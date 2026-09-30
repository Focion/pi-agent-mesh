// ═══════════════════════════════════════════════════════════════════════════
// Pi Agent Mesh — 内部组件契约（非公共 API，不从包根导出）
// 依据：.agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md §3 架构 / §11 存储 / §12 API
// L1 实现 Store/Registry/EventBus/Transport；L2 消费它们并实现 Router/Mailbox；
// L5/L6 按 ToolContext / Observer 契约实现。签名变更必须回报父 agent。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import type {
  Account,
  AccountId,
  Acl,
  Cap,
  Conversation,
  ConversationId,
  ConversationKind,
  ConversationSummary,
  CreateConversationInput,
  DeliveryId,
  DeliveryState,
  Endpoint,
  EndpointId,
  EndpointState,
  Envelope,
  Grade,
  InboxView,
  MeshEvents,
  MeshLease,
  MessageId,
  PresenceState,
  RegisterAccountInput,
  RegisterEndpointInput,
  SendInput,
  SharedObjectMeta,
  SpaceId,
  StreamTopology,
  Unsubscribe
} from "./types.js";

// ─── Store（§3.5：单一真相与单一写者）─────────────────────────────────────

export interface Store {
  /** 原始句柄（Observer 只读查询与迁移用；写路径必须走 tx） */
  readonly db: Database.Database;
  /**
   * IMMEDIATE 事务（§11.8）：BEGIN 时取写锁，SQLITE_BUSY 时整事务重试。
   * fn 内不得再嵌套 BEGIN。seq 分配 + 插消息 + 插 delivery + 计数器必须同事务。
   */
  tx<T>(fn: () => T): T;
  getMeta(k: string): string | undefined;
  setMeta(k: string, v: string): void;
  /** 计数器自增（小时桶，附录 E；与状态跃迁同一事务内调用） */
  bumpCounter(name: string, by?: number): void;
  close(): void;
}

// ─── Registry（§3.2：账号/通讯录/会话/成员的增删查 + 不变量校验）──────────

export interface MemberRow {
  accountId: AccountId;
  displayName: string;
  caps: Cap[];
  presence: PresenceState;
}

export interface ContactRow {
  accountId: AccountId;
  displayName: string;
  alias?: string;
  tags?: unknown;
}

export interface Registry {
  // ── 账号 ──
  registerAccount(a: RegisterAccountInput): Promise<Account>;
  getAccount(id: AccountId): Account | undefined;
  lookupAccounts(q: { query?: string; capabilities?: string[]; limit?: number }): Account[];
  setPresence(id: AccountId, state: PresenceState, opts?: { until?: string; reason?: string }): void;
  upsertContact(ownerId: AccountId, peerId: AccountId, opts?: { alias?: string; tags?: unknown }): void;
  listContacts(ownerId: AccountId, query?: string): ContactRow[];

  // ── 端点 ──
  registerEndpoint(e: RegisterEndpointInput): Promise<Endpoint>;
  getEndpoint(id: EndpointId): Endpoint | undefined;
  endpointsOf(accountId: AccountId): Endpoint[];
  updateEndpointState(id: EndpointId, state: EndpointState): void;
  setEndpointSession(id: EndpointId, piSessionId: string): void;
  setEndpointLease(id: EndpointId, lease: MeshLease, until: string | null): void;

  // ── 会话 ──
  /** 幂等：同一对账号恒得同一 id（§9.1 派生式 id） */
  ensureDirect(a: AccountId, b: AccountId): Promise<Conversation>;
  createConversation(c: CreateConversationInput): Promise<Conversation>;
  getConversation(id: ConversationId): Conversation | undefined;
  setTopic(conv: ConversationId, topic?: string, announcement?: string): void;
  archiveConversation(conv: ConversationId): void;

  // ── 成员（caps 校验在调用方，Registry 只落库；joinedSeq 取当前 next_seq）──
  addMember(conv: ConversationId, account: AccountId, caps: Cap[]): void;
  removeMember(conv: ConversationId, account: AccountId): void;
  getMembership(conv: ConversationId, account: AccountId): { caps: Cap[]; joinedSeq: number; mutedUntil?: string; verbatimPinned?: boolean } | undefined;
  listMembers(conv: ConversationId): MemberRow[];
  memberCount(conv: ConversationId): number;
  setCaps(conv: ConversationId, account: AccountId, caps: Cap[]): void;
  mute(conv: ConversationId, account: AccountId, until: string): void;
  /** 原文预算推导输入（§7.4）：last_spoke_seq / last_mentioned_seq 只增不减 */
  recordSpoke(conv: ConversationId, account: AccountId, seq: number): void;
  recordMentioned(conv: ConversationId, accounts: AccountId[], seq: number): void;

