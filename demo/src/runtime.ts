// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 运行时控制器（全真实装配）。
//
// 一行 import 组装真实 MeshHost：createMesh 不填 streamPort/transport，由库自动
// 装配真实 PiStreamPort + InProcessTransport；createPiSessionFactory 注入真实
// Model（config 层已 fail-fast 校验）。无 faux、无 FakeStreamPort。
//
// MeshHost 没有「列出端点/会话」「读端点 piSessionId」的公开接口，故本控制器：
//  - 自记 accounts/endpoints/conversations/presence/sinkModes 投影；
//  - 给 sessionFactory 包一层以捕获每端点 piSessionId（Stream 页需要它）；
//  - 用 endpoint_state_changed / presence_changed 事件维持最新投影。
//
// 断言只在乎「唤醒决策」（投递时已落库），与 LLM 轮时延/成本无关 —— P0/P1
// 的验收比值由 counters 现算，确定性读得出来。
// ═══════════════════════════════════════════════════════════════════════════

import { createMesh, createPiSessionFactory } from "../../dist/index.js";
import type {
  Account,
  Cap,
  Conversation,
  DeliveryTrace,
  Endpoint,
  Grade,
  MeshEvents,
  MeshHost,
  PresenceState,
  SessionFactory,
  StreamTopology,
  Unsubscribe,
} from "../../dist/core/index.js";
import type { DemoConfig } from "./config.ts";

// ── 服务端回调（由 server.ts 注入；runtime 不感知 HTTP/SSE）─────────────────

export interface ScenarioFrame {
  name: "P0" | "P1";
  phase: string;
  step: string;
  ok: boolean;
  detail?: unknown;
}

export interface ControllerHooks {
  meshEvent(type: string, payload: unknown): void;
  scenario(frame: ScenarioFrame): void;
  delivery(payload: { messageId: string; traces: DeliveryTrace[] }): void;
}

