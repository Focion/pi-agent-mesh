// ═══════════════════════════════════════════════════════════════════════════
// Pi Agent Mesh — 包根装配入口（§12.1 createMesh + §12.2 MeshHost 全 API）。
//
// 只有一个构造函数，没有可 new 的类、没有全局单例。装配顺序即 §12.1 的四件事
// （打开 DB → 抢实例锁/端点锁 → 崩溃恢复核对 → context 钩子链尾），任何一件
// 失败就 reject，绝不返回半可用主机。
//
// 分层边界（§3.3）：本文件可以同时 import mesh-core 与 mesh-pi；mesh-core 的
// 内部模块仍是零 pi 依赖（CI 门禁 G1）。
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ALL_CAPS, capsSubsetOf, MeshRegistry, validCaps } from "./core/registry.js";
import { MeshEventBus } from "./core/events.js";
import type { StorageFaultCode } from "./core/health.js";
import { MeshMailbox } from "./core/mailbox.js";
import { MeshObserver, rowToEnvelope, type MessageRow } from "./core/observer.js";
import {
  createDefaultPolicies,
  guardClock,
  withPolicyTimeout,
  type PolicyTimeoutDeps,
} from "./core/policies.js";
import { MeshRouter } from "./core/router.js";
import { DefaultRenderer, escapeDelims } from "./core/renderer.js";
import { SharedSpace, conversationOfSpace } from "./core/shared.js";
import { SqliteStore } from "./core/store.js";
import { buildToolSet } from "./core/tools.js";
import { InProcessTransport, SameHostTransport } from "./core/transport.js";
import { isoNow, jsonParse, sleep, ulid } from "./core/util.js";
import { EndpointLock, LockHeldError } from "./pi/lock.js";
import { PiStreamPort } from "./pi/stream-port.js";
import { createAssembledSessionFactory } from "./pi/session-factory.js";
import { MeshConfigError, resolveLlmConfig } from "./pi/llm-config.js";
import type { LlmConfig, RuntimeConfig } from "./pi/llm-config.js";
import {
  DEFAULT_LIMITS,
  InvariantViolationError,
  MeshRejectError,
  MeshUnsupportedError,
} from "./core/types.js";
import type {
  AckResult,
  Account,
  AccountId,
  Cap,
  Conversation,
  ConversationChange,
  ConversationId,
  ConversationSummary,
  CreateConversationInput,
  DegradeTarget,
  Endpoint,
  EndpointId,
  Envelope,
  Limits,
  MeshEvents,
  MeshHost,
  MeshLease,
  MeshOptions,
  MeshToolName,
  Policies,
  PolicySlot,
  PortStatus,
  PresenceState,
  RegisterAccountInput,
  RegisterEndpointInput,
  SendInput,
  SessionFactory,
  SinkHandler,
  StreamTopology,
  ToolDefinition,
  Unsubscribe,
} from "./core/types.js";
import type {
  ConversationAdminOp,
  MemberRow,
  ContactRow,
  RouteInput,
  ToolContext,
} from "./core/contracts.js";

const SYSTEM_ACCOUNT = "@system";

/** N03（§9.4 加入历史注入）渲染：把加入前的消息逐条改写为 <<<MSG>>>…<<<END MSG>>>
 *  包裹块，再套 <<<HISTORY>>>…<<<END HISTORY>>> 外框。M4（§10.3 防线 1）：外来内容
 *  只在包裹体内出现，定界符与引号一律转义。不新增导出符号（包内私有助手）。 */
function renderJoinHistoryBlock(
  messages: Envelope[],
  nameOf: (id: AccountId) => string,
): string {
  const body = messages
    .map((m) => {
      const head = [
        ["seq", m.seq],
        ["from", m.from],
        ["name", nameOf(m.from)],
      ]
        .map(([k, v]) => `${k}="${escapeDelims(String(v)).replaceAll('"', "'")}"`)
        .join(" ");
      return `<<<MSG ${head}>>>\n${escapeDelims(m.payload.text ?? "")}\n<<<END MSG>>>`;
    })
    .join("\n\n");
  return (
    `<<<HISTORY kind="join">>>\nMessages sent before you joined this conversation:\n\n${body}\n<<<END HISTORY>>>`
  );
}

// ─── 宿主侧 ToolContext（§10.2：身份由闭包注入，不可伪造）─────────────────

interface ToolCtxDeps {
  accountId: AccountId;
  endpointId: EndpointId;
  registry: MeshRegistry;
  router: MeshRouter;
  mailbox: MeshMailbox;
  observer: MeshObserver;
  db: SqliteStore["db"];
  sharedSpace: SharedSpace;
  ackCorrelation(r: {
    correlationId: string;
    from: AccountId;
    endpointId?: EndpointId;
    data?: unknown;
    error?: unknown;
  }): Promise<void>;
  createConversationHost(input: CreateConversationInput): Promise<Conversation>;
  groupAdmin(conversationId: ConversationId, op: ConversationAdminOp): Promise<void>;
  /** I08：把工具读回的原文字节量折算进 verbatim_copies 统计口径（§10.2）。 */
  countVerbatim(bytes: number): void;
}

class HostToolContext implements ToolContext {
  constructor(private readonly d: ToolCtxDeps) {}

  get accountId(): AccountId {
    return this.d.accountId;
  }
  get endpointId(): EndpointId {
    return this.d.endpointId;
  }

  async send(input: SendInput & { clientToken: string }): Promise<{ messageId: string; seq: number }> {
    // §5.4：Agent 侧身份由闭包注入，不得接受入参
    const r = await this.d.router.route({
      ...input,
      from: this.d.accountId,
      fromEndpoint: this.d.endpointId,
    });
    return { messageId: r.messageId, seq: r.seq };
  }

  async inbox() {
    // I22：接上观测器的完整投影（待答、排队可领取、自身 claim、peer/verbatim/recent），
    // mailbox.inboxOf 只是简化投影（recent 空、无 claimable/myClaims），不作工具出参。
    return this.d.observer.inboxOf(this.d.accountId);
  }

  async history(
    conversationId: string,
    opts?: { beforeSeq?: number; limit?: number },
  ): Promise<Envelope[]> {
    const conv = this.d.registry.getConversation(conversationId);
    if (!conv) {
      throw new MeshRejectError("NOT_A_MEMBER", "no such conversation: " + conversationId);
    }
    // historyVisibility（§9.4）：none 全区间不可见；since_join 从加入起点起；full 全可见。
    // topic 无成员表，读权 = 订阅区间（§16）：订阅起点 from_seq 是可见性权威下界（不随
    // historyVisibility 回退到 0）。
    const vis = conv.config.historyVisibility ?? "since_join";
    if (vis === "none") throw new Error("HISTORY_FORBIDDEN");
    let lower: number;
    if (conv.kind === "topic") {
      const sub = this.d.registry
        .listSubscribers(conversationId)
        .find((s) => s.accountId === this.d.accountId);
      if (!sub) {
        throw new MeshRejectError("NOT_A_MEMBER", this.d.accountId + " is not subscribed to " + conversationId);
      }
      // from_seq 是「从此 seq 起投递」的包含下界；成员 joinedSeq 是「加入前最后一条」
      // 的排除上界。统一到 `seq > lower`（排除）口径需要 -1。
      lower = sub.fromSeq - 1;
    } else {
      const m = this.d.registry.getMembership(conversationId, this.d.accountId);
      if (!m) {
        throw new MeshRejectError("NOT_A_MEMBER", this.d.accountId + " is not a member of " + conversationId);
      }
      if (!m.caps.includes("read")) throw new Error("HISTORY_FORBIDDEN");
      lower = vis === "since_join" ? m.joinedSeq : 0;
    }
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
    let sql = "SELECT * FROM mesh_messages WHERE conversation_id = ? AND seq > ?";
    const args: unknown[] = [conversationId, lower];
    if (opts?.beforeSeq !== undefined) {
      sql += " AND seq < ?";
      args.push(opts.beforeSeq);
    }
    sql += " ORDER BY seq DESC LIMIT ?";
    args.push(limit);
    const rows = this.d.db.prepare(sql).all(...args) as MessageRow[];
    return rows.reverse().map(rowToEnvelope);
  }

  /** I08：mesh_history 读回的原文字节量 → verbatim_copies 统计口径（§10.2）。 */
  countVerbatim(bytes: number): void {
    this.d.countVerbatim(bytes);
  }

  async conversations(filter?: { type?: "direct" | "group" | "topic" | "queue"; hasUnread?: boolean }): Promise<ConversationSummary[]> {
    let list = await this.d.observer.conversationsOf(this.d.accountId);
    if (filter?.type !== undefined) list = list.filter((c) => c.kind === filter.type);
    if (filter?.hasUnread !== undefined) {
      const inbox = await this.d.observer.inboxOf(this.d.accountId);
      const unread = new Set(
        inbox.conversations.filter((c) => c.unread > 0).map((c) => c.conversationId),
      );
      list = list.filter((c) => unread.has(c.conversationId) === filter.hasUnread);
    }
    return list;
  }

  async members(conversationId: string): Promise<MemberRow[]> {
    const conv = this.d.registry.getConversation(conversationId);
    if (!conv) throw new MeshRejectError("NOT_A_MEMBER", "no such conversation: " + conversationId);
    // topic 无成员表：返回订阅者（buildMeshMembers 用它做 subscriberCount）。调用者
    // 必须先为订阅者（§16：未订阅者拿不到订阅者名单——I17）。
    if (conv.kind === "topic") {
      const subs = this.d.registry.listSubscribers(conversationId);
      if (!subs.some((s) => s.accountId === this.d.accountId)) {
        throw new MeshRejectError("NOT_A_MEMBER", this.d.accountId + " is not subscribed to " + conversationId);
      }
      return subs.map((s) => ({
        accountId: s.accountId,
        displayName: s.accountId,
        caps: [] as Cap[],
        presence: "available" as PresenceState,
      }));
    }
    const m = this.d.registry.getMembership(conversationId, this.d.accountId);
    if (!m) throw new MeshRejectError("NOT_A_MEMBER", this.d.accountId + " is not a member of " + conversationId);
    if (!m.caps.includes("read")) throw new Error("HISTORY_FORBIDDEN");
    return this.d.registry.listMembers(conversationId);
  }

