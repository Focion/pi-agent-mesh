// ═══════════════════════════════════════════════════════════════════════════
// 端到端验收（PLAN §3 / 规范 §25.1–§25.2）。全部走 createMesh + FakeStreamPort。
//
// P0（§25.1）：
//   1. 两账号互发 10 条，全部到达 consumed。
//   2. sink 账号收到全部 10 条并能 markConsumed。
//   3. checkInvariants() 全绿。
// P1（§25.2）：
//   1. 20 账号群 × 50 条：每消息平均唤醒 ≤1.2（idle），busy 分支 =0。
//   2. 同场景：每消息平均原文份数 ≤3。
//   3. expect:"reply" 且 to 指向收件人自己 → 必定唤醒（A1 无例外）。
//   4. expect:"none" → triggerTurn===true 次数 = 0。
//
// 关键机制（所有 P1 断言的共同根基）：§7.4 刚性条款——从未发言且从未被 @ 的
// 成员恒定超预算 ⇒ 广播不产生原文份数、不唤醒。只有 expect:"reply" 指向的人
// 因「被请求答复 ⇒ 本条按预算内投」跃迁而醒来。
//
// FakeStreamPort.deliver 同步回吐 entry_appended；triggerTurn 经 queueMicrotask
// 回吐 turn_end——断言前必须 flush 一个宏任务（§23.5）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type {
  Account,
  MeshHost,
  SessionFactory,
  SinkHandler,
} from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

/** sessionFactory 是唯一必填槽（§12.1）；e2e 只用 FakeStreamPort，永不被调 */
const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "e2e-session" }),
  open: async () => ({ session: {} }),
};

/** FakeStreamPort 的 turn_end 走 queueMicrotask —— flush 一个宏任务确保落盘 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface MeshWorld {
  host: MeshHost;
  port: FakeStreamPort;
}

async function makeMesh(): Promise<MeshWorld> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-e2e-"));
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    // P2 落账的投递（queued 不消费）会在 close() 的 handoff 收敛循环里计数；
    // 收敛本身只在真实 in-flight handoff 上有意义，这里收紧死线避免测试挂 30s。
    limits: { handoffTimeoutMs: 20 },
    devMode: true,
  });
  return { host, port };
}

/** 注册一个可说话的 stream 账号 + unified 端点，并设为 available（避开 A2） */
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

