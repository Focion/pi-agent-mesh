// ═══════════════════════════════════════════════════════════════════════════
// Pi Agent Mesh — 公共类型面
// 依据：.agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md §5.2 §12.1–§12.6 §2.4 §19.2 附录 F
// 本文件是全库唯一类型契约：枚举与原因码的漂移是最贵的漂移（§12.6 末）。
// 零外部依赖（M1：不得出现宿主业务词汇；session 字段为 unknown 以保住
// mesh-core 零 pi import 门禁，见 .agents/notes/plan/2026-09-07-p0-p1-rollout.md §0）。
// ═══════════════════════════════════════════════════════════════════════════

// ─── ① 标识与字面量联合（§12.6 ①）──────────────────────────────────────────

export type AccountId = string;
export type EndpointId = string;
export type ConversationId = string;
export type MessageId = string; // = Envelope.id
export type DeliveryId = string; // = mesh_deliveries.id
export type SpaceId = string; // conversationId | "global" | 宿主自定义
export type EntryId = string; // pi entry id（onEntry 归因）
export type PiSessionId = string; // 仅 stream 端点有
export type CorrelationId = string; // 请求-应答配对键

export type Grade = "steer" | "followUp" | "silent"; // 三档（F1：nextTurn 已删）
export type MessageKind = "chat" | "task" | "event" | "system" | "tombstone";
export type ExpectKind = "ack" | "reply" | "none"; // 唤醒的唯一判据（Q17）
export type Priority = "urgent" | "normal" | "low";
export type EndpointClass = "stream" | "sink" | "external";
export type MeshLease = "shared" | "exclusive"; // 库自己的租约，非 pi-client 的
export type Cap = "speak" | "read" | "invite" | "remove" | "setTopic" | "setCaps" | "dissolve";
export type ConversationKind = "direct" | "group" | "topic" | "queue"; // 无 system 类型
export type ConversationType = ConversationKind; // 同义别名
export type ConvState = "active" | "archived";
export type EndpointState = "cold" | "warming" | "hot" | "evicting" | "unavailable";
export type PresenceState = "available" | "busy" | "dnd" | "away" | "offline";
export type DeliveryState =
  | "routed"
  | "queued"
  | "delivered"
  | "consumed"
  | "parked" // 旁路非终态（§7.9②）
  | "dropped"
  | "claimed" // queue 专有（§17）
  | "acked"; // queue 专有（§17）
export type ContextPath = "P1" | "P2" | "P3"; // §7.6 三条进上下文路径

// 三类原因码（§7.10 权威表的类型化）。三类之间不得复用同一个词。
export type RejectCode =
  | "NOT_A_MEMBER"
  | "NO_SPEAK_CAP"
  | "CANNOT_INITIATE"
  | "TARGETING_NOT_SUPPORTED"
  | "FANOUT_TOO_LARGE"
  | "MENTION_ALL_THROTTLED"
  | "NO_FLOOR"
  | "JOIN_DENIED"
  | "NO_ADMIN_LEFT"
  | "REQUEST_CYCLE";

export type ParkReason =
  | "ENDPOINT_GONE"
  | "LEASE_HELD"
  | "NO_SINK_HANDLER"
  | "SINK_REFUSED"
  | "PORT_TIMEOUT"
  | "NO_SESSION"; // 唯一要告警的一个

export type DropReason =
  | "folded" // 不计失败率（§7.5）
  | "TTL_EXPIRED"
  | "TRANSPORT_FAILED"
  | "MAX_ATTEMPTS"
  | "ACL_DENIED"
  | "MUTED"
  | "TOMBSTONED"
  | "WAKE_THROTTLED_AND_EXPIRED";

// 工具层错误码（§10.1 末表；与上面三类互不复用）
export type ToolErrorCode =
  | "ARG_INVALID"
  | "TOOL_DISABLED"
  | "CAP_REQUIRED"
  | "HISTORY_FORBIDDEN"
  | "NO_SUCH_CORRELATION"
  | "ACK_CLOSED"
  | "CLAIM_TAKEN"
  | "CLAIM_EXPIRED"
  | "NO_SUCH_KEY"
  | "VERSION_MISMATCH"
  | "OBJECT_TOO_LARGE"
  | "SPACE_FORBIDDEN";

/** MeshRejectError 可携带的码 = 纯 reject 码 ∪ 工具层错误码（host 面与工具面同源） */
export type MeshErrorCode = RejectCode | ToolErrorCode;

