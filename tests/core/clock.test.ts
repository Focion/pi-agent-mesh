// ═══════════════════════════════════════════════════════════════════════════
// LogicalClock 接线（N05）：guardClock 的 throw/illegal 降级墙钟；format 走
// Renderer ts 头与 mesh_history 回显；compare 反转 inbox/会话排序（非 seq）；
// seq 排序权威不被 clock 动（回归护栏）。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import type { PolicyTimeoutDeps } from "../../src/core/policies.js";
import { guardClock } from "../../src/core/policies.js";
import { DefaultRenderer } from "../../src/core/renderer.js";
import { buildToolSet, parseToolContent } from "../../src/core/tools.js";
import type { Envelope, LogicalClock, ToolDefinition } from "../../src/core/types.js";
import { MeshObserver } from "../../src/core/observer.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { SqliteStore } from "../../src/core/store.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import type { ToolContext } from "../../src/core/contracts.js";
import { isoNow } from "../../src/core/util.js";
import { openTestDb } from "../helpers/db.js";

// ─── guardClock（N05：同步槽，throw/非法 → wallclock，reason 正确）────────────

function deps(events: Array<{ reason?: string; slot?: string; degradedTo?: string }>): PolicyTimeoutDeps {
  return {
    slot: "clock",
    timeoutMs: 50,
    degradedTo: "wallclock",
    onDegraded: (reason, slot, degradedTo) =>
      events.push({ reason, slot, degradedTo: degradedTo as string }),
  };
}

describe("guardClock（N05）", () => {
  it("正常 compare/format 原样透传，零降级", () => {
    const ev: Array<{ reason: string }> = [];
    const g = guardClock(deps(ev), {
      compare: (a, b) => (a === b ? 0 : a! < b! ? -1 : 1),
      format: (ts) => "[" + ts + "]",
    });
    expect(g.compare("a", "b")).toBe(-1);
    expect(g.format?.("t")).toBe("[t]");
    expect(ev).toHaveLength(0);
  });

  it("compare 抛错 → 墙钟结果 + policy_degraded(slot:clock, threw)", () => {
    const ev: Array<{ reason: string; slot: string; degradedTo: string }> = [];
    const g = guardClock(deps(ev), {
      compare: () => {
        throw new Error("boom");
      },
    });
    expect(g.compare("b", "a")).toBe(1); // 墙钟字典序 b > a
    expect(ev).toEqual([{ reason: "threw", slot: "clock", degradedTo: "wallclock" }]);
  });

  it("compare 返回 NaN（非法值）→ 墙钟 + reason:illegal", () => {
    const ev: Array<{ reason: string }> = [];
    const g = guardClock(deps(ev), { compare: () => NaN });
    expect(g.compare("b", "a")).toBe(1);
    expect(ev).toEqual([{ reason: "illegal", slot: "clock", degradedTo: "wallclock" }]);
  });

  it("format 抛错 / 返回非字符串 → 墙钟恒等；缺 format 按恒等（不降级）", () => {
    const evThrow: Array<{ reason: string }> = [];
    const g1 = guardClock(deps(evThrow), {
      compare: () => 0,
      format: () => {
        throw new Error("boom");
      },
    });
    expect(g1.format?.("ts-x")).toBe("ts-x");
    expect(evThrow).toEqual([{ reason: "threw", slot: "clock", degradedTo: "wallclock" }]);

    const evIllegal: Array<{ reason: string }> = [];
    const g2 = guardClock(deps(evIllegal), {
      compare: () => 0,
      format: () => 123 as unknown as string,
    });
    expect(g2.format?.("ts-x")).toBe("ts-x");
    expect(evIllegal).toEqual([{ reason: "illegal", slot: "clock", degradedTo: "wallclock" }]);

    // 缺 format：按 §20.1⑨ 恒等，不是非法值
    const evNone: Array<{ reason: string }> = [];
    const g3 = guardClock(deps(evNone), { compare: (a, b) => (a === b ? 0 : 1) });
    expect(g3.format?.("raw")).toBe("raw");
    expect(evNone).toHaveLength(0);
  });
});

// ─── format 走 Renderer ts 头（N05 §20.1⑨）───────────────────────────────

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: "m_1",
    seq: 1,
    from: "alice",
    fromEndpoint: null,
    routedAt: "2026-01-01T00:00:00.000Z",
    idempotencyKey: "k",
    conversationId: "c1",
    kind: "chat",
    expect: "none",
    payload: { text: "hi" },
    ...over,
  };
}

describe("Renderer：ts 显示走 clock.format", () => {
  it("注入 format 改 ts 头；logicalTs 优先于 routedAt", () => {
    const clock: LogicalClock = { compare: () => 0, format: (ts) => "L<" + ts + ">" };
    const r = new DefaultRenderer(clock);
    const out = r.renderMessage(
      envelope({ logicalTs: "lt:9" }),
      { recipient: { endpointClass: "stream" }, senderName: "Alice" },
    );
    expect(out).toContain('ts="L<lt:9>"');
  });

  it("无 clock 时 new DefaultRenderer() 恒等 ts", () => {
    const r = new DefaultRenderer();
    const out = r.renderMessage(
      envelope({ logicalTs: "lt:2" }),
      { recipient: { endpointClass: "stream" }, senderName: "Alice" },
    );
    expect(out).toContain('ts="lt:2"');
  });
});

