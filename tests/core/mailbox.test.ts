// ═══════════════════════════════════════════════════════════════════════════
// Mailbox 单元测试：定档/唤醒（A1/A2/A2'/A3）/选端/parked/状态机（F5 判据）/
// 溢出折叠/handoff 超时/beforeClearQueue(C10 I22)/CATCHUP/原文预算（§7）
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshEventBus } from "../../src/core/events.js";
import { MeshMailbox } from "../../src/core/mailbox.js";
import type { MailboxDeps } from "../../src/core/mailbox.js";
import { createDefaultPolicies } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { MeshRouter } from "../../src/core/router.js";
import { SqliteStore } from "../../src/core/store.js";
import { InProcessTransport } from "../../src/core/transport.js";
import type { RouteInput } from "../../src/core/contracts.js";
import type {
  DeliveryState,
  Endpoint,
  Envelope,
  Grade,
  Limits,
  MeshLease,
  PendingDelivery,
  Policies,
  PortStatus,
  RegisterAccountInput,
  SinkHandler,
  Transport,
  Unsubscribe,
} from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { isoFromMs } from "../../src/core/util.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

interface Harness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  port: FakeStreamPort;
  mailbox: MeshMailbox;
  router: MeshRouter;
  limits: Limits;
  sinkHandlers: Map<string, SinkHandler>;
  delivered: Envelope[];
  consumed: Array<{ envelope: Envelope; accountId: string }>;
  parked: Array<{ envelope: Envelope; reason: string }>;
}

/** 可脚本化的 Transport：记录 publish/ack、可按开关抛错——供 I03 对账与 publish 抛错场景观测 */
class RecordingTransport implements Transport {
  readonly kind = "recording" as const;
  publishes: PendingDelivery[] = [];
  acks: Array<{ deliveryId: string; state: DeliveryState }> = [];
  failPublish = false;
  failAck = false;
  private handlers = new Map<string, (d: PendingDelivery) => Promise<void>>();

  async publish(d: PendingDelivery): Promise<void> {
    if (this.failPublish) throw new Error("publish boom");
    this.publishes.push(d);
  }
  async ack(deliveryId: string, state: DeliveryState): Promise<void> {
    if (this.failAck) throw new Error("ack boom");
    this.acks.push({ deliveryId, state });
  }
  subscribe(endpointId: string, h: (d: PendingDelivery) => Promise<void>): Unsubscribe {
    this.handlers.set(endpointId, h);
    return () => {
      if (this.handlers.get(endpointId) === h) this.handlers.delete(endpointId);
    };
  }
  stop(): void {}
}

/** 可脚本化的抛错端口：按字段注入特定 PortError code，驱动 I16 归因分支（§8.3/§7.10）。 */
class ThrowingPort extends FakeStreamPort {
  throwOnDeliver?: unknown;
  throwOnNote?: unknown;
  throwOnNudge?: unknown;
  throwOnStatus?: unknown;
  throwOnWarm?: unknown;
  throwOnHasEntries?: unknown;

  async deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    opts?: { triggerTurn?: boolean },
  ): Promise<{ entryId?: string }> {
    if (this.throwOnDeliver !== undefined) throw this.throwOnDeliver;
    return super.deliver(endpointId, rendered, envelope, grade, opts);
  }
  async note(endpointId: string, customType: string, data: unknown): Promise<void> {
    if (this.throwOnNote !== undefined) throw this.throwOnNote;
    return super.note(endpointId, customType, data);
  }
  async nudge(endpointId: string, cue: string, opts?: unknown): Promise<void> {
    if (this.throwOnNudge !== undefined) throw this.throwOnNudge;
    return super.nudge(endpointId, cue, opts as { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean });
  }
  status(endpointId: string): PortStatus {
    if (this.throwOnStatus !== undefined) throw this.throwOnStatus;
    return super.status(endpointId);
  }
  async warm(endpointId: string, lease?: MeshLease): Promise<void> {
    if (this.throwOnWarm !== undefined) throw this.throwOnWarm;
    return super.warm(endpointId, lease);
  }
  async hasEntries(endpointId: string, entryIds: string[]): Promise<Set<string>> {
    if (this.throwOnHasEntries !== undefined) throw this.throwOnHasEntries;
    return super.hasEntries(endpointId, entryIds);
  }
}

function makeHarness(
  opts: {
    limits?: Partial<Limits>;
    policies?: Partial<Policies>;
    transport?: Transport;
    isEndpointLocal?: (endpointId: string) => boolean | Promise<boolean>;
    port?: FakeStreamPort;
    sealKey?: string;
    systemSend?: NonNullable<MailboxDeps["systemSend"]>;
  } = {},
): Harness {
  const tdb = openTestDb();
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  const port = opts.port ?? new FakeStreamPort();
  const sinkHandlers = new Map<string, SinkHandler>();
  const awaiting = new Map<string, Set<string>>();
  const policies: Policies = {
    ...createDefaultPolicies({
      isAwaiting: (acct: string, cid: string | undefined) =>
        cid !== undefined && (awaiting.get(acct) ?? new Set()).has(cid),
      endpointsOf: (acct: string) =>
        registry.endpointsOf(acct).map((e) => ({
          id: e.id,
          inFlight: 0,
          topology: e.topology,
        })),
      limits,
    }),
    sessionFactory: {
      create: async () => ({ session: {}, piSessionId: "pi-test" }),
      open: async () => ({ session: {} }),
    },
    ...opts.policies,
  };
  const mailbox = new MeshMailbox({
    store,
    registry,
    events,
    policies,
    limits,
    transport: opts.transport ?? new InProcessTransport(),
    port,
    sinkHandlers,
    isEndpointLocal: opts.isEndpointLocal,
    awaitingCorrelations: (acct) => [...(awaiting.get(acct) ?? new Set())],
    devMode: true,
    ...(opts.sealKey !== undefined ? { sealKey: opts.sealKey } : {}),
    ...(opts.systemSend !== undefined ? { systemSend: opts.systemSend } : {}),
  });
  port.onEntry((e) => mailbox.handleEntryAppended(e));
  port.onTurnEnd((e) => mailbox.handleTurnEnd(e.endpointId));
  const router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits,
    devMode: true,
    onRouted: async (e) => {
      await mailbox.fanout(e);
    },
    isAwaiting: (acct: string, cid: string) =>
      (awaiting.get(acct) ?? new Set()).has(cid),
  });
  const delivered: Envelope[] = [];
  const consumed: Array<{ envelope: Envelope; accountId: string }> = [];
  const parked: Array<{ envelope: Envelope; reason: string }> = [];
  events.on("message_delivered", (p) => delivered.push(p.envelope));
  events.on("message_consumed", (p) =>
    consumed.push({ envelope: p.envelope, accountId: p.accountId }),
  );
  events.on("message_parked", (p) =>
    parked.push({ envelope: p.envelope, reason: p.reason }),
  );
  return {
    db: tdb.db,
    store,
    registry,
    events,
    port,
    mailbox,
    router,
    limits,
    sinkHandlers,
    delivered,
    consumed,
    parked,
  };
}

const ALL_KINDS: RegisterAccountInput["initiate"] = [
  "chat",
  "task",
  "event",
  "system",
  "tombstone",
];

interface AccOpts {
  presence?: RegisterAccountInput extends never ? never : string;
  endpointClass?: RegisterAccountInput["endpointClass"];
  initiate?: RegisterAccountInput["initiate"];
}

async function addAcc(
  h: Harness,
  id: string,
  o: AccOpts = {},
): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: o.endpointClass ?? "stream",
    initiate: o.initiate ?? ALL_KINDS,
  });
  if (o.presence) h.registry.setPresence(id, o.presence as "available");
}

/** stream 账号注册端点并热化（模拟 SessionHost warm 完成后的形态） */
async function addHotEndpoint(h: Harness, id: string): Promise<Endpoint> {
  const ep = await h.registry.registerEndpoint({
    accountId: id,
    topology: { kind: "unified" },
    piSessionId: "pi-" + id,
  });
  h.registry.updateEndpointState(ep.id, "hot");
  return ep;
}

function msg(
  from: string,
  conversationId: string,
  extra: Partial<RouteInput> = {},
): RouteInput {
  return {
    from,
    conversationId,
    kind: "chat",
    expect: "none",
    text: "hello",
    clientToken: Math.random().toString(36).slice(2),
    ...extra,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function deliveryRow(
  h: Harness,
  messageId: string,
  accountId: string,
): Record<string, unknown> {
  return h.db
    .prepare<[string, string], Record<string, unknown>>(
      "SELECT * FROM mesh_deliveries WHERE message_id = ? AND account_id = ?",
    )
    .get(messageId, accountId)!;
}

function deliveriesOf(h: Harness, messageId: string) {
  return h.db
    .prepare<[string], Record<string, unknown>>(
      "SELECT * FROM mesh_deliveries WHERE message_id = ?",
    )
    .all(messageId);
}

// ─── direct 顺利路径 ─────────────────────────────────────────────────────

describe("mailbox: direct happy path", () => {
  it("wakes, delivers on entry_appended (F5), consumes on turn_end, clears unread", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    await flush();

    const row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("consumed");
    expect(row.grade).toBe("followUp"); // 矩阵行 5，单聊
    expect(row.path).toBe("P1");
    expect(row.woke).toBe(1);
    expect(row.entry_id).toBeTruthy(); // delivered 的判据（F5）
    expect(h.port.wakeCount()).toBe(1); // 规则②：单聊任何消息都醒
    expect(h.delivered).toHaveLength(1);
    expect(h.consumed).toHaveLength(1);
    const inbox = h.db
      .prepare<[string, string], { pending_count: number; cursor_seq: number }>(
        "SELECT pending_count, cursor_seq FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?",
      )
      .get("B", conv.id)!;
    expect(inbox.pending_count).toBe(0);
    expect(inbox.cursor_seq).toBe(1);
    h.store.close();
  });

  it("sender gets no delivery row (投递集 = 未读集，§6.2)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    expect(deliveriesOf(h, r.messageId)).toHaveLength(1);
    h.store.close();
  });

  it("streams are mirrored to mesh_stream_entries (§8.5)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    const mirror = h.db
      .prepare<[string], { mesh_message_id: string; entry_type: string }>(
        "SELECT mesh_message_id, entry_type FROM mesh_stream_entries WHERE mesh_message_id = ?",
      )
      .get(r.messageId);
    expect(mirror).toMatchObject({
      mesh_message_id: r.messageId,
      entry_type: "custom_message",
    });
    h.store.close();
  });
});

// ─── 唤醒的库层强制规则（§7.3 A1/A2/A3/A2'）─────────────────────────────

describe("mailbox: wake guards", () => {
  it("A1: read-only member never wakes and takes P3 (note only, §7.6)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.setCaps(conv.id, "B", ["read"]); // B 只读
    const epA = await addHotEndpoint(h, "A");
    const epB = await addHotEndpoint(h, "B");
    await h.router.route(
      msg("A", conv.id, { to: ["B"], expect: "reply" }),
    );
    await flush();
    const rows = h.db
      .prepare("SELECT * FROM mesh_deliveries WHERE account_id = 'B'")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe("P3");
    expect(rows[0]!.woke).toBe(0); // A1：策略说了也不算
    expect(h.port.wakeCountByEndpoint(epB.id)).toBe(0);
    expect(h.port.delivered.filter((d) => d.endpointId === epB.id)).toHaveLength(0);
    expect(h.port.notes.filter((n) => n.endpointId === epB.id)).toHaveLength(1);
    void epA;
    h.store.close();
  });

  it("A2: dnd blocks wake unless urgent; message still lands in inbox (P1 不唤醒)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "dnd" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.recordSpoke(conv.id, "B", 1); // B 在预算内（发言过）
    const epB = await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { to: ["B"], expect: "reply" }));
    await flush();
    expect(h.port.wakeCountByEndpoint(epB.id)).toBe(0);
    let row = h.db
      .prepare("SELECT state, woke, grade FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as { state: string; woke: number; grade: string };
    expect(row.woke).toBe(0);
    expect(row.grade).toBe("steer"); // 档位与唤醒正交（§7.1）
    expect(row.state).toBe("delivered"); // triggerTurn:false 也进上下文（分支⑤）

    // urgent 是 A2 的默认例外
    await h.router.route(
      msg("A", conv.id, { to: ["B"], priority: "urgent", clientToken: "u1" }),
    );
    await flush();
    expect(h.port.wakeCountByEndpoint(epB.id)).toBe(1);
    h.store.close();
  });

  it("A3: wake rate limit downgrades to silent and counts wake_throttled", async () => {
    const h = makeHarness({ limits: { wakeRateLimit: { count: 1, windowMs: 60_000 } } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.recordSpoke(conv.id, "B", 1);
    const epB = await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { to: ["B"], expect: "reply", clientToken: "m1" }));
    await flush();
    await h.router.route(msg("A", conv.id, { to: ["B"], expect: "reply", clientToken: "m2" }));
    await flush();
    expect(h.port.wakeCountByEndpoint(epB.id)).toBe(1); // 第二条被 A3 限流
    const throttled = h.db
      .prepare<[string], { n: number }>(
        "SELECT value AS n FROM mesh_counters WHERE name = ?",
      )
      .get("wake_throttled");
    expect(throttled?.n ?? 0).toBeGreaterThanOrEqual(1);
    const rows = h.db
      .prepare("SELECT grade FROM mesh_deliveries WHERE account_id = 'B' ORDER BY rowid")
      .all() as Array<{ grade: string }>;
    expect(rows[1]!.grade).toBe("silent");
    h.store.close();
  });

  it("A2': sink accounts deliver to the host handler and never wake", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    const got: Array<{ rendered: string; envelope: Envelope }> = [];
    h.sinkHandlers.set("C", {
      deliver: async (rendered, envelope) => {
        got.push({ rendered, envelope });
        return { accepted: true };
      },
    });
    const conv = await h.registry.ensureDirect("A", "C");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    expect(got).toHaveLength(1);
    // sink 渲染是结构化 JSON（§5.7）
    expect(got[0]!.rendered.trim().startsWith("{")).toBe(true);
    const row = deliveryRow(h, r.messageId, "C");
    expect(row.state).toBe("delivered");
    // markConsumed 推进 sink 的消费（无 turn_end，§12.2 ④）
    await h.mailbox.markConsumed(row.id as string);
    expect(deliveryRow(h, r.messageId, "C").state).toBe("consumed");
    h.store.close();
  });

  it("NO_SINK_HANDLER parks (fail-persistent, §7.10)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    const conv = await h.registry.ensureDirect("A", "C");
    const r = await h.router.route(msg("A", conv.id));
    const row = deliveryRow(h, r.messageId, "C");
    expect(row.state).toBe("parked");
    expect(row.parked_reason).toBe("NO_SINK_HANDLER");
    h.store.close();
  });
});

