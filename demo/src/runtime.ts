// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 运行时控制器（全真实装配，实时 LLM）。
//
// 一行 import 组装真实 MeshHost：createMesh 不填 streamPort/transport，由库自动
// 装配真实 PiStreamPort + InProcessTransport；createPiSessionFactory 注入真实
// Model（config 层已 fail-fast 校验）。无 faux、无 FakeStreamPort、无离线模拟。
//
// 每个 agent 端点都跑一个真实 pi AgentSession（sessionFactory 捕获留存），
// 群聊「接龙」由控制器显式驱动：发消息后，群里其它 agent 各自用真实 session
// 生成一句回复，再经 host.send 回发到群——全部走真实 LLM，没有任何 canned 文案。
//
// MeshHost 没有「列出端点/会话」「读端点 piSessionId」的公开接口，故本控制器：
//  - 自记 accounts/endpoints/conversations/presence/sinkModes 投影；
//  - 给 sessionFactory 包一层以捕获每端点 piSessionId 与真实 session 对象；
//  - 用 endpoint_state_changed / presence_changed 事件维持最新投影。
// ═══════════════════════════════════════════════════════════════════════════

import { createMesh, createPiSessionFactory } from "../../dist/index.js";
import type {
  Account,
  Cap,
  Conversation,
  DeliveryTrace,
  Endpoint,
  Envelope,
  Grade,
  MeshEvents,
  MeshHost,
  PresenceState,
  SessionFactory,
  StreamTopology,
  Unsubscribe,
} from "../../dist/core/index.js";
import type { DemoConfig } from "./config.ts";

const isoNow = () => new Date().toISOString();

export interface ControllerHooks {
  meshEvent(type: string, payload: unknown): void;
  delivery(payload: { messageId: string; traces: DeliveryTrace[] }): void;
  /** 每条路由消息（SSE "meshmsg"）—— 供前端"多 agent 活动流"可视化。 */
  meshMessage(env: Envelope): void;
}

/** 群聊花名册中的单个 agent。 */
export interface AgentInfo {
  id: string;
  displayName: string;
  persona: string;
  isSeed: boolean;
  state?: string;
}

/** 一条群聊消息（首屏历史 + 实时去重）。 */
export interface ChatEntry {
  id: string;
  from: string;
  fromName: string;
  conversationId: string;
  kind: string;
  text: string;
  at: string;
}

export class MeshController {
  readonly config: DemoConfig;
  private readonly model: unknown;
  private readonly hooks: ControllerHooks;

  host!: MeshHost;

  accounts = new Map<string, Account>();
  endpoints = new Map<string, Endpoint>();
  conversations = new Map<string, Conversation>();
  presence = new Map<string, PresenceState>();
  sinkModes = new Map<string, "accept" | "refuse">();
  private sinkUnsubs = new Map<string, Unsubscribe>();

  /** 每个 agent 端点的真实 pi AgentSession（驱动 LLM 回复用）。 */
  private sessions = new Map<string, unknown>();

  // ── 群聊面板状态（注册 agent · 群组 · 多 agent 互聊）────────────────────
  private chatGroupId?: string;
  private agentProfiles = new Map<string, { persona?: string; isSeed?: boolean }>();
  private chatLog = new Map<string, ChatEntry>();
  private chatBusy = false;

  constructor(config: DemoConfig, model: unknown, hooks: ControllerHooks) {
    this.config = config;
    this.model = model;
    this.hooks = hooks;
  }

  // ── 装配（§12.1）─────────────────────────────────────────────────────────
  async init(): Promise<void> {
    const base = createPiSessionFactory({
      stateDir: this.config.stateDir,
      ...(this.config.agentDir ? { agentDir: this.config.agentDir } : {}),
      model: this.model,
      thinkingLevel: this.config.thinkingLevel,
      ...(this.config.tools.length > 0 ? { tools: this.config.tools } : {}),
    });
    // 包一层捕获 piSessionId 与真实 session 对象（接龙回复要用）。
    const controller = this;
    const sessionFactory: SessionFactory = {
      async create(ctx) {
        const r = await base.create(ctx);
        controller.captureSession(ctx.endpoint.id, r.piSessionId);
        controller.sessions.set(ctx.endpoint.id, r.session);
        return r;
      },
      async open(ctx) {
        controller.captureSession(ctx.endpoint.id, ctx.piSessionId);
        const r = await base.open(ctx);
        controller.sessions.set(ctx.endpoint.id, r.session);
        return r;
      },
    };
    this.host = await createMesh({
      dbPath: this.config.dbPath,
      policies: { sessionFactory },
      devMode: true,
      // 单进程面板：崩溃/被 SIGKILL 后 .instance.lock 与端点锁会残留并挡住重启。
      // 开启后 createMesh 先用 pid 存活 + 启动时刻核验持锁者「确实已死」再回收（M3 安全）。
      recoverDeadEndpoints: true,
    });
    this.wireEvents();
    await this.seedChatRoom();
  }

