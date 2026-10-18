// ═══════════════════════════════════════════════════════════════════════════
// queue claim 校验（I12 / C06 的 claim 部分，§17）：
//   claim 状态机（幂等 / CLAIM_TAKEN / CLAIM_EXPIRED / 他人过期回收重认领）；
//   payload 不可变（A1：claim 归属下移到 delivery 列，正文与 seal 字节不变）；
//   turn_end 不消费任务（§17.5）; 待领窗口回收（§17.2）;
//   nack 回队 + pending_acks.deadline 重开; 死信可追溯（§17.7）。
// 全部走 makeHarness 直读 DB，零 pi SDK；systemSend 以记录器接死信通知。
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
  DeliveryState,
  Endpoint,
  Limits,
  Policies,
  SinkHandler,
} from "../../src/core/types.js";
import { DEFAULT_LIMITS, MeshRejectError } from "../../src/core/types.js";
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
  systemSends: Array<{ to: string; conversationId: string; text: string }>;
}

interface QueueSeed {
  producer: string;
  worker: string;
  state?: DeliveryState;
  attempts?: number;
  correlationId?: string;
  payload?: string;
}

function makeHarness(opts: { limits?: Partial<Limits> } = {}): Harness {
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
  };
  const systemSends: Harness["systemSends"] = [];
  const mailbox = new MeshMailbox({
    store,
    registry,
    events,
    policies,
    limits,
    transport: new InProcessTransport(),
    port,
    sinkHandlers,
    isEndpointLocal: undefined,
    awaitingCorrelations: (acct) => [...(awaiting.get(acct) ?? new Set())],
    systemSend: async ({ to, conversationId, text }) => {
      systemSends.push({ to, conversationId, text });
    },
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
  return {
    db: tdb.db,
    store,
    registry,
    events,
    port,
    mailbox,
    router,
    limits,
    systemSends,
  };
}

async function addAcc(
  h: Harness,
  id: string,
  o: { presence?: boolean } = {},
): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat", "task", "event"],
  });
  if (o.presence) h.registry.setPresence(id, "available");
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

/** direct-insert 一条 queue 消息 + 一条 delivery + inbox 行 + 可选 pending_acks（绕开 fanout） */
async function insertQueue(
  h: Harness,
  queueId: string,
  o: QueueSeed,
): Promise<{ msgId: string; dId: string; correlationId: string | null }> {
  const msgId = "test-msg-" + Math.random().toString(36).slice(2);
  const dId = "test-d-" + Math.random().toString(36).slice(2);
  const correlationId = o.correlationId ?? null;
  const now = new Date().toISOString();
  const state = o.state ?? "delivered";
  h.db
    .prepare(
      "INSERT INTO mesh_messages (id, conversation_id, from_account, kind, expect, seq, payload, " +
        "routed_at, idempotency_key, client_token, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      msgId,
      queueId,
      o.producer,
      "task",
      "ack",
      1,
      o.payload ?? JSON.stringify({ text: "job" }),
      now,
      msgId,
      null,
      correlationId,
    );
  const deliveredAt =
    state === "delivered" || state === "claimed" || state === "acked" ? now : null;
  h.db
    .prepare(
      "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, path, state, " +
        "state_changed_at, delivered_at, attempts) VALUES (?,?,?,NULL,'P1',?,?,?,?)",
    )
    .run(dId, msgId, o.worker, state, now, deliveredAt, o.attempts ?? 0);
  h.registry.ensureInboxRow(o.worker, queueId);
  if (correlationId) {
    h.db
      .prepare(
        "INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, " +
          "to_account, conversation_id, deadline, state) VALUES (?,?,?,?,?,?,?,'open')",
      )
      .run(
        correlationId,
        msgId,
        "ack",
        o.producer,
        o.worker,
        queueId,
        isoFromMs(Date.now() + h.limits.claimTtlMs),
      );
  }
  return { msgId, dId, correlationId };
}

function delivery(h: Harness, dId: string): Record<string, unknown> {
  return h.db.prepare("SELECT * FROM mesh_deliveries WHERE id = ?").get(dId)! as Record<
    string,
    unknown
  >;
}

