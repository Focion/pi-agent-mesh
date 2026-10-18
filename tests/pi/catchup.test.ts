// ═══════════════════════════════════════════════════════════════════════════
// W08 · I10 · CATCHUP 正文进入真实 pi 会话（真实 SDK + faux，§7.6）。
//
// 保护的设计决定：升回预算内的跃迁点，追赶摘要不再是 `mesh.catchup` 元数据 note
// （type:"custom"，不进上下文），而是一条 `<<<CATCHUP …>>>` 正文，经全库唯一
// sendCustomMessage 出口（§3.2 ①）落为持久化 custom_message 条目并进入之后的输入。
// 这里在 pi 层锁定：再审正文经 port.deliver 进入真实 session 后是 custom_message
// （含 <<<CATCHUP 包裹体），而非 custom note。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Account,
  Endpoint,
  Envelope,
  PortEntryEvent,
  SessionFactory,
} from "../../src/core/types.js";
import { DefaultRenderer } from "../../src/core/renderer.js";
import { PiStreamPort } from "../../src/pi/stream-port.js";
import { loadPiSdk } from "../../src/pi/pi-sdk.js";
import {
  createFaux,
  registerFauxInto,
  type FauxCore,
} from "../helpers/pi-session.js";

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

let dir: string;
let faux: FauxCore;
let port: PiStreamPort;
let accounts: Map<string, Account>;
let endpoints: Map<string, Endpoint>;
let entries: PortEntryEvent[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-mesh-catchup-"));
  faux = await createFaux("faux-catchup");
  accounts = new Map();
  endpoints = new Map();
  entries = [];
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
  });
  port.onEntry((e) => entries.push(e));
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

describe("CATCHUP 正文落真实会话（I10）：custom_message 而非 note", () => {
  it("renderCatchup 产物经 port.deliver 落为持久化 custom_message，含 <<<CATCHUP 包裹体", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");

    // 与 maybeCatchup 同样的渲染 + 合成信封（不写 mesh_messages/mesh_deliveries）
    const renderer = new DefaultRenderer();
    const body = renderer.renderCatchup(
      "conv_1",
      3,
      4,
      6,
      "most active speakers: Alice(2)\n  seq 5 Alice: hi there",
    );
    const synEnv: Envelope = {
      id: "syn-catchup",
      seq: 7,
      from: "acct_a",
      fromEndpoint: null,
      routedAt: new Date().toISOString(),
      idempotencyKey: "mesh:catchup:test",
      conversationId: "conv_1",
      kind: "chat",
      expect: "none",
      payload: { text: "" },
    };
    await port.deliver(ep.id, body, synEnv, "followUp", { triggerTurn: false });

    // 唯一落的是 custom_message（含捕获正文），不是 custom note
    const evt = entries.find((e) => e.envelopeId === "syn-catchup");
    expect(evt).toBeDefined();
    expect(evt!.entryType).toBe("custom_message");
    const raw = JSON.parse(evt!.rawJson) as Record<string, unknown>;
    expect(raw.type).toBe("custom_message");
    // 正文以 <<<CATCHUP …>>> 包裹体进入条目（先持久化，再进后续输入）
    expect(evt!.rawJson).toContain("<<<CATCHUP");
    expect(evt!.rawJson).toContain("<<<END CATCHUP>>>");
    // 不起轮（固化不被本轮触发；下条 P1 才把它带进输入）
    expect(faux.state.callCount).toBe(0);
  });
});