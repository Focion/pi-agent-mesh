// ═══════════════════════════════════════════════════════════════════════════
// 事件合同测试（I26）：枚举每条合法投递跃迁，钉住「事件名 + 载荷关键字段」。
//
// 覆盖的补发/修正：
//   - P3（只读成员 note 完成）、sink accepted 必发 message_delivered（markDelivered 统一咽喉）。
//   - catchup 固化的 queued→consumed 补发 message_consumed（partial=true）。
//   - 死信 message_dropped 携带 endpointId。
//   - request-response ack 的 message_acked 携带真实 endpointId。
//   - reclaim 拒绝降级经 setEndpointState 补发 endpoint_state_changed。
//
// fold 受害者只发 inbox_overflowed 聚合、不逐受害者发 message_dropped——规范例外：
// 「dropped(folded) 不计投递失败」的显式对齐（见 §7.6 折叠 / appendix 附录 E）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  Envelope,
  Limits,
  PendingDelivery,
  Policies,
  RegisterAccountInput,
  SinkHandler,
  Transport,
  Unsubscribe,
} from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

// ─── mailbox 级迷你编排（与 mailbox.test.ts 同构，聚焦事件断言）────────────────

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
}

class RecordingTransport implements Transport {
  readonly kind = "recording" as const;
  publishes: PendingDelivery[] = [];
  acks: Array<{ deliveryId: string; state: DeliveryState }> = [];
  failPublish = false;
  private handlers = new Map<string, (d: PendingDelivery) => Promise<void>>();

  async publish(d: PendingDelivery): Promise<void> {
    if (this.failPublish) throw new Error("publish boom");
    this.publishes.push(d);
  }
  async ack(deliveryId: string, state: DeliveryState): Promise<void> {
    this.acks.push({ deliveryId, state });
  }
  subscribe(endpointId: string, h: (d: PendingDelivery) => Promise<void>): Unsubscribe {
    this.handlers.set(endpointId, h);
    return () => {
      if (this.handlers.get(endpointId) === h) this.handlers.delete(endpointId);
    };
  }
  stop(): void {}
}

function makeHarness(
  opts: {
    limits?: Partial<Limits>;
    policies?: Partial<Policies>;
    transport?: Transport;
  } = {},
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
    transport: opts.transport ?? new InProcessTransport(),
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
  return { db: tdb.db, store, registry, events, port, mailbox, router, limits, sinkHandlers };
}

const ALL_KINDS: RegisterAccountInput["initiate"] = [
  "chat",
  "task",
  "event",
  "system",
  "tombstone",
];

async function addAcc(
  h: Harness,
  id: string,
  o: {
    presence?: string;
    endpointClass?: RegisterAccountInput["endpointClass"];
    initiate?: RegisterAccountInput["initiate"];
  } = {},
): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: o.endpointClass ?? "stream",
    initiate: o.initiate ?? ALL_KINDS,
  });
  if (o.presence) h.registry.setPresence(id, o.presence as "available");
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

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ─── mailbox 级：delivered / consumed / dropped 载荷 ─────────────────────────