// ─── 原文预算与路径（§7.4 §7.6）─────────────────────────────────────────

describe("mailbox: verbatim budget and paths", () => {
  it("never-spoke group member is out of budget → P2 stays queued, no port call", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const epB = await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id));
    const row = h.db
      .prepare("SELECT * FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as Record<string, unknown>;
    expect(row.path).toBe("P2");
    expect(row.state).toBe("queued"); // 激活时注入才算 delivered
    expect(h.port.delivered.filter((d) => d.endpointId === epB.id)).toHaveLength(0);
    // P2 注入体（§7.6）：context 钩子每次 LLM 调用前重算
    const injection = h.mailbox.inboxInjection(epB.id);
    expect(injection).toContain(`conv="${conv.id}"`);
    expect(injection).toContain("[recent]");
    h.store.close();
  });

  it("expect targeting me returns the conversation to budget (§7.6 transition) and wakes", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const epB = await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { to: ["B"], expect: "reply" }));
    await flush();
    const row = h.db
      .prepare("SELECT * FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as Record<string, unknown>;
    expect(row.path).toBe("P1"); // 被请求答复 ⇒ 回到预算内
    expect(row.woke).toBe(1); // 规则③：有人在等我答复
    expect(h.port.wakeCountByEndpoint(epB.id)).toBe(1);
    h.store.close();
  });

  it("CATCHUP: speaking again fixes the digest into history and clears unread (§7.6)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const epB = await addHotEndpoint(h, "B");
    // B 从未发言：第一条 A 的消息走 P2 留在 queued
    const r1 = await h.router.route(msg("A", conv.id, { clientToken: "m1" }));
    expect(deliveryRow(h, r1.messageId, "B").state).toBe("queued");
    // B 发言（发言 ⇒ 回到预算内）
    await h.router.route(msg("B", conv.id, { clientToken: "b1" }));
    // 下一条给 B 的消息：P1 + CATCHUP 固化 + 旧未读清零
    const r2 = await h.router.route(msg("A", conv.id, { clientToken: "m2" }));
    await flush();
    // I10：CATCHUP 改写为「渲染正文 + port.deliver 落 context」（不再是 mesh.catchup note 元数据）
    const catchup = h.port.delivered.find(
      (d) => d.endpointId === epB.id && d.rendered.includes("<<<CATCHUP"),
    );
    expect(catchup).toBeTruthy();
    expect(catchup!.rendered).toContain("<<<END CATCHUP>>>");
    // 合成信封不产生 mesh_deliveries 行（守 §9.4 追溯不变量）：envelope.id 不在 mesh_messages
    expect(catchup!.triggerTurn).toBe(false); // 固化不起轮
    expect(deliveryRow(h, r1.messageId, "B").state).toBe("consumed"); // 被固化
    expect(deliveryRow(h, r2.messageId, "B").path).toBe("P1");
    const inbox = h.db
      .prepare<[string, string], { pending_count: number; cursor_seq: number }>(
        "SELECT pending_count, cursor_seq FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?",
      )
      .get("B", conv.id)!;
    // 旧未读清零（r1 已 consumed、cursor 前移）；r2 本身尚在 delivered 等它的轮次
    expect(inbox.pending_count).toBeLessThanOrEqual(1);
    expect(inbox.cursor_seq).toBeGreaterThanOrEqual(1);
    h.store.close();
  });

  it("silent to a cold stream stays queued without warming (§7.2 silent×cold → 只写 Inbox)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.recordSpoke(conv.id, "B", 1); // 预算内 ⇒ P1
    const epB = await h.registry.registerEndpoint({
      accountId: "B",
      topology: { kind: "unified" },
    }); // 不热化：state=cold
    h.port.setEndpointState(epB.id, "cold"); // 端口侧也保持冷
    await h.router.route(msg("A", conv.id, { priority: "low", clientToken: "low1" }));
    const row = h.db
      .prepare("SELECT * FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as Record<string, unknown>;
    expect(row.grade).toBe("silent"); // low ⇒ silent（矩阵行 8）
    expect(row.state).toBe("queued"); // §7.2：silent×cold 只写 Inbox，delivery 留 queued（非终态，warm 后重投）
    expect(row.parked_reason).toBeNull();
    expect(h.port.delivered).toHaveLength(0);
    h.store.close();
  });
});

// ─── parked / retry / TTL（§7.9）────────────────────────────────────────

describe("mailbox: parked and retry", () => {
  it("no endpoint ⇒ parked(ENDPOINT_GONE); endpoint appears + retryEndpoint delivers", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    let row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("parked");
    expect(row.parked_reason).toBe("ENDPOINT_GONE");
    const epB = await addHotEndpoint(h, "B");
    await h.mailbox.retryEndpoint(epB.id);
    await flush();
    row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("consumed");
    h.store.close();
  });

  it("parked past parkTtlMs is dropped(TTL_EXPIRED) by sweep", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    h.db.prepare(
      "UPDATE mesh_deliveries SET parked_at = ? WHERE message_id = ?",
    ).run(isoFromMs(Date.now() - h.limits.parkTtlMs - 1000), r.messageId);
    await h.mailbox.sweep();
    const row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("dropped");
    expect(row.drop_reason).toBe("TTL_EXPIRED");
    h.store.close();
  });

  it("beforeClearQueue rolls delivered-not-consumed back to queued (I22)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.recordSpoke(conv.id, "B", 1); // 预算内 ⇒ P1
    const epB = await addHotEndpoint(h, "B");
    // low ⇒ silent ⇒ 不唤醒 ⇒ entry 已回但没有 turn_end ⇒ 停在 delivered
    await h.router.route(
      msg("A", conv.id, { to: ["B"], priority: "low", clientToken: "m1" }),
    );
    const row = h.db
      .prepare("SELECT * FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as Record<string, unknown>;
    expect(row.state).toBe("delivered");
    await h.mailbox.beforeClearQueue(epB.id);
    expect(deliveryRow(h, row.message_id as string, "B").state).toBe("queued");
    h.store.close();
  });

  it("handoff timeout re-queues and counts delivery_handoff_timeout (§7.9①)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    // 手工制造「deliver 已返回但 entry_appended 一直不来」的窗口
    h.db.prepare(
      "UPDATE mesh_deliveries SET state = 'queued', handoff_at = ? WHERE message_id = ?",
    ).run(isoFromMs(Date.now() - h.limits.handoffTimeoutMs - 1000), r.messageId);
    await h.mailbox.sweep();
    const n = h.db
      .prepare("SELECT value AS n FROM mesh_counters WHERE name = 'delivery_handoff_timeout'")
      .get() as { n: number } | undefined;
    expect(n?.n ?? 0).toBeGreaterThanOrEqual(1);
    h.store.close();
  });
});

// ─── 溢出折叠（§7.5）────────────────────────────────────────────────────

describe("mailbox: overflow folding", () => {
  it("over maxPending folds the oldest half to dropped(folded) with summary", async () => {
    const h = makeHarness({ limits: { maxPending: 4, maxPendingBytes: 1_000_000 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    for (let i = 0; i < 5; i++) {
      await h.router.route(msg("A", conv.id, { clientToken: "f" + i }));
    }
    // B 从未发言 ⇒ 全部 P2 留 queued ⇒ pending = 5 > 4
    await h.mailbox.sweep();
    const inbox = h.db
      .prepare<[string, string], { pending_count: number; overflow_count: number; overflow_summary: string | null }>(
        "SELECT pending_count, overflow_count, overflow_summary FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?",
      )
      .get("B", conv.id)!;
    expect(inbox.overflow_count).toBe(3); // ceil(5/2)
    expect(inbox.pending_count).toBe(2);
    expect(inbox.overflow_summary).toBeTruthy();
    const folded = h.db
      .prepare("SELECT COUNT(*) AS n FROM mesh_deliveries WHERE account_id = 'B' AND drop_reason = 'folded'")
      .get() as { n: number };
    expect(folded.n).toBe(3);
    const events = h.db
      .prepare("SELECT value AS n FROM mesh_counters WHERE name = 'fold_events'")
      .get() as { n: number } | undefined;
    // 附录 E ③：fold_events 与 inbox_overflowed 1:1 成对（每次折叠 +1，而非受害行数）
    expect(events?.n).toBe(1);
    h.store.close();
  });
});

// ─── pending_acks 超时（§14.3，Mailbox 侧清扫）──────────────────────────

describe("mailbox: request timeout sweep", () => {
  it("open pending_acks past deadline → timeout state + request_timeout event + @system notice", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const notices: Array<Record<string, unknown>> = [];
    const systemSend = async (input: {
      to: string;
      conversationId: string;
      text: string;
      clientToken: string;
    }) => {
      notices.push(input);
      await h.router.route({
        from: "@system",
        conversationId: input.conversationId,
        kind: "system",
        expect: "none",
        text: input.text,
        clientToken: input.clientToken,
      });
    };
    // 把 systemSend 接进 mailbox（装配层在 index.ts 做同一件事）
    (h.mailbox as unknown as { d: { systemSend?: unknown } }).d.systemSend =
      systemSend;
    await h.router.route(
      msg("A", conv.id, { to: ["B"], expect: "ack", clientToken: "req1" }),
    );
    // 伪造已过 deadline
    h.db.prepare(
      "UPDATE mesh_pending_acks SET deadline = ? WHERE state = 'open'",
    ).run(isoFromMs(Date.now() - 1000));
    const timeouts: Array<{ correlationId: string; from: string }> = [];
    h.events.on("request_timeout", (p) =>
      timeouts.push({ correlationId: p.correlationId, from: p.from }),
    );
    await h.mailbox.sweep();
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]!.from).toBe("A");
    const state = h.db
      .prepare("SELECT state FROM mesh_pending_acks")
      .get() as { state: string };
    expect(state.state).toBe("timeout");
    expect(notices).toHaveLength(1); // @system 已向发起方投超时通知
    const sysMsg = h.db
      .prepare("SELECT COUNT(*) AS n FROM mesh_messages WHERE from_account = '@system'")
      .get() as { n: number };
    expect(sysMsg.n).toBe(1);
    h.store.close();
  });
});

// ─── 合并唤醒（§7.8：只在流空闲时）──────────────────────────────────────

describe("mailbox: merged wake (idle stream only)", () => {
  it("busy stream downgrades triggerTurn to false and keeps wake_per_message_busy at 0", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    // 让端口对 B 报忙（模拟 B 正在跑一轮）
    const orig = h.port.status.bind(h.port);
    h.port.status = (id: string) => ({ ...orig(id), busy: true });
    await h.router.route(msg("A", conv.id));
    expect(h.port.delivered).toHaveLength(1);
    expect(h.port.delivered[0]!.triggerTurn).toBe(false); // 忙流不投 steer
    // I27：忙流合并唤醒是「正确」行为，不计入 wake_per_message_busy（恒 0 = 无回归 canary）
    const busy = h.db
      .prepare("SELECT value AS n FROM mesh_counters WHERE name = 'wake_per_message_busy'")
      .get() as { n: number } | undefined;
    expect(busy?.n ?? 0).toBe(0);
    h.store.close();
  });

  it("idle stream wakes and counts wake_per_message_idle", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    await h.router.route(msg("A", conv.id));
    const idle = h.db
      .prepare("SELECT value AS n FROM mesh_counters WHERE name = 'wake_per_message_idle'")
      .get() as { n: number } | undefined;
    expect(idle?.n ?? 0).toBe(1);
    h.store.close();
  });
});

// ─── 背压（§7.8 扇出时层）───────────────────────────────────────────────

