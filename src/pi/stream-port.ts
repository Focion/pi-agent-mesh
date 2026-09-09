// ═══════════════════════════════════════════════════════════════════════════
// PiStreamPort（§2.4 / §8.2-8.4）：StreamPort 十个方法在真 pi 上的实现，
// 即 §3.2 组件表里的 SessionHost。全库唯一调用 sendCustomMessage 的地方。
//
// 关键设计（每条都对应一个 F 编号或不变量）：
//  - deliver 的 resolve ≠ delivered（F5）：entryId 只在「返回前已落盘」时给出；
//    delivered 的判据是 onEntry（由 entry 差分镜像发出），不是本方法返回。
//  - pi 0.85 的 AgentSession 只对扩展 runtime 的 appendEntry 发 entry_appended，
//    sendCustomMessage 的落盘发的是 message_start/message_end。所以 onEntry 用
//    「getEntries() 差分」实现（F4：无 seq 无游标，只能全量取 + 应用侧过滤），
//    触发点是 message_end / turn_end / agent_settled / entry_appended / 写后自查。
//  - 不写 queueDepth（F3）：inFlight 是端口自己的 handoff 计数（deliver 调用起、
//    entry 落盘止），与 SDK 的 pendingMessageCount 无关。
//  - 永不调用 clearQueue（I22）；永不调用 prompt/sendUserMessage（I19）。
//  - 抢锁失败 ⇒ unavailable，绝不接管（M3）；SessionFactory 失败抛
//    PiPortError{code:"NO_SESSION"}（§7.10 唯一要告警的 park 原因）。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  Account,
  AccountId,
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
  ToolDefinition,
  Unsubscribe,
} from "../core/types.js";
import { EndpointLock, LockHeldError } from "./lock.js";

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
  setEndpointSession(id: EndpointId, piSessionId: string): void;
  setEndpointLease(id: EndpointId, lease: MeshLease, until: string | null): void;
  /** §8.3 clearQueue 协议：仍有 delivered 未 consumed 时不驱逐 */
  hasUnconsumed?(endpointId: EndpointId): boolean;
  /** 锁文件目录（<stateDir>/locks/<endpointId>.lock） */
  stateDir: string;
  /** exclusive 租约 TTL（§8.3 默认 60s；超时强制释放 + 降级事件） */
  exclusiveLeaseTtlMs?: number;
  /** 空闲驱逐（§8.3 默认 10min；0 = 不驱逐） */
  idleEvictMs?: number;
  devMode?: boolean;
  /** exclusive 超时等端口级降级（宿主转 policy_degraded 事件，I21） */
  onDegraded?(info: { reason: "lease_ttl_expired" | "context_hook_unavailable"; endpointId: EndpointId }): void;
}

// ─── pi session 的结构收窄（types.ts 的 SessionFactory.session 是 unknown）──

interface PiSessionEvent {
  type: string;
  message?: { role?: string };
  entry?: unknown;
}

interface PiSessionLike {
  readonly isIdle: boolean;
  readonly sessionManager: {
    getSessionId(): string;
    getEntry(id: string): unknown;
    getEntries(): unknown[];
    appendCustomEntry(customType: string, data?: unknown): string;
  };
  sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  dispose(): void;
  /** pi 的扩展运行器（context 钩子注入点）；结构性探测，缺失则注入降级 */
  extensionRunner?: { extensions: Array<Record<string, unknown>> };
}

const REQUIRED_METHODS = [
  "sendCustomMessage",
  "steer",
  "followUp",
  "waitForIdle",
  "subscribe",
  "dispose",
] as const;

function narrowSession(raw: unknown, endpointId: string): PiSessionLike {
  const s = raw as Partial<PiSessionLike> | null | undefined;
  const bad =
    !s ||
    typeof s !== "object" ||
    REQUIRED_METHODS.some((m) => typeof s[m] !== "function") ||
    !s.sessionManager ||
    typeof s.sessionManager.getEntry !== "function" ||
    typeof s.sessionManager.getEntries !== "function" ||
    typeof s.sessionManager.appendCustomEntry !== "function";
  if (bad) {
    throw new PiPortError(
      "NO_SESSION",
      `mesh-pi: SessionFactory returned an object that is not an AgentSession ` +
        `(endpoint ${endpointId}) — narrow it inside your factory`,
    );
  }
  return s as PiSessionLike;
}