export type Unsubscribe = () => void;

// ─── ② 信封（§5.2）────────────────────────────────────────────────────────

export interface EnvelopePayload {
  text?: string;
  data?: unknown;
  attachments?: SharedRef[];
}

/** 共享空间附件引用：只传引用，不内联进上下文（§18） */
export interface SharedRef {
  spaceId: SpaceId;
  key: string;
  version?: number;
}

/**
 * 三层信封：系统层（Router 签发，发送方不可伪造）/ 意图层（发送方提出，Router
 * 校验）/ 领域层（ext，库只透传不解释）。
 */
export interface Envelope<E = unknown> {
  // ── 系统层（Router 签发）──
  id: MessageId; // ULID
  seq: number; // 会话内单调递增，路由事务内分配
  from: AccountId; // 执行上下文推导，不接受入参（§5.4）
  fromEndpoint: EndpointId | null;
  routedAt: string; // 真实墙钟 ISO8601（运维用，不参与业务排序）
  idempotencyKey: string; // sha256(convId, from, clientToken)（§5.5）
  seal?: string; // 完整性封印（§22.4：只防 Agent 层伪造）

  // ── 意图层（发送方提出，Router 校验）──
  conversationId: ConversationId;
  to?: AccountId[]; // 定向投递集；空 = 全体成员减发送方（§6.1）
  kind: MessageKind;
  expect: ExpectKind; // 默认 "none"；唤醒的主判据
  priority?: Priority;
  mentions?: AccountId[]; // 参与投递集与渲染，不参与唤醒（Q17）
  replyTo?: MessageId;
  correlationId?: CorrelationId;
  requestType?: string; // 库不解释
  logicalTs?: string; // 不透明；排序一律用 seq（Q10）
  claim?: { by: AccountId; at: string }; // 仅 queue（§17）

  // ── 载荷 ──
  payload: EnvelopePayload;

  // ── 领域层（M1：原样落库、原样到达、原样出现在事件里）──
  ext?: E;
}

/** 发送入参 = Envelope 减去系统层字段；text 是 payload.text 的扁平糖 */
export type SendInput = Omit<
  Envelope<never>,
  "id" | "seq" | "from" | "fromEndpoint" | "routedAt" | "idempotencyKey" | "seal" | "payload" | "ext"
> & {
  payload?: EnvelopePayload;
  text?: string;
  ext?: unknown;
};

// ─── ③ 实体投影（§12.6 ②）─────────────────────────────────────────────────

export interface Account {
  id: AccountId;
  displayName: string;
  endpointClass: EndpointClass;
  capabilities?: string[]; // 开放取值，库不解释（§4.2 轴二）
  initiate: MessageKind[]; // 轴三：空数组 = 纯接收
  defaultGrade?: Grade;
  profileRef?: string; // 不透明
  ext?: unknown;
}

export interface Membership {
  conversationId: ConversationId;
  accountId: AccountId;
  caps: Cap[]; // 七位能力，无角色序（I8）
  joinedSeq: number; // historyVisibility: "since_join" 的过滤基准
  mutedUntil?: string;
  verbatimPinned?: boolean; // 三态：true/false/undefined=按预算（§7.4）
  ext?: Record<string, unknown>;
}

export interface Conversation {
  id: ConversationId;
  kind: ConversationKind;
  state: ConvState;
  topic?: string;
  announcement?: string;
  config: ConversationConfig;
  createdBy: AccountId;
  createdAt: string;
  lastSeq: number;
  ext?: unknown;
}

export interface ConversationConfig {
  historyVisibility: "none" | "since_join" | "full"; // 默认 "since_join"
  maxHistoryOnJoin: number; // 默认 0（不注入历史）
  openJoin?: boolean; // 默认 false
  groupSizeHardCap?: number; // 只允许收紧（≤ 全局值）
  claimTtlMs?: number; // queue 专有
  mentionAllPerHour?: number; // 默认 3（§6.1）
  maxPending?: number; // 按会话覆盖全局（F.3）
  maxPendingBytes?: number;
}

export type StreamTopology =
  | { kind: "unified" } // 默认：一账号一流（§8.1）
  | { kind: "perConversation"; scope: "conversation" | "purpose"; key: string }
  | { kind: "pooled"; size: number; affinity?: "none" | "conversation" | "sender" };

export interface Endpoint {
  id: EndpointId;
  accountId: AccountId;
  topology: StreamTopology;
  state: EndpointState;
  piSessionId: PiSessionId | null; // 未热化 / sink / external 恒为 null
  lease: MeshLease;
  leaseUntil: string | null;
  lastActiveAt: string | null;
}