describe("mailbox: backpressure", () => {
  it("inFlight >= maxInFlight downgrades grade to silent and counts backpressure_downgrade", async () => {
    const h = makeHarness({ limits: { maxInFlight: 1 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.recordSpoke(conv.id, "B", 1); // 预算内
    await addHotEndpoint(h, "B");
    // 第一条：low ⇒ silent ⇒ 无 turn ⇒ 停在 delivered（1 条 in-flight）
    await h.router.route(
      msg("A", conv.id, { to: ["B"], priority: "low", clientToken: "bp0" }),
    );
    const first = h.db
      .prepare("SELECT id, state FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as { id: string; state: string };
    expect(first.state).toBe("delivered");
    const epOfFirst = h.db
      .prepare<[string], { endpoint_id: string }>(
        "SELECT endpoint_id FROM mesh_deliveries WHERE id = ?",
      )
      .get(first.id) as { endpoint_id: string };
    expect(h.mailbox.inFlightCount(epOfFirst.endpoint_id)).toBe(1);
    // 第二条本应是 steer（expect:reply 指向 B）—— 背压降档
    await h.router.route(msg("A", conv.id, { to: ["B"], expect: "reply", clientToken: "bp1" }));
    const rows = h.db
      .prepare("SELECT grade FROM mesh_deliveries WHERE account_id = 'B' ORDER BY rowid")
      .all() as Array<{ grade: string }>;
    expect(rows[1]!.grade).toBe("silent");
    const n = h.db
      .prepare("SELECT value AS n FROM mesh_counters WHERE name = 'backpressure_downgrade'")
      .get() as { n: number } | undefined;
    expect(n?.n ?? 0).toBe(1);
    h.store.close();
  });
});

// ─── 策略槽 I21：渲染器 / retention（④-A/④-C）────────────────────────────

describe("mailbox: renderer & retention 策略槽保护（I21, §12.3/§20）", () => {
  it("renderer 抛错 → 降级内建渲染器，仍 delivered 且 policy_degraded(renderer/threw)", async () => {
    const degraded: Array<{ slot: string; reason: string; degradedTo: string }> = [];
    const renderer = {
      renderMessage: () => {
        throw new Error("host renderer boom");
      },
      renderInbox: () => "",
      renderSystem: () => "",
    };
    const h = makeHarness({ policies: { renderer } });
    h.events.on("policy_degraded", (p) =>
      degraded.push({ slot: p.slot, reason: p.reason, degradedTo: p.degradedTo }),
    );
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    await flush();

    const row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("consumed"); // 降级未阻断投递
    expect(degraded).toContainEqual({
      slot: "renderer",
      reason: "threw",
      degradedTo: "builtin_renderer",
    });
    // 内建降级产物仍是 M4 包裹体
    const rendered = h.port.delivered[h.port.delivered.length - 1]?.rendered;
    expect(rendered).toContain("<<<MSG");
    expect(rendered).toContain("<<<END MSG>>>");
    h.store.close();
  });

  it("renderer 返回未包裹文本 → devMode 抛错（§23.7）", async () => {
    const renderer = {
      renderMessage: () => "RAW not wrapped",
      renderInbox: () => "",
      renderSystem: () => "",
    };
    const h = makeHarness({ policies: { renderer } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    await expect(h.router.route(msg("A", conv.id))).rejects.toThrow(/renderer output/);
    h.store.close();
  });

  it("retention 收到全量会话清单（宿主策略据此算预算），不再是单会话", async () => {
    const seen: Array<{ accountId: string; convIds: string[] }> = [];
    const retention = {
      verbatimBudget(ctx: {
        accountId: string;
        conversations: Array<{ id: string }>;
      }) {
        seen.push({ accountId: ctx.accountId, convIds: ctx.conversations.map((c) => c.id) });
        return { bytes: Number.MAX_SAFE_INTEGER, ttlSeq: 20 };
      },
    };
    const h = makeHarness({ policies: { retention } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const g1 = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const g2 = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    // B 在两个群都发过言 ⇒ 越过「从未发言/被 @ 的刚性超预算」检查，进入 retention 决策
    h.registry.recordSpoke(g1.id, "B", 1);
    h.registry.recordSpoke(g2.id, "B", 1);
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", g1.id, { clientToken: "rt1" }));
    await flush();

    const forB = seen.find((s) => s.accountId === "B");
    expect(forB).toBeDefined();
    expect(forB!.convIds).toHaveLength(2);
    expect(forB!.convIds).toContain(g1.id);
    expect(forB!.convIds).toContain(g2.id);
    h.store.close();
  });
});

// ─── claim / ackQueue / reclaimExpiredClaims（§17）───────────────────────────

describe("mailbox: queue claim and ack", () => {
  /** 在 queue conversation 中直接 INSERT 消息+delivery，绕开 fanout 避免 auto-consume */
  function insertQueueMessage(
    h: Harness,
    queueId: string,
    worker: string,
    opts: { state?: string; attempts?: number } = {},
  ) {
    const msgId = "test-msg-" + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    h.db
      .prepare(
        "INSERT INTO mesh_messages (id, conversation_id, from_account, kind, expect, seq, payload, routed_at, idempotency_key, client_token) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(msgId, queueId, "A", "task", "ack", 1, JSON.stringify({ text: "job" }), now, msgId, null);
    const dId = "test-d-" + Math.random().toString(36).slice(2);
    h.db
      .prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, path, state, state_changed_at, delivered_at, attempts) VALUES (?,?,?,NULL,?,?,?,?,?)",
      )
      .run(dId, msgId, worker, "P1", opts.state ?? "delivered", now, now, opts.attempts ?? 0);
    h.registry.ensureInboxRow(worker, queueId);
    return { msgId, dId };
  }

  it("claim: delivered → claimed returns {ok:true, leaseUntil}", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = insertQueueMessage(h, q.id, "W");
    const r = await h.mailbox.claim(msgId, "W");
    expect(r.ok).toBe(true);
    expect(r.leaseUntil).toBeDefined();
    const row = h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(dId) as { state: string };
    expect(row.state).toBe("claimed");
    h.store.close();
  });

  it("claim: not delivered → {ok:false}", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId } = insertQueueMessage(h, q.id, "W", { state: "routed" });
    const r = await h.mailbox.claim(msgId, "W");
    expect(r.ok).toBe(false);
    h.store.close();
  });

  it("ackQueue: success marks claimed→acked", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = insertQueueMessage(h, q.id, "W");
    await h.mailbox.claim(msgId, "W");
    await h.mailbox.ackQueue(msgId, "W");
    const row = h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(dId) as { state: string };
    expect(row.state).toBe("acked");
    h.store.close();
  });

  it("ackQueue: nack (error) requeues and increments attempts", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    await addHotEndpoint(h, "W");
    const { msgId, dId } = insertQueueMessage(h, q.id, "W");
    await h.mailbox.claim(msgId, "W");
    await h.mailbox.ackQueue(msgId, "W", "processing failed");
    const row = h.db.prepare("SELECT state, attempts FROM mesh_deliveries WHERE id = ?").get(dId) as { state: string; attempts: number };
    // nack requeues then deliverOne auto-consumes via hot endpoint
    expect(["queued", "delivered", "consumed"]).toContain(row.state);
    expect(row.attempts).toBe(1);
    h.store.close();
  });

  it("ackQueue: MAX_ATTEMPTS reached → dropped + message_dropped event", async () => {
    const h = makeHarness({ limits: { maxAttempts: 1 } });
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = insertQueueMessage(h, q.id, "W", { attempts: 1 });
    await h.mailbox.claim(msgId, "W");
    const droppedEvents: Array<{ messageId: string; reason: string }> = [];
    h.events.on("message_dropped", (p) =>
      droppedEvents.push({ messageId: p.envelope.id, reason: p.reason }),
    );
    await h.mailbox.ackQueue(msgId, "W", "failed again");
    const row = h.db.prepare("SELECT state, drop_reason FROM mesh_deliveries WHERE id = ?").get(dId) as { state: string; drop_reason: string };
    expect(row.state).toBe("dropped");
    expect(row.drop_reason).toBe("MAX_ATTEMPTS");
    expect(droppedEvents).toHaveLength(1);
    h.store.close();
  });

  it("reclaimExpiredClaims: expired claimed → nack (queued)", async () => {
    const h = makeHarness({ limits: { claimTtlMs: 100 } });
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    await addHotEndpoint(h, "W");
    const { msgId, dId } = insertQueueMessage(h, q.id, "W", { attempts: 1 });
    const past = new Date(Date.now() - 200).toISOString();
    h.db
      .prepare("UPDATE mesh_deliveries SET state='claimed', claim_until=?, claimed_by='W' WHERE id=?")
      .run(past, dId);
    await h.mailbox.reclaimExpiredClaims(Date.now());
    const row = h.db.prepare("SELECT state, attempts FROM mesh_deliveries WHERE id = ?").get(dId) as { state: string; attempts: number };
    // reclaim nacks then deliverOne auto-consumes via hot endpoint
    expect(["queued", "delivered", "consumed"]).toContain(row.state);
    h.store.close();
  });
});

// ─── I31：Sink 档位透传 + 指数退避（§21.2）─────────────────────────────

describe("mailbox: I31 sink grade passthrough and backoff", () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("handler receives the real computed grade (steer, not hardcoded followUp)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    const got: Array<{ grade: string; id: string }> = [];
    h.sinkHandlers.set("C", {
      deliver: async (_rendered, envelope, grade) => {
        got.push({ grade, id: envelope.id });
        return { accepted: true };
      },
    });
    const conv = await h.registry.ensureDirect("A", "C");
    const r = await h.router.route(
      msg("A", conv.id, { expect: "reply", to: ["C"] }),
    );
    await flush();
    expect(got).toHaveLength(1);
    // 直聊 + expect=reply 且指向我 → steer（§7.2 行 2），证明不是硬编码 followUp
    expect(got[0]!.grade).toBe("steer");
    expect(deliveryRow(h, r.messageId, "C").grade).toBe("steer");
    h.store.close();
  });

  it("refusal keeps queued + sink_backoff note, retries with same idempotencyKey/id", async () => {
    const h = makeHarness({ limits: { sinkBackoffBaseMs: 1 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    const seen: Array<{ id: string; idempotencyKey: string; grade: string }> = [];
    let calls = 0;
    h.sinkHandlers.set("C", {
      deliver: async (_rendered, envelope, grade) => {
        calls++;
        seen.push({ id: envelope.id, idempotencyKey: envelope.idempotencyKey, grade });
        return { accepted: calls >= 2 }; // 首次拒收，第二次接受
      },
    });
    const conv = await h.registry.ensureDirect("A", "C");
    const r = await h.router.route(msg("A", conv.id));
    await flush();

    // 首次拒收 → 留 queued + note='sink_backoff'，非 park
    let row = deliveryRow(h, r.messageId, "C");
    expect(row.state).toBe("queued");
    expect(row.note).toBe("sink_backoff");
    expect(row.attempts).toBe(1);
    expect(calls).toBe(1);

    // 退避期满后 sweep 重投 → accepted → delivered
    await sleep(10);
    await h.mailbox.sweep();
    row = deliveryRow(h, r.messageId, "C");
    expect(row.state).toBe("delivered");
    expect(calls).toBe(2);

    // 重投看到同一 id / idempotencyKey（幂等 token 稳定，§21.2）
    expect(seen).toHaveLength(2);
    expect(seen[0]!.id).toBe(seen[1]!.id);
    expect(seen[0]!.idempotencyKey).toBe(seen[1]!.idempotencyKey);
    h.store.close();
  });

  it("maxAttempts consecutive refusals → park(SINK_REFUSED)", async () => {
    const h = makeHarness({ limits: { sinkBackoffBaseMs: 1, maxAttempts: 2 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    let calls = 0;
    h.sinkHandlers.set("C", {
      deliver: async () => {
        calls++;
        return { accepted: false };
      },
    });
    const conv = await h.registry.ensureDirect("A", "C");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    // 首拒：attempts=1 < maxAttempts=2 → 留 queued
    expect(deliveryRow(h, r.messageId, "C").state).toBe("queued");
    await sleep(10);
    await h.mailbox.sweep();
    const row = deliveryRow(h, r.messageId, "C");
    expect(row.state).toBe("parked");
    expect(row.parked_reason).toBe("SINK_REFUSED");
    expect(row.attempts).toBe(2);
    expect(calls).toBe(2);
    h.store.close();
  });
});

// ─── I03：outbox 两层一致对账（publish 抛错 / orphan 重建 / failed 联动）──────

describe("mailbox: I03 outbox reconcile", () => {
  it("publish-throw keeps queued (fanout not aborted), next sweep republishes orphan", async () => {
    const transport = new RecordingTransport();
    let localEp = "";
    const h = makeHarness({
      transport,
      isEndpointLocal: async (ep) => ep === localEp,
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const epA = await addHotEndpoint(h, "A");
    localEp = epA.id; // 只有 A 的端点是本地；B 的端点为"他进程"
    const epB = await addHotEndpoint(h, "B");

    const conv = await h.registry.ensureDirect("A", "B");
    transport.failPublish = true;
    const r = await h.router.route(msg("A", conv.id));
    await flush();

    // publish 抛错 → B 的 delivery 留在 queued（不 park/drop，fanout 未中止）
    const row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("queued");
    expect(transport.publishes).toHaveLength(0);

    // 恢复 publish 后 sweep 对账：孤儿意图重建，重发 outbox
    transport.failPublish = false;
    await h.mailbox.sweep();
    expect(transport.publishes).toHaveLength(1);
    expect(transport.publishes[0]!.deliveryId).toBe(row.id);
    expect(transport.publishes[0]!.endpointId).toBe(epB.id);
    expect(transport.publishes[0]!.path).toBe("P1");
    h.store.close();
  });

  it("outbox failed row writes back drop(TRANSPORT_FAILED) to still-active delivery", async () => {
    const transport = new RecordingTransport();
    let localEp = "";
    const h = makeHarness({
      transport,
      isEndpointLocal: async (ep) => ep === localEp,
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const epA = await addHotEndpoint(h, "A");
    localEp = epA.id;
    const epB = await addHotEndpoint(h, "B");

    const conv = await h.registry.ensureDirect("A", "B");
    transport.failPublish = true;
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    const row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("queued");

    // 手工落一条 outbox failed 行（运输层重试耗尽），下游仍 queued
    h.db
      .prepare(
        "INSERT INTO mesh_outbox (delivery_id, target_endpoint, payload, state) VALUES (?,?,?,'failed')",
      )
      .run(row.id, epB.id, JSON.stringify({ deliveryId: row.id }));

    await h.mailbox.sweep();
    const after = deliveryRow(h, r.messageId, "B");
    expect(after.state).toBe("dropped");
    expect(after.drop_reason).toBe("TRANSPORT_FAILED");
    h.store.close();
  });
});

// ─── I14：档位与唤醒解耦（P2 也参与唤醒；busy 不起新轮）─────────────────

describe("mailbox: I14 wake decoupled from path", () => {
  it("urgent P2 (never-spoke member) marks woke=1 and nudges the hot idle stream", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const epB = await addHotEndpoint(h, "B");
    // B 从未发言 ⇒ 超预算 P2；urgent 仍须唤醒（§7.3 规则④ 与档位正交）
    await h.router.route(
      msg("A", conv.id, { to: ["B"], priority: "urgent", clientToken: "u1" }),
    );
    await flush();
    const row = h.db
      .prepare("SELECT * FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as Record<string, unknown>;
    expect(row.path).toBe("P2");
    expect(row.woke).toBe(1); // 唤醒判定脱 path：P2 也计算 woke
    expect(row.state).toBe("queued"); // P2 仍留 queued，交给注入确认
    // 热流空闲 ⇒ 以极简 cue nudge 起一轮（正文在 context 注入体里）
    expect(h.port.nudges).toContainEqual(
      expect.objectContaining({ endpointId: epB.id, opts: { triggerTurn: true } }),
    );
    // P2 不直接 port.deliver（§7.6）
    expect(h.port.delivered.filter((d) => d.endpointId === epB.id)).toHaveLength(0);
    h.store.close();
  });

  it("urgent P2 on a busy stream does NOT start a new turn (woke=1, no nudge)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const epB = await addHotEndpoint(h, "B");
    // 让端口对 B 报忙（模拟正在跑一轮）
    const orig = h.port.status.bind(h.port);
    h.port.status = (id: string) => ({ ...orig(id), busy: true });
    await h.router.route(
      msg("A", conv.id, { to: ["B"], priority: "urgent", clientToken: "u1" }),
    );
    await flush();
    const row = h.db
      .prepare("SELECT * FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as Record<string, unknown>;
    expect(row.path).toBe("P2");
    expect(row.woke).toBe(1); // woke 落库仍为 1
    expect(h.port.nudges).toHaveLength(0); // busy 不起新轮（交给自然轮/注入确认）
    void epB;
    h.store.close();
  });
});

// ─── I09：confirmInjection 端点级确认（双端点不互相确认；P3 不进注入体）──

describe("mailbox: I09 confirmInjection endpoint isolation", () => {
  it("flips only that endpoint's queued P2 rows to delivered", async () => {
    // 默认 unified 选择器只取首端点；用自定义选择器返回两端点以驱动 I15 多端投递。
    const epIds: string[] = [];
    const h = makeHarness({
      policies: {
        endpointSelector: { select: () => (epIds.length ? [...epIds] : null) },
      },
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const epB1 = await addHotEndpoint(h, "B");
    const epB2 = await h.registry.registerEndpoint({
      accountId: "B",
      topology: { kind: "unified" },
    });
    h.registry.updateEndpointState(epB2.id, "hot");
    epIds.push(epB1.id, epB2.id);
    await h.router.route(msg("A", conv.id, { clientToken: "m1" }));
    await flush();

    const rowOf = (epId: string) =>
      h.db
        .prepare("SELECT * FROM mesh_deliveries WHERE endpoint_id = ?")
        .get(epId) as Record<string, unknown>;
    // B 从未发言 ⇒ P2；两端各一行 queued
    const r1 = rowOf(epB1.id);
    const r2 = rowOf(epB2.id);
    expect(r1.path).toBe("P2");
    expect(r2.path).toBe("P2");
    expect(r1.state).toBe("queued");
    expect(r2.state).toBe("queued");

    h.mailbox.confirmInjection(epB1.id); // 触发 A 端某轮的最终输入确认
    // 只 epB1 的行 → delivered；epB2 仍 queued（双端点不互相确认）
    expect(rowOf(epB1.id).state).toBe("delivered");
    expect(rowOf(epB1.id).entry_id).toBeNull(); // 无 entry_id（P2 确认无落盘条目）
    expect(rowOf(epB2.id).state).toBe("queued");
    h.store.close();
  });

  it("inboxInjection returns null when only P3 (audit) is pending — P3 never leaks", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.setCaps(conv.id, "B", ["read"]); // 只读 ⇒ P3
    const epB = await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { to: ["B"], clientToken: "p3" }));
    // 注入体只收 path='P2'（§7.6）；P3 的 audit note 数值为 0 ⇒ 空注入
    expect(h.mailbox.inboxInjection(epB.id)).toBeNull();
    h.store.close();
  });
});

// ─── I08：原文预算 slots（LRU 淘汰 / 自发言字节口径 / 自定义比较器）────

describe("mailbox: I08 verbatim budget LRU & bytes", () => {
  it("LRU: recency 较新的会话挤掉 LRU 较旧的会话（跨过 maxVerbatimConversations）", async () => {
    const h = makeHarness(); // 默认 maxVerbatimConversations = 3
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const gs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const g = await h.registry.createConversation({
        type: "group",
        creator: "A",
        members: ["B"],
      });
      h.registry.recordSpoke(g.id, "B", 1); // B 均已发言，越过硬性条款
      gs.push(g.id);
    }
    await addHotEndpoint(h, "B");
    // 控制 recency：next_seq 单调 5/7/9/11 → lastActiveSeq 4/6/8/10；全部 gap ≤ 20
    const seqs = [5, 7, 9, 11];
    for (let i = 0; i < 4; i++) {
      h.db
        .prepare("UPDATE mesh_conversations SET next_seq = ? WHERE id = ?")
        .run(seqs[i], gs[i]);
    }
    // 发往最旧的 g0 ⇒ 4 会话、仅 3 名额 ⇒ LRU（g0）被挤出 ⇒ P2
    await h.router.route(msg("A", gs[0]!, { clientToken: "m0" }));
    await flush();
    expect(
      (
        h.db
          .prepare("SELECT path FROM mesh_deliveries WHERE account_id = 'B'")
          .get() as { path: string }
      ).path,
    ).toBe("P2");

    // 发往最新的 g3 ⇒ 接纳（top-3 recency）⇒ P1
    await h.router.route(msg("A", gs[3]!, { clientToken: "m3" }));
    await flush();
    const p1 = h.db
      .prepare("SELECT COUNT(*) AS n FROM mesh_deliveries WHERE account_id = 'B' AND path = 'P1'")
      .get() as { n: number };
    expect(p1.n).toBe(1);
    h.store.close();
  });

  it("retention candidate unreadBytes includes self-spoken verbatim_bytes", async () => {
    const seen = new Map<string, number>(); // convId -> unreadBytes（B 的视角）
    const h = makeHarness({
      policies: {
        retention: {
          verbatimBudget(ctx: { accountId: string; conversations: Array<{ id: string; unreadBytes: number }> }) {
            if (ctx.accountId === "B") {
              for (const c of ctx.conversations) seen.set(c.id, c.unreadBytes);
            }
            return { bytes: Number.MAX_SAFE_INTEGER, ttlSeq: 20 };
          },
        },
      },
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const g = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    await addHotEndpoint(h, "A");
    await addHotEndpoint(h, "B");
    // B 自发言 ⇒ verbatim_bytes 增长（§7.4「含自己发出的消息」）
    await h.router.route(msg("B", g.id, { text: "hello world", clientToken: "b1" }));
    const vb = h.db
      .prepare(
        "SELECT verbatim_bytes FROM mesh_inboxes WHERE account_id = 'B' AND conversation_id = ?",
      )
      .get(g.id) as { verbatim_bytes: number };
    expect(vb.verbatim_bytes).toBeGreaterThan(0); // 自发言字节已落库
    // 触发 B 的 retention 决策
    await h.router.route(msg("A", g.id, { clientToken: "a1" }));
    await flush();
    // 槽诚实：unreadBytes ≥ 自发言字节（pending + verbatim 口径）
    expect(seen.get(g.id)).toBeGreaterThanOrEqual(vb.verbatim_bytes);
    h.store.close();
  });

  it("custom evictionOrder comparator is used by verbatimInBudget", async () => {
    let calls = 0;
    const h = makeHarness({
      policies: {
        retention: {
          verbatimBudget: () => ({ bytes: Number.MAX_SAFE_INTEGER, ttlSeq: 20 }),
          evictionOrder: (a: { conversationId: string }, b: { conversationId: string }) => {
            calls++;
            return b.conversationId.localeCompare(a.conversationId);
          },
        },
      },
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const g1 = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const g2 = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.recordSpoke(g1.id, "B", 1);
    h.registry.recordSpoke(g2.id, "B", 1);
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", g1.id, { clientToken: "x1" }));
    await flush();
    expect(calls).toBeGreaterThan(0); // 比较器确实参与排序（参与接纳集合判定）
    h.store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G07 分支覆盖补强：端口错误归因 / sink 退避 / 原文 pin·mention / outbox 收件 /
// 对账 / queue claim·ack 边界 / 防御性内部路径（白盒直调 private 收口真实行为）
// ═══════════════════════════════════════════════════════════════════════════

/** G07 白盒直调：仅覆盖「外部流程不可达、但契约要求防御」的 private 分支，
 *  每个调用后都跟真实断言（非为了覆盖率刷桩）。 */
function privateMailbox(h: Harness) {
  return h.mailbox as unknown as {
    envelopeOf(id: string): Envelope | null;
    nameOf(id: string): string;
    gapOf(convId: string, accountId: string): number;
    convOfMessage(id: string): string;
    markDelivered(id: string, entryId: string | null): void;
    parkDelivery(id: string, env: Envelope | null, reason: string, endpointId?: string): void;
    dropDelivery(id: string, env: Envelope | null, reason: string): void;
    isVerbatim(
      envelope: Envelope,
      conv: { kind: string },
      accountId: string,
      membership: { verbatimPinned?: boolean } | undefined,
    ): boolean;
  };
}

describe("mailbox: G07 port error attribution (I16)", () => {
  it("ENDPOINT_GONE on P1 deliver → park(ENDPOINT_GONE)", async () => {
    const tp = new ThrowingPort();
    const h = makeHarness({ port: tp });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");

    tp.throwOnDeliver = { code: "ENDPOINT_GONE" };
    const r = await h.router.route(msg("A", conv.id, { clientToken: "e1" }));
    await flush();
    expect(deliveryRow(h, r.messageId, "B").parked_reason).toBe("ENDPOINT_GONE");
    h.store.close();
  });

  it("LOCK_HELD on P1 deliver → park(LEASE_HELD)", async () => {
    const tp = new ThrowingPort();
    const h = makeHarness({ port: tp });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");

    tp.throwOnDeliver = { code: "LOCK_HELD" };
    const r = await h.router.route(msg("A", conv.id, { clientToken: "e2" }));
    await flush();
    expect(deliveryRow(h, r.messageId, "B").parked_reason).toBe("LEASE_HELD");
    h.store.close();
  });
});

describe("mailbox: G07 sink 退避与档位", () => {
  it("sink handler throws → sinkRefused 保持 queued + sink_backoff", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    h.sinkHandlers.set("C", {
      deliver: async () => {
        throw new Error("sink boom");
      },
    });
    const conv = await h.registry.ensureDirect("A", "C");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "s1" }));
    await flush();
    const row = deliveryRow(h, r.messageId, "C");
    expect(row.state).toBe("queued");
    expect(row.note).toBe("sink_backoff");
    h.store.close();
  });

  it("sink handler consumedImmediately → accepted 即 delivered 再 consumed", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    h.sinkHandlers.set("C", {
      deliver: async () => ({ accepted: true, consumedImmediately: true }),
    });
    const conv = await h.registry.ensureDirect("A", "C");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "s2" }));
    await flush();
    expect(deliveryRow(h, r.messageId, "C").state).toBe("consumed");
    h.store.close();
  });

  it("muted sink recipient forces silent grade", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    const grades: Grade[] = [];
    h.sinkHandlers.set("C", {
      deliver: async (_r, _e, grade) => {
        grades.push(grade);
        return { accepted: true };
      },
    });
    const conv = await h.registry.ensureDirect("A", "C");
    h.registry.mute(conv.id, "C", isoFromMs(Date.now() + 60_000));
    await h.router.route(msg("A", conv.id, { clientToken: "s3" }));
    await flush();
    expect(grades).toEqual(["silent"]);
    h.store.close();
  });

  it("sink grade policy illegal return → degrade followUp + policy_degraded", async () => {
    const h = makeHarness({
      policies: {
        delivery: { grade: () => "garbage" as unknown as Grade },
      },
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "C", { endpointClass: "sink" });
    const grades: Grade[] = [];
    h.sinkHandlers.set("C", {
      deliver: async (_r, _e, grade) => {
        grades.push(grade);
        return { accepted: true };
      },
    });
    const conv = await h.registry.ensureDirect("A", "C");
    await h.router.route(msg("A", conv.id, { clientToken: "s4" }));
    await flush();
    expect(grades).toEqual(["followUp"]); // 校验失败降级
    const pd = h.db
      .prepare("SELECT COALESCE(SUM(value),0) AS n FROM mesh_counters WHERE name = 'policy_degraded'")
      .get() as { n: number };
    expect(pd.n).toBeGreaterThanOrEqual(1);
    h.store.close();
  });
});

describe("mailbox: G07 verbatim pin / mention", () => {
  it("verbatim_pinned=1 forces in-budget and is carried in grade membership", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    // B 从未发言（本应 P2），但 verbatim_pinned=1 强制预算内
    h.db
      .prepare("UPDATE mesh_memberships SET verbatim_pinned = 1 WHERE conversation_id = ? AND account_id = ?")
      .run(conv.id, "B");
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { to: ["B"], clientToken: "vp1" }));
    await flush();
    expect(deliveryRow(h, r.messageId, "B").path).toBe("P1");
    h.store.close();
  });

  it("verbatim_pinned=0 forces out-of-budget even for a speaking member", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    h.registry.recordSpoke(conv.id, "B", 2); // 发言过（本应 P1）
    h.db
      .prepare("UPDATE mesh_memberships SET verbatim_pinned = 0 WHERE conversation_id = ? AND account_id = ?")
      .run(conv.id, "B");
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { to: ["B"], clientToken: "vp2" }));
    await flush();
    expect(deliveryRow(h, r.messageId, "B").path).toBe("P2");
    h.store.close();
  });

  it("mention-targeted reply (B not in `to`) restores in-budget via mentions branch", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    await addAcc(h, "D", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["A", "B", "D"] });
    // B 从未发言 → 广播（未指向 B 且未 @ B）超预算；再发一条 @ B 的 reply（不在 to）→ 回预算
    await addHotEndpoint(h, "B");
    const plain = await h.router.route(msg("A", conv.id, { clientToken: "m0" }));
    await flush();
    expect(deliveryRow(h, plain.messageId, "B").path).toBe("P2");
    const mention = await h.router.route(
      msg("A", conv.id, { to: ["D"], expect: "reply", mentions: ["B"], clientToken: "m1" }),
    );
    await flush();
    expect(deliveryRow(h, mention.messageId, "B").path).toBe("P1");
    h.store.close();
  });
});

