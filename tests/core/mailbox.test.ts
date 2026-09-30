// ═══════════════════════════════════════════════════════════════════════════
// Mailbox 单元测试：定档/唤醒（A1/A2/A2'/A3）/选端/parked/状态机（F5 判据）/
// 溢出折叠/handoff 超时/beforeClearQueue(C10 I22)/CATCHUP/原文预算（§7）
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshEventBus } from "../../src/core/events.js";
import { MeshMailbox } from "../../src/core/mailbox.js";
import { createDefaultPolicies } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { MeshRouter } from "../../src/core/router.js";
import { SqliteStore } from "../../src/core/store.js";
import { InProcessTransport } from "../../src/core/transport.js";
import type { RouteInput } from "../../src/core/contracts.js";
import type {
  Endpoint,
  Envelope,
  Limits,
  Policies,
  RegisterAccountInput,
  SinkHandler,
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

function makeHarness(
  opts: { limits?: Partial<Limits>; policies?: Partial<Policies> } = {},
): Harness {
  const tdb = openTestDb();
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  const port = new FakeStreamPort();
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
    transport: new InProcessTransport(),
    port,
    sinkHandlers,
    awaitingCorrelations: (acct) => [...(awaiting.get(acct) ?? new Set())],
    devMode: true,
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
    const catchup = h.port.notes.find(
      (n) => n.endpointId === epB.id && n.customType === "mesh.catchup",
    );
    expect(catchup).toBeTruthy();
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

  it("silent to a cold stream parks without warming (§7.2 silent×cold → parked)", async () => {
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
    expect(row.state).toBe("parked"); // §7.2 表：冷流 silent → parked（非终态，warm 后重投）
    expect(row.parked_reason).toBe("ENDPOINT_GONE");
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
    expect(events?.n).toBe(3);
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
  it("busy stream downgrades triggerTurn to false and counts wake_per_message_busy", async () => {
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
    const busy = h.db
      .prepare("SELECT value AS n FROM mesh_counters WHERE name = 'wake_per_message_busy'")
      .get() as { n: number } | undefined;
    expect(busy?.n ?? 0).toBe(1);
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
      .prepare("UPDATE mesh_messages SET payload = json_set(payload, '$.claim', json_object('by','W','at',?)) WHERE id = ?")
      .run(past, msgId);
    h.db
      .prepare("UPDATE mesh_deliveries SET state='claimed', claim_until=? WHERE id=?")
      .run(past, dId);
    await h.mailbox.reclaimExpiredClaims(Date.now());
    const row = h.db.prepare("SELECT state, attempts FROM mesh_deliveries WHERE id = ?").get(dId) as { state: string; attempts: number };
    // reclaim nacks then deliverOne auto-consumes via hot endpoint
    expect(["queued", "delivered", "consumed"]).toContain(row.state);
    h.store.close();
  });
});
