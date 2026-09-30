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
    // 收敛本身只在真实 in-flight handoff 上有意义，取 F.1 允许范围下限而非默认 30s。
    limits: { handoffTimeoutMs: 1000 },
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

/** 注册一个可发布 event / task / chat 的 stream 账号（话题发布者、队列生产者） */
async function makeProducer(host: MeshHost, id: string): Promise<Account> {
  const account = await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat", "event", "task"],
  });
  await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
  await host.setPresence(id, "available");
  return account;
}

/** 注册一个保持 offline 的 stream worker：投递停在 delivered、不被唤醒/消费（claim 的前提） */
async function makeWorker(host: MeshHost, id: string): Promise<Account> {
  const account = await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
  });
  await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
  return account;
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

describe("topic subscribe/unsubscribe (§16.3)", () => {
  it("publish reaches a subscribed reader without waking it", async () => {
    const { host, port } = await makeMesh();
    try {
      await makeProducer(host, "pub");
      await makeSpeaker(host, "sub");
      const topic = await host.createConversation({ type: "topic", creator: "pub" });
      await host.subscribe(topic.id, "sub");

      const r = await host.send({
        from: "pub",
        conversationId: topic.id,
        kind: "event",
        expect: "none",
        text: "hello subscribers",
      });

      // 订阅者收到一条投递（topic 走 P3 静默路径：只记账，不唤醒）
      const ids = await host.observer.trace(r.messageId);
      expect(ids).toHaveLength(1);
      expect(ids[0]!.accountId).toBe("sub");
      expect(ids[0]!.woke).toBe(false);
      expect(port.wakeCount()).toBe(0);

      const inbox = await host.observer.inboxOf("sub");
      const conv = inbox.conversations.find((c) => c.conversationId === topic.id);
      expect(conv?.unread).toBe(1);

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("unsubscribed reader receives nothing", async () => {
    const { host } = await makeMesh();
    try {
      await makeProducer(host, "pub");
      await makeSpeaker(host, "sub");
      const topic = await host.createConversation({ type: "topic", creator: "pub" });
      await host.subscribe(topic.id, "sub");
      await host.unsubscribe(topic.id, "sub");

      const r = await host.send({
        from: "pub",
        conversationId: topic.id,
        kind: "event",
        expect: "none",
        text: "nobody listening",
      });

      expect(await host.observer.trace(r.messageId)).toHaveLength(0);

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("topic history (§16 / D2：订阅区间可见)", () => {
  it("subscriber reads only messages from the subscription start", async () => {
    const { host } = await makeMesh();
    try {
      await makeProducer(host, "pub");
      const sub = await makeSpeaker(host, "sub");
      const topic = await host.createConversation({ type: "topic", creator: "pub" });

      await host.send({
        from: "pub",
        conversationId: topic.id,
        kind: "event",
        expect: "none",
        text: "before-subscribe",
      }); // seq 1

      await host.subscribe(topic.id, "sub", { fromSeq: 2 });

      await host.send({
        from: "pub",
        conversationId: topic.id,
        kind: "event",
        expect: "none",
        text: "after-subscribe",
      }); // seq 2

      const tool = host.toolSet(sub.endpointId).find((t) => t.name === "mesh_history")!;
      const res = await tool.execute("tc_1", { conversationId: topic.id }, undefined, undefined, undefined);
      const content = typeof res.content === "string" ? res.content : res.content[0]!.text;
      const body = JSON.parse(content) as { messages: Array<{ text: string; seq: number }> };
      expect(body.messages.map((m) => m.text)).toEqual(["after-subscribe"]);
    } finally {
      await host.close();
    }
  });

  it("non-subscriber gets NOT_A_MEMBER", async () => {
    const { host } = await makeMesh();
    try {
      await makeProducer(host, "pub");
      const sub = await makeSpeaker(host, "sub");
      const topic = await host.createConversation({ type: "topic", creator: "pub" });

      const tool = host.toolSet(sub.endpointId).find((t) => t.name === "mesh_history")!;
      const res = await tool.execute("tc_1", { conversationId: topic.id }, undefined, undefined, undefined);
      const content = typeof res.content === "string" ? res.content : res.content[0]!.text;
      const body = JSON.parse(content) as { error?: { code: string } };
      expect(body.error?.code).toBe("NOT_A_MEMBER");
    } finally {
      await host.close();
    }
  });
});

describe("shared spaces (§18)", () => {
  it("put/get/list/del round-trip with versioning and CAS", async () => {
    const { host } = await makeMesh();
    try {
      await host.registerAccount({ id: "owner", displayName: "owner", endpointClass: "stream" });

      const put = await host.shared.put("global", "greeting", { hello: "world" }, { as: "owner" });
      expect(put.version).toBe(1);

      const got = await host.shared.get("global", "greeting", { as: "owner" });
      expect(got).not.toBeNull();
      expect(got!.data).toEqual({ hello: "world" });
      expect(got!.version).toBe(1);

      const list = await host.shared.list("global", { as: "owner" });
      expect(list.map((m) => m.key)).toContain("greeting");

      // CAS：带预期版本更新 → version 递增；版本不匹配 → reject VERSION_MISMATCH
      const put2 = await host.shared.put("global", "greeting", { hello: "again" }, { as: "owner", expectedVersion: 1 });
      expect(put2.version).toBe(2);
      const got2 = await host.shared.get("global", "greeting", { as: "owner" });
      expect(got2!.data).toEqual({ hello: "again" });
      await expect(
        host.shared.put("global", "greeting", {}, { as: "owner", expectedVersion: 99 }),
      ).rejects.toMatchObject({ code: "VERSION_MISMATCH" });

      // del 后 get 返回 null（tombstoned），list 不再列出
      await host.shared.del("global", "greeting", { as: "owner" });
      expect(await host.shared.get("global", "greeting", { as: "owner" })).toBeNull();
      const listAfter = await host.shared.list("global", { as: "owner" });
      expect(listAfter.map((m) => m.key)).not.toContain("greeting");

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("queue claim/requeue (§17)", () => {
  it("claim a delivered task, ack it, delivery reaches acked", async () => {
    const { host } = await makeMesh();
    try {
      await makeProducer(host, "producer");
      await makeWorker(host, "worker");
      const q = await host.createConversation({ type: "queue", creator: "producer", members: ["worker"] });

      const r = await host.send({ from: "producer", conversationId: q.id, kind: "task", expect: "none", text: "job" });
      const envs = await host.observer.messages({ conversationId: q.id });
      const env = envs.find((e) => e.id === r.messageId)!;
      expect(env.expect).toBe("ack");

      // offline worker 不被唤醒/消费，投递停在 delivered → claim 方可命中（C3）
      const claim = await host.claim(r.messageId, "worker");
      expect(claim.ok).toBe(true);
      let trace = await host.observer.trace(r.messageId);
      expect(trace).toHaveLength(1);
      expect(trace[0]!.state).toBe("claimed");

      await host.ack({ correlationId: env.correlationId!, from: "worker" });
      trace = await host.observer.trace(r.messageId);
      expect(trace[0]!.state).toBe("acked");

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("requeue moves a task into another queue conversation", async () => {
    const { host } = await makeMesh();
    try {
      await makeProducer(host, "producer");
      await makeSpeaker(host, "w1");
      await makeWorker(host, "w2");
      const q1 = await host.createConversation({ type: "queue", creator: "producer", members: ["w1"] });
      const q2 = await host.createConversation({ type: "queue", creator: "producer", members: ["w2"] });

      const r = await host.send({ from: "producer", conversationId: q1.id, kind: "task", expect: "none", text: "job" });
      await flush(); // w1（available）唤醒后 turn_end 把投递推进 consumed

      await host.requeue(r.messageId, q2.id);

      // 目标队列里出现一条同 payload 的新消息，投给 q2 的消费者 w2
      const q2msgs = await host.observer.messages({ conversationId: q2.id });
      expect(q2msgs).toHaveLength(1);
      expect(q2msgs[0]!.payload.text).toBe("job");
      const inbox = await host.observer.inboxOf("w2");
      expect(inbox.conversations.find((c) => c.conversationId === q2.id)?.unread).toBe(1);

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("request-response (§14)", () => {
  it("request(expect:ack) correlates to an answer delivered back to the requester", async () => {
    const { host } = await makeMesh();
    try {
      await makeSpeaker(host, "requester");
      await makeSpeaker(host, "responder");
      const conv = await host.ensureDirect("requester", "responder");

      const req = await host.request({
        from: "requester",
        conversationId: conv.id,
        kind: "chat",
        expect: "ack",
        to: ["responder"],
      });
      const correlationId = (req as { correlationId: string }).correlationId;
      expect(correlationId).toBeTruthy();

      // responder 有一笔待应答
      let inbox = await host.observer.inboxOf("responder");
      expect(inbox.awaitingMyAck.some((a) => a.correlationId === correlationId)).toBe(true);

      await host.ack({ correlationId, from: "responder", data: "done" });

      // 应答回到 requester：同 correlationId、from=responder 的消息出现在会话里
      const msgs = await host.observer.messages({ conversationId: conv.id });
      const answer = msgs.find((m) => m.correlationId === correlationId && m.from === "responder");
      expect(answer).toBeDefined();

      inbox = await host.observer.inboxOf("responder");
      expect(inbox.awaitingMyAck.some((a) => a.correlationId === correlationId)).toBe(false);

      const report = await host.observer.checkInvariants();
      expect(report.violations).toEqual([]);
    } finally {
      await host.close();
    }
  });
});