  // ── 订阅（topic）──
  subscribe(conv: ConversationId, account: AccountId, fromSeq: number): void;
  unsubscribe(conv: ConversationId, account: AccountId): void;
  listSubscribers(conv: ConversationId): Array<{ accountId: AccountId; fromSeq: number }>;

  // ── seq 分配（必须在 Store.tx 内调用；§11.8）──
  allocateSeq(conv: ConversationId): number;
  /** 会话当前 next_seq - 1（只读） */
  currentSeq(conv: ConversationId): number;
}

// ─── EventBus（§12.5：事件是通知不是钩子；处理器抛错不影响投递）──────────

export interface EventBus {
  emit<K extends keyof MeshEvents>(event: K, payload: MeshEvents[K]): void;
  on<K extends keyof MeshEvents>(event: K, handler: (p: MeshEvents[K]) => void): Unsubscribe;
  /** 已派发事件总数（测试用） */
  emittedCount(): number;
}

// ─── Router（§3.2：一条消息的准入与分发）─────────────────────────────────

export interface RouteInput extends SendInput {
  from: AccountId; // 宿主显式指定；Agent 工具由闭包注入（§12.2 ①）
  fromEndpoint?: EndpointId;
  /** 幂等键原料：工具层强制取 tool_call id；宿主缺省时退化为 5s 时间窗（§5.5） */
  clientToken?: string;
  /** request-response 阻塞轴（§14.5）：true ⇒ pending_acks.sync=1，参与环检测 */
  blocking?: boolean;
}

export interface Router {
  /**
   * 完整管线（§5.4 六步校验 → 同事务分配 seq/写消息/写 delivery 行(state=routed)/
   * 更新 Inbox 计数/计指标 → 发 message_routed → 触发 mailbox.fanout）。
   * reject(code) 抛 MeshRejectError；幂等命中返回原结果并计 dedup_hit。
   */
  route(input: RouteInput): Promise<{ messageId: MessageId; seq: number }>;
}

// ─── Mailbox（§3.2：未读游标、定档、折叠、投递执行）──────────────────────

export interface Mailbox {
  /** Router 事务提交后调用：逐 delivery 定档/唤醒/选端，执行投递 */
  fanout(envelope: Envelope): Promise<void>;
  /** StreamPort.onEntry 回调：镜像入库 + delivery → delivered（F5 判据） */
  handleEntryAppended(e: {
    endpointId: EndpointId;
    entryId: string;
    parentId?: string;
    envelopeId?: string;
    entryType: string;
    seqInStream: number;
    rawJson: string;
  }): void;
  /** StreamPort.onTurnEnd 回调：该轮已 delivered 的 → consumed，未读清零 */
  handleTurnEnd(endpointId: EndpointId): void;
  /** 周期清扫：parked TTL、handoff 超时回退、溢出折叠、seq 缺口超时 */
  sweep(nowMs?: number): Promise<void>;
  /** warm 成功后：该端点 parked → queued 并重投 */
  retryEndpoint(endpointId: EndpointId): Promise<void>;
  /** 账号级重投（sink handler 注册晚于投递到达等场景）：该账号 parked → queued 并重投 */
  retryAccount(accountId: AccountId): Promise<void>;
  /** I22：clearQueue 前把 delivered 未 consumed 回退为 queued */
  beforeClearQueue(endpointId: EndpointId): Promise<void>;
  /** sink/external 的消费确认（无 turn_end，§12.2 ④） */
  markConsumed(deliveryId: DeliveryId): Promise<void>;
  inboxOf(accountId: AccountId): InboxView;
  /** P2 注入体（context 钩子每次 LLM 调用前重算，不落盘） */
  inboxInjection(endpointId: EndpointId): string | null;
  /** §7.6：P2 注入完成即 delivered（无 entry_id；turn_end 再 consumed） */
  markInjectedDelivered(endpointId: EndpointId): void;
  /** 背压自持计数：该端点 queued+delivered 行数（F3） */
  inFlightCount(endpointId: EndpointId): number;

