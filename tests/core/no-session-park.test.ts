// ═══════════════════════════════════════════════════════════════════════════
// NO_SESSION 不被改写（I33）：deliver/note 抛 {code:"NO_SESSION"} ⇒ park 原因
// 保持 NO_SESSION 并发 invariant_violated(no_session)（唯一要告警）；抛普通
// Error ⇒ PORT_TIMEOUT 且不告警。PiPortError 类型不进 core——mailbox 鸭子判型。
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
import type { Endpoint, Envelope, Grade, Limits, Policies } from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import type { RouteInput } from "../../src/core/contracts.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

/** 脚本化投递失败：deliver / note 按注入意图抛 NO_SESSION 或普通 Error */
class ThrowingPort extends FakeStreamPort {
  deliverThrows: unknown = null;
  noteThrows: unknown = null;

  override async deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    opts?: { triggerTurn?: boolean },
  ): Promise<{ entryId?: string }> {
    if (this.deliverThrows !== null) throw this.deliverThrows;
    return super.deliver(endpointId, rendered, envelope, grade, opts);
  }

  override async note(endpointId: string, customType: string, data: unknown): Promise<void> {
    if (this.noteThrows !== null) throw this.noteThrows;
    return super.note(endpointId, customType, data);
  }
}

interface Harness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  port: ThrowingPort;
  mailbox: MeshMailbox;
  router: MeshRouter;
  violations: Array<{ code: string }>;
}

function makeHarness(): Harness {
  const tdb = openTestDb();
  const limits: Limits = DEFAULT_LIMITS;
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  const port = new ThrowingPort();
  const policies: Policies = {
    ...createDefaultPolicies({
      isAwaiting: () => false,
      endpointsOf: (acct: string) =>
        registry.endpointsOf(acct).map((e) => ({ id: e.id, inFlight: 0, topology: e.topology })),
      limits,
    }),
    sessionFactory: {
      create: async () => ({ session: {}, piSessionId: "pi-test" }),
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
    sinkHandlers: new Map(),
    awaitingCorrelations: () => [],
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
    isAwaiting: () => false,
  });
  const violations: Array<{ code: string }> = [];
  events.on("invariant_violated", (p) => violations.push({ code: p.code }));
  return { db: tdb.db, store, registry, events, port, mailbox, router, violations };
}

async function addAcc(h: Harness, id: string): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat"],
  });
}

async function addHotEndpoint(h: Harness, id: string): Promise<Endpoint> {
  const ep = await h.registry.registerEndpoint({
    accountId: id,
    topology: { kind: "unified" },
    piSessionId: "pi-" + id,
  });
  h.registry.updateEndpointState(ep.id, "hot");
  return ep;
}

function msg(from: string, convId: string, extra: Partial<RouteInput> = {}): RouteInput {
  return {
    from,
    conversationId: convId,
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

function delivery(h: Harness, messageId: string, acct: string): { state: string; parked_reason: string | null } {
  return h.db
    .prepare<[string, string], { state: string; parked_reason: string | null }>(
      "SELECT state, parked_reason FROM mesh_deliveries WHERE message_id = ? AND account_id = ?",
    )
    .get(messageId, acct)!;
}

describe("I33：NO_SESSION 不被裸 catch 改写", () => {
  it("deliver 抛 {code:NO_SESSION} ⇒ park(NO_SESSION) + invariant_violated(no_session)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    h.port.deliverThrows = { code: "NO_SESSION", message: "no session" };
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    expect(delivery(h, r.messageId, "B")).toMatchObject({
      state: "parked",
      parked_reason: "NO_SESSION",
    });
    expect(h.violations).toContainEqual({ code: "no_session" });
    h.store.close();
  });

  it("deliver 抛普通 Error ⇒ park(PORT_TIMEOUT)，无 no_session 告警", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    h.port.deliverThrows = new Error("transport broke");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    expect(delivery(h, r.messageId, "B")).toMatchObject({
      state: "parked",
      parked_reason: "PORT_TIMEOUT",
    });
    expect(h.violations.filter((v) => v.code === "no_session")).toHaveLength(0);
    h.store.close();
  });

  it("note（P3 路径）抛 {code:NO_SESSION} ⇒ park(NO_SESSION) + no_session 告警", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.setCaps(conv.id, "B", ["read"]); // 只读 ⇒ P3（note only）
    await addHotEndpoint(h, "B");
    h.port.noteThrows = { code: "NO_SESSION", message: "no session" };
    const r = await h.router.route(msg("A", conv.id, { to: ["B"] }));
    await flush();
    expect(delivery(h, r.messageId, "B")).toMatchObject({
      state: "parked",
      parked_reason: "NO_SESSION",
    });
    expect(h.violations).toContainEqual({ code: "no_session" });
    h.store.close();
  });

  it("note（P3 路径）抛普通 Error ⇒ PORT_TIMEOUT 无告警", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.setCaps(conv.id, "B", ["read"]);
    await addHotEndpoint(h, "B");
    h.port.noteThrows = new Error("note failed");
    const r = await h.router.route(msg("A", conv.id, { to: ["B"] }));
    await flush();
    expect(delivery(h, r.messageId, "B")).toMatchObject({
      state: "parked",
      parked_reason: "PORT_TIMEOUT",
    });
    expect(h.violations.filter((v) => v.code === "no_session")).toHaveLength(0);
    h.store.close();
  });
});