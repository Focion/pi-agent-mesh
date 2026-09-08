// ═══════════════════════════════════════════════════════════════════════════
// Router 单元测试：六步校验 / 幂等 / @all 闸 / pending_acks / 环检测 /
// topic·queue 收窄 / tombstone / 计数器 / 事件（§5.4 §5.5 §6 §7.8 §9 §14 §16.6 §17）
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshEventBus } from "../../src/core/events.js";
import { createDefaultPolicies } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { MeshRouter } from "../../src/core/router.js";
import { SqliteStore } from "../../src/core/store.js";
import type { RouteInput } from "../../src/core/contracts.js";
import type {
  Envelope,
  Limits,
  Policies,
  RegisterAccountInput,
} from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { directConversationId, isoFromMs, ulid } from "../../src/core/util.js";
import { openTestDb } from "../helpers/db.js";

interface Harness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  policies: Policies;
  router: MeshRouter;
  limits: Limits;
  routed: Envelope[];
  routedEvents: Envelope[];
  droppedEvents: Array<{ envelope: Envelope; reason: string }>;
  degraded: Array<{ slot: string; reason: string }>;
}

function makeHarness(
  opts: { limits?: Partial<Limits>; sealKey?: string } = {},
): Harness {
  const tdb = openTestDb();
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  const policies: Policies = {
    ...createDefaultPolicies({
      isAwaiting: () => false,
      endpointsOf: () => [],
      limits,
    }),
    sessionFactory: {
      create: async () => ({ session: {}, piSessionId: "pi-test" }),
      open: async () => ({ session: {} }),
    },
  };
  const routed: Envelope[] = [];
  const routedEvents: Envelope[] = [];
  const droppedEvents: Array<{ envelope: Envelope; reason: string }> = [];
  const degraded: Array<{ slot: string; reason: string }> = [];
  events.on("message_routed", (p) => routedEvents.push(p.envelope));
  events.on("message_dropped", (p) =>
    droppedEvents.push({ envelope: p.envelope, reason: p.reason }),
  );
  events.on("policy_degraded", (p) =>
    degraded.push({ slot: p.slot, reason: p.reason }),
  );
  const router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits,
    devMode: true,
    onRouted: async (e) => {
      routed.push(e);
    },
    isAwaiting: () => false,
    sealKey: opts.sealKey,
  });
  return {
    db: tdb.db,
    store,
    registry,
    events,
    policies,
    router,
    limits,
    routed,
    routedEvents,
    droppedEvents,
    degraded,
  };
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
  override: Partial<RegisterAccountInput> = {},
): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ALL_KINDS,
    ...override,
  });
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
    text: "hello world",
    clientToken: ulid(),
    ...extra,
  };
}

function counter(h: Harness, name: string): number {
  const row = h.db
    .prepare<[string], { v: number }>(
      "SELECT COALESCE(SUM(value), 0) AS v FROM mesh_counters WHERE name = ?",
    )
    .get(name);
  return row?.v ?? 0;
}

function inboxRow(
  h: Harness,
  account: string,
  conv: string,
):
  | { pending_count: number; pending_bytes: number; verbatim_bytes: number }
  | undefined {
  return h.db
    .prepare<
      [string, string],
      { pending_count: number; pending_bytes: number; verbatim_bytes: number }
    >(
      "SELECT pending_count, pending_bytes, verbatim_bytes FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?",
    )
    .get(account, conv);
}

function deliveriesOf(
  h: Harness,
  messageId: string,
): Array<Record<string, unknown>> {
  return h.db
    .prepare<[string], Record<string, unknown>>(
      "SELECT * FROM mesh_deliveries WHERE message_id = ?",
    )
    .all(messageId);
}

async function group3(h: Harness): Promise<string> {
  await addAcc(h, "A");
  await addAcc(h, "B");
  await addAcc(h, "C");
  const conv = await h.registry.createConversation({
    type: "group",
    creator: "A",
    members: ["B", "C"],
  });
  return conv.id;
}

// ─── direct 顺利路径 ───────────────────────────────────────────────────────

