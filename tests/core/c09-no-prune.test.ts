// ═══════════════════════════════════════════════════════════════════════════
// C09：无物理修剪（软删/tombstone）+ topic 不自投。
// - group dissolve（archive）后会话行与消息行留存，无 DELETE
// - topic 退订是软删（subscription 行留存，listSubscribers 排除）
// - topic 发送方无自身 P3 投递行（投递集 = 订阅者集）
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
import { ulid } from "../../src/core/util.js";
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

async function addAcc(h: Harness, id: string): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ALL_KINDS,
  });
}

function msg(from: string, conversationId: string, extra: Partial<RouteInput> = {}): RouteInput {
  return {
    from,
    conversationId,
    kind: "chat",
    expect: "none",
    text: "hello",
    clientToken: ulid(),
    ...extra,
  };
}

describe("C09: no physical pruning", () => {
  it("group dissolve archives the conversation and keeps its messages", async () => {
    const h = makeHarness();
    await addAcc(h, "A");
    await addAcc(h, "B");
    const g = await h.registry.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    await h.router.route(msg("A", g.id));

    // groupDissolve 的数据路径：archiveConversation（soft delete，不 DELETE）
    h.registry.archiveConversation(g.id);

    const convRow = h.db
      .prepare<[string], { archived_at: string | null }>(
        "SELECT archived_at FROM mesh_conversations WHERE id = ?",
      )
      .get(g.id);
    expect(convRow?.archived_at).toBeTruthy(); // 留存且已归档
    const msgCount = h.db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM mesh_messages WHERE conversation_id = ?")
      .get(g.id) as { n: number };
    expect(msgCount.n).toBe(1); // 消息仍在（无物理删除）
    h.store.close();
  });

  it("topic unsubscribe is a soft delete (row persists, listSubscribers excludes)", async () => {
    const h = makeHarness();
    await addAcc(h, "P");
    await addAcc(h, "B");
    const topic = await h.registry.createConversation({ type: "topic", creator: "P" });
    h.registry.subscribe(topic.id, "B", 1);
    expect(h.registry.listSubscribers(topic.id)).toHaveLength(1);

    h.registry.unsubscribe(topic.id, "B");

    // 行仍留存（软删），但已不再视为订阅者
    const subRow = h.db
      .prepare<[string, string], { unsubscribed_at: string | null }>(
        "SELECT unsubscribed_at FROM mesh_subscriptions WHERE conversation_id = ? AND account_id = ?",
      )
      .get(topic.id, "B");
    expect(subRow?.unsubscribed_at).toBeTruthy();
    expect(h.registry.listSubscribers(topic.id)).toHaveLength(0);
    h.store.close();
  });

  it("topic sender gets no self P3 delivery row", async () => {
    const h = makeHarness();
    await addAcc(h, "P");
    await addAcc(h, "B");
    const topic = await h.registry.createConversation({ type: "topic", creator: "P" });
    h.registry.subscribe(topic.id, "B", 1); // B 订阅；P 未订阅

    const r = await h.router.route(msg("P", topic.id, { kind: "event" }));

    const rows = h.db
      .prepare<[string], { account_id: string; path: string }>(
        "SELECT d.account_id, d.path FROM mesh_deliveries d WHERE d.message_id = ?",
      )
      .all(r.messageId);
    // 投递集 = 订阅者集：只有 B，P 无自投行
    expect(rows.map((x) => x.account_id).sort()).toEqual(["B"]);
    expect(rows.every((x) => x.path === "P3")).toBe(true);
    h.store.close();
  });
});