const isoNow = () => new Date().toISOString();

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
    // 包一层捕获 piSessionId：open 恢复用的 id 在 ctx 上，create 的在返回值里。
    const controller = this;
    const sessionFactory: SessionFactory = {
      async create(ctx) {
        const r = await base.create(ctx);
        controller.captureSession(ctx.endpoint.id, r.piSessionId);
        return r;
      },
      async open(ctx) {
        controller.captureSession(ctx.endpoint.id, ctx.piSessionId);
        return base.open(ctx);
      },
    };
    this.host = await createMesh({
      dbPath: this.config.dbPath,
      policies: { sessionFactory },
      devMode: true,
    });
    this.wireEvents();
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
    this.host.on("message_routed", (p) => fwd("message_routed", p));
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
    });
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
    if (r && typeof r === "object" && "ok" in r) return { ...(r as Record<string, unknown>) };
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
  // 场景（P0 / P1）
  // ═════════════════════════════════════════════════════════════════════════

  async runScenario(name: "P0" | "P1"): Promise<void> {
    try {
      if (name === "P1") await this.p1();
      else await this.p0();
    } catch (err) {
      this.frame("场景异常中止", false, { error: serializeErrorLike(err) });
    }
  }

  private frame(step: string, ok: boolean, detail?: unknown, phase = ""): void {
    this.hooks.scenario({ name: phase.startsWith("P1") ? "P1" : "P0", phase, step, ok, detail });
  }

  private async waitForTrace(
    messageId: string,
    predicate: (t: DeliveryTrace) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const traces = await this.host.observer.trace(messageId);
        if (traces.some(predicate)) return true;
      } catch {
        // 尚未可见
      }
      if (Date.now() >= deadline) return false;
      await sleepMs(150);
    }
  }

  /**
   * P0（确定性、零 LLM 轮）：走真实 warm/投递/消费，但不唤起任何 LLM 轮。
   *  alice/bob 两 stream 账号 warm 后，alice 发 10 条 expect:none 逐条 markConsumed；
   *  worker(sink)+accept+consumeImmediately 自动 consumed 1 条；收尾 checkInvariants。
   */
  private async p0(): Promise<void> {
    const ids = `p0-${Date.now().toString(36)}`;
    const alice = `${ids}-alice`;
    const bob = `${ids}-bob`;
    const worker = `${ids}-worker`;

    this.frame("注册账号", true, { alice, bob, worker }, "P0 · 装配");
    await this.registerAccount({ id: alice, displayName: "Alice", endpointClass: "stream", initiate: ["chat"] });
    await this.registerAccount({ id: bob, displayName: "Bob", endpointClass: "stream", initiate: ["chat"] });
    await this.registerAccount({ id: worker, displayName: "Worker", endpointClass: "sink" });
    this.setSinkMode(worker, "accept", true);

    this.frame("warm alice+bob（真实冷起）", true, {}, "P0 · 装配");
    const aliceEp = await this.registerEndpoint({ accountId: alice, topology: { kind: "unified" } });
    const bobEp = await this.registerEndpoint({ accountId: bob, topology: { kind: "unified" } });
    await this.warm(aliceEp.id, "shared");
    await this.warm(bobEp.id, "shared");

    const dm = await this.ensureDirect(alice, bob);
    this.frame("确保直聊", true, { conversationId: dm.id }, "P0 · 装配");

    let consumed = 0;
    for (let i = 0; i < 10; i++) {
      const r = await this.send({ from: alice, conversationId: dm.id, kind: "chat", expect: "none", text: `hello ${i}` });
      const traces = await this.host.observer.trace(r.messageId);
      const target = traces.find((t) => t.accountId === bob);
      if (target) {
        await this.markConsumed(target.deliveryId);
        consumed++;
      }
    }

    // worker(sink) 自动 consumed 1 条（consumeImmediately:true）
    const dmw = await this.ensureDirect(alice, worker);
    const sinkMsg = await this.send({ from: alice, conversationId: dmw.id, kind: "chat", expect: "none", text: "sink auto-consume" });
    const sinkTraces = await this.host.observer.trace(sinkMsg.messageId);
    const sinkOk = sinkTraces.some((t) => t.accountId === worker && t.state === "consumed");

    const report = await this.host.observer.checkInvariants();
    this.frame("sink 自动 consumed", sinkOk, {}, "P0 · Sink");
    this.frame("checkInvariants", report.ok, {
      checked: report.checked,
      violations: report.violations.length,
      streamConsumed: consumed,
    }, "P0 · 验收");
    this.frame("P0 完成", report.ok && sinkOk, { streamConsumed: consumed }, "P0 · 验收");
  }

  /**
   * P1（§25.2）：20 账号群 × 50 条。47 条 expect:none 广播（silent→冷→cold_hit，
   * 零轮、确定性）+ 3 条 to:[不同冷成员] expect:reply（各自精确唤醒 1 条 idle 流，
   * 共 ≤3 真实轮）。断言读 counters，不看墙钟。
   */
  private async p1(): Promise<void> {
    const ids = `p1-${Date.now().toString(36)}`;
    const N = 20;
    const members = Array.from({ length: N }, (_, i) => `${ids}-g${i}`);

    this.frame("注册 20 账号 + 建群", true, { N }, "P1 · 装配");
    for (const m of members) {
      await this.registerAccount({ id: m, displayName: `G-${m.slice(-5)}`, endpointClass: "stream", initiate: ["chat"] });
    }
    const g = await this.createConversation({ type: "group", creator: members[0]!, members: members.slice(1) });
    this.frame("群已建", true, { conversationId: g.id, members: N }, "P1 · 装配");

    for (let i = 0; i < 47; i++) {
      await this.send({ from: members[0]!, conversationId: g.id, kind: "chat", expect: "none", text: `broadcast ${i}` });
    }
    this.frame("47 条 expect:none 广播完成（零唤醒）", true, {}, "P1 · 广播");

    const responders = [members[1]!, members[2]!, members[3]!];
    const repIds: Array<{ id: string; responder: string }> = [];
    for (const responder of responders) {
      const r = await this.send({
        from: members[0]!,
        conversationId: g.id,
        kind: "chat",
        expect: "reply",
        to: [responder],
        text: `please reply (to ${responder.slice(-5)})`,
      });
      repIds.push({ id: r.messageId, responder });
    }
    this.frame("3 条 expect:reply 已发（真实轮次进行中）", true, { responders: responders.map((x) => x.slice(-5)) }, "P1 · 唤醒");

    for (const { id, responder } of repIds) {
      // 唤醒决策在投递时已落库：只等 trace 出现 woke=true（快速），不等轮次跑完。
      const woke = await this.waitForTrace(id, (t) => t.accountId === responder && t.woke === true, 20000);
      this.frame(`reply→${responder.slice(-5)} 唤醒已投递`, woke, {}, "P1 · 唤醒");
    }

    const report = await this.host.observer.checkInvariants();
    const acc = await this.computeAcceptance();
    this.frame("checkInvariants", report.ok, { checked: report.checked, violations: report.violations.length }, "P1 · 验收");
    this.frame("P1 完成", report.ok, { acceptance: acc }, "P1 · 验收");
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ErrorLike {
  name: string;
  message: string;
  code?: string;
}

function serializeErrorLike(err: unknown): ErrorLike {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return { name: err.name, message: err.message, ...(code ? { code } : {}) };
  }
  return { name: "Error", message: String(err) };
}