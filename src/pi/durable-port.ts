// ═══════════════════════════════════════════════════════════════════════════
// DurablePort（§2.4 / §8.2-8.4）：StreamPort 十个方法在 pi-durable 上的实现，
// 即 §3.2 组件表里的 SessionHost。仅持类型：所有 pi-durable / pi-ai / chord 的
// 运行值经 loadDurableSdk 惰性加载，保持 core-only 隔离（同旧 stream-port）。
//
// 与旧 stream-port（pi-coding-agent）的关键差异（§2 迁移映射表）：
//  - deliver 以 `triggerTurn`（§7.3 的 woke 判定）为主键：`true` → `input`（空闲起轮、
//    忙时 queued）；`false`（含 silent、catch-up 固化、忙流降档）→ 带 model 的 `write`
//    （空闲当场 `done` 不起轮、忙时下一边界落位）。entry 落盘前不返回 entryId，正在进
//    行处由 watch 差分镜像补 (deliver 返回 ≠ delivered，F5)。
//  - 状态从 `value` 推导，不逐条重放 ops。busy = `view.docs["pi.live"].run` 有值；busy→idle
//    边界发 turnEnd（此阶段不区分 abort）。consumed 判据改读 submission（迁 8：deliver 返回
//    submissionId+status，对账按 submission id 精确读，取代 hasEntries 的全量 entry 扫描）。
//  - submissionStatus → `harness.submission(id)` 精确读一条权威投影（取代 hasEntries）。
//    deliver 的 requestId = `<deliveryId>:<attempt>`（无则回退 envelope.id，nudge/note 不用 deliver）。
//  - injectContext → warm 时装/卸 `GenerationHooks.beforeRequest` 钩子，读可变 rec.injection；
//    确认在钩子内同步 onInjectionConfirmed（MD4/OQ1；mesh 账本落确认）。
//  - evict → `waitForIdle` 后 `harness.close()`（§9 F-I）。A21：`dispose()` 强制卸载全部流
//    （force 跳过 hasUnconsumed）并等待进行中的 warm。
//
// 不写 queueDepth / clearQueue / prompt / sendUserMessage / forkFrom（I22/I19/F3）。
// ═══════════════════════════════════════════════════════════════════════════

import { join } from "node:path";
import type {
  ConversationView,
  ConversationWatch,
  EntryId,
  EntryRecord,
  Submission,
  SubmissionId,
  SubmissionRecord as PiSubmissionRecord,
} from "@earendil-works/pi-durable";
import type {
  Account,
  AccountId,
  DegradeTarget,
  Endpoint,
  EndpointId,
  EndpointState,
  Envelope,
  Grade,
  MeshLease,
  PortEntryEvent,
  PortStatus,
  SessionFactory,
  StreamPort,
  SubmissionHandle,
  SubmissionRecord,
  ToolDefinition,
  Unsubscribe,
} from "../core/types.js";
import { loadDurableSdk } from "./durable-sdk.js";
import { toJsonValue, type DurableSession } from "./durable-runtime.js";
import { EndpointLock, LockHeldError } from "./lock.js";

const MESH_MESSAGE_KIND = "mesh.msg";
const MESH_NUDGE_KIND = "mesh.nudge";

/** 带原因码的端口错误：mailbox 据 code 选 parked 原因（§7.10） */
export class PiPortError extends Error {
  constructor(
    readonly code: "NO_SESSION" | "ENDPOINT_GONE" | "LOCK_HELD" | "NOT_HOT",
    message: string,
  ) {
    super(message);
    this.name = "PiPortError";
  }
}