describe("P0 acceptance (§25.1)", () => {
  it("two accounts exchange 10 messages, all consumed", async () => {
    const { host, port } = await makeMesh();
    try {
      await makeSpeaker(host, "alice");
      await makeSpeaker(host, "bob");
      const conv = await host.ensureDirect("alice", "bob");

      const messageIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const from = i % 2 === 0 ? "alice" : "bob";
        const r = await host.send({
          from,
          conversationId: conv.id,
          kind: "chat",
          expect: "none",
          text: `hello ${i}`,
        });
        messageIds.push(r.messageId);
      }
      await flush();

      // 10 条消息 → 10 条 delivery（每条只投给对端），全部 consumed
      const states: string[] = [];
      for (const id of messageIds) {
        const traces = await host.observer.trace(id);
        expect(traces).toHaveLength(1);
        states.push(traces[0]!.state);
      }
      expect(states).toHaveLength(10);
      expect(states.every((s) => s === "consumed")).toBe(true);

      // FakeStreamPort 侧：10 次投递、10 次唤醒（direct 任何消息都醒，§7.3 规则②）
      expect(port.delivered).toHaveLength(10);
      expect(port.wakeCount()).toBe(10);

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("sink account receives 10 and acks via markConsumed", async () => {
    const { host } = await makeMesh();
    try {
      await makeSpeaker(host, "alice");
      const received: string[] = [];
      const sink: SinkHandler = {
        deliver: async (_rendered, envelope) => {
          received.push(envelope.id);
          return { accepted: true, consumedImmediately: false };
        },
      };
      const worker = await host.registerAccount({
        id: "worker",
        displayName: "worker",
        endpointClass: "sink",
      });
      await host.registerSinkHandler("worker", sink);
      const conv = await host.ensureDirect("alice", "worker");

      const messageIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await host.send({
          from: "alice",
          conversationId: conv.id,
          kind: "chat",
          expect: "none",
          text: `task ${i}`,
        });
        messageIds.push(r.messageId);
      }
      await flush();

      expect(worker.endpointClass).toBe("sink");
      expect(received).toHaveLength(10);

      // 每条 delivery 先到 delivered（accepted 即 delivered，§6.3③），再 ack → consumed
      const deliveryIds: string[] = [];
      for (const id of messageIds) {
        const traces = await host.observer.trace(id);
        expect(traces).toHaveLength(1);
        expect(traces[0]!.state).toBe("delivered");
        deliveryIds.push(traces[0]!.deliveryId);
      }
      for (const d of deliveryIds) await host.markConsumed(d);
      await flush();

      for (const id of messageIds) {
        const traces = await host.observer.trace(id);
        expect(traces.every((t) => t.state === "consumed")).toBe(true);
      }

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("P1 acceptance (§25.2)", () => {
  it("20-account group × 50 messages: wake ≤ 1.2 idle, verbatim ≤ 3", async () => {
    const { host, port } = await makeMesh();
    try {
      for (let i = 0; i < 20; i++) await makeSpeaker(host, `g${i}`);
      const conv = await host.createConversation({
        type: "group",
        creator: "g0",
        members: Array.from({ length: 19 }, (_, i) => `g${i + 1}`),
      });

      // g0 群发 50 条 expect:"none"：收件人从未发言 ⇒ 恒定超预算（§7.4 刚性条款），
      // 既不 wake 也不给原文。这是 §24.2 两条硬门槛「分子必须被压住」的场景。
      for (let i = 0; i < 50; i++) {
        await host.send({
          from: "g0",
          conversationId: conv.id,
          kind: "chat",
          expect: "none",
          text: `broadcast ${i}`,
        });
      }
      await flush();

      const c = await host.observer.counters([
        "messages_total",
        "verbatim_copies",
        "wake_per_message_idle",
        "wake_per_message_busy",
      ]);
      // counters() 对请求的名字缺省补 0，故用非空断言（§23.3）
      const messages = c.messages_total!;
      expect(messages).toBeGreaterThanOrEqual(50);
      // 硬门槛：每消息平均原文份数 ≤ 3、每消息平均唤醒（idle）≤ 1.2、busy 分支 = 0
      expect(c.verbatim_copies! / messages).toBeLessThanOrEqual(3);
      expect(c.wake_per_message_idle! / messages).toBeLessThanOrEqual(1.2);
      expect(c.wake_per_message_busy).toBe(0);
      // FakeStreamPort 侧印证：expect:"none" 广播 → triggerTurn:true = 0（§25.2④同源）
      expect(port.wakeCount()).toBe(0);

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('expect:"reply" targeting the recipient wakes (A1 has no exception)', async () => {
    const { host, port } = await makeMesh();
    try {
      await makeSpeaker(host, "requester");
      const responder = await makeSpeaker(host, "responder");
      const conv = await host.createConversation({
        type: "group",
        creator: "requester",
        members: ["responder"],
      });

      const r = await host.send({
        from: "requester",
        conversationId: conv.id,
        kind: "chat",
        expect: "reply",
        to: ["responder"],
        text: "please reply",
      });
      await flush();

      // 收件人即「to 指向的自己」：被请求答复 ⇒ 按预算内投，规则③唤醒
      const traces = await host.observer.trace(r.messageId);
      const mine = traces.find((t) => t.accountId === "responder");
      expect(mine).toBeDefined();
      expect(mine!.woke).toBe(true);
      expect(port.wakeCountByEndpoint(responder.endpointId)).toBeGreaterThanOrEqual(1);

      // 计数器确实动了（证明不是「全部归零」的假达标）：唤醒 + 原文各至少 1
      const c = await host.observer.counters([
        "wake_per_message_idle",
        "verbatim_copies",
      ]);
      expect(c.wake_per_message_idle).toBeGreaterThanOrEqual(1);
      expect(c.verbatim_copies).toBeGreaterThanOrEqual(1);
    } finally {
      await host.close();
    }
  });

  it('expect:"none" produces zero triggerTurn:true deliveries', async () => {
    const { host, port } = await makeMesh();
    try {
      await makeSpeaker(host, "a");
      await makeSpeaker(host, "b");
      await makeSpeaker(host, "c");
      const conv = await host.createConversation({
        type: "group",
        creator: "a",
        members: ["b", "c"],
      });

      for (let i = 0; i < 5; i++) {
        await host.send({
          from: "a",
          conversationId: conv.id,
          kind: "chat",
          expect: "none",
          text: `quiet ${i}`,
        });
      }
      await flush();

      // 全部 expect:"none"，且 b/c 从未发言 ⇒ 零唤醒（§25.2④）
      expect(port.wakeCount()).toBe(0);
      expect(port.delivered.every((d) => d.triggerTurn === false)).toBe(true);
    } finally {
      await host.close();
    }
  });
});