// ═══════════════════════════════════════════════════════════════════════════
// SharedSpace（§18）单元测试：put/get、CAS、盲写、append、del/tombstone、list、
// ACL（conv 默认 / public）、版本历史与旧版本裁剪、OBJECT_TOO_LARGE。
// 每个用例独立打开临时库；写路径会发 shared_object_changed 事件。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { MeshEventBus } from "../../src/core/events.js";
import { createDefaultPolicies } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { SharedSpace } from "../../src/core/shared.js";
import { SqliteStore } from "../../src/core/store.js";
import { DEFAULT_LIMITS, MeshRejectError } from "../../src/core/types.js";
import type { Acl, Limits } from "../../src/core/types.js";
import { openTestDb } from "../helpers/db.js";

interface SharedHarness {
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  shared: SharedSpace;
}

function makeShared(opts: { limits?: Partial<Limits> } = {}): SharedHarness {
  const tdb = openTestDb();
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
  const events = new MeshEventBus();
  const policies = createDefaultPolicies({
    isAwaiting: () => false,
    endpointsOf: () => [],
    limits: DEFAULT_LIMITS,
  });
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const shared = new SharedSpace({
    db: store.db,
    registry,
    events,
    accessControl: policies.accessControl,
    limits,
  });
  return { store, registry, events, shared };
}

async function addAccount(registry: MeshRegistry, id: string): Promise<void> {
  await registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
  });
}

/** group 会话 + 对应 conv: 空间 id */
async function makeConvSpace(
  registry: MeshRegistry,
  members: string[] = ["A", "B"],
): Promise<string> {
  const conv = await registry.createConversation({
    type: "group",
    creator: members[0]!,
    members: members.slice(1),
  });
  return "conv:" + conv.id;
}

// ─── ① 基本 put/get ─────────────────────────────────────────────────────

describe("SharedSpace: put/get basics", () => {
  it("round-trips data with version and meta, and returns null for unknown key", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    const res = await h.shared.put("global", "k1", { hello: "world" }, { as: "A" });
    expect(res.version).toBe(1);

    const got = await h.shared.get("global", "k1", "A");
    expect(got).not.toBeNull();
    expect(got!.version).toBe(1);
    expect(got!.key).toBe("k1");
    expect(got!.ownerId).toBe("A");
    expect(got!.data).toEqual({ hello: "world" });
    expect(got!.size).toBeGreaterThan(0);

    expect(await h.shared.get("global", "missing", "A")).toBeNull();
    h.store.close();
  });

  it("emits shared_object_changed on every write with version and by", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    const seen: Array<{ spaceId: string; key: string; version: number; by: string }> = [];
    h.events.on("shared_object_changed", (p) => seen.push(p));

    await h.shared.put("global", "k", 1, { as: "A" });
    await h.shared.put("global", "k", 2, { as: "A" });

    expect(seen).toEqual([
      { spaceId: "global", key: "k", version: 1, by: "A" },
      { spaceId: "global", key: "k", version: 2, by: "A" },
    ]);
    h.store.close();
  });
});

// ─── ② CAS（乐观并发）───────────────────────────────────────────────────

