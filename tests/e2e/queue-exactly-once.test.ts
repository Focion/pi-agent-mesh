// ═══════════════════════════════════════════════════════════════════════════
// queue 恰好一次（§17.6）：单消费者 1000 个任务逐条 claim+ack，
// 断言全部 acked、claimable=0、无重复 ack、观察「queueDepth:acked」=1000。
// 关键：可用的 worker 被唤醒 + turn_end 回吐后，任务仍停在 delivered（§17.5），
// 得以 claim；ack 由 pending_acks 归因（sync=0，to_account=消费者），恰好一次成功。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "e2e-session" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const N = 1000;

describe("queue exactly-once (§17.6)", () => {
  it("single consumer: 1000 tasks, every one acked exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-qeo-"));
    const port = new FakeStreamPort();
    const host = await createMesh({
      dbPath: join(dir, "mesh.db"),
      policies: { sessionFactory: stubSessionFactory },
      streamPort: port,
      limits: { handoffTimeoutMs: 1000 },
      devMode: true,
    });
    try {
      await host.registerAccount({
        id: "producer",
        displayName: "producer",
        endpointClass: "stream",
        initiate: ["chat", "task"],
      });
      await host.registerEndpoint({ accountId: "producer", topology: { kind: "unified" } });
      const worker = await host.registerAccount({
        id: "worker",
        displayName: "worker",
        endpointClass: "stream",
        initiate: ["chat", "task"],
      });
      await host.registerEndpoint({ accountId: "worker", topology: { kind: "unified" } });
      await host.setPresence("worker", "available");
      const q = await host.createConversation({
        type: "queue",
        creator: "producer",
        members: ["worker"],
      });

      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const r = await host.send({
          from: "producer",
          conversationId: q.id,
          kind: "task",
          expect: "none",
          text: `job ${i}`,
        });
        ids.push(r.messageId);
      }
      await flush();

      // messageId → correlationId（ack 归因需要），分页拿（messages 上限 100）
      const idToCorrelation = new Map<string, string>();
      let since = 0;
      for (;;) {
        const page = await host.observer.messages({
          conversationId: q.id,
          sinceSeq: since,
          limit: 100,
        });
        if (page.length === 0) break;
        for (const e of page) {
          idToCorrelation.set(e.id, e.correlationId!);
          since = Math.max(since, e.seq);
        }
        if (page.length < 100) break;
      }
      expect(idToCorrelation.size).toBe(N);

      // 逐条 claim + ack
      for (const id of ids) {
        const claim = await host.claim(id, "worker");
        expect(claim.ok).toBe(true);
        await host.ack({ correlationId: idToCorrelation.get(id)!, from: "worker" });
      }
      await flush();

      // 观察计数：acked === N，claimable === 0，无未读
      const counters = await host.observer.counters();
      expect(counters["queueDepth:acked"]).toBe(N);
      const inbox = await host.observer.inboxOf("worker");
      const qc = inbox.conversations.find((c) => c.conversationId === q.id)!;
      expect(qc.claimable).toBe(0);
      expect(qc.unread).toBe(0);

      // 无重复 ack：同 correlationId 再 ack 是幂等 no-op，acked 计数不增
      await host.ack({ correlationId: idToCorrelation.get(ids[0]!)!, from: "worker" });
      await flush();
      expect((await host.observer.counters())["queueDepth:acked"]).toBe(N);

      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });
});