// ═══════════════════════════════════════════════════════════════════════════
// Store（§3.5 §11 §11.8）：单一真相与单一写者。
// - 打开 SQLite（WAL / foreign_keys / busy_timeout）并应用 migrations/
// - tx(): BEGIN IMMEDIATE 事务；嵌套即抛错（防拆事务产生 seq 空洞，M-R6）
// - bumpCounter(): 小时桶计数（附录 E；与状态跃迁同一事务内调用）
// 计数器名集合（devMode 校验）＝ 附录 E 的 23 项。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "./contracts.js";
import { hourBucket, isoNow } from "./util.js";

/** 附录 E：23 个登记计数器（devMode 下写入未登记名直接抛错） */
export const REGISTERED_COUNTERS = new Set([
  // A 组：16 个事件计数
  "dedup_hit",
  "wake_throttled",
  "backpressure_downgrade",
  "seq_gap",
  "blind_write",
  "request_timeout",
  "invariant_violated",
  "fanout_warn",
  "inbox_overflowed",
  "fold_events",
  "policy_degraded",
  "parked_total",
  "park_expired",
  "claim_timeout",
  "queue_cleared_detected",
  "delivery_handoff_timeout",
  // B 组：7 个派生指标分子分母
  "messages_total",
  "deliveries_total",
  "wake_per_message_idle",
  "wake_per_message_busy",
  "verbatim_copies",
  "silent_grade",
  "cold_hit",
]);

function migrationsDir(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "migrations",
  );
}

export interface OpenStoreOptions {
  devMode?: boolean;
  /** 测试注入内存库 */
  db?: Database.Database;
}

export class SqliteStore implements Store {
  readonly db: Database.Database;
  private inTx = 0;
  private readonly devMode: boolean;

  private stmtMetaGet: Database.Statement;
  private stmtMetaSet: Database.Statement;

  constructor(db: Database.Database, devMode = false) {
    this.db = db;
    this.devMode = devMode;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    this.migrate();
    this.stmtMetaGet = db.prepare<[string], { v: string }>(
      "SELECT v FROM mesh_meta WHERE k = ?",
    );
    this.stmtMetaSet = db.prepare(
      "INSERT INTO mesh_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );
  }

  static open(dbPath: string, opts: OpenStoreOptions = {}): SqliteStore {
    const db = opts.db ?? new Database(dbPath);
    return new SqliteStore(db, opts.devMode);
  }

  private migrate(): void {
    const dir = migrationsDir();
    const files = readdirSync(dir)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const applied = new Set(
      (
        this.db
          .prepare<[], { k: string }>(
            "SELECT k FROM mesh_meta WHERE k LIKE 'migration:%'",
          )
          .all() as Array<{ k: string }>
      ).map((r) => r.k.replace("migration:", "")),
    );
    for (const f of files) {
      if (applied.has(f)) continue;
      const tx = this.db.transaction(() => {
        // 注意：迁移 SQL 来自库自带 migrations/ 目录（受版本控制的静态资产），
        // 不是运行时输入；DDL 无法参数化。
        this.db.exec(readFileSync(join(dir, f), "utf8"));
        const migrationKey = "migration:" + f;
        this.db
          .prepare("INSERT OR REPLACE INTO mesh_meta (k, v) VALUES (?, ?)")
          .run(migrationKey, isoNow());
      });
      tx();
    }
  }

  tx<T>(fn: () => T): T {
    if (this.inTx > 0) {
      // §11.8：seq 分配 + 插消息 + 插 delivery 必须同事务；拆开会制造
      // 无法自愈的坏状态（seq 空洞 / 有消息无投递）。嵌套 BEGIN 在 SQLite
      // 本就会抛错，这里给出可定位的错误信息。
      throw new Error(
        "mesh: nested Store.tx() detected — transaction boundary violation (§11.8)",
      );
    }
    this.inTx++;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      this.inTx--;
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } finally {
        this.inTx--;
      }
      throw err;
    }
  }

  getMeta(k: string): string | undefined {
    const row = this.stmtMetaGet.get(k) as { v: string } | undefined;
    return row?.v;
  }

  setMeta(k: string, v: string): void {
    this.stmtMetaSet.run(k, v);
  }

  bumpCounter(name: string, by = 1): void {
    if (this.devMode && !REGISTERED_COUNTERS.has(name)) {
      // §23.3：写入未登记的名字直接抛错——否则指标会静静漏掉一整类事件
      throw new Error(
        `mesh: unregistered counter "${name}" (appendix E is authoritative)`,
      );
    }
    this.db
      .prepare(
        "INSERT INTO mesh_counters (name, bucket, value) VALUES (?, ?, ?) " +
          "ON CONFLICT(name, bucket) DO UPDATE SET value = value + excluded.value",
      )
      .run(name, hourBucket(), by);
  }

  /** 测试/恢复用：重算某账号全部收件箱缓存（§8.4④：以 deliveries 为真相） */
  recomputeInboxCaches(): void {
    this.db.exec(`
      UPDATE mesh_inboxes AS i SET
        pending_count = COALESCE(x.n, 0),
        pending_bytes = COALESCE(x.b, 0)
      FROM (
        SELECT d.account_id AS aid, m.conversation_id AS cid,
               COUNT(*) AS n, COALESCE(SUM(LENGTH(m.payload)), 0) AS b
        FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id
        WHERE d.state IN ('routed','queued','parked','delivered')
        GROUP BY d.account_id, m.conversation_id
      ) AS x
      WHERE i.account_id = x.aid AND i.conversation_id = x.cid
    `);
    // 补上 pending=0 的行（LEFT JOIN 没覆盖到）
    this.db.exec(`
      UPDATE mesh_inboxes AS i SET
        pending_count = 0, pending_bytes = 0
      WHERE NOT EXISTS (
        SELECT 1 FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id
        WHERE d.account_id = i.account_id AND m.conversation_id = i.conversation_id
          AND d.state IN ('routed','queued','parked','delivered')
      )
    `);
  }

  close(): void {
    this.db.close();
  }
}