// ─── 内部 Stream 记录（§8.2：Stream 是 mesh-pi 的内部细节）────────────────

interface EntryWaiter {
  envelopeId: string;
  resolve: (entryId: string | undefined) => void;
}

interface StreamRec {
  endpointId: EndpointId;
  accountId: AccountId;
  session: PiSessionLike;
  piSessionId: string;
  lock: EndpointLock;
  lease: MeshLease;
  unsub: Unsubscribe;
  /** 已镜像的 entry id（差分基准，F4：没有游标只能记集合） */
  seen: Set<string>;
  seqInStream: number;
  /** envelopeId → entryId（deliver 的返回与 waiter 唤醒共用） */
  entryByEnvelope: Map<string, string>;
  /** handoff 中的 envelopeId（F3：端口自持在途，不读 SDK 计数） */
  handoff: Set<string>;
  waiters: EntryWaiter[];
  leaseTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  evicting: boolean;
}

const GRADE_DELIVER_AS: Record<Grade, "steer" | "followUp" | undefined> = {
  steer: "steer",
  followUp: "followUp",
  // silent 无 deliverAs：热流走「立即落盘、不起轮」分支（§7.2 表②形态①）
  silent: undefined,
};

export class PiStreamPort implements StreamPort {
  private readonly d: PiStreamPortDeps;
  private readonly streams = new Map<EndpointId, StreamRec>();
  private readonly entryHandlers = new Set<(e: PortEntryEvent) => void>();
  private readonly turnEndHandlers = new Set<(e: { endpointId: string }) => void>();
  private readonly writerId = `mesh-${randomUUID()}`;
  private warming = new Map<EndpointId, Promise<void>>();

  constructor(deps: PiStreamPortDeps) {
    this.d = deps;
  }

  // ── ① warm / ② evict ──────────────────────────────────────────────────

