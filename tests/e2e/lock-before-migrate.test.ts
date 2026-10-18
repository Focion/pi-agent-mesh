// ═══════════════════════════════════════════════════════════════════════════
// I05②：实例锁先于迁移（M3）。预先被另一写者占住实例锁 → createMesh 应在抢锁处
// 失败，且 DB 文件从未被创建/迁移（SqliteStore.open 尚未执行）。证明启动顺序是
// 「先加锁再开库迁移」，跨进程并发打开同一 dbPath 不会竞争迁移。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import { EndpointLock, LockHeldError } from "../../src/pi/lock.js";

const sessionFactory = {
  create: async () => ({ session: {}, piSessionId: "lock-test" }),
  open: async () => ({ session: {} }),
};

describe("instance lock precedes migration (I05②)", () => {
  it("fails at lock acquisition and never creates the DB file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-lock-"));
    const dbPath = join(dir, "mesh.db");
    const lockPath = dbPath + ".instance.lock";

    // 模拟已存在的另一写者：以 single 模式占住实例锁（单进程排他）
    const blocker = await EndpointLock.acquire(lockPath, {
      writerId: "other-writer",
      lease: "shared",
      mode: "single",
    });
    try {
      await expect(
        createMesh({ dbPath, policies: { sessionFactory } }),
      ).rejects.toThrow(LockHeldError);
      // 锁先于迁移：SqliteStore.open 未执行 ⇒ DB 文件未被创建/迁移
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      await blocker.release();
    }
  });
});