export interface Presence {
  accountId: AccountId;
  state: PresenceState;
  changedAt: string;
  source: "host" | "derived";
  until?: string;
  reason?: string;
}

// ─── ④ 收件箱、轨迹与其余投影（§12.6 ③）───────────────────────────────────

export interface RecentPreview {
  seq: number;
  from: AccountId;
  name: string; // Account.displayName，库不解释
  preview: string; // 截断到 40 字
  mentionsMe: boolean;
  expectsMyAck: boolean;
}

export interface InboxState {
  conversationId: ConversationId;
  kind: ConversationKind;
  topic?: string;
  peer?: AccountId; // direct 的对端
  unread: number; // ≡ mesh_deliveries 里该账号未消费行数（§6.2）
  overflow?: number;
  summary?: string; // 超预算会话的折叠摘要
  recent: RecentPreview[]; // ≤ 3 条
  verbatim: boolean; // 本会话当前是否在原文预算内（§7.4）
  lastSeq: number;
  lastAt: string;
  claimable?: number; // queue 专有
  myClaims?: Array<{ messageId: MessageId; leaseIn: string }>;
}

export interface InboxView {
  conversations: InboxState[];
  awaitingMyAck: Array<{ correlationId: CorrelationId; from: AccountId; intent?: string; deadlineIn: string }>;
  awaitingTheirAck: Array<{ correlationId: CorrelationId; to: AccountId; intent?: string; deadlineIn: string }>;
}

export interface ConversationSummary {
  conversationId: ConversationId;
  kind: ConversationKind;
  title: string;
  state: ConvState;
  memberCount?: number; // topic 无成员表 ⇒ undefined
  myCaps: Cap[];
  lastSeq: number;
  lastAt: string;
}

export interface DeliveryTrace {
  deliveryId: DeliveryId;
  messageId: MessageId;
  accountId: AccountId;
  endpointId: EndpointId | null;
  state: DeliveryState;
  grade: Grade | null;
  partial: boolean; // consumed(partial)：只由 abort 造成
  reason: RejectCode | ParkReason | DropReason | null;
  attempts: number;
  woke: boolean;
  path: ContextPath | null;
  handoffAt: string | null;
  parkedAt: string | null;
  stateChangedAt: string;
  createdAt: string;
}

export interface StreamEntry {
  entryId: EntryId;
  piSessionId: PiSessionId;
  parentId: EntryId | null;
  seqInStream: number;
  entryType: string;
  rawJson: string; // byte-fidelity 原文，库不解析
  meshMessageId: MessageId | null;
  createdAt: string;
}

export interface ReplayResult {
  prompt: string;
  entries: StreamEntry[];
  inbox: InboxView;
  injected: string[];
}

export interface ConversationChange {
  op:
    | "group_created"
    | "member_joined"
    | "member_left"
    | "member_removed"
    | "caps_changed"
    | "topic_changed"
    | "announcement_changed"
    | "group_dissolved"
    | "upgraded" // 以上同时产生 system 消息
    | "subscribed"
    | "unsubscribed"
    | "muted"; // 这三个不发 system 消息
  by: AccountId;
  target?: AccountId;
  detail?: unknown;
}

export interface AckResult {
  correlationId: CorrelationId;
  ok: boolean;
  from: AccountId;
  data?: unknown;
  error?: unknown;
  timedOut?: boolean;
}

export interface SinkHandler {
  deliver(
    rendered: string,
    envelope: Envelope,
    grade: Grade
  ): Promise<{ accepted: boolean; consumedImmediately?: boolean }>;
}

export interface PendingDelivery {
  deliveryId: DeliveryId;
  envelope: Envelope;
  grade: Grade;
  accountId: AccountId;
  endpointId: EndpointId | null;
}

export type DeliveryHandler = (d: PendingDelivery) => void | Promise<void>;

export interface AclRule {
  kind: "public" | "conversation" | "accounts" | "capabilities" | "custom";
  conversationId?: ConversationId;
  accounts?: AccountId[];
  capabilities?: string[];
  tag?: string;
}

/** §18 三向 ACL：read（get/list）、write（put/del/append）、admin（改 ACL/管理）各自裁决 */
export interface Acl {
  read: AclRule[];
  write: AclRule[];
  admin: AclRule[];
}