  async warm(endpointId: string, lease: MeshLease = "exclusive"): Promise<void> {
    if (this.streams.has(endpointId)) return;
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
        writerId: this.writerId,
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

    // ② SessionFactory 建/恢复（失败 ⇒ NO_SESSION，§7.10 唯一要告警的）
    const tools = d.buildTools(endpointId);
    let session: PiSessionLike;
    let piSessionId: string;
    try {
      if (endpoint.piSessionId) {
        const r = await d.sessionFactory.open({
          endpoint,
          account,
          piSessionId: endpoint.piSessionId,
          tools,
        });
        session = narrowSession(r.session, endpointId);
        piSessionId = endpoint.piSessionId;
      } else {
        const r = await d.sessionFactory.create({ endpoint, account, tools });
        session = narrowSession(r.session, endpointId);
        piSessionId = r.piSessionId;
      }
    } catch (err) {
      await lock.release();
      d.setEndpointState(endpointId, "unavailable");
      if (err instanceof PiPortError) throw err;
      throw new PiPortError(
        "NO_SESSION",
        `mesh-pi: SessionFactory failed for endpoint ${endpointId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    const rec: StreamRec = {
      endpointId,
      accountId: endpoint.accountId,
      session,
      piSessionId,
      lock,
      lease,
      unsub: () => {},
      seen: new Set(),
      seqInStream: 0,
      entryByEnvelope: new Map(),
      handoff: new Set(),
      waiters: [],
      evicting: false,
    };

    // 差分基准：热化时已有的条目记为 seen（不补镜像；镜像只覆盖热化后新条目，
    // 历史考古查 session 文件即可，§8.5 F4）
    for (const e of session.sessionManager.getEntries()) {
      const id = entryIdOf(e);
      if (id) rec.seen.add(id);
    }

    rec.unsub = session.subscribe((ev) => this.onSessionEvent(rec, ev));
    this.streams.set(endpointId, rec);

    if (!endpoint.piSessionId) d.setEndpointSession(endpointId, piSessionId);
    this.applyLease(rec, lease);
    d.setEndpointState(endpointId, "hot");
    this.resetIdleTimer(rec);
  }

  private applyLease(rec: StreamRec, lease: MeshLease): void {
    const d = this.d;
    rec.lease = lease;
    if (rec.leaseTimer) clearTimeout(rec.leaseTimer);
    if (lease === "exclusive") {
      const ttl = d.exclusiveLeaseTtlMs ?? 60_000;
      d.setEndpointLease(rec.endpointId, "exclusive", new Date(Date.now() + ttl).toISOString());
      // exclusive 必须有超时：强制释放 + 降级事件（§8.3；卡住的应答不得永久冻结流）
      rec.leaseTimer = setTimeout(() => {
        this.d.setEndpointLease(rec.endpointId, "shared", null);
        rec.lease = "shared";
        this.d.onDegraded?.({ reason: "lease_ttl_expired", endpointId: rec.endpointId });
      }, ttl);
      rec.leaseTimer.unref?.();
    } else {
      d.setEndpointLease(rec.endpointId, "shared", null);
    }
  }

  async evict(endpointId: string): Promise<void> {
    const rec = this.streams.get(endpointId);
    if (!rec || rec.evicting) return;
    const d = this.d;
    // §8.3：仍有 delivered 未 consumed ⇒ 不驱逐
    if (d.hasUnconsumed?.(endpointId)) {
      this.resetIdleTimer(rec);
      return;
    }
    rec.evicting = true;
    d.setEndpointState(endpointId, "evicting");
    try {
      await rec.session.waitForIdle();
    } catch {
      // waitForIdle 失败不阻断驱逐（session 已损坏时更要释放）
    }
    rec.unsub();
    if (rec.leaseTimer) clearTimeout(rec.leaseTimer);
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    const endpoint = d.getEndpoint(endpointId);
    try {
      if (endpoint && d.sessionFactory.dispose) {
        await d.sessionFactory.dispose({ endpoint, session: rec.session });
      } else {
        rec.session.dispose();
      }
    } catch {
      // dispose 失败同样不阻断（§8.3 驱逐是内存管理，不是数据操作）
    }
    await rec.lock.release();
    // 挂在 waiter 上的 deliver 以 undefined 收场（调用方走 handoff 超时重投）
    for (const w of rec.waiters.splice(0)) w.resolve(undefined);
    this.streams.delete(endpointId);
    d.setEndpointLease(endpointId, "shared", null);
    d.setEndpointState(endpointId, "cold");
  }

  // ── ③ deliver：全库唯一 sendCustomMessage 出口（§8.2 约束①）───────────

  async deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    opts?: { triggerTurn?: boolean },
  ): Promise<{ entryId?: string }> {
    const rec = await this.ensureHot(endpointId);
    if (this.d.devMode) rec.lock.assertHeld(endpointId);
    this.resetIdleTimer(rec);

    const triggerTurn = opts?.triggerTurn ?? false;
    const deliverAs = GRADE_DELIVER_AS[grade];
    rec.handoff.add(envelope.id);

    // F5：entry 落盘才算交付依据。三个来源里谁先到家算谁：
    //  - 空闲 + 不起轮 / 忙流排队：sendCustomMessage 返回即落定（CT-F5）
    //  - 空闲 + 起轮：entry 在轮次开头落盘，调用要等整个轮次 —— 等 entry 先走，
    //    轮次后续成败与本条投递无关（delivered 判据已满足，pi 自己管重试）
    const entrySeen = new Promise<string | undefined>((resolve) => {
      rec.waiters.push({ envelopeId: envelope.id, resolve });
    });
    let callError: unknown;
    const call = rec.session
      .sendCustomMessage(
        {
          customType: "mesh.msg",
          content: rendered,
          display: true,
          details: { envelope },
        },
        { triggerTurn, ...(deliverAs ? { deliverAs } : {}) },
      )
      .catch((err) => {
        callError = err;
      });

    const outcome = await Promise.race([
      call.then(() => "call" as const),
      entrySeen.then(() => "entry" as const),
    ]);
    this.dropWaiter(rec, envelope.id);
    if (callError) {
      rec.handoff.delete(envelope.id);
      throw callError;
    }
    if (outcome === "entry") {
      const entryId = rec.entryByEnvelope.get(envelope.id);
      return entryId ? { entryId } : {};
    }
    this.syncEntries(rec);
    const entryId = rec.entryByEnvelope.get(envelope.id);
    return entryId ? { entryId } : {};
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
    if (rec.session.isIdle && opts?.triggerTurn) {
      // 空闲起轮：走自定义条目通道（I19 禁 sendUserMessage；不伪装成用户发言）
      await rec.session.sendCustomMessage(
        { customType: "mesh.nudge", content: cue, display: true },
        { triggerTurn: true },
      );
      this.syncEntries(rec);
      return;
    }
    if (opts?.deliverAs === "followUp") await rec.session.followUp(cue);
    else await rec.session.steer(cue);
  }

  // ── ⑤ note：只记账不进上下文（§7.6 P3；落 type:"custom" 条目）─────────

  async note(endpointId: string, customType: string, data: unknown): Promise<void> {
    const rec = await this.ensureHot(endpointId);
    if (this.d.devMode) rec.lock.assertHeld(endpointId);
    this.resetIdleTimer(rec);
    rec.session.sessionManager.appendCustomEntry(customType, data);
    this.syncEntries(rec);
  }

  // ── ⑥ injectContext：P2 注入（§7.6；经 pi 扩展的 context 钩子）────────

  injectContext(endpointId: string, text: string): Unsubscribe {
    const rec = this.streams.get(endpointId);
    const runner = rec?.session.extensionRunner;
    if (!rec || !runner || !Array.isArray(runner.extensions)) {
      // 宿主工厂给的 session 没有暴露扩展运行器：注入面不可用，明说（§2.4 降级传统）
      this.d.onDegraded?.({ reason: "context_hook_unavailable", endpointId });
      return () => {};
    }
    const handler = (event: { messages: unknown[] }) => ({
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "mesh.inbox",
          content: [{ type: "text", text }],
          display: false,
          timestamp: Date.now(),
        },
      ],
    });
    const ext: Record<string, unknown> = {
      path: "pi-agent-mesh:context-injection",
      resolvedPath: "pi-agent-mesh:context-injection",
      hidden: true,
      handlers: new Map([["context", [handler]]]),
      tools: new Map(),
      messageRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    };
    runner.extensions.push(ext);
    return () => {
      const i = runner.extensions.indexOf(ext);
      if (i >= 0) runner.extensions.splice(i, 1);
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
    return { state: "hot", busy: !rec.session.isIdle, inFlight: rec.handoff.size };
  }

  // ── ⑧ hasEntries：存在性核对的唯一手段（I22 / §8.4③；按 id 逐条问，F4）─

  async hasEntries(endpointId: string, entryIds: string[]): Promise<Set<string>> {
    const rec = this.streams.get(endpointId);
    if (!rec) throw new PiPortError("NOT_HOT", `mesh-pi: hasEntries on cold endpoint ${endpointId}`);
    const alive = new Set<string>();
    for (const id of entryIds) {
      if (rec.session.sessionManager.getEntry(id) !== undefined) alive.add(id);
    }
    return alive;
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

  /** dispose：卸载全部流（§23.5：dispose 必须真卸载，不只是停止投递） */
  async dispose(): Promise<void> {
    for (const id of [...this.streams.keys()]) await this.evict(id);
    this.entryHandlers.clear();
    this.turnEndHandlers.clear();
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private async ensureHot(endpointId: string): Promise<StreamRec> {
    const rec = this.streams.get(endpointId);
    if (rec) return rec;
    // §8.3：投给 cold 流先恢复再投（恢复期间新消息在 Inbox 排队——调用方语义）
    await this.warm(endpointId);
    const hot = this.streams.get(endpointId);
    if (!hot) throw new PiPortError("NOT_HOT", `mesh-pi: warm did not yield a stream for ${endpointId}`);
    return hot;
  }

  private onSessionEvent(rec: StreamRec, ev: PiSessionEvent): void {
    if (this.streams.get(rec.endpointId) !== rec) return; // 已驱逐的流的迟到事件
    if (ev.type === "message_end" && ev.message?.role === "custom") {
      this.syncEntries(rec);
    } else if (ev.type === "turn_end") {
      // _flushPendingCustomMessages 在 listener 之后执行（pi 内部顺序），微任务后再差分
      queueMicrotask(() => this.syncEntries(rec));
      this.resetIdleTimer(rec);
      for (const h of [...this.turnEndHandlers]) {
        try {
          h({ endpointId: rec.endpointId });
        } catch {
          // 事件处理器抛错不影响投递（§12.5）
        }
      }
    } else if (ev.type === "agent_settled" || ev.type === "entry_appended") {
      queueMicrotask(() => this.syncEntries(rec));
      this.resetIdleTimer(rec);
    }
  }

  /**
   * entry 差分镜像：getEntries() 全量取，新发条目补发 onEntry。
   * 权威顺序 mesh_deliveries ↔ session JSONL → 镜像（§8.4）：这里只产出
   * 「这条流上出现了什么」的事实，判定交给 mailbox。
   */
  private syncEntries(rec: StreamRec): void {
    if (this.streams.get(rec.endpointId) !== rec) return;
    let entries: unknown[];
    try {
      entries = rec.session.sessionManager.getEntries();
    } catch {
      return; // session 已 dispose 的竞态：静默，驱逐流程会清场
    }
    for (const raw of entries) {
      const id = entryIdOf(raw);
      if (!id || rec.seen.has(id)) continue;
      rec.seen.add(id);
      const envelopeId = envelopeIdOf(raw);
      if (envelopeId) {
        rec.entryByEnvelope.set(envelopeId, id);
        rec.handoff.delete(envelopeId);
        for (const w of rec.waiters.splice(0)) {
          if (w.envelopeId === envelopeId) w.resolve(id);
          else rec.waiters.push(w);
        }
      }
      const evt: PortEntryEvent = {
        endpointId: rec.endpointId,
        entryId: id,
        ...(parentIdOf(raw) ? { parentId: parentIdOf(raw)! } : {}),
        ...(envelopeId ? { envelopeId } : {}),
        entryType: entryTypeOf(raw),
        seqInStream: ++rec.seqInStream, // F4：SessionEntry 无 seq，端口自流内编号
        rawJson: safeStringify(raw),
      };
      for (const h of [...this.entryHandlers]) {
        try {
          h(evt);
        } catch {
          // 同上：处理器抛错不影响投递
        }
      }
    }
  }

  private dropWaiter(rec: StreamRec, envelopeId: string): void {
    const i = rec.waiters.findIndex((w) => w.envelopeId === envelopeId);
    if (i >= 0) rec.waiters.splice(i, 1);
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

// ─── pi SessionEntry 的结构读取（type-only 依赖，运行期不 import pi）──────

function entryIdOf(e: unknown): string | undefined {
  const v = (e as { id?: unknown } | null)?.id;
  return typeof v === "string" ? v : undefined;
}

function parentIdOf(e: unknown): string | undefined {
  const v = (e as { parentId?: unknown } | null)?.parentId;
  return typeof v === "string" ? v : undefined;
}

function entryTypeOf(e: unknown): string {
  const v = (e as { type?: unknown } | null)?.type;
  return typeof v === "string" ? v : "unknown";
}

/** §8.5：mesh_message_id 靠 details.envelope.id 提取；note 的 data.envelopeId 同轨 */
function envelopeIdOf(e: unknown): string | undefined {
  const entry = e as { type?: unknown; details?: unknown; data?: unknown } | null;
  if (!entry) return undefined;
  if (entry.type === "custom_message") {
    const env = (entry.details as { envelope?: { id?: unknown } } | undefined)?.envelope;
    if (typeof env?.id === "string") return env.id;
    const direct = (entry.details as { envelopeId?: unknown } | undefined)?.envelopeId;
    if (typeof direct === "string") return direct;
  }
  if (entry.type === "custom") {
    const data = entry.data as { envelopeId?: unknown } | undefined;
    if (typeof data?.envelopeId === "string") return data.envelopeId;
  }
  return undefined;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "{}";
  } catch {
    return "{}";
  }
}

export const MESH_MESSAGE_CUSTOM_TYPE = "mesh.msg";
export const MESH_NUDGE_CUSTOM_TYPE = "mesh.nudge";
export const MESH_INBOX_CUSTOM_TYPE = "mesh.inbox";
