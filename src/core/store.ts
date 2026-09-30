// ═══════════════════════════════════════════════════════════════════════════
// Store（§3.5 §11 §11.8）：单一真相与单一写者。
// - 打开 SQLite（WAL / foreign_keys / busy_timeout）并应用 migrations/
// - tx(): BEGIN IMMEDIATE 事务；嵌套即抛错（防拆事务产生 seq 空洞，M-R6）
// - bumpCounter(): 小时桶计数（附录 E；与状态跃迁同一事务内调用）
// 计数器名集合（devMode 校验）＝ 附录 E 的 23 项。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/** schema 版本基准（§28.3）：与 migrations/ 的最大序号一致。DB 的 schema_version 大于此即拒绝启动。 */
const SCHEMA_VERSION = 1;
/** 库版本（§11.7 / §28.3 的 `library_version` 键），与 package.json version 同步。 */
export const LIBRARY_VERSION = "0.1.0";

function migrationsDir(): string {
  // migrations/ 是与 dist/ 并列的包根资产（package.json `files` 声明、`exports`
  // 暴露）。从本模块位置向上走，找到含 package.json 的目录即包根，再拼 migrations/。
  // 这样源码直跑（vitest，src/core）与打包产物（dist/index.js、dist/core/index.js）
  // 都能解析到同一个目录——后者由 tsup flatten，用 `../../migrations` 相对路径会偏一级。
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return join(dir, "migrations");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("mesh: could not locate package root for migrations/");
}

export interface OpenStoreOptions {
  devMode?: boolean;
  /** SQLite busy_timeout（§19.5 / 附录 F.2，0–60000，默认 5000） */
  busyTimeoutMs?: number;
  /** 测试注入内存库 */
  db?: Database.Database;
}

export class SqliteStore implements Store {
  readonly db: Database.Database;
  private inTx = 0;
  private readonly devMode: boolean;

  private stmtMetaGet: Database.Statement;
  private stmtMetaSet: Database.Statement;

  constructor(db: Database.Database, devMode = false, busyTimeoutMs = 5000) {
    this.db = db;
    this.devMode = devMode;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.pragma("wal_autocheckpoint = 1000");
    db.pragma("synchronous = NORMAL");
    this.migrate();
    this.stmtMetaGet = db.prepare<[string], { v: string }>(
      "SELECT v FROM mesh_meta WHERE k = ?",
    );
    this.stmtMetaSet = db.prepare(
      "INSERT INTO mesh_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );
    this.seedMeta();
  }

  /** §11.7 / §28.3：元信息表必须存在的键（schema_version 由迁移脚本写，schema_applied_at 由 migrate() 写） */
  private seedMeta(): void {
    if (this.getMeta("created_at") === undefined) {
      this.setMeta("created_at", isoNow());
    }
    // library_version 反映“最近一次打开该 DB 的库版本”（§28.3），每次打开都刷新。
    this.setMeta("library_version", LIBRARY_VERSION);
  }

  static open(dbPath: string, opts: OpenStoreOptions = {}): SqliteStore {
    const db = opts.db ?? new Database(dbPath);
    return new SqliteStore(db, opts.devMode, opts.busyTimeoutMs);
  }

  private migrate(): void {
    const dir = migrationsDir();
    const files = readdirSync(dir)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // 新库上 mesh_meta 尚不存在（由 000_init.sql 创建）：先查表是否存在，
    // 而不是一上来就 SELECT——否则首次迁移必然抛「no such table: mesh_meta」。
    const hasMeta =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mesh_meta'",
          )
          .get() as { n: number }
      ).n > 0;
    // §28.3：旧库不得打开新 DB——schema_version 大于本库预期必须拒绝启动。
    if (hasMeta) {
      const sv = this.db
        .prepare("SELECT v FROM mesh_meta WHERE k = 'schema_version'")
        .get() as { v: string } | undefined;
      const n = sv?.v ? Number.parseInt(sv.v, 10) : 0;
      if (Number.isInteger(n) && n > SCHEMA_VERSION) {
        throw new Error(
          `mesh: database schema_version=${sv!.v} is newer than library (${SCHEMA_VERSION}); upgrade the library (§28.3)`,
        );
      }
    }
    const applied = new Set(
      hasMeta
        ? (
            this.db
              .prepare<[], { k: string }>(
                "SELECT k FROM mesh_meta WHERE k LIKE 'migration:%'",
              )
              .all() as Array<{ k: string }>
          ).map((r) => r.k.replace("migration:", ""))
        : [],
    );
    let ranAny = false;
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
      ranAny = true;
    }
    // §28.3：schema_applied_at = 最近一次迁移完成时间（仅当本次真的跑了迁移才盖章）。
    // schema_version 本身由迁移脚本维护（000_init.sql 置 '1'）。
    if (ranAny) {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO mesh_meta (k, v) VALUES ('schema_applied_at', ?)",
        )
        .run(isoNow());
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

  /** 测试/恢复用：重算全部收件箱缓存字段（§8.4④：以 deliveries/messages 为真相）。
   * 缓存字段：pending_count / pending_bytes（未读，真相在 mesh_deliveries）、verbatim_bytes
   * （发送方原文预算，真相在 mesh_messages，topic 不计，§7.4）、overflow_count（溢出折叠
   * 次数，真相在 mesh_deliveries.state='dropped' && drop_reason='folded'，§7.5）。
   * overflow_summary 是折叠摘要文本，无法从行重建，恢复时置 NULL（下次折叠经 || 重建），
   * 绝不伪造。cursor_seq / folded_to_seq 是权威状态（§7.7/§7.5），本函数不重算、不动。 */
  recomputeInboxCaches(): void {
    this.db.exec(`
      UPDATE mesh_inboxes AS i SET
        pending_count = COALESCE((
          SELECT COUNT(*)
          FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id
          WHERE d.account_id = i.account_id AND m.conversation_id = i.conversation_id
            AND d.state IN ('routed','queued','parked','delivered')
        ), 0),
        pending_bytes = COALESCE((
          SELECT COALESCE(SUM(LENGTH(CAST(m.payload AS BLOB))), 0)
          FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id
          WHERE d.account_id = i.account_id AND m.conversation_id = i.conversation_id
            AND d.state IN ('routed','queued','parked','delivered')
        ), 0),
        verbatim_bytes = COALESCE((
          SELECT COALESCE(SUM(LENGTH(CAST(m.payload AS BLOB))), 0)
          FROM mesh_messages m JOIN mesh_conversations c ON c.id = m.conversation_id
          WHERE m.from_account = i.account_id AND m.conversation_id = i.conversation_id
            AND c.type != 'topic'
        ), 0),
        overflow_count = COALESCE((
          SELECT COUNT(*)
          FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id
          WHERE d.account_id = i.account_id AND m.conversation_id = i.conversation_id
            AND d.state = 'dropped' AND d.drop_reason = 'folded'
        ), 0),
        overflow_summary = NULL
    `);
  }

  close(): void {
    this.db.close();
  }
}
