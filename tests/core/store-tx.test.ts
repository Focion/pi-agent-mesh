// ═══════════════════════════════════════════════════════════════════════════
// Store.tx() 硬化（I05①）：BEGIN IMMEDIATE 失败不残留 inTx，调用方可整体重试；
// SQLITE_BUSY 是拿锁竞争（可重试），不属于「存储不可写」故障。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/core/store.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "mesh-tx-")), "mesh.db");
}

describe("Store.tx() BEGIN-failure hardening (I05①)", () => {
  it("does not strand inTx on SQLITE_BUSY from BEGIN, and retries cleanly", () => {
    const path = tmpDbPath();
    // busyTimeoutMs=0：拿不到写锁立即抛 SQLITE_BUSY（不等待重试窗口）
    const store = SqliteStore.open(path, { busyTimeoutMs: 0 });
    const other = new Database(path);
    try {
      // 第二连接占住写锁 ⇒ store 的 BEGIN IMMEDIATE 立即 BUSY
      other.exec("BEGIN IMMEDIATE");
      expect(() => store.tx(() => "never")).toThrow(/locked|busy/i);
      // BUSY 属可重试竞争，不是「存储不可写」故障（I34 边界）
      expect(store.health.isStopSend()).toBe(false);

      other.exec("COMMIT");

      // 失败未残留 inTx：重试直接走正常路径，而非误报 nested transaction
      const out = store.tx(() => {
        store.setMeta("tx-retry", "ok");
        return "ran";
      });
      expect(out).toBe("ran");
      expect(store.getMeta("tx-retry")).toBe("ok");
    } finally {
      other.close();
      store.close();
    }
  });

  it("still rejects nested tx() with a clear boundary error", () => {
    const store = SqliteStore.open(":memory:");
    try {
      expect(() =>
        store.tx(() => {
          store.tx(() => 1);
        }),
      ).toThrow(/nested Store\.tx/);
    } finally {
      store.close();
    }
  });
});