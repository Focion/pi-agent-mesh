// ═══════════════════════════════════════════════════════════════════════════
// 九槽策略矩阵（C03 / I21）：withPolicyTimeout / withPolicyGuard 的正常/抛错/
// 非法/超时四象限 + 逐槽 degradedTo 与 policy_degraded(slot/reason/degradedTo)
// + 计数器自增。sessionFactory 是第九槽——它不用 withPolicyTimeout，走自有秒级
// deadline，其 timeout/threw → NO_SESSION + unrecoverable 见
// tests/pi/session-warm-deadline.test.ts（此处不重复）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshEventBus } from "../../src/core/events.js";
import { MeshMailbox } from "../../src/core/mailbox.js";
import {
  createDefaultPolicies,
  guardClock,
  withPolicyGuard,
  withPolicyTimeout,
} from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { MeshRouter } from "../../src/core/router.js";
import { SharedSpace } from "../../src/core/shared.js";
import { SqliteStore } from "../../src/core/store.js";
import { InProcessTransport } from "../../src/core/transport.js";
import type { AccessControl, Endpoint, Limits, Policies } from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import type { RouteInput } from "../../src/core/contracts.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

type DegradedEvent = { slot: string; reason: string; degradedTo: string };

// ─── 机制：withPolicyTimeout / withPolicyGuard 四象限 ──────────────────────

describe("withPolicyTimeout / withPolicyGuard（C03 机制）", () => {
  function deps(ev: DegradedEvent[], degradedTo: string) {
    return {
      slot: "delivery" as const,
      timeoutMs: 20,
      degradedTo: degradedTo as never,
      onDegraded: (reason: string, slot: string, d: string) =>
        ev.push({ slot, reason, degradedTo: d }),
    };
  }

  it("正常值原样返回，零降级", async () => {
    const ev: DegradedEvent[] = [];
    expect(await withPolicyTimeout(deps(ev, "x"), () => "ok", "fb")).toBe("ok");
    expect(withPolicyGuard(deps(ev, "x"), () => 7, 0)).toBe(7);
    expect(ev).toHaveLength(0);
  });

  it("抛错 → fallback + reason:threw", async () => {
    const ev: DegradedEvent[] = [];
    expect(
      await withPolicyTimeout(deps(ev, "d"), () => {
        throw new Error("boom");
      }, "fb"),
    ).toBe("fb");
    expect(ev[0]).toMatchObject({ reason: "threw" });
    const ev2: DegradedEvent[] = [];
    expect(
      withPolicyGuard(deps(ev2, "d"), () => {
        throw new Error("boom");
      }, "fb"),
    ).toBe("fb");
    expect(ev2[0]).toMatchObject({ reason: "threw" });
  });

  it("非法返回值（isValid 判假）→ fallback + reason:illegal", async () => {
    const ev: DegradedEvent[] = [];
    expect(
      await withPolicyTimeout(deps(ev, "d"), () => "bad", "fb", (v) => typeof v === "number"),
    ).toBe("fb");
    expect(ev[0]).toMatchObject({ reason: "illegal" });
  });

  it("异步超时 → fallback + reason:timeout（Promise.race）", async () => {
    const ev: DegradedEvent[] = [];
    const slow = () => new Promise<string>((r) => setTimeout(() => r("late"), 60));
    expect(await withPolicyTimeout({ ...deps(ev, "d"), timeoutMs: 5 }, slow, "fb")).toBe("fb");
    expect(ev[0]).toMatchObject({ reason: "timeout" });
  });

  it("!isValid 为 undefined 时不校验返回值（null 合法值不误伤）", async () => {
    const ev: DegradedEvent[] = [];
    expect(await withPolicyTimeout(deps(ev, "d"), () => null, "fb")).toBeNull();
    expect(ev).toHaveLength(0);
  });
});

// ─── 装配 ──────────────────────────────────────────────────────────────────

