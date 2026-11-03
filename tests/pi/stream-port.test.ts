// ═══════════════════════════════════════════════════════════════════════════
// PiStreamPort（SessionHost）真 pi 测试：.lock 单写者（M3）、warm/deliver/note、
// onEntry 差分镜像（F4/F5）、inFlight 自持（F3）、submissionStatus、evict。
// 全部走 faux provider，无 LLM 成本。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
import { PiPortError, PiStreamPort } from "../../src/pi/durable-port.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createFaux, fakeDurableSession, waitFor, type Faux } from "../helpers/pi-session.js";

// ── 测试工厂：createPiSessionFactory 高级路径 + faux provider（每端点真 durable storage）───

async function createTestFactory(faux: Faux, dir: string): Promise<SessionFactory> {
  return createPiSessionFactory({ stateDir: dir, models: faux.models, model: faux.model });
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
    runtimeRef: null,
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
let faux: Faux;
let port: PiStreamPort;
let accounts: Map<string, Account>;
let endpoints: Map<string, Endpoint>;
let entries: PortEntryEvent[];
let turnEnds: Array<{ endpointId: string; eligibleEntryIds?: readonly string[] }>;
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
      if (e) e.runtimeRef = sid;
    },
    setEndpointLease: (id, lease, until) => {
      const e = endpoints.get(id);
      if (e) {
        e.lease = lease;
        e.leaseUntil = until;
      }
    },
    setEndpointLock: () => {},
    stateDir: dir,
    idleEvictMs: 0, // 测试不做空闲驱逐
    onDegraded: (info) => degraded.push(info),
  });
  port.onEntry((e) => {
    entries.push(e);
  });
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
    expect(ep.runtimeRef).toBeTruthy();
    expect(port.status(ep.id).state).toBe("hot");
    expect(await EndpointLock.readInfo(join(dir, "locks", `${ep.id}.lock`))).toBeDefined();
  });

  it("第二个写者抢同一端点的锁 ⇒ LOCK_HELD，端点标 unavailable，绝不接管", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    // 独立第二个 port（另一进程/实例的模拟）
    const factory2 = await createTestFactory(faux, dir);
    const port2 = new PiStreamPort({
      writerId: "test-writer-2",
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
      setEndpointLock: () => {},
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
      writerId: "test-writer",
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
      setEndpointLock: () => {},
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
    expect(evt.entryType).toBe("mesh.msg");
    expect(evt.seqInStream).toBeGreaterThan(0);
    const raw = JSON.parse(evt.rawJson) as Record<string, unknown>;
    expect(raw.kind).toBe("mesh.msg");
    expect((raw.data as { envelopeId?: string }).envelopeId).toBe("m_1");
    expect(port.status(ep.id).inFlight).toBe(0);
    // faux 未被调：不唤醒即无 LLM 成本
    expect(faux.state.callCount).toBe(0);
  });

  it("triggerTurn:true 起一轮，turn_end 经 onTurnEnd 送达", async () => {
    faux.setResponses([fauxAssistantMessage("reply")]);
    const ep = addEndpoint();
    const env = makeEnvelope("m_2");
    // F5：deliver 在 entry 落盘时返回，不等轮次跑完 —— 轮次结果随后异步到达
    await port.deliver(ep.id, "hi", env, "followUp", { triggerTurn: true });
    expect(entries.some((e) => e.envelopeId === "m_2")).toBe(true);
    await waitFor(() => turnEnds.some((e) => e.endpointId === ep.id));
    expect(faux.state.callCount).toBeGreaterThanOrEqual(1);
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

  it("deliver 驱动的自动 warm 以 shared 租约恢复（§8.3 投递→shared，⑤-D）", async () => {
    const ep = addEndpoint();
    expect(ep.state).toBe("cold");
    await port.deliver(ep.id, "auto-warm-shared", makeEnvelope("m_4s"), "followUp", {
      triggerTurn: false,
    });
    expect(ep.state).toBe("hot");
    // 常规投递是 shared，不是 exclusive —— 否则后续并发消息会全部 park(LEASE_HELD)
    expect(ep.lease).toBe("shared");
    expect(ep.leaseUntil).toBe(null);
  });
});

describe("PiStreamPort: note / submissionStatus / evict", () => {
  it("note 落 type:custom 条目（P3：记账不进上下文）且发 onEntry", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    await port.note(ep.id, "mesh.audit", { envelopeId: "m_9", seq: 7 });
    const evt = entries.find((e) => e.envelopeId === "m_9");
    expect(evt).toBeDefined();
    expect(evt!.entryType).toBe("mesh.audit");
    expect(faux.state.callCount).toBe(0);
  });

  it("submissionStatus 按 id 精确读（MD3）；未知 id 返回 null", async () => {
    const ep = addEndpoint();
    const env = makeEnvelope("m_5");
    const res = await port.deliver(ep.id, "x", env, "followUp", { triggerTurn: false });
    const rec = await port.submissionStatus(ep.id, res.submissionId);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe(res.submissionId);
    const none = await port.submissionStatus(ep.id, "999999");
    expect(none).toBeNull();
  });

  it("evict 释放锁、转 cold；之后可重新 warm（single 释放即删锁文件，§8.3）", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    await port.evict(ep.id);
    expect(ep.state).toBe("cold");
    // single 模式：endpoint 锁释放即删文件，下次 warm 可重新抢
    const info = await EndpointLock.readInfo(join(dir, "locks", `${ep.id}.lock`));
    expect(info).toBeUndefined();
    await port.warm(ep.id, "shared");
    expect(ep.state).toBe("hot");
  });
});