  async contacts(query?: string): Promise<ContactRow[]> {
    return this.d.registry.listContacts(this.d.accountId, query);
  }

  async lookup(q: { query?: string; capabilities?: string[]; limit?: number }): Promise<Account[]> {
    return this.d.registry.lookupAccounts(q);
  }

  async createConversation(input: Omit<CreateConversationInput, "creator">): Promise<Conversation> {
    return this.d.createConversationHost({ ...input, creator: this.d.accountId });
  }

  async conversationAdmin(conversationId: string, op: ConversationAdminOp): Promise<void> {
    await this.d.groupAdmin(conversationId, op);
  }

  // ── 应答与队列（ToolContext 面；工具层把 MeshRejectError/Unsupported 转结构化错误）──

  async ack(r: { correlationId: string; data?: unknown; error?: unknown }): Promise<void> {
    return this.d.ackCorrelation({ ...r, from: this.d.accountId, endpointId: this.d.endpointId });
  }
  async claim(messageId: string): Promise<{ ok: boolean; leaseUntil?: string }> {
    return this.d.mailbox.claim(messageId, this.d.accountId);
  }
  async sharedGet(spaceId: string, key: string, version?: number): Promise<unknown> {
    const meta = await this.d.sharedSpace.get(spaceId, key, this.d.accountId, version);
    return meta?.data ?? null;
  }
  async sharedPut(
    spaceId: string,
    key: string,
    data: unknown,
    opts?: { expectedVersion?: number; contentType?: string; op?: "replace" | "append"; maxLen?: number },
  ): Promise<{ version: number }> {
    // I21：op 显式分派——append 走追加（maxLen 裁剪），否则走 CAS 替换（expectedVersion/contentType）。
    if (opts?.op === "append") {
      return this.d.sharedSpace.append(spaceId, key, data, {
        as: this.d.accountId,
        ...(opts.maxLen !== undefined ? { maxLen: opts.maxLen } : {}),
      });
    }
    return this.d.sharedSpace.put(spaceId, key, data, {
      as: this.d.accountId,
      ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
      ...(opts?.contentType !== undefined ? { contentType: opts.contentType } : {}),
    });
  }
  async sharedList(
    spaceId: string,
    opts?: { keyPrefix?: string; sinceVersion?: number; limit?: number },
  ): Promise<Array<{ key: string; version: number; updatedBy: AccountId; updatedAt: string }>> {
    const metas = await this.d.sharedSpace.list(spaceId, {
      as: this.d.accountId,
      ...(opts?.keyPrefix !== undefined ? { keyPrefix: opts.keyPrefix } : {}),
      ...(opts?.sinceVersion !== undefined ? { sinceVersion: opts.sinceVersion } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
    return metas.map((m) => ({
      key: m.key,
      version: m.version,
      updatedBy: m.updatedBy,
      updatedAt: m.updatedAt,
    }));
  }
}

// ─── createMesh（§12.1）───────────────────────────────────────────────────

/**
 * createMesh 的公共入口配置（LD1，§12.1/W00 差异）：`policies` 变为可选，新增
 * `llm`/`runtime`。`policies.sessionFactory`（高级路径）与 `llm` 二选一即可；
 * 都给时 `policies.sessionFactory` 优先，只给 `llm` 时由库按完全隔离（LD2）装配。
 * 两者皆缺 → createMesh 直接 reject。此类型只在包根，不进 core（core 保持 LLM 盲）。
 */
export type CreateMeshOptions = Omit<MeshOptions, "policies"> & {
  policies?: Partial<Policies>;
  llm?: LlmConfig;
  runtime?: RuntimeConfig;
};

/** 附录 F 通条③ / F.1 允许范围：越界值在 createMesh 直接 reject，不静默夹取。 */
function validateLimits(limits: Limits): void {
  const fail = (msg: string): never => {
    throw new Error(`mesh: invalid limits.${msg} (§F.1 允许范围)`);
  };
  const inRange = (name: string, n: number, lo: number, hi: number): void => {
    if (!Number.isInteger(n) || n < lo || n > hi) fail(`${name} = ${n} (want ${lo}..${hi})`);
  };
  inRange("maxPending", limits.maxPending, 1, 10000);
  inRange("maxPendingBytes", limits.maxPendingBytes, 4096, 4_000_000);
  inRange("maxInFlight", limits.maxInFlight, limits.maxPending, 100_000);
  inRange("verbatimGapK", limits.verbatimGapK, 0, 500);
  inRange("maxVerbatimConversations", limits.maxVerbatimConversations, 1, 20);
  const [t0, t1, t2] = limits.groupTiers;
  if (!(Number.isInteger(t0) && t0 >= 2) || !(Number.isInteger(t1) && t1 > t0) || !(Number.isInteger(t2) && t2 > t1)) {
    fail(`groupTiers = [${limits.groupTiers.join(", ")}] (want 严格递增且各值 ≥2)`);
  }
  inRange("groupSizeWarn", limits.groupSizeWarn, 2, limits.groupSizeHardCap);
  inRange("groupSizeHardCap", limits.groupSizeHardCap, limits.groupSizeWarn, 10_000);
  inRange("mentionAllCooldownMs", limits.mentionAllCooldownMs, 0, 86_400_000);
  if (!Number.isInteger(limits.wakeRateLimit.count) || limits.wakeRateLimit.count < 1)
    fail(`wakeRateLimit.count = ${limits.wakeRateLimit.count} (want ≥1)`);
  if (!Number.isInteger(limits.wakeRateLimit.windowMs) || limits.wakeRateLimit.windowMs < 1000)
    fail(`wakeRateLimit.windowMs = ${limits.wakeRateLimit.windowMs} (want ≥1000)`);
  if (!(limits.idleEvictMs === 0 || (limits.idleEvictMs >= 10000 && limits.idleEvictMs <= 86_400_000)))
    fail(`idleEvictMs = ${limits.idleEvictMs} (want 10000..86.4×10⁶ or 0)`);
  inRange("floorSkipMs", limits.floorSkipMs, 1000, 600000);
  inRange("presenceIdleMs", limits.presenceIdleMs, 10000, 86_400_000);
  inRange("seqGapTimeoutMs", limits.seqGapTimeoutMs, 100, 60000);
  inRange("ackTimeoutMs", limits.ackTimeoutMs, 1000, 3_600_000);
  inRange("replyTimeoutMs", limits.replyTimeoutMs, limits.ackTimeoutMs, 36_000_000);
  inRange("parkTtlMs", limits.parkTtlMs, 60000, 86_400_000);
  inRange("exclusiveLeaseTtlMs", limits.exclusiveLeaseTtlMs, 1000, 600000);
  inRange("claimTtlMs", limits.claimTtlMs, 1000, 3_600_000);
  inRange("requestChainMaxDepth", limits.requestChainMaxDepth, 1, 64);
  inRange("maxAttempts", limits.maxAttempts, 1, 100);
  inRange("policyTimeoutMs", limits.policyTimeoutMs, 1, 1000);
  inRange("handoffTimeoutMs", limits.handoffTimeoutMs, 1000, 600000);
  if (!(limits.sweepIntervalMs === 0 || (limits.sweepIntervalMs >= 1000 && limits.sweepIntervalMs <= 86_400_000)))
    fail(`sweepIntervalMs = ${limits.sweepIntervalMs} (want 1000..86.4×10⁶ or 0)`);
  inRange("sinkBackoffBaseMs", limits.sinkBackoffBaseMs, 1, 86_400_000);
  inRange("sinkBackoffMaxMs", limits.sinkBackoffMaxMs, limits.sinkBackoffBaseMs, 86_400_000);
  if (!(limits.outboxDoneRetentionMs === 0 || (limits.outboxDoneRetentionMs >= 60000 && limits.outboxDoneRetentionMs <= 7 * 86_400_000)))
    fail(`outboxDoneRetentionMs = ${limits.outboxDoneRetentionMs} (want 60000..7×86.4×10⁶ or 0)`);
  inRange("toolResultMaxBytes", limits.toolResultMaxBytes, 1024, 65536);
  inRange("sharedObjectMaxBytes", limits.sharedObjectMaxBytes, 1024, 4_000_000);
  inRange("sharedVersionsKept", limits.sharedVersionsKept, 0, 1000);
}

export async function createMesh(options: CreateMeshOptions): Promise<MeshHost> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const devMode = options.devMode ?? false;
  const writerId = `mesh-${randomUUID()}`;
  // 端点工作目录根：sessionFactory（缺省装配）与端点锁/PiStreamPort 共用
  const stateDir = join(dirname(options.dbPath), "mesh");

  // 附录 F 通条③：超出允许范围的值在 createMesh 时直接 reject，不做静默夹取。
  validateLimits(limits);
  // mentionAllCap 的值域 = §4.4 的七个能力位（F.2）。
  if (
    options.mentionAllCap !== undefined &&
    !(ALL_CAPS as readonly string[]).includes(options.mentionAllCap)
  ) {
    throw new Error(
      `mesh: invalid mentionAllCap "${options.mentionAllCap}" ` +
        `(must be one of §4.4 caps: ${ALL_CAPS.join(", ")})`,
    );
  }
  // 附录 F.2：busyTimeoutMs 0–60000（0 = 立即失败）。越界照通条③ reject。
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) {
    throw new Error(
      `mesh: invalid busyTimeoutMs "${options.busyTimeoutMs}" (want 0..60000, §F.2)`,
    );
  }
  // §22.4：seal key 由宿主给出、仅内存、不落库/不进日志/configFingerprint；提供即启用。
  // 必须是 non-empty string——库不自生成密钥（无 key = 默认关）。
  if (options.seal !== undefined && (typeof options.seal.key !== "string" || options.seal.key.length === 0)) {
    throw new Error("mesh: options.seal.key must be a non-empty string (§22.4)");
  }
  // §19 投递搬运：默认 InProcessTransport（单进程直派）；可传 SameHostTransport
  // （同机多进程 outbox，§19.3）。宿主传入的其它 Transport 实现将直接使用（不做校验收敛）。
  if (options.transport !== undefined && options.transport !== "sameHost") {
    // 自定义 Transport 实现：由宿主自管生命周期，不在此启动 poller
  }

  // ── sessionFactory 装配（LD1）：policies.sessionFactory 高级路径优先；
  // 否则由 llm/runtime 缺省装配（完全隔离，LD2）；两者皆无 → fail-fast（§12.1 差异）。
  // 在打开 DB 之前完成：配置非法（缺凭据/坏模型/坏 api）即 reject，绝不半可用。
  const policySessionFactory = options.policies?.sessionFactory;
  let assembledSessionFactory: SessionFactory | undefined;
  if (policySessionFactory === undefined && options.llm !== undefined) {
    assembledSessionFactory = await createAssembledSessionFactory({
      stateDir,
      llm: resolveLlmConfig(options.llm),
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    });
  }
  if (policySessionFactory === undefined && assembledSessionFactory === undefined) {
    // W01 冻结：结构化 MeshConfigError（统一错误码表），不再抛字面 Error。
    throw new MeshConfigError(
      "MESH_NO_SESSION_SOURCE",
      "createMesh requires either policies.sessionFactory or llm configuration (§12.1)",
    );
  }
  const sessionFactory: SessionFactory = (policySessionFactory ?? assembledSessionFactory)!;

  // §19.3：sameHost（多进程同机）下 N 个进程合法共享同一 dbPath；单进程则严格排他。
  const useSameHost =
    options.transport === "sameHost" || options.transport instanceof SameHostTransport;
  // §27.4 / M-R10：接管前必须验证持锁者 pid 真的不存在（kill -0 + 启动时刻），才回收陈旧锁。
  const recoverDead = options.recoverDeadEndpoints === true;

  // ① 先抢实例锁（M3：单实例排他；sameHost 下多进程附着），再开 DB（迁移）——
  // I05：迁移早于实例锁是缺陷，跨进程并发打开同一 dbPath 会竞争迁移。抢锁只需 dbPath，
  // 失败时库尚未创建，无需清理。
  let instanceLock: EndpointLock | undefined;
  // I04：启动回收时无法判定（损坏/不可读）的端点锁，待事件总线就绪后统一发 invariant_violated 告警
  const undeterminedEndpoints: string[] = [];
  if (options.dbPath !== ":memory:") {
    // recoverDeadEndpoints：先回收死写者遗留的实例锁（单进程崩溃后 .instance.lock 残留会挡住重启）。
    if (recoverDead && !useSameHost) {
      const instPath = options.dbPath + ".instance.lock";
      if ((await EndpointLock.ownerIsLive(instPath)) === "dead") {
        await EndpointLock.forceRelease(instPath);
      }
    }
    instanceLock = await EndpointLock.acquire(options.dbPath + ".instance.lock", {
      writerId,
      lease: "shared",
      mode: useSameHost ? "multi" : "single",
    });
  }

  // ② 打开 DB（WAL/busy_timeout/迁移/FTS 对账/存储初检）。
  let store: SqliteStore;
  try {
    store = SqliteStore.open(options.dbPath, {
      devMode,
      busyTimeoutMs,
      fts: options.fts ?? true,
      walMaxBytes: options.walMaxBytes,
    });
  } catch (err) {
    await instanceLock?.release();
    throw err;
  }

  // ③ 端点锁回收/探测（需迁移后的 mesh_endpoints）。单进程形态下任何已注册端点的锁
  // 被他人持有 ⇒ 拒绝启动（§8.4①权威顺序靠它）；sameHost 下跳过——端点归属唯一进程
  // （§19.4），他人持有端点锁是常态，单写者由 warm 时的 acquire 兜底。
  if (options.dbPath !== ":memory:") {
    try {
      // I04：只处理 stream 端点的锁（sink/external 无本地流、无锁，不在回收/探测范围）
      const endpointIds = (store.db
        .prepare<[], { id: string }>(
          "SELECT e.id FROM mesh_endpoints e JOIN mesh_accounts a ON a.id = e.account_id WHERE a.endpoint_class = 'stream'",
        )
        .all() as Array<{ id: string }>).map((r) => r.id);

      // recoverDeadEndpoints：回收死写者遗留的端点锁，暖化不被陈旧锁卡死（M-R10 唯一合法自动回收）。
      // I04：只有五态里的 "dead"（pid 不存在 / 启动时刻不符）才回收；损坏/不可读 → 保持 unavailable 并告警。
      if (recoverDead) {
        for (const id of endpointIds) {
          const lockPath = join(stateDir, "locks", `${id}.lock`);
          const verdict = await EndpointLock.ownerIsLive(lockPath);
          if (verdict === "dead") {
            await EndpointLock.forceRelease(lockPath);
            store.db.prepare("UPDATE mesh_endpoints SET lock_path = NULL WHERE id = ?").run(id);
          } else if (verdict === "unknown") {
            undeterminedEndpoints.push(id);
          }
        }
      }
      if (!useSameHost) {
        for (const id of endpointIds) {
          const probe = await EndpointLock.acquire(join(stateDir, "locks", `${id}.lock`), { writerId });
          await probe.release();
        }
      }
    } catch (err) {
      store.close();
      await instanceLock?.release();
      throw err;
    }
  }

  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  // I04：无法判定的端点锁（损坏/不可读）——保持 unavailable 并告警，绝不猜（§19.6）
  for (const id of undeterminedEndpoints) {
    events.emit("invariant_violated", { code: "endpoint_lock_undetermined", detail: { endpointId: id } });
    store.bumpCounter("invariant_violated");
  }
  // I34：存储故障执行链——store 检测 → 告警（invariant_violated 事件 + 同名计数器，
  // §12.5 末/§23.3）。打开期检测早于本处装配，guard 会缓冲并在 setSink 时重放。
  store.health.setSink({
    onFault: (code, detail) => {
      events.emit("invariant_violated", { code: "storage:" + code, detail });
      store.bumpCounter("invariant_violated");
    },
  });
  // §19 Transport：默认 InProcess，调用方传 SameHostTransport 实例或用 "sameHost" 字符串创建
  const transport =
    options.transport === "sameHost"
      ? new SameHostTransport(store.db, writerId, options.transportOptions)
      : options.transport instanceof SameHostTransport
        ? options.transport
        : (options.transport ?? new InProcessTransport());
  // C02（§12.1）：自定义 Transport 必须在运行期证成 publish/subscribe/ack 三能力，缺任一即拒绝启用（不静默缺失）
  if (
    typeof (transport as { publish?: unknown }).publish !== "function" ||
    typeof (transport as { subscribe?: unknown }).subscribe !== "function" ||
    typeof (transport as { ack?: unknown }).ack !== "function"
  ) {
    throw new MeshConfigError(
      "MESH_BAD_CONFIG",
      "custom Transport must implement publish/subscribe/ack (§12.1)",
    );
  }

  // 策略装配：九个槽八个默认，sessionFactory 必填（§12.1 类型层已保证）
  let mailbox!: MeshMailbox;
  let router!: MeshRouter;

  // 端口级降级 → 告警事件。规范 §8.3 文字写「发 policy_degraded」，但载荷以策略槽
  // 为键，端口级原因（租约超时/钩子缺失）无对应槽；改走同属「必订」告警事件的
  // invariant_violated（§12.5 末），语义更贴切（库已不在正常状态运行）。
  const onPortDegraded = (info: { reason: string; endpointId: EndpointId }): void => {
    events.emit("invariant_violated", { code: info.reason, detail: { endpointId: info.endpointId } });
    // §23.3：invariant_violated 是“必须 0”的告警计数器，与上面的同名事件同源撞击。
    store.bumpCounter("invariant_violated");
    // §8.3/§19.4：exclusive 租约到期释放后，窗口内 parked(LEASE_HELD) 的投递应回 queued 重投
    if (info.reason === "lease_ttl_expired") {
      void mailbox?.retryEndpoint(info.endpointId);
    }
  };

  const setEndpointState = (id: EndpointId, state: Endpoint["state"]): void => {
    const prev = registry.getEndpoint(id)?.state;
    registry.updateEndpointState(id, state);
    if (prev && prev !== state) {
      events.emit("endpoint_state_changed", { endpointId: id, from: prev, to: state });
    }
  };

  const hasUnconsumed = (id: EndpointId): boolean => {
    const row = store.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM mesh_deliveries WHERE endpoint_id = ? AND state = 'delivered'",
      )
      .get(id);
    return (row?.n ?? 0) > 0;
  };