export interface SharedObjectMeta {
  key: string;
  version: number;
  ownerId: AccountId;
  acl: Acl;
  size: number;
  contentType?: string;
  updatedAt: string;
  /** `get` 填充、`list` 不填（避免大对象整表回传） */
  data?: unknown;
}

export interface AclCtx {
  account: Account;
  conversation?: Conversation;
  membership?: Membership;
  object?: SharedObjectMeta;
  op: "read" | "write" | "admin" | "delete";
  tag?: string;
}

export interface InvariantReport {
  ok: boolean;
  checked: number;
  at: string;
  violations: Array<{ id: string; assertion: string; count: number; sample: unknown[] }>;
}

/** 库内工具形状：结构上与 pi 的 ToolDefinition 兼容（mesh-pi 负责桥接注册） */
export interface MeshToolResult {
  content: string | Array<{ type: "text"; text: string }>;
  details?: unknown;
  terminate?: boolean;
}

export interface ToolDefinition {
  name: MeshToolName | string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: object; // JSON Schema（TypeBox 兼容）
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown
  ) => Promise<MeshToolResult>;
}

export type MeshToolName =
  | "mesh_send"
  | "mesh_ack"
  | "mesh_lookup"
  | "mesh_inbox"
  | "mesh_history"
  | "mesh_conversations"
  | "mesh_members"
  | "mesh_contacts"
  | "mesh_create_conversation"
  | "mesh_conversation_admin"
  | "mesh_claim"
  | "mesh_shared_get"
  | "mesh_shared_put"
  | "mesh_shared_list";

// ─── ⑤ 九个策略槽（§12.3）─────────────────────────────────────────────────

export interface DeliveryPolicy {
  grade(ctx: {
    envelope: Envelope;
    recipient: Account;
    membership?: Membership;
    conversation: Conversation;
    memberCount: number;
    inbox: InboxState;
    verbatim: boolean;
  }): Grade;
}

export interface ActivationPolicy {
  shouldWake(ctx: {
    envelope: Envelope;
    recipient: Account;
    grade: Grade;
    expect: ExpectKind;
    awaitingCorrelations: string[];
    inbox: InboxState;
    presence: PresenceState;
  }): boolean;
}

export interface FloorPolicy {
  grantFloor(ctx: {
    conversationId: ConversationId;
    candidates: AccountId[];
    lastSpeakers: AccountId[];
    envelope: Envelope;
  }): AccountId[];
}

export interface Renderer {
  renderMessage(env: Envelope, ctx: { recipient: Account; senderName: string }): string;
  renderInbox(view: InboxView, recent: Envelope[]): string; // P2 注入体（§7.6）
  renderSystem(env: Envelope): string;
}

export interface LogicalClock {
  compare(a: string | undefined, b: string | undefined): number;
  format?(ts: string): string;
}

export interface AccessControl {
  canRead?(ctx: AclCtx): boolean | Promise<boolean>;
  canWrite?(ctx: AclCtx): boolean | Promise<boolean>;
  canAdmin?(ctx: AclCtx): boolean | Promise<boolean>;
  canSend?(ctx: {
    envelope: Envelope;
    from: Account;
    conversation: Conversation;
    membership?: Membership;
  }): boolean | Promise<boolean>;
  canPublish?(ctx: { envelope: Envelope; from: Account; conversation: Conversation }): boolean | Promise<boolean>;
  /** §6.1/§9.5 @all 权限闸的 AccessControl 半边：否决 → reject(NO_SPEAK_CAP)；缺省放行 */
  canMentionAll?(ctx: {
    envelope: Envelope;
    from: Account;
    conversation: Conversation;
    membership?: Membership;
  }): boolean | Promise<boolean>;
  canInitiateDirect?(from: Account, to: Account): boolean | Promise<boolean>;
  canJoin?(conv: Conversation, account: Account): boolean | Promise<boolean>;
  resolveCustomTag?(tag: string, ctx: AclCtx): boolean | Promise<boolean>;
}

export interface RetentionCandidate {
  id: ConversationId;
  kind: ConversationKind;
  gap: number;
  lastActiveSeq: number;
  unreadBytes: number;
}

export interface VerbatimBudget {
  bytes: number;
  ttlSeq?: number;
}

export interface RetentionPolicy {
  verbatimBudget(ctx: { accountId: AccountId; conversations: RetentionCandidate[] }): VerbatimBudget;
  evictionOrder?: "lru" | ((a: InboxState, b: InboxState) => number);
}