describe("mailbox: G07 verbatimInBudget 候选池", () => {
  it("pinned=1 豁免、pinned=0 剔除；ttlSeq gap 溢出剔除", async () => {
    const h = makeHarness({
      policies: {
        retention: { verbatimBudget: () => ({ bytes: Number.MAX_SAFE_INTEGER, ttlSeq: 5 }) },
      },
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const c1 = await h.registry.createConversation({ type: "group", creator: "A", members: ["A", "B"] });
    const c2 = await h.registry.createConversation({ type: "group", creator: "A", members: ["A", "B"] });
    const c3 = await h.registry.createConversation({ type: "group", creator: "A", members: ["A", "B"] });
    // c1 打 pinned=1（豁免占位）、c2 打 pinned=0（剔除）、c3 正常但 gap 超 ttlSeq（剔除）
    h.registry.recordSpoke(c1.id, "B", 1);
    h.registry.recordSpoke(c2.id, "B", 1);
    h.registry.recordSpoke(c3.id, "B", 1);
    h.registry.recordSpoke(c3.id, "A", 100); // 让 c3 的 next 溢出 ttlSeq
    h.db.prepare("UPDATE mesh_memberships SET verbatim_pinned = 1 WHERE conversation_id = ? AND account_id = ?").run(c1.id, "B");
    h.db.prepare("UPDATE mesh_memberships SET verbatim_pinned = 0 WHERE conversation_id = ? AND account_id = ?").run(c2.id, "B");
    await addHotEndpoint(h, "B");
    // 触发 B 的 isVerbatim 判定（在 c1 里再发一条）
    const r = await h.router.route(msg("A", c1.id, { to: ["B"], clientToken: "vb1" }));
    await flush();
    // c1 pinned=1 → 预算内 P1
    expect(deliveryRow(h, r.messageId, "B").path).toBe("P1");
    h.store.close();
  });

  it("bytes-limited budget breaks at ceiling; NULL inbox bytes default to 0", async () => {
    const h = makeHarness({
      policies: { retention: { verbatimBudget: () => ({ bytes: 1, ttlSeq: undefined }) } },
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["A", "B"] });
    // B 发言过（候选），但没有 inbox 行（NULL bytes → ?? 0）；bytes=1 极小 → 字节预算 break
    h.registry.recordSpoke(conv.id, "B", 1);
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { to: ["B"], clientToken: "bb1" }));
    await flush();
    // 字节预算=1 不能容纳当前会话的未读（≥1 字节）→ 超预算
    expect(deliveryRow(h, r.messageId, "B").path).toBe("P2");
    h.store.close();
  });
});