describe("router: direct happy path", () => {
  it("routes with seq=1, one delivery row for the peer, inbox counters, events, counters", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));

    expect(r.seq).toBe(1);
    const m = h.db
      .prepare<[string], { id: string }>(
        "SELECT id FROM mesh_messages WHERE id = ?",
      )
      .get(r.messageId);
    expect(m?.id).toBe(r.messageId);

    // §6.1：发送方自己不产生 delivery —— direct 恰好 1 行（对端 B）
    const rows = deliveriesOf(h, r.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: "B",
      state: "routed",
      path: "P1",
    });

    // inbox：B 未读 +1；A 不算未读但计原文预算（§7.4）
    expect(inboxRow(h, "B", conv.id)?.pending_count).toBe(1);
    expect(inboxRow(h, "B", conv.id)?.pending_bytes).toBeGreaterThan(0);
    expect(inboxRow(h, "A", conv.id)?.pending_count).toBe(0);
    expect(inboxRow(h, "A", conv.id)?.verbatim_bytes).toBeGreaterThan(0);

    // 事件与 fanout 回调（提交后派发）
    expect(h.routed).toHaveLength(1);
    expect(h.routedEvents).toHaveLength(1);
    expect(h.routed[0]?.seq).toBe(1);

    expect(counter(h, "messages_total")).toBe(1);
    expect(counter(h, "deliveries_total")).toBe(1);
    h.store.close();
  });

  it("implicitly creates direct conversation on first send (§9.1/§9.2)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const convId = directConversationId("A", "B");
    const r = await h.router.route(msg("A", convId, { to: ["B"] }));
    expect(r.seq).toBe(1);
    expect(deliveriesOf(h, r.messageId)).toHaveLength(1);
    // 派生式 id 不是随意可伪造：错误 id + to 仍拒绝
    await expect(
      h.router.route(msg("A", "d:deadbeefdeadbeefdead", { to: ["B"] })),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    h.store.close();
  });

  it("seq is strictly monotonic within a conversation", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r1 = await h.router.route(msg("A", conv.id));
    const r2 = await h.router.route(msg("B", conv.id));
    const r3 = await h.router.route(msg("A", conv.id));
    expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 3]);
    h.store.close();
  });
});

// ─── 幂等（§5.5）──────────────────────────────────────────────────────────

describe("router: idempotency", () => {
  it("returns original result on clientToken replay and counts dedup_hit", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const token = "retry-token-1";
    const r1 = await h.router.route(msg("A", conv.id, { clientToken: token }));
    const r2 = await h.router.route(msg("A", conv.id, { clientToken: token }));
    expect(r2.messageId).toBe(r1.messageId);
    expect(r2.seq).toBe(r1.seq);
    expect(counter(h, "dedup_hit")).toBe(1);
    // 无写副作用：仍 1 行 delivery、1 条消息、fanout 不重复触发
    expect(deliveriesOf(h, r1.messageId)).toHaveLength(1);
    expect(counter(h, "messages_total")).toBe(1);
    expect(h.routed).toHaveLength(1);
    h.store.close();
  });

  it("idempotency key excludes seq: new token gets new seq, no UNIQUE collision", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r1 = await h.router.route(msg("A", conv.id, { clientToken: "t1" }));
    const r2 = await h.router.route(
      msg("A", conv.id, { clientToken: "t2", text: "second" }),
    );
    expect(r2.seq).toBe(r1.seq + 1);
    h.store.close();
  });
});

// ─── 准入校验（§5.4 ①②）──────────────────────────────────────────────────

