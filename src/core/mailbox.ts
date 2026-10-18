// ═══════════════════════════════════════════════════════════════════════════
// Mailbox（§3.2 §6.2 §7 §8.3 §9.5）：一条 delivery 从 routed 到终态的执行者。
//
// 职责：定档（DeliveryPolicy）→ 唤醒判定（ActivationPolicy + A1/A2/A2'/A3
// 四条库层强制）→ 选端（EndpointSelector，null ⇒ parked）→ 三条进上下文
// 路径（P1 sendCustomMessage / P2 收件箱+激活时注入 / P3 note）→ 状态机
// 推进（delivered 的判据是 entry_appended，不是 deliver() 返回，F5）。
//
// 本构建的收窄（PLAN §1，P0+P1）：
// - 崩溃恢复的「双向核对」（§8.4）：deterministic 用例 + 幂等断言已落
//   （reconcileDelivered / §23.6 性质③④）；完整随机 kill 属性框架留 G05/W15
// - 合并唤醒只在流空闲时执行（§7.8：忙流上 steer 会与 followUp 顺序反转）
// ═══════════════════════════════════════════════════════════════════════════

import type { Mailbox } from "./contracts.js";
import { rowToEnvelope, type MessageRow } from "./envelope.js";
import type { MeshEventBus } from "./events.js";
import { WallClockLogicalClock, WakeRateLimiter, withPolicyGuard, withPolicyTimeout } from "./policies.js";
import type { MeshRegistry } from "./registry.js";
import { sealValid } from "./seal.js";
import type { SqliteStore } from "./store.js";
import type { InProcessTransport } from "./transport.js";
import type {
  Account,
  AccountId,
  Cap,
  ContextPath,
  Conversation,
  DeliveryId,
  DegradeTarget,
  DropReason,
  EndpointId,
  Envelope,
  Grade,
  InboxState,
  InboxView,
  Limits,
  LogicalClock,
  MeshLease,
  MessageId,
  ParkReason,
  PendingDelivery,
  Policies,
  PolicyDegradeReason,
  PolicySlot,
  PortStatus,
  PresenceState,
  SinkHandler,
  StreamPort,
  Transport,
  Unsubscribe,
  VerbatimBudget,
} from "./types.js";
import {
  DROP_REASONS as DROP_REASON_CODES,
  MeshRejectError,
  PARK_REASONS as PARK_REASON_CODES,
} from "./types.js";
import { mechanicalDigest } from "./renderer.js";
import { DefaultRenderer, escapeDelims, verifyWrapped } from "./renderer.js";
import { isoFromMs, isoNow, msFromIso, truncate, ulid } from "./util.js";

/** 折叠后仍是「在收件箱里」的状态（§7.5 未读口径 = C5 口径） */
const PENDING_STATES = "('routed','queued','parked','delivered')";

/** §7.10 原因码总表（drop）；devMode 下写入未登记码直接抛错（§7.10②）。值源 = types.js 的 DROP_REASONS（W01 冻结） */
const DROP_REASONS = new Set<string>(DROP_REASON_CODES);
/** §7.10 原因码总表（parked）；同上。值源 = types.js 的 PARK_REASONS（W01 冻结） */
const PARK_REASONS = new Set<string>(PARK_REASON_CODES);

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
  /** §20.1⑨：逻辑钟（Renderer 显示 + 会话排序）；缺省墙钟 */
  clock?: LogicalClock;
  /** §22.4：宿主 seal 密钥（仅内存）；缺省不验（历史行 seal 为 NULL 放行） */
  sealKey?: string;
}

/** 鸭子判型（I33）：PiPortError 类型不进 core，按 code 字段判别 NO_SESSION */
function isPortError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === code
  );
}

/** I16：端口错误 code → parked 原因（全用冻结码表，不新增符号）。路径归因不丢失。 */
function parkReasonForPortError(err: unknown): ParkReason {
  if (isPortError(err, "NO_SESSION")) return "NO_SESSION";
  if (isPortError(err, "ENDPOINT_GONE")) return "ENDPOINT_GONE";
  if (isPortError(err, "LOCK_HELD")) return "LEASE_HELD";
  return "PORT_TIMEOUT"; // NOT_HOT 及未知端口错误统一归 PORT_TIMEOUT
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
  queued_at: string | null;
  parked_at: string | null;
  parked_reason: string | null;
  entry_id: string | null;
  claim_until: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_error: string | null;
}

/** queue 投递的 claim 上下文投影（归属/租约/末次错误 + 发起方/序号/correlationId，供 ack/nack/回收） */
interface QueueDeliveryRow {
  id: string;
  message_id: string;
  account_id: string;
  endpoint_id: string | null;
  conversation_id: string;
  correlation_id: string | null;
  from_account: string;
  seq: number;
  state: string;
  attempts: number;
  claim_until: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_error: string | null;
}

/** §8.4 双向核对投影：投递行 + 消息 seq/conversation_id（归因 cursor 推进与 resetInboxPending） */
interface ReconcileRow extends DeliveryRow {
  seq: number;
  conversation_id: string;
}

export class MeshMailbox implements Mailbox {
  private readonly d: MailboxDeps;
  private readonly rateLimiter: WakeRateLimiter;
  /** 渲染槽 I21 降级回的内建渲染器（M4 包裹保底，§12.3④），ts 显示走逻辑钟 */
  private readonly builtinRenderer: DefaultRenderer;
  /** entryId → deliveryId：entry_appended 归因（handleEntryAppended 用） */
  private entryIndex = new Map<string, DeliveryId>();
  /** §7.4 降级留痕：已写过「转入摘要模式」note 的 (account, conv)（一次/跃迁） */
  private verbatimExitNoted = new Set<string>();
  /** §15.4 派生 presence 变迁去重：accountId → 上次记录的有效态（host/derived 共用） */
  private lastPresence = new Map<string, PresenceState>();

  constructor(deps: MailboxDeps) {
    this.d = deps;
    this.rateLimiter = new WakeRateLimiter(deps.limits);
    this.builtinRenderer = new DefaultRenderer(
      deps.clock ?? new WallClockLogicalClock(),
    );
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

    // MUTED（§7.10）：收件人静音了该会话 → 保留 inbox、不唤醒（不 drop）。
    // 静音只压制提升唤醒（A 规则下方强制 want=false），消息仍入 pending/期末可见。
    const muted =
      membership?.mutedUntil !== undefined &&
      msFromIso(membership.mutedUntil) > Date.now();

    // ── A2'（§7.3）：sink/external 不参与唤醒判定，投递即算送达 ──
    // I31：档位透传（免 Floor）——sink 不经端点选择/Floor/唤醒，这里单独算真实 grade，
    // 不硬编码 followUp。Floor 只门禁发送方，接收方无 Floor 概念。
    if (account.endpointClass !== "stream") {
      const sinkGrade = await this.gradeForSink(envelope, account, conv, muted);
      await this.deliverToSink(envelope, row, account, conv, sinkGrade);
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
      (v) =>
        v === null ||
        typeof v === "string" ||
        (Array.isArray(v) && v.every((x) => typeof x === "string")),
    );
    // I15：selector 结果归一为数组（§8.1 多端点投递）；逐条校验「存在且属于本账号」，
    // 未知端点/他账号端点剔除并留痕（policy_degraded），全空才 park。
    const rawSelected: EndpointId[] =
      selected === null ? [] : Array.isArray(selected) ? selected : [selected];
    const endpointIds: EndpointId[] = [];
    for (const id of rawSelected) {
      const ep = d.registry.getEndpoint(id);
      if (ep && ep.accountId === row.account_id) {
        endpointIds.push(id);
      } else {
        d.store.bumpCounter("policy_degraded");
      }
    }
    if (endpointIds.length === 0) {
      this.parkDelivery(row.id, envelope, "ENDPOINT_GONE");
      return;
    }
    const endpointId = endpointIds[0]!;
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

    // §14.3：非 queue 的 ack 请求首次投递时绑定端点 + 取得目标端点 exclusive 租约，
    // 阻止 concurrent 到达（后续消息据上方 LEASE_HELD 分支 park）。ack / timeout /
    // abandoned 由 releaseRequestLease 释放。仅 state='open' 才取租（终端态不复取）。
    if (
      envelope.expect === "ack" &&
      conv.kind !== "queue" &&
      envelope.correlationId
    ) {
      const pa = d.store.db
        .prepare<[string], { endpoint_id: string | null }>(
          "SELECT endpoint_id FROM mesh_pending_acks WHERE correlation_id = ? AND state = 'open'",
        )
        .get(envelope.correlationId) as
        | { endpoint_id: string | null }
        | undefined;
      if (pa && pa.endpoint_id === null) {
        d.store.db
          .prepare(
            "UPDATE mesh_pending_acks SET endpoint_id = ? WHERE correlation_id = ? AND endpoint_id IS NULL",
          )
          .run(endpointId, envelope.correlationId);
        d.registry.setEndpointLease(
          endpointId,
          "exclusive",
          isoFromMs(Date.now() + d.limits.exclusiveLeaseTtlMs),
        );
      }
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
      (v): v is Grade => v === "steer" || v === "followUp" || v === "silent",
    );

    // C01（§9.5:1718）：静音收件人强制 silent —— 渲染定档不再扰流，配合下方 want=false 的
    // 唤醒压制与冷流 silent→park（§9.5:1724），冷流不因静音消息升温。静音是显式关闭：urgent 也不破。
    if (muted) grade = "silent";

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
    // I14：与档位正交（预算只影响档位与形态，不影响唤醒）——P2 也参与唤醒判定，
    // urgent / correlationId 超预算时仍能醒（§7.4/§7.3）。
    let woke = false;
    if (path === "P1" || path === "P2") {
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
        (v) => typeof v === "boolean",
      );
      // 规则②：单聊任何消息都醒（策略签名无 conversation，Mailbox 叠加）
      if (conv.kind === "direct") want = true;
      // A1：只读成员永不唤醒（策略说了也不算）
      if (!canSpeak) want = false;
      // C01：静音（§7.10）只压制唤醒，保留 inbox；urgent 也不破静音（静音是显式关闭）
      if (muted) want = false;
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
      // I28：不唤醒原因留痕（§12.4）——woke=false 且无既有 note（背压/限流已写）时，
      // 按压制来源补 note，让 trace 能解释完整决策链。P3（无 speak）不走此块，由 path='P3' 自解释。
      if (!woke && note === null) {
        note = muted
          ? "muted" // C01 静音
          : presence === "dnd"
            ? "dnd" // A2
            : presence === "offline"
              ? "offline" // A2
              : "activation"; // A0：shouldWake 返回 false
      }
    }

