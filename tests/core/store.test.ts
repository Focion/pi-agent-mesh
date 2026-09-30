// Store 元信息与迁移闸门（§11.7 / §12.1① / §28.3）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIBRARY_VERSION, SqliteStore } from "../../src/core/store.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mesh-store-"));
  return join(dir, "mesh.db");
}

describe("SqliteStore meta keys & migration guard", () => {
  it("seeds required meta keys on first open (§11.7 / §28.3)", () => {
    const store = SqliteStore.open(tmpDbPath());
    try {
      // schema_version 由 000_init.sql 写入；其余键由 seedMeta()/migrate() 补齐
      expect(store.getMeta("schema_version")).toBe("1");
      expect(store.getMeta("created_at")).toBeDefined();
      expect(store.getMeta("schema_applied_at")).toBeDefined();
      expect(store.getMeta("library_version")).toBe(LIBRARY_VERSION);
    } finally {
      store.close();
    }
  });

  it("refreshes library_version on every open (§28.3 取证书)", () => {
    const path = tmpDbPath();
    const a = SqliteStore.open(path);
    a.setMeta("library_version", "0.0.0-stale");
    a.close();
    // 重新打开：library_version 应被刷新回当前库版本
    const b = SqliteStore.open(path);
    try {
      expect(b.getMeta("library_version")).toBe(LIBRARY_VERSION);
    } finally {
      b.close();
    }
  });

  it("rejects a DB whose schema_version is newer than the library (§28.3)", () => {
    const path = tmpDbPath();
    const first = SqliteStore.open(path);
    first.setMeta("schema_version", "99");
    first.close();
    // 旧库不得打开新 DB：migrate() 在版本闸上抛错
    expect(() => SqliteStore.open(path)).toThrow(/newer than library/);
  });
});

describe("recomputeInboxCaches (§8.4④)", () => {
  it("recomputes cache fields, nulls summary, leaves authoritative fields untouched", () => {
    const store = SqliteStore.open(tmpDbPath());
    const db = store.db;
    try {
      const now = new Date().toISOString();
      const insAccount = db.prepare(
        "INSERT INTO mesh_accounts (id, display_name, endpoint_class, capabilities, initiate, presence, created_at) " +
          "VALUES (?,?,?,?,?,?,?)",
      );
      insAccount.run("a1", "A1", "stream", "[]", '["chat"]', "offline", now);
      insAccount.run("a2", "A2", "stream", "[]", '["chat"]', "offline", now);
      db.prepare(
        "INSERT INTO mesh_conversations (id, type, next_seq, member_count, created_by, created_at) " +
          "VALUES (?,?,?,?,?,?)",
      ).run("dc", "direct", 3, 2, "@system", now);

      // m1 由 a1 发（含多字节字符，验证按「字节」而非「字符」求和）；m2 由 a2 发
      const pay1 = JSON.stringify({ text: "héllo" });
      const pay2 = JSON.stringify({ text: "world" });
      const insMsg = db.prepare(
        "INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, expect, routed_at, payload, idempotency_key) " +
          "VALUES (?,?,?,?,?,?,?,?,?)",
      );
      insMsg.run("m1", "dc", 1, "a1", "chat", "none", now, pay1, "ik-m1");
      insMsg.run("m2", "dc", 2, "a2", "chat", "none", now, pay2, "ik-m2");

      // 预置错误缓存 + 权威字段（权威字段必须不被重算）
      db.prepare(
        "INSERT INTO mesh_inboxes (account_id, conversation_id, pending_count, pending_bytes, verbatim_bytes, overflow_count, overflow_summary, cursor_seq, folded_to_seq) " +
          "VALUES (?,?,?,?,?,?,?,?,?)",
      ).run("a1", "dc", 9, 999, 0, 0, "STALE", 42, 7);
      // 一条对 a1 的溢出折叠投递（dropped/folded）
      db.prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, state, drop_reason, queued_at, state_changed_at) " +
          "VALUES (?,?,?,?,?,?,?)",
      ).run("d1", "m1", "a1", "dropped", "folded", now, now);

      store.recomputeInboxCaches();

      const row = db
        .prepare(
          "SELECT * FROM mesh_inboxes WHERE account_id = 'a1' AND conversation_id = 'dc'",
        )
        .get() as {
        verbatim_bytes: number;
        overflow_count: number;
        overflow_summary: string | null;
        cursor_seq: number;
        folded_to_seq: number;
        pending_count: number;
        pending_bytes: number;
      };

      expect(row.verbatim_bytes).toBe(Buffer.byteLength(pay1, "utf8"));
      expect(row.overflow_count).toBe(1);
      expect(row.overflow_summary).toBeNull();
      expect(row.cursor_seq).toBe(42); // 权威：不动
      expect(row.folded_to_seq).toBe(7); // 权威：不动
      expect(row.pending_count).toBe(0); // dropped 不计未读
      expect(row.pending_bytes).toBe(0);
    } finally {
      store.close();
    }
  });
});