export interface EndpointSelector {
  select(ctx: {
    accountId: AccountId;
    conversationId: ConversationId;
    envelope: Envelope;
    topology: StreamTopology;
  }): EndpointId | EndpointId[] | null; // null = parked
}

/**
 * 唯一必填策略槽（§12.1）。session 类型为 unknown：mesh-core 零 pi 依赖，
 * mesh-pi 侧负责结构校验收窄；宿主需要类型时在自己的工厂内收窄。
 * 耗时不受 policyTimeoutMs 约束（建 session 本身是慢操作，§12.3 ⑨）。
 */
export interface SessionFactory {
  create(ctx: {
    endpoint: Endpoint;
    account: Account;
    tools: ToolDefinition[];
  }): Promise<{ session: unknown; piSessionId: string }>;
  open(ctx: {
    endpoint: Endpoint;
    account: Account;
    piSessionId: string;
    tools: ToolDefinition[];
  }): Promise<{ session: unknown }>;
  dispose?(ctx: { endpoint: Endpoint; session: unknown }): Promise<void>;
}

export interface Policies {
  delivery: DeliveryPolicy;
  activation: ActivationPolicy;
  floor: FloorPolicy;
  renderer: Renderer;
  clock: LogicalClock;
  accessControl: AccessControl;
  retention: RetentionPolicy;
  endpointSelector: EndpointSelector;
  sessionFactory: SessionFactory; // ★ 唯一必填
}

export type PolicySlot = keyof Policies;
export type RequiredPolicySlot = "sessionFactory";
export type OptionalPolicySlot = Exclude<PolicySlot, RequiredPolicySlot>;

export type DegradeTarget =
  | "silent_no_wake"
  | "cursor_only"
  | "parked"
  | "deny"
  | "free_for_all"
  | "builtin_renderer"
  | "wallclock"
  | "unrecoverable";

// ─── ⑥ Limits（附录 F.1：26 项运行期限额）─────────────────────────────────

export interface WakeRateLimit {
  count: number;
  windowMs: number;
}

export interface Limits {
  maxPending: number; // 50
  maxPendingBytes: number; // 32768
  maxInFlight: number; // 200（单 endpoint 跨全部会话，≠ maxPending）
  verbatimGapK: number; // 20
  maxVerbatimConversations: number; // 3
  groupTiers: [number, number, number]; // [3, 8, 30]
  groupSizeWarn: number; // 50
  groupSizeHardCap: number; // 500（仅 group）
  mentionAllCooldownMs: number; // 300000
  wakeRateLimit: WakeRateLimit; // {20, 60000}
  idleEvictMs: number; // 600000（0 = 不驱逐）
  floorSkipMs: number; // 10000
  presenceIdleMs: number; // 300000
  seqGapTimeoutMs: number; // 5000
  ackTimeoutMs: number; // 30000
  replyTimeoutMs: number; // 300000
  parkTtlMs: number; // 3600000
  exclusiveLeaseTtlMs: number; // 60000
  claimTtlMs: number; // 300000
  requestChainMaxDepth: number; // 8
  maxAttempts: number; // 3
  policyTimeoutMs: number; // 50（九槽统一超时，I21）
  handoffTimeoutMs: number; // 30000
  toolResultMaxBytes: number; // 8192
  sharedObjectMaxBytes: number; // 65536
  sharedVersionsKept: number; // 10
}

export const DEFAULT_LIMITS: Limits = {
  maxPending: 50,
  maxPendingBytes: 32768,
  maxInFlight: 200,
  verbatimGapK: 20,
  maxVerbatimConversations: 3,
  groupTiers: [3, 8, 30],
  groupSizeWarn: 50,
  groupSizeHardCap: 500,
  mentionAllCooldownMs: 300000,
  wakeRateLimit: { count: 20, windowMs: 60000 },
  idleEvictMs: 600000,
  floorSkipMs: 10000,
  presenceIdleMs: 300000,
  seqGapTimeoutMs: 5000,
  ackTimeoutMs: 30000,
  replyTimeoutMs: 300000,
  parkTtlMs: 3600000,
  exclusiveLeaseTtlMs: 60000,
  claimTtlMs: 300000,
  requestChainMaxDepth: 8,
  maxAttempts: 3,
  policyTimeoutMs: 50,
  handoffTimeoutMs: 30000,
  toolResultMaxBytes: 65536 / 8,
  sharedObjectMaxBytes: 65536,
  sharedVersionsKept: 10
};

