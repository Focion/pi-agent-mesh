// ═══════════════════════════════════════════════════════════════════════════
// registry.ts 分支覆盖率补齐（G07 state-machine 范围）。
// 只构造 MeshRegistry + SqliteStore（内存临时 SQLite，不依赖 pi SDK / 真实 LLM）。
// 目标：逐个命中 registry.ts 中尚未覆盖的分支（序列化回退、拓扑投影、在场派生、
// 会话创建校验、成员/seq 边界回退等），把分支覆盖从 ~82% 推到 ≥95%。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshRegistry } from "../../src/core/registry.js";
import { SqliteStore } from "../../src/core/store.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import type { Limits } from "../../src/core/types.js";
import { openTestDb } from "../helpers/db.js";

function makeRegistry(limits: Limits = DEFAULT_LIMITS): {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
} {
  const tdb = openTestDb();
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, limits);
  return { db: store.db, store, registry };
}

async function seedAccount(
  registry: MeshRegistry,
  id: string,
  endpointClass: "stream" | "sink" | "external" = "stream",
) {
  return registry.registerAccount({ id, displayName: id, endpointClass });
}

describe("registry branch coverage：account 序列化与回退", () => {
  it("registerAccount 省略 id 用 ulid 回退，capabilities/initiate/ext 完整回读", async () => {
    const { store, registry } = makeRegistry();
    const acc = await registry.registerAccount({
      displayName: "no-id",
      endpointClass: "stream",
      capabilities: ["speak", "read"],
      initiate: ["chat", "task"],
      ext: { foo: 1 },
    });
    expect(acc.id).toBeTruthy();
    const got = registry.getAccount(acc.id)!;
    expect(got.capabilities).toEqual(["speak", "read"]);
    expect(got.initiate).toEqual(["chat", "task"]);
    expect(got.ext).toEqual({ foo: 1 });
    store.close();
  });

  it("registerAccount 省略 capabilities/initiate/ext → []/[]/undefined", async () => {
    const { store, registry } = makeRegistry();
    await registry.registerAccount({ id: "X", displayName: "X", endpointClass: "stream" });
    const got = registry.getAccount("X")!;
    expect(got.capabilities).toEqual([]);
    expect(got.initiate).toEqual([]);
    expect(got.ext).toBeUndefined();
    store.close();
  });

  it("getAccount 对缺失账号返回 undefined", () => {
    const { store, registry } = makeRegistry();
    expect(registry.getAccount("missing")).toBeUndefined();
    store.close();
  });
});

describe("registry branch coverage：endpoint 拓扑投影", () => {
  it("perConversation 端点写入并读回 scope/key", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const ep = await registry.registerEndpoint({
      accountId: "A",
      topology: { kind: "perConversation", scope: "purpose", key: "k1" },
    });
    expect(registry.getEndpoint(ep.id)!.topology).toEqual({
      kind: "perConversation",
      scope: "purpose",
      key: "k1",
    });
    store.close();
  });

  it("pooled 端点省略 affinity → 读回 affinity none", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const ep = await registry.registerEndpoint({
      accountId: "A",
      topology: { kind: "pooled", size: 2 },
    });
    expect(registry.getEndpoint(ep.id)!.topology).toEqual({
      kind: "pooled",
      size: 2,
      affinity: "none",
    });
    store.close();
  });

  it("pooled 端点保留显式 affinity；unified 端点读回", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const p = await registry.registerEndpoint({
      accountId: "A",
      topology: { kind: "pooled", size: 3, affinity: "sender" },
    });
    expect(registry.getEndpoint(p.id)!.topology).toEqual({
      kind: "pooled",
      size: 3,
      affinity: "sender",
    });
    const u = await registry.registerEndpoint({
      accountId: "A",
      topology: { kind: "unified" },
    });
    expect(registry.getEndpoint(u.id)!.topology).toEqual({ kind: "unified" });
    store.close();
  });

  it("legacy perConversation 行（scope/scope_key NULL）读回默认 scope/key", async () => {
    const { db, store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    db.prepare("INSERT INTO mesh_endpoints (id, account_id, topology) VALUES (?,?,?)").run(
      "ep-legacy-pc",
      "A",
      "perConversation",
    );
    expect(registry.getEndpoint("ep-legacy-pc")!.topology).toEqual({
      kind: "perConversation",
      scope: "conversation",
      key: "",
    });
    store.close();
  });

  it("registerPooledEndpoints 按槽位写入 piSessionIds", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const eps = await registry.registerPooledEndpoints("A", 2, "none", ["pi-0", "pi-1"]);
    expect(eps.map((e) => e.piSessionId)).toEqual(["pi-0", "pi-1"]);
    store.close();
  });

  it("registerPooledEndpoints 省略 piSessionIds → piSessionId null", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const eps = await registry.registerPooledEndpoints("A", 1);
    expect(eps[0]!.piSessionId).toBeNull();
    store.close();
  });
});

