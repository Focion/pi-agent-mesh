// ═══════════════════════════════════════════════════════════════════════════
// SharedSpace §4.2 合同测试（W12 · I19/I20/I23）：
//   ① put 写按旧 ACL 裁决；换 ACL 要求旧 ACL 的 admin（不在新 ACL 上测写）；
//   ② del 走 admin 面（§18.6），并推进 objects.version（§18.1 单调、删除重建单调）；
//   ③ 并发 append 不丢（读-改-写同事务，版本单调无唯一键异常）；
//   ④ 删除→重建→裁剪组合下无唯一键异常、版本不回退；
//   ⑤ conv 变更通知按 read 全体过滤：有收件人读不到时抑制通知、保留宿主事件；
//   ⑥ 归档会话禁写（put/append/del），读仍放行。
// 每个用例独立临时库；写路径发 shared_object_changed 事件，notify 为装配回调（此处 spy）。
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

interface Harness {
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  shared: SharedSpace;
  notifies: Array<{ spaceId: string; key: string; version: number; op: string }>;
}

function makeShared(opts: { limits?: Partial<Limits> } = {}): Harness {
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
  const notifies: Harness["notifies"] = [];
  const shared = new SharedSpace({
    db: store.db,
    registry,
    events,
    accessControl: policies.accessControl,
    limits,
    notify: (spaceId, key, version, _by, op) => {
      notifies.push({ spaceId, key, version, op });
    },
  });
  return { store, registry, events, shared, notifies };
}

async function addAccount(registry: MeshRegistry, id: string): Promise<void> {
  await registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
  });
}

/** group 会话 + 对应 conv: 空间 id（成员按传入名单） */
async function makeConv(
  registry: MeshRegistry,
  members: string[],
): Promise<{ space: string; convId: string }> {
  const conv = await registry.createConversation({
    type: "group",
    creator: members[0]!,
    members: members.slice(1),
  });
  return { space: "conv:" + conv.id, convId: conv.id };
}

const ADMIN_OWNER = (owner: string): Acl["admin"] => [
  { kind: "accounts", accounts: [owner] },
];

// ─── ① put：写按旧 ACL、换 ACL 需旧 admin ────────────────────────────────

describe("SharedSpace §4.2: put authorizes against OLD acl", () => {
  it("write is checked against old acl — self-granting write in the new acl does not bypass", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    const { space } = await makeConv(h.registry, ["A", "B"]);
    // 旧 ACL：仅 A 可写、可管理
    await h.shared.put(space, "k", "v1", {
      as: "A",
      acl: {
        read: [{ kind: "conversation", conversationId: space.slice(5) }],
        write: [{ kind: "accounts", accounts: ["A"] }],
        admin: ADMIN_OWNER("A"),
      },
    });
    // B 在旧 ACL 无写权；传入的新 ACL 给自己加写权也不该通过（写按旧 ACL 裁决，I19）
    const selfGrant: Acl = {
      read: [{ kind: "conversation", conversationId: space.slice(5) }],
      write: [{ kind: "accounts", accounts: ["A", "B"] }],
      admin: ADMIN_OWNER("A"),
    };
    await expect(
      h.shared.put(space, "k", "v2", { as: "B", acl: selfGrant, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "SPACE_FORBIDDEN" });

    // 正例：B 在旧 ACL 有写权、带 expectedVersion 正常盲写（不换 ACL）仍放行
    await h.shared.put(space, "k2", "v1", {
      as: "A",
      acl: {
        read: [{ kind: "conversation", conversationId: space.slice(5) }],
        write: [{ kind: "conversation", conversationId: space.slice(5) }],
        admin: ADMIN_OWNER("A"),
      },
    });
    const r = await h.shared.put(space, "k2", "v2", { as: "B", expectedVersion: 1 });
    expect(r.version).toBe(2);
    h.store.close();
  });

  it("changing acl requires admin on the OLD acl (non-admin writer with write cap is denied)", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    const { space } = await makeConv(h.registry, ["A", "B"]);
    // 旧 ACL：B 有 write 但非 admin
    await h.shared.put(space, "k", "v1", {
      as: "A",
      acl: {
        read: [{ kind: "conversation", conversationId: space.slice(5) }],
        write: [{ kind: "conversation", conversationId: space.slice(5) }],
        admin: ADMIN_OWNER("A"),
      },
    });
    // B 尝试换 ACL（写入自身作为 admin）→ 需旧 ACL admin，被拒
    const swap: Acl = {
      read: [{ kind: "conversation", conversationId: space.slice(5) }],
      write: [{ kind: "conversation", conversationId: space.slice(5) }],
      admin: [{ kind: "accounts", accounts: ["B"] }],
    };
    await expect(
      h.shared.put(space, "k", "v2", { as: "B", acl: swap, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "SPACE_FORBIDDEN" });
    // A（admin）可换
    const ok = await h.shared.put(space, "k", "v2", { as: "A", acl: swap, expectedVersion: 1 });
    expect(ok.version).toBe(2);
    h.store.close();
  });
});

