// ═══════════════════════════════════════════════════════════════════════════
// I01 + C02：写者统一 + 同机多进程归属（§19.3/§19.4）。
//
// I01 回归（writerId 统一）的关键：PiStreamPort 抢端点锁写的是「宿主注入的
// writerId」，因此端点锁文件里的 writerId 与宿主一致。由此：
//  - 同进程 warm 的端点被 isEndpointLocal 判「本地」→ 直派（绝不绕 outbox）；
//  - 他进程 warm 的端点（自然落锁，无需手动写锁文件）判「远程」→ outbox →
//    对端 poller 认领、handler 投递（收发路径正确）。
//
// C02：external 账号不 auto-warm、无 sink handler → NO_SINK_HANDLER park。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { loadPiSdk } from "../../src/pi/pi-sdk.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { createFaux, registerFauxInto, type FauxCore } from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "stub" }),
  open: async () => ({ session: {} }),
};

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

interface HostCtx {
  host: MeshHost;
  faux: FauxCore;
}

async function makeHost(
  dbPath: string,
  transportOptions?: Parameters<typeof createMesh>[0]["transportOptions"],
): Promise<HostCtx> {
  const cwd = join(dirname(dbPath), "sessions");
  mkdirSync(cwd, { recursive: true });
  const faux = await createFaux("faux-host");
  const factory = await createTestFactory(faux, cwd);
  const host = await createMesh({
    dbPath,
    policies: { sessionFactory: factory },
    transport: "sameHost",
    transportOptions,
    limits: { handoffTimeoutMs: 5000 },
  });
  return { host, faux };
}

async function registerStream(host: MeshHost, accountId: string): Promise<string> {
  await host.registerAccount({
    id: accountId,
    displayName: accountId,
    endpointClass: "stream",
    initiate: ["chat"],
  });
  const ep = await host.registerEndpoint({ accountId, topology: { kind: "unified" } });
  await host.setPresence(accountId, "available");
  return ep.id;
}

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-writerid-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("I01：写者统一后的同机归属（§19.3/§19.4）", () => {
  it("同进程 warm 的端点判本地直派；他进程 warm 的端点经 outbox 完成", async () => {
    const dir = tmp();
    const dbPath = join(dir, "mesh.db");

    // A 进程：账号 A（本地直派验证）+ 账号 C（同进程发往 A）
    const ctxA = await makeHost(dbPath);
    const epA = await registerStream(ctxA.host, "A");
    await ctxA.host.registerAccount({
      id: "C",
      displayName: "C",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    await ctxA.host.warm(epA, "shared"); // 自然落锁（writerId = A 进程的 writerId）

    // B 进程：账号 B（跨进程 outbox 验证）
    const ctxB = await makeHost(dbPath, { pollIntervalMs: 100, claimTtlMs: 5000 });
    const epB = await registerStream(ctxB.host, "B");
    await ctxB.host.warm(epB, "shared");

    // ── ① 同进程直派：C 发消息给 A（A 的端点归本进程，判本地，不绕 outbox）──
    const convLocal = await ctxA.host.createConversation({ type: "group", creator: "A", members: ["C"] });
    const localMsg = await ctxA.host.send({
      from: "C",
      conversationId: convLocal.id,
      kind: "chat",
      expect: "none",
      text: "同进程直派",
    });
    await flush();

    // ── ② 跨进程 outbox：A 发群消息给 B（B 的端点归 B 进程，判远程）──
    const convRemote = await ctxA.host.createConversation({ type: "group", creator: "A", members: ["B"] });
    await ctxA.host.send({
      from: "A",
      conversationId: convRemote.id,
      kind: "chat",
      expect: "none",
      text: "跨进程 outbox",
    });
    await sleep(400);
    await flush();

    const ro = new Database(dbPath, { readonly: true });
    // ① 给 A 的直派：mesh_deliveries 已指派到 epA、未 park，且绝不出现 epA 的 outbox 行
    const aDeliveries = ro
      .prepare("SELECT endpoint_id, parked_reason FROM mesh_deliveries WHERE account_id = ? AND message_id = ?")
      .all("A", localMsg.messageId) as Array<{ endpoint_id: string | null; parked_reason: string | null }>;
    expect(aDeliveries.length).toBe(1);
    expect(aDeliveries[0]!.endpoint_id).toBe(epA);
    expect(aDeliveries[0]!.parked_reason).toBeNull();
    const aOutbox = ro
      .prepare("SELECT state FROM mesh_outbox WHERE target_endpoint = ?")
      .all(epA) as Array<{ state: string }>;
    expect(aOutbox.length).toBe(0);

    // ② 给 B 的 outbox：存在且已完成（对端 poller 认领 → handler 投递 → ack done）
    const bOutbox = ro
      .prepare("SELECT state FROM mesh_outbox WHERE target_endpoint = ?")
      .all(epB) as Array<{ state: string }>;
    expect(bOutbox.length).toBeGreaterThanOrEqual(1);
    expect(bOutbox.every((r) => r.state === "done")).toBe(true);
    ro.close();

    // 不变式仍绿
    await assertInvariants(ctxA.host);
    await assertInvariants(ctxB.host);

    await ctxA.host.close();
    await ctxB.host.close();
  });
});

describe("C02：external 不 auto-warm、无 handler → NO_SINK_HANDLER", () => {
  it("external 账号投递落 NO_SINK_HANDLER，且不触发任何 stream warm", async () => {
    const dir = tmp();
    const dbPath = join(dir, "mesh.db");
    const port = new FakeStreamPort();

    const host = await createMesh({
      dbPath,
      policies: { sessionFactory: stubSessionFactory },
      streamPort: port,
    });
    await host.registerAccount({ id: "A", displayName: "A", endpointClass: "stream", initiate: ["chat"] });
    await host.registerEndpoint({ accountId: "A", topology: { kind: "unified" } });
    await host.registerAccount({ id: "E", displayName: "E", endpointClass: "external", initiate: [] });
    // 不注册 sink handler —— 缺失 handler 应 park NO_SINK_HANDLER

    const conv = await host.createConversation({ type: "group", creator: "A", members: ["E"] });
    await host.send({ from: "A", conversationId: conv.id, kind: "chat", expect: "none", text: "给 external" });
    await flush();

    const ro = new Database(dbPath, { readonly: true });
    const extRows = ro
      .prepare("SELECT parked_reason FROM mesh_deliveries WHERE account_id = ? AND parked_reason IS NOT NULL")
      .all("E") as Array<{ parked_reason: string }>;
    ro.close();
    expect(extRows.map((r) => r.parked_reason)).toContain("NO_SINK_HANDLER");

    // external 无端点、无本地流：永不 auto-warm（A 是发送方自身也被 fanout 排除，不触发 warm）
    expect(port.warmed).toEqual([]);

    await host.close();
  });
});