  private captureSession(endpointId: string, piSessionId: string): void {
    const ep = this.endpoints.get(endpointId);
    if (ep) ep.piSessionId = piSessionId;
  }

  async dispose(): Promise<void> {
    for (const u of this.sinkUnsubs.values()) u();
    this.sinkUnsubs.clear();
    await this.host.close();
  }

  // ── 事件接线（15 个全接；另加 sink_received 合成事件）─────────────────────
  private wireEvents(): void {
    const fwd = <K extends keyof MeshEvents>(e: K, p: MeshEvents[K]): void => {
      this.hooks.meshEvent(e, { at: isoNow(), ...(p as object) });
      this.updateFromEvent(e, p);
    };
    this.host.on("message_routed", (p) => {
      fwd("message_routed", p);
      const env = (p as MeshEvents["message_routed"]).envelope;
      if (env) {
        this.hooks.meshMessage(env);
        if (env.kind === "chat" || env.kind === "system") {
          this.pushChat({
            id: env.id,
            from: env.from,
            conversationId: env.conversationId,
            kind: env.kind,
            text: ((env.payload as { text?: string } | undefined)?.text) ?? "",
            at: ((env as unknown as { at?: string }).at) ?? isoNow(),
          });
        }
      }
    });
    this.host.on("message_delivered", (p) => fwd("message_delivered", p));
    this.host.on("message_consumed", (p) => fwd("message_consumed", p));
    this.host.on("message_parked", (p) => fwd("message_parked", p));
    this.host.on("message_dropped", (p) => fwd("message_dropped", p));
    this.host.on("message_acked", (p) => fwd("message_acked", p));
    this.host.on("inbox_overflowed", (p) => fwd("inbox_overflowed", p));
    this.host.on("request_timeout", (p) => fwd("request_timeout", p));
    this.host.on("conversation_changed", (p) => fwd("conversation_changed", p));
    this.host.on("membership_caps_changed", (p) => fwd("membership_caps_changed", p));
    this.host.on("shared_object_changed", (p) => fwd("shared_object_changed", p));
    this.host.on("presence_changed", (p) => fwd("presence_changed", p));
    this.host.on("endpoint_state_changed", (p) => fwd("endpoint_state_changed", p));
    this.host.on("policy_degraded", (p) => fwd("policy_degraded", p));
    this.host.on("invariant_violated", (p) => fwd("invariant_violated", p));
  }

  private updateFromEvent<K extends keyof MeshEvents>(e: K, p: MeshEvents[K]): void {
    switch (e) {
      case "endpoint_state_changed": {
        const { endpointId, to } = p as MeshEvents["endpoint_state_changed"];
        const ep = this.endpoints.get(endpointId);
        if (ep) ep.state = to;
        break;
      }
      case "presence_changed": {
        const { accountId, to } = p as MeshEvents["presence_changed"];
        this.presence.set(accountId, to);
        break;
      }
      case "conversation_changed": {
        const { conversationId, change } = p as MeshEvents["conversation_changed"];
        if (change.op === "group_dissolved") {
          const c = this.conversations.get(conversationId);
          if (c) c.state = "archived";
        }
        break;
      }
      case "message_routed":
      case "message_delivered":
      case "message_consumed":
      case "message_parked":
      case "message_dropped": {
        const env = (p as MeshEvents["message_routed"]).envelope;
        if (env?.id) void this.pushTrace(env.id);
        break;
      }
    }
  }