    // 定档与选端结果落库（queued = 定档完成，§7.9）——首端点走既有行。
    const now = isoNow();
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, grade = ?, endpoint_id = ?, path = ?, woke = ?, note = ?, state_changed_at = ? " +
          "WHERE id = ?",
      )
      .run(now, grade, endpointId, path, woke ? 1 : 0, note, now, row.id);
    const lives: Array<{ live: DeliveryRow; endpointId: EndpointId; woke: boolean }> = [
      { live: { ...row, state: "queued", grade, endpoint_id: endpointId, path }, endpointId, woke },
    ];
    // I15：多端点投递（§8.1）——其余端点各插一行 mesh_deliveries
    // （UNIQUE(message_id, endpoint_id) 天然允许每端点一行；woke=0，仅首端点可醒）。
    const insExtra = this.d.store.db.prepare(
      "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, grade, path, woke, state, queued_at, state_changed_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    for (let i = 1; i < endpointIds.length; i++) {
      const extraId = ulid();
      insExtra.run(
        extraId,
        row.message_id,
        row.account_id,
        endpointIds[i]!,
        grade,
        path,
        0,
        "queued",
        now,
        now,
      );
      lives.push({
        live: { ...row, id: extraId, state: "queued", grade, endpoint_id: endpointIds[i]!, path },
        endpointId: endpointIds[i]!,
        woke: false,
      });
    }

    // 端点级投递：P1/P3 多端即投；P2 多端留待 W08 上下文集成（各端保持 queued）
    for (const item of lives) {
      await this.deliverToEndpoint(envelope, item.live, account, conv, item.endpointId, grade, item.woke);
    }
  }

  /** 端点级投递（I15）：账号级定档/唤醒/路径已在上方算好，这里对单端点做
   *  isLocal/outbox 分流与 P1/P2/P3 三条路径。 */
  private async deliverToEndpoint(
    envelope: Envelope,
    live: DeliveryRow,
    account: Account,
    conv: Conversation,
    endpointId: EndpointId,
    grade: Grade,
    woke: boolean,
  ): Promise<void> {
    const d = this.d;

    // sameHost 跨进程：目标端点不在本进程 → 发布到 outbox（§19.3），由端点的持锁进程认领投递。
    // 定档/路径/唤醒已在上面判定并落库，接收方只按意图还原投递（不再重定档）。
    const isLocal = await (this.d.isEndpointLocal?.(endpointId) ?? true);
    if (!isLocal) {
      const pending: PendingDelivery = {
        deliveryId: live.id,
        envelope,
        grade,
        accountId: live.account_id,
        endpointId,
        // I02 持久派送意图：path/woke 随 payload 持久化，接收侧据此还原 P1/P2/P3 与起轮。
        path: (live.path ?? "P1") as ContextPath,
        woke,
      };
      try {
        await this.d.transport.publish(pending);
      } catch {
        // I03 失败不中止 fanout：publish 抛错保留 queued，交给 sweep 对账重建 outbox 行。
        return;
      }
      return;
    }

    if (live.path === "P3") {
      // 只记账：note() ⇒ appendCustomEntry，进历史不进 LLM 上下文（§7.6）
      try {
        await d.port.note(endpointId, "mesh.audit", {
          envelopeId: envelope.id,
          seq: envelope.seq,
          conv: envelope.conversationId,
          from: envelope.from,
        });
        // note 完成即 delivered（§7.9 表：note() 完成）
        this.markDelivered(live.id, null);
      } catch (err) {
        // I16：端口错误归因映射（NO_SESSION→NO_SESSION、ENDPOINT_GONE→ENDPOINT_GONE、
        // LOCK_HELD→LEASE_HELD、NOT_HOT→PORT_TIMEOUT），不丢失错误归因。
        this.parkDelivery(live.id, envelope, parkReasonForPortError(err), endpointId);
      }
      return;
    }

    if (live.path === "P2") {
      // 超预算：不碰 session，只留 Inbox；激活时经 context 注入摘要（§7.6）。
      // delivery 留在 queued —— 注入体进入某轮最终输入才 delivered（confirmInjection）。
      // §7.4 降级留痕：该会话此前在预算内、本条起超预算 ⇒ 写一条 P3 note（一次/跃迁）。
      await this.noteVerbatimExit(envelope, live.account_id, endpointId);
      // I14：档位与唤醒正交——urgent/①correlationId 超预算（P2）仍须唤醒。热流且空闲时
      // 以极简 cue 起一轮（正文在 context 注入体里），让注入体进入该轮最终输入并确认；
      // busy 不起轮（交给自然轮次/注入确认），冷流保持 queued（§7.2 冷流不升温）。
      if (woke) {
        const st = d.port.status(endpointId);
        if (st.state === "hot" && !st.busy) {
          try {
            await d.port.nudge(endpointId, "该会话有新未读", { triggerTurn: true });
          } catch {
            // nudge 失败不改变 P2 queued 的事实；留待下轮注入确认或下次 warm。
          }
        }
      }
      return;
    }

    // ── P1 ──
    // silent + 冷流：不升温，只入 Inbox；§7.2 表规定冷流 silent 落 parked（非终态）
    const portState = d.port.status(endpointId);
    if (grade === "silent" && portState.state === "cold") {
      d.store.bumpCounter("cold_hit");
      this.parkDelivery(live.id, envelope, "ENDPOINT_GONE", endpointId);
      return;
    }

    // 预算内：若此前因挤出写过降级 note，复位以便下次挤出再留痕
    this.verbatimExitNoted.delete(live.account_id + "/" + envelope.conversationId);

    // CATCHUP（§7.6）：从超预算回到预算内的跃迁点，固化一次追赶摘要
    await this.maybeCatchup(envelope, live.account_id, endpointId, conv);

    // 合并唤醒的时机约束（§7.8）：忙流上不投 steer —— 降为 triggerTurn:false，
    // 消息在本轮结束时可见（§2.2④），顺序不反转
    let wokeFlag = woke;
    const busy = portState.busy;
    if (wokeFlag && busy) {
      wokeFlag = false;
      // I27：忙流合并唤醒是「正确」行为（不另起轮）——不计入 wake_per_message_busy，
      // 让该计数器保持恒 0 作为「合并回归」的 canary（§23.3）。健康场景读 0 才不是 bug。
    } else if (wokeFlag) {
      d.store.bumpCounter("wake_per_message_idle");
    }
    this.d.store.db
      .prepare("UPDATE mesh_deliveries SET woke = ? WHERE id = ?")
      .run(wokeFlag ? 1 : 0, live.id);
    live.grade = grade;

    // 连续段（§7.7）：只投 cursorSeq 之后的下一条；有更早未投的先等（超时见 sweep ⑥）
    if (
      conv.kind !== "queue" &&
      !this.isNextInSegment(envelope, live.account_id, live)
    ) {
      return; // 留 queued；前面的投完（turn_end → drainQueued）或超时（sweep ⑥）后续投
    }

    await this.renderAndDeliver(envelope, live, endpointId, account, grade, wokeFlag);
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
    } catch (err) {
      // I16：端口错误归因映射，不丢失错误归因（NO_SESSION/ENDPOINT_GONE/LOCK_HELD/NOT_HOT）
      this.parkDelivery(row.id, envelope, parkReasonForPortError(err), endpointId);
    }
  }

  /**
   * 渲染 stream 正文（§7.6 P1）：渲染槽受 I21 保护（抛错/非法降级回内建渲染器），
   * 输出再走 M4 包裹校验（§10.3 防线 1）：devMode 未包裹直接抛错，生产强制加壳。
   */
  private renderForStream(account: Account, envelope: Envelope): string {
    const d = this.d;
    const ctx = { recipient: account, senderName: this.nameOf(envelope.from) };
    const rendered = withPolicyGuard(
      this.guardDeps("renderer"),
      () => d.policies.renderer.renderMessage(envelope, ctx),
      this.builtinRenderer.renderMessage(envelope, ctx),
      (v) => typeof v === "string",
    );
    const check = verifyWrapped(rendered);
    if (d.devMode && !check.ok) {
      throw new Error(
        "mesh: renderer output is not <<<MSG>>>-wrapped (§10.3 M4 / §23.7)",
      );
    }
    if (!check.ok) {
      // §23.7：生产模式渲染器未包裹 → 记 invariant_violated 并强制加壳（不得静默输出裸文本）
      d.events.emit("invariant_violated", {
        code: "renderer_not_wrapped",
        detail: { envelopeId: envelope.id },
      });
      d.store.bumpCounter("invariant_violated");
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
      this.builtinRenderer.renderMessage(envelope, ctx),
      (v) => typeof v === "string",
    );
  }

  /** sink 档位（I31 免 Floor）：sink/external 不经选端/Floor/唤醒，但仍要真实 grade。
   *  复用 delivery 策略（verbatim 恒 true=全量原文），套静音 silent 覆盖。 */
  private async gradeForSink(
    envelope: Envelope,
    account: Account,
    conv: Conversation,
    muted: boolean,
  ): Promise<Grade> {
    const d = this.d;
    let grade = await withPolicyTimeout(
      this.guardDeps("delivery"),
      () =>
        d.policies.delivery.grade({
          envelope,
          recipient: account,
          conversation: conv,
          memberCount: d.registry.memberCount(envelope.conversationId),
          inbox: {
            conversationId: envelope.conversationId,
            kind: conv.kind,
            unread: 0,
            recent: [],
            verbatim: true,
            lastSeq: envelope.seq,
            lastAt: envelope.routedAt,
          },
          verbatim: true,
        }),
      "followUp" as Grade,
      (v): v is Grade => v === "steer" || v === "followUp" || v === "silent",
    );
    // C01（§9.5）：静音收件人强制 silent
    if (muted) grade = "silent";
    return grade;
  }

  /** sink / external（§6.3③）：渲染 JSON 交给宿主处理器，accepted 即 delivered。
   *  §21.2 I31：拒收/抛错不立即 park——attempts 递增、低于 maxAttempts 保持 queued
   *  标 note='sink_backoff' 由 sweep 指数退避重投；连续 maxAttempts 次才 park(SINK_REFUSED)。 */
  private async deliverToSink(
    envelope: Envelope,
    row: DeliveryRow,
    account: Account,
    conv: Conversation,
    grade: Grade,
  ): Promise<void> {
    const d = this.d;
    const handler = d.sinkHandlers.get(row.account_id);
    if (!handler) {
      this.parkDelivery(row.id, envelope, "NO_SINK_HANDLER");
      return;
    }
    // 进入 sink 尝试：清 backoff note（sweep 重投时清）并落真实 grade
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, path = 'P1', grade = ?, note = NULL, state_changed_at = ? WHERE id = ?",
      )
      .run(isoNow(), grade, isoNow(), row.id);
    const rendered = this.renderForSink(account, envelope);
    let result: { accepted: boolean; consumedImmediately?: boolean };
    try {
      result = await handler.deliver(rendered, envelope, grade);
    } catch {
      this.sinkRefused(row, envelope);
      return;
    }
    if (!result.accepted) {
      this.sinkRefused(row, envelope);
      return;
    }
    // sink 无 turn_end：accepted 即 delivered；consumedImmediately 连 consumed 一起推进
    this.markDelivered(row.id, null);
    if (result.consumedImmediately) await this.markConsumed(row.id);
    void conv;
  }

  /** §21.2 拒收退避：attempts+1；低于 maxAttempts → 留 queued + note='sink_backoff'，
   *  queued_at 刷新为「本次退避起点」；达到 maxAttempts → park(SINK_REFUSED)。 */
  private sinkRefused(row: DeliveryRow, envelope: Envelope): void {
    const d = this.d;
    const attempts = row.attempts + 1;
    const now = isoNow();
    d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET attempts = ?, state_changed_at = ? WHERE id = ?",
      )
      .run(attempts, now, row.id);
    if (attempts >= d.limits.maxAttempts) {
      this.parkDelivery(row.id, envelope, "SINK_REFUSED");
      return;
    }
    d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET note = 'sink_backoff', queued_at = ? WHERE id = ?",
      )
      .run(now, row.id);
  }

  /** 指数退避（§21.2）：min(base * 2^(attempts-1), max)。attempts 是「已尝试次数」（首拒后=1）。 */
  private sinkBackoffMs(attempts: number): number {
    return Math.min(
      this.d.limits.sinkBackoffBaseMs * Math.pow(2, attempts - 1),
      this.d.limits.sinkBackoffMaxMs,
    );
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
      // §20.2⑦/IPLAN §4.1：降级不加原文（fail-closed）。ttlSeq=-1 ⇒ gap 永远超标 ⇒ verbatim=false。
      { bytes: 0, ttlSeq: -1 },
      (v) =>
        v !== null &&
        typeof v === "object" &&
        typeof (v as { bytes?: unknown }).bytes === "number" &&
        Number.isFinite((v as { bytes: number }).bytes) &&
        ((v as { ttlSeq?: unknown }).ttlSeq === undefined ||
          (typeof (v as { ttlSeq?: unknown }).ttlSeq === "number" &&
            Number.isFinite((v as { ttlSeq: number }).ttlSeq))),
    );
    const gap = this.gapOf(envelope.conversationId, accountId);
    const gapOk = budget.ttlSeq === undefined || gap <= budget.ttlSeq;
    if (!gapOk) return false;
    // I08：≤ maxVerbatimConversations 个会话在预算内 —— 改为「recency 排序后 top-K 接纳」，
    // 不再是无序计数。当前会话 verbatim ⟺ 在接纳集合内（direct/pinned 恒占位，其余按
    // evictionOrder（默认 lru）排序取满名额，再叠加字节预算贪心）。
    return this.verbatimInBudget(accountId, envelope.conversationId, budget);
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

  /** 当前拿原文的会话数（direct 恒在内 + gap 达标的会话数，§7.4 计数条件）
   *  I08：退化为 `verbatimInBudget` 的接纳集合成员判定。 */
  private verbatimInBudget(
    accountId: AccountId,
    convId: string,
    budget: VerbatimBudget,
  ): boolean {
    const d = this.d;
    const rows = this.d.store.db
      .prepare<
        [string],
        {
          conversation_id: string;
          s: number;
          m: number;
          next: number;
          pinned: number | null;
          type: string;
          pending_bytes: number | null;
          verbatim_bytes: number | null;
        }
      >(
        "SELECT ms.conversation_id, ms.last_spoke_seq AS s, ms.last_mentioned_seq AS m, " +
          "ms.verbatim_pinned AS pinned, c.next_seq AS next, c.type AS type, " +
          "i.pending_bytes AS pending_bytes, i.verbatim_bytes AS verbatim_bytes " +
          "FROM mesh_memberships ms JOIN mesh_conversations c ON c.id = ms.conversation_id " +
          "LEFT JOIN mesh_inboxes i ON i.account_id = ms.account_id AND i.conversation_id = ms.conversation_id " +
          "WHERE ms.account_id = ? AND ms.left_at IS NULL",
      )
      .all(accountId);

    const directs = new Set<string>();
    const pinned = new Set<string>();
    const candidates: Array<{
      id: string;
      lastActiveSeq: number;
      unreadBytes: number;
      inbox: InboxState;
    }> = [];
    for (const r of rows) {
      const lastSeq = r.next - 1;
      if (r.type === "direct") {
        directs.add(r.conversation_id);
        continue;
      }
      if (r.pinned === 1) {
        pinned.add(r.conversation_id);
        continue;
      }
      if (r.pinned === 0) continue;
      if (r.s <= 0 && r.m <= 0) continue; // 从未发言/被 @ ⇒ 不占预算位
      const gap = r.next - 1 - Math.max(r.s, r.m);
      if (budget.ttlSeq !== undefined && gap > budget.ttlSeq) continue;
      const unreadBytes = (r.pending_bytes ?? 0) + (r.verbatim_bytes ?? 0);
      candidates.push({
        id: r.conversation_id,
        lastActiveSeq: lastSeq,
        unreadBytes,
        // 交自定义 evictionOrder 比较器用的 InboxState 投影（§7.4：比较器只看
        // 通信事实——lastSeq/unread/conversationId/kind；recent 为空数组）。
        inbox: {
          conversationId: r.conversation_id,
          kind: r.type as Conversation["kind"],
          unread: 0,
          recent: [],
          verbatim: false,
          lastSeq,
          lastAt: "",
        },
      });
    }

    // LRU：默认 lastActiveSeq 降序（最近活跃优先接纳）；宿主覆写 evictionOrder 函数则用之。
    const order = d.policies.retention.evictionOrder;
    if (typeof order === "function") {
      candidates.sort((a, b) => order(a.inbox, b.inbox));
    } else {
      candidates.sort((a, b) => b.lastActiveSeq - a.lastActiveSeq);
    }

    const slots = d.limits.maxVerbatimConversations - directs.size - pinned.size;
    const accepted = new Set<string>([...directs, ...pinned]);
    const bytesLimited =
      Number.isFinite(budget.bytes) && budget.bytes < Number.MAX_SAFE_INTEGER;
    let usedBytes = 0;
    let taken = 0;
    for (const c of candidates) {
      if (taken >= slots) break;
      if (bytesLimited && usedBytes + c.unreadBytes > budget.bytes) break;
      accepted.add(c.id);
      usedBytes += c.unreadBytes;
      taken++;
    }
    return accepted.has(convId);
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
        {
          conversation_id: string;
          s: number;
          m: number;
          next: number;
          type: string;
          pending_bytes: number | null;
          verbatim_bytes: number | null;
        }
      >(
        "SELECT ms.conversation_id, ms.last_spoke_seq AS s, ms.last_mentioned_seq AS m, " +
          "c.next_seq AS next, c.type AS type, " +
          "i.pending_bytes AS pending_bytes, i.verbatim_bytes AS verbatim_bytes " +
          "FROM mesh_memberships ms JOIN mesh_conversations c ON c.id = ms.conversation_id " +
          "LEFT JOIN mesh_inboxes i ON i.account_id = ms.account_id AND i.conversation_id = ms.conversation_id " +
          "WHERE ms.account_id = ? AND ms.left_at IS NULL",
      )
      .all(accountId);
    return rows.map((r) => ({
      id: r.conversation_id,
      kind: r.type as Conversation["kind"],
      gap: r.next - 1 - Math.max(r.s, r.m),
      lastActiveSeq: r.next - 1,
      // I08：unreadBytes 诚实口径 = 未读字节 + 自发言字节（§7.4「含自己发出的消息」）。
      unreadBytes: (r.pending_bytes ?? 0) + (r.verbatim_bytes ?? 0),
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

    // I10：把追赶摘要作为一条 custom_message 正文永久写进历史并进入下一轮输入（先持久化再消费）。
    // 经全库唯一 sendCustomMessage 出口（§3.2 ①）；合成 envelope 不写 mesh_messages/mesh_deliveries。
    const catchupText = this.builtinRenderer.renderCatchup(
      envelope.conversationId,
      items.length,
      spanFrom,
      spanTo,
      digest,
    );
    const synEnv = this.syntheticEnvelope(envelope, "catchup");
    try {
      await this.d.port.deliver(endpointId, catchupText, synEnv, "followUp", {
        triggerTurn: false,
      });
    } catch {
      return; // 固化失败不阻塞本条投递；下一条跃迁时再试
    }
    // 未读清零：被固化的 queued 投递直接 consumed（进过历史，摘要形态）
    const ids = this.d.store.db
      .prepare<
        [string, string, number],
        { id: string; message_id: string; endpoint_id: string | null }
      >(
        "SELECT d.id, d.message_id, d.endpoint_id FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? AND d.state = 'queued' " +
          "AND m.seq < ? ORDER BY m.seq",
      )
      .all(accountId, envelope.conversationId, envelope.seq) as Array<{
      id: string;
      message_id: string;
      endpoint_id: string | null;
    }>;
    this.d.store.tx(() => {
      const upd = this.d.store.db.prepare(
        "UPDATE mesh_deliveries SET state = 'consumed', consumed_at = ?, partial = 1, state_changed_at = ? WHERE id = ?",
      );
      for (const r of ids) upd.run(isoNow(), isoNow(), r.id);
      this.resetInboxPending(accountId, envelope.conversationId);
      // I32(b)/(c)：追赶摘要固化是唯一「清折叠」的复位点——游标推进到 spanTo、overflow 清零
      this.d.store.db
        .prepare(
          "UPDATE mesh_inboxes SET cursor_seq = MAX(cursor_seq, ?), overflow_count = 0, overflow_summary = NULL " +
            "WHERE account_id = ? AND conversation_id = ?",
        )
        .run(spanTo, accountId, envelope.conversationId);
    });
    // I26：catchup 固化补发 message_consumed——这些行只以摘要形态进过历史，partial=true
    // （「摘要内折叠」，非全文读毕），与 markConsumedPartial 同口径。
    for (const r of ids) {
      const env = this.envelopeOf(r.message_id);
      if (env) {
        this.d.events.emit("message_consumed", {
          envelope: env,
          endpointId: r.endpoint_id ?? "",
          accountId,
          partial: true,
        });
      }
    }
    void conv;
  }

  /** I10/N03：合成信封——CATCHUP 与加入历史注入的正文经 port.deliver 进 session，但不产生
   *  mesh_messages / mesh_deliveries 行（守「delivery 行可追溯到 to∪mentions」与 §9.4
   *  「加入前消息无 delivery 行」）。id 与触发消息不同、不在 mesh_messages；handleEntryAppended
   *  依 envelopeId 查不到 delivery 即 no-op（镜像 mesh_message_id 落 NULL，外键安全）。 */
  private syntheticEnvelope(envelope: Envelope, tag: string): Envelope {
    return {
      id: ulid(),
      seq: envelope.seq,
      from: envelope.from,
      fromEndpoint: null,
      routedAt: isoNow(),
      idempotencyKey: `mesh:${tag}:${ulid()}`,
      conversationId: envelope.conversationId,
      kind: "chat",
      expect: "none",
      payload: { text: "" },
    };
  }

  /** 未读缓存复位：只重算缓存列（含 routed、字节口径）；不推进 cursor_seq、不清 overflow——
   *  游标推进与折叠清空由各调用方显式执行（handleTurnEnd / markConsumed 推游标，maybeCatchup 清折叠）。 */
  private resetInboxPending(accountId: AccountId, convId: string): void {
    this.d.store.recomputeInbox(accountId, convId);
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
      // I10/N03：mesh_message_id 只应指向真实 mesh_messages 行。合成信封（CATCHUP/历史注入）
      // 的 entry 带 envelopeId 但不在 mesh_messages——标量子查询落 NULL，外键安全（镜像非权威）。
      d.store.db
        .prepare(
          "INSERT OR IGNORE INTO mesh_stream_entries (entry_id, pi_session_id, parent_id, seq_in_stream, " +
            "entry_type, raw_json, mesh_message_id, created_at) " +
            "SELECT ?,?,?,?,?,?, (SELECT id FROM mesh_messages WHERE id = ?), ?",
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
    }
  }

  handleTurnEnd(endpointId: EndpointId): void {
    const d = this.d;
    const rows = d.store.db
      .prepare<[string], DeliveryRow & { seq: number }>(
        "SELECT d.*, m.seq AS seq FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "JOIN mesh_conversations c ON c.id = m.conversation_id " +
          "WHERE d.endpoint_id = ? AND d.state = 'delivered' AND c.type != 'queue'",
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
    const path = (d.path ?? "P1") as ContextPath;

    if (path === "P3") {
      // P3 只记账（§7.6）：note() 完成即 delivered（§7.9 表）= 确认点
      try {
        await this.d.port.note(d.endpointId ?? "", "mesh.audit", {
          envelopeId: d.envelope.id,
          seq: d.envelope.seq,
          conv: d.envelope.conversationId,
          from: d.envelope.from,
        });
        this.markDelivered(d.deliveryId, null);
      } catch (err) {
        this.parkDelivery(
          d.deliveryId,
          d.envelope,
          parkReasonForPortError(err),
          d.endpointId ?? undefined,
        );
      }
      return;
    }

    if (path === "P2") {
      // P2 超预算（§7.6）：不全文入流，只写降级留痕 note（§7.4）；delivery 留 queued 交 W08。
      // note 是 outbox 载体的唯一副作用 → 写妥即 ack done，避免 claimTtl 回收后重复留痕。
      try {
        await this.noteVerbatimExit(d.envelope, d.accountId, d.endpointId ?? "");
        await this.d.transport.ack(d.deliveryId, "delivered");
      } catch {
        // 降级留痕失败：不回 ack，outbox 行留 claimed 由 poller 回收窗口再试
      }
      return;
    }

    const rendered = this.renderForStream(account, d.envelope);
    try {
      const res = await this.d.port.deliver(
        d.endpointId ?? "",
        rendered,
        d.envelope,
        d.grade,
        { triggerTurn: !!d.woke }, // 唤醒判定已在发端定稿（P1 才按 woke 醒）
      );
      this.d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET handoff_at = ?, entry_id = ? WHERE id = ?",
        )
        .run(isoNow(), res.entryId ?? null, d.deliveryId);
      if (res.entryId) this.entryIndex.set(res.entryId, d.deliveryId);
      // I02：deliver resolve ≠ delivered（F5）。这里不回 ack——ack 由 markDelivered
      // 在 entry_appended 到达后的确认点统一发出（SameHostTransport 才落 done）。
    } catch (err) {
      // I16：失败 park 对应 delivery 行并归还原因（归因映射）；不回 ack，
      // 留 outbox claim 由 poller 回收窗口重试。
      this.parkDelivery(
        d.deliveryId,
        d.envelope,
        parkReasonForPortError(err),
        d.endpointId ?? undefined,
      );
    }
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
        "UPDATE mesh_deliveries SET handoff_at = NULL, attempts = attempts + 1, redeliver_reason = 'handoff_timeout', state_changed_at = ? WHERE id = ?",
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

    // ④ pending_acks 超时（§14.3）：转 timeout、释放 exclusive、发事件、@system 通知发起方
    const timedOut = d.store.db
      .prepare<[string], {
        correlation_id: string;
        from_account: string;
        to_account: string;
        intent: string | null;
        conversation_id: string;
        expect: string;
        endpoint_id: string | null;
      }>(
        "SELECT correlation_id, from_account, to_account, intent, conversation_id, expect, endpoint_id " +
          "FROM mesh_pending_acks WHERE state = 'open' AND deadline < ?",
      )
      .all(isoNow()) as Array<{
      correlation_id: string;
      from_account: string;
      to_account: string;
      intent: string | null;
      conversation_id: string;
      expect: string;
      endpoint_id: string | null;
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
      // §14.3：超时释放该 request 的 exclusive，解 park LEASE_HELD 的并发到达
      if (pa.expect === "ack" && pa.endpoint_id) {
        await this.releaseRequestLease(pa.correlation_id);
      }
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

    // ⑦ I03 运输层对账：孤儿意图重建（跨主缺 outbox 行重发 publish）+ failed 联动（drop TRANSPORT_FAILED）
    await this.reconcileOutbox();

    // ⑧ I31 §21.2：sink 拒收退避期满的重投
    await this.retrySinkBackoff(nowMs);

    // ⑨ C09 / §19.3：outbox done 保留窗口清理（只删载体，台账不动）
    this.pruneOutboxDone(nowMs);

    // ⑩ §8.4 崩溃恢复：delivered（含被 park 的未决）行按 entry_id 对真实 session 双向核对，
    // 覆盖「崩溃后端点冷、宿主不主动 warm」的窗口②/③（热而 busy 的交给 turn_end）。
    await this.reconcileDelivered();
  }

  /** I03 两层一致对账：
   *  (a) 孤儿意图重建——跨主 queued 的 stream 行缺 outbox 行（publish 抛错 / publish 前崩溃），
   *      按已定稿的 path/grade/woke 重发 publish；
   *  (b) outbox failed 联动——运输层耗尽重试（attempts≥maxAttempts），把仍非终态的下游行
   *      drop(TRANSPORT_FAILED)。 */
  private async reconcileOutbox(): Promise<void> {
    const d = this.d;
    // (a) endpoint_id 非空 = stream 行（sink 走 account 键、endpoint_id 恒 NULL，天然排除）
    const orphan = d.store.db
      .prepare<[], DeliveryRow>(
        "SELECT d.* FROM mesh_deliveries d WHERE d.state = 'queued' AND d.endpoint_id IS NOT NULL " +
          "AND NOT EXISTS (SELECT 1 FROM mesh_outbox o WHERE o.delivery_id = d.id)",
      )
      .all() as DeliveryRow[];
    for (const row of orphan) {
      if (!row.endpoint_id) continue;
      if (await (this.d.isEndpointLocal?.(row.endpoint_id) ?? true)) continue; // 本进程直派：无 outbox 行为正常
      const env = this.envelopeOf(row.message_id);
      if (!env) continue;
      const pending: PendingDelivery = {
        deliveryId: row.id,
        envelope: env,
        grade: (row.grade ?? "followUp") as Grade,
        accountId: row.account_id,
        endpointId: row.endpoint_id,
        path: (row.path ?? "P1") as ContextPath,
        woke: !!row.woke,
      };
      try {
        await d.transport.publish(pending);
      } catch {
        // 再失败留待下一轮 sweep 对账
      }
    }

    // (b) outbox failed → 下游仍活跃（parked/queued/routed）则落终态
    const failed = d.store.db
      .prepare<[], { delivery_id: string }>(
        "SELECT delivery_id FROM mesh_outbox WHERE state = 'failed'",
      )
      .all() as Array<{ delivery_id: string }>;
    for (const f of failed) {
      const live = d.store.db
        .prepare<[string], DeliveryRow>("SELECT * FROM mesh_deliveries WHERE id = ?")
        .get(f.delivery_id) as DeliveryRow | undefined;
      if (!live) continue;
      if (live.state === "delivered" || live.state === "dropped" || live.state === "consumed") continue;
      this.dropDelivery(live.id, this.envelopeOf(live.message_id), "TRANSPORT_FAILED");
    }
  }

  /** I31 §21.2：从退避窗口出来、等待已满的 sink 拒收行（note='sink_backoff'）重投。 */
  private async retrySinkBackoff(nowMs: number): Promise<void> {
    const d = this.d;
    const rows = d.store.db
      .prepare<[], DeliveryRow>(
        "SELECT * FROM mesh_deliveries WHERE state = 'queued' AND note = 'sink_backoff'",
      )
      .all() as DeliveryRow[];
    for (const row of rows) {
      const dueAt = msFromIso(row.queued_at ?? "") + this.sinkBackoffMs(row.attempts);
      if (dueAt > nowMs) continue; // 退避未期满
      const env = this.envelopeOf(row.message_id);
      if (!env) continue;
      const account = d.registry.getAccount(row.account_id);
      const conv = d.registry.getConversation(env.conversationId);
      if (!account || !conv) continue;
      // 清 note 后按已定稿 grade 重投（deliverToSink 内会再清一次，幂等）
      d.store.db.prepare("UPDATE mesh_deliveries SET note = NULL WHERE id = ?").run(row.id);
      await this.deliverToSink(
        env,
        { ...row, note: null },
        account,
        conv,
        (row.grade ?? "followUp") as Grade,
      );
    }
  }

  /** C09 / §19.3：清理 outbox 已 done 且超保留窗口的载体行（仅删 outbox 载体，
   *  mesh_messages / mesh_deliveries 台账一行不删）。done 行无专用 done_at，
   *  用 claimed_at（认领即投递窗口、紧邻 done）近似「最后活动时刻」。 */
  private pruneOutboxDone(nowMs: number): void {
    const d = this.d;
    if (d.limits.outboxDoneRetentionMs === 0) return; // 0 = 不清理
    d.store.db
      .prepare("DELETE FROM mesh_outbox WHERE state = 'done' AND claimed_at < ?")
      .run(isoFromMs(nowMs - d.limits.outboxDoneRetentionMs));
  }

  /** 溢出折叠（§7.5）：cursorSeq 前移 + dropped(folded) 两件事必须同时做 */
  private foldOverflow(): void {
    const d = this.d;
    const over = d.store.db
      .prepare<
        [number, number, number, number, number, number, number, number],
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
          "MIN(COALESCE(json_extract(c.config, '$.maxPending'), ?), ?) AS maxPending, " +
          "MIN(COALESCE(json_extract(c.config, '$.maxPendingBytes'), ?), ?) AS maxPendingBytes " +
          "FROM mesh_inboxes i JOIN mesh_conversations c ON c.id = i.conversation_id " +
          "WHERE i.pending_count > MIN(COALESCE(json_extract(c.config, '$.maxPending'), ?), ?) " +
          "OR i.pending_bytes > MIN(COALESCE(json_extract(c.config, '$.maxPendingBytes'), ?), ?)",
      )
      .all(
        d.limits.maxPending,
        d.limits.maxPending,
        d.limits.maxPendingBytes,
        d.limits.maxPendingBytes,
        d.limits.maxPending,
        d.limits.maxPending,
        d.limits.maxPendingBytes,
        d.limits.maxPendingBytes,
      ) as Array<{
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
            "LENGTH(CAST(m.payload AS BLOB)) AS bytes " +
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
      d.store.bumpCounter("fold_events"); // 附录 E ③：与 inbox_overflowed 1:1 成对（每次折叠 +1）
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
    // §8.4 流热化时对账：warm 成功后端口必 hot，deferred 的 delivered 行在此核对（含此前 warm
    // 失败被 park 的同一批行——hasEntries 判在则 consumed(partial)，不在则重投，绝不盲重投）。
    await this.reconcileDeliveredForEndpoint(endpointId);
  }

  /** §14.3：释放该 request 的 exclusive 租约并解 park 其 LEASE_HELD 行（ack / timeout / abandoned 共用） */
  async releaseRequestLease(correlationId: string): Promise<void> {
    const d = this.d;
    const pa = d.store.db
      .prepare<[string], { endpoint_id: string | null; expect: string }>(
        "SELECT endpoint_id, expect FROM mesh_pending_acks WHERE correlation_id = ?",
      )
      .get(correlationId) as
      | { endpoint_id: string | null; expect: string }
      | undefined;
    if (!pa || pa.expect !== "ack" || !pa.endpoint_id) return;
    d.registry.setEndpointLease(pa.endpoint_id, "shared", null);
    await this.retryEndpoint(pa.endpoint_id);
  }

  /** §14.4：会话解散 → 会话内 open pending_acks 置 abandoned（静默、不发事件）+ 释放 exclusive */
  async abandonConversation(convId: string): Promise<void> {
    const d = this.d;
    const rows = d.store.db
      .prepare<
        [string],
        { correlation_id: string; endpoint_id: string | null; expect: string }
      >(
        "SELECT correlation_id, endpoint_id, expect FROM mesh_pending_acks " +
          "WHERE conversation_id = ? AND state = 'open'",
      )
      .all(convId) as Array<{
      correlation_id: string;
      endpoint_id: string | null;
      expect: string;
    }>;
    d.store.db
      .prepare(
        "UPDATE mesh_pending_acks SET state = 'abandoned' WHERE conversation_id = ? AND state = 'open'",
      )
      .run(convId);
    for (const r of rows) {
      if (r.expect === "ack" && r.endpoint_id) {
        await this.releaseRequestLease(r.correlation_id);
      }
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
    // I28：重投原因落库（旧 parked_reason，如 NO_SESSION/LEASE_HELD/SINK_REFUSED）。SQLite
    // 的 SET 子句以旧行快照求值，故 redeliver_reason=parked_reason 取到的是清空前的值。
    this.d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, parked_reason = NULL, parked_at = NULL, redeliver_reason = parked_reason, state_changed_at = ? WHERE id = ?",
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
      .prepare<[string], DeliveryRow & { seq: number }>(
        "SELECT d.*, m.seq AS seq FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id WHERE d.id = ?",
      )
      .get(deliveryId) as (DeliveryRow & { seq: number }) | undefined;
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
      // I32(b)：只把游标推进到本条已消费 seq（不越界到更高未消费排队/挂起行）
      d.store.db
        .prepare(
          "UPDATE mesh_inboxes SET cursor_seq = MAX(cursor_seq, ?) WHERE account_id = ? AND conversation_id = ?",
        )
        .run(row.seq, row.account_id, conv);
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

  // ── §8.4 崩溃恢复：delivered ↔ session 双向核对（权威是 pi session，非镜像）────

  /** 对账全部「已投但未确认」的 P1 行（state ∈ {delivered, parked}、带 entry_id、非 queue），
   *  按 entry_id 问真实 session：在 → consumed(partial)；不在 → queued 重投（幂等键防重）；
   *  拿不到 session → park 并保留 entry_id（下次 warm 成功再对账；NO_SESSION 自带告警，§23.6）。 */
  async reconcileDelivered(): Promise<void> {
    const d = this.d;
    const rows = d.store.db
      .prepare<[], ReconcileRow>(
        "SELECT d.*, m.seq, m.conversation_id FROM mesh_deliveries d " +
          "JOIN mesh_messages m ON m.id = d.message_id " +
          "JOIN mesh_conversations c ON c.id = m.conversation_id " +
          "WHERE d.state IN ('delivered','parked') AND d.entry_id IS NOT NULL " +
          "AND d.endpoint_id IS NOT NULL AND c.type != 'queue'",
      )
      .all() as ReconcileRow[];
    if (rows.length === 0) return;
    const byEndpoint = new Map<EndpointId, ReconcileRow[]>();
    for (const row of rows) {
      const list = byEndpoint.get(row.endpoint_id!) ?? [];
      list.push(row);
      byEndpoint.set(row.endpoint_id!, list);
    }
    for (const [endpointId, group] of byEndpoint) {
      await this.reconcileDeliveredGroup(endpointId, group);
    }
  }

  /** 单端点对账（warm 成功后调用，端口必已 hot） */
  private async reconcileDeliveredForEndpoint(endpointId: EndpointId): Promise<void> {
    const d = this.d;
    const rows = d.store.db
      .prepare<[string], ReconcileRow>(
        "SELECT d.*, m.seq, m.conversation_id FROM mesh_deliveries d " +
          "JOIN mesh_messages m ON m.id = d.message_id " +
          "JOIN mesh_conversations c ON c.id = m.conversation_id " +
          "WHERE d.endpoint_id = ? AND d.state IN ('delivered','parked') AND d.entry_id IS NOT NULL " +
          "AND c.type != 'queue'",
      )
      .all(endpointId) as ReconcileRow[];
    if (rows.length === 0) return;
    await this.reconcileDeliveredGroup(endpointId, rows);
  }

  private async reconcileDeliveredGroup(
    endpointId: EndpointId,
    rows: ReconcileRow[],
  ): Promise<void> {
    const d = this.d;
    // sameHost：他人进程的端点由对方自己的对账负责，绝不跨进程 warm（M3 单写者）。
    if (!(await (d.isEndpointLocal?.(endpointId) ?? true))) return;
    let status: PortStatus;
    try {
      status = d.port.status(endpointId);
    } catch {
      return; // 端口状态不可读：留待下一轮 sweep / warm 再对账
    }
    if (status.state !== "hot") {
      // 已 park 的行（warm 失败遗留）不在此重 warm——留给 retryEndpoint（下次成功 warm）对账，
      // 避免 sweep 反复 warm 失败刷告警。
      if (rows.every((r) => r.state === "parked")) return;
      try {
        await d.port.warm(endpointId);
      } catch (err) {
        for (const row of rows) {
          if (row.state === "parked") continue;
          this.parkDelivery(
            row.id,
            this.envelopeOf(row.message_id),
            parkReasonForPortError(err),
            endpointId,
          );
        }
        return;
      }
    } else if (status.busy) {
      return; // turn 进行中：交给 turn_end 消费（§8.4 窗口只针对进程已死的空闲态）
    }
    let alive: Set<string>;
    try {
      alive = await d.port.hasEntries(
        endpointId,
        rows.map((r) => r.entry_id!),
      );
    } catch (err) {
      for (const row of rows) {
        if (row.state === "parked") continue;
        this.parkDelivery(
          row.id,
          this.envelopeOf(row.message_id),
          parkReasonForPortError(err),
          endpointId,
        );
      }
      return;
    }
    for (const row of rows) {
      if (alive.has(row.entry_id!)) this.markConsumedPartial(row);
      else await this.requeueForRedelivery(row);
    }
  }

  /** 已进过上下文但没确认跑完：delivered/parked → consumed(partial)，前移 cursor（不进镜像） */
  private markConsumedPartial(row: ReconcileRow): void {
    const d = this.d;
    const now = isoNow();
    d.store.tx(() => {
      d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET state = 'consumed', consumed_at = ?, partial = 1, " +
            "parked_reason = NULL, parked_at = NULL, state_changed_at = ? WHERE id = ? " +
            "AND state IN ('delivered','parked')",
        )
        .run(now, now, row.id);
      this.resetInboxPending(row.account_id, row.conversation_id);
      // I32(b)：只把游标推进到本条已消费 seq（不越界到更高未消费排队/挂起行）
      d.store.db
        .prepare(
          "UPDATE mesh_inboxes SET cursor_seq = MAX(cursor_seq, ?) WHERE account_id = ? AND conversation_id = ?",
        )
        .run(row.seq, row.account_id, row.conversation_id);
    });
    const env = this.envelopeOf(row.message_id);
    if (env) {
      d.events.emit("message_consumed", {
        envelope: env,
        endpointId: row.endpoint_id ?? "",
        accountId: row.account_id,
        partial: true,
        entryId: row.entry_id!,
      });
    }
  }

  /** entry 未落进 session（崩在 pi 落盘前）：回 queued 重投，entry_id 清空（幂等键防重） */
  private async requeueForRedelivery(row: ReconcileRow): Promise<void> {
    const d = this.d;
    const now = isoNow();
    d.store.tx(() => {
      d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, entry_id = NULL, " +
            "handoff_at = NULL, parked_reason = NULL, parked_at = NULL, redeliver_reason = 'entry_vanished', " +
            "state_changed_at = ? WHERE id = ? AND state IN ('delivered','parked')",
        )
        .run(now, now, row.id);
      this.resetInboxPending(row.account_id, row.conversation_id);
      // I27（§7481）：hasEntries 声明仍在、但 entry 早已不在 session —— 判定为「队列被
      // 清过/entry 旁落」，是 W11 的 W13-reconcile 咽喉，单独计数以便观察清队列回归。
      d.store.bumpCounter("queue_cleared_detected");
    });
    const env = this.envelopeOf(row.message_id);
    const live = d.store.db
      .prepare<[string], DeliveryRow>("SELECT * FROM mesh_deliveries WHERE id = ?")
      .get(row.id) as DeliveryRow | undefined;
    if (env && live) {
      await this.deliverOne(env, { ...live, state: "queued" });
    }
  }

  /** I09：P2 注入确认（§7.6）——该端点注入体进入真实 LLM 调用最终输入（context_with_system
   *  观测）后，把该端点全部 `path='P2' AND state='queued'` 行推为 delivered（无 entry_id）；
   *  turn_end 再 consumed 并前移 cursorSeq。endpoint 级（双端点不互相确认），不再按 account 全量。 */
  confirmInjection(endpointId: EndpointId): void {
    const d = this.d;
    const rows = d.store.db
      .prepare<[string], DeliveryRow>(
        "SELECT * FROM mesh_deliveries WHERE endpoint_id = ? AND path = 'P2' AND state = 'queued'",
      )
      .all(endpointId) as DeliveryRow[];
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

  /** P2 注入体（§7.6）：context 钩子每次 LLM 调用前重算，不落盘。
   *  I09：只收 path='P2' 的未读（queued/parked/delivered），P1/P3 不进正文——只读成员的
   *  审计 note（P3）不泄进注入体。inboxOf 的 pending_count 口径（全路径）不变。 */
  inboxInjection(endpointId: EndpointId): string | null {
    const endpoint = this.d.registry.getEndpoint(endpointId);
    if (!endpoint) return null;
    const convRows = this.d.store.db
      .prepare<
        [string],
        {
          conversation_id: string;
          topic: string | null;
          overflow_count: number;
          overflow_summary: string | null;
          unread: number;
        }
      >(
        "SELECT i.conversation_id, c.topic, i.overflow_count, i.overflow_summary, " +
          "(SELECT COUNT(*) FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          " WHERE d.account_id = i.account_id AND m.conversation_id = i.conversation_id " +
          " AND d.path = 'P2' AND d.state IN ('queued','parked','delivered')) AS unread " +
          "FROM mesh_inboxes i JOIN mesh_conversations c ON c.id = i.conversation_id " +
          "WHERE i.account_id = ?",
      )
      .all(endpoint.accountId) as Array<{
      conversation_id: string;
      topic: string | null;
      overflow_count: number;
      overflow_summary: string | null;
      unread: number;
    }>;
    // 未读的原文（最近 3 条预览；P2 的摘要注入以 InboxView 为骨架）
    const blocks: string[] = [];
    for (const conv of convRows) {
      if (conv.unread <= 0 && conv.overflow_count <= 0) continue;
      const recent = this.d.store.db
        .prepare<[string, string], { seq: number; from_account: string; text: string | null }>(
          "SELECT m.seq, m.from_account, json_extract(m.payload, '$.text') AS text " +
            "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
            "WHERE d.account_id = ? AND m.conversation_id = ? AND d.path = 'P2' AND d.state IN " +
            "('queued','parked','delivered') ORDER BY m.seq DESC LIMIT 3",
        )
        .all(endpoint.accountId, conv.conversation_id) as Array<{
        seq: number;
        from_account: string;
        text: string | null;
      }>;
      recent.reverse();
      const lines: string[] = [];
      if (conv.overflow_summary) lines.push(`[summary] ${escapeDelims(conv.overflow_summary)}`);
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
        `<<<INBOX conv="${conv.conversation_id}" unread="${conv.unread}" overflow="${conv.overflow_count}">>>\n` +
          lines.join("\n") +
          "\n<<<END INBOX>>>",
      );
    }
    if (blocks.length === 0) return null;
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
    const row = this.queueDeliveryRow(messageId, false);
    if (!row) return { ok: false };

    // §17.3：claim 只能由被选中的消费者执行（只有合法的当前领取者能推进）
    if (by !== row.account_id) {
      throw new MeshRejectError(
        "CLAIM_TAKEN",
        "message is not assigned to " + by,
      );
    }

    const expired =
      row.claim_until !== null && msFromIso(row.claim_until) <= nowMs;
    if (row.state === "claimed") {
      if (row.claimed_by === by) {
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
          "message is claimed by " + (row.claimed_by ?? "another worker"),
        );
      }
      // 他人租约已过期 → 回收后重新认领（fall through，attempts 不变）
    } else if (row.state !== "delivered") {
      // C3：claimed/acked 必须曾经 delivered；routed/queued/parked 未投到不能领，终态不可领
      return { ok: false };
    }

    const conv = d.registry.getConversation(row.conversation_id);
    const claimTtlMs = conv?.config.claimTtlMs ?? d.limits.claimTtlMs;
    const until = isoFromMs(nowMs + claimTtlMs);
    const now = isoNow();
    d.store.tx(() => {
      // §17：claim 归属写入 delivery 列（claimed_by/claimed_at），正文 payload 不变（A1）
      d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET state = 'claimed', claim_until = ?, claimed_by = ?, claimed_at = ?, state_changed_at = ? WHERE id = ?",
        )
        .run(until, by, now, now, row.id);
      // §17.6：claim 重开持有窗口，pending deadline 与 claim_until 同步推进
      this.syncQueuePendingDeadline(row.correlation_id, until);
      this.resetInboxPending(row.account_id, row.conversation_id);
    });
    return { ok: true, leaseUntil: until };
  }

  async ackQueue(messageId: MessageId, by: AccountId, error?: unknown): Promise<void> {
    const row = this.queueDeliveryRow(messageId, false);
    if (!row || row.state !== "claimed") {
      throw new MeshRejectError(
        "NO_SUCH_CORRELATION",
        "message is not currently claimed: " + messageId,
      );
    }
    if (row.claimed_by !== by) {
      throw new MeshRejectError(
        "CLAIM_TAKEN",
        "cannot ack a message claimed by " + (row.claimed_by ?? "another worker"),
      );
    }
    // C06：先校验身份和端点，再判幂等；过期 claim 一律拒绝
    if (row.claim_until !== null && msFromIso(row.claim_until) <= Date.now()) {
      throw new MeshRejectError("CLAIM_EXPIRED", "claim lease expired for " + messageId);
    }
    if (error !== undefined) {
      await this.nackClaim(row, error);
      return;
    }
    const now = isoNow();
    // §17.6「同一事务四件事」：① 校验（上方）② delivery→acked 清 claim_until ③ pending→answered
    //（queue 无实体应答消息，answered_by_message 留空）④ 前移 cursorSeq（§17.5 queue 只在 ack 前移）。
    this.d.store.tx(() => {
      this.d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET state = 'acked', claim_until = NULL, state_changed_at = ? WHERE id = ? AND state = 'claimed'",
        )
        .run(now, row.id);
      if (row.correlation_id) {
        this.d.store.db
          .prepare(
            "UPDATE mesh_pending_acks SET state = 'answered', deadline = ? WHERE correlation_id = ? AND state = 'open'",
          )
          .run(now, row.correlation_id);
      }
      this.d.store.db
        .prepare(
          "UPDATE mesh_inboxes SET cursor_seq = MAX(cursor_seq, ?) WHERE account_id = ? AND conversation_id = ?",
        )
        .run(row.seq, by, row.conversation_id);
      this.resetInboxPending(by, row.conversation_id);
    });
  }

  async reclaimExpiredClaims(nowMs = Date.now()): Promise<void> {
    const cutoff = isoFromMs(nowMs);
    const d = this.d;
    // §17.2 两个窗口：待领（delivered，投了没人领）与持有（claimed，领了没 ack），
    // 都由 claim_until + claimTtlMs 计时；过期统一走 nackClaim（attempts+1 → 重投 / 死信）。
    const rows = d.store.db
      .prepare<[string], { id: string }>(
        "SELECT d.id FROM mesh_deliveries d " +
          "JOIN mesh_messages m ON m.id = d.message_id " +
          "JOIN mesh_conversations c ON c.id = m.conversation_id " +
          "WHERE c.type = 'queue' AND d.state IN ('delivered','claimed') " +
          "AND d.claim_until IS NOT NULL AND d.claim_until < ?",
      )
      .all(cutoff) as Array<{ id: string }>;
    for (const r of rows) {
      const row = this.queueDeliveryRow(r.id, true);
      if (!row) continue;
      // I27（§7483）：claim_timeout 只计「持有窗口（claimed）过期」——领取了却未 ack；
      // 待领窗口（delivered，投了没人领）是另一回事，不计入。nackClaim 之前按读到的状态判断。
      if (row.state === "claimed") d.store.bumpCounter("claim_timeout");
      // I28：租约过期重投的来源
      await this.nackClaim(row, undefined, "claim_timeout");
    }
  }

  /** 取一条 queue delivery 的完整 claim 上下文（归属/租约/末次错误 + 序号/correlationId/发起方） */
  private queueDeliveryRow(
    key: MessageId | DeliveryId,
    byId: boolean,
  ): QueueDeliveryRow | null {
    const where = byId ? "d.id = ?" : "d.message_id = ?";
    return this.d.store.db
      .prepare<[string], QueueDeliveryRow>(
        "SELECT d.id, d.message_id, d.account_id, d.endpoint_id, m.conversation_id, " +
          "m.correlation_id, m.from_account, m.seq, d.state, d.attempts, d.claim_until, " +
          "d.claimed_by, d.claimed_at, d.claim_error " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "JOIN mesh_conversations c ON c.id = m.conversation_id " +
          "WHERE c.type = 'queue' AND " + where + " ORDER BY m.seq LIMIT 1",
      )
      .get(key) as QueueDeliveryRow | null;
  }

  /** queue 的 claimTtlMs（会话级可覆盖，否则全局）；用于待领/持有窗口与 pending deadline 同步 */
  private queueClaimTtlMs(conversationId: string): number {
    const conv = this.d.registry.getConversation(conversationId);
    return conv?.config.claimTtlMs ?? this.d.limits.claimTtlMs;
  }

  /** §17.6：pending_acks.deadline 与 claim_until 同步推进；claimUntil 缺省重开整个窗口 */
  private syncQueuePendingDeadline(correlationId: string | null, claimUntil: string | null): void {
    if (!correlationId) return;
    const until = claimUntil ?? isoFromMs(Date.now() + this.d.limits.claimTtlMs);
    this.d.store.db
      .prepare(
        "UPDATE mesh_pending_acks SET deadline = ? WHERE correlation_id = ? AND state = 'open'",
      )
      .run(until, correlationId);
  }

  /** nack / 租约过期：attempts+1 → MAX_ATTEMPTS 死信 或 claimed→queued 重投（§17.2/§17.7）。
   *  I28：`redeliverReason` 区分重投来源——ackQueue(error) 显式 nack 写 "nack"，
   *  reclaimExpiredClaims 租约过期写 "claim_timeout"。 */
  private async nackClaim(row: QueueDeliveryRow, error?: unknown, redeliverReason = "nack"): Promise<void> {
    const d = this.d;
    const attempts = row.attempts + 1;
    const env = this.envelopeOf(row.message_id);
    const lastError =
      error === undefined ? undefined : typeof error === "string" ? error : JSON.stringify(error);
    if (attempts > d.limits.maxAttempts) {
      // §17.7 死信：dropped(MAX_ATTEMPTS) + pending timeout + request_timeout + claim_error + system 通知
      d.store.tx(() => {
        d.store.db
          .prepare(
            "UPDATE mesh_deliveries SET state = 'dropped', drop_reason = 'MAX_ATTEMPTS', claim_until = NULL, " +
              "claimed_by = NULL, claim_error = ?, attempts = ?, state_changed_at = ? WHERE id = ?",
          )
          .run(lastError ?? null, attempts, isoNow(), row.id);
        if (row.correlation_id) {
          d.store.db
            .prepare(
              "UPDATE mesh_pending_acks SET state = 'timeout' WHERE correlation_id = ? AND state = 'open'",
            )
            .run(row.correlation_id);
          d.store.bumpCounter("request_timeout");
        }
        this.resetInboxPending(row.account_id, row.conversation_id);
      });
      if (env)
        d.events.emit("message_dropped", {
          envelope: env,
          ...(row.endpoint_id ? { endpointId: row.endpoint_id } : {}),
          reason: "MAX_ATTEMPTS",
        });
      // §17.7 死信通知（必须：发起方是 Agent，不轮询库表，没这条消息会永远等下去）
      if (d.systemSend && row.correlation_id) {
        try {
          await d.systemSend({
            to: row.from_account,
            conversationId: row.conversation_id,
            text:
              "task dead-lettered (correlationId=" + row.correlation_id + ")" +
              (lastError ? "; last error: " + lastError : ""),
            clientToken: "deadletter-" + row.correlation_id,
          });
        } catch {
          // 通知失败只影响告警，不改死信判定
        }
      }
      return;
    }
    // 回队重投：清 claim 归属/租约，endpoint 归 NULL，重开 pending 窗口，交给统一投递路径重选消费者
    const now = isoNow();
    d.store.tx(() => {
      d.store.db
        .prepare(
          "UPDATE mesh_deliveries SET state = 'queued', queued_at = ?, claim_until = NULL, " +
            "claimed_by = NULL, claimed_at = NULL, claim_error = NULL, endpoint_id = NULL, attempts = ?, " +
            "redeliver_reason = ?, state_changed_at = ? WHERE id = ?",
        )
        .run(now, attempts, redeliverReason, now, row.id);
      // §17.6：每次回队重投更新 deadline（重开整个窗口），correlation_id 稳定不新开行
      this.syncQueuePendingDeadline(row.correlation_id, null);
      this.resetInboxPending(row.account_id, row.conversation_id);
    });
    // 统一投递路径（deliverOne → endpointSelector 重新选端）；单消费者 account 不变，
    // 多消费者「换一个消费者」的重算留 W12/W13 pooled 装配收口。
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
    // §17.2 待领窗口：queue 投递进入 delivered 即开启 claim_until（投了没人领的回收计时）。
    // I26：同一咽喉顺带读出定档/端点/路径/唤醒全投影——跃迁成功即统一发 message_delivered
    // （P1=entry_appended / P2=注入确认 / P3=note 完成 / sink=accepted 四路汇此，不再各自发）。
    const q = d.store.db
      .prepare<
        [string],
        {
          message_id: string;
          account_id: string;
          endpoint_id: string | null;
          grade: string | null;
          path: string | null;
          woke: number;
          convId: string;
          type: string;
          correlation_id: string | null;
        }
      >(
        "SELECT d.message_id, d.account_id, d.endpoint_id, d.grade, d.path, d.woke, " +
          "m.conversation_id AS convId, c.type AS type, m.correlation_id AS correlation_id " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "JOIN mesh_conversations c ON c.id = m.conversation_id WHERE d.id = ?",
      )
      .get(deliveryId);
    const isQueue = q?.type === "queue";
    const claimUntil = isQueue
      ? isoFromMs(Date.now() + this.queueClaimTtlMs(q!.convId))
      : null;
    const res = d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'delivered', delivered_at = ?, entry_id = ?, handoff_at = NULL, state_changed_at = ?, " +
          "claim_until = COALESCE(?, claim_until) " +
          "WHERE id = ? AND state IN ('queued','routed')",
      )
      .run(now, entryId, now, claimUntil, deliveryId);
    // §17.6：queue 的 pending deadline 与 claim_until 同步推进（待领窗口起点）
    if (res.changes > 0 && isQueue) {
      this.syncQueuePendingDeadline(q!.correlation_id, claimUntil);
    }
    // I02：delivered 的唯一咽喉——跃迁成功即到达确认点，才推进 outbox 终态 done
    // （InProcessTransport.ack 为 no-op，SameHostTransport.ack 落 done）。
    if (res.changes > 0) {
      void d.transport.ack(deliveryId, "delivered");
      // I26：delivered 统一发事件（sink/external 无端点落 ""，与 markConsumed/markConsumedPartial
      // 的哨兵口径一致，§12.5）
      const env = q ? this.envelopeOf(q.message_id) : null;
      if (q && env) {
        d.events.emit("message_delivered", {
          envelope: env,
          endpointId: q.endpoint_id ?? "",
          accountId: q.account_id,
          grade: (q.grade ?? "followUp") as Grade,
          woke: q.woke === 1,
          path: (q.path ?? "P1") as "P1" | "P2" | "P3",
        });
      }
    }
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
    // §20.1 注 2 / I33：NO_SESSION 是「唯一要告警」的 park 原因——sessionFactory
    // 拿不到 session 说明库已偏离正常运行，记为必订的 invariant_violated（§12.5 末）。
    if (reason === "NO_SESSION") {
      d.events.emit("invariant_violated", {
        code: "no_session",
        detail: { deliveryId, ...(endpointId ? { endpointId } : {}) },
      });
      d.store.bumpCounter("invariant_violated");
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
    // I32(a)：pending→dropped 会减少未读缓存。先按「旧状态 ∈ pending」读出归属，
    // UPDATE 后同事务（dropDelivery 全程同步，无 await 交错）重算对应 (account, conv)。
    // 非 pending 的落 dropped 不影响 pending 缓存，读不到即跳过。
    const prev = d.store.db
      .prepare<
        [string],
        { account_id: string; conversation_id: string; endpoint_id: string | null }
      >(
        "SELECT d.account_id, m.conversation_id, d.endpoint_id FROM mesh_deliveries d " +
          "JOIN mesh_messages m ON m.id = d.message_id WHERE d.id = ? AND d.state IN " +
          PENDING_STATES,
      )
      .get(deliveryId);
    const now = isoNow();
    d.store.db
      .prepare(
        "UPDATE mesh_deliveries SET state = 'dropped', drop_reason = ?, state_changed_at = ? WHERE id = ?",
      )
      .run(reason, now, deliveryId);
    if (prev) d.store.recomputeInbox(prev.account_id, prev.conversation_id);
    if (envelope) {
      d.events.emit("message_dropped", {
        envelope,
        ...(prev?.endpoint_id ? { endpointId: prev.endpoint_id } : {}),
        reason,
      });
    }
  }

  private envelopeOf(messageId: string): Envelope | null {
    const row = this.d.store.db
      .prepare<[string], MessageRow>("SELECT * FROM mesh_messages WHERE id = ?")
      .get(messageId) as MessageRow | undefined;
    if (!row) return null;
    // §22.4：启用 seal 且该行带 seal 才验签；历史行（seal=NULL）放行，不补签。
    // 验签失败 = 拒绝投递 + invariant_violated + 保留原消息（绝不静默修复）。
    if (
      this.d.sealKey !== undefined &&
      row.seal !== null &&
      !sealValid(this.d.sealKey, row)
    ) {
      this.d.events.emit("invariant_violated", {
        code: "seal_mismatch",
        detail: { messageId },
      });
      this.d.store.bumpCounter("invariant_violated");
      return null;
    }
    return rowToEnvelope(row);
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
    // §15.2：显式/派生单一事实源在 Registry（effectivePresence）；这里只负责
    // 派生变迁的 presence_changed 去重发射（host 变迁由 index.ts setPresence 发射并
    // 经 notePresence 同步本跟踪器）。
    const p = this.d.registry.effectivePresence(accountId);
    const prev = this.lastPresence.get(accountId);
    if (prev !== undefined && prev !== p) {
      this.d.events.emit("presence_changed", {
        accountId,
        from: prev,
        to: p,
        source: this.d.registry.isExplicitPresence(accountId)
          ? "host"
          : "derived",
      });
    }
    this.lastPresence.set(accountId, p);
    return p;
  }

  /** 宿主 setPresence 后同步本跟踪器（不重复发射——host 侧已发） */
  notePresence(accountId: AccountId, state: PresenceState): void {
    this.lastPresence.set(accountId, state);
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
      reason: PolicyDegradeReason,
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
