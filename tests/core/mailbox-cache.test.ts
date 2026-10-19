// ═══════════════════════════════════════════════════════════════════════════
// W06 契约式测试（整合计划 §7.3）：邮箱转换后缓存 == 重算值（I32a/c）、游标权威
// 推进不越界（I32b）、静音强制 silent 定档（C01，§9.5:1718）。缓存列
// pending_count/pending_bytes/overflow_count 以 mesh_deliveries 为真相；cursor_seq
// 是权威状态、绝不重算。字节口径恒为 LENGTH(CAST(payload AS BLOB))（UTF-8 字节）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshEventBus } from "../../src/core/events.js";
import { MeshMailbox } from "../../src/core/mailbox.js";
import { createDefaultPolicies } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { MeshRouter } from "../../src/core/router.js";
import { SqliteStore } from "../../src/core/store.js";
import { InProcessTransport } from "../../src/core/transport.js";
import type { RouteInput } from "../../src/core/contracts.js";
import type {
  Endpoint,
  Envelope,
  Limits,
  Policies,
  RegisterAccountInput,
  SinkHandler,
} from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { isoFromMs } from "../../src/core/util.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

interface Harness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  port: FakeStreamPort;
  mailbox: MeshMailbox;
  router: MeshRouter;
  limits: Limits;
  sinkHandlers: Map<string, SinkHandler>;
  delivered: Envelope[];
  consumed: Array<{ envelope: Envelope; accountId: string }>;
  parked: Array<{ envelope: Envelope; reason: string }>;
}

function makeHarness(
  opts: { limits?: Partial<Limits>; policies?: Partial<Policies> } = {},
): Harness {
  const tdb = openTestDb();
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  const port = new FakeStreamPort();
  const sinkHandlers = new Map<string, SinkHandler>();
  const awaiting = new Map<string, Set<string>>();
  const policies: Policies = {
    ...createDefaultPolicies({
      isAwaiting: (acct: string, cid: string | undefined) =>
        cid !== undefined && (awaiting.get(acct) ?? new Set()).has(cid),
      endpointsOf: (acct: string) =>
        registry.endpointsOf(acct).map((e) => ({
          id: e.id,
          inFlight: 0,
          topology: e.topology,
        })),
      limits,
    }),
    sessionFactory: {
      create: async () => ({ session: {}, piSessionId: "pi-test" }),
      open: async () => ({ session: {} }),
    },
    ...opts.policies,
  };
  const mailbox = new MeshMailbox({
    store,
    registry,
    events,
    policies,
    limits,
    transport: new InProcessTransport(),
    port,
    sinkHandlers,
    awaitingCorrelations: (acct) => [...(awaiting.get(acct) ?? new Set())],
    devMode: true,
  });
  port.onEntry((e) => mailbox.handleEntryAppended(e));
  port.onTurnEnd((e) => mailbox.handleTurnEnd(e.endpointId));
  const router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits,
    devMode: true,
    onRouted: async (e) => {
      await mailbox.fanout(e);
    },
    isAwaiting: (acct: string, cid: string) =>
      (awaiting.get(acct) ?? new Set()).has(cid),
  });
  const delivered: Envelope[] = [];
  const consumed: Array<{ envelope: Envelope; accountId: string }> = [];
  const parked: Array<{ envelope: Envelope; reason: string }> = [];
  events.on("message_delivered", (p) => delivered.push(p.envelope));
  events.on("message_consumed", (p) =>
    consumed.push({ envelope: p.envelope, accountId: p.accountId }),
  );
  events.on("message_parked", (p) =>
    parked.push({ envelope: p.envelope, reason: p.reason }),
  );
  return {
    db: tdb.db,
    store,
    registry,
    events,
    port,
    mailbox,
    router,
    limits,
    sinkHandlers,
    delivered,
    consumed,
    parked,
  };
}