  const awaitingCorrelations = (accountId: AccountId): string[] =>
    (store.db
      .prepare<[string], { correlation_id: string }>(
        "SELECT correlation_id FROM mesh_pending_acks WHERE to_account = ? AND state = 'open'",
      )
      .all(accountId) as Array<{ correlation_id: string }>).map((r) => r.correlation_id);

  const isAwaiting = (accountId: AccountId, correlationId: string | undefined): boolean => {
    if (correlationId === undefined) return false;
    return (
      store.db
        .prepare<[string, string], { n: number }>(
          "SELECT COUNT(*) AS n FROM mesh_pending_acks WHERE correlation_id = ? AND to_account = ? AND state = 'open'",
        )
        .get(correlationId, accountId)?.n ?? 0
    ) > 0;
  };

  const endpointsOf = (acct: AccountId): Array<{ id: EndpointId; inFlight: number; topology: StreamTopology }> =>
    registry.endpointsOf(acct).map((e) => ({ id: e.id, inFlight: mailbox ? mailbox.inFlightCount(e.id) : 0, topology: e.topology }));

  const defaults = createDefaultPolicies({ isAwaiting, endpointsOf, limits });
  const policies: Policies = {
    ...defaults,
    ...(options.policies ?? {}),
    sessionFactory,
  };

  // ⑤ 逻辑钟守卫（N05）：clock 槽走 withPolicyGuard 降级墙钟（degradedTo="wallclock"）；
  // renderer 缺省时用守卫后的钟显示时间（§20.1⑨）。
  policies.clock = guardClock(policyDeps("clock", "wallclock"), policies.clock);
  const safeClock = policies.clock;
  if (options.policies?.renderer === undefined) {
    policies.renderer = new DefaultRenderer(safeClock);
  }

