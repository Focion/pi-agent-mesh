// ═══════════════════════════════════════════════════════════════════════════
// Mailbox（§3.2 §6.2 §7 §8.3 §9.5）：一条 delivery 从 routed 到终态的执行者。
//
// 职责：定档（DeliveryPolicy）→ 唤醒判定（ActivationPolicy + A1/A2/A2'/A3
// 四条库层强制）→ 选端（EndpointSelector，null ⇒ parked）→ 三条进上下文
// 路径（P1 sendCustomMessage / P2 收件箱+激活时注入 / P3 note）→ 状态机
// 推进（delivered 的判据是 entry_appended，不是 deliver() 返回，F5）。
//
// 本构建的收窄（PLAN §1，P0+P1）：
// - 崩溃恢复的「双向核对」属性测试仍是 P2 形式（sweep 只做投递侧清扫：
//   parked TTL / handoff 超时 / 溢出折叠 / pending_acks 超时 / queue claim 回收）
// - 合并唤醒只在流空闲时执行（§7.8：忙流上 steer 会与 followUp 顺序反转）
// ═══════════════════════════════════════════════════════════════════════════

import type { Mailbox } from "./contracts.js";
import type { MeshEventBus } from "./events.js";
import { withPolicyTimeout } from "./policies.js";
import { withPolicyGuard } from "./policies.js";
import type { MeshRegistry } from "./registry.js";
import type { SqliteStore } from "./store.js";
import type { InProcessTransport } from "./transport.js";
import type {
  Account,
  AccountId,
  Cap,
  Conversation,
  DeliveryId,
  DegradeTarget,
  DropReason,
  EndpointId,
  Envelope,
  Grade,
  InboxView,
  Limits,
  MeshLease,
  MessageId,
  ParkReason,
  PendingDelivery,
  Policies,
  PolicySlot,
  PresenceState,
  SinkHandler,
  StreamPort,
  Transport,
  Unsubscribe,
} from "./types.js";
import { MeshRejectError } from "./types.js";
import { mechanicalDigest } from "./renderer.js";
import { DefaultRenderer, escapeDelims, verifyWrapped } from "./renderer.js";
import { WakeRateLimiter } from "./policies.js";
import { isoFromMs, isoNow, msFromIso, truncate, ulid } from "./util.js";

/** 折叠后仍是「在收件箱里」的状态（§7.5 未读口径 = C5 口径） */
const PENDING_STATES = "('routed','queued','parked','delivered')";

/** §7.10 原因码总表（drop）；devMode 下写入未登记码直接抛错（§7.10②） */
const DROP_REASONS = new Set<string>([
  "folded",
  "TTL_EXPIRED",
  "TRANSPORT_FAILED",
  "MAX_ATTEMPTS",
  "ACL_DENIED",
  "MUTED",
  "TOMBSTONED",
  "WAKE_THROTTLED_AND_EXPIRED",
]);
/** §7.10 原因码总表（parked）；同上，devMode 下写入未登记码抛错 */
const PARK_REASONS = new Set<string>([
  "ENDPOINT_GONE",
  "LEASE_HELD",
  "NO_SINK_HANDLER",
  "SINK_REFUSED",
  "PORT_TIMEOUT",
  "NO_SESSION",
]);

/** 渲染槽 I21 降级回的内建渲染器（M4 包裹保底，§12.3④） */
const builtinRenderer = new DefaultRenderer();

export interface MailboxDeps {
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  policies: Policies;
  limits: Limits;
  transport: Transport;
  /** 该端点是否本进程持有（sameHost 判断：本进程→直派，他进程→outbox）；可异步，缺省恒 true */
  isEndpointLocal?: (endpointId: EndpointId) => boolean | Promise<boolean>;
  /** StreamPort：装配层必须已接线（FakeStreamPort 或 mesh-pi 的 PiStreamPort） */
  port: StreamPort;
  /** sink/external 账号的宿主处理器（MeshHost.registerSinkHandler 注册） */
  sinkHandlers: Map<AccountId, SinkHandler>;
  /** §14：该账号是否有开集 pending_acks（矩阵行 1 与唤醒规则①） */
  awaitingCorrelations(accountId: AccountId): string[];
  /** 超时后由 @system 向发起方投消息（§14.3）；装配层接 Router.route */
  systemSend?: (input: {
    to: AccountId;
    conversationId: string;
    text: string;
    clientToken: string;
  }) => Promise<unknown>;
  devMode: boolean;
}

interface DeliveryRow {
  id: string;
  message_id: string;
  account_id: string;
  endpoint_id: string | null;
  grade: string | null;
  path: string | null;
  state: string;
  woke: number;
  note: string | null;
  attempts: number;
  handoff_at: string | null;
  parked_at: string | null;
  parked_reason: string | null;
  entry_id: string | null;
}

export class MeshMailbox implements Mailbox {
  private readonly d: MailboxDeps;
  private readonly rateLimiter: WakeRateLimiter;
  /** entryId → deliveryId：entry_appended 归因（handleEntryAppended 用） */
  private entryIndex = new Map<string, DeliveryId>();
  /** §7.4 降级留痕：已写过「转入摘要模式」note 的 (account, conv)（一次/跃迁） */
  private verbatimExitNoted = new Set<string>();

  constructor(deps: MailboxDeps) {
    this.d = deps;
    this.rateLimiter = new WakeRateLimiter(deps.limits);
  }

  // ── Router 提交后的扇出（§5.4 之后的全部投递语义）────────────────────

  async fanout(envelope: Envelope): Promise<void> {
    const rows = this.d.store.db
      .prepare<[string], DeliveryRow>(
        "SELECT * FROM mesh_deliveries WHERE message_id = ? AND state = 'routed'",
      )
      .all(envelope.id) as DeliveryRow[];
    for (const row of rows) {
      await this.deliverOne(envelope, row);
    }
  }

