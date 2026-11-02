// ═══════════════════════════════════════════════════════════════════════════
// D03 权威恢复（§8.4）：delivered ↔ pi session 双向核对。
//   ① entry 在 session（窗口③）→ consumed(partial)，反复恢复结果一致；
//   ② entry 不在 session（窗口②）→ queued 重投（幂等键防重），重投后不再重复；
//   ③ warm 失败（拿不到 session）→ park(原因由端口错误映射) + 告警；
//   ④ queue 的 delivered 不被对账吞掉（仍 delivered 等 claim，§17）。
// 走 makeHarness 直读 DB + FakeStreamPort，零 pi SDK；onEntry 接了 handleEntryAppended、
// 故意不接 onTurnEnd 以停「已进上下文、未确认跑完」的崩溃窗口。
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
import type { Endpoint, Limits, Policies, SinkHandler } from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
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
}

function makeHarness(opts: { limits?: Partial<Limits> } = {}): Harness {
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
      create: async () => ({ session: {}, runtimeRef: "pi-test" }),
      open: async () => ({ session: {} }),
    },
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
    isEndpointLocal: undefined,
    awaitingCorrelations: (acct) => [...(awaiting.get(acct) ?? new Set())],
    devMode: true,
  });
  // 只接 entry（delivered 归因）；不接 turn_end —— 停「已投未确认跑完」的崩溃窗口。
  port.onEntry((e) => mailbox.handleEntryAppended(e));
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
  return { db: tdb.db, store, registry, events, port, mailbox, router };
}

async function addAcc(
  h: Harness,
  id: string,
  o: { presence?: boolean } = {},
): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat", "task", "event"],
  });
  if (o.presence) h.registry.setPresence(id, "available");
}

async function addHotEndpoint(h: Harness, id: string): Promise<Endpoint> {
  const ep = await h.registry.registerEndpoint({
    accountId: id,
    topology: { kind: "unified" },
    runtimeRef: "pi-" + id,
  });
  h.registry.updateEndpointState(ep.id, "hot");
  return ep;
}

const msg = (from: string, conversationId: string, extra: Partial<RouteInput> = {}): RouteInput => ({
  from,
  conversationId,
  kind: "chat",
  expect: "none",
  text: "hi",
  clientToken: Math.random().toString(36).slice(2),
  ...extra,
});

function deliveryRow(h: Harness, messageId: string): Record<string, unknown> {
  return h.db
    .prepare("SELECT * FROM mesh_deliveries WHERE message_id = ?")
    .get(messageId)! as Record<string, unknown>;
}