  // ── queue（§17）：claim / ack / 租约回收 ──
  /** delivered → claimed，写入 claim_until 与 payload.claim（被他人持有 → CLAIM_TAKEN；自己的已过期 → CLAIM_EXPIRED） */
  claim(messageId: MessageId, by: AccountId): Promise<{ ok: boolean; leaseUntil?: string }>;
  /** queue 确认或拒绝：成功 claimed → acked；error → nack（claimed → queued / MAX_ATTEMPTS → dropped） */
  ackQueue(messageId: MessageId, by: AccountId, error?: unknown): Promise<void>;
  /** sweep ⑤：回收过期的 claimed / delivered-claimable 租约（满足 C13） */
  reclaimExpiredClaims(nowMs?: number): Promise<void>;
}

// ─── SharedSpace（§18：共享空间持久化与 ACL，零 pi）─────────────────────

export interface SharedSpace {
  /** 读对象（含 data）；从未存在或已 del → null；version 命中读历史版本 */
  get(spaceId: SpaceId, key: string, as: AccountId, version?: number): Promise<SharedObjectMeta | null>;
  put(
    spaceId: SpaceId,
    key: string,
    data: unknown,
    opts: { as: AccountId; expectedVersion?: number; contentType?: string; acl?: Acl; ext?: unknown },
  ): Promise<{ version: number }>;
  append(
    spaceId: SpaceId,
    key: string,
    item: unknown,
    opts: { as: AccountId; maxLen?: number },
  ): Promise<{ version: number }>;
  del(spaceId: SpaceId, key: string, opts: { as: AccountId }): Promise<void>;
  list(spaceId: SpaceId, opts: { as: AccountId; keyPrefix?: string }): Promise<SharedObjectMeta[]>;
}

// ─── ToolContext（§10.2：工具执行上下文，身份由闭包注入，M6）─────────────

export type ConversationAdminOp =
  | { op: "addMember"; account: AccountId; caps?: Cap[] }
  | { op: "removeMember"; account: AccountId }
  | { op: "setCaps"; account: AccountId; caps: Cap[] }
  | { op: "setTopic"; topic?: string; announcement?: string }
  | { op: "join" }
  | { op: "leave" }
  | { op: "subscribe"; fromSeq?: number }
  | { op: "unsubscribe" }
  | { op: "dissolve" };

export interface ToolContext {
  readonly accountId: AccountId;
  readonly endpointId: EndpointId;
  send(input: SendInput & { clientToken: string }): Promise<{ messageId: MessageId; seq: number }>;
  inbox(): Promise<InboxView>;
  history(conversationId: string, opts: { beforeSeq?: number; limit?: number }): Promise<Envelope[]>;
  conversations(filter: { type?: ConversationKind; hasUnread?: boolean }): Promise<ConversationSummary[]>;
  members(conversationId: string): Promise<MemberRow[]>;
  contacts(query?: string): Promise<ContactRow[]>;
  lookup(q: { query?: string; capabilities?: string[]; limit?: number }): Promise<Account[]>;
  createConversation(input: Omit<CreateConversationInput, "creator">): Promise<Conversation>;
  conversationAdmin(conversationId: string, op: ConversationAdminOp): Promise<void>;
  /** 应答 / 队列 / 共享空间（ToolContext 面）：拒绝统一 reject，工具层转结构化错误 */
  ack(r: { correlationId: string; data?: unknown; error?: unknown }): Promise<void>;
  claim(messageId: string): Promise<{ ok: boolean; leaseUntil?: string }>;
  sharedGet(spaceId: string, key: string, version?: number): Promise<unknown>;
  sharedPut(spaceId: string, key: string, data: unknown, expectedVersion?: number): Promise<{ version: number }>;
  sharedList(spaceId: string, keyPrefix?: string): Promise<Array<{ key: string; version: number }>>;
}

// ─── 组装件（index.ts 装配用）────────────────────────────────────────────

export interface MeshComponents {
  store: Store;
  registry: Registry;
  events: EventBus;
  router: Router;
  mailbox: Mailbox;
  /** 按 endpoint 生成绑定身份的工具集（§10.1，闭包捕获 boundAccountId/boundEndpointId） */
  buildToolSet(accountId: AccountId, endpointId: EndpointId, only?: string[]): import("./types.js").ToolDefinition[];
}

export type { Grade, DeliveryState, StreamTopology };