  private async pushTrace(messageId: string): Promise<void> {
    try {
      const traces = await this.host.observer.trace(messageId);
      this.hooks.delivery({ messageId, traces });
    } catch {
      // 事件到达与 trace 可见之间可能有一拍；忽略。
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 账号 / 端点 / 寻址
  // ═════════════════════════════════════════════════════════════════════════

  async registerAccount(a: {
    id?: string;
    displayName: string;
    endpointClass: "stream" | "sink" | "external";
    capabilities?: string[];
    initiate?: string[];
    defaultGrade?: Grade;
  }): Promise<Account> {
    const acc = await this.host.registerAccount({
      id: a.id,
      displayName: a.displayName,
      endpointClass: a.endpointClass,
      capabilities: a.capabilities,
      initiate: a.initiate as Account["initiate"],
      defaultGrade: a.defaultGrade,
    });
    this.accounts.set(acc.id, acc);
    if (a.endpointClass !== "stream" && !this.sinkModes.has(acc.id)) {
      this.setSinkMode(acc.id, "accept", false);
    }
    return acc;
  }

  async registerEndpoint(a: {
    accountId: string;
    topology: StreamTopology;
  }): Promise<Endpoint> {
    const ep = await this.host.registerEndpoint({ accountId: a.accountId, topology: a.topology });
    this.endpoints.set(ep.id, ep);
    return ep;
  }

  setSinkMode(accountId: string, mode: "accept" | "refuse", consumeImmediately = false): void {
    this.sinkUnsubs.get(accountId)?.();
    const unsub = this.host.registerSinkHandler(accountId, {
      deliver: async (_rendered, envelope, grade) => {
        this.hooks.meshEvent("sink_received", {
          at: isoNow(),
          accountId,
          messageId: envelope.id,
          from: envelope.from,
          text: envelope.payload.text ?? null,
          grade,
          mode,
          consumeImmediately,
        });
        if (mode === "refuse") return { accepted: false };
        return { accepted: true, consumedImmediately: consumeImmediately };
      },
    });
    this.sinkUnsubs.set(accountId, unsub);
    this.sinkModes.set(accountId, mode);
  }

  async setPresence(
    accountId: string,
    state: PresenceState,
    opts?: { until?: string; reason?: string },
  ): Promise<void> {
    await this.host.setPresence(accountId, state, opts);
    this.presence.set(accountId, state);
  }

  lookup(q: { query?: string; capabilities?: string[]; limit?: number }): Promise<Account[]> {
    return this.host.lookup(q);
  }

  upsertContact(
    ownerId: string,
    peerId: string,
    opts?: { alias?: string; tags?: unknown },
  ): Promise<void> {
    return this.host.upsertContact(ownerId, peerId, opts);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 会话 / 成员
  // ═════════════════════════════════════════════════════════════════════════

  async ensureDirect(a: string, b: string): Promise<Conversation> {
    const c = await this.host.ensureDirect(a, b);
    this.conversations.set(c.id, c);
    return c;
  }

  async createConversation(c: {
    type: "group" | "topic" | "queue";
    creator: string;
    members?: string[];
    topic?: string;
    config?: Record<string, unknown>;
  }): Promise<Conversation> {
    const conv = await this.host.createConversation(c as Parameters<MeshHost["createConversation"]>[0]);
    this.conversations.set(conv.id, conv);
    return conv;
  }

  addMember(conv: string, account: string, opts?: { caps?: string[]; by?: string }): Promise<void> {
    return this.host.addMember(conv, account, opts as never);
  }

  removeMember(conv: string, account: string, by: string): Promise<void> {
    return this.host.removeMember(conv, account, { by });
  }

  join(conv: string, account: string): Promise<void> {
    return this.host.join(conv, account);
  }

  leave(conv: string, account: string): Promise<void> {
    return this.host.leave(conv, account);
  }

  setCaps(conv: string, account: string, caps: string[], by: string): Promise<void> {
    return this.host.setCaps(conv, account, caps as Cap[], by);
  }

  setTopic(conv: string, text: string, by: string): Promise<void> {
    return this.host.setTopic(conv, text, by);
  }

  setAnnouncement(conv: string, text: string, by: string): Promise<void> {
    return this.host.setAnnouncement(conv, text, by);
  }

  mute(conv: string, account: string, until: string): Promise<void> {
    return this.host.mute(conv, account, until);
  }

  dissolve(conv: string, by: string): Promise<void> {
    return this.host.dissolve(conv, by);
  }

  async upgradeToGroup(directConv: string, extra: string[], by: string): Promise<Conversation> {
    const g = await this.host.upgradeToGroup(directConv, extra, by);
    this.conversations.set(g.id, g);
    return g;
  }

  subscribe(conv: string, account: string): Promise<void> {
    return this.host.subscribe(conv, account);
  }
  unsubscribe(conv: string, account: string): Promise<void> {
    return this.host.unsubscribe(conv, account);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 发送 / 应答
  // ═════════════════════════════════════════════════════════════════════════

  send(m: {
    from: string;
    conversationId: string;
    kind?: string;
    expect?: string;
    text?: string;
    priority?: string;
    to?: string[];
    mentions?: string[];
    replyTo?: string;
  }): Promise<{ messageId: string; seq: number }> {
    return this.host.send({
      from: m.from,
      conversationId: m.conversationId,
      ...(m.kind ? { kind: m.kind as never } : {}),
      ...(m.expect ? { expect: m.expect as never } : {}),
      ...(m.text !== undefined ? { text: m.text } : {}),
      ...(m.priority ? { priority: m.priority as never } : {}),
      ...(m.to?.length ? { to: m.to } : {}),
      ...(m.mentions?.length ? { mentions: m.mentions } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    } as unknown as Parameters<typeof this.host.send>[0]);
  }

  async request(m: {
    from: string;
    conversationId: string;
    kind?: string;
    text?: string;
    to?: string[];
    blocking?: boolean;
  }): Promise<{ correlationId: string } | Record<string, unknown>> {
    const r = await this.host.request(
      {
        from: m.from,
        conversationId: m.conversationId,
        kind: (m.kind || "chat") as never,
        expect: "ack",
        ...(m.text !== undefined ? { text: m.text } : {}),
        ...(m.to?.length ? { to: m.to } : {}),
      },
      { await: m.blocking },
    );
    // AckResult 不可序列化（含 timestamp Date），归一化为 plain object
    if (r && typeof r === "object" && "ok" in r) return { ...(r as unknown as Record<string, unknown>) };
    return r;
  }
  ack(opts: { correlationId: string; from: string; data?: unknown; error?: string }): Promise<void> {
    return this.host.ack({ correlationId: opts.correlationId, from: opts.from, data: opts.data, error: opts.error });
  }
  claim(messageId: string, by: string): Promise<{ ok: boolean; leaseUntil?: string }> {
    return this.host.claim(messageId, by);
  }
  requeue(messageId: string, targetConversationId: string): Promise<void> {
    return this.host.requeue(messageId, targetConversationId);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 控制面 / 流
  // ═════════════════════════════════════════════════════════════════════════

  markConsumed(deliveryId: string): Promise<void> {
    return this.host.markConsumed(deliveryId);
  }

  async warm(endpointId: string, lease?: "shared" | "exclusive"): Promise<void> {
    await this.host.warm(endpointId, lease as never);
    const ep = this.endpoints.get(endpointId);
    if (ep) {
      ep.lease = (lease ?? "exclusive") as Endpoint["lease"];
      ep.leaseUntil = null;
      // warm 后即 hot（事件异步，这里同步投影保证"会话/端点"稳定）。
      ep.state = "hot";
    }
  }

  evict(endpointId: string): Promise<void> {
    return this.host.evict(endpointId);
  }

  nudge(
    endpointId: string,
    cue: string,
    opts?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean },
  ): Promise<void> {
    return this.host.nudge(endpointId, cue, opts as never);
  }

  injectContext(endpointId: string, text: string): void {
    this.host.injectContext(endpointId, text);
  }

  beforeClearQueue(endpointId: string): Promise<void> {
    return this.host.beforeClearQueue(endpointId);
  }

  toolSet(endpointId: string, only?: string[]): Array<Record<string, unknown>> {
    const defs = this.host.toolSet(endpointId, only as never);
    // ToolDefinition.execute 是函数，不可序列化 —— 只回传元数据。
    return defs.map((d) => ({
      name: d.name,
      label: d.label,
      description: d.description,
      promptSnippet: d.promptSnippet,
      promptGuidelines: d.promptGuidelines,
      parameters: d.parameters,
    }));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 观测（只读，直通 host.observer）
  // ═════════════════════════════════════════════════════════════════════════

  get observer() {
    return this.host.observer;
  }

  /** 首屏一次性铺满：实体投影 + counters + 验收比值。 */
  async snapshot(): Promise<Record<string, unknown>> {
    return {
      at: isoNow(),
      accounts: [...this.accounts.values()],
      endpoints: [...this.endpoints.values()],
      conversations: [...this.conversations.values()],
      presence: Object.fromEntries(this.presence),
      sinkModes: Object.fromEntries(this.sinkModes),
      counters: await this.safeCounters(),
      acceptance: await this.computeAcceptance(),
    };
  }

  /** 1s tick：counters + 顶点状态投影 + 验收比值（不跑不变量，避免高频 SQL）。 */
  async tick(): Promise<Record<string, unknown>> {
    return {
      at: isoNow(),
      counters: await this.safeCounters(),
      acceptance: await this.computeAcceptance(),
      endpoints: [...this.endpoints.values()].map((e) => ({
        endpointId: e.id,
        accountId: e.accountId,
        state: e.state,
        lease: e.lease,
        piSessionId: e.piSessionId,
      })),
    };
  }

  private async safeCounters(): Promise<Record<string, number>> {
    try {
      return await this.host.observer.counters();
    } catch {
      return {};
    }
  }

  // ── 验收（§24.2 公式，由 counters 现算）───────────────────────────────────

  async computeAcceptance(): Promise<Record<string, unknown>> {
    const c = await this.safeCounters();
    const messages = c.messages_total ?? 0;
    const deliveries = c.deliveries_total ?? 0;
    const idle = c.wake_per_message_idle ?? 0;
    const busy = c.wake_per_message_busy ?? 0;
    const verbatim = c.verbatim_copies ?? 0;
    const silent = c.silent_grade ?? 0;
    const cold = c.cold_hit ?? 0;

    const div = (num: number, den: number): number | null => (den > 0 ? num / den : null);
    const ratio = (value: number | null, ok: boolean | null, limit: string) => ({ value, ok, limit });

    return {
      messages,
      deliveries,
      counters: c,
      ratios: {
        avgWake: ratio(div(idle + busy, messages), div(idle + busy, messages) === null ? null : (idle + busy) / messages <= 1.2, "≤1.2"),
        busy: ratio(div(busy, messages), div(busy, messages) === null ? null : busy === 0, "=0"),
        verbatimPerMsg: ratio(div(verbatim, messages), div(verbatim, messages) === null ? null : verbatim / messages <= 3, "≤3"),
        silence: ratio(div(silent, deliveries), div(silent, deliveries) === null ? null : silent / deliveries > 0.5, ">0.5"),
        verbatimRate: ratio(div(verbatim, deliveries), div(verbatim, deliveries) === null ? null : verbatim / deliveries < 0.25, "<0.25"),
        coldHit: ratio(div(cold, silent), null, "— 越高越省"),
      },
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 群聊面板（注册 agent · 群组 · 多 agent 互聊）
  // ═════════════════════════════════════════════════════════════════════════

  /** 默认群聊会话（懒创建）。 */
  private async ensureChatGroup(): Promise<string> {
    if (this.chatGroupId) return this.chatGroupId;
    const members = this.rosterIds();
    const creator = members[0] ?? "system";
    const g = await this.createConversation({ type: "group", creator, members });
    this.chatGroupId = g.id;
    return g.id;
  }

  /** 注册一个聊天 agent（建账号 + 端点 + warm + 入群 + 记录人设）。 */
  async registerAgent(args: { displayName: string; persona?: string }): Promise<AgentInfo> {
    return this.registerAgentInternal(args.displayName, args.persona, false);
  }

  private async registerAgentInternal(displayName: string, persona: string | undefined, isSeed: boolean): Promise<AgentInfo> {
    const base = this.slug(displayName) || "agent";
    const id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const acc = await this.registerAccount({
      id,
      displayName: displayName || id,
      endpointClass: "stream",
      initiate: ["chat", "event", "task"],
    });
    const ep = await this.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
    await this.warm(ep.id, "shared");
    this.agentProfiles.set(id, { persona: persona || undefined, isSeed });
    const groupId = await this.ensureChatGroup();
    try {
      await this.addMember(groupId, id, { by: id });
    } catch {
      /* 群成员加入失败不致命 */
    }
    this.pushSystem(`${acc.displayName} 加入了群聊`);
    return { id, displayName: acc.displayName, persona: persona ?? "", isSeed, state: ep.state };
  }

  /** 首启：预置 3 个示例 agent，让群聊立即"活"起来（真实 LLM 驱动）。 */
  private async seedChatRoom(): Promise<void> {
    const seeds: Array<{ name: string; persona: string }> = [
      { name: "Alice", persona: "产品负责人，关注体验" },
      { name: "Bob", persona: "后端工程师，务实直接" },
      { name: "Carol", persona: "设计师，重视细节" },
    ];
    for (const s of seeds) await this.registerAgentInternal(s.name, s.persona, true);
    await this.ensureChatGroup();
    this.pushSystem("群聊已就绪 · 发一条消息，大家会用真实 LLM 接力回复 ✨");
  }

  /** 当前聊天 agent（stream 账号）id 列表。 */
  rosterIds(): string[] {
    return [...this.accounts.values()].filter((a) => a.endpointClass === "stream").map((a) => a.id);
  }

  /** 前端花名册。 */
  getRoster(): AgentInfo[] {
    return this.rosterIds().map((id) => {
      const a = this.accounts.get(id)!;
      const prof = this.agentProfiles.get(id);
      const ep = [...this.endpoints.values()].find((e) => e.accountId === id);
      return {
        id,
        displayName: a.displayName,
        persona: prof?.persona ?? "",
        isSeed: prof?.isSeed ?? false,
        state: ep?.state,
      };
    });
  }

  /** 群聊元信息（前端据此筛选 SSE 消息 + 渲染标题）。 */
  chatInfo(): { groupId?: string; topic: string } {
    return { groupId: this.chatGroupId, topic: "# lounge · 多 agent 群聊" };
  }

  /** 历史消息（首屏铺满）。 */
  getChatLog(): ChatEntry[] {
    return [...this.chatLog.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  /**
   * 以某 agent 身份在群里发一条消息；随后群里其它 agent 各自用真实 session
   * 生成一句回复并回发（有界：rounds × 其它 agent 数，绝不循环）。
   */
  async postToGroup(args: { asId: string; text: string; rounds?: number; to?: string }): Promise<{ messageId: string }> {
    const groupId = await this.ensureChatGroup();
    const text = (args.text || "").slice(0, 2000);
    if (!text.trim()) throw new Error("消息为空");

    // 定向：to 指定单个成员（须是群内、且非发送者本人）→ 仅该成员回一次；否则全体广播。
    const target =
      args.to && args.to !== args.asId && this.rosterIds().includes(args.to) ? args.to : undefined;

    const r = await this.send({
      from: args.asId,
      conversationId: groupId,
      kind: "chat",
      expect: "none",
      text,
      ...(target ? { to: [target] } : {}),
    });

    if (!this.chatBusy) {
      // 定向 → responders 只含被 @ 成员、且只回 1 条；全体 → 其余成员 × rounds 轮接力。
      const responders = target ? [target] : this.rosterIds().filter((id) => id !== args.asId);
      const rounds = target ? 1 : Math.max(0, Math.min(3, args.rounds ?? 1));
      if (responders.length > 0 && rounds > 0) {
        void this.runLiveChat(groupId, args.asId, text, responders, rounds).catch((e) => {
          console.error("[chat] runLiveChat failed:", e);
        });
      }
    }
    return { messageId: r.messageId };
  }

  private async runLiveChat(groupId: string, starterId: string, starterText: string, others: string[], rounds: number): Promise<void> {
    if (this.chatBusy) return;
    this.chatBusy = true;
    try {
      let lastText = starterText;
      let lastSpeaker = starterId;
      for (let r = 0; r < rounds; r++) {
        for (const responder of others) {
          const prompt = this.buildReplyPrompt(responder, lastText, lastSpeaker);
          const reply = await this.liveReply(responder, prompt);
          if (reply) {
            await this.send({ from: responder, conversationId: groupId, kind: "chat", expect: "none", text: reply });
            lastText = reply;
            lastSpeaker = responder;
            await sleepMs(250);
          }
        }
      }
    } finally {
      this.chatBusy = false;
    }
  }

  /** 为某 agent 拼接待 LLM 回复的提示词（人设 + 最近群聊上下文）。 */
  private buildReplyPrompt(responderId: string, _lastText: string, _lastSpeakerId: string): string {
    const responderName = this.accounts.get(responderId)?.displayName ?? responderId;
    const persona = this.agentProfiles.get(responderId)?.persona?.trim();
    const recent = [...this.chatLog.values()]
      .filter((m) => m.kind === "chat")
      .slice(-6)
      .map((m) => `${m.fromName}：${m.text}`)
      .join("\n");
    const roleLine = persona ? `你是「${responderName}」，${persona}。` : `你是「${responderName}」。`;
    return (
      `${roleLine}你们正在一个多 agent 群聊里，成员包括你和其他几个 agent。\n` +
      `最近的群聊记录：\n${recent}\n\n` +
      `请只以「${responderName}」的口吻，针对最新一条消息，用简体中文写一句自然的群聊回复（1–3 句）。` +
      `直接输出回复文字本身，不要调用任何工具，不要添加前缀或引号。`
    );
  }

  /** 用某 agent 的真实 session 生成一句回复（真实 LLM），返回纯文本或 null。 */
  private async liveReply(responderId: string, prompt: string): Promise<string | null> {
    const ep = this.endpointOfAccount(responderId);
    const session = ep ? (this.sessions.get(ep.id) as LiveReplySession | undefined) : undefined;
    if (!session) return null;
    // 只在 message_end 且 role=assistant 时取「完整」回复：流式增量事件不带 .message，
    // 早期实现按任意事件覆盖 pending，会把分块残片（如单个「？」）当成回复贴进群。
    let assistantText: string | null = null;
    let unsub: () => void = () => {};
    try {
      unsub = session.subscribe((ev) => {
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          const t = contentToText(ev.message.content);
          if (t && t.trim()) assistantText = t.trim();
        }
      });
    } catch {
      unsub = () => {};
    }
    try {
      // 触发一整轮并等待完成：followUp/steer 只入队（空闲 session 不会起轮，
      // waitForIdle 会秒退），prompt() 才真正调用 LLM 并 await 到 assistant 落定。
      await session.prompt(prompt);
      const reply = (assistantText ?? session.getLastAssistantText?.() ?? "").trim();
      // 只取第一段，避免把长思考/工具调用一并贴出
      const firstPara = reply.split(/\n{2,}/)[0]?.trim() ?? "";
      return firstPara || null;
    } catch (err) {
      console.error("[chat] liveReply failed for", responderId, err);
      return null;
    } finally {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
  }

  private endpointOfAccount(accountId: string): Endpoint | undefined {
    return [...this.endpoints.values()].find((e) => e.accountId === accountId);
  }

  /** 记录一条群聊消息（去重，按 id）。fromName 由内部按发送方派生，故入参无需携带。 */
  private pushChat(entry: Omit<ChatEntry, "fromName">): void {
    if (this.chatGroupId && entry.conversationId !== this.chatGroupId) return;
    if (this.chatLog.has(entry.id)) return;
    const name = this.accounts.get(entry.from)?.displayName ?? entry.from;
    this.chatLog.set(entry.id, { ...entry, fromName: name });
  }

  /** 系统提示（入群 / 就绪），居中渲染。 */
  private pushSystem(text: string): void {
    const id = `sys-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const entry: ChatEntry = { id, from: "system", fromName: "system", conversationId: this.chatGroupId ?? "", kind: "system", text, at: isoNow() };
    this.pushChat(entry);
    this.hooks.meshMessage({
      id,
      from: "system",
      conversationId: this.chatGroupId ?? "",
      kind: "system",
      at: isoNow(),
      payload: { text },
    } as unknown as Envelope);
  }

  private slug(s: string): string {
    const out = (s || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    return out || "agent";
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从 pi 会话消息的 content（string | 分块数组 | 对象）中抽取纯文本。 */
function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? ""))
      .join("");
  }
  if (typeof content === "object") {
    const c = content as { text?: string };
    if (typeof c.text === "string") return c.text;
    try {
      return JSON.stringify(c);
    } catch {
      return "";
    }
  }
  return String(content);
}

/**
 * demo 群聊接龙用到的 pi AgentSession 结构子集（真机由 createPiSessionFactory 产出）。
 * 事件与方法的形状对齐 pi-coding-agent/dist/core/agent-session：仅 message_end 事件
 * 携带完整的 event.message；waitForIdle/getLastAssistantText 是取整轮回复的稳定原语。
 */
interface LiveReplySession {
  subscribe(
    listener: (event: { type?: string; message?: { role?: string; content?: unknown } }) => void,
  ): () => void;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  getLastAssistantText?(): string | undefined;
}