describe("SharedSpace: CAS optimistic concurrency", () => {
  it("expectedVersion=0 asserts creation and fails on an existing key", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");

    await expect(
      h.shared.put("global", "k", "v1", { as: "A", expectedVersion: 0 }),
    ).resolves.toEqual({ version: 1 });

    await expect(
      h.shared.put("global", "k", "v2", { as: "A", expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(MeshRejectError);
    await expect(
      h.shared.put("global", "k", "v2", { as: "A", expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    h.store.close();
  });

  it("writes with the correct expectedVersion and rejects a stale one", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await h.shared.put("global", "k", "v1", { as: "A" }); // version 1

    const ok = await h.shared.put("global", "k", "v2", { as: "A", expectedVersion: 1 });
    expect(ok.version).toBe(2);

    await expect(
      h.shared.put("global", "k", "v3", { as: "A", expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    await expect(
      h.shared.put("global", "k", "v3", { as: "A", expectedVersion: 99 }),
    ).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    h.store.close();
  });
});

// ─── ③ 盲写 ─────────────────────────────────────────────────────────────

describe("SharedSpace: blind overwrite", () => {
  it("put without expectedVersion succeeds and bumps version", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");

    await h.shared.put("global", "k", "one", { as: "A" });
    const r2 = await h.shared.put("global", "k", "two", { as: "A" });
    expect(r2.version).toBe(2);

    const got = await h.shared.get("global", "k", "A");
    expect(got!.version).toBe(2);
    expect(got!.data).toBe("two");
    h.store.close();
  });
});

// ─── ④ Append ───────────────────────────────────────────────────────────

describe("SharedSpace: append", () => {
  it("creates an array on a new key, then pushes onto it", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");

    const r1 = await h.shared.append("global", "log", "a", { as: "A" });
    expect(r1.version).toBe(1);
    expect((await h.shared.get("global", "log", "A"))!.data).toEqual(["a"]);

    const r2 = await h.shared.append("global", "log", "b", { as: "A" });
    expect(r2.version).toBe(2);
    expect((await h.shared.get("global", "log", "A"))!.data).toEqual(["a", "b"]);
    h.store.close();
  });

  it("maxLen truncates from the front", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");

    for (const item of [1, 2, 3, 4]) {
      await h.shared.append("global", "q", item, { as: "A", maxLen: 3 });
    }
    expect((await h.shared.get("global", "q", "A"))!.data).toEqual([2, 3, 4]);
    h.store.close();
  });

  it("treats a non-array existing value as an empty list", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await h.shared.put("global", "k", "not-an-array", { as: "A" });

    await h.shared.append("global", "k", "x", { as: "A" });
    expect((await h.shared.get("global", "k", "A"))!.data).toEqual(["x"]);
    h.store.close();
  });
});

// ─── ⑤ Delete / tombstone ───────────────────────────────────────────────

describe("SharedSpace: delete / tombstone", () => {
  it("masks the object from get but keeps prior versions addressable", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await h.shared.put("global", "k", { v: 1 }, { as: "A" }); // version 1

    await h.shared.del("global", "k", { as: "A" });
    expect(await h.shared.get("global", "k", "A")).toBeNull();

    // del 也记了一个 tombstone 版本；v1 仍可按版本读回
    const old = await h.shared.get("global", "k", "A", 1);
    expect(old).not.toBeNull();
    expect(old!.version).toBe(1);
    expect(old!.data).toEqual({ v: 1 });
    h.store.close();
  });

  it("throws NO_SUCH_KEY when deleting a missing key", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await expect(
      h.shared.del("global", "nope", { as: "A" }),
    ).rejects.toMatchObject({ code: "NO_SUCH_KEY" });
    h.store.close();
  });

  it("throws NO_SUCH_KEY when deleting an already-tombstoned key", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await h.shared.put("global", "k", "x", { as: "A" });
    await h.shared.del("global", "k", { as: "A" });
    await expect(
      h.shared.del("global", "k", { as: "A" }),
    ).rejects.toMatchObject({ code: "NO_SUCH_KEY" });
    h.store.close();
  });
});

// ─── ⑥ List ─────────────────────────────────────────────────────────────

describe("SharedSpace: list", () => {
  it("lists keys with versions, respects keyPrefix, and omits tombstones", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    const space = await makeConvSpace(h.registry);

    await h.shared.put(space, "doc/1", { a: 1 }, { as: "A" });
    await h.shared.put(space, "doc/2", { a: 2 }, { as: "A" });
    await h.shared.put(space, "note/1", { a: 3 }, { as: "A" });

    // 成员（非创建者）也能 list
    const all = await h.shared.list(space, { as: "B" });
    expect(all.map((m) => m.key).sort()).toEqual(["doc/1", "doc/2", "note/1"]);
    expect(all.every((m) => m.data === undefined)).toBe(true); // list 不回传 data
    expect(all.find((m) => m.key === "doc/2")!.version).toBe(1);

    const docs = await h.shared.list(space, { as: "B", keyPrefix: "doc/" });
    expect(docs.map((m) => m.key).sort()).toEqual(["doc/1", "doc/2"]);

    // tombstone 被排除在 list 之外
    await h.shared.del(space, "doc/1", { as: "A" });
    const after = await h.shared.list(space, { as: "A", keyPrefix: "doc/" });
    expect(after.map((m) => m.key)).toEqual(["doc/2"]);
    h.store.close();
  });
});

// ─── ⑦ ACL ──────────────────────────────────────────────────────────────

