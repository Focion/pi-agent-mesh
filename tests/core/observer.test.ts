// ═══════════════════════════════════════════════════════════════════════════
// Observer 单测（L6）：C1–C16 断言红/绿、messages/search/trace/inboxOf/
// conversationsOf/streamEntries/counters、replay/forkAt 延期、只读性。
// 数据用裸 SQL 造（不走 Router——那是 L2 泳道的职责面）。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeshObserver } from "../../src/core/observer.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { SqliteStore } from "../../src/core/store.js";
import { DEFAULT_LIMITS, MeshUnsupportedError } from "../../src/core/types.js";
import { isoFromMs, isoNow } from "../../src/core/util.js";
import { openTestDb, type TestDb } from "../helpers/db.js";

// ─── 种子助手（全部裸 SQL + ? 绑定）──────────────────────────────────────

function insAccount(
  db: Database.Database,
  id: string,
  opts: { name?: string; cls?: string } = {},
): void {
  db.prepare(
    "INSERT INTO mesh_accounts (id, display_name, endpoint_class, capabilities, initiate, presence, created_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  ).run(
    id,
    opts.name ?? id,
    opts.cls ?? "stream",
    "[]",
    '["chat","task"]',
    "offline",
    isoNow(),
  );
}

function insConv(
  db: Database.Database,
  id: string,
  type: string,
  config?: unknown,
): void {
  db.prepare(
    "INSERT INTO mesh_conversations (id, type, config, next_seq, member_count, created_by, created_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  ).run(
    id,
    type,
    config === undefined ? null : JSON.stringify(config),
    1,
    0,
    "@system",
    isoNow(),
  );
}

function insMember(
  db: Database.Database,
  conv: string,
  acct: string,
  caps: string[],
  joinedSeq = 0,
): void {
  db.prepare(
    "INSERT INTO mesh_memberships (conversation_id, account_id, caps, joined_seq, joined_at) VALUES (?,?,?,?,?)",
  ).run(conv, acct, JSON.stringify(caps), joinedSeq, isoNow());
  db.prepare(
    "INSERT OR IGNORE INTO mesh_inboxes (account_id, conversation_id) VALUES (?,?)",
  ).run(acct, conv);
}

interface MsgSeed {
  id: string;
  conv: string;
  seq: number;
  from: string;
  text?: string;
  to?: string[];
  mentions?: string[];
  kind?: string;
  expect?: string;
  priority?: string;
  intent?: string;
  correlationId?: string;
  ext?: unknown;
  claim?: { by: string; at: string };
}

function insMsg(db: Database.Database, o: MsgSeed): number {
  const payload: Record<string, unknown> = { text: o.text ?? "body-" + o.seq };
  if (o.claim !== undefined) payload.claim = o.claim;
  db.prepare(
    "INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, expect, priority, " +
      "to_accounts, mentions, correlation_id, intent, routed_at, payload, idempotency_key, ext) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    o.id,
    o.conv,
    o.seq,
    o.from,
    o.kind ?? "chat",
    o.expect ?? "none",
    o.priority ?? null,
    o.to === undefined ? null : JSON.stringify(o.to),
    o.mentions === undefined ? null : JSON.stringify(o.mentions),
    o.correlationId ?? null,
    o.intent ?? null,
    isoNow(),
    JSON.stringify(payload),
    "ik-" + o.id,
    o.ext === undefined ? null : JSON.stringify(o.ext),
  );
  db.prepare(
    "UPDATE mesh_conversations SET next_seq = MAX(next_seq, ?) WHERE id = ?",
  ).run(o.seq + 1, o.conv);
  const row = db
    .prepare("SELECT rowid AS rid FROM mesh_messages WHERE id = ?")
    .get(o.id) as { rid: number } | undefined;
  return row?.rid ?? -1;
}

function insFts(db: Database.Database, rowid: number, text: string): void {
  db.prepare("INSERT INTO mesh_messages_fts (rowid, text) VALUES (?,?)").run(
    rowid,
    text,
  );
}

