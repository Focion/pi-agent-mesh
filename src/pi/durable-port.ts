// ═══════════════════════════════════════════════════════════════════════════
// DurablePort（§2.4 / §8.2-8.4）：StreamPort 十个方法在 pi-durable 上的实现，
// 即 §3.2 组件表里的 SessionHost。仅持类型：所有 pi-durable / pi-ai / chord 的
// 运行值经 loadDurableSdk 惰性加载，保持 core-only 隔离（同旧 stream-port）。
//
// 与旧 stream-port（pi-coding-agent）的关键差异（§2 迁移映射表）：
//  - deliver 以 `triggerTurn`（§7.3 的 woke 判定）为主键：`true` → `input`（空闲起轮、
//    忙时 queued）；`false`（含 silent、catch-up 固化、忙流降档）→ 带 model 的 `write`
//    （空闲当场 `done` 不起轮、忙时下一边界落位）。entry 落盘前不返回 entryId，正在进
//    行处由提交观察镜像补（deliver 返回 ≠ delivered，F5）。
//  - pi 1.5：状态与条目从 `harness.observeCommits()` 的已落盘提交（CommitPublication）
//    推导，取代 watch 差分镜像（1.5 的 watch 回调合并 + 50/100 滚动窗口不再保证
//    条目通知与 busy→idle 边界不遗漏）。advance 同步只记录；每端点串行 drain 在
//    Session 调用栈外按提交顺序消费：先条目镜像（收集确认 Promise 并等待，完成屏障），
//    再应用 pi.live 状态并判定轮次边界（busy→idle 与旧 run→新 run 换手都覆盖）。
//    turnEnd 事件携带 eligibleEntryIds（该边界已通知条目的快照）供消费事务过滤。
//  - busy 判据：pi.live 的 run 存在即忙；run 身份按 inputs 集合跟踪（taskId 换代不换
//    身份）。consumed 判据改读 submission（迁 8：deliver 返回 submissionId+status）。
//  - submissionStatus → `harness.submission(id)` 精确读一条权威投影（取代 hasEntries）。
//    deliver 的 requestId = `<deliveryId>:<attempt>`（无则回退 envelope.id，nudge/note 不用 deliver）。
//    pi 1.5 的 continue 提交投影显式报不支持（mesh 契约只有 input/write）。
//  - injectContext → warm 时装/卸 `GenerationHooks.beforeRequest` 钩子，读可变 rec.injection；
//    确认在钩子内同步 onInjectionConfirmed（MD4/OQ1；mesh 账本落确认）。
//  - evict → `waitForIdle` 后 detach 观察、收敛 drain、`harness.close()`、释放锁（§9 F-I）。
//    A21：`dispose()` 强制卸载全部流（force 跳过 hasUnconsumed）并等待进行中的 warm。
//  - 启动顺序（pi 1.5）：factory 不再 resume；warm 在配置/root → 提交观察与基线 → P2 注入
//    → runtimeRef/租约/状态就绪之后才 `harness.resume()`；后半段失败回滚（关 session、放锁）。
//
// 不写 queueDepth / clearQueue / prompt / sendUserMessage / forkFrom（I22/I19/F3）。
// ═══════════════════════════════════════════════════════════════════════════