  /** 单条 delivery 的定档与投递；fanout 与 retryEndpoint 共用（幂等由状态机保证） */
  private async deliverOne(envelope: Envelope, row: DeliveryRow): Promise<void> {
    const d = this.d;
    const account = d.registry.getAccount(row.account_id);
    if (!account) {
      this.dropDelivery(row.id, envelope, "TRANSPORT_FAILED");
      return;
    }
    const conv = d.registry.getConversation(envelope.conversationId);
    if (!conv) {
      this.dropDelivery(row.id, envelope, "TRANSPORT_FAILED");
      return;
    }
    const membership = d.registry.getMembership(
      envelope.conversationId,
      row.account_id,
    );

    // MUTED（§7.10）：收件人静音了该会话 → 终态，不是失败重试
    if (
      membership?.mutedUntil &&
      msFromIso(membership.mutedUntil) > Date.now()
    ) {
      this.dropDelivery(row.id, envelope, "MUTED");
      return;
    }

    // ── A2'（§7.3）：sink/external 不参与唤醒判定，投递即算送达 ──
    if (account.endpointClass !== "stream") {
      await this.deliverToSink(envelope, row, account, conv);
      return;
    }

    // ── 选端（§8.1）：超时/抛错 → parked(ENDPOINT_GONE)（I21）──
    const topology =
      d.registry.endpointsOf(row.account_id)[0]?.topology ?? { kind: "unified" };
    const selected = await withPolicyTimeout(
      this.guardDeps("endpointSelector"),
      () =>
        d.policies.endpointSelector.select({
          accountId: row.account_id,
          conversationId: envelope.conversationId,
          envelope,
          topology,
        }),
      null,
    );
    const endpointId =
      selected === null || Array.isArray(selected)
        ? (selected?.[0] ?? null)
        : selected;
    if (!endpointId) {
      this.parkDelivery(row.id, envelope, "ENDPOINT_GONE");
      return;
    }
    const endpoint = d.registry.getEndpoint(endpointId);
    // LEASE_HELD（§8.3）：exclusive 租约窗口内的到达延后，不是丢弃
    if (
      endpoint?.lease === "exclusive" &&
      endpoint.leaseUntil &&
      msFromIso(endpoint.leaseUntil) > Date.now()
    ) {
      this.parkDelivery(row.id, envelope, "LEASE_HELD", endpointId);
      return;
    }

    // ── 原文预算（§7.4）：direct 恒在预算内；pinned 三态覆盖策略 ──
    const verbatim = this.isVerbatim(envelope, conv, row.account_id, membership);

    // ── 定档（§7.2 矩阵）：超时/抛错 → silent 不唤醒（§12.3①）──
    const memberCount = d.registry.memberCount(envelope.conversationId);
    let grade = await withPolicyTimeout(
      this.guardDeps("delivery"),
      () =>
        d.policies.delivery.grade({
          envelope,
          recipient: account,
          ...(membership
            ? {
                membership: {
                  conversationId: envelope.conversationId,
                  accountId: row.account_id,
                  caps: membership.caps,
                  joinedSeq: membership.joinedSeq,
                  ...(membership.mutedUntil
                    ? { mutedUntil: membership.mutedUntil }
                    : {}),
                  ...(membership.verbatimPinned !== undefined
                    ? { verbatimPinned: membership.verbatimPinned }
                    : {}),
                },
              }
            : {}),
          conversation: conv,
          memberCount,
          inbox: {
            conversationId: envelope.conversationId,
            kind: conv.kind,
            unread: 0,
            recent: [],
            verbatim,
            lastSeq: envelope.seq,
            lastAt: envelope.routedAt,
          },
          verbatim,
        }),
      "silent" as Grade,
    );

    // ── 背压（§7.8 扇出时层）：库自持 inFlight，不读 SDK 计数（F3）──
    const inFlight = this.inFlightCount(endpointId);
    let note: string | null = null;
    if (grade !== "silent" && inFlight >= this.d.limits.maxInFlight) {
      grade = "silent";
      note = "backpressure_downgrade"; // §23.4：降级留痕
      d.store.bumpCounter("backpressure_downgrade");
    }
    if (grade === "silent") d.store.bumpCounter("silent_grade");

    // ── A1（§7.3）：无 speak 的成员永不唤醒，路径恒 P3（只记账）──
    const caps = membership?.caps ?? [];
    const canSpeak = caps.includes("speak");

    // ── 路径选择（§7.6）：P3 = 无 speak；P2 = 超预算；P1 = 预算内 ──
    let path: "P1" | "P2" | "P3";
    if (!canSpeak) path = "P3";
    else if (!verbatim) path = "P2";
    else path = "P1";

    // ── 唤醒判定（§7.3）：四条默认规则 + direct 叠加，再过 A1/A2/A3 ──
    let woke = false;
    if (path === "P1") {
      const awaiting = d.awaitingCorrelations(row.account_id);
      const presence = this.presenceOf(row.account_id);
      let want = await withPolicyTimeout(
        this.guardDeps("activation"),
        () =>
          d.policies.activation.shouldWake({
            envelope,
            recipient: account,
            grade,
            expect: envelope.expect,
            awaitingCorrelations: awaiting,
            inbox: {
              conversationId: envelope.conversationId,
              kind: conv.kind,
              unread: 1,
              recent: [],
              verbatim,
              lastSeq: envelope.seq,
              lastAt: envelope.routedAt,
            },
            presence,
          }),
        false,
      );
      // 规则②：单聊任何消息都醒（策略签名无 conversation，Mailbox 叠加）
      if (conv.kind === "direct") want = true;
      // A1：只读成员永不唤醒（策略说了也不算）
      if (!canSpeak) want = false;
      // A2：dnd/offline 不唤醒；urgent 是默认例外
      if (
        (presence === "dnd" || presence === "offline") &&
        envelope.priority !== "urgent"
      ) {
        want = false;
      }
      // A3：唤醒速率上限；超限降为 silent（档位随之失去唤醒意义）
      if (want && this.rateLimiter.exceeds(row.account_id)) {
        want = false;
        grade = "silent";
        note = "wake_throttled"; // §7.3：限流仍投不出 ⇒ 终态 WAKE_THROTTLED_AND_EXPIRED
        d.store.bumpCounter("wake_throttled");
      }
      if (want) this.rateLimiter.record(row.account_id);
      woke = want;
    }

    // 定档与选端结果落库（queued = 定档完成，§7.9）
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, grade = ?, endpoint_id = ?, path = ?, woke = ?, note = ?, state_changed_at = ? " +
          "WHERE id = ?",
      )
      .run(isoNow(), grade, endpointId, path, woke ? 1 : 0, note, isoNow(), row.id);
    const live: DeliveryRow = { ...row, state: "queued", grade, endpoint_id: endpointId, path };

    // sameHost 跨进程：目标端点不在本进程 → 发布到 outbox（§19.3），由端点的持锁进程认领投递。
    // 定档/路径/唤醒已在上面判定并落库，接收方只渲染+入流（不再重定档）。
    const isLocal = await (this.d.isEndpointLocal?.(endpointId) ?? true);
    if (!isLocal) {
      const pending: PendingDelivery = {
        deliveryId: row.id,
        envelope,
        grade,
        accountId: row.account_id,
        endpointId,
      };
      await this.d.transport.publish(pending);
      return;
    }

    if (path === "P3") {
      // 只记账：note() ⇒ appendCustomEntry，进历史不进 LLM 上下文（§7.6）
      try {
        await d.port.note(endpointId, "mesh.audit", {
          envelopeId: envelope.id,
          seq: envelope.seq,
          conv: envelope.conversationId,
          from: envelope.from,
        });
        // note 完成即 delivered（§7.9 表：note() 完成）
        this.markDelivered(row.id, null);
      } catch {
        this.parkDelivery(row.id, envelope, "PORT_TIMEOUT", endpointId);
      }
      return;
    }

    if (path === "P2") {
      // 超预算：不碰 session，只留 Inbox；激活时经 context 注入摘要（§7.6）。
      // delivery 留在 queued —— 注入完成才 delivered（markInjectedDelivered）。
      // §7.4 降级留痕：该会话此前在预算内、本条起超预算 ⇒ 写一条 P3 note（一次/跃迁）。
      await this.noteVerbatimExit(envelope, row.account_id, endpointId);
      return;
    }

    // ── P1 ──
    // silent + 冷流：不升温，只入 Inbox；§7.2 表规定冷流 silent 落 parked（非终态）
    const portState = d.port.status(endpointId);
    if (grade === "silent" && portState.state === "cold") {
      d.store.bumpCounter("cold_hit");
      this.parkDelivery(row.id, envelope, "ENDPOINT_GONE", endpointId);
      return;
    }

    // 预算内：若此前因挤出写过降级 note，复位以便下次挤出再留痕
    this.verbatimExitNoted.delete(row.account_id + "/" + envelope.conversationId);

    // CATCHUP（§7.6）：从超预算回到预算内的跃迁点，固化一次追赶摘要
    await this.maybeCatchup(envelope, row.account_id, endpointId, conv);

    // 合并唤醒的时机约束（§7.8）：忙流上不投 steer —— 降为 triggerTurn:false，
    // 消息在本轮结束时可见（§2.2④），顺序不反转
    const busy = portState.busy;
    if (woke && busy) {
      woke = false;
      d.store.bumpCounter("wake_per_message_busy");
    } else if (woke) {
      d.store.bumpCounter("wake_per_message_idle");
    }
    this.d.store.db
      .prepare("UPDATE mesh_deliveries SET woke = ? WHERE id = ?")
      .run(woke ? 1 : 0, row.id);
    live.grade = grade;

    // 连续段（§7.7）：只投 cursorSeq 之后的下一条；有更早未投的先等（超时见 sweep ⑥）
    if (
      conv.kind !== "queue" &&
      !this.isNextInSegment(envelope, row.account_id, live)
    ) {
      return; // 留 queued；前面的投完（turn_end → drainQueued）或超时（sweep ⑥）后续投
    }