function defaultPolicies(store: SqliteStore, registry: MeshRegistry): Policies {
  const limits: Limits = DEFAULT_LIMITS;
  return {
    ...createDefaultPolicies({
      isAwaiting: () => false,
      endpointsOf: (acct: string) =>
        registry.endpointsOf(acct).map((e) => ({ id: e.id, inFlight: 0, topology: e.topology })),
      limits,
    }),
    sessionFactory: {
      create: async () => ({ session: {}, piSessionId: "pi-test" }),
      open: async () => ({ session: {} }),
    },
  };
}

interface MbHarness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  port: FakeStreamPort;
  mailbox: MeshMailbox;
  router: MeshRouter;
  degraded: DegradedEvent[];
}

function makeMailbox(override: Partial<Policies>): MbHarness {
  const tdb = openTestDb();
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
  const events = new MeshEventBus();
  const port = new FakeStreamPort();
  const policies: Policies = { ...defaultPolicies(store, registry), ...override };
  const mailbox = new MeshMailbox({
    store,
    registry,
    events,
    policies,
    limits: DEFAULT_LIMITS,
    transport: new InProcessTransport(),
    port,
    sinkHandlers: new Map(),
    awaitingCorrelations: () => [],
    devMode: true,
  });
  port.onEntry((e) => mailbox.handleEntryAppended(e));
  port.onTurnEnd((e) => mailbox.handleTurnEnd(e.endpointId));
  const router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits: DEFAULT_LIMITS,
    devMode: true,
    onRouted: async (e) => {
      await mailbox.fanout(e);
    },
    isAwaiting: () => false,
  });
  const degraded: DegradedEvent[] = [];
  events.on("policy_degraded", (p) =>
    degraded.push({ slot: p.slot, reason: p.reason, degradedTo: p.degradedTo }),
  );
  return { db: tdb.db, store, registry, events, port, mailbox, router, degraded };
}

interface RtHarness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  router: MeshRouter;
  degraded: DegradedEvent[];
  routed: { count: number };
}

function makeRouter(override: Partial<Policies>): RtHarness {
  const tdb = openTestDb();
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
  const events = new MeshEventBus();
  const policies: Policies = { ...defaultPolicies(store, registry), ...override };
  const routed = { count: 0 };
  const router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits: DEFAULT_LIMITS,
    devMode: true,
    onRouted: async () => {
      routed.count++;
    },
    isAwaiting: () => false,
  });
  const degraded: DegradedEvent[] = [];
  events.on("policy_degraded", (p) =>
    degraded.push({ slot: p.slot, reason: p.reason, degradedTo: p.degradedTo }),
  );
  return { db: tdb.db, store, registry, events, router, degraded, routed };
}

async function addAcc(h: { registry: MeshRegistry }, id: string): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat", "task"],
  });
}

async function addHotEndpoint(h: MbHarness, id: string): Promise<Endpoint> {
  const ep = await h.registry.registerEndpoint({
    accountId: id,
    topology: { kind: "unified" },
    piSessionId: "pi-" + id,
  });
  h.registry.updateEndpointState(ep.id, "hot");
  return ep;
}