import { join } from "node:path";
import type { WatchEnd } from "@earendil-works/chord";
import type {
  CommitObservation,
  CommitPublication,
  Cursor,
  EntryId,
  EntryRecord,
  LiveState,
  Submission,
  SubmissionId,
  SubmissionRecord as PiSubmissionRecord,
  SessionEnd,
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
/** pi.live 会话文档的 kind（harness/live 的 LiveDoc）；忙/轮次状态唯一权威。 */
const LIVE_DOC_KIND = "pi.live";
/** 基线分页大小（root.entries 升序全量分页，不用 50/100 滚动窗口当基线）。 */
const BASELINE_PAGE = 1000;

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
  /** observeCommits 的观察句柄（detach 幂等；detach 后无 advance/end） */
  observation: CommitObservation;
  /** advance 只入队（同步只记录）；drain 在 Session 调用栈外串行消费 */
  pending: CommitPublication[];
  /** 当前 drain 链（收敛用：evict/failure 清理等它落定） */
  drainPromise: Promise<void> | undefined;
  /** 基线完成后置 true；此前 drain 只排队不处理（避免半初始化期发 turnEnd） */
  ready: boolean;
  /** 正常 evict/dispose/失败清理已接管：观察 end / harness.closed 回调不再动作 */
  closing: boolean;
  /** 观察句柄已结束（迟到 advance 不入队） */
  ended: boolean;
  /** busy 缓存：pi.live.run 存在即忙（从提交流维护，不做整视图轮询） */
  busy: boolean;
  /** 当前 run 的已放置输入（LiveRun.inputs 的字符串集）：run 身份跟踪
   *  （taskId 换代不换身份；inputs 换新 = 旧 run 换新 run 的边界） */
  activeRunInputs: Set<string>;
  /** 已镜像的 entry id（F4：EntryId 是数字，镜像集合记 String(id)） */
  seen: Set<string>;
  seqInStream: number;
  /** handoff 中的 envelopeId（F3：端口自持在途，不读 inbox 深度） */
  handoff: Set<string>;
  /** I09：准备请求代次（beforeRequest 自增），注入确认据此归属「某次真实请求」 */
  turnGeneration: number;
  /** P2 注入体（injectContext 设置/清除，beforeRequest 钩子读它，MD4） */
  injection?: string;
  leaseTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  evicting: boolean;
}

/** mesh.msg / mesh.audit / mesh.verbatim_exit 等条目把归因键放在 data.envelopeId。 */
function envelopeIdOf(e: EntryRecord): string | undefined {
  const data = e.data as { envelopeId?: unknown } | undefined;
  return typeof data?.envelopeId === "string" ? data.envelopeId : undefined;
}