    await this.renderAndDeliver(envelope, live, endpointId, account, grade, woke);
  }

  /** P1 渲染 + 投递（§7.6 P1）：deliver resolve ≠ delivered（F5，entry_appended 才推进） */
  private async renderAndDeliver(
    envelope: Envelope,
    row: DeliveryRow,
    endpointId: EndpointId,
    account: Account,
    grade: Grade,
    woke: boolean,
  ): Promise<void> {
    const d = this.d;
    const rendered = this.renderForStream(account, envelope);
    d.store.bumpCounter("verbatim_copies");
    try {
      const res = await d.port.deliver(endpointId, rendered, envelope, grade, {
        triggerTurn: woke,
      });
      // 留 queued + handoff_at 诊断戳；entry_appended 到达才推进（handleEntryAppended）
      d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET handoff_at = ?, entry_id = ? WHERE id = ?",
        )
        .run(isoNow(), res.entryId ?? null, row.id);
      if (res.entryId) this.entryIndex.set(res.entryId, row.id);
    } catch {
      this.parkDelivery(row.id, envelope, "PORT_TIMEOUT", endpointId);
    }
  }

  /**
   * 渲染 stream 正文（§7.6 P1）：渲染槽受 I21 保护（抛错降级回内建渲染器），
   * 输出再走 M4 包裹校验（§10.3 防线 1）：devMode 未包裹直接抛错，生产强制加壳。
   */
  private renderForStream(account: Account, envelope: Envelope): string {
    const d = this.d;
    const ctx = { recipient: account, senderName: this.nameOf(envelope.from) };
    const rendered = withPolicyGuard(
      this.guardDeps("renderer"),
      () => d.policies.renderer.renderMessage(envelope, ctx),
      builtinRenderer.renderMessage(envelope, ctx),
    );
    const check = verifyWrapped(rendered);
    if (d.devMode && !check.ok) {
      throw new Error(
        "mesh: renderer output is not <<<MSG>>>-wrapped (§10.3 M4 / §23.7)",
      );
    }
    return check.ok ? rendered : check.fixed;
  }

  /** sink/external 渲染（§6.3③ 结构化 JSON，不套壳、不校验 M4 包裹） */
  private renderForSink(account: Account, envelope: Envelope): string {
    const d = this.d;
    const ctx = { recipient: account, senderName: this.nameOf(envelope.from) };
    return withPolicyGuard(
      this.guardDeps("renderer"),
      () => d.policies.renderer.renderMessage(envelope, ctx),
      builtinRenderer.renderMessage(envelope, ctx),
    );
  }

  /** sink / external（§6.3③）：渲染 JSON 交给宿主处理器，accepted 即 delivered */
  private async deliverToSink(
    envelope: Envelope,
    row: DeliveryRow,
    account: Account,
    conv: Conversation,
  ): Promise<void> {
    const d = this.d;
    const handler = d.sinkHandlers.get(row.account_id);
    if (!handler) {
      this.parkDelivery(row.id, envelope, "NO_SINK_HANDLER");
      return;
    }
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, path = 'P1', grade = ?, state_changed_at = ? WHERE id = ?",
      )
      .run(isoNow(), "followUp", isoNow(), row.id);
    const rendered = this.renderForSink(account, envelope);
    let result: { accepted: boolean; consumedImmediately?: boolean };
    try {
      result = await handler.deliver(rendered, envelope, "followUp");
    } catch {
      this.parkDelivery(row.id, envelope, "SINK_REFUSED");
      return;
    }
    if (!result.accepted) {
      this.parkDelivery(row.id, envelope, "SINK_REFUSED");
      return;
    }
    // sink 无 turn_end：accepted 即 delivered；consumedImmediately 连 consumed 一起推进
    this.markDelivered(row.id, null);
    if (result.consumedImmediately) await this.markConsumed(row.id);
    void conv;
  }

  // ── 原文预算（§7.4）────────────────────────────────────────────────────

  private isVerbatim(
    envelope: Envelope,
    conv: Conversation,
    accountId: AccountId,
    membership: { verbatimPinned?: boolean } | undefined,
  ): boolean {
    // sink/external 恒全量原文（§7.4 末）——调用方已分流，这里只处理 stream
    if (conv.kind === "direct") return true;
    if (membership?.verbatimPinned === true) return true;
    if (membership?.verbatimPinned === false) return false;
    // §7.6：被请求答复（expect 指向我）⇒ 本条按预算内投（跃迁点，CATCHUP 随后固化）
    const targetsMe =
      !envelope.to || envelope.to.length === 0 || envelope.to.includes(accountId);
    const mentionsMe = envelope.mentions?.includes(accountId) ?? false;
    if (envelope.expect !== "none" && (targetsMe || mentionsMe)) return true;
    if (!this.d.registry.spokeOrMentioned(envelope.conversationId, accountId)) {
      // 从未发言且从未被 @ ⇒ 恒定超预算（初值 0 当 -∞，§7.4 刚性条款）
      return false;
    }
    const budget = withPolicyGuard(
      this.guardDeps("retention"),
      () =>
        this.d.policies.retention.verbatimBudget({
          accountId,
          conversations: this.retentionCandidates(accountId),
        }),
      { bytes: Number.MAX_SAFE_INTEGER, ttlSeq: this.d.limits.verbatimGapK },
    );
    const gap = this.gapOf(envelope.conversationId, accountId);
    const gapOk = budget.ttlSeq === undefined || gap <= budget.ttlSeq;
    if (!gapOk) return false;
    // ≤ maxVerbatimConversations 个会话在预算内：以本条投递前已 in-budget 的计数判断
    const current = this.verbatimConversationCount(accountId);
    return current < this.d.limits.maxVerbatimConversations;
  }

  /** gap = next_seq - 1 - max(last_spoke_seq, last_mentioned_seq)（§7.4） */
  private gapOf(convId: string, accountId: AccountId): number {
    const row = this.d.store.db
      .prepare<[string, string], { s: number; m: number; next: number }>(
        "SELECT ms.last_spoke_seq AS s, ms.last_mentioned_seq AS m, c.next_seq AS next " +
          "FROM mesh_memberships ms JOIN mesh_conversations c ON c.id = ms.conversation_id " +
          "WHERE ms.conversation_id = ? AND ms.account_id = ?",
      )
      .get(convId, accountId);
    if (!row) return Number.MAX_SAFE_INTEGER;
    return row.next - 1 - Math.max(row.s, row.m);
  }

  /** 当前拿原文的会话数（direct 恒在内 + gap 达标的会话数，§7.4 计数条件） */
  private verbatimConversationCount(accountId: AccountId): number {
    const rows = this.d.store.db
      .prepare<[string], { conversation_id: string; s: number; m: number; next: number; pinned: number | null; type: string }>(
        "SELECT ms.conversation_id, ms.last_spoke_seq AS s, ms.last_mentioned_seq AS m, " +
          "ms.verbatim_pinned AS pinned, c.next_seq AS next, c.type AS type " +
          "FROM mesh_memberships ms JOIN mesh_conversations c ON c.id = ms.conversation_id " +
          "WHERE ms.account_id = ? AND ms.left_at IS NULL",
      )
      .all(accountId);
    let n = 0;
    for (const r of rows) {
      if (r.type === "direct" || r.pinned === 1) {
        n++;
        continue;
      }
      if (r.pinned === 0) continue;
      if (r.s <= 0 && r.m <= 0) continue; // 从未发言/被 @ ⇒ 不占预算位
      if (r.next - 1 - Math.max(r.s, r.m) <= this.d.limits.verbatimGapK) n++;
    }
    return n;
  }

  /** 预算决策的全量会话清单（§7.4：宿主 RetentionPolicy 据此算 bytes/count 预算） */
  private retentionCandidates(
    accountId: AccountId,
  ): Array<{
    id: string;
    kind: Conversation["kind"];
    gap: number;
    lastActiveSeq: number;
    unreadBytes: number;
  }> {
    const rows = this.d.store.db
      .prepare<
        [string],
        { conversation_id: string; s: number; m: number; next: number; type: string }
      >(
        "SELECT ms.conversation_id, ms.last_spoke_seq AS s, ms.last_mentioned_seq AS m, " +
          "c.next_seq AS next, c.type AS type " +
          "FROM mesh_memberships ms JOIN mesh_conversations c ON c.id = ms.conversation_id " +
          "WHERE ms.account_id = ? AND ms.left_at IS NULL",
      )
      .all(accountId);
    return rows.map((r) => ({
      id: r.conversation_id,
      kind: r.type as Conversation["kind"],
      gap: r.next - 1 - Math.max(r.s, r.m),
      lastActiveSeq: r.next - 1,
      unreadBytes: 0, // P0：字节预算的未读字节不计（DefaultRetentionPolicy 不看 bytes）
    }));
  }

  /**
   * CATCHUP 固化（§7.6）：本条会 P1 投递（回到预算内），若该会话此前有
   * 折叠/未读积压，先把追赶摘要作为一条 note 永久写进历史，cursorSeq
   * 前移、未读清零。只在跃迁时发生一次：overflow 清零后不再触发。
   */
  private async maybeCatchup(
    envelope: Envelope,
    accountId: AccountId,
    endpointId: EndpointId,
    conv: Conversation,
  ): Promise<void> {
    const inbox = this.d.store.db
      .prepare<[string, string], { overflow_count: number; cursor_seq: number; pending_count: number }>(
        "SELECT overflow_count, cursor_seq, pending_count FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?",
      )
      .get(accountId, envelope.conversationId);
    if (!inbox || (inbox.overflow_count <= 0 && inbox.pending_count <= 0)) return;

    // 待固化的未读（不含本条）：此前留在 queued 的 P2 投递
    const items = this.d.store.db
      .prepare<[string, string, number], { seq: number; from_account: string; text: string | null }>(
        "SELECT m.seq, m.from_account, json_extract(m.payload, '$.text') AS text " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? AND d.state = 'queued' " +
          "AND m.seq < ? ORDER BY m.seq",
      )
      .all(accountId, envelope.conversationId, envelope.seq) as Array<{
      seq: number;
      from_account: string;
      text: string | null;
    }>;
    if (items.length === 0 && inbox.overflow_count <= 0) return;

    const spanFrom = items[0]?.seq ?? Math.max(1, envelope.seq - inbox.overflow_count);
    const spanTo = items[items.length - 1]?.seq ?? envelope.seq - 1;
    const digest = mechanicalDigest(
      items.map((it) => ({
        from: it.from_account,
        name: this.nameOf(it.from_account),
        seq: it.seq,
        text: it.text ?? "",
      })),
    );
    try {
      await this.d.port.note(endpointId, "mesh.catchup", {
        conv: envelope.conversationId,
        missed: items.length,
        spanFrom,
        spanTo,
      });
    } catch {
      return; // 固化失败不阻塞本条投递；下一条跃迁时再试
    }
    // 未读清零：被固化的 queued 投递直接 consumed（进过历史，摘要形态）
    const ids = this.d.store.db
      .prepare<[string, string, number], { id: string }>(
        "SELECT d.id FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? AND d.state = 'queued' " +
          "AND m.seq < ? ORDER BY m.seq",
      )
      .all(accountId, envelope.conversationId, envelope.seq) as Array<{ id: string }>;
    this.d.store.tx(() => {
      const upd = this.d.store.db.prepare(
        "UPDATE mesh_deliveries SET state = 'consumed', consumed_at = ?, state_changed_at = ? WHERE id = ?",
      );
      for (const r of ids) upd.run(isoNow(), isoNow(), r.id);
      this.resetInboxPending(accountId, envelope.conversationId);
    });
    void conv;
  }

  /** 未读清零后重算 (account, conv) 的 pending 缓存（以 deliveries 为真相，§8.4④） */
  private resetInboxPending(accountId: AccountId, convId: string): void {
    const row = this.d.store.db
      .prepare<[string, string], { n: number; b: number; max_seq: number }>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(m.payload)), 0) AS b, MAX(m.seq) AS max_seq " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? AND d.state IN " +
          PENDING_STATES +
          " AND d.state <> 'routed'",
      )
      .get(accountId, convId);
    const n = row?.n ?? 0;
    const b = row?.b ?? 0;
    const maxSeq = row?.max_seq ?? 0;
    this.d.store.db
      .prepare(
        "UPDATE mesh_inboxes SET pending_count = ?, pending_bytes = ?, cursor_seq = MAX(cursor_seq, ?), " +
          "overflow_count = 0, overflow_summary = NULL WHERE account_id = ? AND conversation_id = ?",
      )
      .run(n, b, maxSeq, accountId, convId);
  }

  /** 连续段判定（§7.7）：本条 seq 是否是 cursorSeq+1，或此前无未投的更小 seq */
  private isNextInSegment(
    envelope: Envelope,
    accountId: AccountId,
    live: DeliveryRow,
  ): boolean {
    const row = this.d.store.db
      .prepare<
        [string, string, number, string],
        { n: number }
      >(
        "SELECT COUNT(*) AS n FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? AND m.seq < ? " +
          "AND d.state IN ('queued','parked','routed') AND d.id <> ?",
      )
      .get(accountId, envelope.conversationId, envelope.seq, live.id);
    return (row?.n ?? 0) === 0;
  }

  // ── StreamPort 回调（F5：delivered 的判据）────────────────────────────

  handleEntryAppended(e: {
    endpointId: EndpointId;
    entryId: string;
    parentId?: string;
    envelopeId?: string;
    entryType: string;
    seqInStream: number;
    rawJson: string;
  }): void {
    const d = this.d;
    const endpoint = d.registry.getEndpoint(e.endpointId);
    // 镜像入库（§8.5）：raw_json byte-fidelity；piSessionId 缺失时跳过镜像
    // （崩溃恢复不以镜像为权威，缺条目只影响回放，§8.4）
    if (endpoint?.piSessionId) {
      // 流表行可能在 warm 之前就有 entry 到达（宿主 open 已有 session）：惰性补一行，
      // 否则镜像的外键会炸（镜像不是权威，允许后补流记录）
      d.store.db
        .prepare(
          "INSERT OR IGNORE INTO mesh_streams (pi_session_id, endpoint_id, account_id, created_at) VALUES (?,?,?,?)",
        )
        .run(
          endpoint.piSessionId,
          e.endpointId,
          endpoint.accountId,
          isoNow(),
        );
      d.store.db
        .prepare(
          "INSERT OR IGNORE INTO mesh_stream_entries (entry_id, pi_session_id, parent_id, seq_in_stream, " +
            "entry_type, raw_json, mesh_message_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          e.entryId,
          endpoint.piSessionId,
          e.parentId ?? null,
          e.seqInStream,
          e.entryType,
          e.rawJson,
          e.envelopeId ?? null,
          isoNow(),
        );
      const stmt = d.store.db.prepare(
        "UPDATE mesh_streams SET last_entry_at = ?, entry_count = entry_count + 1, leaf_entry_id = ? WHERE pi_session_id = ?",
      );
      stmt.run(isoNow(), e.entryId, endpoint.piSessionId);
    }

    if (!e.envelopeId) return;
    // envelopeId → 该端点账号的 delivery 推进 delivered（§7.9①）
    const row = d.store.db
      .prepare<[string, string], DeliveryRow>(
        "SELECT d.* FROM mesh_deliveries d WHERE d.message_id = ? AND d.account_id = " +
          "(SELECT account_id FROM mesh_endpoints WHERE id = ?)",
      )
      .get(e.envelopeId, e.endpointId) as DeliveryRow | undefined;
    if (row && (row.state === "queued" || row.state === "routed")) {
      this.markDelivered(row.id, e.entryId);
      const env = this.envelopeOf(e.envelopeId);
      if (env) {
        d.events.emit("message_delivered", {
          envelope: env,
          endpointId: e.endpointId,
          accountId: row.account_id,
          grade: (row.grade ?? "followUp") as Grade,
          woke: !!row.woke, // §12.5：woke 是本投递是否触发轮次（deliverOne 已落库）
          path: (row.path ?? "P1") as "P1" | "P2" | "P3",
        });
      }
    }
  }

  handleTurnEnd(endpointId: EndpointId): void {
    const d = this.d;
    const rows = d.store.db
      .prepare<[string], DeliveryRow & { seq: number }>(
        "SELECT d.*, m.seq AS seq FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.endpoint_id = ? AND d.state = 'delivered'",
      )
      .all(endpointId) as Array<DeliveryRow & { seq: number }>;
    if (rows.length === 0) return;
    const now = isoNow();
    d.store.tx(() => {
      const upd = d.store.db.prepare(
        "UPDATE mesh_deliveries SET state = 'consumed', consumed_at = ?, state_changed_at = ? WHERE id = ?",
      );
      for (const r of rows) upd.run(now, now, r.id);
      // 按会话分组清未读 + 前移 cursorSeq
      const byConv = new Map<string, number>();
      for (const r of rows) {
        const conv = this.convOfMessage(r.message_id);
        byConv.set(
          conv,
          Math.max(byConv.get(conv) ?? 0, r.seq),
        );
      }
      for (const [convId, seq] of byConv) {
        const acct = rows.find((r) => this.convOfMessage(r.message_id) === convId);
        const accountId = acct?.account_id;
        if (!accountId) continue;
        this.resetInboxPending(accountId, convId);
        d.store.db
          .prepare(
            "UPDATE mesh_inboxes SET cursor_seq = MAX(cursor_seq, ?) WHERE account_id = ? AND conversation_id = ?",
          )
          .run(seq, accountId, convId);
      }
    });
    for (const r of rows) {
      const env = this.envelopeOf(r.message_id);
      if (env) {
        d.events.emit("message_consumed", {
          envelope: env,
          endpointId,
          accountId: r.account_id,
          partial: false,
          ...(r.entry_id ? { entryId: r.entry_id } : {}),
        });
      }
    }
    // §7.7：turn_end 前移了 cursorSeq，缺口可能已关闭——续投被阻塞的队头
    void this.drainQueued(endpointId);
  }

  /** sameHost 收件：由 Transport poller 认领后调用，渲染并写入目标端点的流。
   *  定档/唤醒判定已在发端完成（deliverOne 落库到 mesh_deliveries）；这里只负责
   *  stream 入流 → entry_appended 推进状态机（F5）。 */
  async handleOutboxDelivery(d: PendingDelivery): Promise<void> {
    const account = this.d.registry.getAccount(d.accountId);
    if (!account) {
      throw new Error(
        `mesh: outbox delivery to unknown account ${d.accountId}`,
      );
    }
    const rendered = this.renderForStream(account, d.envelope);
    const res = await this.d.port.deliver(
      d.endpointId ?? "",
      rendered,
      d.envelope,
      d.grade,
      { triggerTurn: false }, // 唤醒判定已在发端完成
    );
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET handoff_at = ?, entry_id = ? WHERE id = ?",
      )
      .run(isoNow(), res.entryId ?? null, d.deliveryId);
    if (res.entryId) this.entryIndex.set(res.entryId, d.deliveryId);
    // 推进 outbox 终态（§19.3）：投递成功 ⇒ done，避免 claimTtl 回收后重复投递。
    // InProcessTransport.ack 为 no-op；SameHostTransport.ack 落 done。
    await this.d.transport.ack(d.deliveryId, "delivered");
  }

  // ── 周期清扫（§8.4 ③ 的运行时形态）──────────────────────────────────

  async sweep(nowMs = Date.now()): Promise<void> {
    const d = this.d;
    // ① parked TTL（§7.9②：没有 TTL 的挂起等于静默丢失）
    const expired = d.store.db
      .prepare<[string], DeliveryRow>(
        "SELECT * FROM mesh_deliveries WHERE state = 'parked' AND parked_at < ?",
      )
      .all(isoFromMs(nowMs - d.limits.parkTtlMs)) as DeliveryRow[];
    for (const row of expired) {
      const env = this.envelopeOf(row.message_id);
      // §7.3：被 A3 限流且始终投不出（冷流 parked）的，TTL 时落专用原因码
      const reason =
        row.note === "wake_throttled" ? "WAKE_THROTTLED_AND_EXPIRED" : "TTL_EXPIRED";
      this.dropDelivery(row.id, env, reason);
      d.store.bumpCounter("park_expired");
    }

    // ② handoff 超时（§7.9①）：deliver 已返回但 entry_appended 一直不来
    const staleHandoff = d.store.db
      .prepare<[string], DeliveryRow>(
        "SELECT * FROM mesh_deliveries WHERE state = 'queued' AND handoff_at IS NOT NULL AND handoff_at < ?",
      )
      .all(isoFromMs(nowMs - d.limits.handoffTimeoutMs)) as DeliveryRow[];
    if (staleHandoff.length > 0) {
      d.store.bumpCounter("delivery_handoff_timeout");
      const upd = d.store.db.prepare(
        "UPDATE mesh_deliveries SET handoff_at = NULL, attempts = attempts + 1, state_changed_at = ? WHERE id = ?",
      );
      for (const row of staleHandoff) {
        upd.run(isoNow(), row.id);
        const env = this.envelopeOf(row.message_id);
        if (env && row.endpoint_id) await this.deliverOne(env, { ...row, state: "queued", handoff_at: null });
      }
    }

    // ③ 溢出折叠（§7.5）：两个上限，任一触发即折最旧一半
    this.foldOverflow();

    // ⑥ seq 缺口超时（§7.7）：连续段等待超 seqGapTimeoutMs 就跳过，宁乱序不卡死
    const gapRows = d.store.db
      .prepare<[string], DeliveryRow & { seq: number }>(
        "SELECT d.*, m.seq FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.state = 'queued' AND d.path = 'P1' AND d.handoff_at IS NULL AND d.endpoint_id IS NOT NULL " +
          "AND d.queued_at < ? ORDER BY m.seq",
      )
      .all(isoFromMs(nowMs - d.limits.seqGapTimeoutMs)) as Array<DeliveryRow & { seq: number }>;
    for (const row of gapRows) {
      const env = this.envelopeOf(row.message_id);
      if (!env || !row.endpoint_id) continue;
      if (this.isNextInSegment(env, row.account_id, row)) continue; // 缺口已关：留给 drainQueued 保序
      const account = d.registry.getAccount(row.account_id);
      if (!account) continue;
      d.store.bumpCounter("seq_gap");
      await this.renderAndDeliver(
        env,
        row,
        row.endpoint_id,
        account,
        (row.grade ?? "followUp") as Grade,
        !!row.woke,
      );
    }

    // ④ pending_acks 超时（§14.3）：转 timeout、发事件、@system 通知发起方
    const timedOut = d.store.db
      .prepare<[string], {
        correlation_id: string;
        from_account: string;
        to_account: string;
        intent: string | null;
        conversation_id: string;
      }>(
        "SELECT correlation_id, from_account, to_account, intent, conversation_id FROM mesh_pending_acks " +
          "WHERE state = 'open' AND deadline < ?",
      )
      .all(isoNow()) as Array<{
      correlation_id: string;
      from_account: string;
      to_account: string;
      intent: string | null;
      conversation_id: string;
    }>;
    for (const pa of timedOut) {
      d.store.db
        .prepare(
          "UPDATE mesh_pending_acks SET state = 'timeout' WHERE correlation_id = ? AND state = 'open'",
        )
        .run(pa.correlation_id);
      d.store.bumpCounter("request_timeout");
      d.events.emit("request_timeout", {
        correlationId: pa.correlation_id,
        from: pa.from_account,
        to: pa.to_account,
        ...(pa.intent ? { intent: pa.intent } : {}),
      });
      if (d.systemSend) {
        try {
          await d.systemSend({
            to: pa.from_account,
            conversationId: pa.conversation_id,
            text:
              `request timed out (correlationId=${pa.correlation_id}` +
              `${pa.intent ? `, type=${pa.intent}` : ""}); no answer arrived before the deadline`,
            clientToken: "timeout-" + pa.correlation_id,
          });
        } catch {
          // @system 投递失败只影响通知，不改超时判定
        }
      }
    }

    // ⑤ queue 租约回收（§17.2）：过期 claimed 回队或死信（满足 C13）
    await this.reclaimExpiredClaims(nowMs);
  }

  /** 溢出折叠（§7.5）：cursorSeq 前移 + dropped(folded) 两件事必须同时做 */
  private foldOverflow(): void {
    const d = this.d;
    const over = d.store.db
      .prepare<
        [number, number, number, number],
        {
          account_id: string;
          conversation_id: string;
          pending_count: number;
          pending_bytes: number;
          maxPending: number;
          maxPendingBytes: number;
        }
      >(
        "SELECT i.account_id, i.conversation_id, i.pending_count, i.pending_bytes, " +
          "COALESCE(json_extract(c.config, '$.maxPending'), ?) AS maxPending, " +
          "COALESCE(json_extract(c.config, '$.maxPendingBytes'), ?) AS maxPendingBytes " +
          "FROM mesh_inboxes i JOIN mesh_conversations c ON c.id = i.conversation_id " +
          "WHERE i.pending_count > COALESCE(json_extract(c.config, '$.maxPending'), ?) " +
          "OR i.pending_bytes > COALESCE(json_extract(c.config, '$.maxPendingBytes'), ?)",
      )
      .all(d.limits.maxPending, d.limits.maxPendingBytes, d.limits.maxPending, d.limits.maxPendingBytes) as Array<{
      account_id: string;
      conversation_id: string;
      pending_count: number;
      maxPending: number;
      maxPendingBytes: number;
    }>;
    for (const o of over) {
      const foldN = Math.max(1, Math.ceil(o.pending_count / 2));
      const victims = d.store.db
        .prepare<
          [string, string, number],
          { id: string; seq: number; from_account: string; text: string | null; bytes: number }
        >(
          "SELECT d.id, m.seq, m.from_account, json_extract(m.payload, '$.text') AS text, " +
            "LENGTH(m.payload) AS bytes " +
            "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
            "WHERE d.account_id = ? AND m.conversation_id = ? AND d.state IN " +
            "('queued','parked','delivered') ORDER BY m.seq LIMIT ?",
        )
        .all(o.account_id, o.conversation_id, foldN) as Array<{
        id: string;
        seq: number;
        from_account: string;
        text: string | null;
        bytes: number;
      }>;
      if (victims.length === 0) continue;
      const digest = mechanicalDigest(
        victims.map((v) => ({
          from: v.from_account,
          name: this.nameOf(v.from_account),
          seq: v.seq,
          text: v.text ?? "",
        })),
      );
      const lastSeq = victims[victims.length - 1]!.seq;
      // 被折叠行离开 pending 集合（C5 口径），pending 计数必须同事务扣减
      const foldedBytes = victims.reduce((s, v) => s + v.bytes, 0);
      const now = isoNow();
      d.store.tx(() => {
        const upd = d.store.db.prepare(
          "UPDATE mesh_deliveries SET state = 'dropped', drop_reason = 'folded', state_changed_at = ? WHERE id = ?",
        );
        for (const v of victims) upd.run(now, v.id);
        d.store.db
          .prepare(
            "UPDATE mesh_inboxes SET overflow_count = overflow_count + ?, overflow_summary = COALESCE(overflow_summary, '') || ?, " +
              "cursor_seq = MAX(cursor_seq, ?), pending_count = pending_count - ?, " +
              "pending_bytes = MAX(0, pending_bytes - ?) WHERE account_id = ? AND conversation_id = ?",
          )
          .run(
            victims.length,
            digest,
            lastSeq,
            victims.length,
            foldedBytes,
            o.account_id,
            o.conversation_id,
          );
      });
      d.store.bumpCounter("inbox_overflowed");
      d.store.bumpCounter("fold_events", victims.length);
      d.events.emit("inbox_overflowed", {
        accountId: o.account_id,
        conversationId: o.conversation_id,
        foldedCount: victims.length,
        foldedRange: [victims[0]!.seq, lastSeq],
      });
    }
  }

  /** warm 成功后：该端点 parked → queued 并重投（§7.9 parked→queued 边） */
  async retryEndpoint(endpointId: EndpointId): Promise<void> {
    const d = this.d;
    const endpoint = d.registry.getEndpoint(endpointId);
    // ENDPOINT_GONE 的 parked 行没选到端（endpoint_id NULL）：端点出现后按账号认领
    const rows = (
      endpoint
        ? d.store.db
            .prepare<[string, string], DeliveryRow>(
              "SELECT * FROM mesh_deliveries WHERE state = 'parked' AND " +
                "(endpoint_id = ? OR (endpoint_id IS NULL AND account_id = ?))",
            )
            .all(endpointId, endpoint.accountId)
        : d.store.db
            .prepare<[string], DeliveryRow>(
              "SELECT * FROM mesh_deliveries WHERE endpoint_id = ? AND state = 'parked'",
            )
            .all(endpointId)
    ) as DeliveryRow[];
    for (const row of rows) {
      await this.requeueParked(row);
    }
  }

  /** 账号级重投（§6.3③：sink handler 注册晚于投递到达 → NO_SINK_HANDLER 解除） */
  async retryAccount(accountId: AccountId): Promise<void> {
    const rows = this.d.store.db
      .prepare<[string], DeliveryRow>(
        "SELECT * FROM mesh_deliveries WHERE state = 'parked' AND account_id = ?",
      )
      .all(accountId) as DeliveryRow[];
    for (const row of rows) {
      await this.requeueParked(row);
    }
  }

  private async requeueParked(row: DeliveryRow): Promise<void> {
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, parked_reason = NULL, parked_at = NULL, state_changed_at = ? WHERE id = ?",
      )
      .run(isoNow(), isoNow(), row.id);
    const env = this.envelopeOf(row.message_id);
    if (env) await this.deliverOne(env, { ...row, state: "queued" });
  }

  /** I22：clearQueue 前把 delivered 未 consumed 回退为 queued（清空后重投） */
  async beforeClearQueue(endpointId: EndpointId): Promise<void> {
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, consumed_at = NULL, entry_id = NULL, state_changed_at = ? " +
          "WHERE endpoint_id = ? AND state = 'delivered'",
      )
      .run(isoNow(), isoNow(), endpointId);
  }

  /** sink/external 的消费确认（无 turn_end，§12.2 ④） */
  async markConsumed(deliveryId: DeliveryId): Promise<void> {
    const d = this.d;
    const row = d.store.db
      .prepare<[string], DeliveryRow>(
        "SELECT * FROM mesh_deliveries WHERE id = ?",
      )
      .get(deliveryId) as DeliveryRow | undefined;
    if (!row) return;
    if (row.state !== "delivered" && row.state !== "queued") return;
    const now = isoNow();
    const conv = this.convOfMessage(row.message_id);
    d.store.tx(() => {
      d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET state = 'consumed', consumed_at = ?, state_changed_at = ? WHERE id = ?",
        )
        .run(now, now, deliveryId);
      this.resetInboxPending(row.account_id, conv);
    });
    const env = this.envelopeOf(row.message_id);
    if (env) {
      d.events.emit("message_consumed", {
        envelope: env,
        endpointId: row.endpoint_id ?? "",
        accountId: row.account_id,
        partial: false,
        ...(row.entry_id ? { entryId: row.entry_id } : {}),
      });
    }
  }

  /** §7.6：P2 注入完成即 delivered（无 entry_id）；turn_end 再 consumed 并前移 cursorSeq */
  markInjectedDelivered(endpointId: EndpointId): void {
    const d = this.d;
    const ep = d.registry.getEndpoint(endpointId);
    if (!ep) return;
    const rows = d.store.db
      .prepare<[string], DeliveryRow>(
        "SELECT * FROM mesh_deliveries WHERE account_id = ? AND path = 'P2' AND state = 'queued'",
      )
      .all(ep.accountId) as DeliveryRow[];
    if (rows.length === 0) return;
    const now = isoNow();
    const upd = d.store.db.prepare(
      "UPDATE mesh_deliveries SET state = 'delivered', delivered_at = ?, entry_id = NULL, handoff_at = NULL, state_changed_at = ? WHERE id = ?",
    );
    d.store.tx(() => {
      for (const r of rows) upd.run(now, now, r.id);
    });
    for (const r of rows) {
      const env = this.envelopeOf(r.message_id);
      if (!env) continue;
      d.events.emit("message_delivered", {
        envelope: env,
        endpointId,
        accountId: r.account_id,
        grade: (r.grade ?? "followUp") as Grade,
        woke: !!r.woke,
        path: "P2",
      });
    }
  }

  /** §7.7 续投：缺口关闭后把被连续段阻塞的 queued P1 队头投出去（F5：一次只投一条） */
  private async drainQueued(endpointId: EndpointId): Promise<void> {
    const d = this.d;
    const rows = d.store.db
      .prepare<[string], DeliveryRow>(
        "SELECT d.* FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.endpoint_id = ? AND d.state = 'queued' AND d.path = 'P1' AND d.handoff_at IS NULL " +
          "ORDER BY m.seq",
      )
      .all(endpointId) as DeliveryRow[];
    for (const row of rows) {
      const env = this.envelopeOf(row.message_id);
      if (!env) continue;
      if (!this.isNextInSegment(env, row.account_id, row)) break; // 更早的还没完：停，保序
      const account = d.registry.getAccount(row.account_id);
      if (!account) continue;
      await this.renderAndDeliver(
        env,
        row,
        endpointId,
        account,
        (row.grade ?? "followUp") as Grade,
        !!row.woke,
      );
    }
  }

  /** §7.4 降级留痕：会话从预算内被挤出时写一条 P3 note（不进 LLM 上下文，一次/跃迁） */
  private async noteVerbatimExit(
    envelope: Envelope,
    accountId: AccountId,
    endpointId: EndpointId,
  ): Promise<void> {
    const d = this.d;
    const key = accountId + "/" + envelope.conversationId;
    if (this.verbatimExitNoted.has(key)) return;
    // 只有「此前拿过原文」的会话才有资格谈「挤出」（从未发言/被 @ 的恒超预算不算）
    const hadVerbatim = d.store.db
      .prepare<[string, string, number], { n: number }>(
        "SELECT COUNT(*) AS n FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? AND d.path = 'P1' AND m.seq < ?",
      )
      .get(accountId, envelope.conversationId, envelope.seq);
    if (!hadVerbatim || hadVerbatim.n === 0) return;
    this.verbatimExitNoted.add(key);
    try {
      await d.port.note(endpointId, "mesh.verbatim_exit", {
        conv: envelope.conversationId,
        atSeq: envelope.seq,
      });
    } catch {
      this.verbatimExitNoted.delete(key); // 失败则下次再试
    }
  }

  // ── 读路径 ──────────────────────────────────────────────────────────────

  inboxOf(accountId: AccountId): InboxView {
    const d = this.d;
    const convRows = d.store.db
      .prepare<[string], {
        conversation_id: string;
        type: string;
        topic: string | null;
        pending_count: number;
        overflow_count: number;
        overflow_summary: string | null;
        next_seq: number;
      }>(
        "SELECT i.conversation_id, c.type, c.topic, i.pending_count, i.overflow_count, i.overflow_summary, c.next_seq " +
          "FROM mesh_inboxes i JOIN mesh_conversations c ON c.id = i.conversation_id " +
          "WHERE i.account_id = ? AND (i.pending_count > 0 OR i.overflow_count > 0)",
      )
      .all(accountId) as Array<{
      conversation_id: string;
      type: string;
      topic: string | null;
      pending_count: number;
      overflow_count: number;
      overflow_summary: string | null;
      next_seq: number;
    }>;
    const conversations = convRows.map((r) => ({
      conversationId: r.conversation_id,
      kind: r.type as "direct" | "group" | "topic" | "queue",
      ...(r.topic ? { topic: r.topic } : {}),
      unread: r.pending_count,
      overflow: r.overflow_count > 0 ? r.overflow_count : undefined,
      summary: r.overflow_summary ?? undefined,
      recent: [] as InboxView["conversations"][number]["recent"],
      verbatim: false,
      lastSeq: r.next_seq - 1,
      lastAt: "",
    }));
    return { conversations, awaitingMyAck: [], awaitingTheirAck: [] };
  }

  /** P2 注入体（§7.6）：context 钩子每次 LLM 调用前重算，不落盘 */
  inboxInjection(endpointId: EndpointId): string | null {
    const endpoint = this.d.registry.getEndpoint(endpointId);
    if (!endpoint) return null;
    const view = this.inboxOf(endpoint.accountId);
    if (view.conversations.length === 0) return null;
    // 未读的原文（最近 3 条预览；P2 的摘要注入以 InboxView 为骨架）
    const blocks: string[] = [];
    for (const conv of view.conversations) {
      const recent = this.d.store.db
        .prepare<[string, string], { seq: number; from_account: string; text: string | null }>(
          "SELECT m.seq, m.from_account, json_extract(m.payload, '$.text') AS text " +
            "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
            "WHERE d.account_id = ? AND m.conversation_id = ? AND d.state IN " +
            "('queued','parked','delivered') ORDER BY m.seq DESC LIMIT 3",
        )
        .all(endpoint.accountId, conv.conversationId) as Array<{
        seq: number;
        from_account: string;
        text: string | null;
      }>;
      recent.reverse();
      const lines: string[] = [];
      if (conv.summary) lines.push(`[summary] ${escapeDelims(conv.summary)}`);
      lines.push(`[digest] ${conv.unread} unread message(s) in this conversation.`);
      if (recent.length > 0) {
        lines.push("[recent]");
        for (const r of recent) {
          lines.push(
            `  <<<MSG seq="${r.seq}" from="${r.from_account}">>> ${escapeDelims(truncate(r.text ?? "", 40))} <<<END MSG>>>`,
          );
        }
      }
      blocks.push(
        `<<<INBOX conv="${conv.conversationId}" unread="${conv.unread}" overflow="${conv.overflow ?? 0}">>>\n` +
          lines.join("\n") +
          "\n<<<END INBOX>>>",
      );
    }
    return blocks.join("\n\n");
  }

  /** 背压自持计数（F3/§7.8）：queued+delivered 行数，不读 SDK 字段 */
  inFlightCount(endpointId: EndpointId): number {
    const row = this.d.store.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM mesh_deliveries WHERE endpoint_id = ? AND state IN ('queued','delivered')",
      )
      .get(endpointId);
    return row?.n ?? 0;
  }

  // ── queue（§17）：claim / ack / 租约回收 ────────────────────────────────

  async claim(
    messageId: MessageId,
    by: AccountId,
  ): Promise<{ ok: boolean; leaseUntil?: string }> {
    const d = this.d;
    const nowMs = Date.now();
    const row = d.store.db
      .prepare<
        [string],
        { id: string; account_id: string; state: string; claim_until: string | null; claim_by: string | null }
      >(
        "SELECT d.id, d.account_id, d.state, d.claim_until, " +
          "json_extract(m.payload, '$.claim.by') AS claim_by " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.message_id = ? ORDER BY m.seq LIMIT 1",
      )
      .get(messageId) as
      | {
          id: string;
          account_id: string;
          state: string;
          claim_until: string | null;
          claim_by: string | null;
        }
      | undefined;
    if (!row) return { ok: false };

    if (row.state === "claimed") {
      const expired =
        row.claim_until !== null && msFromIso(row.claim_until) <= nowMs;
      if (row.claim_by === by) {
        if (expired) {
          throw new MeshRejectError(
            "CLAIM_EXPIRED",
            "your claim lease expired on " + messageId,
          );
        }
        return { ok: true, leaseUntil: row.claim_until ?? undefined };
      }
      if (!expired) {
        throw new MeshRejectError(
          "CLAIM_TAKEN",
          "message is claimed by " + (row.claim_by ?? "another worker"),
        );
      }
      // 他人租约已过期 → 回收后可再认领（fall through）
    }

    // C3：claimed/acked 必须曾经 delivered（已投递到流才可认领）
    if (row.state !== "delivered") return { ok: false };

    const convId = this.convOfMessage(messageId);
    const conv = d.registry.getConversation(convId);
    const claimTtlMs = conv?.config.claimTtlMs ?? d.limits.claimTtlMs;
    const until = isoFromMs(nowMs + claimTtlMs);
    const now = isoNow();
    d.store.tx(() => {
      d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET state = 'claimed', claim_until = ?, state_changed_at = ? WHERE id = ?",
        )
        .run(until, now, row.id);
      d.store.db
        .prepare(
          "UPDATE mesh_messages SET payload = json_set(payload, '$.claim', json_object('by', ?, 'at', ?)) WHERE id = ?",
        )
        .run(by, now, messageId);
      this.resetInboxPending(row.account_id, convId);
    });
    return { ok: true, leaseUntil: until };
  }

  async ackQueue(messageId: MessageId, by: AccountId, error?: unknown): Promise<void> {
    const row = this.claimedRowFor(messageId);
    if (!row || row.state !== "claimed") {
      throw new MeshRejectError(
        "NO_SUCH_CORRELATION",
        "message is not currently claimed: " + messageId,
      );
    }
    if (row.claim_by !== by) {
      throw new MeshRejectError(
        "CLAIM_TAKEN",
        "cannot ack a message claimed by " + (row.claim_by ?? "another worker"),
      );
    }
    if (error !== undefined) {
      await this.nackClaim(row);
      return;
    }
    const now = isoNow();
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'acked', claim_until = NULL, state_changed_at = ? WHERE id = ?",
      )
      .run(now, row.id);
  }

  async reclaimExpiredClaims(nowMs = Date.now()): Promise<void> {
    const cutoff = isoFromMs(nowMs);
    const d = this.d;
    const rows = d.store.db
      .prepare<[string], { id: string }>(
        "SELECT d.id FROM mesh_deliveries d " +
          "JOIN mesh_messages m ON m.id = d.message_id " +
          "JOIN mesh_conversations c ON c.id = m.conversation_id " +
          "WHERE c.type = 'queue' AND d.state = 'claimed' AND d.claim_until IS NOT NULL AND d.claim_until < ?",
      )
      .all(cutoff) as Array<{ id: string }>;
    for (const r of rows) {
      const row = this.claimedRowForDelivery(r.id);
      if (row) await this.nackClaim(row);
    }
  }

  /** 取一条 queue delivery 的 claim 归属（用于 ack 断言与回收） */
  private claimedRowFor(messageId: MessageId): {
    id: string;
    message_id: string;
    account_id: string;
    conversation_id: string;
    state: string;
    attempts: number;
    claim_by: string | null;
  } | null {
    return this.d.store.db
      .prepare<
        [string],
        {
          id: string;
          message_id: string;
          account_id: string;
          conversation_id: string;
          state: string;
          attempts: number;
          claim_by: string | null;
        }
      >(
        "SELECT d.id, d.message_id, d.account_id, d.state, d.attempts, m.conversation_id, " +
          "json_extract(m.payload, '$.claim.by') AS claim_by " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.message_id = ? ORDER BY m.seq LIMIT 1",
      )
      .get(messageId) as
      | {
          id: string;
          message_id: string;
          account_id: string;
          conversation_id: string;
          state: string;
          attempts: number;
          claim_by: string | null;
        }
      | null;
  }

  private claimedRowForDelivery(deliveryId: DeliveryId): {
    id: string;
    message_id: string;
    account_id: string;
    conversation_id: string;
    state: string;
    attempts: number;
    claim_by: string | null;
  } | null {
    return this.d.store.db
      .prepare<
        [string],
        {
          id: string;
          message_id: string;
          account_id: string;
          conversation_id: string;
          state: string;
          attempts: number;
          claim_by: string | null;
        }
      >(
        "SELECT d.id, d.message_id, d.account_id, d.state, d.attempts, m.conversation_id, " +
          "json_extract(m.payload, '$.claim.by') AS claim_by " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.id = ?",
      )
      .get(deliveryId) as
      | {
          id: string;
          message_id: string;
          account_id: string;
          conversation_id: string;
          state: string;
          attempts: number;
          claim_by: string | null;
        }
      | null;
  }

  /** nack / 租约过期：claimed → queued（重投）或 MAX_ATTEMPTS → dropped */
  private async nackClaim(row: {
    id: string;
    message_id: string;
    account_id: string;
    conversation_id: string;
    attempts: number;
  }): Promise<void> {
    const d = this.d;
    const attempts = row.attempts + 1;
    const env = this.envelopeOf(row.message_id);
    if (attempts > d.limits.maxAttempts) {
      d.store.tx(() => {
        d.store.db
          .prepare(
            "UPDATE mesh_deliveries SET state = 'dropped', drop_reason = 'MAX_ATTEMPTS', claim_until = NULL, attempts = ?, state_changed_at = ? WHERE id = ?",
          )
          .run(attempts, isoNow(), row.id);
      });
      if (env) d.events.emit("message_dropped", { envelope: env, reason: "MAX_ATTEMPTS" });
      return;
    }
    const now = isoNow();
    d.store.tx(() => {
      d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, claim_until = NULL, endpoint_id = NULL, attempts = ?, " +
            "state_changed_at = ? WHERE id = ?",
        )
        .run(now, attempts, now, row.id);
      this.resetInboxPending(row.account_id, row.conversation_id);
    });
    // 回队后重投（本 worker 重试：单 consumers 简化，见 notes/review）
    const live = d.store.db
      .prepare<[string], DeliveryRow>("SELECT * FROM mesh_deliveries WHERE id = ?")
      .get(row.id) as DeliveryRow | undefined;
    if (env && live) {
      await this.deliverOne(env, { ...live, state: "queued", endpoint_id: null, attempts });
    }
  }

  // ── 内部：状态跃迁与事件 ────────────────────────────────────────────────

  private markDelivered(deliveryId: DeliveryId, entryId: string | null): void {
    const d = this.d;
    const now = isoNow();
    d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'delivered', delivered_at = ?, entry_id = ?, handoff_at = NULL, state_changed_at = ? " +
          "WHERE id = ? AND state IN ('queued','routed')",
      )
      .run(now, entryId, now, deliveryId);
  }

  private parkDelivery(
    deliveryId: DeliveryId,
    envelope: Envelope | null,
    reason: ParkReason,
    endpointId?: EndpointId,
  ): void {
    const d = this.d;
    if (d.devMode && !PARK_REASONS.has(reason)) {
      throw new Error(`mesh: unregistered parked_reason "${reason}" (§7.10②)`);
    }
    const now = isoNow();
    d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'parked', parked_reason = ?, parked_at = ?, " +
          "state_changed_at = ?, endpoint_id = COALESCE(?, endpoint_id) WHERE id = ?",
      )
      .run(reason, now, now, endpointId ?? null, deliveryId);
    d.store.bumpCounter("parked_total");
    if (envelope) {
      d.events.emit("message_parked", {
        envelope,
        ...(endpointId ? { endpointId } : {}),
        reason,
      });
    }
  }

  private dropDelivery(
    deliveryId: DeliveryId,
    envelope: Envelope | null,
    reason: DropReason,
  ): void {
    const d = this.d;
    if (d.devMode && !DROP_REASONS.has(reason)) {
      throw new Error(`mesh: unregistered drop_reason "${reason}" (§7.10②)`);
    }
    const now = isoNow();
    d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'dropped', drop_reason = ?, state_changed_at = ? WHERE id = ?",
      )
      .run(reason, now, deliveryId);
    if (envelope) {
      d.events.emit("message_dropped", { envelope, reason });
    }
  }

  private envelopeOf(messageId: string): Envelope | null {
    const row = this.d.store.db
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM mesh_messages WHERE id = ?",
      )
      .get(messageId);
    if (!row) return null;
    const payload = JSON.parse((row.payload as string) ?? "{}") as {
      text?: string;
    };
    return {
      id: row.id as string,
      seq: row.seq as number,
      from: row.from_account as string,
      fromEndpoint: (row.from_endpoint as string | null) ?? null,
      routedAt: row.routed_at as string,
      idempotencyKey: (row.idempotency_key as string) ?? "",
      conversationId: row.conversation_id as string,
      kind: row.kind as Envelope["kind"],
      expect: row.expect as Envelope["expect"],
      priority: (row.priority ?? undefined) as Envelope["priority"],
      to: row.to_accounts
        ? (JSON.parse(row.to_accounts as string) as string[])
        : undefined,
      mentions: row.mentions
        ? (JSON.parse(row.mentions as string) as string[])
        : undefined,
      replyTo: (row.reply_to as string | null) ?? undefined,
      correlationId: (row.correlation_id as string | null) ?? undefined,
      requestType: (row.intent as string | null) ?? undefined,
      logicalTs: (row.logical_ts as string | null) ?? undefined,
      payload: { text: payload.text },
      ext:
        row.ext === null || row.ext === undefined
          ? undefined
          : (JSON.parse(row.ext as string) as unknown),
    };
  }

  private convOfMessage(messageId: string): string {
    const row = this.d.store.db
      .prepare<[string], { conversation_id: string }>(
        "SELECT conversation_id FROM mesh_messages WHERE id = ?",
      )
      .get(messageId);
    return row?.conversation_id ?? "";
  }

  private presenceOf(accountId: AccountId): PresenceState {
    const row = this.d.store.db
      .prepare<[string], { presence: string; presence_until: string | null }>(
        "SELECT presence, presence_until FROM mesh_accounts WHERE id = ?",
      )
      .get(accountId);
    if (!row) return "offline";
    const expired =
      row.presence_until !== null && Date.parse(row.presence_until) < Date.now();
    // §15 派生规则：宿主未设（或 until 已过期回落）时由端点状态派生 ——
    // 任一端点 hot ⇒ available；全冷 ⇒ offline。dnd/busy 等宿主显式值原样生效。
    if (row.presence === "offline" || expired) {
      const hot = this.d.registry
        .endpointsOf(accountId)
        .some((e) => e.state === "hot" || e.state === "warming");
      return hot ? "available" : "offline";
    }
    return row.presence as PresenceState;
  }

  private nameOf(accountId: AccountId): string {
    const row = this.d.store.db
      .prepare<[string], { display_name: string }>(
        "SELECT display_name FROM mesh_accounts WHERE id = ?",
      )
      .get(accountId);
    return row?.display_name ?? accountId;
  }

  private guardDeps(
    slot:
      | "delivery"
      | "activation"
      | "endpointSelector"
      | "renderer"
      | "retention",
  ): {
    slot:
      | "delivery"
      | "activation"
      | "endpointSelector"
      | "renderer"
      | "retention";
    timeoutMs: number;
    degradedTo: DegradeTarget;
    onDegraded: (
      reason: "timeout" | "threw",
      slot: PolicySlot,
      degradedTo: DegradeTarget,
    ) => void;
  } {
    const d = this.d;
    const degradedTo: DegradeTarget =
      slot === "endpointSelector"
        ? "parked"
        : slot === "renderer"
          ? "builtin_renderer"
          : slot === "retention"
            ? "cursor_only"
            : "silent_no_wake";
    return {
      slot,
      timeoutMs: d.limits.policyTimeoutMs,
      degradedTo,
      onDegraded: (reason, s, target) => {
        d.events.emit("policy_degraded", {
          slot: s,
          reason,
          degradedTo: target,
        });
        d.store.bumpCounter("policy_degraded");
      },
    };
  }
}

export type { MeshLease, Unsubscribe, Cap };