describe("event contract: mailbox delivered/consumed/dropped", () => {
  it("P3 (read-only note) 完成即发 message_delivered，携带 endpointId/path/woke", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    h.registry.setCaps(conv.id, "B", ["read"]); // B 只读 ⇒ 走 P3
    await addHotEndpoint(h, "A");
    const epB = await addHotEndpoint(h, "B");

    const delivered: Array<{ endpointId: string; accountId: string; path: string; woke: boolean }> = [];
    h.events.on("message_delivered", (p) => delivered.push(p));

    await h.router.route(msg("A", conv.id, { to: ["B"], expect: "reply" }));
    await flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      endpointId: epB.id,
      accountId: "B",
      path: "P3",
      woke: false, // A1：只读成员永不醒
    });
    h.store.close();
  });

  it("sink accepted 即发 message_delivered（无端点落 \"\"，path=P1）", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "S", { endpointClass: "sink" });
    await addHotEndpoint(h, "A");
    const accepted: Array<{ grade: string }> = [];
    h.sinkHandlers.set("S", {
      deliver: async (_rendered, _env, grade) => {
        accepted.push({ grade });
        return { accepted: true };
      },
    });
    const conv = await h.registry.ensureDirect("A", "S");

    const delivered: Array<{ endpointId: string; accountId: string; path: string }> = [];
    h.events.on("message_delivered", (p) => delivered.push(p));

    await h.router.route(msg("A", conv.id));
    await flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ endpointId: "", accountId: "S", path: "P1" });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.grade).toBe("followUp");
    h.store.close();
  });

  it("catchup 固化 queued→consumed 补发 message_consumed（partial=true）", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { presence: "available" });
    await addAcc(h, "B", { presence: "available" });
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    await addHotEndpoint(h, "B");
    // B 从未发言：第一条 A 的消息走 P2 留在 queued
    await h.router.route(msg("A", conv.id, { clientToken: "m1" }));
    // B 发言（发言 ⇒ 回到预算内）
    await h.router.route(msg("B", conv.id, { clientToken: "b1" }));

    const consumed: Array<{ accountId: string; partial: boolean }> = [];
    h.events.on("message_consumed", (p) => consumed.push({ accountId: p.accountId, partial: p.partial }));

    // 下一条给 B 的消息触发 CATCHUP，把 queued 的 m1 固化成 consumed
    await h.router.route(msg("A", conv.id, { clientToken: "m2" }));
    await flush();

    const catchupConsumed = consumed.filter((c) => c.accountId === "B" && c.partial);
    expect(catchupConsumed.length).toBeGreaterThanOrEqual(1);
    h.store.close();
  });

  it("死信 message_dropped 携带 endpointId（nack 到 MAX_ATTEMPTS）", async () => {
    const h = makeHarness({ limits: { maxAttempts: 1 } });
    await addAcc(h, "A");
    await addAcc(h, "W");
    const epW = await addHotEndpoint(h, "W");
    const q = await h.registry.createConversation({ type: "queue", creator: "A", members: ["W"] });

    // 直接INSERT 一条已投给 epW 的 queue delivery（endpoint_id 非空），绕开 fanout 避免 auto-consume
    const msgId = "test-msg-" + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    h.db
      .prepare(
        "INSERT INTO mesh_messages (id, conversation_id, from_account, kind, expect, seq, payload, routed_at, idempotency_key, client_token) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(msgId, q.id, "A", "task", "ack", 1, JSON.stringify({ text: "job" }), now, msgId, null);
    const dId = "test-d-" + Math.random().toString(36).slice(2);
    h.db
      .prepare(
        "INSERT INTO mesh_deliveries (id, message_id, account_id, endpoint_id, path, state, state_changed_at, delivered_at, attempts) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(dId, msgId, "W", epW.id, "P1", "delivered", now, now, 1);
    h.registry.ensureInboxRow("W", q.id);

    const dropped: Array<{ endpointId?: string; reason: string }> = [];
    h.events.on("message_dropped", (p) => dropped.push({ endpointId: p.endpointId, reason: p.reason }));

    await h.mailbox.claim(msgId, "W");
    await h.mailbox.ackQueue(msgId, "W", "failed again");

    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toBe("MAX_ATTEMPTS");
    expect(dropped[0]!.endpointId).toBe(epW.id);
    h.store.close();
  });
});

// ─── host 级（createMesh + FakeStreamPort）：ack 端点与状态跃迁 ──────────────

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "e2e-session" }),
  open: async () => ({ session: {} }),
};

async function makeMesh(): Promise<{ host: MeshHost; dir: string; port: FakeStreamPort }> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-event-"));
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits: { handoffTimeoutMs: 1000 },
    devMode: true,
  });
  return { host, dir, port };
}

async function makeSpeaker(host: MeshHost, id: string): Promise<{ endpointId: string }> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat"],
  });
  const endpoint = await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
  await host.setPresence(id, "available");
  return { endpointId: endpoint.id };
}

describe("event contract: host ack + endpoint state", () => {
  it("request-response ack 的 message_acked 携带真实 endpointId", async () => {
    const { host } = await makeMesh();
    try {
      await makeSpeaker(host, "requester");
      const responder = await makeSpeaker(host, "responder");
      const conv = await host.ensureDirect("requester", "responder");

      const req = await host.request({
        from: "requester",
        conversationId: conv.id,
        kind: "chat",
        expect: "ack",
        to: ["responder"],
      });
      const correlationId = (req as { correlationId: string }).correlationId;

      const acks: Array<{ correlationId: string; endpointId: string; ok: boolean }> = [];
      host.on("message_acked", (p) =>
        acks.push({ correlationId: p.correlationId, endpointId: p.endpointId, ok: p.ok }),
      );

      await host.ack({ correlationId, from: "responder", endpointId: responder.endpointId, data: "done" });

      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        correlationId,
        endpointId: responder.endpointId,
        ok: true,
      });
    } finally {
      await host.close();
    }
  });

  it("reclaim 拒绝（锁损坏 → unknown）经 setEndpointState 补发 endpoint_state_changed", async () => {
    const { host, dir } = await makeMesh();
    try {
      const { endpointId } = await makeSpeaker(host, "w1");

      const stateEvents: Array<{ endpointId: string; from: string; to: string }> = [];
      host.on("endpoint_state_changed", (p) =>
        stateEvents.push({ endpointId: p.endpointId, from: p.from, to: p.to }),
      );

      // 写一个损坏的锁文件 ⇒ ownerIsLive 返回 "unknown"，reclaim 拒绝并降级 unavailable
      const lockDir = join(dir, "mesh", "locks");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, `${endpointId}.lock`), "{ not valid json", "utf8");

      const r = await host.reclaimEndpoint(endpointId);
      expect(r.outcome).toBe("unknown");

      const mine = stateEvents.filter((e) => e.endpointId === endpointId);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine[mine.length - 1]!.to).toBe("unavailable");
      expect(mine[mine.length - 1]!.from).not.toBe("unavailable");
    } finally {
      await host.close();
    }
  });
});