// ─── format 走 mesh_history 工具回显（N05）────────────────────────────────

function tinyCtx(history: Envelope[]): ToolContext {
  return {
    accountId: "acct_me",
    endpointId: "ep_me",
    send: async () => ({ messageId: "m", seq: 1 }),
    inbox: async () => ({ conversations: [], awaitingMyAck: [], awaitingTheirAck: [] }),
    history: async () => history,
    conversations: async () => [],
    members: async () => [],
    contacts: async () => [],
    lookup: async () => [],
    createConversation: async () => ({
      id: "c",
      kind: "group",
      state: "active",
      config: { historyVisibility: "since_join", maxHistoryOnJoin: 0 },
      createdBy: "acct_me",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeq: 0,
    }),
    conversationAdmin: async () => {},
    ack: async () => {},
    claim: async () => ({ ok: false }),
    sharedGet: async () => null,
    sharedPut: async () => ({ version: 1 }),
    sharedList: async () => [],
  };
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error("tool not found: " + name);
  return t;
}

describe("tools：mesh_history ts 回显走 clock.format", () => {
  it("historyItem.ts = clock.format(logicalTs ?? routedAt)", async () => {
    const clock: LogicalClock = { compare: () => 0, format: (ts) => "C<" + ts + ">" };
    const ctx = tinyCtx([
      envelope({ id: "m_1", seq: 1, logicalTs: "lt:7", payload: { text: "seven" } }),
      envelope({ id: "m_2", seq: 2, payload: { text: "eight" } }),
    ]);
    const tool = byName(buildToolSet(ctx, ["mesh_history"], { clock }), "mesh_history");
    const raw = await tool.execute("tc", { conversationId: "c1" }, undefined, undefined, undefined);
    const body = parseToolContent(raw) as { messages: Array<{ seq: number; ts: string }> };
    expect(body.messages[0]!.ts).toBe("C<lt:7>"); // logicalTs 优先
    expect(body.messages[1]!.ts).toBe("C<2026-01-01T00:00:00.000Z>"); // 回落 routedAt 也 format
  });
});

// ─── compare 反转会话排序（非 seq）+ seq 权威护栏（N05）────────────────────

function seedWorld(db: import("better-sqlite3").Database): void {
  const acc = (id: string, name: string) =>
    db.prepare(
      "INSERT INTO mesh_accounts (id, display_name, endpoint_class, capabilities, initiate, presence, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, name, "stream", "[]", '["chat"]', "offline", isoNow());
  acc("a1", "Alice");
  const conv = (id: string, type: string) =>
    db.prepare(
      "INSERT INTO mesh_conversations (id, type, config, next_seq, member_count, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, type, null, 2, 0, "@system", isoNow());
  conv("gc1", "group");
  conv("gc2", "group");
  const member = (convId: string, acct: string) =>
    db.prepare(
      "INSERT INTO mesh_memberships (conversation_id, account_id, caps, joined_seq, joined_at) VALUES (?,?,?,?,?)",
    ).run(convId, acct, '["speak","read"]', 0, isoNow());
  member("gc1", "a1");
  member("gc2", "a1");
  // gc1 较旧、gc2 较新（routed_at 不同），seq 各 1
  const msg = (id: string, convId: string, seq: number, at: string) => {
    db.prepare(
      "INSERT INTO mesh_messages (id, conversation_id, seq, from_account, kind, expect, priority, to_accounts, mentions, correlation_id, intent, routed_at, payload, idempotency_key, ext) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(id, convId, seq, "a1", "chat", "none", null, null, null, null, null, at, JSON.stringify({ text: id }), "ik-" + id, null);
    db.prepare("UPDATE mesh_conversations SET next_seq = MAX(next_seq, ?) WHERE id = ?").run(seq + 1, convId);
  };
  msg("m1", "gc1", 1, "2026-01-01T00:00:00.000Z");
  msg("m2", "gc2", 1, "2026-02-01T00:00:00.000Z");
}

describe("observer：compare 反转会话排序，seq 不动", () => {
  it("墙钟：gc2（较新）在前；反转 compare：gc1 在前", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db);
    const registry = new MeshRegistry(tdb.db, DEFAULT_LIMITS);
    seedWorld(tdb.db);

    const wall = new MeshObserver({ store, registry, limits: DEFAULT_LIMITS });
    const wallOrder = (await wall.conversationsOf("a1")).map((c) => c.conversationId);
    expect(wallOrder).toEqual(["gc2", "gc1"]); // 降序（descending compare）

    const reversed: LogicalClock = {
      compare: (a, b) => {
        const wa = a ?? "";
        const wb = b ?? "";
        return wa < wb ? 1 : wa > wb ? -1 : 0; // 反转字典序
      },
    };
    const rev = new MeshObserver({
      store,
      registry,
      limits: DEFAULT_LIMITS,
      clock: reversed,
    });
    const revOrder = (await rev.conversationsOf("a1")).map((c) => c.conversationId);
    expect(revOrder).toEqual(["gc1", "gc2"]); // 翻转，但只影响会话排序

    // seq 权威护栏：messages 仍按 seq 升序（clock 不碰 seq 排序）
    const msgs = await rev.messages({ conversationId: "gc1" });
    expect(msgs.map((m) => m.seq)).toEqual([1]);
    store.close();
  });
});