function insDelivery(
  db: Database.Database,
  o: {
    id: string;
    msg: string;
    acct: string;
    state: string;
    endpoint?: string | null;
    grade?: string;
    woke?: boolean;
    reason?: string;
    parkedAt?: string;
    claimUntil?: string;
    attempts?: number;
  },
): void {
  const now = isoNow();
  const order = [
    "queued",
    "parked",
    "delivered",
    "consumed",
    "claimed",
    "acked",
  ];
  const hasQueued = order.includes(o.state);
  const isParked = o.state === "parked";
  const hasDelivered = ["delivered", "consumed", "claimed", "acked"].includes(
    o.state,
  );
  const isConsumed = o.state === "consumed";
  const isDropped = o.state === "dropped";
  db.prepare(
    "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, grade, woke, state, " +
      "parked_reason, drop_reason, attempts, claim_until, parked_at, queued_at, delivered_at, consumed_at, " +
      "state_changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    o.id,
    o.msg,
    o.acct,
    o.endpoint ?? null,
    o.grade ?? null,
    o.woke === true ? 1 : 0,
    o.state,
    isParked ? (o.reason ?? "ENDPOINT_GONE") : null,
    isDropped ? (o.reason ?? "TTL_EXPIRED") : null,
    o.attempts ?? 0,
    o.claimUntil ?? null,
    isParked ? (o.parkedAt ?? now) : null,
    hasQueued || isDropped ? now : null,
    hasDelivered ? now : null,
    isConsumed ? now : null,
    now,
  );
}

function insPendingAck(
  db: Database.Database,
  o: {
    cid: string;
    msg: string;
    from: string;
    to: string;
    conv: string;
    deadline: string;
  },
): void {
  db.prepare(
    "INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, " +
      "conversation_id, deadline, state) VALUES (?,?,?,?,?,?,?, 'open')",
  ).run(o.cid, o.msg, "ack", o.from, o.to, o.conv, o.deadline);
}

function insEndpoint(
  db: Database.Database,
  o: { id: string; acct: string; state: string; lockPath?: string | null },
): void {
  db.prepare(
    "INSERT INTO mesh_endpoints (id, account_id, topology, state, lock_path) VALUES (?,?,?,?,?)",
  ).run(o.id, o.acct, "unified", o.state, o.lockPath ?? null);
}

/** 一个全绿的世界：3 账号、direct+group+topic、5 投递、1 待应答 */
function greenWorld(db: Database.Database): void {
  insAccount(db, "a1", { name: "Alice" });
  insAccount(db, "a2", { name: "Bob" });
  insAccount(db, "a3", { name: "Carol" });
  insConv(db, "dc", "direct", { historyVisibility: "full" });
  insMember(db, "dc", "a1", ["speak", "read"]);
  insMember(db, "dc", "a2", ["speak", "read"]);
  insConv(db, "gc", "group");
  insMember(db, "gc", "a1", [
    "speak",
    "read",
    "invite",
    "remove",
    "setTopic",
    "setCaps",
    "dissolve",
  ]);
  insMember(db, "gc", "a2", ["speak", "read"]);
  insMember(db, "gc", "a3", ["speak", "read"]);
  insConv(db, "tc", "topic");
  db.prepare(
    "INSERT INTO mesh_subscriptions (conversation_id, account_id, from_seq, subscribed_at) VALUES (?,?,?,?)",
  ).run("tc", "a3", 1, isoNow());
  db.prepare(
    "INSERT OR IGNORE INTO mesh_inboxes (account_id, conversation_id) VALUES (?,?)",
  ).run("a3", "tc");

  const m1 = insMsg(db, {
    id: "m1",
    conv: "dc",
    seq: 1,
    from: "a1",
    text: "hello world from a1",
  });
  const m2 = insMsg(db, {
    id: "m2",
    conv: "dc",
    seq: 2,
    from: "a2",
    text: "hi there",
  });
  const g1 = insMsg(db, {
    id: "g1",
    conv: "gc",
    seq: 1,
    from: "a1",
    text: "group kickoff",
  });
  insMsg(db, { id: "g2", conv: "gc", seq: 2, from: "a2", text: "sounds good" });
  const t1 = insMsg(db, {
    id: "t1",
    conv: "tc",
    seq: 1,
    from: "a1",
    text: "topic announcement",
  });
  insFts(db, m1, "hello world from a1");
  insFts(db, m2, "hi there");
  insFts(db, g1, "group kickoff");
  insFts(db, t1, "topic announcement");

  insDelivery(db, { id: "d1", msg: "m1", acct: "a2", state: "delivered" });
  insDelivery(db, { id: "d2", msg: "m2", acct: "a1", state: "consumed" });
  insDelivery(db, { id: "d3", msg: "g1", acct: "a2", state: "queued" });
  insDelivery(db, { id: "d4", msg: "g1", acct: "a3", state: "delivered" });
  insDelivery(db, { id: "d5", msg: "t1", acct: "a3", state: "delivered" });
  insPendingAck(db, {
    cid: "corr-1",
    msg: "m1",
    from: "a1",
    to: "a2",
    conv: "dc",
    deadline: isoFromMs(Date.now() + 60_000),
  });
}