function pendingAck(h: Harness, correlationId: string): Record<string, unknown> {
  return h.db
    .prepare("SELECT * FROM mesh_pending_acks WHERE correlation_id = ?")
    .get(correlationId)! as Record<string, unknown>;
}

function counter(h: Harness, name: string): number {
  const row = h.db
    .prepare("SELECT COALESCE(SUM(value), 0) AS n FROM mesh_counters WHERE name = ?")
    .get(name) as { n: number };
  return row.n;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const msg = (from: string, conversationId: string, extra: Partial<RouteInput> = {}): RouteInput => ({
  from,
  conversationId,
  kind: "task",
  expect: "none",
  text: "job",
  clientToken: Math.random().toString(36).slice(2),
  ...extra,
});

describe("queue claim: state machine (§17.2/§17.3)", () => {
  it("delivered → claimed returns {ok:true, leaseUntil}; second claim is idempotent", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = await insertQueue(h, q.id, { producer: "A", worker: "W" });

    const first = await h.mailbox.claim(msgId, "W");
    expect(first.ok).toBe(true);
    expect(first.leaseUntil).toBeDefined();
    expect(delivery(h, dId).state).toBe("claimed");
    expect(delivery(h, dId).claimed_by).toBe("W");

    const second = await h.mailbox.claim(msgId, "W");
    expect(second.ok).toBe(true);
    expect(second.leaseUntil).toBe(first.leaseUntil); // 幂等：同一租约
    expect(delivery(h, dId).state).toBe("claimed");
    h.store.close();
  });

  it("non-assigned consumer claim → CLAIM_TAKEN", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    await addAcc(h, "X");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId } = await insertQueue(h, q.id, { producer: "A", worker: "W" });

    await expect(h.mailbox.claim(msgId, "X")).rejects.toMatchObject({
      code: "CLAIM_TAKEN",
    });
    h.store.close();
  });

  it("claimed by other (unexpired) → CLAIM_TAKEN; self expired → CLAIM_EXPIRED", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = await insertQueue(h, q.id, { producer: "A", worker: "W" });

    // 他人持有、未过期
    h.db
      .prepare("UPDATE mesh_deliveries SET state='claimed', claimed_by='X', claim_until=? WHERE id=?")
      .run(isoFromMs(Date.now() + 60_000), dId);
    await expect(h.mailbox.claim(msgId, "W")).rejects.toMatchObject({ code: "CLAIM_TAKEN" });

    // 自己持有、已过期
    h.db
      .prepare("UPDATE mesh_deliveries SET claimed_by='W', claim_until=? WHERE id=?")
      .run(isoFromMs(Date.now() - 1), dId);
    await expect(h.mailbox.claim(msgId, "W")).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    h.store.close();
  });

  it("other's expired claim falls through to reassign (attempts unchanged)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { msgId, dId } = await insertQueue(h, q.id, { producer: "A", worker: "W", attempts: 2 });

    h.db
      .prepare("UPDATE mesh_deliveries SET state='claimed', claimed_by='X', claim_until=? WHERE id=?")
      .run(isoFromMs(Date.now() - 1), dId);
    const r = await h.mailbox.claim(msgId, "W");
    expect(r.ok).toBe(true);
    const row = delivery(h, dId);
    expect(row.claimed_by).toBe("W");
    expect(row.attempts).toBe(2); // 回收重认领不改 attempts
    h.store.close();
  });
});

describe("queue claim: payload immutability (A1)", () => {
  it("claim never rewrites payload bytes or seal", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const payload = JSON.stringify({ text: "job", n: 42 });
    const { msgId } = await insertQueue(h, q.id, { producer: "A", worker: "W", payload });

    const before = h.db
      .prepare("SELECT payload, seal FROM mesh_messages WHERE id = ?")
      .get(msgId) as { payload: string; seal: string | null };
    await h.mailbox.claim(msgId, "W");
    const after = h.db
      .prepare("SELECT payload, seal FROM mesh_messages WHERE id = ?")
      .get(msgId) as { payload: string; seal: string | null };

    expect(after.payload).toBe(before.payload); // 字节一致（claim 不落正文）
    expect(after.seal).toBe(before.seal);
    expect(after.payload).not.toContain("by"); // 无 claim 归属混入
    h.store.close();
  });
});