describe("registry branch coverage：conversation 投影与校验", () => {
  it("archiveConversation 后 state 读回 archived", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    await seedAccount(registry, "B");
    const conv = await registry.ensureDirect("A", "B");
    expect(registry.getConversation(conv.id)!.state).toBe("active");
    registry.archiveConversation(conv.id);
    expect(registry.getConversation(conv.id)!.state).toBe("archived");
    store.close();
  });

  it("created_by 为 NULL 的会话行投影为 ''", async () => {
    const { db, store, registry } = makeRegistry();
    db.prepare(
      "INSERT INTO mesh_conversations (id, type, created_at) VALUES (?,?,?)",
    ).run("c-null-creator", "direct", "2020-01-01T00:00:00Z");
    expect(registry.getConversation("c-null-creator")!.createdBy).toBe("");
    store.close();
  });

  it("createConversation 携带 ext 完整回读", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const conv = await registry.createConversation({
      type: "group",
      creator: "A",
      ext: { tag: "x", n: 5 },
    });
    expect(registry.getConversation(conv.id)!.ext).toEqual({ tag: "x", n: 5 });
    store.close();
  });

  it("createConversation 省略 ext → undefined", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const conv = await registry.createConversation({ type: "group", creator: "A" });
    expect(registry.getConversation(conv.id)!.ext).toBeUndefined();
    store.close();
  });

  it("createConversation 的 creator 不存在 → NOT_A_MEMBER", () => {
    const { store, registry } = makeRegistry();
    try {
      registry.createConversation({ type: "group", creator: "ghost" });
      expect.unreachable("应当同步抛出 NOT_A_MEMBER");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("NOT_A_MEMBER");
    }
    store.close();
  });

  it("group 成员数超过 groupSizeHardCap → FANOUT_TOO_LARGE", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    await seedAccount(registry, "B");
    await seedAccount(registry, "C");
    try {
      registry.createConversation({
        type: "group",
        creator: "A",
        members: ["B", "C"],
        config: { groupSizeHardCap: 2 },
      });
      expect.unreachable("应当同步抛出 FANOUT_TOO_LARGE");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("FANOUT_TOO_LARGE");
    }
    store.close();
  });

  it("group 省略 members → 回退空数组并按 creator 创建", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const conv = await registry.createConversation({ type: "group", creator: "A" });
    expect(registry.memberCount(conv.id)).toBe(1);
    store.close();
  });

  it("topic 会话不建成员行", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const conv = await registry.createConversation({ type: "topic", creator: "A", topic: "news" });
    expect(registry.memberCount(conv.id)).toBe(0);
    expect(registry.listMembers(conv.id)).toEqual([]);
    store.close();
  });

  it("setTopic 传 null/undefined 时保留原值（COALESCE 语义）", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const conv = await registry.createConversation({ type: "group", creator: "A", topic: "before" });
    registry.setTopic(conv.id, "after", "ann");
    expect(registry.getConversation(conv.id)!.topic).toBe("after");
    expect(registry.getConversation(conv.id)!.announcement).toBe("ann");
    registry.setTopic(conv.id);
    expect(registry.getConversation(conv.id)!.topic).toBe("after");
    expect(registry.getConversation(conv.id)!.announcement).toBe("ann");
    store.close();
  });
});

