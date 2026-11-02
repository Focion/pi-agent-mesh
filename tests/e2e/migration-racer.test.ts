// ═══════════════════════════════════════════════════════════════════════════
// G（本地验收·并发迁移）角色：被 `migration-concurrency.test.ts` fork 的第 N 个进程。
//
// 非独立用例：仅在 MESH_RACE=1 且 MESH_DB_PATH/MESH_MIG_DIR/MESH_RACER_ID/
// MESH_RACER_N/MESH_READY_DIR 齐备时才运行，`npm test` 直接收集到本文件时整条 it 跳过。
// N 个 racer 全部抵达 ready 屏障后再同时 `SqliteStore.open` 同一 dbPath：验证
// A18（BEGIN IMMEDIATE + 写锁内重读 applied/hasMeta）下并发打开不会重复执行迁移、
// 也不会因「表已存在」互斥失败；任一 racer 成功打开且全部迁移戳齐全即 exit 0。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/core/store.js";

const dbPath = process.env.MESH_DB_PATH;
const migDir = process.env.MESH_MIG_DIR;
const racerId = process.env.MESH_RACER_ID;
const racerN = Number(process.env.MESH_RACER_N);
const readyDir = process.env.MESH_READY_DIR;
const enabled =
  process.env.MESH_RACE === "1" &&
  !!dbPath &&
  !!migDir &&
  !!racerId &&
  !!readyDir &&
  Number.isInteger(racerN) &&
  racerN > 0;

/** 同步忙等，直到 ready 目录里凑齐 racerN 个 ready.* 信号（全部进程就位）。 */
function waitReady(): void {
  mkdirSync(readyDir!, { recursive: true });
  writeFileSync(join(readyDir!, `ready.${racerId}`), "");
  const sab = new SharedArrayBuffer(4);
  const slot = new Int32Array(sab);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const n = readdirSync(readyDir!).filter((f) => f.startsWith("ready.")).length;
    if (n >= racerN) return;
    if (Date.now() > deadline) throw new Error(`racer ${racerId}: ready barrier timeout`);
    Atomics.wait(slot, 0, 0, 10);
  }
}

describe("G: 并发迁移 racer（真实 OS 进程）", () => {
  it.skipIf(!enabled)("同期 open 同一 dbPath 不重复迁移、迁移戳齐全", () => {
    waitReady();
    const store = SqliteStore.open(dbPath!, { migrationsDir: migDir });
    try {
      const files = readdirSync(migDir!).filter((f) => /^\d{3}_.*\.sql$/.test(f));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(store.getMeta("migration:" + f), `migration:${f} missing`).toBeDefined();
      }
    } finally {
      store.close();
    }
  });
});