describe("router: admission validation", () => {
  it("rejects non-member sender with NOT_A_MEMBER", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    await addAcc(h, "C");
    const conv = await h.registry.ensureDirect("A", "B");
    await expect(h.router.route(msg("C", conv.id))).rejects.toMatchObject({
      code: "NOT_A_MEMBER",
    });
    h.store.close();
  });

  it("rejects member without speak cap with NO_SPEAK_CAP", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.setCaps(conv.id, "B", ["read"]);
    await expect(h.router.route(msg("B", conv.id))).rejects.toMatchObject({
      code: "NO_SPEAK_CAP",
    });
    h.store.close();
  });

  it("read-only member receives a P3 delivery row (no speak)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.setCaps(conv.id, "B", ["read"]);
    const r = await h.router.route(msg("A", conv.id));
    const rows = deliveriesOf(h, r.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: "B", path: "P3" });
    h.store.close();
  });

  it("member without read cap gets no delivery row", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    h.registry.setCaps(conv.id, "B", ["speak"]);
    const r = await h.router.route(msg("A", conv.id));
    expect(deliveriesOf(h, r.messageId)).toHaveLength(0);
    expect(counter(h, "deliveries_total")).toBe(0);
    h.store.close();
  });

  it("rejects kind not in initiate set with CANNOT_INITIATE", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { initiate: [] });
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    await expect(h.router.route(msg("A", conv.id))).rejects.toMatchObject({
      code: "CANNOT_INITIATE",
    });
    h.store.close();
  });

  it("@system is exempt from membership and initiate checks (C16 seed)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const r = await h.router.route(
      msg("@system", conv.id, { kind: "system", text: "system notice" }),
    );
    expect(r.seq).toBe(1);
    // 全员（除 @system 自己——它本就不是成员）都收到
    const rows = deliveriesOf(h, r.messageId);
    expect(rows).toHaveLength(2);
    h.store.close();
  });

  it("rejects unknown conversation and archived conversation", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    await expect(h.router.route(msg("A", "nope"))).rejects.toMatchObject({
      code: "NOT_A_MEMBER",
    });
    const conv = await h.registry.ensureDirect("A", "B");
    h.registry.archiveConversation(conv.id);
    await expect(h.router.route(msg("A", conv.id))).rejects.toMatchObject({
      code: "NOT_A_MEMBER",
    });
    h.store.close();
  });
});

// ─── mentions 与 @all（§5.4③ §6.1）───────────────────────────────────────

describe("router: mentions and @all", () => {
  it("drops non-member mentions (spec: filter + warn, not reject)", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    await addAcc(h, "ghost");
    const r = await h.router.route(
      msg("A", convId, { mentions: ["B", "ghost"] }),
    );
    const m = h.db
      .prepare<[string], { mentions: string }>(
        "SELECT mentions FROM mesh_messages WHERE id = ?",
      )
      .get(r.messageId);
    expect(m?.mentions).toBe(JSON.stringify(["B"]));
    // ghost 无 delivery；B 因 mention 有行；C 因 to 空全成员有行
    const rows = deliveriesOf(h, r.messageId);
    const ids = rows
      .map((x) => x.account_id)
      .sort((a, b) => String(a).localeCompare(String(b)));
    expect(ids).toEqual(["B", "C"]);
    h.store.close();
  });

  it("@all expands delivery to all members and keeps the literal in mentions", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    const r = await h.router.route(msg("A", convId, { mentions: ["@all"] }));
    const rows = deliveriesOf(h, r.messageId);
    expect(rows).toHaveLength(2); // B、C
    const m = h.db
      .prepare<[string], { mentions: string }>(
        "SELECT mentions FROM mesh_messages WHERE id = ?",
      )
      .get(r.messageId);
    expect(m?.mentions).toBe(JSON.stringify(["@all"]));
    // @all 等价被点名：last_mentioned_seq 前移（§7.4 预算输入）
    const mem = h.registry.getMembership(convId, "B");
    expect(mem).toBeDefined();
    h.store.close();
  });

  it("@all cooldown rejects an immediate second @all (mentionAllCooldownMs)", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    await h.router.route(msg("A", convId, { mentions: ["@all"] }));
    await expect(
      h.router.route(msg("A", convId, { mentions: ["@all"], text: "again" })),
    ).rejects.toMatchObject({ code: "MENTION_ALL_THROTTLED" });
    h.store.close();
  });

  it("@all hourly cap rejects the 4th within the window when cooldown is disabled", async () => {
    const h = makeHarness({ limits: { mentionAllCooldownMs: 0 } });
    const convId = await group3(h);
    await h.router.route(
      msg("A", convId, { mentions: ["@all"], clientToken: "m1" }),
    );
    await h.router.route(
      msg("A", convId, { mentions: ["@all"], clientToken: "m2" }),
    );
    await h.router.route(
      msg("A", convId, { mentions: ["@all"], clientToken: "m3" }),
    );
    await expect(
      h.router.route(
        msg("A", convId, { mentions: ["@all"], clientToken: "m4" }),
      ),
    ).rejects.toMatchObject({ code: "MENTION_ALL_THROTTLED" });
    h.store.close();
  });
});

