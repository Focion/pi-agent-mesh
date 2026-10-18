// ═══════════════════════════════════════════════════════════════════════════
// G06 · V05（计划 §6）：规模正确性用例。正确性优先——不设吞吐门槛、不参与 20%
// 回归基线；每例收尾 `assertInvariants`（C1–C16 全绿）证明规模增大无状态腐化。
//
// 六例：①30 账号冷热切换　②1000 订阅者 topic 过滤（from_seq 边界）　③100 并发
// 请求　④queue 租约回收接管　⑤10 写者 CAS　⑥附件上下文（shared 引用随信封投影）。
// 一律走真实 createMesh + FakeStreamPort + stub SessionFactory + devMode:false。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "v05" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface World {
  host: MeshHost;
  port: FakeStreamPort;
  dir: string;
}

async function makeWorld(extraLimits: Record<string, unknown> = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-v05-"));
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits: { handoffTimeoutMs: 1000, sweepIntervalMs: 0, ...extraLimits },
    devMode: false,
  });
  return { host, port, dir };
}

async function closeWorld(w: World): Promise<void> {
  await w.host.close().catch(() => {});
  rmSync(w.dir, { recursive: true, force: true });
}

/** 注册一个 stream 账号 + unified 端点 + available presence，返回端点 id。 */
async function addStreamAccount(
  host: MeshHost,
  id: string,
  initiate: string[] = ["chat"],
): Promise<string> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: initiate as never,
  });
  const ep = await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
  await host.setPresence(id, "available");
  return ep.id;
}

// ─── ① 30 账号冷热切换 ────────────────────────────────────────────────────