const ALL_KINDS: RegisterAccountInput["initiate"] = [
  "chat",
  "task",
  "event",
  "system",
  "tombstone",
];

async function addAcc(h: Harness, id: string, presence?: string): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ALL_KINDS,
  });
  if (presence) h.registry.setPresence(id, presence as "available");
}

async function addHotEndpoint(h: Harness, id: string): Promise<Endpoint> {
  const ep = await h.registry.registerEndpoint({
    accountId: id,
    topology: { kind: "unified" },
    piSessionId: "pi-" + id,
  });
  h.registry.updateEndpointState(ep.id, "hot");
  return ep;
}

function msg(
  from: string,
  conversationId: string,
  extra: Partial<RouteInput> = {},
): RouteInput {
  return {
    from,
    conversationId,
    kind: "chat",
    expect: "none",
    text: "hello",
    clientToken: Math.random().toString(36).slice(2),
    ...extra,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function deliveryRow(
  h: Harness,
  messageId: string,
  accountId: string,
): Record<string, unknown> {
  return h.db
    .prepare<[string, string], Record<string, unknown>>(
      "SELECT * FROM mesh_deliveries WHERE message_id = ? AND account_id = ?",
    )
    .get(messageId, accountId)!;
}

function inboxOf(
  h: Harness,
  accountId: string,
  conversationId: string,
): Record<string, unknown> {
  return h.db
    .prepare<[string, string], Record<string, unknown>>(
      "SELECT * FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?",
    )
    .get(accountId, conversationId)!;
}

/** 真相：pending 行的 BLOB（UTF-8）字节和 —— 与 store.recomputeInbox 同一口径 */
function byteTruth(
  h: Harness,
  accountId: string,
  conversationId: string,
): number {
  return (
    h.db
      .prepare<[string, string], { b: number }>(
        "SELECT COALESCE(SUM(LENGTH(CAST(m.payload AS BLOB))), 0) AS b " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? " +
          "AND d.state IN ('routed','queued','parked','delivered')",
      )
      .get(accountId, conversationId)!.b
  );
}

/** 对照口径：LENGTH(payload) 字符数（非 ASCII 下 < 字节数，用于证明用例确能区分） */
function charSum(
  h: Harness,
  accountId: string,
  conversationId: string,
): number {
  return (
    h.db
      .prepare<[string, string], { c: number }>(
        "SELECT COALESCE(SUM(LENGTH(m.payload)), 0) AS c " +
          "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? " +
          "AND d.state IN ('routed','queued','parked','delivered')",
      )
      .get(accountId, conversationId)!.c
  );
}

// ─── I32(a)：pending→dropped 后缓存 == 重算值 ────────────────────────────

describe("W06 I32(a): pending→dropped recomputes inbox cache", () => {
  it("TTL sweep drop resets pending_count/pending_bytes to zero", async () => {
    const h = makeHarness();
    await addAcc(h, "A", "available");
    await addAcc(h, "B", "available");
    const conv = await h.registry.ensureDirect("A", "B");
    // 无端点 → ENDPOINT_GONE parked，pending=1（含多字节载荷）
    const r = await h.router.route(
      msg("A", conv.id, { text: "你好 🎉", clientToken: "ttl1" }),
    );
    let inbox = inboxOf(h, "B", conv.id);
    expect(inbox.pending_count).toBe(1);
    expect(inbox.pending_bytes).toBeGreaterThan(0);

    h.db
      .prepare("UPDATE mesh_deliveries SET parked_at = ? WHERE message_id = ?")
      .run(isoFromMs(Date.now() - h.limits.parkTtlMs - 1000), r.messageId);
    await h.mailbox.sweep();

    expect(deliveryRow(h, r.messageId, "B").state).toBe("dropped");
    expect(deliveryRow(h, r.messageId, "B").drop_reason).toBe("TTL_EXPIRED");
    inbox = inboxOf(h, "B", conv.id);
    // 转换后缓存 == 重算值（本例为 0）；且与真相口径一致
    expect(inbox.pending_count).toBe(0);
    expect(inbox.pending_bytes).toBe(0);
    expect(byteTruth(h, "B", conv.id)).toBe(0);
    h.store.close();
  });
});

// ─── I32(c)：字节口径与真相一致 ──────────────────────────────────────────

describe("W06 I32(c): byte-accurate accounting", () => {
  it("fold of non-ASCII payloads keeps pending_bytes == BLOB byte truth", async () => {
    const h = makeHarness({
      limits: { maxPending: 4, maxPendingBytes: 1_000_000 },
    });
    await addAcc(h, "A", "available");
    await addAcc(h, "B", "available");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const texts = ["你好世界", "🎉🎉", "こんにちは", "😀😀😀", "مرحبا بالعالم"];
    for (let i = 0; i < 5; i++) {
      await h.router.route(
        msg("A", conv.id, { text: texts[i], clientToken: "f" + i }),
      );
    }
    await h.mailbox.sweep();

    const inbox = inboxOf(h, "B", conv.id);
    expect(inbox.pending_count).toBe(2); // ceil(5/2) 折叠 3，剩 2
    expect(inbox.overflow_count).toBe(3);

    // 用例确能区分字符/字节（非 ASCII 下字节数 > 字符数），否则测试无意义
    expect(charSum(h, "B", conv.id)).toBeLessThan(byteTruth(h, "B", conv.id));
    // 转换后 pending_bytes == 真相；重算幂等（缓存 == 重算值）
    expect(inbox.pending_bytes).toBe(byteTruth(h, "B", conv.id));
    h.store.recomputeInbox("B", conv.id);
    expect(inboxOf(h, "B", conv.id).pending_bytes).toBe(byteTruth(h, "B", conv.id));
    h.store.close();
  });
});

// ─── I32(b)：游标推进不越界、折叠只在追赶固化时清零 ────────────────────

describe("W06 I32(b): cursor advance and overflow reset", () => {
  it("markConsumed advances cursor only to the consumed seq (no overshoot)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", "available");
    await addAcc(h, "B", "available");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.recordSpoke(conv.id, "B", 1); // 预算内 ⇒ P1
    await addHotEndpoint(h, "B");
    // silent(low) 不醒 → 停在 delivered（无 turn_end），游标不动
    const r1 = await h.router.route(
      msg("A", conv.id, { to: ["B"], priority: "low", clientToken: "m1" }),
    );
    const r2 = await h.router.route(
      msg("A", conv.id, { to: ["B"], priority: "low", clientToken: "m2" }),
    );
    expect(deliveryRow(h, r1.messageId, "B").state).toBe("delivered");
    expect(deliveryRow(h, r2.messageId, "B").state).toBe("delivered");

    const seq1 = h.db
      .prepare<[string], { seq: number }>("SELECT seq FROM mesh_messages WHERE id = ?")
      .get(r1.messageId)!.seq;
    const seq2 = h.db
      .prepare<[string], { seq: number }>("SELECT seq FROM mesh_messages WHERE id = ?")
      .get(r2.messageId)!.seq;
    expect(seq1).toBeLessThan(seq2);

    // sink 单条消费：只推本条 seq，不越界到更高未消费排队/挂起行
    await h.mailbox.markConsumed(deliveryRow(h, r1.messageId, "B").id as string);

    const inbox = inboxOf(h, "B", conv.id);
    expect(inbox.cursor_seq).toBe(seq1);
    expect(inbox.cursor_seq).toBeLessThan(seq2);
    // r2 仍 delivered 待消费
    expect(inbox.pending_count).toBe(1);
    expect(deliveryRow(h, r2.messageId, "B").state).toBe("delivered");
    h.store.close();
  });

  it("CATCHUP digest clears overflow and advances cursor to spanTo", async () => {
    const h = makeHarness({
      limits: { maxPending: 4, maxPendingBytes: 1_000_000 },
    });
    await addAcc(h, "A", "available");
    await addAcc(h, "B", "available");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    await addHotEndpoint(h, "B");
    // B 未发言 → 5 条 P2 queued → 折叠 3（overflow=3，剩 2 条 queued）
    for (let i = 0; i < 5; i++) {
      await h.router.route(msg("A", conv.id, { clientToken: "fo" + i }));
    }
    await h.mailbox.sweep();
    let inbox = inboxOf(h, "B", conv.id);
    expect(inbox.overflow_count).toBe(3);
    expect(inbox.overflow_summary).toBeTruthy();
    const spanTo = h.db
      .prepare<[string, string], { s: number }>(
        "SELECT MAX(m.seq) AS s FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
          "WHERE d.account_id = ? AND m.conversation_id = ? AND d.state = 'queued'",
      )
      .get("B", conv.id)!.s;

    // B 发言（回预算）→ 下一条 A 消息 P1 + CATCHUP：固化摘要、清折叠、推游标到 spanTo
    await h.router.route(msg("B", conv.id, { clientToken: "b1" }));
    await h.router.route(
      msg("A", conv.id, { to: ["B"], priority: "low", clientToken: "m7" }),
    );
    await flush();

    inbox = inboxOf(h, "B", conv.id);
    expect(inbox.overflow_count).toBe(0); // 折叠只在追赶固化时清零
    expect(inbox.overflow_summary).toBeNull();
    expect(inbox.cursor_seq).toBe(spanTo);
    h.store.close();
  });
});

