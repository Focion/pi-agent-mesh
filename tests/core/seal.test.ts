// ═══════════════════════════════════════════════════════════════════════════
// 消息 seal（§22.4 / I07）：签名落库、默认关、验签失败拒绝投递 + 告警 + 保留原
// 消息、NULL 历史行放行。seal 必须盖住 ext（I06#4 与 I07 联动）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshEventBus } from "../../src/core/events.js";
import { MeshMailbox } from "../../src/core/mailbox.js";
import { createDefaultPolicies } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { MeshRouter } from "../../src/core/router.js";
import { computeSealToken, sealFieldsFromRow } from "../../src/core/seal.js";
import type { MessageRow } from "../../src/core/envelope.js";
import { SqliteStore } from "../../src/core/store.js";
import { InProcessTransport } from "../../src/core/transport.js";
import type { Policies } from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const KEY = "test-seal-key";

interface Harness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  mailbox: MeshMailbox;
  router: MeshRouter;
  sealKey?: string;
}

function makeHarness(sealKey?: string): Harness {
  const tdb = openTestDb();
  const limits = DEFAULT_LIMITS;
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  const port = new FakeStreamPort();
  const policies: Policies = {
    ...createDefaultPolicies({
      isAwaiting: () => false,
      endpointsOf: (acct) =>
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
    ...(sealKey !== undefined ? { sealKey } : {}),
    devMode: true,
  });
  const router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits,
    devMode: true,
    ...(sealKey !== undefined ? { sealKey } : {}),
    onRouted: async (env) => {
      await mailbox.fanout(env);
    },
    isAwaiting: () => false,
  });
  return { db: tdb.db, store, registry, events, mailbox, router, sealKey };
}

async function addPair(h: Harness, a: string, b: string): Promise<void> {
  await h.registry.registerAccount({ id: a, displayName: a, endpointClass: "stream", initiate: ["chat"] });
  await h.registry.registerAccount({ id: b, displayName: b, endpointClass: "stream", initiate: ["chat"] });
}

function messageRow(h: Harness, messageId: string): MessageRow {
  return h.db.prepare<[string], MessageRow>("SELECT * FROM mesh_messages WHERE id = ?").get(messageId) as MessageRow;
}

describe("seal: 签名落库（§22.4）", () => {
  it("提供 seal.key ⇒ seal 列非空且等于重算值（盖住 ext）", async () => {
    const h = makeHarness(KEY);
    await addPair(h, "alice", "bob");
    const conv = await h.registry.ensureDirect("alice", "bob");
    const r = await h.router.route({
      from: "alice",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "hi",
      ext: { tenant: "acme" },
      clientToken: "tok_seal",
    });
    const row = messageRow(h, r.messageId);
    expect(row.seal).not.toBeNull();
    expect(row.ext).toBe(JSON.stringify({ tenant: "acme" }));
    expect(row.seal).toBe(computeSealToken(KEY, sealFieldsFromRow(row)));
    h.store.close();
  });

  it("不提供 seal ⇒ seal 列为 NULL（默认关），验签不触发", async () => {
    const h = makeHarness(undefined);
    await addPair(h, "alice", "bob");
    const conv = await h.registry.ensureDirect("alice", "bob");
    const r = await h.router.route({
      from: "alice",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "hi",
      clientToken: "tok_noseal",
    });
    const row = messageRow(h, r.messageId);
    expect(row.seal).toBeNull();
    h.store.close();
  });
});

describe("seal: 验签失败 ⇒ 拒绝投递 + 告警 + 保留原消息（§22.4④）", () => {
  it("篡改 payload → retry 触发 seal_mismatch，投递被拒，原行不动", async () => {
    const h = makeHarness(KEY);
    await addPair(h, "alice", "bob");
    const conv = await h.registry.ensureDirect("alice", "bob");
    const r = await h.router.route({
      from: "alice",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "original",
      clientToken: "tok_tamper",
    });
    // 收件人无端点 ⇒ parked；篡改 payload 后再重投，走到 envelopeOf 验签
    h.db.prepare("UPDATE mesh_messages SET payload = ? WHERE id = ?").run(JSON.stringify({ text: "tampered" }), r.messageId);
    const violations: Array<{ code: string }> = [];
    h.events.on("invariant_violated", (p) => violations.push({ code: p.code }));

    await h.mailbox.retryAccount("bob");

    expect(violations).toContainEqual({ code: "seal_mismatch" });
    const counter = h.db.prepare("SELECT value AS n FROM mesh_counters WHERE name = 'invariant_violated'").get() as { n: number } | undefined;
    expect(counter?.n ?? 0).toBeGreaterThanOrEqual(1);
    // 拒绝投递：delivery 停在 queued（未 delivered/consumed）
    const d = h.db.prepare<[string, string], { state: string }>(
      "SELECT state FROM mesh_deliveries WHERE message_id = ? AND account_id = ?",
    ).get(r.messageId, "bob") as { state: string };
    expect(d.state).toBe("queued");
    // 原消息行不动（仍是篡改后的值，绝不静默修复/重建）
    const after = h.db.prepare("SELECT payload FROM mesh_messages WHERE id = ?").get(r.messageId) as { payload: string };
    expect(after.payload).toBe(JSON.stringify({ text: "tampered" }));
    h.store.close();
  });

  it("篡改 ext → seal_mismatch（证明 seal 盖住 ext，非空串哈希）", async () => {
    const h = makeHarness(KEY);
    await addPair(h, "alice", "bob");
    const conv = await h.registry.ensureDirect("alice", "bob");
    const r = await h.router.route({
      from: "alice",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "hi",
      ext: { tenant: "acme" },
      clientToken: "tok_ext",
    });
    h.db.prepare("UPDATE mesh_messages SET ext = ? WHERE id = ?").run(JSON.stringify({ tenant: "evil" }), r.messageId);
    const violations: Array<{ code: string }> = [];
    h.events.on("invariant_violated", (p) => violations.push({ code: p.code }));
    await h.mailbox.retryAccount("bob");
    expect(violations).toContainEqual({ code: "seal_mismatch" });
    h.store.close();
  });
});

describe("seal: NULL 历史行放行（不补签）", () => {
  it("启用 seal 但历史行 seal=NULL → 不验签，正常投递", async () => {
    const h = makeHarness(KEY);
    await addPair(h, "alice", "bob");
    const conv = await h.registry.ensureDirect("alice", "bob");
    const r = await h.router.route({
      from: "alice",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "legacy",
      clientToken: "tok_legacy",
    });
    // 模拟「启用 seal 之前落库」的历史行：seal 置 NULL
    h.db.prepare("UPDATE mesh_messages SET seal = NULL WHERE id = ?").run(r.messageId);
    const violations: Array<{ code: string }> = [];
    h.events.on("invariant_violated", (p) => violations.push({ code: p.code }));
    await h.mailbox.retryAccount("bob");
    expect(violations.filter((v) => v.code === "seal_mismatch")).toHaveLength(0);
    h.store.close();
  });
});