export interface PiStreamPortDeps {
  sessionFactory: SessionFactory;
  getEndpoint(id: EndpointId): Endpoint | undefined;
  getAccount(id: AccountId): Account | undefined;
  /** 绑定身份的 mesh 工具定义（§10.1，由 SessionFactory 注册进 session） */
  buildTools(endpointId: EndpointId): ToolDefinition[];
  setEndpointState(id: EndpointId, state: EndpointState): void;
  setEndpointSession(id: EndpointId, runtimeRef: string): void;
  setEndpointLease(id: EndpointId, lease: MeshLease, until: string | null): void;
  /** §8.3/§19.4：warm 抢到锁后落库 lock_path 归属（C10 锁一致），evict 清空（null） */
  setEndpointLock(id: EndpointId, lockPath: string | null): void;
  /** §8.3：仍有 delivered 未 consumed 时不驱逐（force 跳过，A21） */
  hasUnconsumed?(endpointId: EndpointId): boolean;
  /** 锁文件目录（<stateDir>/locks/<endpointId>.lock） */
  stateDir: string;
  /** 与宿主共享的单写者身份（I01）：宿主 isEndpointLocal 用同一 writerId 判定归属 */
  writerId: string;
  /** 建流成功后回调（I01）：宿主据此注册 sameHost transport handler（显式/自动 warm 都覆盖） */
  onWarmed?(endpointId: EndpointId): void;
  /** exclusive 租约 TTL（§8.3 默认 60s；超时强制释放 + 降级事件） */
  exclusiveLeaseTtlMs?: number;
  /** 空闲驱逐（§8.3 默认 10min；0 = 不驱逐） */
  idleEvictMs?: number;
  devMode?: boolean;
  /** exclusive 超时等端口级降级（宿主转 policy_degraded 事件，I21）；session_failed 见 MD8 */
  onDegraded?(info: { reason: "lease_ttl_expired" | "context_hook_unavailable" | "session_failed"; endpointId: EndpointId }): void;
  /** §20.1：SessionFactory 自身的秒级 deadline（不受 policyTimeoutMs 约束）。缺省 30s。 */
  sessionWarmTimeoutMs?: number;
  /** sessionFactory 超时/抛错的降级回调（宿主转 policy_degraded，degradedTo="unrecoverable"） */
  onPolicyDegraded?(info: { slot: "sessionFactory"; reason: "timeout" | "threw"; degradedTo: DegradeTarget }): void;
  /** I09：P2 注入真实确认——该端点注入体进入某轮最终输入时回调（经 beforeRequest）。 */
  onInjectionConfirmed?(endpointId: EndpointId, info: { turnGeneration: number }): void;
}

/** §20.1 秒级 deadline 默认值（计划 §4.1；不加进 Limits 以免漂移导出类型） */
const SESSION_WARM_TIMEOUT_MS = 30_000;

/** 工厂 deadline 触发的哨兵错误：与「工厂真实抛错」区分，供降级 reason 判定 */
class WarmDeadlineError extends Error {
  constructor() {
    super("warm deadline exceeded");
    this.name = "WarmDeadlineError";
  }
}

/** 给异步工厂调用套一条 unref deadline（§20.1：sessionFactory 豁免 policyTimeoutMs，须自身秒级） */
function withWarmDeadline<T>(ms: number, op: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new WarmDeadlineError());
    }, ms);
    timer.unref?.();
    op().then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ─── 内部 Stream 记录（§8.2：Stream 是 mesh-pi 的内部细节）────────────────

interface StreamRec {
  endpointId: EndpointId;
  accountId: AccountId;
  session: DurableSession;
  runtimeRef: string;
  lock: EndpointLock;
  lease: MeshLease;
  watch: ConversationWatch;
  /** watch 维护的内存视图快照（status 同步读它，不现读文档，§2.4⑨） */
  view: ConversationView;
  /** 已镜像的 entry id（F4：EntryId 是数字，镜像集合记 String(id)） */
  seen: Set<string>;
  seqInStream: number;
  /** handoff 中的 envelopeId（F3：端口自持在途，不读 inbox 深度） */
  handoff: Set<string>;
  /** I09：准备请求代次（beforeRequest 自增），注入确认据此归属「某次真实请求」 */
  turnGeneration: number;
  /** 上次视图的 busy 态（busy→idle 发 turnEnd） */
  wasBusy: boolean;
  /** P2 注入体（injectContext 设置/清除，beforeRequest 钩子读它，MD4） */
  injection?: string;
  leaseTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  evicting: boolean;
}

/** busy = 有一个运行中的 run 控制（LiveState.run 只在其 busy 期间存在）。 */
function isBusy(view: ConversationView): boolean {
  const live = view.docs["pi.live"] as { run?: unknown } | undefined;
  return live?.run !== undefined;
}