// ─── expect 与 pending_acks（§14）─────────────────────────────────────────

describe("router: expect and pending_acks", () => {
  it("expect:ack with multiple targets is rejected", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    await expect(
      h.router.route(msg("A", convId, { expect: "ack", to: ["B", "C"] })),
    ).rejects.toMatchObject({ code: "TARGETING_NOT_SUPPORTED" });
    h.store.close();
  });

  it("expect:ack to a single member registers an open pending_ack with ack deadline", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    const before = Date.now();
    const r = await h.router.route(
      msg("A", convId, { expect: "ack", to: ["B"] }),
    );
    expect(r.correlationId).toBeTruthy();
    const pa = h.db
      .prepare<
        [string],
        {
          state: string;
          expect: string;
          from_account: string;
          to_account: string;
          deadline: string;
        }
      >(
        "SELECT state, expect, from_account, to_account, deadline FROM mesh_pending_acks WHERE correlation_id = ?",
      )
      .get(r.correlationId ?? "");
    expect(pa).toMatchObject({
      state: "open",
      expect: "ack",
      from_account: "A",
      to_account: "B",
    });
    const slack = Date.parse(pa?.deadline ?? "") - before;
    expect(slack).toBeGreaterThanOrEqual(h.limits.ackTimeoutMs - 2000);
    expect(slack).toBeLessThanOrEqual(h.limits.ackTimeoutMs + 2000);
    h.store.close();
  });

  it("expect:reply uses replyTimeoutMs (5min) as deadline", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    const before = Date.now();
    const r = await h.router.route(
      msg("A", convId, { expect: "reply", to: ["B"] }),
    );
    const pa = h.db
      .prepare<[string], { deadline: string }>(
        "SELECT deadline FROM mesh_pending_acks WHERE correlation_id = ?",
      )
      .get(r.correlationId ?? "");
    const slack = Date.parse(pa?.deadline ?? "") - before;
    expect(slack).toBeGreaterThanOrEqual(h.limits.replyTimeoutMs - 2000);
    expect(slack).toBeLessThanOrEqual(h.limits.replyTimeoutMs + 2000);
    h.store.close();
  });

  it("expect target must be a member", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    await addAcc(h, "outsider");
    await expect(
      h.router.route(msg("A", convId, { expect: "ack", to: ["outsider"] })),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    h.store.close();
  });

  it("direct expect:ack with empty to resolves the unique peer", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id, { expect: "ack" }));
    expect(r.correlationId).toBeTruthy();
    const pa = h.db
      .prepare(
        "SELECT to_account FROM mesh_pending_acks WHERE correlation_id = ?",
      )
      .get(r.correlationId ?? "");
    expect(pa).toMatchObject({ to_account: "B" });
    h.store.close();
  });

  it("a valid reply is exempt from initiate, forces expect:none, and answers the pending_ack", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    h.registry.setCaps(convId, "B", ["read"]); // B 保留 read；下面改回 speak 以便发送
    h.registry.setCaps(convId, "B", ["speak", "read"]);
    await addAcc(h, "D", { initiate: [] }); // D 完全不能发起
    h.registry.addMember(convId, "D", ["speak", "read"]); // 但它是成员
    const req = await h.router.route(
      msg("A", convId, { expect: "ack", to: ["B"] }),
    );
    // D 不是应答方 → 仍受 initiate 限制
    await expect(
      h.router.route(
        msg("D", convId, {
          correlationId: req.correlationId,
          clientToken: "d1",
        }),
      ),
    ).rejects.toMatchObject({ code: "CANNOT_INITIATE" });
    // B 是应答方 → 豁免 initiate（B 的 initiate 置空再试）
    h.registry.registerAccount({
      id: "B2",
      displayName: "B2",
      endpointClass: "stream",
      initiate: [],
    }); // 注册不了同名；改用直接改 B 的账号行
    h.db
      .prepare("UPDATE mesh_accounts SET initiate = '[]' WHERE id = ?")
      .run("B");
    const reply = await h.router.route(
      msg("B", convId, {
        correlationId: req.correlationId,
        expect: "reply",
        clientToken: "b1",
      }),
    );
    const stored = h.db
      .prepare<[string], { expect: string }>(
        "SELECT expect FROM mesh_messages WHERE id = ?",
      )
      .get(reply.messageId);
    expect(stored?.expect).toBe("none"); // §14.1：应答的 expect 强制 none
    const pa = h.db
      .prepare<[string], { state: string }>(
        "SELECT state FROM mesh_pending_acks WHERE correlation_id = ?",
      )
      .get(req.correlationId ?? "");
    expect(pa?.state).toBe("answered");
    h.store.close();
  });

  it("unknown correlationId passthrough does not create or answer pending_acks", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    const r = await h.router.route(
      msg("A", convId, { correlationId: "loose-id" }),
    );
    expect(r.correlationId).toBe("loose-id");
    const n = h.db
      .prepare("SELECT COUNT(*) AS n FROM mesh_pending_acks")
      .get() as { n: number };
    expect(n.n).toBe(0);
    h.store.close();
  });
});

