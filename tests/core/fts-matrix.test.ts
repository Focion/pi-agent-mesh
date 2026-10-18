// ═══════════════════════════════════════════════════════════════════════════
// FTS 开关矩阵（N04）：新建 / 同 flag 重开 / false→true 回填 / true→false 删除，
// 以及搜索在显式禁用时的「功能关闭」语义、表缺失时的空结果兜底。
// FTS 的建/删由 store 运行时对账管理（不改 000_init.sql，可逆），contentless 删表零数据损失。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MeshObserver } from "../../src/core/observer.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { SqliteStore } from "../../src/core/store.js";
import { DEFAULT_LIMITS, MeshUnsupportedError } from "../../src/core/types.js";
import { isoNow } from "../../src/core/util.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "mesh-fts-")), "mesh.db");
}

function ftsTableExists(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mesh_messages_fts'",
      )
      .get() as { n: number }
  ).n > 0;
}

function insAccount(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO mesh_accounts (id, display_name, endpoint_class, capabilities, initiate, presence, created_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  ).run(id, id, "stream", "[]", '["chat"]', "offline", isoNow());
}

function insConversation(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO mesh_conversations (id, type, next_seq, member_count, created_by, created_at) " +
      "VALUES (?,?,?,?,?,?)",
  ).run(id, "direct", 1, 2, "@system", isoNow());
}

/** 直接裸 SQL 造消息（不走 Router——那是 L2 泳道职责），返回 rowid 供 FTS 断言。 */
function insMessage(
  db: Database.Database,
  id: string,
  conv: string,
  seq: number,
  from: string,
  text: string,
): number {
  db.prepare(
    "INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, expect, routed_at, payload, idempotency_key) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(id, conv, seq, from, "chat", "none", isoNow(), JSON.stringify({ text }), "ik-" + id);
  return (db.prepare("SELECT rowid AS r FROM mesh_messages WHERE id = ?").get(id) as {
    r: number;
  }).r;
}

function ftsMatchRowids(db: Database.Database, phrase: string): number[] {
  return (
    db
      .prepare("SELECT rowid FROM mesh_messages_fts WHERE mesh_messages_fts MATCH ?")
      .all('"' + phrase + '"') as Array<{ rowid: number }>
  ).map((r) => r.rowid);
}

describe("FTS switch matrix (N04)", () => {
  it("fts=true fresh open → table present, enabled, meta '1'", () => {
    const store = SqliteStore.open(tmpDbPath(), { fts: true });
    try {
      expect(store.ftsEnabled).toBe(true);
      expect(ftsTableExists(store.db)).toBe(true);
      expect(store.getMeta("fts_enabled")).toBe("1");
    } finally {
      store.close();
    }
  });

  it("fts=false fresh open → table absent, disabled, meta '0'", () => {
    const store = SqliteStore.open(tmpDbPath(), { fts: false });
    try {
      expect(store.ftsEnabled).toBe(false);
      expect(ftsTableExists(store.db)).toBe(false);
      expect(store.getMeta("fts_enabled")).toBe("0");
    } finally {
      store.close();
    }
  });

  it("same flag reopen is stable (true→true, false→false)", () => {
    const path = tmpDbPath();
    const a = SqliteStore.open(path, { fts: true });
    a.close();
    const b = SqliteStore.open(path, { fts: true });
    expect(ftsTableExists(b.db)).toBe(true);
    b.close();

    const c = SqliteStore.open(path, { fts: false });
    expect(ftsTableExists(c.db)).toBe(false);
    c.close();
    const d = SqliteStore.open(path, { fts: false });
    expect(ftsTableExists(d.db)).toBe(false);
    d.close();
  });

  it("false→true reopen → create + backfill, history is searchable", () => {
    const path = tmpDbPath();
    const off = SqliteStore.open(path, { fts: false });
    insAccount(off.db, "a1");
    insConversation(off.db, "dc");
    const rid = insMessage(off.db, "m1", "dc", 1, "a1", "backfilled hello world");
    off.close();

    const on = SqliteStore.open(path, { fts: true });
    try {
      expect(ftsTableExists(on.db)).toBe(true);
      expect(ftsMatchRowids(on.db, "backfilled")).toContain(rid);
    } finally {
      on.close();
    }
  });

  it("true→false reopen → table dropped, disabled, meta '0'", () => {
    const path = tmpDbPath();
    const on = SqliteStore.open(path, { fts: true });
    insAccount(on.db, "a1");
    insConversation(on.db, "dc");
    insMessage(on.db, "m1", "dc", 1, "a1", "some text");
    on.close();

    const off = SqliteStore.open(path, { fts: false });
    try {
      expect(ftsTableExists(off.db)).toBe(false);
      expect(off.ftsEnabled).toBe(false);
      expect(off.getMeta("fts_enabled")).toBe("0");
    } finally {
      off.close();
    }
  });
});

describe("observer.search FTS semantics (N04)", () => {
  it("throws 功能关闭 when fts disabled", async () => {
    const store = SqliteStore.open(tmpDbPath(), { fts: false });
    try {
      const registry = new MeshRegistry(store.db);
      const obs = new MeshObserver({ store, registry, limits: DEFAULT_LIMITS });
      await expect(obs.search({ text: "hello" })).rejects.toThrow(MeshUnsupportedError);
      await expect(obs.search({ text: "hello" })).rejects.toThrow(/disabled/);
    } finally {
      store.close();
    }
  });

  it("degrades to [] when fts enabled but table missing (migration tolerance)", async () => {
    const store = SqliteStore.open(tmpDbPath(), { fts: true });
    try {
      store.db.exec("DROP TABLE IF EXISTS mesh_messages_fts");
      const registry = new MeshRegistry(store.db);
      const obs = new MeshObserver({ store, registry, limits: DEFAULT_LIMITS });
      expect(await obs.search({ text: "hello" })).toEqual([]);
    } finally {
      store.close();
    }
  });
});