  // P2 注入刷新（§7.6 I23）：port.injectContext 追加在扩展链尾，文本变化时重装
  const injectionUnsub = new Map<EndpointId, Unsubscribe>();
  const injectionText = new Map<EndpointId, string>();
  /** sameHost（§19.3）：transport.subscribe 的退订句柄，evict 时清理 */
  const transportSubs = new Map<EndpointId, Unsubscribe>();
  function refreshInjection(endpointId: EndpointId): void {
    try {
      if (port.status(endpointId).state !== "hot") return; // 冷流不装，warm 时再装
      const text = mailbox.inboxInjection(endpointId);
      if (text === null) {
        // I09：空摘要（无 P2 未读）清除旧 hook，不确认（无实际集合可确认）。
        injectionUnsub.get(endpointId)?.();
        injectionUnsub.delete(endpointId);
        injectionText.delete(endpointId);
        return;
      }
      if (injectionText.get(endpointId) === text) return;
      injectionUnsub.get(endpointId)?.();
      injectionUnsub.set(endpointId, port.injectContext(endpointId, text));
      injectionText.set(endpointId, text);
      // I09：不再「装 hook 即确认」——确认由 injectContext 的 context_with_system 观测器
      // 在真实某轮最终输入时回调 onInjectionConfirmed → mailbox.confirmInjection。
    } catch {
      // 注入失败不阻断投递（§12.5）
    }
  }

  const port = options.streamPort ?? new PiStreamPort({
    writerId,
    // I01：同一 writerId 贯穿「实例锁 / isEndpointLocal / 端点锁」，自动 warm（ensureHot）
    // 与显式 warm 完成后都经此处注册本进程 outbox handler，异进程发来的条目有处可投。
    onWarmed: (endpointId) => {
      if (transport instanceof SameHostTransport) {
        transportSubs.set(
          endpointId,
          transport.subscribe(endpointId, (pd) => mailbox.handleOutboxDelivery(pd)),
        );
      }
    },
    sessionFactory: policies.sessionFactory,
    getEndpoint: (id) => registry.getEndpoint(id),
    getAccount: (id) => registry.getAccount(id),
    buildTools: (endpointId) => {
      const ep = registry.getEndpoint(endpointId);
      if (!ep) return [];
      return buildToolSet(makeToolContext(ep.accountId, endpointId), undefined, { devMode, clock: safeClock, maxBytes: limits.toolResultMaxBytes });
    },
    setEndpointState,
    setEndpointSession: (id, sid) => registry.setEndpointSession(id, sid),
    setEndpointLease: (id, lease, until) => registry.setEndpointLease(id, lease, until),
    setEndpointLock: (id, p) => registry.setEndpointLock(id, p),
    hasUnconsumed,
    stateDir,
    exclusiveLeaseTtlMs: limits.exclusiveLeaseTtlMs,
    idleEvictMs: limits.idleEvictMs,
    devMode,
    onDegraded: onPortDegraded,
    onInjectionConfirmed: (id) => mailbox.confirmInjection(id),
    onPolicyDegraded: (info) =>
      policyDeps("sessionFactory", "unrecoverable").onDegraded(
        info.reason,
        "sessionFactory",
        info.degradedTo,
      ),
  });

  // C10（§12.1）：自定义 StreamPort 必须在运行期证成全部 10 个能力，缺任一即拒绝启用
  // （不静默缺失）——否则 note/injectContext/hasEntries/onTurnEnd 等静默丢投递或漏对账。
  if (options.streamPort) {
    const SP_METHODS = [
      "warm", "evict", "deliver", "nudge", "note",
      "injectContext", "status", "hasEntries", "onEntry", "onTurnEnd",
    ] as const;
    for (const m of SP_METHODS) {
      if (typeof (port as unknown as Record<string, unknown>)[m] !== "function") {
        throw new MeshConfigError(
          "MESH_BAD_CONFIG",
          `custom StreamPort must implement ${m} (§12.1)`,
        );
      }
    }
  }

  if (options.streamPort && !(options.streamPort instanceof PiStreamPort)) {
    // §12.1：自定义 StreamPort 使 replay(§23.2) / 崩溃恢复双向核对(§8.4) /
    // .lock 单写者(M3) 三项保证失效，启动时降级并警告。
    console.warn(
      "[pi-agent-mesh] custom StreamPort: replay / crash-recovery dual-check / .lock " +
        "single-writer guarantees are degraded (§2.4)",
    );
  }

  // I24（§15.2）：在场派生接入端口状态源（端口在 registry 之后构建，延后注入）
  registry.setDeriveStatus((accountId) => {
    const hot = registry
      .endpointsOf(accountId)
      .filter((e) => e.state === "hot");
    if (hot.length === 0) return { busy: false };
    let busy = false;
    let idleMs: number | undefined;
    for (const ep of hot) {
      let st: PortStatus;
      try {
        st = port.status(ep.id);
      } catch {
        continue;
      }
      if (st.busy) busy = true;
      if (st.idleMs !== undefined && (idleMs === undefined || st.idleMs > idleMs)) {
        idleMs = st.idleMs;
      }
    }
    return { busy, idleMs };
  });

  const sinkHandlers = new Map<AccountId, SinkHandler>();

  // ③ 崩溃恢复核对（§8.4）：以 deliveries 为真相重算收件箱缓存（派生缓存可重建）。
  store.recomputeInboxCaches();

  /** sameHost（§19.3）：端点锁 writerId 与本进程匹配 ⇒ 本进程直派；否则走 outbox */
  const isEndpointLocal = async (endpointId: EndpointId): Promise<boolean> => {
    // 单进程 InProcessTransport 恒为 true（无锁探测必要）
    if (!(transport instanceof SameHostTransport)) return true;
    try {
      // 归属真相（§19.4）：warm 时落库的 lock_path；他进程托管的 external 账号恒不走本进程直派。
      const row = store.db
        .prepare<[string], { lock_path: string | null; account_id: string }>(
          "SELECT lock_path, account_id FROM mesh_endpoints WHERE id = ?",
        )
        .get(endpointId);
      if (row) {
        const acct = registry.getAccount(row.account_id);
        if (acct && acct.endpointClass !== "stream") return false;
      }
      const lockPath = row?.lock_path ?? join(stateDir, "locks", `${endpointId}.lock`);
      const inspected = await EndpointLock.inspect(lockPath);
      if (inspected.status === "missing") {
        // 无锁文件且 lock_path 空＝从未归属 ⇒ 本进程可 warm（O_EXCL 兜底单写者）。
        // lock_path 已落库但文件消失（owner 崩溃残留）⇒ 保守判他进程，交 outbox，等运维 reclaim。
        return !row?.lock_path;
      }
      if (inspected.status === "corrupted" || inspected.status === "unreadable") {
        // I04：读不出归属 → 保守判非本地（走 outbox），不猜（§19.6）
        return false;
      }
      return inspected.info.writerId === writerId;
    } catch {
      return true; // 读不到锁信息时保守视为本进程
    }
  };

  mailbox = new MeshMailbox({
    store,
    registry,
    events,
    policies,
    limits,
    transport,
    isEndpointLocal,
    port,
    sinkHandlers,
    awaitingCorrelations,
    clock: safeClock,
    sealKey: options.seal?.key,
    systemSend: async ({ to, conversationId, text, clientToken }) =>
      router.route({
        from: SYSTEM_ACCOUNT,
        conversationId,
        to: [to],
        kind: "system",
        expect: "none",
        text,
        clientToken,
      }),
    devMode,
  });

  port.onEntry((e) => mailbox.handleEntryAppended(e));
  port.onTurnEnd((e) => {
    mailbox.handleTurnEnd(e.endpointId);
    refreshInjection(e.endpointId);
  });

  // ③ 崩溃恢复核对（§8.4）：在端口 wiring 之后对「已投未确认」的 P1 行按 entry_id 对
  // 真实 session 双向核对（在→consumed(partial)，不在→queued 重投，拿不到 session→
  // park+告警）。冷端点由 sweep / warm 触发对账，启动此处仅核对已 hot 的（FakeStreamPort
  // 默认 hot，e2e 重启测试据此断言）；重投走 deliverOne → port.deliver 同步回吐 entry，
  // 故必须在 onEntry 接好之后。
  await mailbox.reconcileDelivered();

  // sameHost（§19.3）：启动 outbox poller（启动时先回收一轮 stale claimed，再周期轮询）
  if (transport instanceof SameHostTransport) transport.start();