// ─── REQUEST_CYCLE（§14.5）────────────────────────────────────────────────

describe("router: request cycle detection", () => {
  it("rejects when a sync=1 open wait edge leads back to the requester", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    const seedMsg = await h.router.route(
      msg("A", convId, { expect: "ack", to: ["B"] }),
    );
    // 夹具：B 正阻塞等待 A（宿主 await 场景留下的 sync 边）
    h.db
      .prepare(
        "INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, " +
          "conversation_id, deadline, state, sync) VALUES (?,?,?,?,?,?,?,?,1)",
      )
      .run(
        "fx-cycle",
        seedMsg.messageId,
        "ack",
        "B",
        "A",
        convId,
        isoFromMs(Date.now() + 60_000),
        "open",
      );
    await expect(
      h.router.route(
        msg("A", convId, { expect: "ack", to: ["B"], clientToken: "cyc1" }),
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CYCLE" });
    h.store.close();
  });

  it("self-request (from === to) is a cycle", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    await expect(
      h.router.route(msg("A", convId, { expect: "ack", to: ["A"] })),
    ).rejects.toMatchObject({ code: "REQUEST_CYCLE" });
    h.store.close();
  });

  it("async (sync=0) edges never trigger the detector", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    const seedMsg = await h.router.route(
      msg("A", convId, { expect: "ack", to: ["B"] }),
    );
    // sync=0 的边不算数（§14.5 边界规则一）
    h.db
      .prepare(
        "INSERT INTO mesh_pending_acks (correlation_id, message_id, expect, from_account, to_account, " +
          "conversation_id, deadline, state, sync) VALUES (?,?,?,?,?,?,?,?,0)",
      )
      .run(
        "fx-async",
        seedMsg.messageId,
        "ack",
        "B",
        "A",
        convId,
        isoFromMs(Date.now() + 60_000),
        "open",
      );
    const r = await h.router.route(
      msg("A", convId, { expect: "ack", to: ["B"], clientToken: "ok1" }),
    );
    expect(r.seq).toBeGreaterThan(0);
    h.store.close();
  });
});

// ─── topic / queue 收窄（§16.6 §17.1）─────────────────────────────────────