// ─── 夹具 ─────────────────────────────────────────────────────────────────

let t: TestDb;
let db: Database.Database;
let store: SqliteStore;
let obs: MeshObserver;

beforeEach(() => {
  t = openTestDb();
  db = t.db;
  store = new SqliteStore(db);
  const registry = new MeshRegistry(db);
  obs = new MeshObserver({ store, registry, limits: DEFAULT_LIMITS });
});

afterEach(() => {
  t.close();
});

function violationIds(ids: string[]): string[] {
  return ids;
}

async function reportIds(): Promise<string[]> {
  const r = await obs.checkInvariants();
  return r.violations.map((v) => v.id);
}

// ─── C1–C16 ───────────────────────────────────────────────────────────────

describe("MeshObserver.checkInvariants", () => {
  it("green on a consistent world (all 16 checked)", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    const r = await obs.checkInvariants();
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(16);
    expect(r.violations).toEqual([]);
  });

  it("C1 red on a seq hole", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insMsg(db, { id: "m3", conv: "dc", seq: 5, from: "a1" });
    const r = await obs.checkInvariants();
    expect(r.ok).toBe(false);
    const c1 = r.violations.find((v) => v.id === "C1");
    expect(c1).toBeDefined();
    expect(c1?.count).toBe(1);
    expect(c1?.sample.length).toBeGreaterThan(0);
  });

  it("C2 red on duplicate null-endpoint delivery (index dropped)", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    db.exec("DROP INDEX ux_delivery_noep");
    insDelivery(db, { id: "d6", msg: "g2", acct: "a3", state: "queued" });
    insDelivery(db, { id: "d7", msg: "g2", acct: "a3", state: "queued" });
    expect(violationIds(await reportIds())).toContain("C2");
  });

  it("C3 red on delivered without delivered_at", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    db.prepare(
      "UPDATE mesh_deliveries SET delivered_at = NULL WHERE id = 'd4'",
    ).run();
    expect(violationIds(await reportIds())).toContain("C3");
  });

  it("C4 red on orphan delivery", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    db.pragma("foreign_keys = OFF");
    try {
      db.prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, state, state_changed_at) VALUES (?,?,?,?,?)",
      ).run("d-ghost", "no-such-message", "a2", "routed", isoNow());
    } finally {
      db.pragma("foreign_keys = ON");
    }
    expect(violationIds(await reportIds())).toContain("C4");
  });

  it("C5 red on pending_count drift, green after recompute", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    db.prepare(
      "UPDATE mesh_inboxes SET pending_count = pending_count + 3 WHERE account_id = 'a2' AND conversation_id = 'gc'",
    ).run();
    expect(violationIds(await reportIds())).toContain("C5");
    store.recomputeInboxCaches();
    expect(violationIds(await reportIds())).not.toContain("C5");
  });

  it("C6 red on delivery to a non-member", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insAccount(db, "a4");
    insDelivery(db, { id: "d8", msg: "g2", acct: "a4", state: "queued" });
    expect(violationIds(await reportIds())).toContain("C6");
  });

  it("C7 red on pre-join history delivered", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insAccount(db, "a5");
    insMember(db, "gc", "a5", ["speak", "read"], 2); // joined at seq 2
    insDelivery(db, { id: "d9", msg: "g1", acct: "a5", state: "queued" }); // seq 1 < 2
    expect(violationIds(await reportIds())).toContain("C7");
  });

  it("C8 red on stale open pending_ack", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insPendingAck(db, {
      cid: "corr-old",
      msg: "m2",
      from: "a2",
      to: "a1",
      conv: "dc",
      deadline: isoFromMs(Date.now() - 7_200_000),
    });
    expect(violationIds(await reportIds())).toContain("C8");
  });

  it("C9 red on broken tombstone chain", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    db.prepare(
      "UPDATE mesh_messages SET tombstoned_by = 'm1' WHERE id = 'm2'",
    ).run();
    expect(violationIds(await reportIds())).toContain("C9");
  });

  it("C10 red without lock_path, red on missing lock file, green with real file", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insEndpoint(db, { id: "e1", acct: "a2", state: "hot" }); // lock_path NULL
    expect(violationIds(await reportIds())).toContain("C10");
    db.prepare("UPDATE mesh_endpoints SET lock_path = ? WHERE id = 'e1'").run(
      "/nonexistent/mesh-e1.lock",
    );
    expect(violationIds(await reportIds())).toContain("C10");
    const lock = join(t.dir, "mesh-e1.lock");
    writeFileSync(lock, "pid=1\n", "utf8");
    db.prepare("UPDATE mesh_endpoints SET lock_path = ? WHERE id = 'e1'").run(
      lock,
    );
    expect(violationIds(await reportIds())).not.toContain("C10");
  });

  it("C11 red on parked without reason", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    const now = isoNow();
    db.prepare(
      "INSERT INTO mesh_deliveries (id, message_id, account_id, state, parked_at, queued_at, state_changed_at) " +
        "VALUES (?,?,?,?,?,?,?)",
    ).run("d-p", "g2", "a2", "parked", now, now, now);
    expect(violationIds(await reportIds())).toContain("C11");
  });

  it("C12 red on parked older than parkTtlMs", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insDelivery(db, {
      id: "d-old",
      msg: "g2",
      acct: "a2",
      state: "parked",
      reason: "ENDPOINT_GONE",
      parkedAt: isoFromMs(Date.now() - 2 * DEFAULT_LIMITS.parkTtlMs),
    });
    expect(violationIds(await reportIds())).toContain("C12");
  });

  it("C13 red on expired claimed in a queue conversation", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insConv(db, "qc", "queue");
    insMember(db, "qc", "a1", ["speak", "read"]);
    insMsg(db, {
      id: "q1",
      conv: "qc",
      seq: 1,
      from: "a1",
      text: "job",
      claim: { by: "a1", at: isoNow() },
    });
    insDelivery(db, {
      id: "d-claim",
      msg: "q1",
      acct: "a1",
      state: "claimed",
      claimUntil: isoFromMs(Date.now() - 60_000),
    });
    expect(violationIds(await reportIds())).toContain("C13");
  });

  it("C14 red on topic delivery outside subscription", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insDelivery(db, { id: "d10", msg: "t1", acct: "a2", state: "delivered" }); // a2 未订阅
    expect(violationIds(await reportIds())).toContain("C14");
  });

  it("C15 red on bad cap value and group without dissolve holder", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    db.prepare(
      "UPDATE mesh_memberships SET caps = ? WHERE conversation_id = 'gc' AND account_id = 'a1'",
    ).run('["speak"]'); // 唯一 dissolve 持有者失去该位
    db.prepare(
      "UPDATE mesh_memberships SET caps = ? WHERE conversation_id = 'gc' AND account_id = 'a2'",
    ).run('["speak","admin"]'); // 值域越界
    const r = await obs.checkInvariants();
    const c15 = r.violations.find((v) => v.id === "C15");
    expect(c15).toBeDefined();
    expect(c15?.count).toBe(2);
  });

  it("C16 red when @system account is missing", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    db.pragma("foreign_keys = OFF");
    try {
      db.prepare("DELETE FROM mesh_accounts WHERE id = '@system'").run();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    expect(violationIds(await reportIds())).toContain("C16");
  });
});