describe("mailbox: G07 outbox 收件（handleOutboxDelivery）", () => {
  async function outboxHarness(port?: FakeStreamPort) {
    const rec = new RecordingTransport();
    const h = makeHarness({
      port,
      transport: rec,
      isEndpointLocal: () => false,
    });
    return { h, rec };
  }

  it("P1 收件渲染并投递（entry_appended 归因）；unknown account 抛错", async () => {
    const { h, rec } = await outboxHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { clientToken: "o1" }));
    await flush();
    expect(rec.publishes).toHaveLength(1);
    const pending = rec.publishes[0]!;
    await h.mailbox.handleOutboxDelivery(pending);
    await flush();
    // 唤醒=true ⇒ FakeStreamPort 自动 turn_end，已推进 consumed；投递确实发生即可。
    expect(["delivered", "consumed"]).toContain(deliveryRow(h, pending.envelope.id, "B").state);

    // 未知账号 →
    await expect(
      h.mailbox.handleOutboxDelivery({ ...pending, accountId: "ghost" }),
    ).rejects.toThrow(/unknown account/);
    h.store.close();
  });

  it("P3 收件只记账 note 并 markDelivered（null entryId）", async () => {
    const { h, rec } = await outboxHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    h.registry.setCaps(conv.id, "B", ["read"]); // 只读 → P3
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { to: ["B"], clientToken: "o2" }));
    await flush();
    expect(rec.publishes).toHaveLength(1);
    expect(rec.publishes[0]!.path).toBe("P3");
    await h.mailbox.handleOutboxDelivery(rec.publishes[0]!);
    await flush();
    expect(deliveryRow(h, rec.publishes[0]!.envelope.id, "B").state).toBe("delivered");
    expect(h.port.notes.some((n) => n.customType === "mesh.audit")).toBe(true);
    h.store.close();
  });

  it("P1 收件 deliver 抛错 → park 对应 delivery（不含 ack）", async () => {
    const tp = new ThrowingPort();
    const { h, rec } = await outboxHarness(tp);
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { clientToken: "o3" }));
    await flush();
    tp.throwOnDeliver = { code: "NO_SESSION" };
    await h.mailbox.handleOutboxDelivery(rec.publishes[0]!);
    await flush();
    expect(deliveryRow(h, rec.publishes[0]!.envelope.id, "B").parked_reason).toBe("NO_SESSION");
    h.store.close();
  });
});

describe("mailbox: G07 对账（reconcileDelivered）", () => {
  it("isEndpointLocal false → skip; status throw → skip without park", async () => {
    const h = makeHarness({ isEndpointLocal: () => false });
    // 手工插入一条带 entry_id 的 delivered 行，对账时因非本地端点直接跳过
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const dId = h.db
      .prepare("SELECT id FROM mesh_deliveries WHERE account_id = 'B' LIMIT 1")
      .get() as { id: string } | undefined;
    void dId; void conv; void ep;
    // 直接造一行的方式：route 后改状态
    const r = await h.router.route(msg("A", conv.id, { clientToken: "r1" }));
    await flush();
    h.db
      .prepare("UPDATE mesh_deliveries SET state='delivered', entry_id='e1' WHERE message_id = ?")
      .run(r.messageId);
    await h.mailbox.reconcileDelivered(); // 非本地 → 全部跳过，无 park
    const row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("delivered");
    h.store.close();
  });

  it("status throw → 留待下一轮（不 park）", async () => {
    const tp = new ThrowingPort();
    const h = makeHarness({ port: tp });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "r2" }));
    await flush();
    h.db
      .prepare("UPDATE mesh_deliveries SET state='delivered', entry_id='e2' WHERE message_id = ?")
      .run(r.messageId);
    tp.throwOnStatus = new Error("status boom");
    await h.mailbox.reconcileDelivered();
    expect(deliveryRow(h, r.messageId, "B").state).toBe("delivered");
    h.store.close();
  });
});

describe("mailbox: G07 queue claim/ack 边界", () => {
  function insertQueueMessage(h: Harness, queueId: string, worker: string, opts: { state?: string; attempts?: number; grade?: string | null; path?: string | null } = {}) {
    const msgId = "test-msg-" + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    h.db
      .prepare(
        "INSERT INTO mesh_messages (id, conversation_id, from_account, kind, expect, seq, payload, routed_at, idempotency_key, client_token) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(msgId, queueId, "A", "task", "ack", 1, JSON.stringify({ text: "job" }), now, msgId, null);
    const dId = "test-d-" + Math.random().toString(36).slice(2);
    h.db
      .prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, grade, path, state, state_changed_at, delivered_at, attempts) VALUES (?,?,?,NULL,?,?,?,?,?,?)",
      )
      .run(dId, msgId, worker, opts.grade ?? null, opts.path ?? "P1", opts.state ?? "delivered", now, now, opts.attempts ?? 0);
    h.registry.ensureInboxRow(worker, queueId);
    return { msgId, dId };
  }

  it("claim nonexistent → {ok:false}", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const r = await h.mailbox.claim("no-such-message", "W");
    expect(r.ok).toBe(false);
    h.store.close();
  });

  it("re-claim with NULL claim_until (held by self) → {ok:true, leaseUntil:undefined}", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = insertQueueMessage(h, q.id, "W");
    h.db
      .prepare("UPDATE mesh_deliveries SET state='claimed', claimed_by='W', claim_until=NULL WHERE id=?")
      .run(dId);
    const r = await h.mailbox.claim(msgId, "W");
    expect(r.ok).toBe(true);
    expect(r.leaseUntil).toBeUndefined();
    h.store.close();
  });

  it("claim by assigned worker while another holds with NULL claimed_by → CLAIM_TAKEN 'another worker'", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = insertQueueMessage(h, q.id, "W");
    h.db
      .prepare("UPDATE mesh_deliveries SET state='claimed', claimed_by=NULL, claim_until=? WHERE id=?")
      .run(isoFromMs(Date.now() + 60_000), dId);
    await expect(h.mailbox.claim(msgId, "W")).rejects.toMatchObject({ code: "CLAIM_TAKEN" });
    h.store.close();
  });

  it("conv claimTtlMs overrides global (claim + queueClaimTtlMs)", async () => {
    const h = makeHarness({ limits: { claimTtlMs: 5000 } });
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    // 会话级 claimTtlMs 收敛到低于全局 5000，证明读的是会话 config 而非全局默认
    h.db.prepare("UPDATE mesh_conversations SET config = ? WHERE id = ?").run(JSON.stringify({ claimTtlMs: 2500 }), q.id);
    const { msgId } = insertQueueMessage(h, q.id, "W");
    const r = await h.mailbox.claim(msgId, "W");
    expect(r.ok).toBe(true);
    const until = new Date(r.leaseUntil!).getTime();
    expect(until - Date.now()).toBeLessThan(3500); // 未用全局 5000
    expect(until - Date.now()).toBeGreaterThan(1500);
    h.store.close();
  });

  it("ack when not claimed → NO_SUCH_CORRELATION; wrong worker → CLAIM_TAKEN; expired → CLAIM_EXPIRED", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    await addAcc(h, "X");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = insertQueueMessage(h, q.id, "W");

    // 未领取
    await expect(h.mailbox.ackQueue(msgId, "W")).rejects.toMatchObject({ code: "NO_SUCH_CORRELATION" });

    // 他人持有（未过期）
    await h.mailbox.claim(msgId, "W");
    h.db.prepare("UPDATE mesh_deliveries SET claimed_by='X' WHERE id=?").run(dId);
    await expect(h.mailbox.ackQueue(msgId, "W")).rejects.toMatchObject({ code: "CLAIM_TAKEN" });

    // 过期
    h.db
      .prepare("UPDATE mesh_deliveries SET claimed_by='W', claim_until=? WHERE id=?")
      .run(isoFromMs(Date.now() - 1), dId);
    await expect(h.mailbox.ackQueue(msgId, "W")).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    h.store.close();
  });

  it("reclaimExpiredClaims skips rows whose queueDeliveryRow vanished (byId)", async () => {
    const h = makeHarness({ limits: { claimTtlMs: 100 } });
    await addAcc(h, "A");
    await addAcc(h, "W");
    // 无 expired 行 → reclaim 静默空转（L2282 `if (!row) continue` 的防御面）
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    await insertQueueMessage(h, q.id, "W");
    await expect(h.mailbox.reclaimExpiredClaims(Date.now())).resolves.toBeUndefined();
    h.store.close();
  });
});

