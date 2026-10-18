// ═══════════════════════════════════════════════════════════════════════════
// W09 · 请求应答 host 面端到端（I11 + C06，§14.3–§14.6）。
//
// 走 createMesh + FakeStreamPort（§23.5），直读共享 DB 断言持久终态：
// - C06：重复/冲突 ack——身份校验优先于幂等（非目标对已应答 id 报 NO_SUCH_CORRELATION，
//   目标重复 ack 幂等、不产生第二条应答消息）；
// - §14.5：request(await) 恰好一次——快 ack（同进程事件路径）与超时、
//   会话解散（abandoned 静默）各自唯一终态；
// - §14.4：dissolve → open pending 置 abandoned（静默，无 request_timeout / message_acked），
//   等待中的 await 以 abandoned 终态恰好一次解析。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createMesh } from "../../src/index.js";
import type { Account, MeshHost, SessionFactory } from "../../src/index.js";
import type { AckResult } from "../../src/core/types.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "e2e-session" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface MeshWorld {
  host: MeshHost;
  port: FakeStreamPort;
  dbPath: string;
}

async function makeMesh(extraLimits: Record<string, unknown> = {}): Promise<MeshWorld> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-req-"));
  const dbPath = join(dir, "mesh.db");
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath,
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits: { handoffTimeoutMs: 1000, ...extraLimits },
    devMode: true,
  });
  return { host, port, dbPath };
}

async function makeSpeaker(
  host: MeshHost,
  id: string,
): Promise<{ account: Account; endpointId: string }> {
  const account = await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat"],
  });
  const endpoint = await host.registerEndpoint({
    accountId: id,
    topology: { kind: "unified" },
  });
  await host.setPresence(id, "available");
  return { account, endpointId: endpoint.id };
}

/** 轮询直到某账号出现待应答（awaitingMyAck），返回 correlationId。 */
async function waitForAwaitingAck(host: MeshHost, accountId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const inbox = await host.observer.inboxOf(accountId);
    const corr = inbox.awaitingMyAck[0]?.correlationId;
    if (corr) return corr;
    await flush();
  }
  throw new Error(`account ${accountId} 未在时限内出现待应答`);
}

/** 按 correlationId + from 统计某账号发出的消息数。 */
function answerCount(dbPath: string, correlationId: string, from: string): number {
  const db = new Database(dbPath, { readonly: true });
  const n = db
    .prepare<[string, string], { n: number }>(
      "SELECT COUNT(*) AS n FROM mesh_messages WHERE correlation_id = ? AND from_account = ?",
    )
    .get(correlationId, from)!.n;
  db.close();
  return n;
}

function pendingState(dbPath: string, correlationId: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare<[string], { state: string }>(
      "SELECT state FROM mesh_pending_acks WHERE correlation_id = ?",
    )
    .get(correlationId) as { state: string } | undefined;
  db.close();
  return row?.state;
}

// ─── C06：重复 / 冲突 ack 的唯一正确终态 ───────────────────────────────────

describe("W09: ack 身份与幂等（C06）", () => {
  it("非目标对已应答 id 报 NO_SUCH_CORRELATION；目标重复 ack 幂等且不产生第二条应答", async () => {
    const { host, dbPath } = await makeMesh();
    try {
      await makeSpeaker(host, "A");
      await makeSpeaker(host, "B");
      await makeSpeaker(host, "C");
      const conv = await host.createConversation({
        type: "group",
        creator: "A",
        members: ["B", "C"],
      });

      const req = (await host.request({
        from: "A",
        conversationId: conv.id,
        kind: "chat",
        expect: "ack",
        to: ["B"],
        text: "请回答",
      })) as { correlationId: string };
      const corr = req.correlationId;

      // 目标 B 第一次 ack → answered
      await host.ack({ correlationId: corr, from: "B", data: "done" });
      expect(pendingState(dbPath, corr)).toBe("answered");
      expect(answerCount(dbPath, corr, "B")).toBe(1);

      // 非目标 C（从未被期待）→ NO_SUCH_CORRELATION，不伪装成功
      await expect(
        host.ack({ correlationId: corr, from: "C", data: "hijack" }),
      ).rejects.toMatchObject({ code: "NO_SUCH_CORRELATION" });

      // 目标 B 重复 ack → 幂等，无第二条应答消息
      await host.ack({ correlationId: corr, from: "B", data: "again" });
      expect(answerCount(dbPath, corr, "B")).toBe(1);
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });
});

// ─── request(await) 恰好一次 ───────────────────────────────────────────────

describe("W09: request(await) 恰好一次（§14.5）", () => {
  it("快 ack：同进程事件路径 resolve 一次，data/ok/from 正确", async () => {
    const { host } = await makeMesh();
    try {
      await makeSpeaker(host, "A");
      await makeSpeaker(host, "B");
      const conv = await host.ensureDirect("A", "B");

      const p = host.request(
        {
          from: "A",
          conversationId: conv.id,
          kind: "chat",
          expect: "ack",
          to: ["B"],
          text: "请回答",
        },
        { await: true },
      ) as Promise<AckResult>;

      // 从 B 的待应答列表拿到 correlationId，再 ack
      const corr = await waitForAwaitingAck(host, "B");
      await host.ack({ correlationId: corr, from: "B", data: "done" });

      const result = await p;
      expect(result).toMatchObject({
        correlationId: corr,
        ok: true,
        from: "B",
        data: "done",
      });
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });

  it("超时：无 ack 时以 timedOut 终态 resolve 一次", async () => {
    // ackTimeoutMs 下限 1000；sweep 每 1000ms 扫描 deadline 过期
    const { host } = await makeMesh({ ackTimeoutMs: 1000, sweepIntervalMs: 1000 });
    try {
      await makeSpeaker(host, "A");
      await makeSpeaker(host, "B");
      const conv = await host.ensureDirect("A", "B");

      const p = host.request(
        {
          from: "A",
          conversationId: conv.id,
          kind: "chat",
          expect: "ack",
          to: ["B"],
          text: "请回答",
        },
        { await: true },
      ) as Promise<AckResult>;

      const result = await Promise.race([
        p,
        sleep(4000).then((): AckResult => {
          throw new Error("request(await) 未在超时内终态解析");
        }),
      ]);
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.correlationId).toBeTruthy();
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });

  it("dissolve → abandoned：静默终态 resolve 一次，不回退 pending、无应答消息", async () => {
    const { host, dbPath } = await makeMesh();
    try {
      await makeSpeaker(host, "A");
      await makeSpeaker(host, "B");
      const conv = await host.createConversation({
        type: "group",
        creator: "A",
        members: ["B"],
      });

      const p = host.request(
        {
          from: "A",
          conversationId: conv.id,
          kind: "chat",
          expect: "ack",
          to: ["B"],
          text: "请回答",
        },
        { await: true },
      ) as Promise<AckResult>;

      const corr = await waitForAwaitingAck(host, "B");

      // 解散会话：open pending → abandoned（静默，无 request_timeout/message_acked）
      await host.dissolve(conv.id, "A");

      const result = await p; // 轮询（50ms）读持久终态 abandoned
      expect(result.ok).toBe(false);
      expect(result.abandoned).toBe(true);
      expect(result.timedOut).toBeUndefined();
      expect(pendingState(dbPath, corr)).toBe("abandoned");
      // 静默：B 之外不产生任何应答消息（correlationId 下无新消息）
      expect(answerCount(dbPath, corr, "B")).toBe(0);
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });
});