// ─── messages ─────────────────────────────────────────────────────────────

describe("MeshObserver.messages", () => {
  it("filters by conversation/from/kind/sinceSeq/limit and maps Envelope fields", async () => {
    greenWorld(db);
    const dc = await obs.messages({ conversationId: "dc" });
    expect(dc.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(dc[0]).toMatchObject({
      seq: 1,
      from: "a1",
      fromEndpoint: null,
      kind: "chat",
      expect: "none",
      conversationId: "dc",
      idempotencyKey: "ik-m1",
    });
    const first = dc[0];
    expect(first?.payload.text).toBe("hello world from a1");

    expect((await obs.messages({ from: "a1" })).map((m) => m.id)).toEqual([
      "m1",
      "g1",
      "t1",
    ]);
    expect(
      (await obs.messages({ conversationId: "dc", sinceSeq: 1 })).map(
        (m) => m.id,
      ),
    ).toEqual(["m2"]);
    expect((await obs.messages({ limit: 3 })).length).toBe(3);

    const rid = insMsg(db, {
      id: "g3",
      conv: "gc",
      seq: 3,
      from: "a1",
      kind: "task",
      expect: "ack",
      priority: "urgent",
      to: ["a2"],
      mentions: ["a3"],
      intent: "review",
      correlationId: "corr-x",
      ext: { tag: 7 },
    });
    expect(rid).toBeGreaterThan(0);
    const g3 = (await obs.messages({ conversationId: "gc", sinceSeq: 2 }))[0]!;
    expect(g3.to).toEqual(["a2"]);
    expect(g3.mentions).toEqual(["a3"]);
    expect(g3.kind).toBe("task");
    expect(g3.expect).toBe("ack");
    expect(g3.priority).toBe("urgent");
    expect(g3.requestType).toBe("review");
    expect(g3.correlationId).toBe("corr-x");
    expect(g3.ext).toEqual({ tag: 7 });
    expect(g3.payload.text).toBe("body-3");
  });
});

// ─── search（FTS5 trigram）───────────────────────────────────────────────

describe("MeshObserver.search", () => {
  it("finds by trigram, filters by conversation", async () => {
    greenWorld(db);
    const hits = await obs.search({ text: "hello world" });
    expect(hits.map((m) => m.id)).toEqual(["m1"]);
    expect(hits[0]!.payload.text).toBe("hello world from a1");
    const scoped = await obs.search({
      text: "hello world",
      conversationId: "gc",
    });
    expect(scoped).toEqual([]);
  });

  it("returns empty for queries shorter than 3 chars", async () => {
    greenWorld(db);
    expect(await obs.search({ text: "he" })).toEqual([]);
    expect(await obs.search({ text: "" })).toEqual([]);
  });

  it("supports trailing * prefix wildcard", async () => {
    greenWorld(db);
    const rowid = insMsg(db, {
      id: "m9",
      conv: "dc",
      seq: 3,
      from: "a1",
      text: "xylophone concert",
    });
    insFts(db, rowid, "xylophone concert");
    expect((await obs.search({ text: "xylo*" })).map((m) => m.id)).toEqual([
      "m9",
    ]);
  });

  it("embedded quotes do not break FTS syntax", async () => {
    greenWorld(db);
    await expect(obs.search({ text: 'wor"ld' })).resolves.toEqual([]);
    await expect(obs.search({ text: "hello" })).resolves.toHaveLength(1);
  });

  it("degrades to empty result when the FTS table is missing", async () => {
    greenWorld(db);
    db.exec("DROP TABLE mesh_messages_fts");
    await expect(obs.search({ text: "hello" })).resolves.toEqual([]);
  });
});

// ─── trace ────────────────────────────────────────────────────────────────

describe("MeshObserver.trace", () => {
  it("maps delivery rows to DeliveryTrace", async () => {
    greenWorld(db);
    const tr = await obs.trace("m1");
    expect(tr.length).toBe(1);
    expect(tr[0]).toMatchObject({
      deliveryId: "d1",
      messageId: "m1",
      accountId: "a2",
      state: "delivered",
      partial: false,
      attempts: 0,
      woke: false,
      path: null,
      grade: null,
    });
    expect(tr[0]!.createdAt).toBe(
      (await obs.messages({ conversationId: "dc" }))[0]!.routedAt,
    );

    insDelivery(db, {
      id: "d-park",
      msg: "g2",
      acct: "a3",
      state: "parked",
      reason: "LEASE_HELD",
      attempts: 2,
      grade: "steer",
      woke: true,
    });
    const parked = (await obs.trace("g2")).find(
      (x) => x.deliveryId === "d-park",
    );
    expect(parked).toMatchObject({
      state: "parked",
      reason: "LEASE_HELD",
      attempts: 2,
      woke: true,
      grade: "steer",
    });
    expect(parked!.parkedAt).toBeTruthy();
  });
});

// ─── inboxOf ──────────────────────────────────────────────────────────────

describe("MeshObserver.inboxOf", () => {
  it("computes unread, recent(≤3, ascending, truncated), peer, awaiting acks", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insMsg(db, {
      id: "m3",
      conv: "dc",
      seq: 3,
      from: "a1",
      text: "x".repeat(80),
    });
    insMsg(db, {
      id: "m4",
      conv: "dc",
      seq: 4,
      from: "a1",
      text: "with mention",
      mentions: ["a2"],
    });
    insMsg(db, { id: "m5", conv: "dc", seq: 5, from: "a1", text: "plain" });
    insMsg(db, {
      id: "m6",
      conv: "dc",
      seq: 6,
      from: "a1",
      text: "need ack",
      expect: "ack",
      to: ["a2"],
    });
    for (const mid of ["m3", "m4", "m5", "m6"]) {
      insDelivery(db, {
        id: "dx-" + mid,
        msg: mid,
        acct: "a2",
        state: "queued",
      });
    }
    store.recomputeInboxCaches();

    const view = await obs.inboxOf("a2");
    const dc = view.conversations.find((c) => c.conversationId === "dc");
    expect(dc).toBeDefined();
    expect(dc!.unread).toBe(5); // m1 delivered + m3..m6 queued
    expect(dc!.kind).toBe("direct");
    expect(dc!.peer).toBe("a1");
    expect(dc!.verbatim).toBe(true); // direct 恒在预算内
    expect(dc!.recent.map((r) => r.seq)).toEqual([4, 5, 6]); // 最新 3 条升序
    expect(dc!.recent[0]!.preview.length).toBeLessThanOrEqual(40); // 40 字截断
    expect(dc!.recent[0]!.mentionsMe).toBe(true); // m4 mentions a2
    expect(dc!.recent[2]!.expectsMyAck).toBe(true); // m6 expect=ack to a2
    expect(dc!.recent[1]!.expectsMyAck).toBe(false);
    expect(view.awaitingMyAck.map((x) => x.correlationId)).toEqual(["corr-1"]);
    expect(view.awaitingMyAck[0]!.from).toBe("a1");

    const mine = await obs.inboxOf("a1");
    expect(mine.awaitingTheirAck.map((x) => x.correlationId)).toEqual([
      "corr-1",
    ]);
  });

  it("verbatim: never-spoke group member out of budget; spoke recently in budget", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    const v0 = await obs.inboxOf("a2");
    expect(
      v0.conversations.find((c) => c.conversationId === "gc")!.verbatim,
    ).toBe(false);
    db.prepare(
      "UPDATE mesh_memberships SET last_spoke_seq = 2 WHERE conversation_id = 'gc' AND account_id = 'a2'",
    ).run();
    const v1 = await obs.inboxOf("a2");
    expect(
      v1.conversations.find((c) => c.conversationId === "gc")!.verbatim,
    ).toBe(true);
  });

  it("passes through overflow folding fields", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    db.prepare(
      "UPDATE mesh_inboxes SET overflow_count = 4, overflow_summary = ? WHERE account_id = 'a2' AND conversation_id = 'gc'",
    ).run("4 messages folded");
    const view = await obs.inboxOf("a2");
    const gc = view.conversations.find((c) => c.conversationId === "gc");
    expect(gc!.overflow).toBe(4);
    expect(gc!.summary).toBe("4 messages folded");
  });

  it("queue conversations expose claimable count", async () => {
    greenWorld(db);
    store.recomputeInboxCaches();
    insConv(db, "qc", "queue");
    insMember(db, "qc", "a2", ["speak", "read"]);
    insMsg(db, { id: "q1", conv: "qc", seq: 1, from: "a1", text: "job1" });
    insMsg(db, {
      id: "q2",
      conv: "qc",
      seq: 2,
      from: "a1",
      text: "job2",
      claim: { by: "a2", at: isoNow() },
    });
    insDelivery(db, { id: "dq1", msg: "q1", acct: "a2", state: "queued" });
    insDelivery(db, {
      id: "dq2",
      msg: "q2",
      acct: "a2",
      state: "claimed",
      claimUntil: isoFromMs(Date.now() + 300_000),
    });
    const view = await obs.inboxOf("a2");
    const qc = view.conversations.find((c) => c.conversationId === "qc");
    expect(qc!.claimable).toBe(1);
    expect(qc!.myClaims?.length).toBe(1);
  });
});