// ─── C01：静音强制 silent 定档（§9.5:1718）──────────────────────────────

describe("W06 C01: mute forces grade = silent", () => {
  it("muted cold stream: silent + queued, no warm (§7.2 silent×cold → 只写 Inbox)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", "available");
    await addAcc(h, "B", "available");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.recordSpoke(conv.id, "B", 1); // 预算内 ⇒ P1
    h.registry.mute(conv.id, "B", isoFromMs(Date.now() + 60_000));
    const epB = await h.registry.registerEndpoint({
      accountId: "B",
      topology: { kind: "unified" },
    });
    h.port.setEndpointState(epB.id, "cold");

    await h.router.route(msg("A", conv.id, { to: ["B"], clientToken: "m1" }));

    const row = h.db
      .prepare("SELECT grade, state, woke, parked_reason FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as Record<string, unknown>;
    expect(row.grade).toBe("silent"); // 静音强制 silent（普通消息本应是 followUp/steer）
    expect(row.state).toBe("queued"); // §7.2：silent×cold 只写 Inbox，delivery 留 queued（非终态，warm 后重投）
    expect(row.parked_reason).toBeNull();
    expect(row.woke).toBe(0);
    expect(h.port.delivered).toHaveLength(0);
    expect(h.port.warmed).toHaveLength(0); // 冷流不因静音消息升温
    h.store.close();
  });

  it("muted hot direct: silent + no wake (mute suppresses even direct wake)", async () => {
    const h = makeHarness();
    await addAcc(h, "A", "available");
    await addAcc(h, "B", "available");
    const epB = await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    h.registry.mute(conv.id, "B", isoFromMs(Date.now() + 60_000));

    await h.router.route(msg("A", conv.id, { clientToken: "m1" }));

    const row = h.db
      .prepare("SELECT grade, state, woke FROM mesh_deliveries WHERE account_id = 'B'")
      .get() as Record<string, unknown>;
    expect(row.grade).toBe("silent"); // 规则②单聊必醒也会被静音压成 silent
    expect(row.woke).toBe(0);
    expect(row.state).toBe("delivered"); // 热流仍入流，只是不唤醒
    expect(h.port.wakeCountByEndpoint(epB.id)).toBe(0);
    h.store.close();
  });
});