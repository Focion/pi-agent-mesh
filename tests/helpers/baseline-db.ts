// G02（本地验收·存储与迁移）：确定性重建「迁移全链已跑完的 0.1.0 基线库」。
//
// 不提交二进制 DB：从仓库 migrations/ 的 5 个脚本逐文件执行（与 SqliteStore.migrate
// 同序），再写入与 000_init/migrate/seedMeta/reconcileFts 同口径的 mesh_meta 印章
// （schema_version / migration:* / schema_applied_at / library_version / fts_enabled），
// 最后插入一组固定 id 的种子数据——让库处于「早于本次进程已正常跑过迁移的现状」。
//
// 种子数据是一棵 C1–C16 全绿的世界（结构与 tests/core/observer.test.ts 的 greenWorld
// 同源：seq 连续、投递只到成员、caps 值域合规、group 有 setCaps 持有者），并额外
// 覆盖 shared_objects/versions、streams、subscriptions、endpoints 与 queue 投递的 acked
// 终态，供 g02-baseline-reopen 断言「重开后五类数据行数一致 + 16 条不变量绿」。
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

const ALL_CAPS = ["speak", "read", "invite", "remove", "setTopic", "setCaps", "dissolve"];

/** 迁移目录里 `^\d{3}_.*\.sql$` 的文件按字典序（与 store.migrate 的过滤/排序一致）。 */
function sortedMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort((a, b) => (a < b ? -1 : 1));
}

