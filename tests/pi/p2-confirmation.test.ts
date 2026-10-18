// ═══════════════════════════════════════════════════════════════════════════
// W08 · I09 · P2 最终输入确认（真实 SDK + faux，§7.6 / W01 探针确认点）。
//
// 保护的设计决定：P2 的「delivered」唯一判据是注入体进入真实 LLM 调用的最终输入
// —— 通过同一扩展的 context_with_system 处理器观测到 customType==="mesh.inbox" 的那
// 一条。装 hook（injectContext）≠ 确认；不起轮 ⇒ 观测零次 ⇒ 永不确认（停在 blocked，
// 不伪造绿灯）。确认回调绑定端点与回合代次（turnGeneration）。
//
// pi 1.1.0 实测机制（W01 探针）：context_with_system 在所有 context 处理器跑完、
// system 前缀恢复后看到完整 transcript；此钩子找不到注入体即静默。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Account,
  Endpoint,
  Envelope,
  SessionFactory,
} from "../../src/core/types.js";
import { PiStreamPort } from "../../src/pi/stream-port.js";
import { loadPiSdk } from "../../src/pi/pi-sdk.js";
import {
  createFaux,
  loadFauxCompat,
  registerFauxInto,
  waitFor,
  type FauxCore,
} from "../helpers/pi-session.js";

// ── 测试工厂：每端点一条真 inMemory pi 流（同 stream-port.test.ts 装配）───

async function createTestFactory(faux: FauxCore, dir: string): Promise<SessionFactory> {
  const pi = await loadPiSdk();
  const make = async (id: string) => {
    const sm = pi.SessionManager.inMemory(join(dir, id));
    const { session } = await pi.createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: faux.getModel() as never,
      noTools: "all",
      sessionManager: sm,
    });
    registerFauxInto(session, faux);
    return { session, piSessionId: `mem:${id}` };
  };
  return {
    async create(ctx) {
      return make(ctx.endpoint.id);
    },
    async open(ctx) {
      const r = await make(ctx.endpoint.id);
      return { session: r.session };
    },
  };
}

function makeAccount(id: string): Account {
  return { id, displayName: id, endpointClass: "stream", initiate: ["chat"] };
}

function makeEndpoint(id: string, accountId: string): Endpoint {
  return {
    id,
    accountId,
    topology: { kind: "unified" },
    state: "cold",
    piSessionId: null,
    lease: "shared",
    leaseUntil: null,
    lastActiveAt: null,
  };
}

function makeEnvelope(id: string): Envelope {
  return {
    id,
    seq: 1,
    from: "acct_a",
    fromEndpoint: "ep_a",
    routedAt: new Date().toISOString(),
    idempotencyKey: `k_${id}`,
    conversationId: "conv_1",
    kind: "chat",
    expect: "none",
    payload: { text: `text of ${id}` },
  };
}

let dir: string;
let faux: FauxCore;
let port: PiStreamPort;
let accounts: Map<string, Account>;
let endpoints: Map<string, Endpoint>;
let confirmed: Array<{ endpointId: string; turnGeneration: number }>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-mesh-p2-"));
  faux = await createFaux("faux-p2");
  accounts = new Map();
  endpoints = new Map();
  confirmed = [];
  const factory = await createTestFactory(faux, dir);
  port = new PiStreamPort({
    writerId: "test-writer",
    sessionFactory: factory,
    getEndpoint: (id) => endpoints.get(id),
    getAccount: (id) => accounts.get(id),
    buildTools: () => [],
    setEndpointState: (id, state) => {
      const e = endpoints.get(id);
      if (e) e.state = state;
    },
    setEndpointSession: (id, sid) => {
      const e = endpoints.get(id);
      if (e) e.piSessionId = sid;
    },
    setEndpointLease: () => {},
    setEndpointLock: () => {},
    stateDir: dir,
    idleEvictMs: 0,
    onInjectionConfirmed: (id, info) =>
      confirmed.push({ endpointId: id, turnGeneration: info.turnGeneration }),
  });
});

afterEach(async () => {
  await port.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function addEndpoint(id = "ep_b", accountId = "acct_b"): Endpoint {
  accounts.set(accountId, makeAccount(accountId));
  const ep = makeEndpoint(id, accountId);
  endpoints.set(id, ep);
  return ep;
}

describe("P2 最终输入确认（I09）：装 hook ≠ 确认；起轮才确认", () => {
  it("不起轮 ⇒ context_with_system 观测零次 ⇒ onInjectionConfirmed 零次（停在 blocked）", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    port.injectContext(ep.id, "P2-INBOX-SNIPPET");
    // 不触发任何 turn（faux 不发起模型调用）
    expect(confirmed).toHaveLength(0);
    expect(faux.state.callCount).toBe(0);
  });

  it("起一轮 ⇒ 观测到 mesh.inbox ⇒ onInjectionConfirmed 恰一次（绑定回合代次）", async () => {
    const compat = await loadFauxCompat();
    faux.setResponses([compat.fauxAssistantMessage("ok")]);
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    port.injectContext(ep.id, "P2-INBOX-SNIPPET");
    // 触发真实一轮（faux 应答）；注入体进入最终输入 ⇒ context_with_system 观测确认
    await port.deliver(ep.id, "wake", makeEnvelope("m_1"), "steer", {
      triggerTurn: true,
    });
    await waitFor(() => confirmed.length === 1);
    expect(confirmed[0]).toEqual({ endpointId: ep.id, turnGeneration: 1 });
    expect(faux.state.callCount).toBe(1);
  });

  it("双端点：只触发一端轮 ⇒ 只有该端点确认，另一端不确认（不互相确认）", async () => {
    const compat = await loadFauxCompat();
    faux.setResponses([compat.fauxAssistantMessage("ok")]);
    const ep1 = addEndpoint("ep_1", "acct_b");
    const ep2 = addEndpoint("ep_2", "acct_b");
    await port.warm(ep1.id, "shared");
    await port.warm(ep2.id, "shared");
    port.injectContext(ep1.id, "P2-FOR-EP1");
    port.injectContext(ep2.id, "P2-FOR-EP2");
    // 只 ep1 起轮
    await port.deliver(ep1.id, "wake", makeEnvelope("m_2"), "steer", {
      triggerTurn: true,
    });
    await waitFor(() => confirmed.length === 1);
    expect(confirmed.map((c) => c.endpointId)).toEqual([ep1.id]);
    expect(confirmed[0]!.turnGeneration).toBe(1);
  });
});