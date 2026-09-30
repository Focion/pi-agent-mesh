// ═══════════════════════════════════════════════════════════════════════════
// TopologyEndpointSelector 纯单元测试：perConversation 的 hash(accountId,key)
// 精确命中 + 确定性兜底（audit #9 的修复点）。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { TopologyEndpointSelector } from "../../src/core/policies.js";
import type { Envelope, StreamTopology } from "../../src/core/types.js";

function env(conversationId: string, over: Partial<Envelope> = {}): Envelope {
  return {
    id: "m1",
    seq: 1,
    from: "alice",
    fromEndpoint: null,
    routedAt: new Date().toISOString(),
    idempotencyKey: "ik",
    conversationId,
    kind: "chat",
    expect: "none",
    payload: {},
    ...over,
  };
}

const PERCV: Array<{ id: string; inFlight: number; topology: StreamTopology }> = [
  { id: "ep-c1", inFlight: 0, topology: { kind: "perConversation", scope: "conversation", key: "conv-1" } },
  { id: "ep-c2", inFlight: 0, topology: { kind: "perConversation", scope: "conversation", key: "conv-2" } },
  { id: "ep-c3", inFlight: 0, topology: { kind: "perConversation", scope: "conversation", key: "conv-3" } },
];

describe("TopologyEndpointSelector: perConversation（§8.1 hash(accountId,key)）", () => {
  it("精确命中声明了 scope_key 的端点", () => {
    const s = new TopologyEndpointSelector({ endpointsOf: () => PERCV });
    const r = s.select({
      accountId: "a",
      conversationId: "conv-2",
      envelope: env("conv-2"),
      topology: { kind: "perConversation", scope: "conversation", key: "conv-2" },
    });
    expect(r).toBe("ep-c2");
  });

  it("无精确命中时按 hash(accountId:key) 稳定选一条（确定性、仍落在 perConversation 池内）", () => {
    const s = new TopologyEndpointSelector({ endpointsOf: () => PERCV });
    const pick = (cid: string) =>
      s.select({
        accountId: "a",
        conversationId: cid,
        envelope: env(cid),
        topology: { kind: "perConversation", scope: "conversation", key: cid },
      });
    expect(pick("conv-unknown")).toBe(pick("conv-unknown")); // 同 key 恒同端点
    expect(PERCV.map((e) => e.id)).toContain(pick("conv-unknown"));
  });

  it("purpose 作用域以 requestType 为 key", () => {
    const PURPOSE: Array<{ id: string; inFlight: number; topology: StreamTopology }> = [
      { id: "ep-triage", inFlight: 0, topology: { kind: "perConversation", scope: "purpose", key: "triage" } },
      { id: "ep-summarize", inFlight: 0, topology: { kind: "perConversation", scope: "purpose", key: "summarize" } },
    ];
    const s = new TopologyEndpointSelector({ endpointsOf: () => PURPOSE });
    const r = s.select({
      accountId: "a",
      conversationId: "conv-x",
      envelope: env("conv-x", { requestType: "summarize" }),
      topology: { kind: "perConversation", scope: "purpose", key: "summarize" },
    });
    expect(r).toBe("ep-summarize");
  });

  it("账号无 perConversation 端点 ⇒ 回退首条（不破坏 P1 单端点）", () => {
    const s = new TopologyEndpointSelector({
      endpointsOf: () => [{ id: "ep-u", inFlight: 0, topology: { kind: "unified" } }],
    });
    expect(
      s.select({
        accountId: "a",
        conversationId: "c",
        envelope: env("c"),
        topology: { kind: "perConversation", scope: "conversation", key: "c" },
      }),
    ).toBe("ep-u");
  });

  it("空端点 ⇒ null（parked）", () => {
    const s = new TopologyEndpointSelector({ endpointsOf: () => [] });
    expect(
      s.select({
        accountId: "a",
        conversationId: "c",
        envelope: env("c"),
        topology: { kind: "unified" },
      }),
    ).toBeNull();
  });
});