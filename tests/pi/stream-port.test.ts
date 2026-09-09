// ═══════════════════════════════════════════════════════════════════════════
// PiStreamPort（SessionHost）真 pi 测试：.lock 单写者（M3）、warm/deliver/note、
// onEntry 差分镜像（F4/F5）、inFlight 自持（F3）、hasEntries、evict。
// 全部走 faux provider，无 LLM 成本。
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
import { EndpointLock, LockHeldError } from "../../src/pi/lock.js";
import { PiPortError, PiStreamPort } from "../../src/pi/stream-port.js";
import { loadPiSdk } from "../../src/pi/pi-sdk.js";
import {
  createFaux,
  loadFauxCompat,
  registerFauxInto,
  waitFor,
  type FauxCore,
} from "../helpers/pi-session.js";

// ── 测试工厂：每端点一条真 inMemory pi 流 ────────────────────────────────

async function createTestFactory(faux: FauxCore, dir: string): Promise<SessionFactory> {
  const pi = await loadPiSdk();
  return {
    async create(ctx) {
      const sm = pi.SessionManager.inMemory(join(dir, ctx.endpoint.id));
      const { session } = await pi.createAgentSession({
        cwd: dir,
        agentDir: dir,
        model: faux.getModel() as never,
        noTools: "all",
        sessionManager: sm,
      });
      registerFauxInto(session, faux);
      return { session, piSessionId: `mem:${ctx.endpoint.id}` };
    },
    async open(ctx) {
      // 测试工厂的 open 等价于 create（inMemory 无盘可恢）
      const sm = pi.SessionManager.inMemory(join(dir, ctx.endpoint.id));
      const { session } = await pi.createAgentSession({
        cwd: dir,
        agentDir: dir,
        model: faux.getModel() as never,
        noTools: "all",
        sessionManager: sm,
      });
      registerFauxInto(session, faux);
      return { session };
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

// ── 装配 ─────────────────────────────────────────────────────────────────

let dir: string;
let faux: FauxCore;
let port: PiStreamPort;
let accounts: Map<string, Account>;
let endpoints: Map<string, Endpoint>;
let entries: PortEntryEvent[];
let turnEnds: Array<{ endpointId: string }>;
let degraded: Array<{ reason: string; endpointId: string }>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-mesh-port-"));
  faux = await createFaux("faux-port");
  accounts = new Map();
  endpoints = new Map();
  entries = [];
  turnEnds = [];
  degraded = [];
  const factory = await createTestFactory(faux, dir);
  port = new PiStreamPort({
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
    setEndpointLease: (id, lease, until) => {
      const e = endpoints.get(id);
      if (e) {
        e.lease = lease;
        e.leaseUntil = until;
      }
    },
    stateDir: dir,
    idleEvictMs: 0, // 测试不做空闲驱逐
    onDegraded: (info) => degraded.push(info),
  });
  port.onEntry((e) => entries.push(e));
  port.onTurnEnd((e) => turnEnds.push(e));
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

// ── 用例 ─────────────────────────────────────────────────────────────────

describe("PiStreamPort: warm 与 .lock 单写者（M3 / §8.4①）", () => {
  it("warm 建流：cold→warming→hot，锁文件存在，租约落库", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    expect(ep.state).toBe("hot");
    expect(ep.piSessionId).toBe("mem:ep_b");
    expect(port.status(ep.id).state).toBe("hot");
    expect(await EndpointLock.readInfo(join(dir, "locks", `${ep.id}.lock`))).toBeDefined();
  });

  it("第二个写者抢同一端点的锁 ⇒ LOCK_HELD，端点标 unavailable，绝不接管", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    // 独立第二个 port（另一进程/实例的模拟）
    const factory2 = await createTestFactory(faux, dir);
    const port2 = new PiStreamPort({
      sessionFactory: factory2,
      getEndpoint: (id) => endpoints.get(id),
      getAccount: (id) => accounts.get(id),
      buildTools: () => [],
      setEndpointState: (id, state) => {
        const e = endpoints.get(id);
        if (e) e.state = state;
      },
      setEndpointSession: () => {},
      setEndpointLease: () => {},
      stateDir: dir,
      idleEvictMs: 0,
    });
    await expect(port2.warm(ep.id)).rejects.toThrow(PiPortError);
    await expect(port2.warm(ep.id)).rejects.toMatchObject({ code: "LOCK_HELD" });
    expect(ep.state).toBe("unavailable");
  });

  it("exclusive 租约有 leaseUntil；TTL 超时强制释放为 shared 并报降级", async () => {
    const ep = addEndpoint();
    const shortTtl = new PiStreamPort({
      sessionFactory: await createTestFactory(faux, dir),
      getEndpoint: (id) => endpoints.get(id),
      getAccount: (id) => accounts.get(id),
      buildTools: () => [],
      setEndpointState: (id, state) => {
        const e = endpoints.get(id);
        if (e) e.state = state;
      },
      setEndpointSession: () => {},
      setEndpointLease: (id, lease, until) => {
        const e = endpoints.get(id);
        if (e) {
          e.lease = lease;
          e.leaseUntil = until;
        }
      },
      stateDir: dir,
      idleEvictMs: 0,
      exclusiveLeaseTtlMs: 120,
      onDegraded: (info) => degraded.push(info),
    });
    await shortTtl.warm(ep.id, "exclusive");
    expect(ep.lease).toBe("exclusive");
    expect(ep.leaseUntil).not.toBeNull();
    await waitFor(() => ep.lease === "shared");
    expect(degraded.some((d) => d.reason === "lease_ttl_expired")).toBe(true);
    await shortTtl.dispose();
  });
});

describe("PiStreamPort: deliver / onEntry / inFlight（F3/F5）", () => {
  it("deliver 后 onEntry 带 envelopeId 与 rawJson；entryId 返回；inFlight 归零", async () => {
    const ep = addEndpoint();
    const env = makeEnvelope("m_1");
    const res = await port.deliver(ep.id, "<<<MSG>>>hi<<<END_MSG>>>", env, "followUp", {
      triggerTurn: false,
    });
    expect(res.entryId).toBeDefined();
    expect(entries.some((e) => e.envelopeId === "m_1" && e.entryId === res.entryId)).toBe(true);
    const evt = entries.find((e) => e.envelopeId === "m_1")!;
    expect(evt.entryType).toBe("custom_message");
    expect(evt.seqInStream).toBeGreaterThan(0);
    expect(JSON.parse(evt.rawJson)).toMatchObject({ type: "custom_message", customType: "mesh.msg" });
    expect(port.status(ep.id).inFlight).toBe(0);
    // faux 未被调：不唤醒即无 LLM 成本
    expect(faux.state.callCount).toBe(0);
  });

  it("triggerTurn:true 起一轮，turn_end 经 onTurnEnd 送达", async () => {
    const compat = await loadFauxCompat();
    faux.setResponses([compat.fauxAssistantMessage("reply")]);
    const ep = addEndpoint();
    const env = makeEnvelope("m_2");
    // F5：deliver 在 entry 落盘时返回，不等轮次跑完 —— 轮次结果随后异步到达
    await port.deliver(ep.id, "hi", env, "followUp", { triggerTurn: true });
    expect(entries.some((e) => e.envelopeId === "m_2")).toBe(true);
    await waitFor(() => turnEnds.some((e) => e.endpointId === ep.id));
    expect(faux.state.callCount).toBe(1);
  });

  it("silent 档：热流落盘不起轮（§7.2 形态①）", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    const env = makeEnvelope("m_3");
    await port.deliver(ep.id, "quiet", env, "silent", { triggerTurn: false });
    expect(entries.some((e) => e.envelopeId === "m_3")).toBe(true);
    expect(faux.state.callCount).toBe(0);
    expect(turnEnds).toHaveLength(0);
  });

  it("cold 流 deliver 自动 warm 再投（§8.3）", async () => {
    const ep = addEndpoint();
    expect(ep.state).toBe("cold");
    const env = makeEnvelope("m_4");
    await port.deliver(ep.id, "auto-warm", env, "followUp", { triggerTurn: false });
    expect(ep.state).toBe("hot");
    expect(entries.some((e) => e.envelopeId === "m_4")).toBe(true);
  });
});