// ─── conversationsOf ──────────────────────────────────────────────────────

describe("MeshObserver.conversationsOf", () => {
  it("lists memberships and subscriptions with titles, caps, memberCount", async () => {
    greenWorld(db);
    const cs = await obs.conversationsOf("a1");
    expect(cs.map((c) => c.conversationId).sort()).toEqual(["dc", "gc"]);
    const dc = cs.find((c) => c.conversationId === "dc")!;
    expect(dc.title).toBe("Bob"); // direct 标题 = 对端 displayName
    expect(dc.kind).toBe("direct");
    expect(dc.myCaps).toEqual(["speak", "read"]);
    expect(dc.memberCount).toBe(2);
    expect(dc.state).toBe("active");

    const a3 = await obs.conversationsOf("a3");
    expect(a3.map((c) => c.conversationId).sort()).toEqual(["gc", "tc"]);
    const tc = a3.find((c) => c.conversationId === "tc")!;
    expect(tc.memberCount).toBeUndefined(); // topic 无成员表
    expect(tc.myCaps).toEqual([]);
    expect(tc.lastSeq).toBe(1);
  });
});

// ─── streamEntries ────────────────────────────────────────────────────────

describe("MeshObserver.streamEntries", () => {
  it("lists entries ordered by seq_in_stream, filtered by sinceSeq", async () => {
    greenWorld(db);
    insEndpoint(db, { id: "e1", acct: "a2", state: "hot" });
    db.prepare(
      "INSERT INTO mesh_streams (pi_session_id, endpoint_id, account_id, created_at) VALUES (?,?,?,?)",
    ).run("ps1", "e1", "a2", isoNow());
    for (let i = 1; i <= 4; i++) {
      db.prepare(
        "INSERT INTO mesh_stream_entries (entry_id, pi_session_id, parent_id, seq_in_stream, entry_type, " +
          "raw_json, mesh_message_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        "en" + i,
        "ps1",
        i === 1 ? null : "en" + (i - 1),
        i,
        "custom_message",
        '{"i":' + i + "}",
        i === 1 ? "m1" : null,
        isoNow(),
      );
    }
    const all = await obs.streamEntries("ps1");
    expect(all.map((e) => e.seqInStream)).toEqual([1, 2, 3, 4]);
    expect(all[0]!.meshMessageId).toBe("m1");
    expect(all[0]!.parentId).toBeNull();
    const tail = await obs.streamEntries("ps1", { sinceSeq: 3 });
    expect(tail.map((e) => e.seqInStream)).toEqual([3, 4]);
    expect(tail[0]!.rawJson).toBe('{"i":3}');
  });
});