describe("router: topic and queue narrowing", () => {
  it("topic publish stores the message with zero delivery rows", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const topic = await h.registry.createConversation({
      type: "topic",
      creator: "A",
    });
    h.registry.subscribe(topic.id, "B", 0);
    const r = await h.router.route(
      msg("A", topic.id, { kind: "event", text: "broadcast" }),
    );
    expect(r.seq).toBe(1);
    expect(deliveriesOf(h, r.messageId)).toHaveLength(0);
    expect(counter(h, "deliveries_total")).toBe(0);
    h.store.close();
  });

  it("topic rejects to and expect", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    const topic = await h.registry.createConversation({
      type: "topic",
      creator: "A",
    });
    await expect(
      h.router.route(msg("A", topic.id, { to: ["A"] })),
    ).rejects.toMatchObject({ code: "TARGETING_NOT_SUPPORTED" });
    await expect(
      h.router.route(msg("A", topic.id, { expect: "reply" })),
    ).rejects.toMatchObject({ code: "TARGETING_NOT_SUPPORTED" });
    h.store.close();
  });

  it("topic publish goes through canPublish (fail-closed)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    const topic = await h.registry.createConversation({
      type: "topic",
      creator: "A",
    });
    h.policies.accessControl = {
      ...h.policies.accessControl,
      canPublish: () => false,
    };
    await expect(h.router.route(msg("A", topic.id))).rejects.toMatchObject({
      code: "NOT_A_MEMBER",
    });
    h.store.close();
  });

  it("queue stores the message with expect forced to ack, no deliveries, no pending_acks", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const q = await h.registry.createConversation({
      type: "queue",
      creator: "A",
      members: ["B"],
    });
    const r = await h.router.route(
      msg("A", q.id, { kind: "task", text: "job" }),
    );
    const m = h.db
      .prepare<[string], { expect: string }>(
        "SELECT expect FROM mesh_messages WHERE id = ?",
      )
      .get(r.messageId);
    expect(m?.expect).toBe("ack");
    expect(deliveriesOf(h, r.messageId)).toHaveLength(0);
    const n = h.db
      .prepare("SELECT COUNT(*) AS n FROM mesh_pending_acks")
      .get() as { n: number };
    expect(n.n).toBe(0);
    // 显式 expect:"reply" 在 queue 上被拒绝（§17.6）；显式 "none" 同样被覆写为 ack
    await expect(
      h.router.route(
        msg("A", q.id, { kind: "task", expect: "reply", clientToken: "q2" }),
      ),
    ).rejects.toMatchObject({ code: "TARGETING_NOT_SUPPORTED" });
    const r3 = await h.router.route(
      msg("A", q.id, { kind: "task", expect: "none", clientToken: "q3" }),
    );
    const m3 = h.db
      .prepare<[string], { expect: string }>(
        "SELECT expect FROM mesh_messages WHERE id = ?",
      )
      .get(r3.messageId);
    expect(m3?.expect).toBe("ack");
    h.store.close();
  });
});

// ─── tombstone（§5.6）─────────────────────────────────────────────────────

describe("router: tombstone", () => {
  it("marks the original and drops its undelivered rows with TOMBSTONED", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    const orig = await h.router.route(msg("A", convId));
    const tomb = await h.router.route(
      msg("A", convId, {
        kind: "tombstone",
        replyTo: orig.messageId,
        text: "withdrawn",
      }),
    );
    const om = h.db
      .prepare<[string], { tombstoned_by: string }>(
        "SELECT tombstoned_by FROM mesh_messages WHERE id = ?",
      )
      .get(orig.messageId);
    expect(om?.tombstoned_by).toBe(tomb.messageId);
    const origRows = deliveriesOf(h, orig.messageId);
    expect(origRows).toHaveLength(2);
    for (const row of origRows)
      expect(row).toMatchObject({
        state: "dropped",
        drop_reason: "TOMBSTONED",
      });
    // tombstone 自身是正常消息：B、C 各一行
    expect(deliveriesOf(h, tomb.messageId)).toHaveLength(2);
    // 事件：原文每条被终止的投递一个 message_dropped
    expect(h.droppedEvents).toHaveLength(2);
    expect(h.droppedEvents[0]?.reason).toBe("TOMBSTONED");
    h.store.close();
  });

  it("tombstone requires replyTo within the same conversation", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const c1 = await h.registry.ensureDirect("A", "B");
    const c2 = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const orig = await h.router.route(msg("A", c1.id));
    await expect(
      h.router.route(
        msg("A", c2.id, { kind: "tombstone", replyTo: orig.messageId }),
      ),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await expect(
      h.router.route(msg("A", c1.id, { kind: "tombstone" })),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    h.store.close();
  });
});

// ─── 策略槽（§12.3）───────────────────────────────────────────────────────

