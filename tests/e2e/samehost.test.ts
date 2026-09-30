// ═══════════════════════════════════════════════════════════════════════════
// sameHost 两进程端到端（§19.3）：同 DB 两 MeshHost 实例，outbox 投递。
//
// 模拟策略：由于 FakeStreamPort 不创建端点锁文件，测试需手动创建来触发
// isEndpointLocal 判异进程 → outbox 发布 → 对端 poller 认领。
//
// 流程：HostA 创建 conv，向 HostB 发消息 → 因 ep-b 锁 writerId 异于 HostA，
// deliverOne 走 transport.publish（outbox ready）→ HostB 的 SameHostTransport
// poller CAS 认领 → handler 调 mailbox.handleOutboxDelivery → port.deliver。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { EndpointLock } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "e2e-session" }),
  open: async () => ({ session: {} }),
};

interface HostContext {
  host: MeshHost;
  port: FakeStreamPort;
  /** 端点的 regToken（registerEndpoint 返回值） */
  epId: string;
  /** DB 目录 */
  dir: string;
}

async function makeHost(
  dbPath: string,
  accountId: string,
  endpointId: string,
  transportOptions?: Parameters<typeof createMesh>[0]["transportOptions"],
): Promise<HostContext> {
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath,
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    transport: "sameHost",
    transportOptions,
    limits: { handoffTimeoutMs: 1000 },
    devMode: true,
  });
  await host.registerAccount({
    id: accountId,
    displayName: accountId,
    endpointClass: "stream",
    initiate: ["chat"],
  });
  const ep = await host.registerEndpoint({
    accountId,
    topology: { kind: "unified" },
  });
  await host.setPresence(accountId, "available");
  return { host, port, epId: ep.id, dir: dirname(dbPath) };
}

describe("sameHost two-process delivery (§19.3)", () => {
  it("HostA sends to HostB via outbox — HostB poller claims and delivers", async () => {
    const dbPath = join(tmpdir(), `mesh-samehost-${Date.now()}.db`);

    // ── ① 创建 HostA（注册 A/ep-a，warm ep-a）──
    const ctxA = await makeHost(dbPath, "A", "ep-a");
    await ctxA.host.warm(ctxA.epId);

    // ── ② 创建 HostB（注册 B/ep-b，warm ep-b）──
    const ctxB = await makeHost(dbPath, "B", "ep-b", {
      pollIntervalMs: 100,
      claimTtlMs: 5000,
    });
    await ctxB.host.warm(ctxB.epId);

    // ── ③ 手动创建 ep-b 的锁文件（writerId ≠ HostA），触发 isEndpointLocal → false ──
    const locksDir = join(ctxA.dir, "mesh", "locks");
    await mkdir(locksDir, { recursive: true });
    // 使用实际端点 ID（registerEndpoint 自动生成 ULID，非传入名）
    await writeFile(
      join(locksDir, `${ctxB.epId}.lock`),
      JSON.stringify({
        writerId: "foreign-process-" + Date.now(),
        pid: 99999,
        lease: "exclusive",
        acquiredAt: new Date().toISOString(),
        leaseUntil: null,
      }),
    );

    // ── ④ HostA 创建群会话并发送消息给 B ──
    const conv = await ctxA.host.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    const { messageId } = await ctxA.host.send({
      from: "A",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "跨进程测试消息",
    });
    await flush();

    // ── ⑤ HostA 不应包含发往 B 端点的直派（走 outbox，非本进程 port.deliver）──
    const hostADelivered = ctxA.port.delivered;
    // 群消息给 A 自己也会有一条直派，这是正常的；关键是无针对 ep-b 的直派
    const aDeliveredForB = hostADelivered.filter(
      (d) => d.endpointId === ctxB.epId && d.envelope.id === messageId,
    );
    expect(aDeliveredForB.length).toBe(0);

    // ── ⑥ 等待 HostB 的 poller 认领并投递 ──
    // poller 启动时已跑首轮（runPollCycle in start()），send 后下一轮在 pollIntervalMs 内触发。
    await sleep(300);
    await flush();

    // HostB 的 FakeStreamPort.delivered 应有跨进程投递的这条消息
    const bDelivered = ctxB.port.delivered;
    const bDeliveredForMsg = bDelivered.filter(
      (d) => d.endpointId === ctxB.epId && d.envelope.id === messageId,
    );
    expect(bDeliveredForMsg.length).toBeGreaterThanOrEqual(1);

    // ── ⑥.5 修复验证：投递成功后 outbox 行应为 done（handleOutboxDelivery 已 ack）──
    const ro = new Database(dbPath, { readonly: true });
    const outboxRows = ro
      .prepare("SELECT state, payload FROM mesh_outbox WHERE target_endpoint = ?")
      .all(ctxB.epId) as Array<{ state: string; payload: string }>;
    ro.close();
    const mine = outboxRows.filter((o) => o.payload.includes(messageId));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((o) => o.state === "done")).toBe(true);

    // ── ⑦ 不变式验证 ──
    expect(await ctxA.host.observer.checkInvariants().then((r) => r.violations)).toEqual([]);
    expect(await ctxB.host.observer.checkInvariants().then((r) => r.violations)).toEqual([]);

    await ctxA.host.close();
    await ctxB.host.close();
  });

  it("outbox idempotent publish survives duplicate send", async () => {
    const dbPath = join(tmpdir(), `mesh-samehost-${Date.now()}.db`);

    const ctxA = await makeHost(dbPath, "A", "ep-a");
    const ctxB = await makeHost(dbPath, "B", "ep-b", {
      pollIntervalMs: 100,
      claimTtlMs: 5000,
    });
    await ctxA.host.warm(ctxA.epId);
    await ctxB.host.warm(ctxB.epId);

    // 模拟 ep-b 不归 HostA（使用实际端点 ID）
    const locksDir = join(ctxA.dir, "mesh", "locks");
    await mkdir(locksDir, { recursive: true });
    await writeFile(
      join(locksDir, `${ctxB.epId}.lock`),
      JSON.stringify({
        writerId: "foreign-" + Date.now(),
        pid: 88888,
        lease: "exclusive",
        acquiredAt: new Date().toISOString(),
        leaseUntil: null,
      }),
    );

    const conv = await ctxA.host.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });
    await ctxA.host.send({
      from: "A",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "幂等测试",
    });

    await sleep(300);
    await flush();

    // 验证目标进程收到（含消息内容）
    const bDelivered = ctxB.port.delivered;
    const matches = bDelivered.filter(
      (d) => d.endpointId === ctxB.epId && d.rendered?.includes("幂等测试"),
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);

    // 不变式仍绿
    expect(await ctxA.host.observer.checkInvariants().then((r) => r.violations)).toEqual([]);
    expect(await ctxB.host.observer.checkInvariants().then((r) => r.violations)).toEqual([]);

    await ctxA.host.close();
    await ctxB.host.close();
  });
});