// ─── ② del：admin 面 + 版本推进 ──────────────────────────────────────────

describe("SharedSpace §4.2: del goes through admin and advances version", () => {
  it("tombstone advances objects.version (delete → recreate stays monotonic)", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    const { space } = await makeConv(h.registry, ["A", "B"]);
    await h.shared.put(space, "k", "v1", { as: "A" }); // v1
    await h.shared.del(space, "k", { as: "A" }); // 墓碑 → v2

    // objects.version 已推进到墓碑版本（§18.1 断言：objects.version == max(versions.version)）
    const obj = h.store.db
      .prepare("SELECT version, tombstoned FROM mesh_shared_objects WHERE space_id = ? AND key = ?")
      .get(space, "k") as { version: number; tombstoned: number };
    expect(obj.version).toBe(2);
    expect(obj.tombstoned).toBe(1);
    const maxV = h.store.db
      .prepare("SELECT MAX(version) AS m FROM mesh_shared_versions WHERE space_id = ? AND key = ?")
      .get(space, "k") as { m: number };
    expect(maxV.m).toBe(2);

    // 删除后重建：版本不回退
    const r = await h.shared.put(space, "k", "v3", { as: "A", expectedVersion: 0 });
    expect(r.version).toBe(3);
    h.store.close();
  });

  it("member with write but not admin cannot del (§18.6)", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    const { space } = await makeConv(h.registry, ["A", "B"]);
    await h.shared.put(space, "k", "v1", {
      as: "A",
      acl: {
        read: [{ kind: "conversation", conversationId: space.slice(5) }],
        write: [{ kind: "conversation", conversationId: space.slice(5) }], // B 可写
        admin: ADMIN_OWNER("A"), // 仅 A 是 admin
      },
    });
    await expect(h.shared.del(space, "k", { as: "B" })).rejects.toMatchObject({
      code: "SPACE_FORBIDDEN",
    });
    await h.shared.del(space, "k", { as: "A" });
    h.store.close();
  });
});

// ─── ③ 并发 append 不丢 ─────────────────────────────────────────────────

describe("SharedSpace §18.3: concurrent append loses nothing", () => {
  it("N concurrent appends all land (read-modify-write is atomic in the tx)", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) => h.shared.append("global", "log", i, { as: "A" })),
    );
    const got = await h.shared.get("global", "log", "A");
    expect(got!.version).toBe(N);
    const data = got!.data as number[];
    expect(data).toHaveLength(N);
    // 每个并发追加的条目都在，无覆盖丢失
    expect([...data].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
    h.store.close();
  });

  it("append + maxLen truncation + version monotonic all coexist", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    for (let i = 0; i < 12; i++) {
      await h.shared.append("global", "q", i, { as: "A", maxLen: 5 });
    }
    const got = await h.shared.get("global", "q", "A");
    expect(got!.data).toEqual([7, 8, 9, 10, 11]);
    expect(got!.version).toBe(12);
    h.store.close();
  });
});

// ─── ④ 删除→重建→裁剪组合：无唯一键异常、版本单调 ────────────────────────

