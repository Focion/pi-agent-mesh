// ═══════════════════════════════════════════════════════════════════════════
// 九个策略槽的默认实现 + withPolicyTimeout（I21）。
//
// I21：任何槽超过 policyTimeoutMs（默认 50ms）或抛异常，库必须用内建默认
// 实现的结果继续，并必须发 policy_degraded 事件。降级方向逐槽：
//   delivery      → silent + 不唤醒（少醒一次比乱醒一片好排查）
//   activation    → 不唤醒
//   floor         → free_for_all（全群失声比一次嘈杂更难发现）
//   renderer      → 内建渲染器（必须保住 M4 包裹）
//   clock         → 墙钟（顺序权威是 seq）
//   accessControl → 拒绝 fail-closed（唯一一个）
//   retention     → 不给原文（上下文爆掉是最贵的失败）
//   endpointSelector → parked(ENDPOINT_GONE)（宁可等，不可乱投）
//   sessionFactory → parked(NO_SESSION) + 告警（不受 policyTimeoutMs 约束）
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AccessControl,
  AccountId,
  ActivationPolicy,
  ConversationId,
  DeliveryPolicy,
  DegradeTarget,
  EndpointId,
  EndpointSelector,
  Envelope,
  FloorPolicy,
  Grade,
  Limits,
  LogicalClock,
  Policies,
  PolicySlot,
  PresenceState,
  RetentionPolicy,
  StreamTopology,
  VerbatimBudget,
} from "./types.js";
import { DefaultRenderer } from "./renderer.js";
import { sha256Hex } from "./util.js";

// ─── withPolicyTimeout（I21）──────────────────────────────────────────────

export interface PolicyTimeoutDeps {
  slot: PolicySlot;
  timeoutMs: number;
  degradedTo: DegradeTarget;
  onDegraded: (
    reason: "timeout" | "threw",
    slot: PolicySlot,
    degradedTo: DegradeTarget,
  ) => void;
}

/**
 * 包装一个策略调用：同步槽直接执行；异步槽与超时竞速。
 * 抛错 / 超时 → 返回 fallback 并回调 onDegraded（由装配层发 policy_degraded 事件 + 计数器）。
 */
export async function withPolicyTimeout<T>(
  deps: PolicyTimeoutDeps,
  fn: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  const timer = new Promise<"timeout">((resolve) => {
    const t = setTimeout(() => resolve("timeout"), deps.timeoutMs);
    if (typeof t === "object" && t && "unref" in t) t.unref();
  });
  let result: T;
  try {
    const race = await Promise.race([Promise.resolve().then(fn), timer]);
    if (race === "timeout") {
      deps.onDegraded("timeout", deps.slot, deps.degradedTo);
      return fallback;
    }
    result = race as T;
  } catch {
    deps.onDegraded("threw", deps.slot, deps.degradedTo);
    return fallback;
  }
  return result;
}

/** 同步版（多数槽是同步的）：抛错即降级；同步槽无法超时，但契约允许（§12.3①） */
export function withPolicyGuard<T>(
  deps: PolicyTimeoutDeps,
  fn: () => T,
  fallback: T,
): T {
  try {
    return fn();
  } catch {
    deps.onDegraded("threw", deps.slot, deps.degradedTo);
    return fallback;
  }
}

// ─── ① DeliveryPolicy：§7.2 档位映射矩阵 ─────────────────────────────────

/**
 * 规模列：direct=0, 小群(3–8)=1, 中群(9–30)=2, 大群(30+)=3。
 * `groupTiers` 语义（附录 F.1）= [小群下界, 小群上界, 中群上界]（默认 [3,8,30]），
 * 因此小群上界取 `tiers[1]`、中群上界取 `tiers[2]`（`tiers[0]` 是下界，上界判定不读它）。
 */
export function memberTier(
  memberCount: number,
  tiers: [number, number, number],
): 0 | 1 | 2 | 3 {
  if (memberCount <= 2) return 0;
  if (memberCount <= tiers[1]) return 1; // 3–8
  if (memberCount <= tiers[2]) return 2; // 9–30
  return 3; // 30+
}

export interface DeliveryMatrixDeps {
  /** 该收件人是否在等这个 correlationId（矩阵第 1 行；§14 应答回来） */
  isAwaiting(accountId: string, correlationId: string | undefined): boolean;
  limits: Limits;
}

export class DefaultDeliveryPolicy implements DeliveryPolicy {
  private readonly deps: DeliveryMatrixDeps;

  constructor(deps: DeliveryMatrixDeps) {
    this.deps = deps;
  }