describe("V05 · 规模正确性", () => {
  it("① 30 账号冷热切换：投递按 oracle 落账，翻转后不变量仍 16 绿", async () => {
    const w = await makeWorld();
    const { host, port } = w;
    try {
      const ids = Array.from({ length: 30 }, (_, i) => `m${i}`);
      const eps = new Map<string, string>();
      for (const id of ids) eps.set(id, await addStreamAccount(host, id));

      // 冷热分界：前 15 warm（热），后 15 显式置冷（FakeStreamPort 未设置默认热）。
      for (let i = 0; i < 15; i++) await host.warm(eps.get(ids[i]!)!);
      for (let i = 15; i < 30; i++) port.setEndpointState(eps.get(ids[i]!)!, "cold");

      const conv = await host.createConversation({ type: "group", creator: "m0", members: ids });

      // 群创建会发 1 条 system 消息（L1001），故用「增量」锚定我的 3 条广播，不硬写绝对计数。
      const base = await host.observer.counters();

      for (const sender of ["m0", "m1", "m2"]) {
        await host.send({ from: sender, conversationId: conv.id, kind: "chat", expect: "none", text: `${sender} 广播` });
      }
      await flush();

      let c = await host.observer.counters();
      expect((c["messages_total"] ?? 0) - (base["messages_total"] ?? 0)).toBe(3);
      expect((c["deliveries_total"] ?? 0) - (base["deliveries_total"] ?? 0)).toBe(3 * 29); // 广播到除发送者外的 29 人

      // 翻转：把 15 个冷账号 warm，把 5 个热账号转冷——过程不丢既有派送意图。
      for (let i = 15; i < 30; i++) await host.warm(eps.get(ids[i]!)!);
      for (let i = 0; i < 5; i++) port.setEndpointState(eps.get(ids[i]!)!, "cold");

      for (const sender of ["m0", "m1", "m2"]) {
        await host.send({ from: sender, conversationId: conv.id, kind: "chat", expect: "none", text: `${sender} 再广播` });
      }
      await flush();

      c = await host.observer.counters();
      expect((c["messages_total"] ?? 0) - (base["messages_total"] ?? 0)).toBe(6);
      expect((c["deliveries_total"] ?? 0) - (base["deliveries_total"] ?? 0)).toBe(6 * 29);
      expect(port.warmed.length).toBe(30); // 15 初始 + 15 翻转 warm

      await assertInvariants(host);
    } finally {
      await closeWorld(w);
    }
  });

  // ─── ② 1000 订阅者 topic 过滤（from_seq 下界）────────────────────────

  it("② 1000 订阅者：只投 from_seq≤seq 的订阅者（500×10=5000 行），非订阅者 0", async () => {
    const w = await makeWorld();
    const { host, port } = w;
    try {
      await addStreamAccount(host, "pub", ["event"]);
      const topic = await host.createConversation({ type: "topic", creator: "pub" });

      const subscribers = Array.from({ length: 1000 }, (_, i) => `s${i}`);
      for (const s of subscribers) await addStreamAccount(host, s, ["event"]);
      // 前 500 从 seq 1 起收（全收）；后 500 从 seq 50 起收（10 条内 session 收不到）
      for (let i = 0; i < 500; i++) await host.subscribe(topic.id, subscribers[i]!, { fromSeq: 1 });
      for (let i = 500; i < 1000; i++) await host.subscribe(topic.id, subscribers[i]!, { fromSeq: 50 });

      // 非订阅者：注册但从未订阅，不得收到任何行
      await addStreamAccount(host, "outsider", ["event"]);

      for (let seq = 1; seq <= 10; seq++) {
        await host.send({ from: "pub", conversationId: topic.id, kind: "event", expect: "none", text: `e${seq}` });
      }
      await flush();

      const c = await host.observer.counters();
      expect(c["messages_total"]).toBe(10);
      // topic 无发送方自身行；只有 from_seq=1 的 500 人各收 10 条 P3 note=记账
      expect(c["deliveries_total"]).toBe(500 * 10);
      expect(port.notes.length).toBe(500 * 10);

      // 非订阅者无任何派送（outsider 不落行，pending 恒 0）
      const outsider = await host.observer.inboxOf("outsider");
      expect(outsider.conversations.find((x) => x.conversationId === topic.id)).toBeUndefined();

      await assertInvariants(host);
    } finally {
      await closeWorld(w);
    }
  });

  // ─── ③ 100 并发请求 ─────────────────────────────────────────────────────

  it("③ 100 并发 request→ack：全部 answered、无 open、恰好 100 条应答消息", async () => {
    const w = await makeWorld();
    const { host } = w;
    try {
      await addStreamAccount(host, "A");
      await addStreamAccount(host, "B");
      const conv = await host.ensureDirect("A", "B");

      const reqs = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          host.request({
            from: "A",
            conversationId: conv.id,
            kind: "chat",
            expect: "ack",
            to: ["B"],
            text: `q${i}`,
          }),
        ),
      );
      const corrs = (reqs as Array<{ correlationId: string }>).map((r) => r.correlationId);

      await Promise.all(corrs.map((corr, i) => host.ack({ correlationId: corr, from: "B", data: `a${i}` })));
      await flush();

      const db = new Database(join(w.dir, "mesh.db"), { readonly: true });
      const states = db
        .prepare("SELECT state, COUNT(*) AS n FROM mesh_pending_acks GROUP BY state")
        .all() as Array<{ state: string; n: number }>;
      const answered = states.find((s) => s.state === "answered")?.n ?? 0;
      const open = states.find((s) => s.state === "open")?.n ?? 0;
      db.close();
      expect(answered).toBe(100);
      expect(open).toBe(0);

      await assertInvariants(host);
    } finally {
      await closeWorld(w);
    }
  });

  // ─── ④ queue 租约回收接管 ───────────────────────────────────────────────

  it("④ queue 接管：领而未 ack 的租约到期回收（claim_timeout=16）后可再领", async () => {
    // claimTtlMs 下限 1000；sweep 每 1000ms 回收过期租约 → nackClaim 重投。
    // maxAttempts 拉高：短租约下任务反复「到期→重投」，「领而未 ack」若滚过默认 3 次
    // 上限会被 dead-letter 并向 producer 发系统通知（增生派送）。本测试只验证接管语义，
    // 故把上限拉离试验窗，避免把「重投次数限制」误判成接管污染。
    const w = await makeWorld({ claimTtlMs: 1000, sweepIntervalMs: 1000, maxAttempts: 100 });
    const { host } = w;
    try {
      const workers = Array.from({ length: 8 }, (_, i) => `w${i}`);
      await addStreamAccount(host, "producer", ["task"]);
      for (const x of workers) await addStreamAccount(host, x, ["task"]);
      const q = await host.createConversation({ type: "queue", creator: "producer", members: workers });

      const N = 16; // 每 worker 2 条
      for (let i = 0; i < N; i++) {
        await host.send({ from: "producer", conversationId: q.id, kind: "task", expect: "none", text: `t${i}` });
      }
      await flush();

      // oracle：messageId → 分派消费者（flush 后、sweep 未跑，单次只读即稳定）
      const db = new Database(join(w.dir, "mesh.db"), { readonly: true });
      const tasks = db
        .prepare(
          "SELECT d.message_id AS mid, d.account_id AS consumer FROM mesh_deliveries d " +
            "JOIN mesh_messages m ON m.id = d.message_id WHERE m.conversation_id = ? AND m.kind = 'task' ORDER BY m.seq",
        )
        .all(q.id) as Array<{ mid: string; consumer: string }>;
      db.close();
      expect(tasks).toHaveLength(N);

      // 全体领取但不 ack → 租约全部过期
      for (const t of tasks) expect((await host.claim(t.mid, t.consumer)).ok).toBe(true);

      // 阶段一信号（单调）：每个「claimed」行到期回收时 claim_timeout +1，共 N 次。
      {
        const deadline = Date.now() + 10000;
        for (;;) {
          const ct = (await host.observer.counters())["claim_timeout"] ?? 0;
          if (ct === N) break;
          if (Date.now() > deadline) throw new Error(`接管超时：claim_timeout=${ct} ≠ ${N}`);
          await sleep(100);
        }
      }

      // 阶段二信号（收敛）：任务行（kind='task'）重投回 delivered——不含 producer 收到的
      // 「request timed out」系统通知（§17.6 领而未 ack 时 pending deadline 与 claim_until
      // 同步到期，属正确耦合）。
      {
        const dbr = new Database(join(w.dir, "mesh.db"), { readonly: true });
        const qs = dbr.prepare(
          "SELECT COUNT(*) AS n FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
            "WHERE m.conversation_id = ? AND m.kind = 'task' AND d.state = 'delivered'",
        );
        const deadline = Date.now() + 10000;
        for (;;) {
          if ((qs.get(q.id) as { n: number }).n === N) break;
          if (Date.now() > deadline) throw new Error("接管超时：任务行未全部重投回 delivered");
          await sleep(100);
        }
        dbr.close();
      }

      const c = await host.observer.counters();
      expect(c["claim_timeout"]).toBe(N);
      expect(c["request_timeout"]).toBe(N); // 领而未 ack ⇒ 请求同期超时（同一 deadline，耦合非缺陷）

      // 接管重投后 account 不变（nackClaim 不重选消费者，§17.7），可再领。
      // sweep 每 1000ms 仍会短暂把未领行置回 queued 再重投，claim 撞上瞬态 {ok:false} 时重试。
      for (const t of tasks) {
        const deadline = Date.now() + 5000;
        let claimed = false;
        while (!claimed) {
          if ((await host.claim(t.mid, t.consumer)).ok) {
            claimed = true;
            break;
          }
          if (Date.now() > deadline) break;
          await sleep(50);
        }
        expect(claimed).toBe(true);
      }

      await assertInvariants(host);
    } finally {
      await closeWorld(w);
    }
  });

  // ─── ⑤ 10 写者 CAS ──────────────────────────────────────────────────────

  it("⑤ 10 写者并发 CAS：恰 1 人成功、9 人 VERSION_MISMATCH、版本推进到 2", async () => {
    const w = await makeWorld();
    const { host } = w;
    try {
      const writers = Array.from({ length: 10 }, (_, i) => `wr${i}`);
      for (const x of writers) await addStreamAccount(host, x);
      const conv = await host.createConversation({ type: "group", creator: "wr0", members: writers });
      const space = "conv:" + conv.id;

      await host.shared.put(space, "doc", { v: 0 }, { as: "wr0" }); // version 1

      const settled = await Promise.allSettled(
        writers.map((x, i) =>
          host.shared.put(space, "doc", { v: i }, { as: x, expectedVersion: 1 }),
        ),
      );
      const ok = settled.filter((s) => s.status === "fulfilled");
      const clash = settled.filter(
        (s) => s.status === "rejected" && (s.reason as { code?: string })?.code === "VERSION_MISMATCH",
      );
      expect(ok).toHaveLength(1);
      expect(clash).toHaveLength(9);

      const latest = await host.shared.get(space, "doc", { as: "wr0" });
      expect(latest?.version).toBe(2);

      await assertInvariants(host);
    } finally {
      await closeWorld(w);
    }
  });

  // ─── ⑥ 附件上下文 ──────────────────────────────────────────────────────

  it("⑥ 附件上下文：shared 引用随信封投影原样保留、成员可反查附件正文", async () => {
    const w = await makeWorld();
    const { host } = w;
    try {
      await addStreamAccount(host, "A");
      await addStreamAccount(host, "B");
      const conv = await host.createConversation({ type: "group", creator: "A", members: ["B"] });
      const space = "conv:" + conv.id;

      await host.shared.put(space, "doc", { content: "attachment-body" }, { as: "A" }); // version 1
      await host.send({
        from: "A",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        to: ["B"],
        payload: {
          text: "see attachment",
          attachments: [{ spaceId: space, key: "doc", version: 1 }],
        },
      });
      await flush();

      const msgs = await host.observer.messages({ conversationId: conv.id, sinceSeq: 0, limit: 10 });
      const sent = msgs.find((m) => m.from === "A");
      expect(sent?.payload?.text).toBe("see attachment");
      expect(sent?.payload?.attachments).toEqual([{ spaceId: space, key: "doc", version: 1 }]);

      const data = await host.shared.get(space, "doc", { as: "B" });
      expect(data?.data).toEqual({ content: "attachment-body" });

      await assertInvariants(host);
    } finally {
      await closeWorld(w);
    }
  });
});