describe("router: policy slots", () => {
  it("canSend deny rejects without any delivery (fail-closed)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    h.policies.accessControl = {
      ...h.policies.accessControl,
      canSend: () => false,
    };
    await expect(h.router.route(msg("A", conv.id))).rejects.toMatchObject({
      code: "NOT_A_MEMBER",
    });
    const n = h.db.prepare("SELECT COUNT(*) AS n FROM mesh_messages").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
    h.store.close();
  });

  it("canSend throwing degrades to deny with policy_degraded event + counter", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    h.policies.accessControl = {
      ...h.policies.accessControl,
      canSend: () => {
        throw new Error("policy boom");
      },
    };
    await expect(h.router.route(msg("A", conv.id))).rejects.toMatchObject({
      code: "NOT_A_MEMBER",
    });
    expect(
      h.degraded.some(
        (x) => x.slot === "accessControl" && x.reason === "threw",
      ),
    ).toBe(true);
    expect(counter(h, "policy_degraded")).toBeGreaterThanOrEqual(1);
    h.store.close();
  });

  it("floor denying the sender rejects with NO_FLOOR", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    h.policies.floor = { grantFloor: () => ["B"] };
    await expect(h.router.route(msg("A", convId))).rejects.toMatchObject({
      code: "NO_FLOOR",
    });
    h.store.close();
  });

  it("floor throwing degrades to free_for_all (message still routes)", async () => {
    const h = makeHarness();
    const convId = await group3(h);
    h.policies.floor = {
      grantFloor: () => {
        throw new Error("floor boom");
      },
    };
    const r = await h.router.route(msg("A", convId));
    expect(r.seq).toBe(1);
    expect(
      h.degraded.some((x) => x.slot === "floor" && x.reason === "threw"),
    ).toBe(true);
    h.store.close();
  });
});

// ─── 扇出防护（§7.8）──────────────────────────────────────────────────────

describe("router: fanout guards", () => {
  it("group over groupSizeHardCap rejects with FANOUT_TOO_LARGE", async () => {
    const h = makeHarness({
      limits: { groupSizeHardCap: 5, groupSizeWarn: 3 },
    });
    const ids = ["A", "B", "C", "D", "E", "F"];
    for (const id of ids) await addAcc(h, id);
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    for (const id of ids.slice(2))
      h.registry.addMember(conv.id, id, ["speak", "read"]);
    await expect(h.router.route(msg("A", conv.id))).rejects.toMatchObject({
      code: "FANOUT_TOO_LARGE",
    });
    h.store.close();
  });

  it("group over groupSizeWarn routes but counts fanout_warn", async () => {
    const h = makeHarness({
      limits: { groupSizeHardCap: 5, groupSizeWarn: 3 },
    });
    const ids = ["A", "B", "C", "D"];
    for (const id of ids) await addAcc(h, id);
    const conv = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B", "C", "D"],
    });
    const r = await h.router.route(msg("A", conv.id));
    expect(r.seq).toBe(1);
    expect(counter(h, "fanout_warn")).toBe(1);
    expect(deliveriesOf(h, r.messageId)).toHaveLength(3);
    h.store.close();
  });
});

// ─── FTS / seal / 计数器口径 ──────────────────────────────────────────────

describe("router: fts, seal, counters", () => {
  it("indexes message text into mesh_messages_fts (trigram)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    await h.router.route(
      msg("A", conv.id, { text: "xyzzyplugh unique needle" }),
    );
    const hit = h.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM mesh_messages_fts WHERE mesh_messages_fts MATCH ?",
      )
      .get('"xyzzyplugh"');
    expect(hit?.n).toBe(1);
    const miss = h.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM mesh_messages_fts WHERE mesh_messages_fts MATCH ?",
      )
      .get('"qqqzzz"');
    expect(miss?.n).toBe(0);
    h.store.close();
  });

  it("computes HMAC seal over the message when sealKey is provided; absent otherwise", async () => {
    const h = makeHarness({ sealKey: "host-secret" });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    const m = h.db
      .prepare<[string], { seal: string | null }>(
        "SELECT seal FROM mesh_messages WHERE id = ?",
      )
      .get(r.messageId);
    expect(m?.seal).toMatch(/^[0-9a-f]{64}$/);
    expect(h.routed[0]?.seal).toBe(m?.seal);
    h.store.close();

    const h2 = makeHarness();
    await addAcc(h2, "A");
    await addAcc(h2, "B");
    const conv2 = await h2.registry.ensureDirect("A", "B");
    const r2 = await h2.router.route(msg("A", conv2.id));
    const m2 = h2.db
      .prepare<[string], { seal: string | null }>(
        "SELECT seal FROM mesh_messages WHERE id = ?",
      )
      .get(r2.messageId);
    expect(m2?.seal).toBeNull();
    h2.store.close();
  });
});
