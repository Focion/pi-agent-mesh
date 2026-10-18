// ═══════════════════════════════════════════════════════════════════════════
// W09 · I11 + C06 · 请求应答（§14）。
//
// 保护的设计决定（Router/Mailbox 层契约，直读 DB 断言）：
// - §14.1/§14.4：复信（ack 入口与 ordinary correlation send 一致）定向回发起方，
//   `to_accounts=[发起方]`、投递集只有发起方一行，不按「全体成员减发送方」广播；
// - §14.4：超时后到达的复信 `late=1`，只定向回发起方，不回退 pending 终态
//   （state 仍 timeout、answered_by_message 仍 NULL），ack_of 仍指向原请求；
// - §14.3：非 queue 的 `expect:"ack"` 请求首次投递时绑定 endpoint_id + 取得目标
//   端点 exclusive 租约，concurrent 到达 park(LEASE_HELD)；timeout 释放 exclusive
//   并解 park（release 恢复，非终止）。
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
import type { Limits, Policies } from "../../src/core/types.js";
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
}

function makeHarness(opts: { limits?: Partial<Limits> } = {}): Harness {
  const tdb = openTestDb();
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const store = new SqliteStore(tdb.db, true);
  const registry = new MeshRegistry(store.db, limits);
  const events = new MeshEventBus();
  const port = new FakeStreamPort();
  const policies: Policies = {
    ...createDefaultPolicies({
      isAwaiting: () => false,
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
  const mailbox = new MeshMailbox({
    store,
    registry,
    events,
    policies,
    limits,
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
    limits,
    devMode: true,
    onRouted: async (e) => {
      await mailbox.fanout(e);
    },
    isAwaiting: () => false,
  });
  return { db: tdb.db, store, registry, events, port, mailbox, router };
}

async function addAcc(h: Harness, id: string): Promise<void> {
  await h.registry.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat", "task", "event", "system", "tombstone"],
  });
}

async function addHotEndpoint(h: Harness, id: string): Promise<string> {
  const ep = await h.registry.registerEndpoint({
    accountId: id,
    topology: { kind: "unified" },
    piSessionId: "pi-" + id,
  });
  h.registry.updateEndpointState(ep.id, "hot");
  return ep.id;
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

function pendingRow(h: Harness, correlationId: string) {
  return h.db
    .prepare<
      [string],
      {
        state: string;
        endpoint_id: string | null;
        answered_by_message: string | null;
        message_id: string;
      }
    >(
      "SELECT state, endpoint_id, answered_by_message, message_id FROM mesh_pending_acks WHERE correlation_id = ?",
    )
    .get(correlationId) as
    | {
        state: string;
        endpoint_id: string | null;
        answered_by_message: string | null;
        message_id: string;
      }
    | undefined;
}

function openCorrelation(h: Harness): string {
  const row = h.db
    .prepare<[], { correlation_id: string }>(
      "SELECT correlation_id FROM mesh_pending_acks WHERE state = 'open'",
    )
    .get() as { correlation_id: string } | undefined;
  return row!.correlation_id;
}

// ─── 回程定向：复信只回发起方（§14.1）─────────────────────────────────────

describe("W09: 回程定向（§14.1/§14.4）", () => {
  it("带 correlationId 的复信定向回发起方，不广播给群内第三方；闭合 open + ack_of", async () => {
    const h = makeHarness();
    try {
      await addAcc(h, "A");
      await addAcc(h, "B");
      await addAcc(h, "C");
      await addHotEndpoint(h, "A");
      await addHotEndpoint(h, "B");
      await addHotEndpoint(h, "C");
      const conv = await h.registry.createConversation({
        type: "group",
        creator: "A",
        members: ["B", "C"],
      });

      await h.router.route(msg("A", conv.id, { to: ["B"], expect: "ack", clientToken: "req1" }));
      const corr = openCorrelation(h);

      // B 用 ordinary correlation send 复信（与 ack 入口走同一 router 路径）
      await h.router.route(
        msg("B", conv.id, { correlationId: corr, expect: "none", text: "answer", clientToken: "ans1" }),
      );

      const ans = h.db
        .prepare<[string], { id: string; to_accounts: string | null; ack_of: string | null; late: number }>(
          "SELECT id, to_accounts, ack_of, late FROM mesh_messages WHERE correlation_id = ? AND from_account = 'B'",
        )
        .get(corr) as { id: string; to_accounts: string | null; ack_of: string | null; late: number };

      // 定向回 A（to_accounts=["A"]），不是全体成员（无 C）
      expect(JSON.parse(ans.to_accounts!)).toEqual(["A"]);
      expect(ans.late).toBe(0);
      const pa = pendingRow(h, corr);
      expect(pa!.state).toBe("answered");
      expect(pa!.answered_by_message).toBe(ans.id);
      // ack_of 指向原请求（expect:"ack" 的复信）
      expect(ans.ack_of).toBe(pa!.message_id);

      // 投递集：只有 A 一条，无 C
      const deliveries = h.db
        .prepare<[string], { account_id: string } | undefined>(
          "SELECT account_id FROM mesh_deliveries WHERE message_id = ?",
        )
        .all(ans.id) as Array<{ account_id: string }>;
      expect(deliveries.map((d) => d.account_id).sort()).toEqual(["A"]);
    } finally {
      h.store.close();
    }
  });

  it("超时后到达的复信打 late=1、只定向回发起方、不回退 pending 终态", async () => {
    const h = makeHarness();
    try {
      await addAcc(h, "A");
      await addAcc(h, "B");
      await addAcc(h, "C");
      await addHotEndpoint(h, "A");
      await addHotEndpoint(h, "B");
      await addHotEndpoint(h, "C");
      const conv = await h.registry.createConversation({
        type: "group",
        creator: "A",
        members: ["B", "C"],
      });

      await h.router.route(msg("A", conv.id, { to: ["B"], expect: "ack", clientToken: "req1" }));
      const corr = openCorrelation(h);
      const orig = pendingRow(h, corr)!;

      // 伪造 deadline 过期 + sweep → timeout
      h.db
        .prepare("UPDATE mesh_pending_acks SET deadline = ? WHERE state = 'open'")
        .run(isoFromMs(Date.now() - 1000));
      await h.mailbox.sweep();
      expect(pendingRow(h, corr)!.state).toBe("timeout");

      // B 超时后复信
      await h.router.route(
        msg("B", conv.id, { correlationId: corr, expect: "none", text: "late answer", clientToken: "late1" }),
      );

      const ans = h.db
        .prepare<[string], { id: string; to_accounts: string | null; ack_of: string | null; late: number }>(
          "SELECT id, to_accounts, ack_of, late FROM mesh_messages WHERE correlation_id = ? AND from_account = 'B'",
        )
        .get(corr) as { id: string; to_accounts: string | null; ack_of: string | null; late: number };

      expect(ans.late).toBe(1); // late 标记
      expect(ans.ack_of).toBe(orig.message_id); // 仍指向原请求
      expect(JSON.parse(ans.to_accounts!)).toEqual(["A"]); // 只定向发起方
      // 不回退终态：仍 timeout，answered_by_message 仍 NULL
      const pa = pendingRow(h, corr);
      expect(pa!.state).toBe("timeout");
      expect(pa!.answered_by_message).toBeNull();
    } finally {
      h.store.close();
    }
  });
});

// ─── exclusive 租约：获取 / 并发阻挡 / 超时释放（§14.3）────────────────────

describe("W09: exclusive 租约（§14.3）", () => {
  it("ack 请求首次投递绑定端点 + 取 exclusive；并发到达 park(LEASE_HELD)；超时释放并解 park", async () => {
    const h = makeHarness();
    try {
      await addAcc(h, "A");
      await addAcc(h, "B");
      await addHotEndpoint(h, "A");
      const epB = await addHotEndpoint(h, "B");
      const conv = await h.registry.createConversation({
        type: "group",
        creator: "A",
        members: ["B"],
      });

      // ack 请求 → deliverOne 在投递前取得 B 端点 exclusive + 绑定 endpoint_id
      await h.router.route(msg("A", conv.id, { to: ["B"], expect: "ack", clientToken: "req1" }));
      const corr = openCorrelation(h);
      const pa = pendingRow(h, corr);
      expect(pa!.endpoint_id).toBe(epB);
      const lease = h.db
        .prepare<[string], { lease_mode: string }>(
          "SELECT lease_mode FROM mesh_endpoints WHERE id = ?",
        )
        .get(epB) as { lease_mode: string };
      expect(lease.lease_mode).toBe("exclusive");

      // 并发到达（普通消息 expect:none）→ park(LEASE_HELD)
      await h.router.route(msg("A", conv.id, { to: ["B"], expect: "none", text: "concurrent", clientToken: "c1" }));
      const parked = h.db
        .prepare<[string], { state: string; parked_reason: string | null }>(
          "SELECT state, parked_reason FROM mesh_deliveries WHERE endpoint_id = ? AND parked_reason IS NOT NULL",
        )
        .get(epB) as { state: string; parked_reason: string | null } | undefined;
      expect(parked!.state).toBe("parked");
      expect(parked!.parked_reason).toBe("LEASE_HELD");

      // 伪造超时 + sweep → 释放 exclusive + 解 park（release 恢复，非终止）
      h.db
        .prepare("UPDATE mesh_pending_acks SET deadline = ? WHERE state = 'open'")
        .run(isoFromMs(Date.now() - 1000));
      await h.mailbox.sweep();
      const leaseAfter = h.db
        .prepare<[string], { lease_mode: string }>(
          "SELECT lease_mode FROM mesh_endpoints WHERE id = ?",
        )
        .get(epB) as { lease_mode: string };
      expect(leaseAfter.lease_mode).toBe("shared");
      const unparked = h.db
        .prepare<[string], { state: string }>(
          "SELECT state FROM mesh_deliveries WHERE endpoint_id = ? AND parked_reason IS NOT NULL",
        )
        .get(epB) as { state: string } | undefined;
      // 解 park 后不再是 parked（重投为 delivered / queued）
      expect(unparked?.state).not.toBe("parked");
    } finally {
      h.store.close();
    }
  });
});