// ─── ⑦ 事件（§12.5 + §12.6 ⑤）────────────────────────────────────────────

export interface MeshEvents {
  message_routed: { envelope: Envelope };
  message_delivered: {
    envelope: Envelope;
    endpointId: EndpointId;
    accountId: AccountId;
    grade: Grade;
    woke: boolean;
    path: ContextPath;
  };
  message_consumed: {
    envelope: Envelope;
    endpointId: EndpointId;
    accountId: AccountId;
    partial: boolean;
    entryId?: EntryId;
  };
  message_parked: { envelope: Envelope; endpointId?: EndpointId; reason: ParkReason };
  message_dropped: { envelope: Envelope; endpointId?: EndpointId; reason: DropReason };
  message_acked: { correlationId: CorrelationId; endpointId: EndpointId; ok: boolean; detail?: unknown };
  inbox_overflowed: {
    accountId: AccountId;
    conversationId: ConversationId;
    foldedCount: number;
    foldedRange: [number, number];
  };
  request_timeout: { correlationId: CorrelationId; from: AccountId; to: AccountId; intent?: string };
  conversation_changed: { conversationId: ConversationId; change: ConversationChange };
  membership_caps_changed: { conversationId: ConversationId; accountId: AccountId; caps: Cap[] };
  shared_object_changed: { spaceId: SpaceId; key: string; version: number; by: AccountId };
  presence_changed: { accountId: AccountId; from: PresenceState; to: PresenceState };
  endpoint_state_changed: { endpointId: EndpointId; from: EndpointState; to: EndpointState };
  policy_degraded: { slot: PolicySlot; reason: "timeout" | "threw"; degradedTo: DegradeTarget };
  invariant_violated: { code: string; detail: unknown };
}

export interface MeshEventMeta {
  at: string; // 墙钟 ISO8601
  endpointId: EndpointId | null; // 归因端点
}

export type MeshEvent = MeshEventMeta &
  (
    | { type: "message_routed"; envelope: Envelope }
    | { type: "message_delivered"; envelope: Envelope; accountId: AccountId; grade: Grade; woke: boolean; path: ContextPath }
    | { type: "message_consumed"; envelope: Envelope; accountId: AccountId; partial: boolean; entryId?: EntryId }
    | { type: "message_parked"; envelope: Envelope; reason: ParkReason }
    | { type: "message_dropped"; envelope: Envelope; reason: DropReason }
    | { type: "message_acked"; correlationId: CorrelationId; ok: boolean; detail?: unknown }
    | {
        type: "inbox_overflowed";
        accountId: AccountId;
        conversationId: ConversationId;
        foldedCount: number;
        foldedRange: [number, number];
      }
    | { type: "request_timeout"; correlationId: CorrelationId; from: AccountId; to: AccountId; intent?: string }
    | { type: "conversation_changed"; conversationId: ConversationId; change: ConversationChange }
    | { type: "membership_caps_changed"; conversationId: ConversationId; accountId: AccountId; caps: Cap[] }
    | { type: "shared_object_changed"; spaceId: SpaceId; key: string; version: number; by: AccountId }
    | { type: "presence_changed"; accountId: AccountId; from: PresenceState; to: PresenceState }
    | { type: "endpoint_state_changed"; endpointId: EndpointId; from: EndpointState; to: EndpointState }
    | { type: "policy_degraded"; slot: PolicySlot; reason: "timeout" | "threw"; degradedTo: DegradeTarget }
    | { type: "invariant_violated"; code: string; detail: unknown }
  );

// ─── ⑧ StreamPort（§2.4：锁定的 10 个方法）────────────────────────────────

export interface PortEntryEvent {
  endpointId: EndpointId;
  entryId: EntryId;
  parentId?: string;
  envelopeId?: MessageId; // delivered 归因的唯一依据（§7.9①）
  entryType: string; // 原样透传，库不枚举校验（§11.5）
  seqInStream: number; // 端口分配的流内序号（pi 的 SessionEntry 没有 seq，F4）
  rawJson: string; // byte-fidelity 原文（镜像入库用）
}

export interface PortStatus {
  state: EndpointState;
  busy: boolean;
  inFlight: number; // 端口自己的 handoff 计数（§7.8；非 SDK 的 pendingMessageCount，F3）
}

/**
 * mesh-core 与 pi SDK 之间的唯一接口，恰好 10 个方法（§2.4）。
 * deliver 的 resolve 不等于 delivered（F5）；判据是 onEntry。
 */