// ─── counters ─────────────────────────────────────────────────────────────

describe("MeshObserver.counters", () => {
  it("sums buckets, zero-fills all 23 names, adds queueDepth", async () => {
    greenWorld(db);
    store.bumpCounter("messages_total", 3);
    store.bumpCounter("dedup_hit", 2);
    db.prepare(
      "INSERT INTO mesh_counters (name, bucket, value) VALUES (?,?,?)",
    ).run("messages_total", "2000-01-01T10", 5);
    const all = await obs.counters();
    expect(all["messages_total"]).toBe(8);
    expect(all["dedup_hit"]).toBe(2);
    const names = Object.keys(all).filter((k) => !k.startsWith("queueDepth:"));
    expect(names.length).toBe(23);
    expect(all["policy_degraded"]).toBe(0); // 零填充
    expect(all["queueDepth:queued"]).toBe(1); // d3
    expect(all["queueDepth:delivered"]).toBe(3); // d1 d4 d5
    expect(all["queueDepth:consumed"]).toBe(1); // d2
    expect(all["queueDepth:routed"]).toBe(0);
  });

  it("filters by names and by since (hour bucket)", async () => {
    greenWorld(db);
    store.bumpCounter("messages_total", 3);
    db.prepare(
      "INSERT INTO mesh_counters (name, bucket, value) VALUES (?,?,?)",
    ).run("messages_total", "2000-01-01T10", 5);
    const one = await obs.counters(["messages_total"]);
    expect(one).toEqual({ messages_total: 8 });
    const recent = await obs.counters(
      undefined,
      isoFromMs(Date.now() - 3_600_000),
    );
    expect(recent["messages_total"]).toBe(3); // 只剩当前小时桶
    expect(recent["seq_gap"]).toBe(0);
  });
});