describe("queue claim: turn_end does not consume (§17.5)", () => {
  it("available worker wakes and turns end, delivery stays delivered (claimable)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W", { presence: true });
    await addHotEndpoint(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });

    const r = await h.router.route(msg("A", q.id));
    await flush();

    const row = h.db
      .prepare("SELECT state, claim_until FROM mesh_deliveries WHERE message_id = ?")
      .get(r.messageId) as { state: string; claim_until: string | null };
    expect(row.state).toBe("delivered"); // turn_end 不消费 queue 任务
    expect(row.claim_until).toBeTruthy(); // 待领窗口已开启
    h.store.close();
  });
});

describe("queue claim: 待领窗口回收 (§17.2)", () => {
  it("delivered with expired claim_until → nack, attempts+1, lease reopened", async () => {
    const h = makeHarness({ limits: { claimTtlMs: 100 } });
    await addAcc(h, "A");
    await addAcc(h, "W");
    await addHotEndpoint(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const { dId } = await insertQueue(h, q.id, { producer: "A", worker: "W" });

    h.db
      .prepare("UPDATE mesh_deliveries SET claim_until=? WHERE id=?")
      .run(isoFromMs(Date.now() - 200), dId);
    await h.mailbox.reclaimExpiredClaims(Date.now());

    const row = delivery(h, dId);
    expect(row.attempts).toBe(1);
    expect(["queued", "delivered"]).toContain(row.state); // 回收后回队重投，不丢不卡
    h.store.close();
  });
});

describe("queue claim: nack requeue + pending deadline reopen (§17.6)", () => {
  it("nack requeues, attempts+1, pending_acks stays open with reopened deadline", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "W");
    await addHotEndpoint(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const correlationId = "corr-" + Math.random().toString(36).slice(2);
    const { msgId, dId } = await insertQueue(h, q.id, {
      producer: "A",
      worker: "W",
      correlationId,
    });

    await h.mailbox.claim(msgId, "W");
    const deadlineAfterClaim = pendingAck(h, correlationId).deadline as string;
    await h.mailbox.ackQueue(msgId, "W", "processing failed");

    const row = delivery(h, dId);
    expect(row.attempts).toBe(1);
    expect(["queued", "delivered"]).toContain(row.state);

    const pa = pendingAck(h, correlationId);
    expect(pa.state).toBe("open"); // 仍待应答，窗口重开
    expect(new Date(pa.deadline as string).getTime()).toBeGreaterThan(
      new Date(deadlineAfterClaim).getTime() - 1, // deadline >= claim 时推进的窗口
    );
    expect(pa.to_account).toBe("W"); // 单消费者且消费者一致（不误拒后续 ack）
    h.store.close();
  });
});

describe("queue claim: dead-letter (§17.7)", () => {
  it("MAX_ATTEMPTS → dropped + claim_error + timeout + request_timeout + system notify", async () => {
    const h = makeHarness({ limits: { maxAttempts: 1 } });
    await addAcc(h, "A");
    await addAcc(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });
    const correlationId = "corr-" + Math.random().toString(36).slice(2);
    const { msgId, dId } = await insertQueue(h, q.id, { producer: "A", worker: "W", correlationId });

    // 使 attempts 已到 1：claim 后再 nack 一次即超限（attempts=2 > maxAttempts=1）
    h.db.prepare("UPDATE mesh_deliveries SET attempts=1 WHERE id=?").run(dId);
    await h.mailbox.claim(msgId, "W");
    await h.mailbox.ackQueue(msgId, "W", "failed");

    const row = delivery(h, dId);
    expect(row.state).toBe("dropped");
    expect(row.drop_reason).toBe("MAX_ATTEMPTS");
    expect(row.claim_error).toBe("failed");
    expect(row.claimed_by).toBeNull();
    expect(row.claim_until).toBeNull();

    const pa = pendingAck(h, correlationId);
    expect(pa.state).toBe("timeout");
    expect(counter(h, "request_timeout")).toBe(1);

    expect(h.systemSends).toHaveLength(1);
    expect(h.systemSends[0]!.to).toBe("A"); // 通知发起方
    expect(h.systemSends[0]!.conversationId).toBe(q.id);
    expect(h.systemSends[0]!.text).toContain(correlationId);
    expect(h.systemSends[0]!.text).toContain("failed");
    h.store.close();
  });
});