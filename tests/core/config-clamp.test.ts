// ═══════════════════════════════════════════════════════════════════════════
// I30：会话配置写时钳制 + 溢出折叠读路径兜底。
// - createConversation / ensureDirect 落库前过 normalizeConfig（claimTtlMs 夹 [1000, 全局]）
// - foldOverflow 对「绕过写时钳制」注入的超标 maxPending 按全局上限折叠（不超）
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
  Limits,
  Policies,
  RegisterAccountInput,
  SinkHandler,
} from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const claimTtlFloor = 1000;
const claimTtlCeil = DEFAULT_LIMITS.claimTtlMs;

function storedConfig(tdb: { db: Database.Database }, convId: string): Record<string, unknown> {
  const row = tdb.db
    .prepare<[string], { config: string | null }>("SELECT config FROM mesh_conversations WHERE id = ?")
    .get(convId);
  return JSON.parse(row?.config ?? "{}") as Record<string, unknown>;
}

// ─── 写时钳制（registry 层）────────────────────────────────────────────────

describe("I30: config written with clamping", () => {
  it("createConversation clamps claimTtlMs into [floor, global ceiling]", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    await registry.registerAccount({ id: "B", displayName: "B", endpointClass: "stream" });

    const lo = await registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
      config: { claimTtlMs: 10 },
    });
    const hi = await registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
      config: { claimTtlMs: 9_999_999 },
    });

    expect(storedConfig(tdb, lo.id).claimTtlMs).toBe(claimTtlFloor); // 10 → 1000
    expect(storedConfig(tdb, hi.id).claimTtlMs).toBe(claimTtlCeil); // 超界 → 全局上限
    store.close();
  });

  it("ensureDirect writes a normalized config (full history, clamped claimTtlMs)", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    await registry.registerAccount({ id: "B", displayName: "B", endpointClass: "stream" });

    const d = await registry.ensureDirect("A", "B");
    const cfg = storedConfig(tdb, d.id);
    expect(cfg.historyVisibility).toBe("full");
    expect(cfg.claimTtlMs).toBe(claimTtlCeil);
    store.close();
  });

  it("maxPending on a freshly created conversation never exceeds the global cap", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    await registry.registerAccount({ id: "B", displayName: "B", endpointClass: "stream" });

    const g = await registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
      config: { maxPending: 9_999 },
    });
    expect(storedConfig(tdb, g.id).maxPending).toBe(DEFAULT_LIMITS.maxPending);
    store.close();
  });
});

// ─── 读路径兜底：foldOverflow 对注入的超标配置仍按全局上限折叠 ─────────────

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

const ALL_KINDS: RegisterAccountInput["initiate"] = [
  "chat",
  "task",
  "event",
  "system",
  "tombstone",
];

async function addAcc(h: Harness, id: string): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ALL_KINDS,
  });
}

function msg(from: string, conversationId: string, clientToken: string): RouteInput {
  return { from, conversationId, kind: "chat", expect: "none", text: "x", clientToken };
}

describe("I30: foldOverflow clamps raw oversized config to the global cap", () => {
  it("injected maxPending=999 folds at the global cap (4), not the raw value", async () => {
    const h = makeHarness({ limits: { maxPending: 4, maxPendingBytes: 1_000_000 } });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    // 模拟绕过写时钳制的损坏配置（直接注入超标 raw config）
    h.db
      .prepare("UPDATE mesh_conversations SET config = json_set(config, '$.maxPending', 999) WHERE id = ?")
      .run(conv.id);

    for (let i = 0; i < 5; i++) {
      await h.router.route(msg("A", conv.id, "f" + i));
    }
    await h.mailbox.sweep();

    const inbox = h.db
      .prepare<[string, string], { pending_count: number; overflow_count: number }>(
        "SELECT pending_count, overflow_count FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?",
      )
      .get("B", conv.id)!;
    // 若读路径未兜底（只有 COALESCE 无 MIN），maxPending=999 ⇒ 不折叠 ⇒ pending 保持 5
    expect(inbox.overflow_count).toBe(3); // ceil(5/2)
    expect(inbox.pending_count).toBe(2);
    h.store.close();
  });
});