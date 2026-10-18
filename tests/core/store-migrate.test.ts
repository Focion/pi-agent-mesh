// ═══════════════════════════════════════════════════════════════════════════
// 迁移硬化（C07/I05）：迁移前备份（仅升级路径）+ 逐脚本续跑（每脚本各自事务提交，
// 崩溃后续跑只执行未完成的脚本）。测试缝 migrationsDir 注入含多个脚本的临时目录，
// 不改动仓库 migrations/ 资产。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/core/store.js";
import { buildBaselineDb } from "../helpers/baseline-db.js";

const MIGRATIONS_ROOT = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** 复制仓库 migrations/ 到临时目录，供额外注入脚本（升级路径场景）。 */
function copyMigrationsTo(destDir: string): string {
  const dest = join(destDir, "migrations");
  cpSync(MIGRATIONS_ROOT, dest, { recursive: true });
  return dest;
}

function tableCount(db: Database.Database, name: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { n: number }
  ).n;
}

describe("migrate() backup before migration (C07/I05)", () => {
  it("snapshots only the upgrade path and records backup_path (§28.3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-mig-backup-"));
    const db = join(dir, "mesh.db");

    // 新鲜库首次打开：无可备份的「已有库」，不产生备份
    const first = SqliteStore.open(db);
    first.close();
    expect(existsSync(db + ".premigrate.bak")).toBe(false);

    // 升级路径：注入一个额外 pending 脚本后重开
    const customMigrations = copyMigrationsTo(dir);
    writeFileSync(
      join(customMigrations, "002_marker.sql"),
      "CREATE TABLE marker_a (id INTEGER);",
    );
    const store = SqliteStore.open(db, { migrationsDir: customMigrations });
    try {
      expect(store.getMeta("backup_path")).toBe(db + ".premigrate.bak");
      expect(existsSync(db + ".premigrate.bak")).toBe(true);
      expect(readFileSync(db + ".premigrate.bak").length).toBeGreaterThan(0);
      expect(tableCount(store.db, "marker_a")).toBe(1);
      expect(store.getMeta("migration:002_marker.sql")).toBeDefined();
    } finally {
      store.close();
    }
  });
});

describe("migrate() per-script continuation (C07/I05)", () => {
  it("commits each script atomically and resumes only the failing script", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-mig-cont-"));
    const db = join(dir, "mesh.db");
    const customMigrations = copyMigrationsTo(dir);
    writeFileSync(
      join(customMigrations, "001_a.sql"),
      "CREATE TABLE t1 (id INTEGER PRIMARY KEY);",
    );
    writeFileSync(join(customMigrations, "002_b.sql"), "THIS IS NOT VALID SQL;");

    // 首次打开：000 成功、001 成功（各自事务提交）、002 抛错 ⇒ 构造失败
    {
      const conn = new Database(db);
      try {
        expect(
          () => new SqliteStore(conn, false, 5000, { migrationsDir: customMigrations }),
        ).toThrow();
      } finally {
        conn.close();
      }
    }

    // 裸连接核验：001 已落盘（表 + 迁移键），002 未落盘（无表、无键）
    {
      const probe = new Database(db);
      expect(tableCount(probe, "t1")).toBe(1);
      expect(probe.prepare("SELECT v FROM mesh_meta WHERE k='migration:001_a.sql'").get()).toBeTruthy();
      expect(probe.prepare("SELECT v FROM mesh_meta WHERE k='migration:002_b.sql'").get()).toBeUndefined();
      expect(tableCount(probe, "t2")).toBe(0);
      probe.close();
    }

    // 修好 002 重开：只续跑 002，001 保持应用状态
    writeFileSync(
      join(customMigrations, "002_b.sql"),
      "CREATE TABLE t2 (id INTEGER PRIMARY KEY);",
    );
    const store = SqliteStore.open(db, { migrationsDir: customMigrations });
    try {
      expect(store.getMeta("migration:002_b.sql")).toBeDefined();
      expect(tableCount(store.db, "t2")).toBe(1);
      expect(tableCount(store.db, "t1")).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("migrate() backup integrity and failure blocking (C07/I05)", () => {
  it("backup reopens cleanly (quick_check=ok) with content matching the pre-migration db", () => {
    const dbPath = buildBaselineDb();
    const dir = mkdtempSync(join(tmpdir(), "mesh-mig-bak-integrity-"));
    const customMigrations = copyMigrationsTo(dir);
    writeFileSync(
      join(customMigrations, "005_extra.sql"),
      "CREATE TABLE extra_marker (id INTEGER);",
    );

    const store = SqliteStore.open(dbPath, { migrationsDir: customMigrations });
    const backupPath = dbPath + ".premigrate.bak";
    try {
      expect(existsSync(backupPath)).toBe(true);
      expect(tableCount(store.db, "extra_marker")).toBe(1); // 备份在迁移前、迁移本身已成功

      const bak = new Database(backupPath);
      try {
        const qc = bak.prepare("PRAGMA quick_check").get() as { quick_check: string };
        expect(qc.quick_check).toBe("ok");
        const bakMessages = (
          bak.prepare("SELECT COUNT(*) AS n FROM mesh_messages").get() as { n: number }
        ).n;
        const mainMessages = (
          store.db.prepare("SELECT COUNT(*) AS n FROM mesh_messages").get() as { n: number }
        ).n;
        expect(bakMessages).toBe(mainMessages);
        // 备份是「迁移前」快照：不含迁移生成的表。
        expect(tableCount(bak, "extra_marker")).toBe(0);
      } finally {
        bak.close();
      }
    } finally {
      store.close();
    }
  });

  it("backup failure (EISDIR) aborts migration before any script is applied", () => {
    const dbPath = buildBaselineDb();
    // 预置「同名目录」令 writeFileSync(backupPath, ...) 抛 EISDIR：备份失败必须阻断迁移。
    mkdirSync(dbPath + ".premigrate.bak");

    const dir = mkdtempSync(join(tmpdir(), "mesh-mig-bak-fail-"));
    const customMigrations = copyMigrationsTo(dir);
    writeFileSync(
      join(customMigrations, "005_extra.sql"),
      "CREATE TABLE extra_marker (id INTEGER);",
    );

    expect(() => SqliteStore.open(dbPath, { migrationsDir: customMigrations })).toThrow();

    const probe = new Database(dbPath);
    try {
      // 备份失败 ⇒ 迁移零增生：005 未落盘（无表、无键）。
      expect(tableCount(probe, "extra_marker")).toBe(0);
      expect(probe.prepare("SELECT v FROM mesh_meta WHERE k='migration:005_extra.sql'").get()).toBeUndefined();
      // 原 5 个迁移键仍在（升级路径 → 备份 → 失败前尚未盖任何新章）。
      const keys = (
        probe.prepare("SELECT k FROM mesh_meta WHERE k LIKE 'migration:%'").all() as Array<{ k: string }>
      ).map((r) => r.k);
      expect(keys).toHaveLength(5);
    } finally {
      probe.close();
    }
  });
});