// ═══════════════════════════════════════════════════════════════════════════
// A32：Agent 建群绕过准入 + 会话配置写时夹紧。
//
//  - 建群准入：createConversation({type:"group", members}) 不得绕过「被拒绝的私聊」——
//    对每个非创建者成员走 canInitiateDirect（fail-closed），否决 → reject(CANNOT_INITIATE)。
//  - 配置只允许比全局更收紧：
//      · mentionAllPerHour 夹 [0, 100]（§附录 F.3 值域 0–100）；
//      · maxHistoryOnJoin 夹 [0, 500]（注入是成本 §9.4，防无界注水）；
//      · historyVisibility 非法值回落到 "since_join"（默认 §9.4）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { SessionFactory } from "../../src/index.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { SqliteStore } from "../../src/core/store.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, runtimeRef: "a32" }),
  open: async () => ({ session: {} }),
};

function storedConfig(tdb: { db: Database.Database }, convId: string): Record<string, unknown> {
  const row = tdb.db
    .prepare<[string], { config: string | null }>("SELECT config FROM mesh_conversations WHERE id = ?")
    .get(convId);
  return JSON.parse(row?.config ?? "{}") as Record<string, unknown>;
}

describe("A32: 建群准入", () => {
  it("canInitiateDirect 拒绝的成员不得在建群时被拉入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-a32-"));
    const host = await createMesh({
      dbPath: join(dir, "mesh.db"),
      policies: {
        sessionFactory: stubSessionFactory,
        accessControl: { canInitiateDirect: (_from, to) => to.id !== "blocked" },
      },
      streamPort: new FakeStreamPort(),
      devMode: true,
    });
    try {
      for (const id of ["alice", "bob", "blocked"]) {
        await host.registerAccount({
          id,
          displayName: id,
          endpointClass: "stream",
          initiate: ["chat"],
        });
      }
      // 被拒绝的「私聊对端」不能借建群气场拉进来
      await expect(
        host.createConversation({ type: "group", creator: "alice", members: ["blocked"] }),
      ).rejects.toMatchObject({ code: "CANNOT_INITIATE" });

      // 放行成员照常建群
      const ok = await host.createConversation({
        type: "group",
        creator: "alice",
        members: ["bob"],
      });
      expect(ok.id).toBeTruthy();
    } finally {
      await host.close();
    }
  });
});

describe("A32: 会话配置夹紧", () => {
  it("mentionAllPerHour / maxHistoryOnJoin 夹上界，historyVisibility 非法回落 since_join", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    await registry.registerAccount({ id: "B", displayName: "B", endpointClass: "stream" });

    const g = await registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
      config: {
        mentionAllPerHour: 9999,
        maxHistoryOnJoin: 9999,
        historyVisibility: "bogus" as never,
      },
    });
    const cfg = storedConfig(tdb, g.id);
    expect(cfg.mentionAllPerHour).toBe(100);
    expect(cfg.maxHistoryOnJoin).toBe(500);
    expect(cfg.historyVisibility).toBe("since_join");
    store.close();
  });

  it("mentionAllPerHour 夹下界 0（负数/NaN 落到合法值）", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    await registry.registerAccount({ id: "B", displayName: "B", endpointClass: "stream" });

    const neg = await registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
      config: { mentionAllPerHour: -5 },
    });
    const nan = await registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
      config: { mentionAllPerHour: Number.NaN },
    });
    expect(storedConfig(tdb, neg.id).mentionAllPerHour).toBe(0);
    expect(storedConfig(tdb, nan.id).mentionAllPerHour).toBe(3); // 非有限数 → 默认 3
    store.close();
  });
});