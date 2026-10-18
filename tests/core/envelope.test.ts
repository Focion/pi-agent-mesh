// ═══════════════════════════════════════════════════════════════════════════
// 信封物化（I06）：rowToEnvelope 是「存储行 → Envelope」的唯一权威构造器，
// 全字段无一丢弃；router 写盘草稿挂 ext，message_routed / 持久行都带 ext。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { rowToEnvelope, type MessageRow } from "../../src/core/envelope.js";
import { MeshEventBus } from "../../src/core/events.js";
import { createDefaultPolicies } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { MeshRouter } from "../../src/core/router.js";
import { SqliteStore } from "../../src/core/store.js";
import type { Envelope, Policies } from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { openTestDb } from "../helpers/db.js";

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "m_1",
    conversation_id: "conv_1",
    seq: 7,
    from_account: "alice",
    from_endpoint: "ep_alice",
    kind: "chat",
    expect: "reply",
    priority: "urgent",
    to_accounts: JSON.stringify(["bob", "carol"]),
    mentions: JSON.stringify(["bob"]),
    reply_to: "m_0",
    correlation_id: "corr_9",
    intent: "summarize",
    late: 0,
    logical_ts: "lt_1",
    routed_at: "2026-10-13T00:00:00.000Z",
    payload: JSON.stringify({
      text: "hi",
      data: { foo: 1 },
      attachments: [{ spaceId: "conv:space", key: "k1" }],
    }),
    idempotency_key: "key_1",
    seal: "abc123",
    tombstoned_by: null,
    ext: JSON.stringify({ tenant: "acme", trace: 42 }),
    ...over,
  };
}

describe("envelope: rowToEnvelope 全字段（I06）", () => {
  it("系统层 / 意图层 / 载荷 / 领域层字段全部保留", () => {
    const env = rowToEnvelope(row());
    expect(env).toMatchObject({
      id: "m_1",
      seq: 7,
      from: "alice",
      fromEndpoint: "ep_alice",
      routedAt: "2026-10-13T00:00:00.000Z",
      idempotencyKey: "key_1",
      seal: "abc123",
      conversationId: "conv_1",
      kind: "chat",
      expect: "reply",
      priority: "urgent",
      replyTo: "m_0",
      correlationId: "corr_9",
      requestType: "summarize", // 行 intent → requestType（§22.4 表划归一致）
      logicalTs: "lt_1",
    });
    expect(env.to).toEqual(["bob", "carol"]);
    expect(env.mentions).toEqual(["bob"]);
    // I12（§17）：claim 归属已下移到 mesh_deliveries，正文不再落 claim → 信封物化恒 undefined
    expect(env.claim).toBeUndefined();
    expect(env.ext).toEqual({ tenant: "acme", trace: 42 });
  });

  it("payload.data 与 payload.attachments 不丢（重载/重投路径依赖它）", () => {
    const env = rowToEnvelope(row());
    expect(env.payload.text).toBe("hi");
    expect(env.payload.data).toEqual({ foo: 1 });
    expect(env.payload.attachments).toEqual([{ spaceId: "conv:space", key: "k1" }]);
  });

  it("可空列 → undefined（不造假值）", () => {
    const env = rowToEnvelope(
      row({
        to_accounts: null,
        mentions: null,
        reply_to: null,
        correlation_id: null,
        intent: null,
        logical_ts: null,
        priority: null,
        seal: null,
        from_endpoint: null,
        ext: null,
        tombstoned_by: "m_0",
      }),
    );
    expect(env.to).toBeUndefined();
    expect(env.mentions).toBeUndefined();
    expect(env.replyTo).toBeUndefined();
    expect(env.correlationId).toBeUndefined();
    expect(env.requestType).toBeUndefined();
    expect(env.logicalTs).toBeUndefined();
    expect(env.priority).toBeUndefined();
    expect(env.seal).toBeUndefined();
    expect(env.fromEndpoint).toBeNull();
    expect(env.ext).toBeUndefined();
  });

  it("payload 空文本不存在时 text 为 undefined，不抛", () => {
    const env = rowToEnvelope(row({ payload: JSON.stringify({}) }));
    expect(env.payload.text).toBeUndefined();
    expect(env.payload.data).toBeUndefined();
    expect(env.payload.attachments).toBeUndefined();
  });
});

// ─── router 写盘草稿挂 ext（I06 #4）────────────────────────────────────────

describe("envelope: router 草稿带 ext", () => {
  it("route 写入 ext 列，message_routed 事件的信封带 ext", async () => {
    const tdb = openTestDb();
    const limits = DEFAULT_LIMITS;
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, limits);
    const events = new MeshEventBus();
    const policies: Policies = {
      ...createDefaultPolicies({
        isAwaiting: () => false,
        endpointsOf: () => [],
        limits,
      }),
      sessionFactory: {
        create: async () => ({ session: {}, piSessionId: "s" }),
        open: async () => ({ session: {} }),
      },
    };
    await registry.registerAccount({
      id: "alice",
      displayName: "alice",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    await registry.registerAccount({
      id: "bob",
      displayName: "bob",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    const conv = await registry.ensureDirect("alice", "bob");
    const routed: Envelope[] = [];
    events.on("message_routed", (p) => routed.push(p.envelope));
    const router = new MeshRouter({
      store,
      registry,
      events,
      policies,
      limits,
      devMode: true,
      onRouted: async () => {},
      isAwaiting: () => false,
    });
    await router.route({
      from: "alice",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "hello",
      ext: { tenant: "acme", trace: 42 },
      clientToken: "tok_ext",
    });

    const rows = tdb.db
      .prepare<[string, string], { ext: string | null }>(
        "SELECT ext FROM mesh_messages WHERE conversation_id = ? AND from_account = ?",
      )
      .all(conv.id, "alice") as Array<{ ext: string | null }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.ext!)).toEqual({ tenant: "acme", trace: 42 });
    expect(routed).toHaveLength(1);
    expect(routed[0]!.ext).toEqual({ tenant: "acme", trace: 42 });
    store.close();
  });

  it("无 ext 时 ext 列为 NULL，信封不带 ext", async () => {
    const tdb = openTestDb();
    const limits = DEFAULT_LIMITS;
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, limits);
    const events = new MeshEventBus();
    const policies: Policies = {
      ...createDefaultPolicies({
        isAwaiting: () => false,
        endpointsOf: () => [],
        limits,
      }),
      sessionFactory: {
        create: async () => ({ session: {}, piSessionId: "s" }),
        open: async () => ({ session: {} }),
      },
    };
    await registry.registerAccount({
      id: "alice",
      displayName: "alice",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    await registry.registerAccount({
      id: "bob",
      displayName: "bob",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    const conv = await registry.ensureDirect("alice", "bob");
    const router = new MeshRouter({
      store,
      registry,
      events,
      policies,
      limits,
      devMode: true,
      onRouted: async () => {},
      isAwaiting: () => false,
    });
    await router.route({
      from: "alice",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "hi",
      clientToken: "tok_noext",
    });
    const row = tdb.db
      .prepare<[string, string], { ext: string | null }>(
        "SELECT ext FROM mesh_messages WHERE conversation_id = ? AND from_account = ?",
      )
      .get(conv.id, "alice") as { ext: string | null };
    expect(row.ext).toBeNull();
    store.close();
  });
});