/** mesh.msg / mesh.audit / mesh.verbatim_exit 等条目把归因键放在 data.envelopeId。 */
function envelopeIdOf(e: EntryRecord): string | undefined {
  const data = e.data as { envelopeId?: unknown } | undefined;
  return typeof data?.envelopeId === "string" ? data.envelopeId : undefined;
}

/** 收窄 SessionFactory 产物到 durable 面（session 在 core 眼里是 unknown）。 */
function narrowDurableSession(raw: unknown, endpointId: string): DurableSession {
  const s = raw as Partial<DurableSession> | null | undefined;
  const bad =
    !s ||
    typeof s !== "object" ||
    !s.ctx ||
    !s.root ||
    typeof s.root.submit !== "function" ||
    typeof s.root.watch !== "function" ||
    typeof s.root.entries !== "function" ||
    typeof s.root.waitForIdle !== "function" ||
    !s.registry ||
    typeof s.registry.install !== "function" ||
    typeof s.close !== "function";
  if (bad) {
    throw new PiPortError(
      "NO_SESSION",
      `mesh-pi: SessionFactory returned an object that is not a DurableSession ` +
        `(endpoint ${endpointId}) — narrow it inside your factory`,
    );
  }
  return s as DurableSession;
}

/** triggerTurn=true 时 grade 的落位方式（silent 不走到 input 分支，兜底 steer）。 */
function whenBusyFor(grade: Grade): "steer" | "followUp" {
  return grade === "followUp" ? "followUp" : "steer";
}

/** pi-durable 的 SubmissionRecord → core 的权威投影（丢弃 conversationId/detail，保留判据面）。 */
function toSubmissionProjection(st: PiSubmissionRecord): SubmissionRecord {
  const rec = st as PiSubmissionRecord & { entry?: EntryId; reason?: string };
  return {
    id: String(st.id),
    status: st.status,
    entryId: rec.entry !== undefined ? String(rec.entry) : undefined,
    reason: rec.reason,
    type: st.type,
  };
}

/** deliver 的当场返回投影：submission 句柄 + 状态投影。 */
function toSubmissionHandle(sub: Submission, st: PiSubmissionRecord): SubmissionHandle {
  const p = toSubmissionProjection(st);
  return { submissionId: String(sub.id), status: p.status, entryId: p.entryId };
}

export class PiStreamPort implements StreamPort {
  private readonly d: PiStreamPortDeps;
  private readonly streams = new Map<EndpointId, StreamRec>();
  private readonly entryHandlers = new Set<(e: PortEntryEvent) => void>();
  private readonly turnEndHandlers = new Set<(e: { endpointId: string }) => void>();
  private warming = new Map<EndpointId, Promise<void>>();

  constructor(deps: PiStreamPortDeps) {
    this.d = deps;
  }

  // ── ① warm / ② evict ──────────────────────────────────────────────────

  async warm(endpointId: string, lease: MeshLease = "exclusive"): Promise<void> {
    const existing = this.streams.get(endpointId);
    if (existing) {
      // I16：热流 shared → exclusive 升级（不重建流，只切租约并同步锁文件）
      if (lease === "exclusive" && existing.lease === "shared" && !existing.evicting) {
        await existing.lock.setLease("exclusive", this.d.exclusiveLeaseTtlMs ?? 60_000);
        this.applyLease(existing, "exclusive");
      }
      return;
    }
    // 并发 warm 合并（同一端点只建一条流）
    const pending = this.warming.get(endpointId);
    if (pending) return pending;
    const p = this.doWarm(endpointId, lease).finally(() => this.warming.delete(endpointId));
    this.warming.set(endpointId, p);
    return p;
  }