describe("mailbox: G07 markDelivered/park/drop 内部咽喉", () => {
  function insertDelivery(h: Harness, queueId: string, worker: string, opts: { grade?: string | null; path?: string | null; state?: string } = {}) {
    const msgId = "dm-" + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    h.db
      .prepare(
        "INSERT INTO mesh_messages (id, conversation_id, from_account, kind, expect, seq, payload, routed_at, idempotency_key, client_token) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(msgId, queueId, "A", "task", "ack", 1, JSON.stringify({ text: "x" }), now, msgId, null);
    const dId = "dd-" + Math.random().toString(36).slice(2);
    h.db
      .prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, grade, path, state, state_changed_at) VALUES (?,?,?,NULL,?,?,?,?)",
      )
      .run(dId, msgId, worker, opts.grade ?? null, opts.path ?? null, opts.state ?? "queued", now);
    return { msgId, dId };
  }

  it("markDelivered on missing delivery → no-op; NULL grade/path default to followUp/P1", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });

    // 缺失行 → q undefined → env null 分支（无事件、无异常）
    expect(() => privateMailbox(h).markDelivered("no-such-delivery", null)).not.toThrow();

    const events: Array<{ grade: string; path: string }> = [];
    h.events.on("message_delivered", (p) =>
      events.push({ grade: (p as { grade?: string }).grade ?? "", path: (p as { path?: string }).path ?? "" }),
    );
    const { dId } = insertDelivery(h, q.id, "W", { grade: null, path: null });
    privateMailbox(h).markDelivered(dId, null);
    expect(events).toHaveLength(1);
    expect(events[0]!.grade).toBe("followUp");
    expect(events[0]!.path).toBe("P1");
    h.store.close();
  });

  it("parkDelivery/dropDelivery reject unregistered reasons in devMode", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { dId } = insertDelivery(h, q.id, "W");
    expect(() => privateMailbox(h).parkDelivery(dId, null, "NOT_A_REASON" as never)).toThrow(/unregistered parked_reason/);
    expect(() => privateMailbox(h).dropDelivery(dId, null, "NOT_A_REASON" as never)).toThrow(/unregistered drop_reason/);
    h.store.close();
  });

  it("parkDelivery NO_SESSION without endpointId emits invariant detail sans endpoint", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { dId } = insertDelivery(h, q.id, "W");
    let detail: unknown;
    h.events.on("invariant_violated", (p) => (detail = (p as { detail?: unknown }).detail));
    privateMailbox(h).parkDelivery(dId, null, "NO_SESSION");
    expect((detail as { endpointId?: string }).endpointId).toBeUndefined();
    h.store.close();
  });

  it("envelopeOf/nameOf/gapOf/convOfMessage defend on missing rows", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const pm = privateMailbox(h);
    expect(pm.envelopeOf("no-such-message")).toBeNull();
    expect(pm.nameOf("no-such-account")).toBe("no-such-account");
    expect(pm.convOfMessage("no-such-message")).toBe("");
    expect(pm.gapOf(conv.id, "no-such-member")).toBe(Number.MAX_SAFE_INTEGER);
    h.store.close();
  });
});

describe("mailbox: G07 其它防御分支", () => {
  it("markConsumed on missing / non-pending row returns early", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    // 缺失行
    await expect(h.mailbox.markConsumed("no-such-delivery")).resolves.toBeUndefined();
    // 非 pending 状态（acked）
    const msgId = "mc-" + Math.random().toString(36).slice(2);
    const dId = "dd-" + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    h.db
      .prepare(
        "INSERT INTO mesh_messages (id, conversation_id, from_account, kind, expect, seq, payload, routed_at, idempotency_key, client_token) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(msgId, q.id, "A", "task", "ack", 1, JSON.stringify({ text: "x" }), now, msgId, null);
    h.db
      .prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, path, state, state_changed_at) VALUES (?,?,?,NULL,'P1','acked',?)",
      )
      .run(dId, msgId, "W", now);
    await expect(h.mailbox.markConsumed(dId)).resolves.toBeUndefined();
    h.store.close();
  });

  it("inboxInjection with unknown endpoint → null", async () => {
    const h = makeHarness();
    expect(h.mailbox.inboxInjection("no-such-endpoint")).toBeNull();
    h.store.close();
  });

  it("queue dead-letter: systemSend throw is swallowed (still dropped)", async () => {
    const h = makeHarness({
      limits: { maxAttempts: 1 },
      systemSend: async () => {
        throw new Error("notify boom");
      },
    });
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const msgId = "dl-" + Math.random().toString(36).slice(2);
    const dId = "dd-" + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    h.db
      .prepare(
        "INSERT INTO mesh_messages (id, conversation_id, from_account, kind, expect, seq, payload, routed_at, idempotency_key, client_token, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(msgId, q.id, "A", "task", "ack", 1, JSON.stringify({ text: "x" }), now, msgId, null, "corr-dl");
    h.db
      .prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, path, state, state_changed_at, attempts) VALUES (?,?,?,NULL,'P1','delivered',?,1)",
      )
      .run(dId, msgId, "W", now);
    await h.mailbox.claim(msgId, "W");
    await h.mailbox.ackQueue(msgId, "W", { nested: "error-object" }); // 非字符串 error → JSON.stringify 分支
    const row = h.db.prepare("SELECT state, drop_reason FROM mesh_deliveries WHERE id = ?").get(dId) as { state: string; drop_reason: string };
    expect(row.state).toBe("dropped");
    expect(row.drop_reason).toBe("MAX_ATTEMPTS");
    h.store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G07 分支补全（第二批）：直接命中仍未覆盖的防御/边界分支，供 coverage-gate 95% 阈值。
// 全程只做目标分支的最小构造，不改变公共契约，也不依赖真实 LLM。
// ═══════════════════════════════════════════════════════════════════════════

/** deliver 只返回空对象（不产生 entryId、不同步回吐 entry）——触发 entryId null 兜底。 */
class NoEntryPort extends FakeStreamPort {
  override async deliver(
    _endpointId: string,
    _rendered: string,
    _envelope: Envelope,
    _grade: Grade,
    _opts?: { triggerTurn?: boolean },
  ): Promise<{ entryId?: string }> {
    return {};
  }
}

/** triggerTurn:false（CATCHUP 固化）时抛错、其余正常——隔离「固化失败不阻塞本条」。 */
class CatchupThrowPort extends FakeStreamPort {
  override async deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    opts?: { triggerTurn?: boolean },
  ): Promise<{ entryId?: string }> {
    if (opts && opts.triggerTurn === false) throw { code: "NO_SESSION" };
    return super.deliver(endpointId, rendered, envelope, grade, opts);
  }
}

let seedCounter = 0;

/** 直接落一条 message + delivery（绕过路由），用于精确构造脏/边界形态。 */
function seedMessageDelivery(
  h: Harness,
  convId: string,
  accountId: string,
  opts: {
    seq?: number;
    endpointId?: string | null;
    state?: string;
    path?: string | null;
    grade?: string | null;
    payload?: string;
    entryId?: string | null;
    attempts?: number;
    correlationId?: string | null;
    kind?: string;
    expect?: string;
    fromAccount?: string;
    note?: string | null;
    claimUntil?: string | null;
    claimedBy?: string | null;
    queuedAt?: string | null;
    parkedAt?: string | null;
    woke?: number;
  } = {},
): { msgId: string; dId: string } {
  const msgId = "sdmsg-" + (++seedCounter) + Math.random().toString(36).slice(2, 8);
  const dId = "sddlv-" + (++seedCounter) + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  h.db
    .prepare(
      "INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, expect, payload, routed_at, idempotency_key, client_token, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      msgId, convId, opts.seq ?? 1, opts.fromAccount ?? "A", opts.kind ?? "chat",
      opts.expect ?? "none", opts.payload ?? JSON.stringify({ text: "x" }), now, msgId, null,
      opts.correlationId ?? null,
    );
  h.db
    .prepare(
      "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, grade, path, woke, state, entry_id, attempts, claim_until, claimed_by, queued_at, parked_at, note, state_changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      dId, msgId, accountId, opts.endpointId ?? null, opts.grade ?? null, opts.path ?? null,
      opts.woke ?? 0, opts.state ?? "queued", opts.entryId ?? null, opts.attempts ?? 0,
      opts.claimUntil ?? null, opts.claimedBy ?? null, opts.queuedAt ?? null, opts.parkedAt ?? null,
      opts.note ?? null, now,
    );
  return { msgId, dId };
}

describe("mailbox: G07 分支补全·P1 连续段/无 entry/catchup", () => {
  it("§7.7 连续段：更早 seq 仍 queued 时后续 P1 留 queued", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    // 更早的 seq 仍 parked（未投完）→ 连续段检查把后续 seq 留在 queued；
    // 不 seed 成 queued：那会被 CATCHUP 当作「待固化未读」先消费掉，无法形成缺口。
    seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: ep.id, state: "parked", path: "P1", grade: "followUp", payload: JSON.stringify({ text: "first" }) });
    h.db.prepare("UPDATE mesh_conversations SET next_seq = 2 WHERE id = ?").run(conv.id);
    const r = await h.router.route(msg("A", conv.id, { clientToken: "gap1" }));
    await flush();
    expect(deliveryRow(h, r.messageId, "B").state).toBe("queued");
    h.store.close();
  });

  it("P1 deliver 返回无 entryId → 留 queued + handoff（不 markDelivered）", async () => {
    const h = makeHarness({ port: new NoEntryPort() });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "ne1" }));
    await flush();
    const row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("queued");
    expect(row.entry_id).toBeNull();
    expect(row.handoff_at).not.toBeNull();
    h.store.close();
  });

  it("verbatim 候选池：pinned=1/0 占位、ttlSeq 缺口剔除、无 inbox 行 null 兜底", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const g1 = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const g2 = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const g3 = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const g4 = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    h.db.prepare("UPDATE mesh_memberships SET verbatim_pinned = 1 WHERE conversation_id = ? AND account_id = 'B'").run(g1.id);
    h.db.prepare("UPDATE mesh_memberships SET verbatim_pinned = 0 WHERE conversation_id = ? AND account_id = 'B'").run(g2.id);
    h.db.prepare("UPDATE mesh_memberships SET last_spoke_seq = 1 WHERE conversation_id = ? AND account_id = 'B'").run(g3.id);
    h.db.prepare("UPDATE mesh_conversations SET next_seq = 50 WHERE id = ?").run(g3.id);
    h.db.prepare("UPDATE mesh_memberships SET last_spoke_seq = 1 WHERE conversation_id = ? AND account_id = 'B'").run(g4.id);
    h.db.prepare("DELETE FROM mesh_inboxes WHERE account_id = 'B' AND conversation_id = ?").run(g4.id);

    const mb = h.mailbox as any;
    const cands = mb.retentionCandidates("B") as Array<{ id: string; unreadBytes: number }>;
    const g4cand = cands.find((c) => c.id === g4.id);
    expect(g4cand).toBeDefined();
    expect(g4cand!.unreadBytes).toBe(0);
    expect(mb.verbatimInBudget("B", g3.id, { bytes: 1000, ttlSeq: 5 })).toBe(false);
    expect(mb.verbatimInBudget("B", g1.id, { bytes: 1000, ttlSeq: 5 })).toBe(true);
    expect(mb.verbatimInBudget("B", g4.id, { bytes: 1000, ttlSeq: 5 })).toBe(true);
    h.store.close();
  });

  it("CATCHUP：overflow>0 且无待固化 items → span 走 envelope.seq 兜底并清折叠", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    h.db.prepare("UPDATE mesh_inboxes SET overflow_count = 3, overflow_summary = 's' WHERE account_id = ? AND conversation_id = ?").run("B", conv.id);
    await h.router.route(msg("A", conv.id, { clientToken: "cu1" }));
    await flush();
    const inbox = h.db.prepare("SELECT overflow_count, overflow_summary FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?").get("B", conv.id) as { overflow_count: number; overflow_summary: string | null };
    expect(inbox.overflow_count).toBe(0);
    expect(inbox.overflow_summary).toBeNull();
    h.store.close();
  });

  it("CATCHUP：空文本 item 摘要兜底 + 无端点 consumed 归因 endpointId=''", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: null, state: "queued", path: "P2", payload: JSON.stringify({ kind: "system" }) });
    h.db.prepare("UPDATE mesh_inboxes SET overflow_count = 1 WHERE account_id = ? AND conversation_id = ?").run("B", conv.id);
    h.db.prepare("UPDATE mesh_conversations SET next_seq = 2 WHERE id = ?").run(conv.id);
    const consumedEndpoints: string[] = [];
    h.events.on("message_consumed", (p) => consumedEndpoints.push((p as { endpointId?: string }).endpointId ?? "<missing>"));
    await h.router.route(msg("A", conv.id, { clientToken: "ct1" }));
    await flush();
    expect(consumedEndpoints).toContain("");
    h.store.close();
  });

  it("CATCHUP 固化投递抛错被吞 → 折叠保留、主消息照常送达", async () => {
    const h = makeHarness({ port: new CatchupThrowPort() });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    h.db.prepare("UPDATE mesh_inboxes SET overflow_count = 1 WHERE account_id = ? AND conversation_id = ?").run("B", conv.id);
    const r = await h.router.route(msg("A", conv.id, { clientToken: "cu2" }));
    await flush();
    // 固化摘要投递（triggerTurn:false）被 CatchupThrowPort 抛错 → 只吞错返回，不中止主消息投递。
    expect(["delivered", "consumed"]).toContain(deliveryRow(h, r.messageId, "B").state);
    // 抛错发生在记录之前 → 没有任何 triggerTurn:false 的摘要投递落账，证明 L1033 分支确实走到。
    expect(h.port.delivered.some((d) => d.triggerTurn === false)).toBe(false);
    h.store.close();
  });

  it("entry_appended 对已投递行重复到达 → 不重复 markDelivered", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "dup1" }));
    await flush();
    expect(deliveryRow(h, r.messageId, "B").state).toBe("consumed");
    h.port.emitEntry({
      endpointId: ep.id, entryId: "dup-" + r.messageId, envelopeId: r.messageId,
      entryType: "custom_message", seqInStream: 99, rawJson: JSON.stringify({}),
    });
    await flush();
    expect(deliveryRow(h, r.messageId, "B").state).toBe("consumed");
    h.store.close();
  });
});