describe("SharedSpace: ACL", () => {
  it("default conv ACL allows members and rejects outsiders", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    await addAccount(h.registry, "C"); // 非成员
    const space = await makeConvSpace(h.registry);

    await h.shared.put(space, "k", "x", { as: "A" });

    // 成员可读
    expect((await h.shared.get(space, "k", "B"))!.data).toBe("x");

    // 外人 get / put / del 一律 SPACE_FORBIDDEN
    await expect(h.shared.get(space, "k", "C")).rejects.toMatchObject({
      code: "SPACE_FORBIDDEN",
    });
    await expect(h.shared.put(space, "k2", "y", { as: "C" })).rejects.toMatchObject({
      code: "SPACE_FORBIDDEN",
    });

    // 成员可写、可删
    expect((await h.shared.put(space, "k2", "y", { as: "B" })).version).toBe(1);
    await expect(h.shared.del(space, "k2", { as: "C" })).rejects.toMatchObject({
      code: "SPACE_FORBIDDEN",
    });
    await h.shared.del(space, "k2", { as: "B" });

    // 外人的 list 也过滤为空（不泄露键名）
    expect(await h.shared.list(space, { as: "C" })).toEqual([]);
    h.store.close();
  });

  it("public ACL allows anyone to read and write", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    await addAccount(h.registry, "C");
    const space = await makeConvSpace(h.registry);
    const acl: Acl = {
      read: [{ kind: "public" }],
      write: [{ kind: "public" }],
      admin: [{ kind: "public" }],
    };

    await h.shared.put(space, "pub", "open", { as: "A", acl });

    expect((await h.shared.get(space, "pub", "C"))!.data).toBe("open");

    // 沿用 public ACL：外人 C 也能继续写
    const r = await h.shared.put(space, "pub", "by-C", { as: "C" });
    expect(r.version).toBe(2);
    expect((await h.shared.get(space, "pub", "A"))!.data).toBe("by-C");
    h.store.close();
  });

  it("three-way ACL adjudicates read vs write independently", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    await addAccount(h.registry, "C");
    const space = await makeConvSpace(h.registry);

    // read 对外开放，write 仅 owner(A)：非 owner 可读不可写
    await h.shared.put(space, "ro", "visible", {
      as: "A",
      acl: { read: [{ kind: "public" }], write: [{ kind: "accounts", accounts: ["A"] }], admin: [{ kind: "accounts", accounts: ["A"] }] },
    });

    expect((await h.shared.get(space, "ro", "C"))!.data).toBe("visible");
    await expect(
      h.shared.put(space, "ro", "by-C", { as: "C" }),
    ).rejects.toMatchObject({ code: "SPACE_FORBIDDEN" });

    // del 也走 write 面（§18）：只读者不能删
    await expect(h.shared.del(space, "ro", { as: "C" })).rejects.toMatchObject({
      code: "SPACE_FORBIDDEN",
    });

    // write 面独立裁决：授予非成员 C 写权（A 也保留写权以便创建）
    await h.shared.put(space, "wo", "writable", {
      as: "A",
      acl: { read: [{ kind: "accounts", accounts: ["A", "C"] }], write: [{ kind: "accounts", accounts: ["A", "C"] }], admin: [{ kind: "accounts", accounts: ["A"] }] },
    });
    expect((await h.shared.put(space, "wo", "by-C", { as: "C" })).version).toBe(2);
    h.store.close();
  });
});

// ─── ⑧ 版本历史与旧版本裁剪 ─────────────────────────────────────────────

describe("SharedSpace: version history and pruning", () => {
  it("records every version and reads a specific one via version param", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");

    for (let i = 1; i <= 3; i++) {
      await h.shared.put("global", "k", { n: i }, { as: "A" });
    }

    expect((await h.shared.get("global", "k", "A"))!.version).toBe(3);
    expect((await h.shared.get("global", "k", "A", 1))!.data).toEqual({ n: 1 });
    expect((await h.shared.get("global", "k", "A", 2))!.data).toEqual({ n: 2 });
    expect((await h.shared.get("global", "k", "A", 3))!.data).toEqual({ n: 3 });
    h.store.close();
  });

  it("prunes old versions per sharedVersionsKept", async () => {
    const h = makeShared({ limits: { sharedVersionsKept: 3 } });
    await addAccount(h.registry, "A");

    for (let i = 1; i <= 5; i++) {
      await h.shared.put("global", "k", `v${i}`, { as: "A" });
    }

    // 最新版本仍可盲读；最旧的 1、2 已被裁剪，3 起保留
    expect((await h.shared.get("global", "k", "A"))!.data).toBe("v5");
    expect(await h.shared.get("global", "k", "A", 1)).toBeNull();
    expect(await h.shared.get("global", "k", "A", 2)).toBeNull();
    expect((await h.shared.get("global", "k", "A", 3))!.data).toBe("v3");
    expect((await h.shared.get("global", "k", "A", 4))!.data).toBe("v4");
    expect((await h.shared.get("global", "k", "A", 5))!.data).toBe("v5");
    h.store.close();
  });
});

// ─── ⑨ OBJECT_TOO_LARGE ─────────────────────────────────────────────────

describe("SharedSpace: OBJECT_TOO_LARGE", () => {
  it("rejects data whose JSON encoding exceeds sharedObjectMaxBytes", async () => {
    const h = makeShared({ limits: { sharedObjectMaxBytes: 8 } });
    await addAccount(h.registry, "A");

    // `"123456789"` = 11 bytes > 8
    await expect(
      h.shared.put("global", "k", "123456789", { as: "A" }),
    ).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });

    // 超限写不入库，后续正常写入仍从 version 1 起
    await expect(h.shared.put("global", "k", "ok", { as: "A" })).resolves.toEqual({
      version: 1,
    });
    h.store.close();
  });

  it("defaults to 64KB (DEFAULT_LIMITS.sharedObjectMaxBytes)", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    const big = "x".repeat(DEFAULT_LIMITS.sharedObjectMaxBytes + 1);
    await expect(
      h.shared.put("global", "big", big, { as: "A" }),
    ).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
    h.store.close();
  });
});