describe("PiStreamPort: note / hasEntries / evict", () => {
  it("note 落 type:custom 条目（P3：记账不进上下文）且发 onEntry", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    await port.note(ep.id, "mesh.audit", { envelopeId: "m_9", seq: 7 });
    const evt = entries.find((e) => e.envelopeId === "m_9");
    expect(evt).toBeDefined();
    expect(evt!.entryType).toBe("custom");
    expect(faux.state.callCount).toBe(0);
  });

  it("hasEntries 按 id 逐条问（F4）；未知 id 不在结果集", async () => {
    const ep = addEndpoint();
    const env = makeEnvelope("m_5");
    const res = await port.deliver(ep.id, "x", env, "followUp", { triggerTurn: false });
    const alive = await port.hasEntries(ep.id, [res.entryId!, "nonexistent"]);
    expect(alive.has(res.entryId!)).toBe(true);
    expect(alive.has("nonexistent")).toBe(false);
  });

  it("evict 释放锁、转 cold；之后可重新 warm", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    await port.evict(ep.id);
    expect(ep.state).toBe("cold");
    expect(await EndpointLock.readInfo(join(dir, "locks", `${ep.id}.lock`))).toBeUndefined();
    await port.warm(ep.id, "shared");
    expect(ep.state).toBe("hot");
  });
});

describe("EndpointLock 单元行为", () => {
  it("双抢同一路径 ⇒ LockHeldError 带持锁者信息；release 后可再抢", async () => {
    const p = join(dir, "locks", "unit.lock");
    const a = await EndpointLock.acquire(p, { writerId: "w-a", lease: "shared" });
    await expect(EndpointLock.acquire(p, { writerId: "w-b", lease: "shared" })).rejects.toThrow(
      LockHeldError,
    );
    await a.release();
    const b = await EndpointLock.acquire(p, { writerId: "w-b", lease: "shared" });
    expect(b.held()).toBe(true);
    await b.release();
  });

  it("exclusive 租约过期 ⇒ held() = false，assertHeld 抛 invariant_violated（§23.7）", async () => {
    const p = join(dir, "locks", "unit2.lock");
    const lock = await EndpointLock.acquire(p, {
      writerId: "w",
      lease: "exclusive",
      leaseTtlMs: 30,
    });
    expect(lock.held()).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(lock.held()).toBe(false);
    expect(() => lock.assertHeld("ep_x")).toThrow(/invariant_violated/);
    await lock.release();
  });
});