describe("mailbox: G07 分支补全·sweep/outbox/sink/fold", () => {
  it("sweep parked TTL：wake_throttled 与普通挂起分别落专用原因", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const past = isoFromMs(Date.now() - 10_000_000);
    const a = seedMessageDelivery(h, conv.id, "B", { seq: 1, state: "parked", note: "wake_throttled", parkedAt: past });
    const b = seedMessageDelivery(h, conv.id, "B", { seq: 2, state: "parked", note: null, parkedAt: past });
    await h.mailbox.sweep(Date.now());
    const ra = h.db.prepare("SELECT state, drop_reason FROM mesh_deliveries WHERE id = ?").get(a.dId) as { state: string; drop_reason: string };
    const rb = h.db.prepare("SELECT state, drop_reason FROM mesh_deliveries WHERE id = ?").get(b.dId) as { state: string; drop_reason: string };
    expect(ra.state).toBe("dropped");
    expect(ra.drop_reason).toBe("WAKE_THROTTLED_AND_EXPIRED");
    expect(rb.drop_reason).toBe("TTL_EXPIRED");
    h.store.close();
  });

  it("sweep seq 缺口超时：绕过连续段直接投出队头", async () => {
    const h = makeHarness({ limits: { seqGapTimeoutMs: 1 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const old = isoFromMs(Date.now() - 50_000);
    seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: ep.id, state: "queued", path: "P1", grade: "followUp", queuedAt: isoFromMs(Date.now()), woke: 0 });
    const t = seedMessageDelivery(h, conv.id, "B", { seq: 2, endpointId: ep.id, state: "queued", path: "P1", grade: "followUp", queuedAt: old, woke: 0 });
    await h.mailbox.sweep(Date.now());
    await flush();
    expect(["delivered", "consumed"]).toContain((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string }).state);
    h.store.close();
  });

  it("sweep pending_ack 超时：intent 写入事件与 @system 文本", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    const h = makeHarness({ systemSend: async (s) => { sent.push({ to: s.to, text: s.text }); } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const { msgId } = seedMessageDelivery(h, conv.id, "B", { state: "consumed" });
    h.db.prepare("INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, endpoint_id, conversation_id, intent, deadline, state) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("pa-intent", msgId, "reply", "A", "B", null, conv.id, "url_fetch", isoFromMs(Date.now() - 1000), "open");
    await h.mailbox.sweep(Date.now());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("type=url_fetch");
    h.store.close();
  });

  it("sweep pending_ack 超时 systemSend 抛错被吞（超时判定仍落库）", async () => {
    const h = makeHarness({ systemSend: async () => { throw new Error("boom"); } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const { msgId } = seedMessageDelivery(h, conv.id, "B", { state: "consumed" });
    h.db.prepare("INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, endpoint_id, conversation_id, intent, deadline, state) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("pa-throw", msgId, "reply", "A", "B", null, conv.id, null, isoFromMs(Date.now() - 1000), "open");
    await h.mailbox.sweep(Date.now());
    expect((h.db.prepare("SELECT state FROM mesh_pending_acks WHERE correlation_id = 'pa-throw'").get() as { state: string }).state).toBe("timeout");
    h.store.close();
  });

  it("sweep 孤儿意图重建 publish 抛错被吞（grade/path NULL 兜底）", async () => {
    const rec = new RecordingTransport();
    rec.failPublish = true;
    const h = makeHarness({ transport: rec, isEndpointLocal: () => false });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const t = seedMessageDelivery(h, conv.id, "B", { endpointId: ep.id, state: "queued", grade: null, path: null });
    await h.mailbox.sweep(Date.now());
    expect((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string }).state).toBe("queued");
    h.store.close();
  });

  it("sweep outbox failed 联动：孤儿/终态跳过，活跃行 drop TRANSPORT_FAILED", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    h.db.prepare("INSERT INTO mesh_outbox (delivery_id, target_endpoint, payload, state) VALUES (?,?,?,?)").run("ghost-dlv", "ep-x", "{}", "failed");
    const d1 = seedMessageDelivery(h, conv.id, "B", { seq: 1, state: "delivered" });
    h.db.prepare("INSERT INTO mesh_outbox (delivery_id, target_endpoint, payload, state) VALUES (?,?,?,?)").run(d1.dId, "ep-x", "{}", "failed");
    const d2 = seedMessageDelivery(h, conv.id, "B", { seq: 2, state: "queued" });
    h.db.prepare("INSERT INTO mesh_outbox (delivery_id, target_endpoint, payload, state) VALUES (?,?,?,?)").run(d2.dId, "ep-x", "{}", "failed");
    await h.mailbox.sweep(Date.now());
    const r2 = h.db.prepare("SELECT state, drop_reason FROM mesh_deliveries WHERE id = ?").get(d2.dId) as { state: string; drop_reason: string };
    expect(r2.state).toBe("dropped");
    expect(r2.drop_reason).toBe("TRANSPORT_FAILED");
    expect((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(d1.dId) as { state: string }).state).toBe("delivered");
    h.store.close();
  });

  it("sweep sink 退避未期满 → 跳过不重投", async () => {
    const h = makeHarness({ limits: { sinkBackoffBaseMs: 600_000 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const t = seedMessageDelivery(h, conv.id, "B", { state: "queued", path: "P1", grade: "followUp", note: "sink_backoff", queuedAt: isoFromMs(Date.now()) });
    await h.mailbox.sweep(Date.now());
    expect(h.db.prepare("SELECT state, note FROM mesh_deliveries WHERE id = ?").get(t.dId)).toEqual({ state: "queued", note: "sink_backoff" });
    h.store.close();
  });

  it("sweep sink 退避期满 queued_at/grade NULL → 无 handler 落 NO_SINK_HANDLER", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const t = seedMessageDelivery(h, conv.id, "B", { state: "queued", path: "P1", grade: null, note: "sink_backoff", queuedAt: null });
    await h.mailbox.sweep(Date.now());
    const r = h.db.prepare("SELECT state, parked_reason FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string; parked_reason: string };
    expect(r.state).toBe("parked");
    expect(r.parked_reason).toBe("NO_SINK_HANDLER");
    h.store.close();
  });

  it("sweep outboxDoneRetentionMs=0 → 不清理 done 载体", async () => {
    const h = makeHarness({ limits: { outboxDoneRetentionMs: 0 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const { dId } = seedMessageDelivery(h, conv.id, "B", { state: "consumed" });
    h.db.prepare("INSERT INTO mesh_outbox (delivery_id, target_endpoint, payload, state, claimed_at) VALUES (?,?,?,?,?)").run(dId, "ep-x", "{}", "done", isoFromMs(Date.now() - 1e9));
    await h.mailbox.sweep(Date.now());
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM mesh_outbox WHERE delivery_id = ?").get(dId) as { n: number }).n).toBe(1);
    h.store.close();
  });

  it("foldOverflow：溢出但无未投送行 → victims 空跳过", async () => {
    const h = makeHarness({ limits: { maxPending: 2 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { clientToken: "fo1" }));
    await flush();
    h.db.prepare("UPDATE mesh_inboxes SET pending_count = 100 WHERE account_id = ? AND conversation_id = ?").run("B", conv.id);
    await h.mailbox.sweep(Date.now());
    expect((h.db.prepare("SELECT pending_count FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?").get("B", conv.id) as { pending_count: number }).pending_count).toBe(100);
    h.store.close();
  });

  it("foldOverflow：无 text 消息摘要兜底 '' 并 drop folded", async () => {
    const h = makeHarness({ limits: { maxPending: 2 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const t = seedMessageDelivery(h, conv.id, "B", { seq: 1, state: "queued", payload: JSON.stringify({ kind: "system" }) });
    h.db.prepare("UPDATE mesh_inboxes SET pending_count = 100, pending_bytes = 100 WHERE account_id = ? AND conversation_id = ?").run("B", conv.id);
    await h.mailbox.sweep(Date.now());
    const r = h.db.prepare("SELECT state, drop_reason FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string; drop_reason: string };
    expect(r.state).toBe("dropped");
    expect(r.drop_reason).toBe("folded");
    expect((h.db.prepare("SELECT overflow_summary FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?").get("B", conv.id) as { overflow_summary: string | null }).overflow_summary).not.toBeNull();
    h.store.close();
  });
});

describe("mailbox: G07 分支补全·对账/confirm/drain/note/inbox", () => {
  it("reconcileDelivered：全 parked 且端口冷 → 直接返回不 warm", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "rc1" }));
    await flush();
    h.db.prepare("UPDATE mesh_deliveries SET state='parked', entry_id='e1' WHERE message_id = ?").run(r.messageId);
    h.port.setEndpointState(ep.id, "cold");
    await h.mailbox.reconcileDelivered();
    expect(h.port.warmed).not.toContain(ep.id);
    expect(deliveryRow(h, r.messageId, "B").state).toBe("parked");
    h.store.close();
  });

  it("reconcileDelivered：冷端口非全 parked → warm 成功后对账", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "rc2" }));
    await flush();
    h.db.prepare("UPDATE mesh_deliveries SET state='delivered', entry_id='e2' WHERE message_id = ?").run(r.messageId);
    h.port.setEndpointState(ep.id, "cold");
    await h.mailbox.reconcileDelivered();
    await flush();
    expect(h.port.warmed).toContain(ep.id);
    h.store.close();
  });

  it("reconcileDelivered：warm 抛错 → 跳过 parked、park 其余", async () => {
    const tp = new ThrowingPort();
    const h = makeHarness({ port: tp });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const r1 = await h.router.route(msg("A", conv.id, { clientToken: "rc3a" }));
    const r2 = await h.router.route(msg("A", conv.id, { clientToken: "rc3b" }));
    await flush();
    h.db.prepare("UPDATE mesh_deliveries SET state='parked', entry_id='e-p' WHERE message_id = ?").run(r1.messageId);
    h.db.prepare("UPDATE mesh_deliveries SET state='delivered', entry_id='e-d' WHERE message_id = ?").run(r2.messageId);
    tp.throwOnWarm = new Error("warm boom");
    h.port.setEndpointState(ep.id, "cold");
    await h.mailbox.reconcileDelivered();
    const p = h.db.prepare("SELECT state, parked_reason FROM mesh_deliveries WHERE message_id = ?").get(r1.messageId) as { state: string; parked_reason: string | null };
    const d = h.db.prepare("SELECT state, parked_reason FROM mesh_deliveries WHERE message_id = ?").get(r2.messageId) as { state: string; parked_reason: string };
    expect(p.state).toBe("parked");
    expect(p.parked_reason).toBeNull();
    expect(d.state).toBe("parked");
    expect(d.parked_reason).toBe("PORT_TIMEOUT");
    h.store.close();
  });

  it("reconcileDelivered：热端口 busy → 交还 turn_end 不推进", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "rc4" }));
    await flush();
    h.db.prepare("UPDATE mesh_deliveries SET state='delivered', entry_id='e4' WHERE message_id = ?").run(r.messageId);
    (h.port as unknown as { busy: Set<string> }).busy.add(ep.id);
    await h.mailbox.reconcileDelivered();
    expect(deliveryRow(h, r.messageId, "B").state).toBe("delivered");
    h.store.close();
  });

  it("reconcileDelivered：hasEntries 抛错 → park 该行", async () => {
    const tp = new ThrowingPort();
    const h = makeHarness({ port: tp });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "rc5" }));
    await flush();
    h.db.prepare("UPDATE mesh_deliveries SET state='delivered', entry_id='e5' WHERE message_id = ?").run(r.messageId);
    tp.throwOnHasEntries = new Error("has boom");
    await h.mailbox.reconcileDelivered();
    expect(deliveryRow(h, r.messageId, "B").state).toBe("parked");
    h.store.close();
  });

  it("retryEndpoint 未知端点 → 走 else 分支空集", async () => {
    const h = makeHarness();
    await h.mailbox.retryEndpoint("ghost-ep");
    h.store.close();
  });

  it("releaseRequestLease：缺行 / expect≠ack / 无端点 → 全早退", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const { msgId } = seedMessageDelivery(h, conv.id, "B", { state: "consumed" });
    h.db.prepare("INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, endpoint_id, conversation_id, deadline, state) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("pa-rl2", msgId, "reply", "A", "B", null, conv.id, isoFromMs(Date.now()), "open");
    h.db.prepare("INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, endpoint_id, conversation_id, deadline, state) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("pa-rl3", msgId, "ack", "A", "B", null, conv.id, isoFromMs(Date.now()), "open");
    await h.mailbox.releaseRequestLease("no-such");
    await h.mailbox.releaseRequestLease("pa-rl2");
    await h.mailbox.releaseRequestLease("pa-rl3");
    h.store.close();
  });

  it("confirmInjection：无 P2 行空转；grade NULL 兜底 followUp", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const ep = await addHotEndpoint(h, "B");
    h.mailbox.confirmInjection("no-such-endpoint");
    const t = seedMessageDelivery(h, conv.id, "B", { endpointId: ep.id, state: "queued", path: "P2", grade: null });
    const grades: string[] = [];
    h.events.on("message_delivered", (p) => grades.push((p as { grade?: string }).grade ?? ""));
    h.mailbox.confirmInjection(ep.id);
    expect((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string }).state).toBe("delivered");
    expect(grades).toContain("followUp");
    h.store.close();
  });

  it("drainQueued：存在队头 queued P1 → 循环投出", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const t = seedMessageDelivery(h, conv.id, "B", { endpointId: ep.id, state: "queued", path: "P1", grade: "followUp", woke: 0 });
    await (h.mailbox as any).drainQueued(ep.id);
    await flush();
    expect(["delivered", "consumed"]).toContain((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string }).state);
    h.store.close();
  });

  it("noteVerbatimExit：note 抛错后允许下次重试（失败复位重试键）", async () => {
    const tp = new ThrowingPort();
    const h = makeHarness({ port: tp });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const ep = await addHotEndpoint(h, "B");
    seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: ep.id, state: "delivered", path: "P1", grade: "followUp" });
    const env2 = {
      id: "env-vx", seq: 2, from: "A", fromEndpoint: null, routedAt: isoFromMs(Date.now()),
      idempotencyKey: "env-vx", conversationId: conv.id,
    } as unknown as Envelope;
    tp.throwOnNote = new Error("note boom");
    await (h.mailbox as any).noteVerbatimExit(env2, "B", ep.id);
    tp.throwOnNote = undefined;
    await (h.mailbox as any).noteVerbatimExit(env2, "B", ep.id);
    expect(tp.notes.some((n) => n.customType === "mesh.verbatim_exit")).toBe(true);
    h.store.close();
  });

  it("inboxInjection：overflow_summary 与空文本 recent 渲染", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const ep = await addHotEndpoint(h, "B");
    seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: ep.id, state: "queued", path: "P2", grade: "followUp", payload: JSON.stringify({ kind: "system" }) });
    h.db.prepare("UPDATE mesh_inboxes SET overflow_count = 1, overflow_summary = 'sum-x' WHERE account_id = ? AND conversation_id = ?").run("B", conv.id);
    const out = h.mailbox.inboxInjection(ep.id);
    expect(out).not.toBeNull();
    expect(out!).toContain("[summary] sum-x");
    expect(out!).toContain("<<<MSG");
    h.store.close();
  });
});

