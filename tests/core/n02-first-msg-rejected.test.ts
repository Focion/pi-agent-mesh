// ═══════════════════════════════════════════════════════════════════════════
// N02：首聊被拒不留会话（§9.1/§9.2）。
// - canInitiateDirect 闸 fail-closed（拒绝/undefined → CANNOT_INITIATE，零落库）
// - initiate 集不含 kind → CANNOT_INITIATE，隐式 direct 空会话被回滚
// - canSend 拒绝首聊 → 空会话被回滚（无 conversation/membership/inbox 残留）
// - 钩子缺失 → 放行
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshEventBus } from "../../src/core/events.js";
import { createDefaultPolicies } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { MeshRouter } from "../../src/core/router.js";
import { SqliteStore } from "../../src/core/store.js";
import type { RouteInput } from "../../src/core/contracts.js";
import type { Limits, Policies, RegisterAccountInput } from "../../src/core/types.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { directConversationId, ulid } from "../../src/core/util.js";
import { openTestDb } from "../helpers/db.js";

interface Harness {
  db: Database.Database;
  store: SqliteStore;
  registry: MeshRegistry;
  events: MeshEventBus;
  policies: Policies;
  router: MeshRouter;
  limits: Limits;
}

function makeHarness(opts: { limits?: Partial<Limits> } = {}): Harness {
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
  const router = new MeshRouter({
    store,
    registry,
    events,
    policies,
    limits,
    devMode: true,
    onRouted: async () => {},
    isAwaiting: () => false,
  });
  return { db: tdb.db, store, registry, events, policies, router, limits };
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

/** 会话/成员/inbox 三表残留计数（N02：被拒首聊必须三处全 0） */
function residue(h: Harness, convId: string): { conv: number; members: number; inboxes: number } {
  const conv = h.db
    .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM mesh_conversations WHERE id = ?")
    .get(convId) as { n: number };
  const members = h.db
    .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM mesh_memberships WHERE conversation_id = ?")
    .get(convId) as { n: number };
  const inboxes = h.db
    .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM mesh_inboxes WHERE conversation_id = ?")
    .get(convId) as { n: number };
  return { conv: conv.n, members: members.n, inboxes: inboxes.n };
}

describe("N02: first message rejected leaves no conversation", () => {
  it("canInitiateDirect:false rejects the first message with zero residue", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    h.policies.accessControl = {
      ...h.policies.accessControl,
      canInitiateDirect: () => false,
    };
    const convId = directConversationId("A", "B");
    await expect(
      h.router.route(msg("A", convId, { to: ["B"] })),
    ).rejects.toMatchObject({ code: "CANNOT_INITIATE" });
    expect(residue(h, convId)).toEqual({ conv: 0, members: 0, inboxes: 0 });
    h.store.close();
  });

  it("canInitiateDirect returning undefined is fail-closed deny (zero residue)", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    h.policies.accessControl = {
      ...h.policies.accessControl,
      canInitiateDirect: () => undefined as never,
    };
    const convId = directConversationId("A", "B");
    await expect(
      h.router.route(msg("A", convId, { to: ["B"] })),
    ).rejects.toMatchObject({ code: "CANNOT_INITIATE" });
    expect(residue(h, convId)).toEqual({ conv: 0, members: 0, inboxes: 0 });
    h.store.close();
  });

  it("kind not in initiate set → CANNOT_INITIATE and empty direct rolled back", async () => {
    const h = makeHarness();
    await addAcc(h, "A", { initiate: [] }); // A 无任何 initiate 权利
    await addAcc(h, "B");
    const convId = directConversationId("A", "B");
    await expect(
      h.router.route(msg("A", convId, { to: ["B"] })),
    ).rejects.toMatchObject({ code: "CANNOT_INITIATE" });
    expect(residue(h, convId)).toEqual({ conv: 0, members: 0, inboxes: 0 });
    h.store.close();
  });

  it("canSend:false on the first message rolls back the implicit empty direct", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    h.policies.accessControl = {
      ...h.policies.accessControl,
      canSend: () => false,
    };
    const convId = directConversationId("A", "B");
    await expect(
      h.router.route(msg("A", convId, { to: ["B"] })),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(residue(h, convId)).toEqual({ conv: 0, members: 0, inboxes: 0 });
    h.store.close();
  });

  it("missing canInitiateDirect hook (default allow) still creates the direct", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    // 删除默认钩子，模拟「钩子缺失 → 放行」
    h.policies.accessControl = {
      ...h.policies.accessControl,
      canInitiateDirect: undefined,
    };
    const convId = directConversationId("A", "B");
    const r = await h.router.route(msg("A", convId, { to: ["B"] }));
    expect(r.seq).toBe(1);
    expect(residue(h, convId).conv).toBe(1);
    h.store.close();
  });
});