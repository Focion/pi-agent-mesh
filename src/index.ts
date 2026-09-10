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
import { capsSubsetOf, MeshRegistry, validCaps } from "./core/registry.js";
import { MeshEventBus } from "./core/events.js";
import { MeshMailbox } from "./core/mailbox.js";
import { MeshObserver, rowToEnvelope, type MessageRow } from "./core/observer.js";
import {
  createDefaultPolicies,
  withPolicyTimeout,
  type PolicyTimeoutDeps,
} from "./core/policies.js";
import { MeshRouter } from "./core/router.js";
import { SqliteStore } from "./core/store.js";
import { buildToolSet } from "./core/tools.js";
import { InProcessTransport } from "./core/transport.js";
import { isoNow, sleep } from "./core/util.js";
import { EndpointLock, LockHeldError } from "./pi/lock.js";
import { PiStreamPort } from "./pi/stream-port.js";
import {
  DEFAULT_LIMITS,
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
  MeshEvents,
  MeshHost,
  MeshLease,
  MeshOptions,
  MeshToolName,
  Policies,
  PolicySlot,
  PresenceState,
  RegisterAccountInput,
  RegisterEndpointInput,
  SendInput,
  SinkHandler,
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

// ─── 宿主侧 ToolContext（§10.2：身份由闭包注入，不可伪造）─────────────────

interface ToolCtxDeps {
  accountId: AccountId;
  endpointId: EndpointId;
  registry: MeshRegistry;
  router: MeshRouter;
  mailbox: MeshMailbox;
  observer: MeshObserver;
  db: SqliteStore["db"];
  createConversationHost(input: CreateConversationInput): Promise<Conversation>;
  groupAdmin(conversationId: ConversationId, op: ConversationAdminOp): Promise<void>;
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
    return this.d.mailbox.inboxOf(this.d.accountId);
  }

  async history(
    conversationId: string,
    opts?: { beforeSeq?: number; limit?: number },
  ): Promise<Envelope[]> {
    const conv = this.d.registry.getConversation(conversationId);
    if (!conv) {
      throw new MeshRejectError("NOT_A_MEMBER", "no such conversation: " + conversationId);
    }
    if (conv.kind === "topic") throw new MeshUnsupportedError("topic history");
    const m = this.d.registry.getMembership(conversationId, this.d.accountId);
    if (!m) {
      throw new MeshRejectError("NOT_A_MEMBER", this.d.accountId + " is not a member of " + conversationId);
    }
    // historyVisibility（§9.4）：none 全区间不可见；since_join 从 joinedSeq 起；full 全可见
    const vis = conv.config.historyVisibility ?? "since_join";
    if (vis === "none") throw new Error("HISTORY_FORBIDDEN");
    const lower = vis === "since_join" ? m.joinedSeq : 0;
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

  async conversations(filter?: { type?: "direct" | "group" | "topic" | "queue"; hasUnread?: boolean }): Promise<ConversationSummary[]> {
    let list = await this.d.observer.conversationsOf(this.d.accountId);
    if (filter?.type !== undefined) list = list.filter((c) => c.kind === filter.type);
    if (filter?.hasUnread !== undefined) {
      const inbox = this.d.mailbox.inboxOf(this.d.accountId);
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
    // topic 无成员表：返回订阅者（buildMeshMembers 用它做 subscriberCount）
    if (conv.kind === "topic") {
      return this.d.registry.listSubscribers(conversationId).map((s) => ({
        accountId: s.accountId,
        displayName: s.accountId,
        caps: [] as Cap[],
        presence: "available" as PresenceState,
      }));
    }
    const m = this.d.registry.getMembership(conversationId, this.d.accountId);
    if (!m) throw new MeshRejectError("NOT_A_MEMBER", this.d.accountId + " is not a member of " + conversationId);
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

  // ── P3/P4 延后面（工具层把 MeshUnsupportedError 转结构化 TOOL_DISABLED）──

  async ack(): Promise<void> {
    throw new MeshUnsupportedError("ack (request-response, P3)");
  }
  async claim(): Promise<{ ok: boolean; leaseUntil?: string }> {
    throw new MeshUnsupportedError("queue claim (P3)");
  }
  async sharedGet(): Promise<unknown> {
    throw new MeshUnsupportedError("shared spaces (P4)");
  }
  async sharedPut(): Promise<{ version: number }> {
    throw new MeshUnsupportedError("shared spaces (P4)");
  }
  async sharedList(): Promise<Array<{ key: string; version: number }>> {
    throw new MeshUnsupportedError("shared spaces (P4)");
  }
}

// ─── createMesh（§12.1）───────────────────────────────────────────────────

export async function createMesh(options: MeshOptions): Promise<MeshHost> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const devMode = options.devMode ?? false;
  const writerId = `mesh-${randomUUID()}`;

  // ① 打开 DB（WAL/busy_timeout/迁移/外键）
  const store = SqliteStore.open(options.dbPath, { devMode });

  const stateDir = join(dirname(options.dbPath), "mesh");
  let instanceLock: EndpointLock | undefined;

  // ② 抢占实例锁（M3：同一 dbPath 不得被两个实例同时打开，绝不接管）
  try {
    if (options.dbPath !== ":memory:") {
      instanceLock = await EndpointLock.acquire(options.dbPath + ".instance.lock", {
        writerId,
        lease: "shared",
      });
      // 端点锁探测：任何已注册端点的锁被他人持有 ⇒ 拒绝启动（崩溃恢复的权威顺序靠它，§8.4①）
      const endpointIds = (store.db
        .prepare<[], { id: string }>("SELECT id FROM mesh_endpoints")
        .all() as Array<{ id: string }>).map((r) => r.id);
      for (const id of endpointIds) {
        const probe = await EndpointLock.acquire(join(stateDir, "locks", `${id}.lock`), { writerId });
        await probe.release();
      }
    }
  } catch (err) {
    store.close();
    throw err;
  }

  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  // MeshOptions.transport 公开为窄接口 Transport；内部三件（router/mailbox/transport）
  // 当前只实现 InProcessTransport（跨进程 outbox 是 P5），自定义 Transport 暂不接。
  const transport = (options.transport ?? new InProcessTransport()) as InProcessTransport;

  // 端口级降级 → 告警事件。规范 §8.3 文字写「发 policy_degraded」，但载荷以策略槽
  // 为键，端口级原因（租约超时/钩子缺失）无对应槽；改走同属「必订」告警事件的
  // invariant_violated（§12.5 末），语义更贴切（库已不在正常状态运行）。
  const onPortDegraded = (info: { reason: string; endpointId: EndpointId }): void => {
    events.emit("invariant_violated", { code: info.reason, detail: { endpointId: info.endpointId } });
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

  // 策略装配：九个槽八个默认，sessionFactory 必填（§12.1 类型层已保证）
  let mailbox!: MeshMailbox;
  let router!: MeshRouter;

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

  const endpointsOf = (acct: AccountId): Array<{ id: EndpointId; inFlight: number }> =>
    registry.endpointsOf(acct).map((e) => ({ id: e.id, inFlight: mailbox ? mailbox.inFlightCount(e.id) : 0 }));

  const defaults = createDefaultPolicies({ isAwaiting, endpointsOf, limits });
  const policies: Policies = { ...defaults, ...options.policies };

  // P2 注入刷新（§7.6 I23）：port.injectContext 追加在扩展链尾，文本变化时重装
  const injectionUnsub = new Map<EndpointId, Unsubscribe>();
  const injectionText = new Map<EndpointId, string>();
  function refreshInjection(endpointId: EndpointId): void {
    try {
      if (port.status(endpointId).state !== "hot") return; // 冷流不装，warm 时再装
      const text = mailbox.inboxInjection(endpointId);
      if (!text || injectionText.get(endpointId) === text) return;
      injectionUnsub.get(endpointId)?.();
      injectionUnsub.set(endpointId, port.injectContext(endpointId, text));
      injectionText.set(endpointId, text);
    } catch {
      // 注入失败不阻断投递（§12.5）
    }
  }

  const port = options.streamPort ?? new PiStreamPort({
    sessionFactory: policies.sessionFactory,
    getEndpoint: (id) => registry.getEndpoint(id),
    getAccount: (id) => registry.getAccount(id),
    buildTools: (endpointId) => {
      const ep = registry.getEndpoint(endpointId);
      if (!ep) return [];
      return buildToolSet(makeToolContext(ep.accountId, endpointId), undefined, { devMode });
    },
    setEndpointState,
    setEndpointSession: (id, sid) => registry.setEndpointSession(id, sid),
    setEndpointLease: (id, lease, until) => registry.setEndpointLease(id, lease, until),
    hasUnconsumed,
    stateDir,
    exclusiveLeaseTtlMs: limits.exclusiveLeaseTtlMs,
    idleEvictMs: limits.idleEvictMs,
    devMode,
    onDegraded: onPortDegraded,
  });

  if (options.streamPort && !(options.streamPort instanceof PiStreamPort)) {
    // §12.1：自定义 StreamPort 使 replay(§23.2) / 崩溃恢复双向核对(§8.4) /
    // .lock 单写者(M3) 三项保证失效，启动时降级并警告。
    console.warn(
      "[pi-agent-mesh] custom StreamPort: replay / crash-recovery dual-check / .lock " +
        "single-writer guarantees are degraded (§2.4)",
    );
  }

  const sinkHandlers = new Map<AccountId, SinkHandler>();

  // ③ 崩溃恢复核对（§8.4）：以 deliveries 为真相重算收件箱缓存 + 周期清扫
  // （parked TTL / handoff 超时 / 溢出折叠 / seq 缺口）。双向逐条核对与镜像
  // 对齐属 P2，本轮落基础恢复面。
  store.recomputeInboxCaches();

  mailbox = new MeshMailbox({
    store,
    registry,
    events,
    policies,
    limits,
    transport,
    port,
    sinkHandlers,
    awaitingCorrelations,
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

  router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits,
    devMode,
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

  const observer = new MeshObserver({ store, registry, limits });

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

  /** 宿主代行身份（§12.2 ①）：by 不是成员时不校验；是成员则必须有该 cap */
  function requireMemberCap(conv: ConversationId, by: AccountId, cap: Cap): void {
    const m = registry.getMembership(conv, by);
    if (!m) return;
    if (!m.caps.includes(cap)) throw new Error("CAP_REQUIRED");
  }

  /** I8（§4.4）：授出的 caps 必须是授予者自身 caps 的子集 */
  function assertSubsetCaps(conv: ConversationId, by: AccountId, granted: Cap[]): void {
    const m = registry.getMembership(conv, by);
    if (!m) return;
    if (!capsSubsetOf(granted, m.caps)) throw new Error("CAP_REQUIRED");
  }

  function emitConvChanged(conv: ConversationId, change: ConversationChange): void {
    events.emit("conversation_changed", { conversationId: conv, change });
  }

  function emitSystem(conv: ConversationId, text: string): Promise<unknown> {
    return router.route({ from: SYSTEM_ACCOUNT, conversationId: conv, kind: "system", expect: "none", text });
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
    emitConvChanged(conv, { op: "member_joined", by, target: account });
    await emitSystem(conv, `${by} added ${account}`);
  }

  async function groupRemoveMember(conv: ConversationId, account: AccountId, by: AccountId): Promise<void> {
    requireGroup(conv);
    if (!registry.getMembership(conv, account)) return;
    requireMemberCap(conv, by, "remove");
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
      () => policies.accessControl.canJoin?.(c, acc) ?? true,
      false,
    );
    if (!allowed) throw new MeshRejectError("JOIN_DENIED", "canJoin denied");
    registry.addMember(conv, account, ["speak", "read"]);
    emitConvChanged(conv, { op: "member_joined", by: account, target: account });
    await emitSystem(conv, `${account} joined`);
  }

  async function groupLeave(conv: ConversationId, account: AccountId): Promise<void> {
    requireGroup(conv);
    const m = registry.getMembership(conv, account);
    if (!m) return;
    // 最后一个 setCaps 持有者离开前须先授出（§12.2：reject NO_ADMIN_LEFT）
    if (m.caps.includes("setCaps")) {
      const others = registry.listMembers(conv).filter((x) => x.accountId !== account);
      if (others.length > 0 && !others.some((x) => x.caps.includes("setCaps"))) {
        throw new MeshRejectError("NO_ADMIN_LEFT", "last setCaps holder must grant before leaving");
      }
    }
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

  function makeToolContext(accountId: AccountId, endpointId: EndpointId): ToolContext {
    return new HostToolContext({
      accountId,
      endpointId,
      registry,
      router,
      mailbox,
      observer,
      db: store.db,
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
            // topic（P2 延后）——不落 subgroup 表
            throw new MeshUnsupportedError("topic subscribe");
          case "unsubscribe":
            throw new MeshUnsupportedError("topic unsubscribe");
          default:
            throw new Error("ARG_INVALID");
        }
      },
    });
  }

  // ── close（§12.1：全有全无）────────────────────────────────────────────

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const u of injectionUnsub.values()) u();
    injectionUnsub.clear();
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
    const p = port as unknown as { dispose?: () => Promise<void> };
    if (typeof p.dispose === "function") await p.dispose();
    await instanceLock?.release();
    store.close();
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
      if (prev !== next) events.emit("presence_changed", { accountId, from: prev, to: next });
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
    subscribe: () => {
      throw new MeshUnsupportedError("topic subscribe (P2)");
    },
    unsubscribe: () => {
      throw new MeshUnsupportedError("topic unsubscribe (P2)");
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
      const { from, ...input } = m;
      const r = await router.route({ ...input, from } as RouteInput);
      return { messageId: r.messageId, seq: r.seq };
    },
    request: () => {
      throw new MeshUnsupportedError("request-response (P3)");
    },
    ack: () => {
      throw new MeshUnsupportedError("ack (request-response, P3)");
    },
    claim: () => {
      throw new MeshUnsupportedError("queue claim (P3)");
    },
    requeue: () => {
      throw new MeshUnsupportedError("queue requeue (P3)");
    },

    // ── 控制面 ──
    nudge: (endpointId, cue, opts) => port.nudge(endpointId, cue, opts),
    injectContext: (endpointId, text) => port.injectContext(endpointId, text),
    beforeClearQueue: (endpointId) => mailbox.beforeClearQueue(endpointId),

    // ── 共享空间（P4 延后）──
    shared: {
      get: () => Promise.reject(new MeshUnsupportedError("shared spaces (P4)")),
      put: () => Promise.reject(new MeshUnsupportedError("shared spaces (P4)")),
      append: () => Promise.reject(new MeshUnsupportedError("shared spaces (P4)")),
      del: () => Promise.reject(new MeshUnsupportedError("shared spaces (P4)")),
      list: () => Promise.reject(new MeshUnsupportedError("shared spaces (P4)")),
    },

    // ── 流控制 ──
    async warm(endpointId: string, lease?: MeshLease) {
      await port.warm(endpointId, lease);
      await mailbox.retryEndpoint(endpointId);
      refreshInjection(endpointId);
    },
    evict: (endpointId) => port.evict(endpointId),
    toolSet(endpointId: string, only?: MeshToolName[]): ToolDefinition[] {
      const ep = registry.getEndpoint(endpointId);
      if (!ep) throw new Error("mesh: unknown endpoint " + endpointId);
      return buildToolSet(makeToolContext(ep.accountId, endpointId), only, { devMode });
    },

    // ── 事件与观测 ──
    on<K extends keyof MeshEvents>(e: K, h: (p: MeshEvents[K]) => void): Unsubscribe {
      return events.on(e, h);
    },
    observer,
    close,
  };

  return host;
}

export type {
  Account,
  AccountId,
  Cap,
  Conversation,
  ConversationId,
  ConvState,
  ConversationConfig,
  ConversationKind,
  ConversationSummary,
  ConversationType,
  CreateConversationInput,
  DropReason,
  Endpoint,
  EndpointId,
  EndpointClass,
  EndpointState,
  Envelope,
  ExpectKind,
  Grade,
  Limits,
  MeshEvent,
  MeshEvents,
  MeshHost,
  MeshLease,
  MeshOptions,
  MeshRejectError,
  MeshToolName,
  MessageKind,
  ParkReason,
  Policies,
  PresenceState,
  Priority,
  RejectCode,
  SessionFactory,
  SendInput,
  SinkHandler,
  StreamPort,
  Transport,
  Unsubscribe,
} from "./core/types.js";

export {
  DEFAULT_LIMITS,
  InvariantViolationError,
  MeshUnsupportedError,
} from "./core/types.js";

export { createPiSessionFactory } from "./pi/session-factory.js";
export { EndpointLock, LockHeldError } from "./pi/lock.js";
export { PiPortError, PiStreamPort } from "./pi/stream-port.js";