export interface StreamPort {
  warm(endpointId: string, lease?: MeshLease): Promise<void>;
  evict(endpointId: string): Promise<void>;
  deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    opts?: { triggerTurn?: boolean }
  ): Promise<{ entryId?: string }>;
  nudge(
    endpointId: string,
    cue: string,
    opts?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean }
  ): Promise<void>;
  note(endpointId: string, customType: string, data: unknown): Promise<void>;
  injectContext(endpointId: string, text: string): Unsubscribe;
  status(endpointId: string): PortStatus;
  hasEntries(endpointId: string, entryIds: string[]): Promise<Set<string>>;
  onEntry(h: (e: PortEntryEvent) => void): Unsubscribe;
  onTurnEnd(h: (e: { endpointId: string }) => void): Unsubscribe;
}

// ─── ⑨ Transport（§19.2：四个成员的窄接口）───────────────────────────────

export interface Transport {
  publish(d: PendingDelivery): Promise<void>;
  subscribe(endpointId: EndpointId, h: DeliveryHandler): Unsubscribe;
  ack(deliveryId: string, state: DeliveryState): Promise<void>;
  readonly kind: "inProcess" | "sameHost" | (string & {});
}

// ─── ⑩ Observer（§12.4：全库唯一保证只读的读入口）────────────────────────

export interface Observer {
  messages(q: {
    conversationId?: string;
    from?: string;
    kind?: MessageKind;
    sinceSeq?: number;
    limit?: number;
  }): Promise<Envelope[]>;
  search(q: { text: string; conversationId?: string; limit?: number }): Promise<Envelope[]>;
  trace(messageId: string): Promise<DeliveryTrace[]>;
  inboxOf(accountId: string): Promise<InboxView>;
  conversationsOf(accountId: string): Promise<ConversationSummary[]>;
  streamEntries(piSessionId: string, opts?: { sinceSeq?: number }): Promise<StreamEntry[]>;
  replay(endpointId: string, opts?: { untilSeq?: number }): Promise<ReplayResult>;
  forkAt(endpointId: string, entryId: string): Promise<{ endpointId: string }>;
  counters(names?: string[], since?: string): Promise<Record<string, number>>;
  checkInvariants(): Promise<InvariantReport>;
}

// ─── ⑪ MeshHost 与装配入口（§12.1 §12.2）─────────────────────────────────

export interface RegisterAccountInput {
  id?: string;
  displayName: string;
  endpointClass: EndpointClass;
  capabilities?: string[];
  initiate?: MessageKind[];
  defaultGrade?: Grade;
  profileRef?: string;
  ext?: unknown;
}

export interface RegisterEndpointInput {
  accountId: AccountId;
  topology: StreamTopology;
  piSessionId?: string;
}

export interface CreateConversationInput {
  type: "group" | "topic" | "queue";
  creator: AccountId;
  members?: AccountId[];
  topic?: string;
  config?: Partial<ConversationConfig>;
  ext?: unknown;
}

export interface MeshHost {
  // ── 账号、端点与寻址 ──
  registerAccount(a: RegisterAccountInput): Promise<Account>;
  registerEndpoint(e: RegisterEndpointInput): Promise<Endpoint>;
  registerSinkHandler(accountId: string, h: SinkHandler): Unsubscribe;
  markConsumed(deliveryId: string): Promise<void>;
  setPresence(accountId: string, state: PresenceState, opts?: { until?: string; reason?: string }): Promise<void>;
  upsertContact(ownerId: string, peerId: string, opts?: { alias?: string; tags?: unknown }): Promise<void>;
  lookup(q: { query?: string; capabilities?: string[]; limit?: number }): Promise<Account[]>;

  // ── 会话与成员 ──
  ensureDirect(a: string, b: string): Promise<Conversation>;
  createConversation(c: CreateConversationInput): Promise<Conversation>;
  addMember(conv: string, account: string, opts?: { caps?: Cap[]; by?: string }): Promise<void>;
  removeMember(conv: string, account: string, opts: { by: string }): Promise<void>;
  join(conv: string, account: string): Promise<void>;
  leave(conv: string, account: string): Promise<void>;
  setCaps(conv: string, account: string, caps: Cap[], by: string): Promise<void>;
  subscribe(conv: string, account: string, opts?: { fromSeq?: number }): Promise<void>;
  unsubscribe(conv: string, account: string): Promise<void>;
  setAnnouncement(conv: string, text: string, by: string): Promise<void>;
  setTopic(conv: string, text: string, by: string): Promise<void>;
  mute(conv: string, account: string, until: string): Promise<void>;
  dissolve(conv: string, by: string): Promise<void>;
  upgradeToGroup(directConv: string, extra: string[], by: string): Promise<Conversation>;