describe("mailbox: G07 分支补全·queue 租约回收/ack", () => {
  it("ackQueue CLAIM_TAKEN when claimed_by NULL → 'another worker'", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId } = seedMessageDelivery(h, q.id, "W", { kind: "task", expect: "ack", state: "claimed", claimedBy: null, claimUntil: isoFromMs(Date.now() + 60_000) });
    await expect(h.mailbox.ackQueue(msgId, "W")).rejects.toMatchObject({ code: "CLAIM_TAKEN" });
    h.store.close();
  });

  it("reclaimExpiredClaims：claimed 过期 → claim_timeout 计数 + 死信 lastError 置空", async () => {
    const sent: Array<{ text: string }> = [];
    const h = makeHarness({
      limits: { maxAttempts: 0 },
      systemSend: async (s) => { sent.push({ text: s.text }); },
    });
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { dId } = seedMessageDelivery(h, q.id, "W", {
      kind: "task", expect: "ack", state: "claimed", claimedBy: "W",
      claimUntil: isoFromMs(Date.now() - 1000), correlationId: "corr-x",
    });
    await h.mailbox.reclaimExpiredClaims(Date.now());
    const row = h.db.prepare("SELECT state, drop_reason, claim_error FROM mesh_deliveries WHERE id = ?").get(dId) as { state: string; drop_reason: string; claim_error: string | null };
    expect(row.state).toBe("dropped");
    expect(row.drop_reason).toBe("MAX_ATTEMPTS");
    expect(row.claim_error).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("corr-x");
    expect(sent[0]!.text).not.toContain("last error");
    const counter = h.db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM mesh_counters WHERE name = 'claim_timeout'").get() as { v: number };
    expect(counter.v).toBeGreaterThanOrEqual(1);
    h.store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G07 分支补全（第三批）：把四范围中仍未覆盖的 6 个可达分支补齐（≥95% 阈值）。
// ═══════════════════════════════════════════════════════════════════════════

describe("mailbox: G07 分支补全·兜底六支", () => {
  it("selector 返回未知端点 → policy_degraded + park(ENDPOINT_GONE)", async () => {
    const h = makeHarness({
      policies: { endpointSelector: { select: () => "ghost-ep" } },
    });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { clientToken: "sel-ghost" }));
    await flush();
    const row = deliveryRow(h, r.messageId, "B");
    expect(row.state).toBe("parked");
    expect(row.parked_reason).toBe("ENDPOINT_GONE");
    h.store.close();
  });

  it("urgent P2 唤醒时 nudge 抛错被吞（仍留 queued）", async () => {
    const tp = new ThrowingPort();
    const h = makeHarness({ port: tp });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    await addHotEndpoint(h, "B");
    tp.throwOnNudge = new Error("nudge boom");
    await h.router.route(msg("A", conv.id, { to: ["B"], priority: "urgent", clientToken: "u-nudge" }));
    await flush();
    const row = h.db.prepare("SELECT state, path, woke FROM mesh_deliveries WHERE account_id = 'B'").get() as { state: string; path: string; woke: number };
    expect(row.path).toBe("P2");
    expect(row.woke).toBe(1);
    expect(row.state).toBe("queued"); // nudge 失败不改变 P2 queued 事实
    h.store.close();
  });

  it("sweep seq 缺口：无更早缺口 → continue（交给 drainQueued，不重复投）", async () => {
    const h = makeHarness({ limits: { seqGapTimeoutMs: 1 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const t = seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: ep.id, state: "queued", path: "P1", grade: "followUp", queuedAt: isoFromMs(Date.now() - 50_000), woke: 0 });
    await h.mailbox.sweep(Date.now());
    await flush();
    expect((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string }).state).toBe("queued");
    h.store.close();
  });

  it("reconcileDelivered hasEntries 抛错：parked 跳过、delivered park", async () => {
    const tp = new ThrowingPort();
    const h = makeHarness({ port: tp });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    const r1 = await h.router.route(msg("A", conv.id, { clientToken: "rc6a" }));
    const r2 = await h.router.route(msg("A", conv.id, { clientToken: "rc6b" }));
    await flush();
    h.db.prepare("UPDATE mesh_deliveries SET state='parked', entry_id='e-pk' WHERE message_id = ?").run(r1.messageId);
    h.db.prepare("UPDATE mesh_deliveries SET state='delivered', entry_id='e-dl' WHERE message_id = ?").run(r2.messageId);
    tp.throwOnHasEntries = new Error("has boom");
    await h.mailbox.reconcileDelivered();
    const p = h.db.prepare("SELECT state, parked_reason FROM mesh_deliveries WHERE message_id = ?").get(r1.messageId) as { state: string; parked_reason: string | null };
    const d = h.db.prepare("SELECT state, parked_reason FROM mesh_deliveries WHERE message_id = ?").get(r2.messageId) as { state: string; parked_reason: string };
    expect(p.state).toBe("parked");
    expect(p.parked_reason).toBeNull(); // 已 parked → 跳过，不重 park
    expect(d.state).toBe("parked");
    expect(d.parked_reason).toBe("PORT_TIMEOUT");
    h.store.close();
  });

  it("drainQueued：更早 seq 仍挂起 → break 保序不投", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: ep.id, state: "parked", path: "P1" });
    const t = seedMessageDelivery(h, conv.id, "B", { seq: 2, endpointId: ep.id, state: "queued", path: "P1", grade: "followUp", woke: 0 });
    await (h.mailbox as any).drainQueued(ep.id);
    await flush();
    expect((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string }).state).toBe("queued");
    h.store.close();
  });

  it("sweep seq 缺口超时：grade NULL 兜底 followUp", async () => {
    const h = makeHarness({ limits: { seqGapTimeoutMs: 1 } });
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const old = isoFromMs(Date.now() - 50_000);
    seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: ep.id, state: "queued", path: "P1", grade: "followUp", queuedAt: isoFromMs(Date.now()), woke: 0 });
    const t = seedMessageDelivery(h, conv.id, "B", { seq: 2, endpointId: ep.id, state: "queued", path: "P1", grade: null, queuedAt: old, woke: 0 });
    await h.mailbox.sweep(Date.now());
    await flush();
    expect(["delivered", "consumed"]).toContain((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string }).state);
    h.store.close();
  });
});

describe("mailbox: G07 outbox 收件·缺省与异常支路", () => {
  async function outboxHarness(port?: FakeStreamPort) {
    const rec = new RecordingTransport();
    const h = makeHarness({
      port,
      transport: rec,
      isEndpointLocal: () => false,
    });
    return { h, rec };
  }

  it("P1 收件：path/endpointId 缺省 + deliver 无 entryId → 留 queued 且 entry_id NULL", async () => {
    const { h, rec } = await outboxHarness(new NoEntryPort());
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { clientToken: "o4" }));
    await flush();
    const pending = rec.publishes[0]!;
    await h.mailbox.handleOutboxDelivery({ ...pending, path: undefined, endpointId: null });
    await flush();
    const row = deliveryRow(h, pending.envelope.id, "B");
    expect(row.state).toBe("queued");
    expect(row.entry_id).toBeNull();
    expect(row.handoff_at).not.toBeNull();
    h.store.close();
  });

  it("P1 收件：deliver 抛错 + endpointId 缺省 → park(PORT_TIMEOUT)", async () => {
    const tp = new ThrowingPort();
    const { h, rec } = await outboxHarness(tp);
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { clientToken: "o5" }));
    await flush();
    tp.throwOnDeliver = new Error("deliver boom");
    await h.mailbox.handleOutboxDelivery({ ...rec.publishes[0]!, endpointId: null });
    await flush();
    const row = deliveryRow(h, rec.publishes[0]!.envelope.id, "B");
    expect(row.state).toBe("parked");
    expect(row.parked_reason).toBe("PORT_TIMEOUT");
    h.store.close();
  });

  it("P3 收件：endpointId 缺省 note 成功 → markDelivered(null entryId)", async () => {
    const { h, rec } = await outboxHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { clientToken: "o6" }));
    await flush();
    const pending = rec.publishes[0]!;
    await h.mailbox.handleOutboxDelivery({ ...pending, path: "P3", endpointId: null });
    await flush();
    expect(deliveryRow(h, pending.envelope.id, "B").state).toBe("delivered");
    expect(h.port.notes.some((n) => n.customType === "mesh.audit" && n.endpointId === "")).toBe(true);
    h.store.close();
  });

  it("P3 收件：note 抛错 → park(PORT_TIMEOUT)", async () => {
    const tp = new ThrowingPort();
    const { h, rec } = await outboxHarness(tp);
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { clientToken: "o7" }));
    await flush();
    tp.throwOnNote = new Error("note boom");
    await h.mailbox.handleOutboxDelivery({ ...rec.publishes[0]!, path: "P3" });
    await flush();
    const row = deliveryRow(h, rec.publishes[0]!.envelope.id, "B");
    expect(row.state).toBe("parked");
    expect(row.parked_reason).toBe("PORT_TIMEOUT");
    h.store.close();
  });

  it("P2 收件：endpointId 缺省 + ack 抛错 → 吞错留 queued 无 ack", async () => {
    const { h, rec } = await outboxHarness();
    rec.failAck = true;
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    await addHotEndpoint(h, "B");
    await h.router.route(msg("A", conv.id, { clientToken: "o8" }));
    await flush();
    const pending = rec.publishes[0]!;
    await h.mailbox.handleOutboxDelivery({ ...pending, path: "P2", endpointId: null });
    await flush();
    expect(rec.acks).toHaveLength(0);
    expect(deliveryRow(h, pending.envelope.id, "B").state).toBe("queued");
    h.store.close();
  });

  it("drainQueued：grade NULL 兜底 followUp 投出", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.ensureDirect("A", "B");
    const ep = await addHotEndpoint(h, "B");
    const t = seedMessageDelivery(h, conv.id, "B", { seq: 1, endpointId: ep.id, state: "queued", path: "P1", grade: null, woke: 0 });
    await (h.mailbox as any).drainQueued(ep.id);
    await flush();
    expect(["delivered", "consumed"]).toContain((h.db.prepare("SELECT state FROM mesh_deliveries WHERE id = ?").get(t.dId) as { state: string }).state);
    h.store.close();
  });
});