function counter(h: Harness, name: string): number {
  const row = h.db
    .prepare("SELECT COALESCE(SUM(value), 0) AS n FROM mesh_counters WHERE name = ?")
    .get(name) as { n: number };
  return row.n;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("D03 authoritative recovery (§8.4)", () => {
  it("entry alive in session → consumed(partial); repeated recovery is identical", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    await addHotEndpoint(h, "W");
    const conv = await h.registry.ensureDirect("A", "W");
    const r = await h.router.route(msg("A", conv.id));
    await flush();

    // 未接 turn_end：delivery 停在 delivered，entry 真在 port 里（窗口③）
    const row = deliveryRow(h, r.messageId);
    expect(row.state).toBe("delivered");
    expect(row.entry_id).toBeTruthy();
    const deliveredBefore = h.port.delivered.length;

    // 崩溃残骸：delivered_at 早于本进程启动（A04），sweep 对账才纳入
    h.db.prepare("UPDATE mesh_deliveries SET delivered_at = '1970-01-01T00:00:00.000Z' WHERE message_id = ?").run(r.messageId);
    await h.mailbox.reconcileDelivered();
    const after = deliveryRow(h, r.messageId);
    expect(after.state).toBe("consumed");
    expect(after.partial).toBe(1);
    expect(h.port.delivered.length).toBe(deliveredBefore); // 不重投

    // 反复恢复结果相同（幂等：门控 state='delivered'，二次查无 delivered 即 no-op）
    await h.mailbox.reconcileDelivered();
    const again = deliveryRow(h, r.messageId);
    expect(again.state).toBe("consumed");
    expect(again.partial).toBe(1);
    expect(h.port.delivered.length).toBe(deliveredBefore);
    h.store.close();
  });

  it("A08: clearQueue 抹掉已投递条目 → 只重投一次、不重复；反复对账留 turn_end 兜底 (A04)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    await addHotEndpoint(h, "W");
    const conv = await h.registry.ensureDirect("A", "W");
    const r = await h.router.route(msg("A", conv.id));
    await flush();

    const row = deliveryRow(h, r.messageId);
    const entryId = row.entry_id as string;
    expect(entryId).toBeTruthy();
    // 窗口②：deliver 已返回、entry 未能落进 session（clearQueue 抹掉）
    h.port.vanishedEntries.add(entryId);
    const before = h.port.delivered.length;

    h.db.prepare("UPDATE mesh_deliveries SET delivered_at = '1970-01-01T00:00:00.000Z' WHERE message_id = ?").run(r.messageId);
    await h.mailbox.reconcileDelivered();
    // 回 queued 后重投一次：port 多出恰好一条 entry
    expect(h.port.delivered.length).toBe(before + 1);
    // A08：clearQueue 抹条目被记为「条目旁落」，只重投一次、不重复进入上下文
    expect(counter(h, "queue_cleared_detected")).toBe(1);

    // 反复恢复：重投后的 delivered 行 delivered_at 晚于本进程启动，A04 交给 turn_end
    // 不再被 sweep 对账二次重投——换新 submission 后 attempt 停留在 1，无重复进上下文。
    await h.mailbox.reconcileDelivered();
    const after = deliveryRow(h, r.messageId);
    expect(after.state).toBe("delivered");
    expect(after.attempt).toBe(1);
    expect(h.port.delivered.length).toBe(before + 1);
    h.store.close();
  });

  it("cold endpoint warm fails → parked + counted alert (cannot determine)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const ep = await addHotEndpoint(h, "W");
    const conv = await h.registry.ensureDirect("A", "W");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    const row = deliveryRow(h, r.messageId);
    expect(row.state).toBe("delivered");
    const entryId = row.entry_id;
    expect(entryId).toBeTruthy();

    // 崩溃后端点冷、warm 又拿不到 session：无法判定 → park + NO_SESSION 告警（§8.4）
    h.db.prepare("UPDATE mesh_deliveries SET delivered_at = '1970-01-01T00:00:00.000Z' WHERE message_id = ?").run(r.messageId);
    h.port.setEndpointState(ep.id, "cold");
    h.port.warmError = Object.assign(new Error("no session"), { code: "NO_SESSION" });

    await h.mailbox.reconcileDelivered();
    const after = deliveryRow(h, r.messageId);
    expect(after.state).toBe("parked");
    expect(after.parked_reason).toBe("NO_SESSION");
    expect(after.entry_id).toBe(entryId); // entry_id 保留，下次 warm 成功再对账
    expect(counter(h, "invariant_violated")).toBe(1);
    h.store.close();
  });

  it("warm 失败恢复后不盲重投：parked(submission) → retryEndpoint 精确读 → consumed(partial) (A03)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const ep = await addHotEndpoint(h, "W");
    const conv = await h.registry.ensureDirect("A", "W");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    const row = deliveryRow(h, r.messageId);
    expect(row.state).toBe("delivered");
    expect(row.submission_id).toBeTruthy(); // durable 投递后必带权威 submission
    const deliveredBefore = h.port.delivered.length;

    // 崩溃后 warm 失败：park（保留 submission_id）
    h.db.prepare("UPDATE mesh_deliveries SET delivered_at = '1970-01-01T00:00:00.000Z' WHERE message_id = ?").run(r.messageId);
    h.port.setEndpointState(ep.id, "cold");
    h.port.warmError = Object.assign(new Error("no session"), { code: "NO_SESSION" });
    await h.mailbox.reconcileDelivered();
    expect(deliveryRow(h, r.messageId).state).toBe("parked");

    // 端点恢复：retryEndpoint 的 requeueParked 对带 submission 的行早退、不盲重投；
    // 随后 reconcileDeliveredForEndpoint 按 submission id 精确读（done 带 entry）→ consumed(partial)
    h.port.warmError = undefined;
    h.port.setEndpointState(ep.id, "hot");
    await h.mailbox.retryEndpoint(ep.id);
    await flush();
    const after = deliveryRow(h, r.messageId);
    expect(after.state).toBe("consumed");
    expect(after.partial).toBe(1);
    expect(h.port.delivered.length).toBe(deliveredBefore); // 无重复进上下文（I5）
    h.store.close();
  });

  it("queue delivered is NOT reconciled (stays delivered awaiting claim)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W", { presence: true });
    await addHotEndpoint(h, "W");
    const q = await h.registry.createConversation({
      type: "queue",
      creator: "A",
      members: ["W"],
    });
    const r = await h.router.route(msg("A", q.id, { kind: "task", expect: "ack" }));
    await flush();

    const row = deliveryRow(h, r.messageId);
    expect(row.state).toBe("delivered");
    expect(row.entry_id).toBeTruthy(); // queue 的 P1 也写 entry_id

    await h.mailbox.reconcileDelivered();
    const after = deliveryRow(h, r.messageId);
    expect(after.state).toBe("delivered"); // 不被对账吞掉（claim 回收闭环在 §17.2）
    h.store.close();
  });
});