  // ── 发送与应答 ──
  send(m: SendInput & { from: string }): Promise<{ messageId: string; seq: number }>;
  request(
    m: SendInput & { from: string; expect: "ack" | "reply" },
    opts?: { await?: boolean }
  ): Promise<{ correlationId: string } | AckResult>;
  ack(r: { correlationId: string; from: string; data?: unknown; error?: unknown }): Promise<void>;
  claim(messageId: string, by: string): Promise<{ ok: boolean; leaseUntil?: string }>;
  requeue(messageId: string, targetConv: string): Promise<void>;

  // ── 控制面：推自己的 Agent，不伪造消息 ──
  nudge(endpointId: string, cue: string, opts?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean }): Promise<void>;
  injectContext(endpointId: string, text: string): Unsubscribe;
  beforeClearQueue(endpointId: string): Promise<void>;

  // ── 共享空间（P4）──
  shared: {
    get(spaceId: string, key: string, opts: { as: string; version?: number }): Promise<SharedObjectMeta | null>;
    put(
      spaceId: string,
      key: string,
      data: unknown,
      opts: { as: string; expectedVersion?: number; contentType?: string; acl?: Acl; ext?: unknown }
    ): Promise<{ version: number }>;
    append(spaceId: string, key: string, item: unknown, opts: { as: string; maxLen?: number }): Promise<{ version: number }>;
    del(spaceId: string, key: string, opts: { as: string }): Promise<void>;
    list(spaceId: string, opts: { as: string; keyPrefix?: string }): Promise<SharedObjectMeta[]>;
  };

  // ── 流控制 ──
  warm(endpointId: string, lease?: MeshLease): Promise<void>;
  evict(endpointId: string): Promise<void>;
  toolSet(endpointId: string, only?: MeshToolName[]): ToolDefinition[];

  // ── 事件与观测 ──
  on<K extends keyof MeshEvents>(e: K, h: (p: MeshEvents[K]) => void): Unsubscribe;
  readonly observer: Observer;
  close(): Promise<void>;
}

export interface MeshOptions {
  dbPath: string;
  policies: Partial<Policies> & Pick<Policies, "sessionFactory">;
  /** Transport 实现：默认 InProcessTransport；传 "sameHost" 创建 SameHostTransport（§19.3） */
  transport?: Transport | "sameHost";
  /** SameHostTransport 配置（仅 transport="sameHost" 时生效） */
  transportOptions?: { pollIntervalMs?: number; claimTtlMs?: number; maxAttempts?: number };
  streamPort?: StreamPort;
  limits?: Partial<Limits>;
  devMode?: boolean;
  /**
   * §6.1/F.2：放行 `mentions: ["@all"]` 的能力位（默认 `"speak"`，须为 §4.4
   * 七能力位之一；收紧如 `"setCaps"` 可让全员唤醒只归管理员）。
   */
  mentionAllCap?: Cap;
  /**
   * §19.5 / 附录 F.2：SQLite `busy_timeout`（拿不到写锁时的等待上限，0–60000，
   * 默认 5000）。0 = 立即失败（`SQLITE_BUSY` 抛给调用方），多进程部署建议显式设置。
   */
  busyTimeoutMs?: number;
}

export declare function createMesh(options: MeshOptions): Promise<MeshHost>;

// ─── ⑫ 错误类型 ───────────────────────────────────────────────────────────

/** reject(code)：同步返回发送方，不落任何 delivery（§7.10） */
export class MeshRejectError extends Error {
  readonly code: MeshErrorCode;
  constructor(code: MeshErrorCode, message?: string) {
    super(message ?? code);
    this.name = "MeshRejectError";
    this.code = code;
  }
}

/** 本构建暂未实现的公共面方法（P2–P5 演进中） */
export class MeshUnsupportedError extends Error {
  constructor(what: string) {
    super(`not implemented in this build: ${what}`);
    this.name = "MeshUnsupportedError";
  }
}

/** 库内部不变量失败（devMode 下抛出；生产发 invariant_violated 事件） */
export class InvariantViolationError extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(code: string, detail: unknown) {
    super(`invariant violated: ${code}`);
    this.name = "InvariantViolationError";
    this.code = code;
    this.detail = detail;
  }
}