  router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits,
    devMode,
    mentionAllCap: options.mentionAllCap,
    sealKey: options.seal?.key,
    onRouted: async (envelope) => {
      await mailbox.fanout(envelope);
      // fanout 后刷新受影响端点的 P2 注入（未读摘要可能已变化）
      const ids = store.db
        .prepare<[string], { endpoint_id: string | null }>(
          "SELECT DISTINCT endpoint_id FROM mesh_deliveries WHERE message_id = ? AND endpoint_id IS NOT NULL",
        )
        .all(envelope.id) as Array<{ endpoint_id: string | null }>;
      for (const r of ids) if (r.endpoint_id) refreshInjection(r.endpoint_id);
    },
    isAwaiting,
  });

  await mailbox.sweep();

  // N01：周期清扫定时器（§7.5/§7.9/§14.3/§17.2 都由 sweep 驱动）。守卫防重入：
  // 上一轮未结束则跳过本轮，满足「调度不重叠」；.unref() 让定时器不拖住进程退出。
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweepBusy = false;
  if (limits.sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      if (sweepBusy) return;
      sweepBusy = true;
      mailbox
        .sweep()
        .catch(() => {
          // sweep 内部单步失败不影响下一轮；错误已在各步内 emit/计数。
        })
        .finally(() => {
          sweepBusy = false;
        });
    }, limits.sweepIntervalMs);
    sweepTimer.unref?.();
  }

  const observer = new MeshObserver({
    store,
    registry,
    limits,
    clock: safeClock,
    // I25（C10）：活 owner 判定注入（core 零 pi）——pid + 启动时刻双判据，见 EndpointLock.ownerIsLive。
    lockLiveness: (p) => EndpointLock.ownerIsLive(p),
  });

  // ── SharedSpace（§18）────────────────────────────────────────────────────

  const sharedSpace = new SharedSpace({
    db: store.db,
    registry,
    events,
    accessControl: policies.accessControl,
    limits,
    store,
    notify: async (spaceId, key, version, by, op) => {
      const convId = conversationOfSpace(spaceId);
      if (!convId) return;
      void router
        .route({
          from: SYSTEM_ACCOUNT,
          conversationId: convId,
          kind: "event",
          expect: "none",
          payload: { data: { op, key, version, by } },
          clientToken: `shared-${spaceId}-${key}-${version}`,
        })
        .catch(() => {
          /* best-effort */
        });
    },
  });

  // ── 会话 / 成员编排（§9 §13）：Registry 只落库，这里的校验与事件是宿主面 ──

  function requireConv(conv: ConversationId): Conversation {
    const c = registry.getConversation(conv);
    if (!c) throw new MeshRejectError("NOT_A_MEMBER", "no such conversation: " + conv);
    return c;
  }

  function requireGroup(conv: ConversationId): Conversation {
    const c = requireConv(conv);
    if (c.kind !== "group") throw new Error("ARG_INVALID");
    return c;
  }

  /** 宿主代行身份（§12.2 ①/C04）：@system 库代行可信；非成员 by 显式拒绝（不隐式放权） */
  function requireMemberCap(conv: ConversationId, by: AccountId, cap: Cap): void {
    if (by === SYSTEM_ACCOUNT) return; // 库内部代行（system 消息等）豁免
    const m = registry.getMembership(conv, by);
    if (!m) throw new MeshRejectError("NOT_A_MEMBER", by + " is not a member of " + conv);
    if (!m.caps.includes(cap)) throw new MeshRejectError("CAP_REQUIRED", by + " lacks " + cap + " in " + conv);
  }

  /** I8（§4.4）：授出的 caps 必须是授予者自身 caps 的子集；非成员授予者显式拒绝（C04） */
  function assertSubsetCaps(conv: ConversationId, by: AccountId, granted: Cap[]): void {
    if (by === SYSTEM_ACCOUNT) return;
    const m = registry.getMembership(conv, by);
    if (!m) throw new MeshRejectError("NOT_A_MEMBER", by + " is not a member of " + conv);
    if (!capsSubsetOf(granted, m.caps)) throw new MeshRejectError("CAP_REQUIRED", by + " cannot grant caps beyond own set");
  }

  /**
   * §12.2:1651（I18）：最后 setCaps 持有者不得退出/被移除/被降权。
   * targetWillHoldSetCaps = 操作后 target 是否仍持 setCaps（remove/leave 传 false；
   * setCaps 传新 caps 是否含 setCaps）。唯一成员退出（空群）不在此约束内。
   */
  function assertNotLastAdmin(
    conv: ConversationId,
    target: AccountId,
    targetWillHoldSetCaps: boolean,
  ): void {
    const m = registry.getMembership(conv, target);
    if (!m || !m.caps.includes("setCaps")) return; // 目标本就不持 setCaps
    if (targetWillHoldSetCaps) return;
    const others = registry
      .listMembers(conv)
      .filter((x) => x.accountId !== target);
    if (others.length === 0) return; // 唯一成员退出 → 空群
    if (others.some((x) => x.caps.includes("setCaps"))) return;
    throw new MeshRejectError(
      "NO_ADMIN_LEFT",
      "last setCaps holder must grant before leaving / being demoted",
    );
  }

  function emitConvChanged(conv: ConversationId, change: ConversationChange): void {
    events.emit("conversation_changed", { conversationId: conv, change });
  }

  function emitSystem(conv: ConversationId, text: string): Promise<unknown> {
    return router.route({ from: SYSTEM_ACCOUNT, conversationId: conv, kind: "system", expect: "none", text });
  }

  /** N03（§9.4 加入历史注入）：仅 historyVisibility:"full" 且 maxHistoryOnJoin>0 时，
   *  把加入前的 ≤N 条消息经 port.deliver 注入到新成员的「热」端点（合成 envelope，不产
   *  mesh_messages / mesh_deliveries 行）。冷端点不 warm（成本守 §9.4「注入是成本」）。 */
  async function injectJoinHistory(c: Conversation, account: AccountId): Promise<void> {
    const vis = c.config.historyVisibility ?? "since_join";
    const max = c.config.maxHistoryOnJoin ?? 0;
    if (vis !== "full" || max <= 0) return;
    const membership = registry.getMembership(c.id, account);
    if (!membership) return;
    const rows = store.db
      .prepare<[string, number, number], MessageRow>(
        "SELECT * FROM mesh_messages WHERE conversation_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?",
      )
      .all(c.id, membership.joinedSeq, max) as MessageRow[];
    if (rows.length === 0) return;
    const block = renderJoinHistoryBlock(
      rows.reverse().map(rowToEnvelope),
      (id) => registry.getAccount(id)?.displayName ?? id,
    );
    const synEnv: Envelope = {
      id: ulid(),
      seq: membership.joinedSeq,
      from: SYSTEM_ACCOUNT,
      fromEndpoint: null,
      routedAt: isoNow(),
      idempotencyKey: `mesh:join-history:${ulid()}`,
      conversationId: c.id,
      kind: "chat",
      expect: "none",
      payload: { text: "" },
    };
    for (const ep of registry.endpointsOf(account)) {
      if (port.status(ep.id).state !== "hot") continue;
      try {
        await port.deliver(ep.id, block, synEnv, "followUp", { triggerTurn: false });
      } catch {
        // 注入失败不阻断加入；加入本身已落库。
      }
    }
  }

  async function createConversationHost(input: CreateConversationInput): Promise<Conversation> {
    const conv = await registry.createConversation(input);
    if (input.type === "group") {
      emitConvChanged(input.creator ? conv.id : conv.id, {
        op: "group_created",
        by: input.creator,
      });
      await emitSystem(conv.id, `conversation created (${input.type}) by ${input.creator}`);
    }
    return conv;
  }

  async function groupAddMember(
    conv: ConversationId,
    account: AccountId,
    opts: { caps?: Cap[]; by?: AccountId } = {},
  ): Promise<void> {
    const c = requireGroup(conv);
    const by = opts.by ?? SYSTEM_ACCOUNT;
    if (!registry.getAccount(account)) throw new MeshRejectError("NOT_A_MEMBER", "unknown account: " + account);
    if (registry.getMembership(conv, account)) return; // 幂等
    const hardCap = c.config.groupSizeHardCap ?? limits.groupSizeHardCap;
    if (registry.memberCount(conv) >= hardCap) throw new MeshRejectError("FANOUT_TOO_LARGE", "group size hard cap reached");
    const caps: Cap[] = validCaps(opts.caps) ? (opts.caps as Cap[]) : ["speak", "read"];
    requireMemberCap(conv, by, "invite");
    assertSubsetCaps(conv, by, caps);
    registry.addMember(conv, account, caps);
    await injectJoinHistory(c, account);
    emitConvChanged(conv, { op: "member_joined", by, target: account });
    await emitSystem(conv, `${by} added ${account}`);
  }

  async function groupRemoveMember(conv: ConversationId, account: AccountId, by: AccountId): Promise<void> {
    requireGroup(conv);
    const m = registry.getMembership(conv, account);
    if (!m) return;
    requireMemberCap(conv, by, "remove");
    // §12.2:1633（I18）：移除持 setCaps 的目标，调用者还须持 dissolve
    if (m.caps.includes("setCaps")) requireMemberCap(conv, by, "dissolve");
    assertNotLastAdmin(conv, account, false);
    registry.removeMember(conv, account);
    emitConvChanged(conv, { op: "member_removed", by, target: account });
    await emitSystem(conv, `${by} removed ${account}`);
  }

  async function groupJoin(conv: ConversationId, account: AccountId): Promise<void> {
    const c = requireGroup(conv);
    if (!c.config.openJoin) throw new MeshRejectError("JOIN_DENIED", "openJoin is disabled");
    if (!registry.getAccount(account)) throw new MeshRejectError("NOT_A_MEMBER", "unknown account: " + account);
    if (registry.getMembership(conv, account)) return;
    const acc = registry.getAccount(account)!;
    const allowed = await withPolicyTimeout(
      policyDeps("accessControl", "deny"),
      () => {
        const hook = policies.accessControl.canJoin;
        if (!hook) return true; // 钩子缺失 → 放行（默认 AllowAll 恒真）
        return hook(c, acc);
      },
      false,
      (v) => typeof v === "boolean", // 返回 undefined / 其它类型 → 非法 → deny（§22.5 fail-closed）
    );
    if (!allowed) throw new MeshRejectError("JOIN_DENIED", "canJoin denied");
    registry.addMember(conv, account, ["speak", "read"]);
    await injectJoinHistory(c, account);
    emitConvChanged(conv, { op: "member_joined", by: account, target: account });
    await emitSystem(conv, `${account} joined`);
  }

  async function groupLeave(conv: ConversationId, account: AccountId): Promise<void> {
    requireGroup(conv);
    const m = registry.getMembership(conv, account);
    if (!m) return;
    // 最后一个 setCaps 持有者离开前须先授出（§12.2:1651：reject NO_ADMIN_LEFT）
    assertNotLastAdmin(conv, account, false);
    registry.removeMember(conv, account);
    emitConvChanged(conv, { op: "member_left", by: account, target: account });
    await emitSystem(conv, `${account} left`);
  }

  async function groupSetCaps(conv: ConversationId, account: AccountId, caps: Cap[], by: AccountId): Promise<void> {
    requireGroup(conv);
    if (!validCaps(caps)) throw new Error("CAP_REQUIRED");
    requireMemberCap(conv, by, "setCaps");
    assertSubsetCaps(conv, by, caps);
    if (!registry.getMembership(conv, account)) throw new MeshRejectError("NOT_A_MEMBER", account + " is not a member");
    // 不得移走最后 setCaps 持有者的 setCaps（§12.2:1651）
    assertNotLastAdmin(conv, account, caps.includes("setCaps"));
    registry.setCaps(conv, account, caps);
    events.emit("membership_caps_changed", { conversationId: conv, accountId: account, caps });
    emitConvChanged(conv, { op: "caps_changed", by, target: account });
    await emitSystem(conv, `${by} changed caps of ${account}`);
  }

  async function groupSetTopic(
    conv: ConversationId,
    by: AccountId,
    topic?: string,
    announcement?: string,
  ): Promise<void> {
    requireConv(conv);
    requireMemberCap(conv, by, "setTopic");
    registry.setTopic(conv, topic, announcement);
    if (topic !== undefined) {
      emitConvChanged(conv, { op: "topic_changed", by });
      await emitSystem(conv, `${by} set topic`);
    }
    if (announcement !== undefined) {
      emitConvChanged(conv, { op: "announcement_changed", by });
    }
  }

  async function groupMute(conv: ConversationId, account: AccountId, until: string): Promise<void> {
    requireGroup(conv);
    registry.mute(conv, account, until);
    emitConvChanged(conv, { op: "muted", by: account, target: account }); // 不发 system 消息
  }

  async function groupDissolve(conv: ConversationId, by: AccountId): Promise<void> {
    requireGroup(conv);
    requireMemberCap(conv, by, "dissolve");
    await emitSystem(conv, `${by} dissolved the conversation`); // 先 system 后归档（Router 拒投已归档会话）
    registry.archiveConversation(conv);
    await mailbox.abandonConversation(conv); // §14.4：open pending_acks → abandoned（静默）+ 释放 exclusive
    emitConvChanged(conv, { op: "group_dissolved", by });
  }

  async function upgradeToGroup(directConv: ConversationId, extra: AccountId[], by: AccountId): Promise<Conversation> {
    const c = requireConv(directConv);
    if (c.kind !== "direct") throw new Error("ARG_INVALID");
    const directMembers = registry.listMembers(directConv).map((x) => x.accountId);
    const members = Array.from(new Set([...directMembers, by, ...extra]));
    const g = await registry.createConversation({ type: "group", creator: by, members, topic: c.topic });
    emitConvChanged(g.id, { op: "upgraded", by, detail: { from: directConv } });
    await emitSystem(g.id, `group upgraded from direct ${directConv}`);
    return g;
  }

  function policyDeps(slot: PolicySlot, degradedTo: DegradeTarget): PolicyTimeoutDeps {
    return {
      slot,
      timeoutMs: limits.policyTimeoutMs,
      degradedTo,
      onDegraded: (reason, s, d) => {
        events.emit("policy_degraded", { slot: s, reason, degradedTo: d });
        store.bumpCounter("policy_degraded");
      },
    };
  }

  // ── ack 编排（§14.6）─────────────────────────────────────────────────────

  async function ackCorrelation(r: {
    correlationId: string;
    from: AccountId;
    endpointId?: EndpointId;
    data?: unknown;
    error?: unknown;
  }): Promise<void> {
    const pa = store.db
      .prepare<
        [string],
        {
          message_id: string;
          conversation_id: string;
          to_account: string;
          state: string;
        }
      >(
        "SELECT message_id, conversation_id, to_account, state FROM mesh_pending_acks WHERE correlation_id = ?",
      )
      .get(r.correlationId) as
      | {
          message_id: string;
          conversation_id: string;
          to_account: string;
          state: string;
        }
      | undefined;
    if (!pa) throw new MeshRejectError("NO_SUCH_CORRELATION", "unknown correlation: " + r.correlationId);
    // C06：身份校验优先于幂等——非目标对已应答 id 的重复 ack 必须拒绝，不伪装成功
    if (pa.to_account !== r.from) throw new MeshRejectError("NO_SUCH_CORRELATION", "not the expected ack target for " + r.correlationId);
    if (pa.state === "abandoned") throw new MeshRejectError("ACK_CLOSED", "correlation already abandoned: " + r.correlationId);
    if (pa.state === "answered") return; // 幂等（目标正确才幂等）

    const conv = registry.getConversation(pa.conversation_id);
    const isQueue = conv?.kind === "queue";

    // 超时后到达的 late ack：best-effort 投应答，不回退 pending_acks 状态
    if (pa.state === "timeout") {
      if (!isQueue) {
        const row = store.db
          .prepare<[string], { kind: string }>("SELECT kind FROM mesh_messages WHERE id = ?")
          .get(pa.message_id) as { kind: string } | undefined;
        void router
          .route({
            from: r.from,
            conversationId: pa.conversation_id,
            correlationId: r.correlationId,
            kind: (row?.kind ?? "chat") as RouteInput["kind"],
            expect: "none",
            payload: buildAckPayload(r.data, r.error),
            clientToken: "late-ack-" + r.correlationId,
          })
          .catch(() => {
            /* best-effort late delivery */
          });
      }
      return;
    }

    if (isQueue) {
      if (r.error !== undefined) {
        // queue nack：claimed → queued，pending_acks 保持 open
        await mailbox.ackQueue(pa.message_id, r.from, r.error);
        events.emit("message_acked", {
          correlationId: r.correlationId,
          endpointId: r.endpointId ?? "",
          ok: false,
          detail: { error: r.error },
        });
        return;
      }
      // queue ack：claimed → acked（ackQueue 同事务闭合 delivery→acked + pending→answered + 前移 cursorSeq，§17.6）
      await mailbox.ackQueue(pa.message_id, r.from);
      events.emit("message_acked", {
        correlationId: r.correlationId,
        endpointId: r.endpointId ?? "",
        ok: true,
        detail: r.data !== undefined ? { data: r.data } : undefined,
      });
      return;
    }

    // request-response ack：逐应答消息 + 标记 pending_acks answered
    const row = store.db
      .prepare<[string], { kind: string }>("SELECT kind FROM mesh_messages WHERE id = ?")
      .get(pa.message_id) as { kind: string } | undefined;
    await router.route({
      from: r.from,
      conversationId: pa.conversation_id,
      correlationId: r.correlationId,
      kind: (row?.kind ?? "chat") as RouteInput["kind"],
      expect: "none",
      payload: buildAckPayload(r.data, r.error),
      clientToken: "ack-" + r.correlationId,
    });
    await mailbox.releaseRequestLease(r.correlationId); // §14.3：ack 释放 exclusive + 解 park LEASE_HELD
    events.emit("message_acked", {
      correlationId: r.correlationId,
      endpointId: r.endpointId ?? "",
      ok: r.error === undefined,
      detail:
        r.error !== undefined ? { error: r.error } : r.data !== undefined ? { data: r.data } : undefined,
    });
  }

  function buildAckPayload(data: unknown, error: unknown): { text?: string; data?: unknown } {
    if (error !== undefined) {
      return { text: typeof error === "string" ? "error: " + error : "error", data: { error } };
    }
    if (typeof data === "string") return { text: data };
    if (data !== undefined) return { data };
    return {};
  }

  // 由落库的 canonical 应答消息逆编码 buildAckPayload（跨进程轮询 / 快 ack 补查用）。
  // buildAckPayload 的不变量：error 分支 data 与 text 同时存在；object data 仅 data；
  // string data 仅 text；空应答两者皆无。
  function rebuildAckResult(
    correlationId: string,
    from: string,
    payload: { text?: string; data?: unknown } | undefined,
  ): AckResult {
    if (!payload) return { correlationId, ok: true, from };
    if (payload.data !== undefined && payload.text !== undefined) {
      return {
        correlationId,
        ok: false,
        from,
        error: (payload.data as { error?: unknown })?.error,
      };
    }
    if (payload.data !== undefined) {
      return { correlationId, ok: true, from, data: payload.data };
    }
    if (payload.text !== undefined) {
      return { correlationId, ok: true, from, data: payload.text };
    }
    return { correlationId, ok: true, from };
  }

  // ── request（§14.5）─────────────────────────────────────────────────────

  async function request(
    m: SendInput & { from: string; expect: "ack" | "reply" },
    opts?: { await?: boolean },
  ): Promise<{ correlationId: string } | AckResult> {
    if (closed) throw new Error("mesh: host is closed");
    const { from, ...input } = m;
    const blocking = opts?.await === true;
    const r = await router.route({
      ...input,
      from,
      blocking,
    } as RouteInput);
    const correlationId = r.correlationId!;
    if (!blocking) return { correlationId };

    const pa = store.db
      .prepare<[string], { to_account: string }>(
        "SELECT to_account FROM mesh_pending_acks WHERE correlation_id = ?",
      )
      .get(correlationId) as { to_account: string } | undefined;
    const expectedFrom = pa?.to_account ?? "";

    // 持久终态（§14.3/§14.4）：不只靠事件——补查闭合「await route 悬挂窗口内的快 ack」，
    // 轮询兜底跨进程 ack，保证「只有一个正确终态」且 await 恰好 resolve 一次。
    const terminalState = (): AckResult | null => {
      const st = store.db
        .prepare<
          [string],
          {
            state: string;
            to_account: string;
            answered_by_message: string | null;
          }
        >(
          "SELECT state, to_account, answered_by_message FROM mesh_pending_acks WHERE correlation_id = ?",
        )
        .get(correlationId) as
        | {
            state: string;
            to_account: string;
            answered_by_message: string | null;
          }
        | undefined;
      if (!st) return null;
      const from = st.to_account || expectedFrom;
      switch (st.state) {
        case "answered": {
          const ans = st.answered_by_message
            ? (store.db
                .prepare<[string], { payload: string }>(
                  "SELECT payload FROM mesh_messages WHERE id = ?",
                )
                .get(st.answered_by_message) as { payload: string } | undefined)
            : undefined;
          const payload = ans
            ? jsonParse<{ text?: string; data?: unknown }>(ans.payload, {})
            : undefined;
          return rebuildAckResult(correlationId, from, payload);
        }
        case "timeout":
          return { correlationId, ok: false, from, timedOut: true };
        case "abandoned":
          return { correlationId, ok: false, from, abandoned: true };
        default:
          return null; // open：仍等待
      }
    };

    return new Promise<AckResult>((resolve) => {
      let done = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      const finish = (result: AckResult) => {
        if (done) return;
        done = true;
        offAck();
        offTimeout();
        if (poll !== undefined) clearInterval(poll);
        resolve(result);
      };

      // 快路径：本进程事件（detail 精确到 data/error）
      const offAck = events.on("message_acked", (p) => {
        if (p.correlationId !== correlationId) return;
        const detail = p.detail as
          | { data?: unknown; error?: unknown }
          | undefined;
        finish({
          correlationId,
          ok: p.ok,
          from: expectedFrom,
          ...(detail?.data !== undefined ? { data: detail.data } : {}),
          ...(detail?.error !== undefined ? { error: detail.error } : {}),
        });
      });

      const offTimeout = events.on("request_timeout", (p) => {
        if (p.correlationId !== correlationId) return;
        finish({ correlationId, ok: false, from: expectedFrom, timedOut: true });
      });

      // 立即补查一次：闭合路由悬挂窗口内已经发生的快 ack / 已终态
      const seeded = terminalState();
      if (seeded) {
        finish(seeded);
        return;
      }

      // 轮询兜底：跨进程 ack / 慢超时 / 慢 abandoned（本地事件之外的正确性来源）
      poll = setInterval(() => {
        let st: AckResult | null = null;
        try {
          st = terminalState();
        } catch {
          // 宿主已 close（DB 连接关闭）或存储故障：停止轮询，勿在定时器内抛未捕获异常。
          offAck();
          offTimeout();
          if (poll !== undefined) clearInterval(poll);
          done = true;
          return;
        }
        if (st) finish(st);
      }, 50);
      (poll as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    });
  }

  // ── topic subscribe / unsubscribe（§16.3）────────────────────────────────

  async function topicSubscribe(
    conv: string,
    account: string,
    opts?: { fromSeq?: number },
  ): Promise<void> {
    const c = requireConv(conv);
    if (c.kind !== "topic") throw new Error("ARG_INVALID: not a topic");
    const acc = registry.getAccount(account);
    if (!acc) throw new MeshRejectError("NOT_A_MEMBER", "unknown account: " + account);
    const allowed = await withPolicyTimeout(
      policyDeps("accessControl", "deny"),
      () => {
        const hook = policies.accessControl.canSubscribe;
        if (!hook) return true; // 钩子缺失 → 放行（默认 AllowAll 恒真）
        return hook({ conversation: c, account: acc });
      },
      false,
      (v) => typeof v === "boolean", // 返回 undefined / 其它类型 → 非法 → deny（§22.5 fail-closed）
    );
    if (!allowed) throw new MeshRejectError("JOIN_DENIED", "canSubscribe denied");
    const fromSeq = opts?.fromSeq ?? registry.currentSeq(conv) + 1;
    registry.subscribe(conv, account, fromSeq);
    emitConvChanged(conv, { op: "subscribed", by: account, target: account });
  }

  async function topicUnsubscribe(conv: string, account: string): Promise<void> {
    const c = requireConv(conv);
    if (c.kind !== "topic") throw new Error("ARG_INVALID: not a topic");
    // §16.3 ① 软删
    registry.unsubscribe(conv, account);
    // §16.3 ② queued/parked → dropped(ACL_DENIED)。mesh_deliveries 无 conversation_id，
    // 需经 message_id 关联 mesh_messages 定位本会话的投递行。
    store.db
      .prepare(
        "UPDATE mesh_deliveries SET state='dropped', drop_reason='ACL_DENIED', state_changed_at=? " +
          "WHERE account_id=? AND state IN ('queued','parked') " +
          "AND message_id IN (SELECT id FROM mesh_messages WHERE conversation_id=?)",
      )
      .run(isoNow(), account, conv);
    // §16.3 ③ mesh_inboxes 该会话行清零：cursor_seq 置「当时的 next_seq」（非 0，规则 3），
    // 重新订阅才不按旧游标算巨大落后量；旧折叠摘要与重新订阅无关，一并清空。
    store.db
      .prepare(
        "UPDATE mesh_inboxes SET pending_count=0, pending_bytes=0, overflow_count=0, overflow_summary=NULL, " +
          "cursor_seq=(SELECT next_seq FROM mesh_conversations WHERE id=?) WHERE account_id=? AND conversation_id=?",
      )
      .run(conv, account, conv);
    emitConvChanged(conv, { op: "unsubscribed", by: account, target: account });
  }

  // ── requeue（§17.8）─────────────────────────────────────────────────────

  async function requeue(messageId: string, targetConv: string): Promise<void> {
    const row = store.db
      .prepare<[string], MessageRow>("SELECT * FROM mesh_messages WHERE id = ?")
      .get(messageId) as MessageRow | undefined;
    if (!row) throw new MeshRejectError("NO_SUCH_KEY", "no such message: " + messageId);
    const env = rowToEnvelope(row);
    const target = requireConv(targetConv);
    // 标记原 delivery 为 dropped（若仍处于未终态），避免悬挂 claimed
    // I32(a)：pending→dropped 减少未读缓存。先取受影响 (account, conv)，UPDATE 后重算。
    const affected = store.db
      .prepare<[string], { account_id: string; conversation_id: string }>(
        "SELECT DISTINCT d.account_id, m.conversation_id FROM mesh_deliveries d " +
          "JOIN mesh_messages m ON m.id = d.message_id WHERE d.message_id = ? " +
          "AND d.state IN ('routed','queued','parked','delivered')",
      )
      .all(messageId) as Array<{ account_id: string; conversation_id: string }>;
    store.db
      .prepare(
        "UPDATE mesh_deliveries SET state='dropped', drop_reason='TTL_EXPIRED', state_changed_at=? " +
          "WHERE message_id=? AND state IN ('routed','queued','parked','delivered','claimed')",
      )
      .run(isoNow(), messageId);
    for (const a of affected) store.recomputeInbox(a.account_id, a.conversation_id);
    await router.route({
      from: env.from,
      conversationId: targetConv,
      kind: (env.kind === "task" ? "task" : "chat") as RouteInput["kind"],
      expect: target.kind === "queue" ? ("ack" as const) : ("none" as const),
      payload: env.payload,
      clientToken: "requeue-" + messageId,
    });
  }

  function makeToolContext(accountId: AccountId, endpointId: EndpointId): ToolContext {
    return new HostToolContext({
      accountId,
      endpointId,
      registry,
      router,
      mailbox,
      observer,
      db: store.db,
      sharedSpace,
      ackCorrelation,
      createConversationHost,
      groupAdmin: async (conv, op) => {
        switch (op.op) {
          case "addMember":
            await groupAddMember(conv, op.account, { caps: op.caps, by: accountId });
            return;
          case "removeMember":
            await groupRemoveMember(conv, op.account, accountId);
            return;
          case "setCaps":
            await groupSetCaps(conv, op.account, op.caps, accountId);
            return;
          case "setTopic":
            await groupSetTopic(conv, accountId, op.topic, op.announcement);
            return;
          case "join":
            await groupJoin(conv, accountId);
            return;
          case "leave":
            await groupLeave(conv, accountId);
            return;
          case "dissolve":
            await groupDissolve(conv, accountId);
            return;
          case "subscribe":
            await topicSubscribe(conv, accountId, op.fromSeq !== undefined ? { fromSeq: op.fromSeq } : undefined);
            return;
          case "unsubscribe":
            await topicUnsubscribe(conv, accountId);
          default:
            throw new Error("ARG_INVALID");
        }
      },
      // I08：工具读史计量 —— 每次 mesh_history 读回原文记 1 份（verbatim_copies 语义 =
      // 「一份原文进了 Agent 上下文」，§10.2）。不新增计数器名。
      countVerbatim: (_bytes) => {
        store.bumpCounter("verbatim_copies");
      },
    });
  }

  // ── close（§12.1：全有全无）────────────────────────────────────────────

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = undefined;
    for (const u of injectionUnsub.values()) u();
    injectionUnsub.clear();
    // sameHost：停 outbox poller；已认领未完成的 delivery 由其他进程在回收窗口中接管
    for (const u of transportSubs.values()) u();
    transportSubs.clear();
    // C02（§12.1）：停 transport 的轮询/定时器（SameHostTransport 与自定义实现共用 stop 合同）
    await transport.stop?.();
    // 等在途 handoff 收敛或超时（§12.1）
    const deadline = Date.now() + limits.handoffTimeoutMs;
    const endpointIds = (store.db
      .prepare<[], { id: string }>("SELECT id FROM mesh_endpoints")
      .all() as Array<{ id: string }>).map((r) => r.id);
    while (Date.now() < deadline) {
      let inflight = 0;
      for (const id of endpointIds) inflight += mailbox.inFlightCount(id) + port.status(id).inFlight;
      if (inflight === 0) break;
      await sleep(10);
    }
    // I16（§12.1）：port.dispose 失败也不跳过实例锁释放与关库——三者按序全部收尾，
    // 之后重抛首个错误（残留写者不是可接受的失败模式）。
    let firstErr: unknown;
    try {
      const p = port as unknown as { dispose?: () => Promise<void> };
      if (typeof p.dispose === "function") await p.dispose();
    } catch (err) {
      firstErr = err;
    }
    try {
      await instanceLock?.release();
    } catch (err) {
      firstErr ??= err;
    }
    try {
      store.close();
    } catch (err) {
      firstErr ??= err;
    }
    if (firstErr) throw firstErr;
  }

  // ── MeshHost 对象 ───────────────────────────────────────────────────────

  const host: MeshHost = {
    // ── 账号、端点与寻址 ──
    registerAccount: (a: RegisterAccountInput) => registry.registerAccount(a),
    registerEndpoint: (e: RegisterEndpointInput) => registry.registerEndpoint(e),
    registerSinkHandler(accountId: AccountId, h: SinkHandler): Unsubscribe {
      sinkHandlers.set(accountId, h);
      // §6.3③：handler 晚到的投递从 NO_SINK_HANDLER 恢复
      void mailbox.retryAccount(accountId);
      return () => {
        if (sinkHandlers.get(accountId) === h) sinkHandlers.delete(accountId);
      };
    },
    markConsumed: (deliveryId: string) => mailbox.markConsumed(deliveryId),
    async setPresence(accountId: AccountId, state: PresenceState, opts?: { until?: string; reason?: string }) {
      const prev = registry.effectivePresence(accountId);
      registry.setPresence(accountId, state, opts);
      const next = registry.effectivePresence(accountId);
      // I24：显式 host 值同步进 mailbox 的 last-emitted 表，避免与派生回落重复/漏发
      mailbox.notePresence(accountId, next);
      if (prev !== next) {
        events.emit("presence_changed", { accountId, from: prev, to: next, source: "host" });
      }
    },
    upsertContact: async (ownerId, peerId, opts) => {
      registry.upsertContact(ownerId, peerId, opts);
    },
    lookup: async (q) => registry.lookupAccounts(q),

    // ── 会话与成员 ──
    ensureDirect: (a, b) => {
      if (!registry.getAccount(a) || !registry.getAccount(b)) {
        throw new MeshRejectError("NOT_A_MEMBER", "both accounts must be registered");
      }
      return registry.ensureDirect(a, b);
    },
    createConversation: (c) => createConversationHost(c),
    addMember: (conv, account, opts) => groupAddMember(conv, account, opts),
    removeMember: (conv, account, opts) => groupRemoveMember(conv, account, opts.by),
    join: (conv, account) => groupJoin(conv, account),
    leave: (conv, account) => groupLeave(conv, account),
    setCaps: (conv, account, caps, by) => groupSetCaps(conv, account, caps, by),
    subscribe: async (conv, account, opts) => {
      await topicSubscribe(conv, account, opts);
    },
    unsubscribe: async (conv, account) => {
      await topicUnsubscribe(conv, account);
    },
    setAnnouncement: async (conv, text, by) => {
      await groupSetTopic(conv, by, undefined, text);
    },
    setTopic: async (conv, text, by) => {
      await groupSetTopic(conv, by, text);
    },
    mute: (conv, account, until) => groupMute(conv, account, until),
    dissolve: (conv, by) => groupDissolve(conv, by),
    upgradeToGroup: (directConv, extra, by) => upgradeToGroup(directConv, extra, by),

    // ── 发送与应答 ──
    async send(m: SendInput & { from: string }) {
      if (closed) throw new Error("mesh: host is closed");
      // I34：任一存储故障激活即停发（告警+边界），恢复后自动放行。
      if (store.health.isStopSend()) {
        throw new InvariantViolationError("storage_fault", {
          faults: store.health.activeFaults(),
        });
      }
      const { from, ...input } = m;
      const r = await router.route({ ...input, from } as RouteInput);
      return { messageId: r.messageId, seq: r.seq };
    },
    request: (m, opts) => request(m, opts) as Promise<{ correlationId: string } | AckResult>,
    ack: (r) => ackCorrelation(r),
    claim: (messageId, by) => mailbox.claim(messageId, by),
    requeue: (messageId, targetConv) => requeue(messageId, targetConv),

    // ── 控制面 ──
    nudge: (endpointId, cue, opts) => port.nudge(endpointId, cue, opts),
    injectContext: (endpointId, text) => port.injectContext(endpointId, text),
    beforeClearQueue: (endpointId) => mailbox.beforeClearQueue(endpointId),

    // ── 共享空间 ──
    shared: {
      get: (spaceId, key, opts) => sharedSpace.get(spaceId, key, opts.as, opts.version),
      put: (spaceId, key, data, opts) => sharedSpace.put(spaceId, key, data, opts),
      append: (spaceId, key, item, opts) => sharedSpace.append(spaceId, key, item, opts),
      del: (spaceId, key, opts) => sharedSpace.del(spaceId, key, opts),
      list: (spaceId, opts) => sharedSpace.list(spaceId, opts),
    },

    // ── 流控制 ──
    async warm(endpointId: string, lease?: MeshLease) {
      await port.warm(endpointId, lease);
      await mailbox.retryEndpoint(endpointId);
      refreshInjection(endpointId);
      // sameHost（§19.3）：注册本进程的端点 handler 供 outbox poller 发现后投递。
      // PiStreamPort 的自动/显式 warm 已由 onWarmed 注册；此处兜底自定义 StreamPort
      // （无 onWarmed 钩子）。Map 按端点覆盖，重复注册幂等。
      if (transport instanceof SameHostTransport) {
        transportSubs.set(
          endpointId,
          transport.subscribe(endpointId, (pd) => mailbox.handleOutboxDelivery(pd)),
        );
      }
    },
    evict: async (endpointId) => {
      // sameHost：清理 transport 订阅避免 stale handler
      transportSubs.get(endpointId)?.();
      transportSubs.delete(endpointId);
      await port.evict(endpointId);
    },
    async reclaimEndpoint(endpointId) {
      // §27.4 / M-R10：只有 ownerIsLive === "dead" 才回收；alive/unknown 一律拒绝（绝不猜）。
      const lockPath = join(stateDir, "locks", `${endpointId}.lock`);
      const verdict = await EndpointLock.ownerIsLive(lockPath);
      if (verdict !== "dead") {
        const ep = registry.getEndpoint(endpointId);
        // I26：经 setEndpointState 补发 endpoint_state_changed（reclaim 拒绝降级也是状态跃迁）
        if (ep) setEndpointState(endpointId, "unavailable");
        if (verdict === "unknown") {
          // I04：锁文件损坏/不可读/取不到启动时刻时保持 unavailable 并告警，绝不猜（§19.6）
          events.emit("invariant_violated", { code: "endpoint_lock_undetermined", detail: { endpointId } });
          store.bumpCounter("invariant_violated");
        }
        return { outcome: verdict === "alive" ? "held" : "unknown" };
      }
      await EndpointLock.forceRelease(lockPath);
      registry.setEndpointLock(endpointId, null);
      return { outcome: "reclaimed" };
    },
    toolSet(endpointId: string, only?: MeshToolName[]): ToolDefinition[] {
      const ep = registry.getEndpoint(endpointId);
      if (!ep) throw new Error("mesh: unknown endpoint " + endpointId);
      return buildToolSet(makeToolContext(ep.accountId, endpointId), only, { devMode, clock: safeClock, maxBytes: limits.toolResultMaxBytes });
    },

    // ── 事件与观测 ──
    on<K extends keyof MeshEvents>(e: K, h: (p: MeshEvents[K]) => void): Unsubscribe {
      return events.on(e, h);
    },
    observer,
    close,
  };

  // devMode 故障注入缝（非公共面）：测试直接驱动 store 的 I34 执行链
  // （注入→停发+告警、清除→恢复），生产无此挂点。
  if (devMode) {
    (host as unknown as { _dev: { injectFault: (c: StorageFaultCode) => void; clearFault: (c: StorageFaultCode) => void } })._dev = {
      injectFault: (c) => store.injectFault(c),
      clearFault: (c) => store.clearFault(c),
    };
  }

  return host;
}