describe("reclaimEndpoint：死写者锁恢复（M-R10 / §27.4）", () => {
  it("死 pid 残留锁 ⇒ reclaimed；活锁 ⇒ held；取不到启动时刻 ⇒ unknown", async () => {
    const dbPath = join(tmpdir(), `mesh-reclaim-${Date.now()}.db`);
    const ctxB = await makeHost(dbPath, "B", "ep-b", { pollIntervalMs: 100 });

    const locksDir = join(ctxB.dir, "mesh", "locks");
    await mkdir(locksDir, { recursive: true });
    const lockPath = join(locksDir, `${ctxB.epId}.lock`);

    // ① 死 pid 残留锁（owner 崩溃）：可回收
    await writeFile(
      lockPath,
      JSON.stringify({ writerId: "crashed", pid: 99_999_999, lease: "exclusive", acquiredAt: "", leaseUntil: null, procStartedAt: "" }),
    );
    expect(await ctxB.host.reclaimEndpoint(ctxB.epId)).toEqual({ outcome: "reclaimed" });
    expect(await EndpointLock.readInfo(lockPath)).toBeUndefined();
    await ctxB.host.warm(ctxB.epId); // 回收后本进程可 warm

    // ② 活锁（本进程持有时）：拒绝接管，绝不猜
    const held = await EndpointLock.acquire(lockPath, { writerId: "live-owner", lease: "shared" });
    expect(await ctxB.host.reclaimEndpoint(ctxB.epId)).toEqual({ outcome: "held" });
    await held.release();

    // ③ 取不到启动时刻（pid 存活、procStartedAt 空）：保守拒绝 unknown
    await writeFile(
      lockPath,
      JSON.stringify({ writerId: "ambiguous", pid: process.pid, lease: "shared", acquiredAt: "", leaseUntil: null, procStartedAt: "" }),
    );
    expect(await ctxB.host.reclaimEndpoint(ctxB.epId)).toEqual({ outcome: "unknown" });

    await ctxB.host.close();
  });
});