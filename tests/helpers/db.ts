// 测试共用：打开临时 SQLite 并应用全部迁移（各泳道测试的公共地基）
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
}

export interface TestDb {
  db: Database.Database;
  dir: string;
  close(): void;
}

export function openTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "mesh-test-"));
  const db = new Database(join(dir, "mesh.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  for (const f of ["000_init.sql"].sort()) {
    db.exec(readFileSync(join(migrationsDir(), f), "utf8"));
  }
  return {
    db,
    dir,
    close() {
      db.close();
    }
  };
}