describe("EndpointLock 单元行为", () => {
  it("single 模式：任何租约撞 EEXIST ⇒ LockHeldError（M3 全局单写者）", async () => {
    const p = join(dir, "locks", "unit.lock");
    // shared 撞 shared 也排他（M3：同一 endpointId 全局最多一个持锁写者）
    const a = await EndpointLock.acquire(p, { writerId: "w-a", lease: "shared" });
    await expect(
      EndpointLock.acquire(p, { writerId: "w-b", lease: "shared" }),
    ).rejects.toThrow(LockHeldError);
    await a.release(); // single 释放即删
    // exclusive 撞 shared 同理排他
    const c = await EndpointLock.acquire(p, { writerId: "w-c", lease: "exclusive", leaseTtlMs: 60_000 });
    await expect(
      EndpointLock.acquire(p, { writerId: "w-d", lease: "shared" }),
    ).rejects.toThrow(LockHeldError);
    await c.release();
  });

  it("multi 模式：shared-shared 共存（instance 锁 §19.3，释放不删文件）", async () => {
    const p = join(dir, "locks", "instance.lock");
    const a = await EndpointLock.acquire(p, { writerId: "w-a", lease: "shared", mode: "multi" });
    const b = await EndpointLock.acquire(p, { writerId: "w-b", lease: "shared", mode: "multi" });
    expect(a.held()).toBe(true);
    expect(b.held()).toBe(true);
    await a.release();
    await b.release();
    // multi 不删文件（多进程共享标记）
    expect(await EndpointLock.readInfo(p)).toBeDefined();
    await EndpointLock.forceRelease(p);
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

describe("EndpointLock.ownerIsLive：死写者判定（M-R10 / §27.4）", () => {
  beforeEach(() => mkdirSync(join(dir, "locks"), { recursive: true }));

  it("pid 不存在的死锁 ⇒ dead（kill -0 失败，允许接管）", async () => {
    const p = join(dir, "locks", "ovl1.lock");
    await writeFile(
      p,
      JSON.stringify({ writerId: "w-dead", pid: 99_999_999, lease: "shared", acquiredAt: "", leaseUntil: null, procStartedAt: "" }),
    );
    expect(await EndpointLock.ownerIsLive(p)).toBe("dead");
  });

  it("本进程持有的锁 ⇒ alive（pid 存活且启动时刻吻合）", async () => {
    const p = join(dir, "locks", "ovl2.lock");
    const lock = await EndpointLock.acquire(p, { writerId: "w-live", lease: "shared" });
    expect(await EndpointLock.ownerIsLive(p)).toBe("alive");
    await lock.release();
  });

  it("pid 存活但启动时刻不吻合 ⇒ dead（pid 已被复用）", async () => {
    const p = join(dir, "locks", "ovl3.lock");
    const lock = await EndpointLock.acquire(p, { writerId: "w-stale", lease: "shared" });
    // 覆写启动时刻，模拟 pid 被复用的残留锁
    await writeFile(
      p,
      JSON.stringify({ writerId: "w-stale", pid: process.pid, lease: "shared", acquiredAt: "", leaseUntil: null, procStartedAt: "Thu Jan  1 00:00:00 1970" }),
    );
    expect(await EndpointLock.ownerIsLive(p)).toBe("dead");
    await lock.release();
  });

  it("pid 存活但取不到启动时刻 ⇒ unknown（保守拒绝，绝不猜）", async () => {
    const p = join(dir, "locks", "ovl4.lock");
    await writeFile(
      p,
      JSON.stringify({ writerId: "w-old", pid: process.pid, lease: "shared", acquiredAt: "", leaseUntil: null, procStartedAt: "" }),
    );
    expect(await EndpointLock.ownerIsLive(p)).toBe("unknown");
  });

  it("锁文件不存在 ⇒ dead（无持有者）", async () => {
    expect(await EndpointLock.ownerIsLive(join(dir, "locks", "ovl5.lock"))).toBe("dead");
  });
});

describe("PiStreamPort: lock_path 归属落库（§19.4 / C10）", () => {
  it("warm 抢到锁后落 lock_path，evict 清空", async () => {
    const lockPaths = new Map<string, string | null>();
    // 用真实注册表语义的 setEndpointLock：记录到 Map，供断言
    const factory = await createTestFactory(faux, dir);
    const tracking = new PiStreamPort({
      writerId: "test-writer",
      sessionFactory: factory,
      getEndpoint: (id) => endpoints.get(id),
      getAccount: (id) => accounts.get(id),
      buildTools: () => [],
      setEndpointState: (id, state) => {
        const e = endpoints.get(id);
        if (e) e.state = state;
      },
      setEndpointSession: () => {},
      setEndpointLease: () => {},
      setEndpointLock: (id, p) => lockPaths.set(id, p),
      stateDir: dir,
      idleEvictMs: 0,
    });
    const ep = addEndpoint();
    await tracking.warm(ep.id, "shared");
    expect(lockPaths.get(ep.id)).toBe(join(dir, "locks", `${ep.id}.lock`));
    await tracking.evict(ep.id);
    expect(lockPaths.get(ep.id)).toBeNull();
    await tracking.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// pi 1.5 observeCommits 回归：提交 drain 的镜像/屏障/轮次边界/失败通道。
// 关键回归面：>100 提交窗口无漏无重（旧 watch 50/100 滚动窗口会漏）、慢确认
// 屏障（先 delivered 后 consumed）、快速连续 run 不合并 turnEnd、warm 后半段
// 失败回滚、continue 投影显式不支持、session 失败通道、重开基线去重。
// ═══════════════════════════════════════════════════════════════════════════

describe("PiStreamPort: observeCommits 回归（pi 1.5）", () => {
  /** 与 beforeEach 相同的 deps，仅换 sessionFactory：假会话/失败注入用例用。 */
  function portWith(factory: SessionFactory): PiStreamPort {
    return new PiStreamPort({
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
        if (e) e.runtimeRef = sid;
      },
      setEndpointLease: (id, lease, until) => {
        const e = endpoints.get(id);
        if (e) {
          e.lease = lease;
          e.leaseUntil = until;
        }
      },
      setEndpointLock: () => {},
      stateDir: dir,
      idleEvictMs: 0,
      onDegraded: (info) => degraded.push(info),
    });
  }

  it("120 条 note：全量镜像一次，seqInStream 连续 1..120（>100 提交窗口回归）", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    for (let i = 0; i < 120; i++) {
      await port.note(ep.id, "mesh.audit", { envelopeId: `m_audit_${i}`, seq: i });
    }
    await waitFor(() => entries.filter((e) => e.entryType === "mesh.audit").length === 120);
    const audit = entries.filter((e) => e.entryType === "mesh.audit");
    expect(audit).toHaveLength(120);
    expect(new Set(audit.map((e) => e.entryId)).size).toBe(120); // 不重
    expect(audit.map((e) => e.seqInStream)).toEqual(
      Array.from({ length: 120 }, (_, i) => i + 1),
    ); // 不漏、不乱序
  });

  it("慢 entry 确认是完成屏障：确认落定前不发 turnEnd，turnEnd 携带 eligibleEntryIds", async () => {
    faux.setResponses([fauxAssistantMessage("reply")]);
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held: PortEntryEvent[] = [];
    port.onEntry(async (e) => {
      held.push(e);
      await gate;
    });
    const env = makeEnvelope("m_barrier");
    await port.deliver(ep.id, "hi", env, "followUp", { triggerTurn: true });
    await waitFor(() => held.some((e) => e.envelopeId === "m_barrier"));
    await new Promise((r) => setTimeout(r, 50));
    expect(turnEnds).toHaveLength(0); // 屏障内不得提前发 turnEnd（先 delivered 后 consumed）
    release();
    await waitFor(() => turnEnds.some((t) => t.endpointId === ep.id));
    const t = turnEnds.find((x) => x.endpointId === ep.id)!;
    const deliveredEntry = held.find((e) => e.envelopeId === "m_barrier")!.entryId;
    expect(t.eligibleEntryIds).toContain(deliveredEntry);
  });

  it("快速连续 run：旧 run→新 run 换手与 busy→idle 各发 turnEnd（不合并、不提前）", async () => {
    let releaseR1!: () => void;
    faux.setResponses([
      () =>
        new Promise((resolve) => {
          releaseR1 = () => resolve(fauxAssistantMessage("r1"));
        }),
      fauxAssistantMessage("r2"),
    ]);
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    await port.deliver(ep.id, "hi1", makeEnvelope("m_run_1"), "followUp", { triggerTurn: true });
    await port.deliver(ep.id, "hi2", makeEnvelope("m_run_2"), "followUp", { triggerTurn: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(turnEnds).toHaveLength(0); // run 1 未结束不提前发
    releaseR1();
    await waitFor(() => turnEnds.filter((t) => t.endpointId === ep.id).length >= 2);
    expect(faux.state.callCount).toBe(2);
    for (const t of turnEnds) expect(t.eligibleEntryIds).toBeDefined();
    expect(entries.some((e) => e.envelopeId === "m_run_1")).toBe(true);
    expect(entries.some((e) => e.envelopeId === "m_run_2")).toBe(true);
  });

  it("resume 由 port warm 末尾执行且只一次（factory 不自 resume）", async () => {
    let resumeCalls = 0;
    const s = fakeDurableSession() as { harness: { resume: () => void } };
    s.harness.resume = () => {
      resumeCalls += 1;
    };
    const factory: SessionFactory = {
      create: async () => ({ session: s as unknown, runtimeRef: "rs-ref" }),
      open: async () => ({ session: s as unknown }),
    };
    const spyPort = portWith(factory);
    const ep = addEndpoint();
    await spyPort.warm(ep.id, "shared");
    expect(ep.state).toBe("hot");
    expect(resumeCalls).toBe(1);
    await spyPort.dispose();
  });

  it("warm 后半段失败（基线抛错）回滚：NO_SESSION + unavailable + 锁释放，重试成功", async () => {
    const good = await createTestFactory(faux, dir);
    let attempts = 0;
    const flaky: SessionFactory = {
      create: async (ctx) => {
        attempts += 1;
        if (attempts === 1) {
          const s = fakeDurableSession() as { root: { entries: () => Promise<never> } };
          s.root.entries = () => Promise.reject(new Error("baseline boom"));
          return { session: s as unknown, runtimeRef: "bad-ref" };
        }
        return good.create(ctx);
      },
      open: (ctx) => good.open(ctx),
    };
    const flakyPort = portWith(flaky);
    const ep = addEndpoint();
    await expect(flakyPort.warm(ep.id, "shared")).rejects.toMatchObject({ code: "NO_SESSION" });
    expect(ep.state).toBe("unavailable");
    expect(await EndpointLock.readInfo(join(dir, "locks", `${ep.id}.lock`))).toBeUndefined();
    await flakyPort.warm(ep.id, "shared"); // 重试走 good 工厂
    expect(ep.state).toBe("hot");
    await flakyPort.dispose();
  });

  it("continue 提交投影显式不支持：submissionStatus 返回 null（不伪装成 input/write）", async () => {
    const s = fakeDurableSession() as { harness: { submission: () => Promise<unknown> } };
    s.harness.submission = () =>
      Promise.resolve({
        status: async () => ({ id: 7, type: "continue", status: "done" }),
      });
    const factory: SessionFactory = {
      create: async () => ({ session: s as unknown, runtimeRef: "cont-ref" }),
      open: async () => ({ session: s as unknown }),
    };
    const contPort = portWith(factory);
    const ep = addEndpoint();
    await contPort.warm(ep.id, "shared");
    expect(ep.state).toBe("hot");
    expect(await contPort.submissionStatus(ep.id, "7")).toBeNull();
    await contPort.dispose();
  });

  it("session 失败通道：harness.closed(kind=failed) → unavailable + session_failed 降级 + 锁释放", async () => {
    let endSession!: (end: { kind: string; error?: unknown }) => void;
    const s = fakeDurableSession() as { harness: { closed: Promise<unknown> } };
    s.harness.closed = new Promise((resolve) => {
      endSession = (end) => resolve(end);
    });
    const factory: SessionFactory = {
      create: async () => ({ session: s as unknown, runtimeRef: "fail-ref" }),
      open: async () => ({ session: s as unknown }),
    };
    const failPort = portWith(factory);
    const ep = addEndpoint();
    await failPort.warm(ep.id, "shared");
    expect(ep.state).toBe("hot");
    endSession({ kind: "failed", error: new Error("storage boom") });
    await waitFor(() => ep.state === "unavailable");
    expect(degraded.some((d) => d.reason === "session_failed" && d.endpointId === ep.id)).toBe(true);
    await waitFor(
      async () => (await EndpointLock.readInfo(join(dir, "locks", `${ep.id}.lock`))) === undefined,
    );
    await failPort.dispose();
  });

  it("harness.closed(kind=closed) 不算失败：流保持 hot（正常关闭由 evict 接管）", async () => {
    let endSession!: (end: { kind: string }) => void;
    const s = fakeDurableSession() as { harness: { closed: Promise<unknown> } };
    s.harness.closed = new Promise((resolve) => {
      endSession = (end) => resolve(end);
    });
    const factory: SessionFactory = {
      create: async () => ({ session: s as unknown, runtimeRef: "closed-ref" }),
      open: async () => ({ session: s as unknown }),
    };
    const closedPort = portWith(factory);
    const ep = addEndpoint();
    await closedPort.warm(ep.id, "shared");
    endSession({ kind: "closed" });
    await new Promise((r) => setTimeout(r, 50));
    expect(ep.state).toBe("hot");
    expect(degraded).toHaveLength(0);
    await closedPort.dispose();
  });

  it("evict 后重开：基线条目不重发，只镜像新条目", async () => {
    const ep = addEndpoint();
    await port.warm(ep.id, "shared");
    await port.deliver(ep.id, "first", makeEnvelope("m_reopen_1"), "followUp", { triggerTurn: false });
    await waitFor(() => entries.some((e) => e.envelopeId === "m_reopen_1"));
    await port.evict(ep.id);
    expect(ep.state).toBe("cold");
    await port.warm(ep.id, "shared");
    await port.deliver(ep.id, "second", makeEnvelope("m_reopen_2"), "followUp", { triggerTurn: false });
    await waitFor(() => entries.some((e) => e.envelopeId === "m_reopen_2"));
    expect(entries.filter((e) => e.envelopeId === "m_reopen_1")).toHaveLength(1);
    expect(entries.filter((e) => e.envelopeId === "m_reopen_2")).toHaveLength(1);
  });
});