describe("registry branch coverage：presence 派生与显式判定", () => {
  it("effectivePresence 对缺失账号返回 offline", () => {
    const { store, registry } = makeRegistry();
    expect(registry.effectivePresence("missing")).toBe("offline");
    store.close();
  });

  it("derivePresence：无 hot 端点 → sink online、stream offline", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "S", "sink");
    await seedAccount(registry, "X", "stream");
    expect(registry.effectivePresence("S")).toBe("online");
    expect(registry.effectivePresence("X")).toBe("offline");
    store.close();
  });

  it("derivePresence：deriveStatus 注入 busy / idleMs 解析在线与空闲", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const ep = await registry.registerEndpoint({ accountId: "A", topology: { kind: "unified" } });
    registry.updateEndpointState(ep.id, "hot");

    registry.setDeriveStatus(() => ({ busy: true }));
    expect(registry.effectivePresence("A")).toBe("busy");

    registry.setDeriveStatus(() => ({ busy: false, idleMs: 100 }));
    expect(registry.effectivePresence("A")).toBe("online");

    registry.setDeriveStatus(() => ({ busy: false, idleMs: DEFAULT_LIMITS.presenceIdleMs }));
    expect(registry.effectivePresence("A")).toBe("idle");
    store.close();
  });

  it("derivePresence：hot 端点 last_active_at 无/旧混合，回退 reduce 求空闲", async () => {
    const { db, store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    // 一个 hot 端点 last_active_at NULL（NaN 分支），一个 400s 前的旧时间（数值分支）。
    db.prepare("INSERT INTO mesh_endpoints (id, account_id, topology, state) VALUES (?,?,?,?)")
      .run("ep-null", "A", "unified", "hot");
    db.prepare(
      "INSERT INTO mesh_endpoints (id, account_id, topology, state, last_active_at) VALUES (?,?,?,?,?)",
    ).run("ep-old", "A", "unified", "hot", new Date(Date.now() - 400_000).toISOString());
    // 无 deriveStatus → idleMs 由 last_active_at 派生 → 400s > 300s → idle。
    expect(registry.effectivePresence("A")).toBe("idle");
    store.close();
  });

  it("derivePresence：hot 端点 last_active_at 全 NULL → lastActive 0 → online", async () => {
    const { db, store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    db.prepare("INSERT INTO mesh_endpoints (id, account_id, topology, state) VALUES (?,?,?,?)")
      .run("ep-null", "A", "unified", "hot");
    expect(registry.effectivePresence("A")).toBe("online");
    store.close();
  });

  it("derivePresence：deriveStatus 抛错时 catch 回退 last_active_at", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    const ep = await registry.registerEndpoint({ accountId: "A", topology: { kind: "unified" } });
    registry.updateEndpointState(ep.id, "hot");
    registry.setDeriveStatus(() => {
      throw new Error("boom");
    });
    // catch → undefined → 回落 last_active_at（刚 hot 化，接近 now）= online。
    expect(registry.effectivePresence("A")).toBe("online");
    store.close();
  });

  it("isExplicitPresence：新账号与缺失账号均为 false", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    expect(registry.isExplicitPresence("A")).toBe(false);
    expect(registry.isExplicitPresence("missing")).toBe(false);
    store.close();
  });

  it("构造函数 opts.deriveStatus 生效", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS, {
      deriveStatus: () => ({ busy: true }),
    });
    await seedAccount(registry, "A");
    const ep = await registry.registerEndpoint({ accountId: "A", topology: { kind: "unified" } });
    registry.updateEndpointState(ep.id, "hot");
    expect(registry.effectivePresence("A")).toBe("busy");
    store.close();
  });
});

describe("registry branch coverage：成员与 seq 边界", () => {
  it("addMember 对曾退群成员走 UPDATE 重加入路径", async () => {
    const { store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    await seedAccount(registry, "B");
    const conv = await registry.createConversation({ type: "group", creator: "A" });
    registry.addMember(conv.id, "B", ["speak", "read"]);
    expect(registry.getMembership(conv.id, "B")).toBeDefined();
    registry.removeMember(conv.id, "B");
    expect(registry.getMembership(conv.id, "B")).toBeUndefined();
    // 有此前的成员行（left_at 已置）→ 走 UPDATE 分支恢复 left_at=NULL。
    registry.addMember(conv.id, "B", ["speak", "read"]);
    expect(registry.getMembership(conv.id, "B")).toBeDefined();
    store.close();
  });

  it("getMembership 正确投影 verbatim_pinned 的 null/0/1 三态", async () => {
    const { db, store, registry } = makeRegistry();
    await seedAccount(registry, "A");
    await seedAccount(registry, "B");
    const conv = await registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    expect(registry.getMembership(conv.id, "A")!.verbatimPinned).toBeUndefined();
    db.prepare(
      "UPDATE mesh_memberships SET verbatim_pinned = ? WHERE conversation_id = ? AND account_id = ?",
    ).run(1, conv.id, "A");
    expect(registry.getMembership(conv.id, "A")!.verbatimPinned).toBe(true);
    db.prepare(
      "UPDATE mesh_memberships SET verbatim_pinned = ? WHERE conversation_id = ? AND account_id = ?",
    ).run(0, conv.id, "A");
    expect(registry.getMembership(conv.id, "A")!.verbatimPinned).toBe(false);
    store.close();
  });

  it("memberCount 对缺失会话返回 0", () => {
    const { store, registry } = makeRegistry();
    expect(registry.memberCount("no-conv")).toBe(0);
    store.close();
  });

  it("allocateSeq / currentSeq 对缺失会话安全回退", () => {
    const { store, registry } = makeRegistry();
    expect(registry.allocateSeq("no-conv")).toBe(1);
    expect(registry.currentSeq("no-conv")).toBe(0);
    store.close();
  });
});