describe("SharedSpace §18.4: delete/recreate/prune without unique-key anomalies", () => {
  it("interleaved put/del/recreate with pruning keeps versions monotonic", async () => {
    const h = makeShared({ limits: { sharedVersionsKept: 4 } });
    await addAccount(h.registry, "A");
    let v = 0;
    for (let round = 0; round < 5; round++) {
      v = (await h.shared.put("global", "k", `r${round}`, { as: "A" })).version;
      await h.shared.del("global", "k", { as: "A" });
      const res = await h.shared.put("global", "k", `r${round}b`, { as: "A", expectedVersion: 0 });
      v = res.version;
    }
    // 版本单调不回退；末尾版本可读
    const got = await h.shared.get("global", "k", "A");
    expect(got!.version).toBe(v);
    const maxV = h.store.db
      .prepare("SELECT MAX(version) AS m FROM mesh_shared_versions WHERE space_id = 'global' AND key = 'k'")
      .get() as { m: number };
    expect(maxV.m).toBe(v);
    h.store.close();
  });
});

// ─── ⑤ 变更通知按 read 过滤（私有对象 key 不进群历史）────────────────────

describe("SharedSpace §4.2: notification filtered by read acl", () => {
  it("suppresses conv notification when any history-readable member cannot read (host event kept)", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    await addAccount(h.registry, "C");
    const { space } = await makeConv(h.registry, ["A", "B", "C"]);

    const changed: number[] = [];
    h.events.on("shared_object_changed", (p) => changed.push(p.version));

    // 私有对象：C（成员）读不到
    await h.shared.put(space, "secret", "x", {
      as: "A",
      acl: {
        read: [{ kind: "accounts", accounts: ["A", "B"] }],
        write: [{ kind: "accounts", accounts: ["A"] }],
        admin: ADMIN_OWNER("A"),
      },
    });
    // 宿主事件照发，但公共会话通知被抑制（C 无 read → 不泄露 key）
    expect(changed).toEqual([1]);
    expect(h.notifies).toEqual([]);

    // 公开对象：全员可读 → 通知放行
    await h.shared.put(space, "open", "y", {
      as: "A",
      acl: {
        read: [{ kind: "conversation", conversationId: space.slice(5) }],
        write: [{ kind: "accounts", accounts: ["A"] }],
        admin: ADMIN_OWNER("A"),
      },
    });
    expect(changed).toEqual([1, 1]);
    expect(h.notifies.map((n) => n.key)).toEqual(["open"]);
    h.store.close();
  });

  it("global/acct spaces skip the notification gate (assembly notify is a no-op anyway)", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await h.shared.put("global", "k", "x", { as: "A" });
    expect(h.notifies.map((n) => n.key)).toEqual(["k"]);
    h.store.close();
  });
});

// ─── ⑥ 归档禁写 ─────────────────────────────────────────────────────────

describe("SharedSpace §18.4: archived conv rejects writes (reads stay allowed)", () => {
  it("put/append/del all reject on an archived conversation; get/list still work", async () => {
    const h = makeShared();
    await addAccount(h.registry, "A");
    await addAccount(h.registry, "B");
    const { space, convId } = await makeConv(h.registry, ["A", "B"]);
    await h.shared.put(space, "k", "v1", { as: "A" });

    h.registry.archiveConversation(convId);

    await expect(h.shared.put(space, "k", "v2", { as: "A", expectedVersion: 1 })).rejects.toMatchObject({
      code: "SPACE_FORBIDDEN",
    });
    await expect(h.shared.append(space, "k", "item", { as: "A" })).rejects.toMatchObject({
      code: "SPACE_FORBIDDEN",
    });
    await expect(h.shared.del(space, "k", { as: "A" })).rejects.toMatchObject({
      code: "SPACE_FORBIDDEN",
    });

    // 读仍放行
    expect((await h.shared.get(space, "k", "B"))!.data).toBe("v1");
    expect((await h.shared.list(space, { as: "B" })).map((m) => m.key)).toEqual(["k"]);
    h.store.close();
  });
});