function msg(from: string, convId: string, extra: Partial<RouteInput> = {}): RouteInput {
  return {
    from,
    conversationId: convId,
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

function counter(db: Database.Database, name: string): number {
  const row = db
    .prepare<[string], { v: number }>("SELECT COALESCE(SUM(value),0) AS v FROM mesh_counters WHERE name = ?")
    .get(name);
  return row?.v ?? 0;
}

function deliveryRow(
  db: Database.Database,
  messageId: string,
  acct: string,
): { state: string; grade: string | null; path: string | null; woke: number; parked_reason: string | null } {
  return db
    .prepare<[string, string], { state: string; grade: string | null; path: string | null; woke: number; parked_reason: string | null }>(
      "SELECT state, grade, path, woke, parked_reason FROM mesh_deliveries WHERE message_id = ? AND account_id = ?",
    )
    .get(messageId, acct)!;
}

// ─── ① delivery → silent_no_wake ─────────────────────────────────────────

describe("slot: delivery（degradedTo=silent_no_wake）", () => {
  it("grade 抛错 → silent 且不唤醒，reason:threw", async () => {
    const h = makeMailbox({
      delivery: { grade: () => { throw new Error("boom"); } },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    expect(deliveryRow(h.db, r.messageId, "B").grade).toBe("silent");
    expect(h.degraded).toContainEqual({ slot: "delivery", reason: "threw", degradedTo: "silent_no_wake" });
    expect(counter(h.db, "policy_degraded")).toBeGreaterThanOrEqual(1);
    h.store.close();
  });

  it("grade 返回非法档位 → silent，reason:illegal", async () => {
    const h = makeMailbox({
      delivery: { grade: () => "bogus" as never },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    expect(deliveryRow(h.db, r.messageId, "B").grade).toBe("silent");
    expect(h.degraded).toContainEqual({ slot: "delivery", reason: "illegal", degradedTo: "silent_no_wake" });
    h.store.close();
  });
});

// ─── ② activation → silent_no_wake ───────────────────────────────────────

describe("slot: activation（degradedTo=silent_no_wake）", () => {
  it("shouldWake 抛错 → 不唤醒（woke=0），reason:threw（group，member spoke）", async () => {
    const h = makeMailbox({
      activation: { shouldWake: () => { throw new Error("boom"); } },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    h.registry.recordSpoke(conv.id, "B", 1);
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { to: ["B"], expect: "reply" }));
    await flush();
    expect(deliveryRow(h.db, r.messageId, "B").woke).toBe(0);
    expect(h.degraded).toContainEqual({ slot: "activation", reason: "threw", degradedTo: "silent_no_wake" });
    h.store.close();
  });

  it("shouldWake 返回非法值 → 不唤醒，reason:illegal", async () => {
    const h = makeMailbox({
      activation: { shouldWake: () => "yes" as never },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    h.registry.recordSpoke(conv.id, "B", 1);
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { to: ["B"], expect: "reply" }));
    await flush();
    expect(deliveryRow(h.db, r.messageId, "B").woke).toBe(0);
    expect(h.degraded).toContainEqual({ slot: "activation", reason: "illegal", degradedTo: "silent_no_wake" });
    h.store.close();
  });
});

// ─── ⑧ endpointSelector → parked（ENDPOINT_GONE）─────────────────────────

describe("slot: endpointSelector（degradedTo=parked）", () => {
  it("select 抛错 → parked(ENDPOINT_GONE)，reason:threw", async () => {
    const h = makeMailbox({
      endpointSelector: { select: () => { throw new Error("boom"); } },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    await addHotEndpoint(h, "B"); // 有端点，但 selector 炸了
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    expect(deliveryRow(h.db, r.messageId, "B")).toMatchObject({ state: "parked", parked_reason: "ENDPOINT_GONE" });
    expect(h.degraded).toContainEqual({ slot: "endpointSelector", reason: "threw", degradedTo: "parked" });
    h.store.close();
  });

  it("select 返回非法值（数字）→ parked，reason:illegal", async () => {
    const h = makeMailbox({
      endpointSelector: { select: () => 42 as never },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    expect(deliveryRow(h.db, r.messageId, "B")).toMatchObject({ state: "parked", parked_reason: "ENDPOINT_GONE" });
    expect(h.degraded).toContainEqual({ slot: "endpointSelector", reason: "illegal", degradedTo: "parked" });
    h.store.close();
  });
});

// ─── ④ renderer → builtin_renderer ───────────────────────────────────────

describe("slot: renderer（degradedTo=builtin_renderer）", () => {
  it("renderMessage 返回非字符串 → 内建渲染器（仍 M4 包裹），reason:illegal", async () => {
    const h = makeMailbox({
      renderer: {
        renderMessage: () => 123 as never,
        renderInbox: () => "",
        renderSystem: () => "",
      },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    await addHotEndpoint(h, "B");
    const conv = await h.registry.ensureDirect("A", "B");
    const r = await h.router.route(msg("A", conv.id));
    await flush();
    expect(deliveryRow(h.db, r.messageId, "B").state).toBe("consumed"); // 降级未阻断
    const rendered = h.port.delivered.find((d) => d.envelope.id === r.messageId)?.rendered;
    expect(rendered).toContain("<<<MSG");
    expect(rendered).toContain("<<<END MSG>>>");
    expect(h.degraded).toContainEqual({ slot: "renderer", reason: "illegal", degradedTo: "builtin_renderer" });
    h.store.close();
  });
});

// ─── ⑦ retention → cursor_only（fail-closed：不加原文）────────────────────

describe("slot: retention（degradedTo=cursor_only）", () => {
  it("verbatimBudget 返回非法 → {bytes:0,ttlSeq:-1} → 超预算 P2，reason:illegal", async () => {
    const h = makeMailbox({
      retention: { verbatimBudget: () => ({ bytes: "x" }) as never },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    h.registry.recordSpoke(conv.id, "B", 1);
    await addHotEndpoint(h, "B");
    const r = await h.router.route(msg("A", conv.id, { to: ["B"] }));
    await flush();
    expect(deliveryRow(h.db, r.messageId, "B")).toMatchObject({ state: "queued", path: "P2" });
    expect(h.degraded).toContainEqual({ slot: "retention", reason: "illegal", degradedTo: "cursor_only" });
    h.store.close();
  });
});

// ─── ⑤ clock → wallclock ─────────────────────────────────────────────────

describe("slot: clock（degradedTo=wallclock）", () => {
  it("compare 抛错 → 墙钟 + reason:threw", () => {
    const ev: DegradedEvent[] = [];
    const g = guardClock(
      {
        slot: "clock",
        timeoutMs: 50,
        degradedTo: "wallclock",
        onDegraded: (reason, slot, d) => ev.push({ slot, reason, degradedTo: d }),
      },
      {
        compare: () => {
          throw new Error("boom");
        },
      },
    );
    expect(g.compare("b", "a")).toBe(1);
    expect(ev).toContainEqual({ slot: "clock", reason: "threw", degradedTo: "wallclock" });
  });
});

// ─── ⑥ accessControl → deny（fail-closed，undefined 当 deny）──────────────

describe("slot: accessControl（degradedTo=deny）", () => {
  it("canSend 返回 undefined → deny（NOT_A_MEMBER）+ reason:illegal", async () => {
    const h = makeRouter({
      accessControl: { canSend: () => undefined as never },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    await expect(h.router.route(msg("A", conv.id))).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(h.degraded).toContainEqual({ slot: "accessControl", reason: "illegal", degradedTo: "deny" });
    expect(h.routed.count).toBe(0);
    h.store.close();
  });

  it("钩子缺失（无 canSend）→ 放行，路由成功，零降级", async () => {
    const h = makeRouter({ accessControl: {} as AccessControl });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    await h.router.route(msg("A", conv.id));
    expect(h.routed.count).toBe(1);
    expect(h.degraded).toHaveLength(0);
    h.store.close();
  });
});

// ─── ③ floor → free_for_all ──────────────────────────────────────────────

describe("slot: floor（degradedTo=free_for_all）", () => {
  it("grantFloor 抛错 → free_for_all（发送者仍获 floor），reason:threw", async () => {
    const h = makeRouter({
      floor: { grantFloor: () => { throw new Error("boom"); } },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const r = await h.router.route(msg("A", conv.id));
    expect(r.messageId).toBeTruthy();
    expect(h.degraded).toContainEqual({ slot: "floor", reason: "threw", degradedTo: "free_for_all" });
    h.store.close();
  });

  it("grantFloor 返回非数组 → free_for_all，reason:illegal", async () => {
    const h = makeRouter({
      floor: { grantFloor: () => "nope" as never },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const conv = await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] });
    const r = await h.router.route(msg("A", conv.id));
    expect(r.messageId).toBeTruthy();
    expect(h.degraded).toContainEqual({ slot: "floor", reason: "illegal", degradedTo: "free_for_all" });
    h.store.close();
  });
});

// ─── ⑥b accessControl.resolveCustomTag（shared，deny + 计数器）────────────

interface ShHarness {
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  shared: SharedSpace;
  degraded: DegradedEvent[];
  db: Database.Database;
}

function makeShared(accessControl: AccessControl): ShHarness {
  const tdb = openTestDb();
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
  const events = new MeshEventBus();
  const shared = new SharedSpace({
    db: store.db,
    registry,
    events,
    accessControl,
    limits: DEFAULT_LIMITS,
    store,
  });
  const degraded: DegradedEvent[] = [];
  events.on("policy_degraded", (p) =>
    degraded.push({ slot: p.slot, reason: p.reason, degradedTo: p.degradedTo }),
  );
  return { store, registry, events, shared, degraded, db: tdb.db };
}

const CUSTOM_TAG = { kind: "custom", tag: "secret" } as const;

describe("slot: accessControl.resolveCustomTag（shared，deny）", () => {
  it("钩子抛错 → deny（SPACE_FORBIDDEN），reason:threw，计数器自增", async () => {
    const h = makeShared({
      resolveCustomTag: () => {
        throw new Error("boom");
      },
    });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const space = "conv:" + (await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] })).id;
    await h.shared.put(space, "k", "x", {
      as: "A",
      acl: { read: [CUSTOM_TAG], write: [{ kind: "accounts", accounts: ["A"] }], admin: [{ kind: "accounts", accounts: ["A"] }] },
    });
    await expect(h.shared.get(space, "k", "B")).rejects.toMatchObject({ code: "SPACE_FORBIDDEN" });
    expect(h.degraded).toContainEqual({ slot: "accessControl", reason: "threw", degradedTo: "deny" });
    expect(counter(h.db, "policy_degraded")).toBeGreaterThanOrEqual(1);
    h.store.close();
  });

  it("钩子返回 undefined → deny + reason:illegal（§22.5 fail-closed）", async () => {
    const h = makeShared({ resolveCustomTag: () => undefined as never });
    await addAcc(h, "A");
    await addAcc(h, "B");
    const space = "conv:" + (await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] })).id;
    await h.shared.put(space, "k", "x", {
      as: "A",
      acl: { read: [CUSTOM_TAG], write: [{ kind: "accounts", accounts: ["A"] }], admin: [{ kind: "accounts", accounts: ["A"] }] },
    });
    await expect(h.shared.get(space, "k", "B")).rejects.toMatchObject({ code: "SPACE_FORBIDDEN" });
    expect(h.degraded).toContainEqual({ slot: "accessControl", reason: "illegal", degradedTo: "deny" });
    h.store.close();
  });

  it("钩子缺失 → deny（§18.6 custom 无人判定即拒绝），零降级", async () => {
    const h = makeShared({} as AccessControl);
    await addAcc(h, "A");
    await addAcc(h, "B");
    const space = "conv:" + (await h.registry.createConversation({ type: "group", creator: "A", members: ["B"] })).id;
    await h.shared.put(space, "k", "x", {
      as: "A",
      acl: { read: [CUSTOM_TAG], write: [{ kind: "accounts", accounts: ["A"] }], admin: [{ kind: "accounts", accounts: ["A"] }] },
    });
    await expect(h.shared.get(space, "k", "B")).rejects.toMatchObject({ code: "SPACE_FORBIDDEN" });
    expect(h.degraded).toHaveLength(0);
    h.store.close();
  });
});