// ═══════════════════════════════════════════════════════════════════════════
// W09 · 跨进程请求应答（§14.5 持久终态闭环）。
//
// 两进程共享同一 DB（同 sameHost.test.ts 模式）：HostA 无应答方的锁 → outbox →
// HostB poller 认领投递。HostA 的 request(await) 在本进程收不到 message_acked 事件
//（应答在 HostB 进程发生），必须靠共享 DB 的 mesh_pending_acks 终态轮询 resolve；
// 本测试证明「跨进程 ack → 恰好一次、ok:true」的持久终态闭环。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import type { AckResult } from "../../src/core/types.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "e2e-session" }),
  open: async () => ({ session: {} }),
};

interface HostContext {
  host: MeshHost;
  port: FakeStreamPort;
  epId: string;
  dir: string;
}

async function makeHost(
  dbPath: string,
  accountId: string,
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

describe("sameHost 跨进程请求应答（§14.5）", () => {
  it("HostA request(await) → HostB 跨进程 ack → A 经共享 DB 轮询恰好一次 resolve", async () => {
    const dbPath = join(tmpdir(), `mesh-req-xproc-${Date.now()}.db`);

    const ctxA = await makeHost(dbPath, "A", { pollIntervalMs: 100, claimTtlMs: 5000 });
    const ctxB = await makeHost(dbPath, "B", { pollIntervalMs: 100, claimTtlMs: 5000 });
    await ctxA.host.warm(ctxA.epId);
    await ctxB.host.warm(ctxB.epId);

    // FakeStreamPort 不落端点锁：双向都需手动落锁（writerId ≠ 对方），
    // 使 A→B（请求）与 B→A（应答）都走 outbox（同 sameHost.test.ts 单侧做法）。
    const locksDir = join(ctxA.dir, "mesh", "locks");
    await mkdir(locksDir, { recursive: true });
    const foreignA = JSON.stringify({
      writerId: "foreign-a-" + Date.now(),
      pid: 99998,
      lease: "exclusive",
      acquiredAt: new Date().toISOString(),
      leaseUntil: null,
    });
    const foreignB = JSON.stringify({
      writerId: "foreign-b-" + Date.now(),
      pid: 99999,
      lease: "exclusive",
      acquiredAt: new Date().toISOString(),
      leaseUntil: null,
    });
    await writeFile(join(locksDir, `${ctxA.epId}.lock`), foreignA);
    await writeFile(join(locksDir, `${ctxB.epId}.lock`), foreignB);

    const conv = await ctxA.host.createConversation({
      type: "group",
      creator: "A",
      members: ["B"],
    });

    // HostA 阻塞请求；A 进程收不到 ack 事件，只能靠共享 DB 终态轮询
    let resolveCount = 0;
    const awaited = (
      ctxA.host.request(
        {
          from: "A",
          conversationId: conv.id,
          kind: "chat",
          expect: "ack",
          to: ["B"],
          text: "跨进程请求",
        },
        { await: true },
      ) as Promise<AckResult>
    ).then((r) => {
      resolveCount++;
      return r;
    });

    // 等 HostB 经 outbox 收到请求，从投递信封拿 correlationId
    let correlationId: string | undefined;
    for (let i = 0; i < 40 && !correlationId; i++) {
      await sleep(50);
      await flush();
      const d = ctxB.port.delivered.find(
        (x) => x.endpointId === ctxB.epId && x.envelope.expect === "ack",
      );
      correlationId = d?.envelope.correlationId;
    }
    expect(correlationId).toBeTruthy();

    // HostB 应答 → 共享 DB mesh_pending_acks 终态 'answered'（消息事件只在 B 进程）
    await ctxB.host.ack({ correlationId: correlationId!, from: "B", data: "ok" });

    const result = await Promise.race([
      awaited,
      sleep(4000).then((): AckResult => {
        throw new Error("跨进程 await 未在时限内终态解析（持久态轮询失效）");
      }),
    ]);

    expect(result).toMatchObject({ correlationId: correlationId, ok: true, from: "B", data: "ok" });
    expect(resolveCount).toBe(1); // 恰好一次

    // 应答回程也经 outbox 回到 A（端到端不丢实体消息）
    let answerBack = false;
    for (let i = 0; i < 40 && !answerBack; i++) {
      await sleep(50);
      await flush();
      answerBack = ctxA.port.delivered.some(
        (x) => x.endpointId === ctxA.epId && x.envelope.correlationId === correlationId,
      );
    }
    expect(answerBack).toBe(true);

    await assertInvariants(ctxA.host);
    await assertInvariants(ctxB.host);

    await ctxA.host.close();
    await ctxB.host.close();
  });
});