/** 收窄 SessionFactory 产物到 durable 面（session 在 core 眼里是 unknown）。 */
function narrowDurableSession(raw: unknown, endpointId: string): DurableSession {
  const s = raw as Partial<DurableSession> | null | undefined;
  const harness = s?.harness as { observeCommits?: unknown; closed?: unknown; resume?: unknown } | undefined;
  const bad =
    !s ||
    typeof s !== "object" ||
    !s.ctx ||
    !s.root ||
    typeof s.root.submit !== "function" ||
    typeof s.root.entries !== "function" ||
    typeof s.root.waitForIdle !== "function" ||
    !harness ||
    typeof harness.observeCommits !== "function" ||
    typeof harness.resume !== "function" ||
    !harness.closed ||
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

/** pi-durable 的 SubmissionRecord → core 的权威投影（丢弃 conversationId/detail，保留判据面）。
 *  pi 1.5 的 continue 提交不在 mesh 的 input/write 契约内（SDK 内部钩子产物）：
 *  显式报不支持，不伪装成 input/write，也不新增 continue 提交入口。 */
function toSubmissionProjection(st: PiSubmissionRecord): SubmissionRecord {
  if (st.type === "continue") {
    throw new Error(
      `mesh: pi 1.5 continue submission ${st.id} is not supported by the input/write ` +
        `delivery contract (continue is produced by SDK-internal hooks, not by mesh delivery)`,
    );
  }
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

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export class PiStreamPort implements StreamPort {
  private readonly d: PiStreamPortDeps;
  private readonly streams = new Map<EndpointId, StreamRec>();
  private readonly entryHandlers = new Set<(e: PortEntryEvent) => void | Promise<void>>();
  private readonly turnEndHandlers = new Set<(e: { endpointId: string; eligibleEntryIds?: readonly string[] }) => void>();
  private warming = new Map<EndpointId, Promise<void>>();

  constructor(deps: PiStreamPortDeps) {
    this.d = deps;
  }

  // ── ① warm / ② evict ──────────────────────────────────────────────────

  async warm(endpointId: string, lease: MeshLease = "exclusive"): Promise<void> {
    const existing = this.streams.get(endpointId);
    if (existing) {
      // I16：热流 shared → exclusive 升级（不重建流，只切租约并同步锁文件）
      if (lease === "exclusive" && existing.lease === "shared" && !existing.evicting && !existing.closing) {
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

    // ③ 后半段装配（pi 1.5 启动顺序）：观察 → 基线 → 注册流 → P2 注入 → 状态就绪 → resume。
    //    任一失败回滚：detach 观察、关 session、放锁，端点 unavailable，不残留半装配流。
    let rec: StreamRec | undefined;
    try {
      rec = await this.assembleStream(endpointId, endpoint.accountId, session, runtimeRef, lock, lease);
      this.streams.set(endpointId, rec);
      rec.ready = true;
      void this.drain(rec); // 处理基线期间缓冲的提交
      await this.installInjection(rec);
      this.watchFailure(rec);
      if (!endpoint.runtimeRef) d.setEndpointSession(endpointId, runtimeRef);
      this.applyLease(rec, lease);
      d.setEndpointState(endpointId, "hot");
      this.resetIdleTimer(rec);
      this.d.onWarmed?.(endpointId);
      // resume 幂等、放最后：就绪前不调用会隐式 resume 的 waitForIdle/compact/abort
      // （evict 的 waitForIdle 只在 hot 之后可达）。
      rec.session.harness.resume();
    } catch (err) {
      if (rec) {
        rec.closing = true;
        this.streams.delete(endpointId);
        try { rec.observation.detach(); } catch { /* 观察 detach 幂等，失败不阻断回滚 */ }
        try { await withWarmDeadline(warmDeadlineMs, () => rec!.drainPromise ?? Promise.resolve()); } catch { /* 收敛失败不阻断 */ }
      }
      try {
        await withWarmDeadline(warmDeadlineMs, () => session.close());
      } catch {
        // 关 session 失败不阻断回滚（锁必须释放）
      }
      await lock.release();
      d.setEndpointLock(endpointId, null);
      d.setEndpointState(endpointId, "unavailable");
      if (err instanceof PiPortError) throw err;
      throw new PiPortError(
        "NO_SESSION",
        `mesh-pi: stream assembly failed for endpoint ${endpointId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** 观察接线 + 历史基线（pi 1.5）：先挂提交缓冲（advance 只入队），再经 root.entries
   *  分页建立 seen 基线；基线期间的提交保留在 pending，不会被基线覆盖。busy 从 false 起，
   *  由提交流按序建立状态（不读快照：避免「快照新于待处理提交」的倒置）。 */
  private async assembleStream(
    endpointId: string,
    accountId: AccountId,
    session: DurableSession,
    runtimeRef: string,
    lock: EndpointLock,
    lease: MeshLease,
  ): Promise<StreamRec> {
    let rec!: StreamRec;
    const observation = session.harness.observeCommits({
      advance: (publication: CommitPublication) => {
        // 同步只记录，绝不 await / 调 Session / 抛错（抛错 ⇒ listener_error 并 detach）。
        try {
          if (rec.closing || rec.ended) return;
          rec.pending.push(publication);
          void this.drain(rec);
        } catch {
          // advance 不抛：极端情况（如 OOM）只丢该 publication，由后续提交与对账兜底
        }
      },
      end: (end: WatchEnd) => {
        // 观察结束通道：正常关闭前 closing 已置 true（evict/dispose/failStream），
        // 其余任何结束（session 失败 / listener_error / 外部关闭）都走失败清理。
        if (rec.ended) return;
        rec.ended = true;
        if (!rec.closing && this.streams.get(endpointId) === rec) {
          this.failStream(rec);
        }
      },
    });
    rec = {
      endpointId,
      accountId,
      session,
      runtimeRef,
      lock,
      lease,
      observation,
      pending: [],
      drainPromise: undefined,
      ready: false,
      closing: false,
      ended: false,
      busy: false,
      activeRunInputs: new Set(),
      seen: new Set(),
      seqInStream: 0,
      handoff: new Set(),
      turnGeneration: 0,
      evicting: false,
    };
    // 历史基线：升序全量分页（head marker 不入镜像）；重开前的既有条目进 seen，
    // 使后续 turnEnd 的 eligibleEntryIds 覆盖重开前的 delivery（不依赖 50/100 滚窗）。
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await session.root.entries(
        { order: "ascending" },
        BASELINE_PAGE,
        cursor,
        session.ctx,
      );
      for (const e of page.items) {
        if (e.head !== undefined) continue;
        rec.seen.add(String(e.id));
      }
      if (!page.next) break;
      cursor = page.next;
    }
    return rec;
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
    if (!rec || rec.evicting || rec.closing) return;
    const d = this.d;
    // §8.3：仍有 delivered 未 consumed ⇒ 不驱逐（A21 强制驱除除外）
    if (!force && d.hasUnconsumed?.(endpointId)) {
      this.resetIdleTimer(rec);
      return;
    }
    rec.evicting = true;
    d.setEndpointState(endpointId, "evicting");
    const warmDeadlineMs = d.sessionWarmTimeoutMs ?? SESSION_WARM_TIMEOUT_MS;
    try {
      await rec.session.root.waitForIdle(rec.session.ctx);
    } catch {
      // waitForIdle 失败不阻断驱逐（session 已损坏时更要释放）
    }
    // 停止新提交进入：detach 观察（此后无 advance/end），再收敛 drain（不丢已缓冲提交）。
    try {
      rec.observation.detach();
    } catch {
      // detach 幂等
    }
    try {
      await withWarmDeadline(warmDeadlineMs, () => rec!.drainPromise ?? Promise.resolve());
    } catch {
      // 收敛失败不阻断驱逐（锁必须释放）
    }
    rec.closing = true;
    if (rec.leaseTimer) clearTimeout(rec.leaseTimer);
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    try {
      await withWarmDeadline(warmDeadlineMs, () => rec.session.close());
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
    if (!rec.busy && opts?.triggerTurn) {
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
    return { state: "hot", busy: rec.busy, inFlight: rec.handoff.size };
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
      return null; // continue 等不支持的投影 / 读取失败：判未进转录，交给 reconcile 兜底
    }
  }

  // ── ⑨ onEntry / ⑩ onTurnEnd ───────────────────────────────────────────

  onEntry(h: (e: PortEntryEvent) => void | Promise<void>): Unsubscribe {
    this.entryHandlers.add(h);
    return () => this.entryHandlers.delete(h);
  }

  onTurnEnd(h: (e: { endpointId: string; eligibleEntryIds?: readonly string[] }) => void): Unsubscribe {
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

  /** MD8 失败通道：harness 自身 fatally 关闭（closed kind="failed"）时清理流并报 session_failed。
   *  非致命失败（task_faulted / task_parked / extension_error）走装配层的 onReport，不在此。
   *  pi 1.5：SessionEnd 按 kind 分派——closed 是正常关闭（evict 已置 closing，此处直接返回）。 */
  private watchFailure(rec: StreamRec): void {
    void (async () => {
      const end: SessionEnd = await rec.session.harness.closed;
      if (rec.closing) return; // 正常 evict/dispose/failStream 路径已接管
      if (this.streams.get(rec.endpointId) !== rec) return; // 已驱逐流的迟到闭门不重复处理
      if (end.kind !== "failed") return;
      this.failStream(rec);
    })().catch(() => {
      // harness.closed 意外 rejection 不致命：端点交由 sweep/对账兜底。
    });
  }

  /** 观察意外终止 / session 失败的统一清理：流立即脱表并 unavailable（绝不仍显示正常 hot），
   *  随后收敛 drain、关闭旧写者、释放锁。幂等：closing 标记隔离一切迟到回调。 */
  private failStream(rec: StreamRec): void {
    if (rec.closing) return;
    rec.closing = true;
    rec.ended = true;
    const d = this.d;
    if (this.streams.get(rec.endpointId) === rec) this.streams.delete(rec.endpointId);
    d.setEndpointState(rec.endpointId, "unavailable");
    d.setEndpointLease(rec.endpointId, "shared", null);
    const warmDeadlineMs = d.sessionWarmTimeoutMs ?? SESSION_WARM_TIMEOUT_MS;
    void (async () => {
      if (rec.leaseTimer) clearTimeout(rec.leaseTimer);
      if (rec.idleTimer) clearTimeout(rec.idleTimer);
      try { rec.observation.detach(); } catch { /* 幂等 */ }
      try { await withWarmDeadline(warmDeadlineMs, () => rec.drainPromise ?? Promise.resolve()); } catch { /* 收敛失败不阻断 */ }
      try { await withWarmDeadline(warmDeadlineMs, () => rec.session.close()); } catch { /* session 已损坏，尽力关 */ }
      try { await rec.lock.release(); } catch { /* 锁释放失败交由 ownerIsLive 兜底 */ }
      d.setEndpointLock(rec.endpointId, null);
      d.onDegraded?.({ reason: "session_failed", endpointId: rec.endpointId });
    })().catch(() => {
      // 清理自身失败不致命：端点已 unavailable，锁交由 ownerIsLive/sweep 兜底。
    });
  }

  /** 每端点串行的提交 drain（Session 调用栈外）：一次一个提交，不合并。
   *  条目镜像 → 等全部确认（完成屏障）→ 应用 pi.live 并判定轮次边界。 */
  private drain(rec: StreamRec): Promise<void> {
    const existing = rec.drainPromise;
    if (existing) return existing;
    const p = (async () => {
      for (;;) {
        const pub = rec.pending.shift();
        if (!pub || rec.closing || !rec.ready) break;
        try {
          await this.applyCommit(rec, pub);
        } catch {
          // drain 异常不炸端口、不 detach 观察：该提交的镜像/边界由后续提交与 reconcile 兜底
        }
      }
    })().finally(() => {
      if (rec.drainPromise === p) rec.drainPromise = undefined;
    });
    rec.drainPromise = p;
    return p;
  }

  /** 单提交处理：changes 顺序不定 → 先收集 root 会话的条目与 pi.live 变化，
   *  条目按 id 升序镜像并等待确认，再应用 live 状态与轮次结束通知。 */
  private async applyCommit(rec: StreamRec, pub: CommitPublication): Promise<void> {
    if (rec.closing || rec.ended || this.streams.get(rec.endpointId) !== rec) return;
    const rootId = rec.session.root.id;
    const entries: EntryRecord[] = [];
    let live: LiveState | undefined;
    let liveChanged = false;
    for (const ch of pub.changes) {
      if (ch.type === "entry" && ch.value.conversationId === rootId) {
        entries.push(ch.value);
      } else if (ch.type === "document" && ch.conversationId === rootId && ch.record.kind === LIVE_DOC_KIND) {
        liveChanged = true;
        live = ch.kind === "change" ? (ch.value as unknown as LiveState) : {};
      }
    }
    entries.sort((a, b) => a.id - b.id);

    // 条目镜像（跳过 head marker）；收集 handler 返回的确认 Promise 作完成屏障。
    const confirmations: Promise<void>[] = [];
    for (const e of entries) {
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
          const r = h(evt);
          if (r != null && typeof (r as PromiseLike<unknown>).then === "function") {
            confirmations.push(
              Promise.resolve(r).catch(() => undefined), // 确认失败保留既有恢复/重试语义，不炸 drain
            );
          }
        } catch {
          // 事件处理器抛错不影响投递（§12.5）
        }
      }
    }
    // 完成屏障：全部 entry 确认落定后才评估该提交边界的轮次结束（先 delivered 后 consumed）。
    if (confirmations.length > 0) await Promise.all(confirmations);

    if (!liveChanged) return;
    if (rec.closing || rec.ended || this.streams.get(rec.endpointId) !== rec) return;

    // 轮次边界：busy→idle（run 移除）与旧 run→新 run（inputs 换新非空）都发 turnEnd；
    // 生成代际换手（taskId 变而 inputs 不变）不算边界。answer 后 inputs 空转（afterRun
    // 阶段）不发——保持 1.4 的「run 完全结束才 turnEnd」时序，run 移除时统一发。
    const wasBusy = rec.busy;
    const newInputs = new Set<string>();
    for (const sid of live?.run?.inputs ?? []) newInputs.add(String(sid));
    const fire =
      wasBusy &&
      (live?.run === undefined || (newInputs.size > 0 && !sameSet(newInputs, rec.activeRunInputs)));
    rec.busy = live?.run !== undefined;
    rec.activeRunInputs = newInputs;
    if (fire) {
      this.resetIdleTimer(rec);
      this.fireTurnEnd(rec);
    }
  }

  private fireTurnEnd(rec: StreamRec): void {
    // 该边界已纳入基线/entry 通知的条目 ID 快照（不含后续提交）：消费事务据此过滤。
    const eligible = Array.from(rec.seen);
    for (const h of [...this.turnEndHandlers]) {
      try {
        h({ endpointId: rec.endpointId, eligibleEntryIds: eligible });
      } catch {
        // 事件处理器抛错不影响后续投递（§12.5）
      }
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
