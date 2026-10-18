// ═══════════════════════════════════════════════════════════════════════════
// I24：完整 §15.2 在场派生。
// - 显式（presence_explicit 且 until 未过期）→ host 值胜出，不被派生覆盖
// - 派生：busy / online / idle / offline；sink/external 默认 online
// - until 过期回落派生，且经 mailbox.presenceOf 发一次 presence_changed(source:derived)
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
  Limits,
  Policies,
  RegisterAccountInput,
  SinkHandler,
} from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { isoFromMs } from "../../src/core/util.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

// ─── 纯 registry 层（派生状态 + 显式优先级 + 过期回落）─────────────────────

function makeRegistry(): { store: SqliteStore; registry: MeshRegistry } {
  const tdb = openTestDb();
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
  return { store, registry };
}

describe("I24: presence derivation (§15.2)", () => {
  it("derives busy / online / idle / offline, and sink→online", async () => {
    const { store, registry } = makeRegistry();
    await registry.registerAccount({ id: "X", displayName: "X", endpointClass: "stream" });
    const ep = await registry.registerEndpoint({ accountId: "X", topology: { kind: "unified" } });
    registry.updateEndpointState(ep.id, "hot");

    registry.setDeriveStatus(() => ({ busy: true }));
    expect(registry.effectivePresence("X")).toBe("busy");

    registry.setDeriveStatus(() => ({ busy: false, idleMs: 0 }));
    expect(registry.effectivePresence("X")).toBe("online");

    registry.setDeriveStatus(() => ({ busy: false, idleMs: DEFAULT_LIMITS.presenceIdleMs }));
    expect(registry.effectivePresence("X")).toBe("idle");

    // 全冷 → offline（stream）
    registry.updateEndpointState(ep.id, "cold");
    registry.setDeriveStatus(() => ({ busy: false, idleMs: 0 }));
    expect(registry.effectivePresence("X")).toBe("offline");

    // sink 无端点 → 默认 online
    await registry.registerAccount({ id: "S", displayName: "S", endpointClass: "sink" });
    expect(registry.effectivePresence("S")).toBe("online");
    store.close();
  });

  it("explicit offline is not overridden by derivation", async () => {
    const { store, registry } = makeRegistry();
    await registry.registerAccount({ id: "X", displayName: "X", endpointClass: "stream" });
    await registry.registerEndpoint({ accountId: "X", topology: { kind: "unified" } });
    registry.setDeriveStatus(() => ({ busy: true })); // 派生本会给出 busy
    registry.setPresence("X", "offline");
    expect(registry.effectivePresence("X")).toBe("offline");
    expect(registry.isExplicitPresence("X")).toBe(true);
    store.close();
  });

  it("explicit dnd wins within its until window", async () => {
    const { store, registry } = makeRegistry();
    await registry.registerAccount({ id: "X", displayName: "X", endpointClass: "stream" });
    registry.setDeriveStatus(() => ({ busy: false, idleMs: 0 }));
    registry.setPresence("X", "dnd", { until: isoFromMs(Date.now() + 60_000) });
    expect(registry.effectivePresence("X")).toBe("dnd");
    expect(registry.isExplicitPresence("X")).toBe(true);
    store.close();
  });

  it("expired until falls back to derivation and clears explicit flag", async () => {
    const { store, registry } = makeRegistry();
    await registry.registerAccount({ id: "X", displayName: "X", endpointClass: "stream" });
    const ep = await registry.registerEndpoint({ accountId: "X", topology: { kind: "unified" } });
    registry.updateEndpointState(ep.id, "hot");
    registry.setDeriveStatus(() => ({ busy: false, idleMs: 0 }));
    registry.setPresence("X", "offline", { until: isoFromMs(Date.now() - 1000) });
    expect(registry.effectivePresence("X")).toBe("online"); // 过期 → 派生
    expect(registry.isExplicitPresence("X")).toBe(false);
    store.close();
  });
});

// ─── mailbox 层：until 过期回落发一次 presence_changed(source:derived) ─────

interface Harness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  port: FakeStreamPort;
  mailbox: MeshMailbox;
  router: MeshRouter;
  limits: Limits;
}

function makeHarness(): Harness {
  const tdb = openTestDb();
  const limits: Limits = { ...DEFAULT_LIMITS };
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
  return { db: tdb.db, store, registry, events, port, mailbox, router, limits };
}

const ALL_KINDS: RegisterAccountInput["initiate"] = ["chat", "task", "event", "system", "tombstone"];

async function addAcc(h: Harness, id: string): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ALL_KINDS,
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

function msg(from: string, conversationId: string): RouteInput {
  return {
    from,
    conversationId,
    kind: "chat",
    expect: "none",
    text: "hello",
    clientToken: Math.random().toString(36).slice(2),
  };
}

describe("I24: derived fallback emits presence_changed", () => {
  it("expired until → derived transition emits once with source:derived", async () => {
    const h = makeHarness();
    await addAcc(h, "X");
    await addAcc(h, "Y");
    await addHotEndpoint(h, "X");
    // 派生本应 online（hot 端点）
    h.registry.setDeriveStatus(() => ({ busy: false, idleMs: 0 }));

    const changed: Array<{ accountId: string; from: string; to: string; source: string }> = [];
    h.events.on("presence_changed", (p) =>
      changed.push({ accountId: p.accountId, from: p.from, to: p.to, source: p.source }),
    );

    const conv = await h.registry.ensureDirect("X", "Y");
    // X 显式 offline（未过期）：第一次投递观察为 offline
    h.registry.setPresence("X", "offline", { until: isoFromMs(Date.now() + 60_000) });
    await h.router.route(msg("Y", conv.id));
    // 手动到期：第二次投递观察应为派生 online，并发出一次 source:derived 回落
    h.db
      .prepare("UPDATE mesh_accounts SET presence_until = ? WHERE id = ?")
      .run(isoFromMs(Date.now() - 1000), "X");
    await h.router.route(msg("Y", conv.id));

    const derived = changed.filter((e) => e.source === "derived");
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ accountId: "X", from: "offline", to: "online" });
    h.store.close();
  });
});