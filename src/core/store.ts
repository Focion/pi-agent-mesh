// ═══════════════════════════════════════════════════════════════════════════
// Store（§3.5 §11 §11.8）：单一真相与单一写者。
// - 打开 SQLite（WAL / foreign_keys / busy_timeout）并应用 migrations/
// - tx(): BEGIN IMMEDIATE 事务；嵌套即抛错（防拆事务产生 seq 空洞，M-R6）
// - bumpCounter(): 小时桶计数（附录 E；与状态跃迁同一事务内调用）
// - 计数器名集合（devMode 校验）＝ 附录 E 的 23 项。
//
// W02 硬化（I05 / N04 / I34 / C07）：
// - I05：tx() 在 BEGIN 失败时不残留 inTx，调用方可整体重试；写/BEGIN 的致命
//   失败（READONLY/CORRUPT/IOERR…）上报 not_writable 故障。
// - C07/I05：迁移前对「升级路径」（已有库且存在待跑脚本）做同步快照备份，
//   备份失败即拒绝无保护迁移；版本校验（新库拒启）+ 逐脚本续跑。
// - N04：`fts` 开关（默认开）。禁用时删除 contentless FTS 表、router 跳过索引、
//   搜索抛「功能关闭」；重开/重启用由 reconcileFts 按「表是否存在」对账。
// - I34：StorageHealthGuard 执行链——时钟回退、WAL 超阈值、quick_check 损坏、
//   存储不可写，检测→告警→停发→恢复；devMode 提供 fault-injection 缝。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountId, ConversationId } from "./types.js";
import type { Store } from "./contracts.js";
import { StorageHealthGuard, type StorageFaultCode } from "./health.js";
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

/** WAL 阈值默认值（I34）；规范附录 F.2 未定义，W02 拍板 8 MiB。 */
const DEFAULT_WAL_MAX_BYTES = 8 * 1024 * 1024;

/** contentless FTS 表 DDL（镜像 migrations/000_init.sql:157-159）。禁用后重启用时按此重建。 */
const FTS_DDL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS mesh_messages_fts USING fts5(text, content='', tokenize='trigram')";

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
  /** N04：是否启用 FTS 搜索索引（默认 true）。禁用时搜索返回「功能关闭」。 */
  fts?: boolean;
  /** I34：<dbPath>-wal 超此字节数即告警停发（默认 8 MiB）。 */
  walMaxBytes?: number;
  /** 测试注入内存库 */
  db?: Database.Database;
  /** 测试缝：覆盖 migrations/ 目录（验证逐脚本续跑），非公共面。 */
  migrationsDir?: string;
}

interface StoreCtorOptions {
  fts?: boolean;
  walMaxBytes?: number;
  migrationsDir?: string;
}

export class SqliteStore implements Store {
  readonly db: Database.Database;
  /** I25：Observer 用的只读句柄（§12.4 全库唯一保证只读）。WAL 只读连接读已提交数据；
   *  `:memory:` 或只读句柄打不开（只读文件系统等）时退化为共享写句柄——Observer 仍只读使用。 */
  readonly readonlyDb: Database.Database;
  /** 挂到 DB 文件旁的备份/WAL 观测都需要它；`:memory:` 时为哨兵。 */
  private readonly dbPath: string;
  /** N04：本次打开是否启用 FTS。 */
  readonly ftsEnabled: boolean;
  /** I34：存储故障执行链状态（真实故障 + devMode 注入）。 */
  readonly health: StorageHealthGuard;
  private inTx = 0;
  private readonly devMode: boolean;
  private readonly walMaxBytes: number;

  private stmtMetaGet: Database.Statement;
  private stmtMetaSet: Database.Statement;