  grade(ctx: {
    envelope: Envelope;
    recipient: { id: string };
    conversation: { kind: string };
    memberCount: number;
    verbatim: boolean;
  }): Grade {
    const env = ctx.envelope;
    const me = ctx.recipient.id;
    const tier =
      ctx.conversation.kind === "topic"
        ? ("topic" as const)
        : ctx.conversation.kind === "queue"
          ? ("queue" as const)
          : memberTier(ctx.memberCount, this.deps.limits.groupTiers);
    const targetsMe = !env.to || env.to.length === 0 || env.to.includes(me);
    const mentionsMe = env.mentions?.includes(me) ?? false;

    // 行 1：带我在等的 correlationId 的应答 → steer（所有列）
    if (env.correlationId && this.deps.isAwaiting(me, env.correlationId))
      return "steer";
    // 行 2：expect=reply 且指向我
    if (env.expect === "reply" && (targetsMe || mentionsMe)) {
      return tier === 3 ? "followUp" : "steer";
    }
    // 行 3：to 含我
    if (env.to && env.to.includes(me)) {
      return tier === 3 ? "followUp" : "steer";
    }
    // 行 4：urgent
    if (env.priority === "urgent") {
      if (tier === "topic") return "followUp";
      if (tier === "queue") return "steer";
      return tier >= 2 ? "followUp" : "steer";
    }
    // 行 7：event 播报 → silent（所有列）
    if (env.kind === "event") return "silent";
    // 行 8：low / 只读（verbatim=false 由预算外统一 silent 覆盖）
    if (env.priority === "low") return "silent";
    // 行 5/6：普通 chat —— 预算内按规模，预算外一律 silent
    if (!ctx.verbatim) return "silent";
    switch (tier) {
      case 0:
      case 1:
        return "followUp";
      case 2:
        return "followUp";
      case 3:
        return "silent";
      case "topic":
        return "silent";
      case "queue":
        return "followUp";
      default:
        return "followUp";
    }
  }
}

// ─── ② ActivationPolicy：§7.3 expect_driven 四条规则 ────────────────────

export class DefaultActivationPolicy implements ActivationPolicy {
  shouldWake(ctx: {
    envelope: Envelope;
    recipient: { id: string };
    grade: Grade;
    expect: "ack" | "reply" | "none";
    awaitingCorrelations: string[];
    presence: PresenceState;
  }): boolean {
    const env = ctx.envelope;
    const me = ctx.recipient.id;
    const targetsMe = !env.to || env.to.length === 0 || env.to.includes(me);
    const mentionsMe = env.mentions?.includes(me) ?? false;
    return (
      (env.correlationId !== undefined &&
        ctx.awaitingCorrelations.includes(env.correlationId)) || // ① 我在等的应答回来
      (env.expect !== "none" && (targetsMe || mentionsMe)) || // ②③ 有期望且指向我（§12.3②：expect ≠ none 唤醒）
      env.priority === "urgent" // ④ 紧急
    );
    // ② 单聊任何消息都醒 —— 由 Mailbox 以 conversation.kind === "direct" 叠加
  }
}

// ─── ③ FloorPolicy：free_for_all（§13）───────────────────────────────────

export class FreeForAllFloorPolicy implements FloorPolicy {
  grantFloor(ctx: { candidates: AccountId[] }): AccountId[] {
    return ctx.candidates;
  }
}

// ─── ⑤ LogicalClock：墙钟 ISO-8601 字典序 ────────────────────────────────

export class WallClockLogicalClock implements LogicalClock {
  compare(a: string | undefined, b: string | undefined): number {
    if (a === b) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  format(ts: string): string {
    return ts;
  }
}

// ─── ⑥ AccessControl：全部放行（caps / Acl 仍由库内建判定生效）─────────

export class AllowAllAccessControl implements AccessControl {
  canRead(): boolean {
    return true;
  }
  canWrite(): boolean {
    return true;
  }
  canAdmin(): boolean {
    return true;
  }
  canSend(): boolean {
    return true;
  }
  canPublish(): boolean {
    return true;
  }
  canInitiateDirect(): boolean {
    return true;
  }
  canJoin(): boolean {
    return true;
  }
  resolveCustomTag(): boolean {
    return true;
  }
}

// ─── ⑦ RetentionPolicy：gap ≤ K 且 ≤3 会话，LRU 挤出（§7.4）────────────

export class DefaultRetentionPolicy implements RetentionPolicy {
  private readonly gapK: number;

  constructor(gapK = 20) {
    this.gapK = gapK;
  }

  /**
   * 返回预算参数：ttlSeq = gap 阈值；bytes = 原文总字节预算（默认策略不限
   * 字节——§7.4 的默认只看 gap 与会话数，字节条件留给宿主覆盖时表达）。
   */
  verbatimBudget(_ctx: {
    accountId: AccountId;
    conversations: Array<{
      id: ConversationId;
      gap: number;
      lastActiveSeq: number;
      unreadBytes: number;
    }>;
  }): VerbatimBudget {
    void _ctx;
    return { bytes: Number.MAX_SAFE_INTEGER, ttlSeq: this.gapK };
  }
}

// ─── ⑧ EndpointSelector：按拓扑解析（§8.1）──────────────────────────────

export interface EndpointLookupDeps {
  endpointsOf(accountId: string): Array<{ id: EndpointId; inFlight: number; topology: StreamTopology }>;
}

export class TopologyEndpointSelector implements EndpointSelector {
  private readonly deps: EndpointLookupDeps;