export type {
  Account,
  AccountId,
  AccessControl,
  AckResult,
  Acl,
  AclCtx,
  AclRule,
  ActivationPolicy,
  Cap,
  ContextPath,
  Conversation,
  ConversationChange,
  ConversationConfig,
  ConversationId,
  ConversationKind,
  ConversationSummary,
  ConversationType,
  ConvState,
  CorrelationId,
  CreateConversationInput,
  DegradeTarget,
  DeliveryHandler,
  DeliveryId,
  DeliveryPolicy,
  DeliveryState,
  DeliveryTrace,
  DropReason,
  Endpoint,
  EndpointClass,
  EndpointId,
  EndpointSelector,
  EndpointState,
  EntryId,
  Envelope,
  EnvelopePayload,
  ExpectKind,
  FloorPolicy,
  Grade,
  InboxState,
  InboxView,
  InvariantReport,
  Limits,
  LogicalClock,
  Membership,
  MeshErrorCode,
  MeshEvents,
  MeshHost,
  MeshLease,
  MeshOptions,
  MeshRejectError,
  MeshToolName,
  MeshToolResult,
  MessageId,
  MessageKind,
  Observer,
  OptionalPolicySlot,
  ParkReason,
  PendingDelivery,
  PiSessionId,
  Policies,
  PolicyDegradeReason,
  PolicySlot,
  PortEntryEvent,
  PortStatus,
  Presence,
  PresenceState,
  Priority,
  RecentPreview,
  RegisterAccountInput,
  RegisterEndpointInput,
  RejectCode,
  Renderer,
  ReplayResult,
  RequiredPolicySlot,
  RetentionCandidate,
  RetentionPolicy,
  SendInput,
  SessionFactory,
  SharedObjectMeta,
  SharedRef,
  SinkHandler,
  SpaceId,
  StreamEntry,
  StreamPort,
  StreamTopology,
  ToolDefinition,
  ToolErrorCode,
  Transport,
  Unsubscribe,
  VerbatimBudget,
  WakeRateLimit,
} from "./core/types.js";

export type {
  ConversationAdminOp,
  ContactRow,
  MemberRow,
  ToolContext,
} from "./core/contracts.js";

export {
  DEFAULT_LIMITS,
  DROP_REASONS,
  InvariantViolationError,
  MeshUnsupportedError,
  PARK_REASONS,
  REJECT_CODES,
  TOOL_ERROR_CODES,
} from "./core/types.js";

export { REGISTERED_COUNTERS } from "./core/store.js";
export { MESH_TOOL_NAMES } from "./core/tools.js";

export { createPiSessionFactory, createAssembledSessionFactory } from "./pi/session-factory.js";
export { MESH_ERROR_CODES, MeshConfigError, configFingerprint, resolveLlmConfig } from "./pi/llm-config.js";
export type {
  LlmConfig,
  MeshConfigCode,
  ProviderConfig,
  RuntimeConfig,
  RuntimeResources,
  Profile,
  ResolvedLlm,
} from "./pi/llm-config.js";
export { EndpointLock, LockHeldError } from "./pi/lock.js";
export { PiPortError, PiStreamPort } from "./pi/stream-port.js";