  constructor(
    db: Database.Database,
    devMode = false,
    busyTimeoutMs = 5000,
    opts: StoreCtorOptions = {},
  ) {
    this.db = db;
    // 由 db.name 派生（better-sqlite3 暴露构造时的路径名；`:memory:` 原样）。
    this.dbPath = (db as unknown as { name?: string | null }).name ?? ":memory:";
    this.devMode = devMode;
    this.ftsEnabled = opts.fts ?? true;
    this.walMaxBytes = opts.walMaxBytes ?? DEFAULT_WAL_MAX_BYTES;
    this.health = new StorageHealthGuard(devMode);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.pragma("wal_autocheckpoint = 1000");
    db.pragma("synchronous = NORMAL");
    this.migrate(opts.migrationsDir);
    this.reconcileFts();
    this.stmtMetaGet = db.prepare<[string], { v: string }>(
      "SELECT v FROM mesh_meta WHERE k = ?",
    );
    this.stmtMetaSet = db.prepare(
      "INSERT INTO mesh_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    );
    this.seedMeta();
    // 打开期初检（I34）：迁移/对账之后、返回前，把已存在故障登记进执行链。
    this.checkHealth();
    // I25：只读句柄必须在迁移/对账之后打开（否则读到旧 schema），保证 Observer
    // 从打开起就只读、且与迁移后的写连接读到同一套表。
    this.readonlyDb = this.openReadonly();
  }

  /** I25 只读句柄：`:memory:` 无文件可开；`readonly:true` 打不开时退化共享写句柄。 */
  private openReadonly(): Database.Database {
    if (this.dbPath === ":memory:") return this.db;
    try {
      return new Database(this.dbPath, { readonly: true });
    } catch {
      return this.db;
    }
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
    return new SqliteStore(db, opts.devMode ?? false, opts.busyTimeoutMs ?? 5000, {
      fts: opts.fts,
      walMaxBytes: opts.walMaxBytes,
      migrationsDir: opts.migrationsDir,
    });
  }

  // ─── I34：存储故障执行链 ─────────────────────────────────────────────────

  /** 复检全部存储健康（时钟 + WAL + 完整性），供观测/手动触发的恢复边界。 */
  checkHealth(): void {
    this.tickClock();
    this.checkWal();
    this.checkIntegrity();
  }

  /** devMode 故障注入缝（生产 no-op）：测试观察停发/告警/恢复边界用。 */
  injectFault(code: StorageFaultCode): void {
    this.health.inject(code);
  }

  clearFault(code: StorageFaultCode): void {
    this.health.clear(code);
  }

  /** 时钟回退检测：比对 mesh_meta.clock_observed_at，回退即告警；推进观察值。 */
  private tickClock(): void {
    const now = isoNow();
    const row = this.db
      .prepare("SELECT v FROM mesh_meta WHERE k = 'clock_observed_at'")
      .get() as { v: string } | undefined;
    const last = row?.v;
    if (last !== undefined && Date.parse(now) < Date.parse(last)) {
      this.health.report("clock_rollback", { now, lastObserved: last });
    } else {
      // 无回退 → 真实 clock_rollback 故障自愈（recover 幂等，只清真实集，不动注入集）。
      this.health.recover("clock_rollback");
    }
    if (last === undefined || Date.parse(now) > Date.parse(last)) {
      this.db
        .prepare(
          "INSERT INTO mesh_meta (k, v) VALUES ('clock_observed_at', ?) " +
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        )
        .run(now);
    }
  }

  /** WAL 超阈值：stat <dbPath>-wal；超限即告警并 TRUNCATE 检查点，随后复检恢复。 */
  private checkWal(): void {
    if (this.dbPath === ":memory:") return;
    const walPath = this.dbPath + "-wal";
    const size = this.walSize(walPath);
    if (size > this.walMaxBytes) {
      this.health.report("wal_over_threshold", { size, threshold: this.walMaxBytes });
      try {
        // TRUNCATE 检查点把已提交页归并回主库，收缩 WAL（§I34「有告警和停发边界」）。
        this.db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // checkpoint 失败（活跃读端等）保留故障，下次复检再试。
        return;
      }
      if (this.walSize(walPath) <= this.walMaxBytes) {
        this.health.recover("wal_over_threshold");
      }
    } else {
      this.health.recover("wal_over_threshold");
    }
  }

  private walSize(walPath: string): number {
    try {
      return statSync(walPath).size;
    } catch {
      return 0; // 无 WAL 文件（未曾写 / 已 checkpoint 清空）
    }
  }

  /** 完整性：PRAGMA quick_check 非 ok 即告警（致命，无自动恢复，宿主须关闭）。 */
  private checkIntegrity(): void {
    const rows = this.db.pragma("quick_check") as unknown as Array<{ quick_check: string }>;
    const verdict = rows[0]?.quick_check;
    if (verdict !== "ok") {
      this.health.report("integrity_failed", { verdict });
    }
  }

  /** 写路径致命失败分类：SQLITE_BUSY 是拿锁竞争（可重试），不算「存储不可写」。 */
  private classifyWriteFault(err: unknown): void {
    const code = (err as { code?: string } | null | undefined)?.code;
    if (
      typeof code === "string" &&
      /READONLY|CORRUPT|FULL|IOERR|NOMEM|PERM|NOTADB|CANTOPEN/.test(code)
    ) {
      this.health.report("not_writable", { code });
    }
  }

  // ─── 迁移 ─────────────────────────────────────────────────────────────

  private migrate(migrationsDirOverride?: string): void {
    const dir = migrationsDirOverride ?? migrationsDir();
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
    const pending = files.filter((f) => !applied.has(f));
    // C07/I05：升级路径（已有库）跑新脚本前先备份；备份失败拒绝无保护迁移。
    if (pending.length > 0 && hasMeta && this.dbPath !== ":memory:") {
      const backupPath = this.dbPath + ".premigrate.bak";
      writeFileSync(backupPath, this.db.serialize());
      this.db
        .prepare(
          "INSERT INTO mesh_meta (k, v) VALUES ('backup_path', ?) " +
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        )
        .run(backupPath);
    }
    let ranAny = false;
    for (const f of pending) {
      // 注意：迁移 SQL 来自库自带 migrations/ 目录（受版本控制的静态资产），
      // 不是运行时输入；DDL 无法参数化。每个脚本各自事务 + 同事务盖章，
      // 崩溃后按 pending 续跑（逐脚本续跑语义）。
      const tx = this.db.transaction(() => {
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

  /** N04：按 ftsEnabled 对账 FTS 表存在性（contentless，可逆，不改 000_init.sql）。 */
  private reconcileFts(): void {
    const exists =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mesh_messages_fts'",
          )
          .get() as { n: number }
      ).n > 0;
    if (!this.ftsEnabled) {
      // contentless：删表零行数据损失，text 可由 mesh_messages.payload 重建。
      if (exists) this.db.exec("DROP TABLE IF EXISTS mesh_messages_fts");
    } else if (!exists) {
      this.db.exec(FTS_DDL);
      // 回填：与 router 的 payload.text ?? JSON.stringify(payload) 同口径（§7.4）。
      this.db.exec(
        "INSERT INTO mesh_messages_fts (rowid, text) " +
          "SELECT m.rowid, COALESCE(json_extract(m.payload, '$.text'), m.payload) " +
          "FROM mesh_messages m",
      );
    }
    this.db
      .prepare(
        "INSERT INTO mesh_meta (k, v) VALUES ('fts_enabled', ?) " +
          "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      )
      .run(this.ftsEnabled ? "1" : "0");
  }

  // ─── 事务 ─────────────────────────────────────────────────────────────

  tx<T>(fn: () => T): T {
    if (this.inTx > 0) {
      // §11.8：seq 分配 + 插消息 + 插 delivery 必须同事务；拆开会制造
      // 无法自愈的坏状态（seq 空洞 / 有消息无投递）。嵌套 BEGIN 在 SQLite
      // 本就会抛错，这里给出可定位的错误信息。
      throw new Error(
        "mesh: nested Store.tx() detected — transaction boundary violation (§11.8)",
      );
    }
    // BEGIN 失败（SQLITE_BUSY / 已关闭 / 损坏）：inTx 保持 0，调用方可整体重试（I05）。
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      this.classifyWriteFault(err);
      throw err;
    }
    this.inTx = 1;
    let out: T;
    try {
      this.tickClock();
      out = fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.classifyWriteFault(err);
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // rollback 失败不掩盖原错误（库可能已损坏，交给 not_writable/integrity 链）
      }
      throw err;
    } finally {
      this.inTx = 0;
    }
    // 一次完整成功的事务 = 存储可写（自愈边界）。
    this.health.recover("not_writable");
    return out;
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

  /** 单 (account, conversation) 的缓存重算（§8.4④）：pending_count / pending_bytes /
   *  overflow_count 三列以 mesh_deliveries 为真相，字节口径 BLOB（UTF-8），含 routed。
   *  绝不触碰 cursor_seq / folded_to_seq（权威状态）与 verbatim_bytes / overflow_summary
   *  （前者是发送方预算、不受投递状态转换影响，后者无法从行重建）。 */
  recomputeInbox(accountId: AccountId, conversationId: ConversationId): void {
    this.db
      .prepare(
        `UPDATE mesh_inboxes SET
          pending_count = COALESCE((
            SELECT COUNT(*)
            FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id
            WHERE d.account_id = ? AND m.conversation_id = ?
              AND d.state IN ('routed','queued','parked','delivered')
          ), 0),
          pending_bytes = COALESCE((
            SELECT COALESCE(SUM(LENGTH(CAST(m.payload AS BLOB))), 0)
            FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id
            WHERE d.account_id = ? AND m.conversation_id = ?
              AND d.state IN ('routed','queued','parked','delivered')
          ), 0),
          overflow_count = COALESCE((
            SELECT COUNT(*)
            FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id
            WHERE d.account_id = ? AND m.conversation_id = ?
              AND d.state = 'dropped' AND d.drop_reason = 'folded'
          ), 0)
        WHERE account_id = ? AND conversation_id = ?`,
      )
      .run(
        accountId, conversationId,
        accountId, conversationId,
        accountId, conversationId,
        accountId, conversationId,
      );
  }

  close(): void {
    this.db.close();
    if (this.readonlyDb !== this.db) this.readonlyDb.close();
  }
}