  constructor(deps: EndpointLookupDeps) {
    this.deps = deps;
  }

  select(ctx: {
    accountId: AccountId;
    conversationId: ConversationId;
    envelope: Envelope;
    topology: StreamTopology;
  }): EndpointId | EndpointId[] | null {
    const eps = this.deps.endpointsOf(ctx.accountId);
    if (eps.length === 0) return null;
    switch (ctx.topology.kind) {
      case "unified":
        return eps[0]!.id;
      case "pooled": {
        if (ctx.topology.affinity === "none" || !ctx.topology.affinity) {
          // 取当前 inFlight 最小的一条（§8.1 表）
          let best = eps[0]!;
          for (const e of eps) if (e.inFlight < best.inFlight) best = e;
          return best.id;
        }
        const anchor =
          ctx.topology.affinity === "sender"
            ? ctx.envelope.from
            : ctx.conversationId;
        const idx = sha256Hex(anchor).codePointAt(0)! % eps.length;
        return eps[idx]!.id;
      }
      case "perConversation": {
        // §8.1：endpointId = hash(accountId, key)。key = 会话（scope="conversation"）或
        // 用途（scope="purpose" ← requestType）。注册端点带 scope_key（ux_endpoint_percv
        // 唯一）→ 先精确命中；无命中则在 perConversation 端点里按 hash 稳定选一条兜底。
        const scope = ctx.topology.scope ?? "conversation";
        const key = scope === "purpose" ? (ctx.envelope.requestType ?? ctx.envelope.kind) : ctx.conversationId;
        const percv = eps.filter((e) => e.topology.kind === "perConversation");
        if (percv.length === 0) return eps[0]!.id; // 账号未按 perConversation 注册 ⇒ 回退首条
        const exact = percv.find((e) => e.topology.kind === "perConversation" && e.topology.key === key);
        if (exact) return exact.id;
        const idx = sha256Hex(`${ctx.accountId}:${key}`).codePointAt(0)! % percv.length;
        return percv[idx]!.id;
      }
      default:
        return eps[0]!.id;
    }
  }
}

// ─── 唤醒速率限制（A3，§7.3）────────────────────────────────────────────

/** 进程内滑动窗口；A3 的库层强制（策略返回 true 也降级） */
export class WakeRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(private readonly limits: Limits) {}

  /** 是否已超限（超限则强制降为 silent，计 wake_throttled） */
  exceeds(accountId: AccountId, now = Date.now()): boolean {
    const win = this.windows.get(accountId) ?? [];
    const fresh = win.filter(
      (t) => now - t < this.limits.wakeRateLimit.windowMs,
    );
    this.windows.set(accountId, fresh);
    return fresh.length >= this.limits.wakeRateLimit.count;
  }

  /** 实际唤醒后记录 */
  record(accountId: AccountId, now = Date.now()): void {
    const win = this.windows.get(accountId) ?? [];
    win.push(now);
    this.windows.set(accountId, win);
  }

  reset(): void {
    this.windows.clear();
  }
}

// ─── 装配：默认 Policies（sessionFactory 必填由调用方提供）──────────────

export interface DefaultPolicyDeps
  extends DeliveryMatrixDeps,
    EndpointLookupDeps {
  limits: Limits;
}

export function createDefaultPolicies(
  deps: DefaultPolicyDeps,
): Omit<Policies, "sessionFactory"> {
  return {
    delivery: new DefaultDeliveryPolicy({
      isAwaiting: deps.isAwaiting,
      limits: deps.limits,
    }),
    activation: new DefaultActivationPolicy(),
    floor: new FreeForAllFloorPolicy(),
    renderer: new DefaultRenderer(),
    clock: new WallClockLogicalClock(),
    accessControl: new AllowAllAccessControl(),
    retention: new DefaultRetentionPolicy(deps.limits.verbatimGapK),
    endpointSelector: new TopologyEndpointSelector({
      endpointsOf: deps.endpointsOf,
    }),
  };
}

/** 单聊叠加唤醒（§7.3 规则②：direct 任何消息都醒）—— 由 Mailbox 调用 */
export function directConversationWakes(kind: string): boolean {
  return kind === "direct";
}

/** A2：presence ∈ {dnd, offline} 时不唤醒；urgent 是默认开启的例外（§7.3） */
export function presenceBlocksWake(
  presence: PresenceState,
  priority: string | undefined,
): boolean {
  return (
    (presence === "dnd" || presence === "offline") && priority !== "urgent"
  );
}