function execMigrations(db: Database.Database): void {
  for (const f of sortedMigrations()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
}

/** 每个钥匙齐全的 mesh_meta 印章（照 store.migrate/seedMeta/reconcileFts 生产口径）。 */
function stampMeta(db: Database.Database): void {
  const set = db.prepare(
    "INSERT INTO mesh_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  );
  for (const f of sortedMigrations()) set.run("migration:" + f, T0);
  set.run("schema_applied_at", T0);
  set.run("library_version", "0.1.0");
  set.run("fts_enabled", "1");
  set.run("created_at", T0);
  set.run("clock_observed_at", T1);
  // schema_version 已由 000_init.sql 置 '1'，这里再确认一次避免漂移。
  set.run("schema_version", "1");
}

function insAccount(db: Database.Database, id: string, displayName: string): void {
  db.prepare(
    "INSERT INTO mesh_accounts (id, display_name, endpoint_class, capabilities, initiate, presence, created_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  ).run(id, displayName, "stream", "[]", '["chat","task"]', "offline", T0);
}

function insEndpoint(db: Database.Database, id: string, accountId: string): void {
  db.prepare(
    "INSERT INTO mesh_endpoints (id, account_id, topology, state, lock_path) " +
      "VALUES (?,?,?,?,?)",
  ).run(id, accountId, "unified", "cold", null);
}

function insConv(
  db: Database.Database,
  id: string,
  type: string,
  opts: { nextSeq: number; memberCount: number; creator: string },
): void {
  db.prepare(
    "INSERT INTO mesh_conversations (id, type, config, next_seq, member_count, created_by, created_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  ).run(id, type, "{}", opts.nextSeq, opts.memberCount, opts.creator, T0);
}

function insMember(
  db: Database.Database,
  conv: string,
  acct: string,
  caps: readonly string[],
): void {
  db.prepare(
    "INSERT INTO mesh_memberships (conversation_id, account_id, caps, joined_seq, joined_at) VALUES (?,?,?,?,?)",
  ).run(conv, acct, JSON.stringify(caps), 0, T0);
  db.prepare("INSERT OR IGNORE INTO mesh_inboxes (account_id, conversation_id) VALUES (?,?)").run(
    acct,
    conv,
  );
}

function insMsg(
  db: Database.Database,
  o: { id: string; conv: string; seq: number; from: string; text: string; routedAt?: string },
): void {
  db.prepare(
    "INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, expect, priority, " +
      "to_accounts, mentions, reply_to, correlation_id, routed_at, payload, idempotency_key, ext) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    o.id,
    o.conv,
    o.seq,
    o.from,
    "chat",
    "none",
    null,
    null,
    null,
    null,
    null,
    o.routedAt ?? T1,
    JSON.stringify({ text: o.text }),
    "ik-" + o.id,
    null,
  );
}

/**
 * 按终态补齐 queued_at/delivered_at/consumed_at（与 observer.test.ts 的 insDelivery
 * 同口径），保证 C3「状态与时间戳组合合法」。
 */
function insDelivery(
  db: Database.Database,
  o: {
    id: string;
    msg: string;
    acct: string;
    state: "queued" | "parked" | "delivered" | "consumed" | "claimed" | "acked";
    path: "P1" | "P2" | "P3";
    claimUntil?: string;
    claimedBy?: string;
  },
): void {
  const hasQueued =
    o.state === "queued" || o.state === "parked" || o.state === "delivered" ||
    o.state === "consumed" || o.state === "claimed" || o.state === "acked";
  const hasDelivered =
    o.state === "delivered" || o.state === "consumed" || o.state === "claimed" || o.state === "acked";
  const isConsumed = o.state === "consumed";
  db.prepare(
    "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, grade, path, woke, state, " +
      "queued_at, delivered_at, consumed_at, claim_until, claimed_by, state_changed_at) " +
      "VALUES (?,?,?,NULL,?,?,0,?,?,?,?,?,?,?)",
  ).run(
    o.id,
    o.msg,
    o.acct,
    hasDelivered ? "followUp" : "silent",
    o.path,
    o.state,
    hasQueued ? T1 : null,
    hasDelivered ? T2 : null,
    isConsumed ? T2 : null,
    o.claimUntil ?? null,
    o.claimedBy ?? null,
    T2,
  );
}

/**
 * 构建基线库：全新 better-sqlite3（WAL/foreign_keys/busy_timeout）→ 逐文件执行 5 个
 * 迁移脚本 → 打 meta 印章 → 插入固定 id 种子数据 → close 并返回 dbPath。
 */
export function buildBaselineDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "mesh-baseline-"));
  const dbPath = join(dir, "mesh.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  execMigrations(db);
  stampMeta(db);

  insAccount(db, "alice", "Alice");
  insAccount(db, "bob", "Bob");
  insAccount(db, "carol", "Carol");
  insEndpoint(db, "ep-alice", "alice");
  insEndpoint(db, "ep-bob", "bob");
  insEndpoint(db, "ep-carol", "carol");

  insConv(db, "dc", "direct", { nextSeq: 3, memberCount: 2, creator: "alice" });
  insMember(db, "dc", "alice", ALL_CAPS);
  insMember(db, "dc", "bob", ["speak", "read"]);

  insConv(db, "gc", "group", { nextSeq: 3, memberCount: 3, creator: "alice" });
  insMember(db, "gc", "alice", ALL_CAPS);
  insMember(db, "gc", "bob", ["speak", "read"]);
  insMember(db, "gc", "carol", ["speak", "read"]);

  insConv(db, "qc", "queue", { nextSeq: 2, memberCount: 3, creator: "alice" });
  insMember(db, "qc", "alice", ALL_CAPS);
  insMember(db, "qc", "bob", ["speak", "read"]);
  insMember(db, "qc", "carol", ["speak", "read"]);

  insConv(db, "tc", "topic", { nextSeq: 2, memberCount: 0, creator: "alice" });
  db.prepare(
    "INSERT INTO mesh_subscriptions (conversation_id, account_id, from_seq, subscribed_at) VALUES (?,?,?,?)",
  ).run("tc", "carol", 1, T0);
  db.prepare("INSERT OR IGNORE INTO mesh_inboxes (account_id, conversation_id) VALUES (?,?)").run(
    "carol",
    "tc",
  );

  insMsg(db, { id: "m1", conv: "dc", seq: 1, from: "alice", text: "hello world from alice" });
  insMsg(db, { id: "m2", conv: "dc", seq: 2, from: "bob", text: "hi there" });
  insMsg(db, { id: "g1", conv: "gc", seq: 1, from: "alice", text: "group kickoff" });
  insMsg(db, { id: "g2", conv: "gc", seq: 2, from: "bob", text: "sounds good" });
  insMsg(db, { id: "t1", conv: "tc", seq: 1, from: "alice", text: "topic announcement" });
  insMsg(db, { id: "q1", conv: "qc", seq: 1, from: "alice", text: "task one" });

  insDelivery(db, { id: "d1", msg: "m1", acct: "bob", state: "delivered", path: "P1" });
  insDelivery(db, { id: "d2", msg: "m2", acct: "alice", state: "consumed", path: "P1" });
  insDelivery(db, { id: "d3", msg: "g1", acct: "bob", state: "queued", path: "P1" });
  insDelivery(db, { id: "d4", msg: "g1", acct: "carol", state: "delivered", path: "P1" });
  insDelivery(db, { id: "d5", msg: "g2", acct: "alice", state: "consumed", path: "P1" });
  insDelivery(db, { id: "d6", msg: "g2", acct: "carol", state: "queued", path: "P2" });
  insDelivery(db, { id: "d7", msg: "t1", acct: "carol", state: "delivered", path: "P3" });
  insDelivery(db, {
    id: "d8",
    msg: "q1",
    acct: "bob",
    state: "acked",
    path: "P1",
    claimUntil: FAR_FUTURE,
    claimedBy: "bob",
  });

  db.prepare(
    "INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, " +
      "conversation_id, deadline, state) VALUES (?,?,?,?,?,?,?,'open')",
  ).run("corr-dc-1", "m1", "ack", "alice", "bob", "dc", FAR_FUTURE);

  db.prepare(
    "INSERT INTO mesh_shared_objects (space_id, key, version, data, content_type, acl, created_by, " +
      "created_at, updated_by, updated_at, tombstoned) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
  ).run("space-1", "cfg", 2, '{"v":2}', "application/json", '{"read":["alice"],"write":["alice"]}', "alice", T0, "alice", T2);
  db.prepare(
    "INSERT INTO mesh_shared_versions (space_id, key, version, data, updated_by, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("space-1", "cfg", 1, '{"v":1}', "alice", T1);
  db.prepare(
    "INSERT INTO mesh_shared_versions (space_id, key, version, data, updated_by, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("space-1", "cfg", 2, '{"v":2}', "alice", T2);

  db.prepare(
    "INSERT INTO mesh_streams (pi_session_id, endpoint_id, account_id, created_at) VALUES (?,?,?,?)",
  ).run("ps-alice-1", "ep-alice", "alice", T0);

  // 抽查用：alice 在 dc 已消费完 seq2，游标随之前移（recomputeInboxCaches 不触碰 cursor_seq）。
  db.prepare(
    "UPDATE mesh_inboxes SET cursor_seq = 2 WHERE account_id = 'alice' AND conversation_id = 'dc'",
  ).run();

  db.close();
  return dbPath;
}

// 与 folk 无关的模块级导出（供测试断言种子行数），避免测试在别处重复维护计数。
export const BASELINE_COUNTS = {
  accounts: 4, // @system + alice + bob + carol
  endpoints: 3,
  conversations: 4,
  memberships: 8, // dc(2) + gc(3) + qc(3)
  subscriptions: 1,
  messages: 6,
  deliveries: 8,
  pending_acks: 1,
  shared_objects: 1,
  shared_versions: 2,
  streams: 1,
  inboxes: 9, // 8 成员 + carol/tc 订阅
} as const;