  private async doWarm(endpointId: string, lease: MeshLease): Promise<void> {
    const d = this.d;
    const endpoint = d.getEndpoint(endpointId);
    if (!endpoint) throw new PiPortError("ENDPOINT_GONE", `mesh-pi: unknown endpoint ${endpointId}`);
    const account = d.getAccount(endpoint.accountId);
    if (!account) throw new PiPortError("ENDPOINT_GONE", `mesh-pi: unknown account ${endpoint.accountId}`);

    d.setEndpointState(endpointId, "warming");

    // ① 抢 .lock（M3：失败 ⇒ unavailable，绝不接管）
    let lock: EndpointLock;
    try {
      lock = await EndpointLock.acquire(join(d.stateDir, "locks", `${endpointId}.lock`), {
        writerId: this.d.writerId,
        lease,
        leaseTtlMs: d.exclusiveLeaseTtlMs ?? 60_000,
      });
    } catch (err) {
      if (err instanceof LockHeldError) {
        d.setEndpointState(endpointId, "unavailable");
        throw new PiPortError("LOCK_HELD", err.message);
      }
      throw err;
    }
    d.setEndpointLock(endpointId, lock.lockPath);

    // ② SessionFactory 建/恢复（失败 ⇒ NO_SESSION）。工厂自身秒级 deadline（§20.1）。
    const tools = d.buildTools(endpointId);
    const warmDeadlineMs = d.sessionWarmTimeoutMs ?? SESSION_WARM_TIMEOUT_MS;
    let session: DurableSession;
    let runtimeRef: string;
    try {
      if (endpoint.runtimeRef) {
        const existingRuntimeRef = endpoint.runtimeRef;
        const r = await withWarmDeadline(warmDeadlineMs, () =>
          d.sessionFactory.open({
            endpoint,
            account,
            runtimeRef: existingRuntimeRef,
            tools,
          }),
        );
        session = narrowDurableSession(r.session, endpointId);
        runtimeRef = existingRuntimeRef;
      } else {
        const r = await withWarmDeadline(warmDeadlineMs, () =>
          d.sessionFactory.create({ endpoint, account, tools }),
        );
        session = narrowDurableSession(r.session, endpointId);
        runtimeRef = r.runtimeRef;
      }
    } catch (err) {
      await lock.release();
      d.setEndpointLock(endpointId, null);
      d.setEndpointState(endpointId, "unavailable");
      if (err instanceof WarmDeadlineError) {
        d.onPolicyDegraded?.({ slot: "sessionFactory", reason: "timeout", degradedTo: "unrecoverable" });
        throw new PiPortError(
          "NO_SESSION",
          `mesh-pi: SessionFactory deadline exceeded for endpoint ${endpointId}`,
        );
      }
      d.onPolicyDegraded?.({ slot: "sessionFactory", reason: "threw", degradedTo: "unrecoverable" });
      if (err instanceof PiPortError) throw err;
      throw new PiPortError(
        "NO_SESSION",
        `mesh-pi: SessionFactory failed for endpoint ${endpointId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    // ③ 基线 watch（OQ5：watch 作主）；差分基准把既有的非 head 条目记为 seen。
    const watch = await session.root.watch(session.ctx);
    const rec: StreamRec = {
      endpointId,
      accountId: endpoint.accountId,
      session,
      runtimeRef,
      lock,
      lease,
      watch,
      view: watch.value,
      seen: new Set(),
      seqInStream: 0,
      handoff: new Set(),
      turnGeneration: 0,
      wasBusy: isBusy(watch.value),
      evicting: false,
    };
    for (const e of watch.value.entries) {
      if (e.head !== undefined) continue; // head marker 不入镜像
      rec.seen.add(String(e.id));
    }
    rec.watch.start(async (value) => this.onView(rec, value));
    this.streams.set(endpointId, rec);

    // ④ P2 注入扩展（装在 registry 尾，读可变 rec.injection，MD4）
    await this.installInjection(rec);
    // MD8：订阅 harness 的失败通道——harness.closed reason="failed" ⇒ 端点级不可用 + requeue。
    this.watchFailure(rec);

    if (!endpoint.runtimeRef) d.setEndpointSession(endpointId, runtimeRef);
    this.applyLease(rec, lease);
    d.setEndpointState(endpointId, "hot");
    this.resetIdleTimer(rec);
    this.d.onWarmed?.(endpointId);
  }

  private applyLease(rec: StreamRec, lease: MeshLease): void {
    const d = this.d;
    rec.lease = lease;
    if (rec.leaseTimer) clearTimeout(rec.leaseTimer);
    if (lease === "exclusive") {
      const ttl = d.exclusiveLeaseTtlMs ?? 60_000;
      d.setEndpointLease(rec.endpointId, "exclusive", new Date(Date.now() + ttl).toISOString());
      rec.leaseTimer = setTimeout(() => {
        this.d.setEndpointLease(rec.endpointId, "shared", null);
        rec.lease = "shared";
        void rec.lock.setLease("shared");
        this.d.onDegraded?.({ reason: "lease_ttl_expired", endpointId: rec.endpointId });
      }, ttl);
      rec.leaseTimer.unref?.();
    } else {
      d.setEndpointLease(rec.endpointId, "shared", null);
    }
  }

  /** force=true：A21 关闭路径，跳过 hasUnconsumed 强制卸载。 */
  async evict(endpointId: string, force = false): Promise<void> {
    const rec = this.streams.get(endpointId);
    if (!rec || rec.evicting) return;
    const d = this.d;
    // §8.3：仍有 delivered 未 consumed ⇒ 不驱逐（A21 强制驱除除外）
    if (!force && d.hasUnconsumed?.(endpointId)) {
      this.resetIdleTimer(rec);
      return;
    }
    rec.evicting = true;
    d.setEndpointState(endpointId, "evicting");
    try {
      await rec.session.root.waitForIdle(rec.session.ctx);
    } catch {
      // waitForIdle 失败不阻断驱逐（session 已损坏时更要释放）
    }
    try {
      await rec.watch.stop();
    } catch {
      // watch.stop 失败不阻断
    }
    if (rec.leaseTimer) clearTimeout(rec.leaseTimer);
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    try {
      await withWarmDeadline(
        d.sessionWarmTimeoutMs ?? SESSION_WARM_TIMEOUT_MS,
        () => rec.session.close(),
      );
    } catch {
      // harness/storage close 失败或超时同样不阻断（§8.3 驱逐是内存管理）
    }
    await rec.lock.release();
    d.setEndpointLock(endpointId, null);
    this.streams.delete(endpointId);
    d.setEndpointLease(endpointId, "shared", null);
    d.setEndpointState(endpointId, "cold");
  }

  // ── ③ deliver：durable 提交入口（§2 映射表，triggerTurn 为主键）────────

  async deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    opts?: { triggerTurn?: boolean; deliveryId?: string; attempt?: number },
  ): Promise<SubmissionHandle> {
    const rec = await this.ensureHot(endpointId);
    if (this.d.devMode) rec.lock.assertHeld(endpointId);
    this.resetIdleTimer(rec);

    // MD3 requestId = `<deliveryId>:<attempt>`（确定性幂等键）；nudge/note 不走本方法。
    const requestId =
      opts?.deliveryId !== undefined && opts?.attempt !== undefined
        ? `${opts.deliveryId}:${opts.attempt}`
        : envelope.id;
    const triggerTurn = opts?.triggerTurn ?? false;
    rec.handoff.add(envelope.id);

    try {
      // 条目进 durable 的 JsonValue 面前先走 JSON 往返（丢弃 Envelope 的 undefined 字段）。
      const data = toJsonValue({ envelopeId: envelope.id });
      if (triggerTurn) {
        // input：空闲 → placed 并起轮；忙 → queued，下一边界落位。silent 由 §7.3 保证不到这。
        const sub = await rec.session.root.submit(
          {
            type: "input",
            content: rendered,
            requestId,
            whenBusy: whenBusyFor(grade),
            entry: { kind: MESH_MESSAGE_KIND, data },
          },
          rec.session.ctx,
        );
        const st = await sub.status(rec.session.ctx);
        return toSubmissionHandle(sub, st);
      }
      // write + model：空闲 → 当场 done 不起轮；忙 → queued，下一边界落位。
      const sub = await rec.session.root.submit(
        {
          type: "write",
          requestId,
          entry: {
            kind: MESH_MESSAGE_KIND,
            data,
            model: [{ role: "user", content: rendered, timestamp: Date.now() }],
          },
        },
        rec.session.ctx,
      );
      const st = await sub.status(rec.session.ctx);
      return toSubmissionHandle(sub, st);
    } catch (err) {
      rec.handoff.delete(envelope.id);
      throw err;
    }
  }

  // ── ④ nudge：宿主的控制面（§8.2 约束③：不入 mesh 账、不产生 delivery）─

  async nudge(
    endpointId: string,
    cue: string,
    opts?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean },
  ): Promise<void> {
    const rec = await this.ensureHot(endpointId);
    if (this.d.devMode) rec.lock.assertHeld(endpointId);
    this.resetIdleTimer(rec);
    if (!rec.wasBusy && opts?.triggerTurn) {
      // 空闲起轮：走自定义条目通道（I19 禁 sendUserMessage；不伪装成用户发言）
      await rec.session.root.submit(
        { type: "input", content: cue, entry: { kind: MESH_NUDGE_KIND } },
        rec.session.ctx,
      );
      return;
    }
    await rec.session.root.submit(
      { type: "input", content: cue, whenBusy: opts?.deliverAs === "followUp" ? "followUp" : "steer" },
      rec.session.ctx,
    );
  }

  // ── ⑤ note：只记账不进上下文（§7.6 P3；display-only write）────────────

  async note(endpointId: string, customType: string, data: unknown): Promise<void> {
    const rec = await this.ensureHot(endpointId);
    if (this.d.devMode) rec.lock.assertHeld(endpointId);
    this.resetIdleTimer(rec);
    // 无 model/head/edits：当场追加 done、永不排队，模型看不到（CT-D4）。
    await rec.session.root.submit(
      { type: "write", entry: { kind: customType, data: toJsonValue(data) } },
      rec.session.ctx,
    );
  }

  // ── ⑥ injectContext：P2 注入（§7.6；经 beforeRequest 钩子，MD4）────────

  injectContext(endpointId: string, text: string): Unsubscribe {
    const rec = this.streams.get(endpointId);
    if (!rec) {
      // 冷流没装扩展：注入面不可用，明说（§2.4 降级传统）
      this.d.onDegraded?.({ reason: "context_hook_unavailable", endpointId });
      return () => {};
    }
    rec.injection = text;
    return () => {
      const r = this.streams.get(endpointId);
      if (r === rec) r.injection = undefined;
    };
  }

  // ── ⑦ status（F3：inFlight 是端口自持 handoff 计数）────────────────────

  status(endpointId: string): PortStatus {
    const rec = this.streams.get(endpointId);
    if (!rec) {
      return {
        state: this.d.getEndpoint(endpointId)?.state ?? "cold",
        busy: false,
        inFlight: 0,
      };
    }
    return { state: "hot", busy: rec.wasBusy, inFlight: rec.handoff.size };
  }

  // ── ⑧ submissionStatus：按 id 精确读一条权威投影（§8.4，取代 hasEntries）─

  async submissionStatus(endpointId: string, submissionId: string): Promise<SubmissionRecord | null> {
    const rec = this.streams.get(endpointId);
    if (!rec) return null;
    let sub: Submission | undefined;
    try {
      sub = await rec.session.harness.submission(Number(submissionId) as SubmissionId, rec.session.ctx);
    } catch {
      return null; // 端点损坏/关闭：留待下一轮 sweep / warm 再对账
    }
    if (!sub) return null; // 记录不存在：submission 从未准入或被清理
    try {
      return toSubmissionProjection(await sub.status(rec.session.ctx));
    } catch {
      return null;
    }
  }

  // ── ⑨ onEntry / ⑩ onTurnEnd ───────────────────────────────────────────

  onEntry(h: (e: PortEntryEvent) => void): Unsubscribe {
    this.entryHandlers.add(h);
    return () => this.entryHandlers.delete(h);
  }

  onTurnEnd(h: (e: { endpointId: string }) => void): Unsubscribe {
    this.turnEndHandlers.add(h);
    return () => this.turnEndHandlers.delete(h);
  }

  /** dispose：A21 强制卸载全部流（跳过 hasUnconsumed），并等待进行中的 warm。 */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.warming.values()]);
    await Promise.all([...this.streams.keys()].map((id) => this.evict(id, true)));
    this.entryHandlers.clear();
    this.turnEndHandlers.clear();
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private async ensureHot(endpointId: string): Promise<StreamRec> {
    const rec = this.streams.get(endpointId);
    if (rec) return rec;
    // §8.3：投给 cold 流先恢复再投（恢复期间新消息在 Inbox 排队——调用方语义）。
    await this.warm(endpointId, "shared");
    const hot = this.streams.get(endpointId);
    if (!hot) throw new PiPortError("NOT_HOT", `mesh-pi: warm did not yield a stream for ${endpointId}`);
    return hot;
  }

  private installInjection(rec: StreamRec): Promise<void> {
    return (async () => {
      const d = this.d;
      try {
        const sdk = await loadDurableSdk();
        const ext = sdk.durable.defineExtension({
          name: "pi-agent-mesh:context-injection",
          hooks: [
            sdk.durable.hook(sdk.durable.GenerationTask, {
              beforeRequest: async (req) => {
                const text = rec.injection;
                if (text == null) return undefined;
                rec.turnGeneration += 1;
                d.onInjectionConfirmed?.(rec.endpointId, { turnGeneration: rec.turnGeneration });
                return {
                  messages: [
                    ...req.messages,
                    { role: "user" as const, content: text, timestamp: Date.now() },
                  ],
                };
              },
            }),
          ],
        });
        rec.session.registry.install(ext);
      } catch {
        // 注入扩展安装失败不阻断 warm（§12.5）；后续 injectContext 会走降级
      }
    })();
  }

  /** MD8 失败通道：harness 自身 fatally 关闭（closed reason="failed"）时清理流并报 session_failed。
   *  非致命失败（task_faulted / task_parked / extension_error）走装配层的 onReport，不在此。 */
  private watchFailure(rec: StreamRec): void {
    void (async () => {
      const end = await rec.session.harness.closed;
      // 常规 evict 走 session.close() 收敛到 reason="closed"；只有 "failed" 才走失败清理。
      if (end.reason !== "failed") return;
      if (this.streams.get(rec.endpointId) !== rec) return; // 已驱逐流的迟到闭门不重复处理
      const d = this.d;
      if (rec.leaseTimer) clearTimeout(rec.leaseTimer);
      if (rec.idleTimer) clearTimeout(rec.idleTimer);
      try { await rec.watch.stop(); } catch { /* session 已损坏，尽力停 */ }
      await rec.lock.release();
      d.setEndpointLock(rec.endpointId, null);
      this.streams.delete(rec.endpointId);
      d.setEndpointLease(rec.endpointId, "shared", null);
      d.setEndpointState(rec.endpointId, "unavailable");
      d.onDegraded?.({ reason: "session_failed", endpointId: rec.endpointId });
    })().catch(() => {
      // harness.closed 意外 rejection 不致命：端点交由 sweep/对账兜底。
    });
  }

  /** watch 差分镜像（OQ5）：从 value 整视图推导，不逐条重放 ops。 */
  private onView(rec: StreamRec, value: ConversationView): void {
    if (this.streams.get(rec.endpointId) !== rec) return; // 已驱逐流的迟到帧
    rec.view = value;

    // 镜像新条目（跳过 head marker：head !== undefined 即 head marker，view 自身判据）。
    for (const e of value.entries) {
      if (e.head !== undefined) continue;
      const id = String(e.id);
      if (rec.seen.has(id)) continue;
      rec.seen.add(id);
      const envelopeId = envelopeIdOf(e);
      if (envelopeId) rec.handoff.delete(envelopeId);
      const evt: PortEntryEvent = {
        endpointId: rec.endpointId,
        entryId: id,
        ...(envelopeId ? { envelopeId } : {}),
        entryType: e.kind,
        seqInStream: ++rec.seqInStream, // F4：durable 条目有 id 无流内序号，端口自编号
        rawJson: JSON.stringify(e) ?? "{}",
      };
      for (const h of [...this.entryHandlers]) {
        try {
          h(evt);
        } catch {
          // 事件处理器抛错不影响投递（§12.5）
        }
      }
    }

    // busy→idle 边界发 turnEnd（此阶段不辨 abort，consumed 判据改读 submission 属步骤 8）。
    const busy = isBusy(value);
    if (rec.wasBusy && !busy) {
      rec.wasBusy = false;
      this.resetIdleTimer(rec);
      for (const h of [...this.turnEndHandlers]) {
        try {
          h({ endpointId: rec.endpointId });
        } catch {
          // 同上
        }
      }
    } else if (busy) {
      rec.wasBusy = true;
    }
  }

  private resetIdleTimer(rec: StreamRec): void {
    const ms = this.d.idleEvictMs ?? 600_000;
    if (ms <= 0 || rec.evicting) return;
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => {
      void this.evict(rec.endpointId);
    }, ms);
    rec.idleTimer.unref?.();
  }
}