// ─── 回放延期与只读性 ─────────────────────────────────────────────────────

describe("MeshObserver misc", () => {
  it("replay returns ReplayResult (implemented), forkAt still throws MeshUnsupportedError", async () => {
    const result = await obs.replay("e1");
    expect(result).toBeDefined();
    expect(result.entries).toBeDefined();
    expect(result.inbox).toBeDefined();
    await expect(obs.forkAt("e1", "en1")).rejects.toThrow(MeshUnsupportedError);
  });

  it("never writes: table contents unchanged after every read method", async () => {
    greenWorld(db);
    insEndpoint(db, { id: "e1", acct: "a2", state: "hot" });
    db.prepare(
      "INSERT INTO mesh_streams (pi_session_id, endpoint_id, account_id, created_at) VALUES (?,?,?,?)",
    ).run("ps1", "e1", "a2", isoNow());
    store.bumpCounter("messages_total", 1);

    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mesh_%'",
        )
        .all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    const countsBefore = tables.map(
      (name) =>
        (db.prepare("SELECT COUNT(*) AS n FROM " + name).get() as { n: number })
          .n,
    );

    await obs.checkInvariants();
    await obs.messages({});
    await obs.search({ text: "hello" });
    await obs.trace("m1");
    await obs.inboxOf("a2");
    await obs.conversationsOf("a1");
    await obs.streamEntries("ps1");
    await obs.counters();

    const countsAfter = tables.map(
      (name) =>
        (db.prepare("SELECT COUNT(*) AS n FROM " + name).get() as { n: number })
          .n,
    );
    expect(countsAfter).toEqual(countsBefore);
  });
});
