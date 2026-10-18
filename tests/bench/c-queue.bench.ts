// ═══════════════════════════════════════════════════════════════════════════
// G06 基准 C（§8.1）：8 消费者、1000 个任务，无故障。oracle 钉死：
//   - 每个任务恰好一个成功 ack（queueDepth:acked === 1000）；
//   - claim 冲突率 ≤15%（无故障下按调度器分派的消费者领取 ⇒ 0 冲突）；
//   - 超时回收（claim_timeout）为 0；dedup_hit 为 0；
//   - 纯账本吞吐（claim→ack）≥200 任务/秒，按 5 轮中位数判定。
// 计划 §6 口径：计数用 host.observer.counters()；通过只读 JOIN 拿到 messageId →
// 分派消费者/ correlationId（oracle，非直接插入终态行），claim/ack 全走公共 API。
// 计量真实 createMesh + FakeStreamPort + stub SessionFactory + devMode:false。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createMesh, type MeshHost, type SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { check, runBench, type Scenario } from "./helpers.js";

const CONSUMERS = 8;
const TASKS = 1000;

function consumers(): string[] {
  return Array.from({ length: CONSUMERS }, (_, i) => `w${i}`);
}

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "bench-c" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface TaskRef {
  mid: string;
  consumer: string;
  corr: string;
}

async function makeScenario(): Promise<Scenario> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-bench-c-"));
  const dbPath = join(dir, "mesh.db");
  const host: MeshHost = await createMesh({
    dbPath,
    policies: { sessionFactory: stubSessionFactory },
    streamPort: new FakeStreamPort(),
    limits: { sweepIntervalMs: 0, handoffTimeoutMs: 1000 },
    devMode: false,
  });

  await host.registerAccount({ id: "producer", displayName: "producer", endpointClass: "stream", initiate: ["task"] });
  await host.registerEndpoint({ accountId: "producer", topology: { kind: "unified" } });
  for (const w of consumers()) {
    await host.registerAccount({ id: w, displayName: w, endpointClass: "stream", initiate: ["task"] });
    await host.registerEndpoint({ accountId: w, topology: { kind: "unified" } });
    await host.setPresence(w, "available");
  }
  const q = await host.createConversation({ type: "queue", creator: "producer", members: consumers() });

  // ── setup（不计时）：1000 任务发送 + flush（deliveries 落 delivered，可 claim）──
  for (let i = 0; i < TASKS; i++) {
    await host.send({ from: "producer", conversationId: q.id, kind: "task", expect: "none", text: `job ${i}` });
  }
  await flush();

  // ── oracle（只读）：messageId → 分派消费者 + correlationId（调度器 least-in-flight 已定）──
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      "SELECT d.message_id AS mid, d.account_id AS consumer, m.correlation_id AS corr " +
        "FROM mesh_deliveries d JOIN mesh_messages m ON m.id = d.message_id " +
        "WHERE m.conversation_id = ? ORDER BY m.seq",
    )
    .all(q.id) as TaskRef[];
  db.close();
  check(rows.length === TASKS, `oracle 任务数 ${rows.length} ≠ ${TASKS}`);

  // 无故障按调度器分派 ⇒ 0 冲突；claim 失败返回 {ok:false} 时计入，断言钉在 ≤15%。
  let claimConflicts = 0;

  return {
    async op() {
      for (const t of rows) {
        const claim = await host.claim(t.mid, t.consumer);
        if (!claim.ok) claimConflicts += 1;
        await host.ack({ correlationId: t.corr, from: t.consumer });
      }
      return TASKS;
    },
    async assert() {
      const c = await host.observer.counters();
      check(c["queueDepth:acked"] === TASKS, `queueDepth:acked=${c["queueDepth:acked"]} ≠ ${TASKS}（恰好一次）`);
      check(c["queueDepth:claimed"] === 0, `queueDepth:claimed=${c["queueDepth:claimed"]} ≠ 0（全部已 ack）`);
      check((c["claim_timeout"] ?? 0) === 0, `claim_timeout=${c["claim_timeout"]} ≠ 0`);
      check((c["dedup_hit"] ?? 0) === 0, `dedup_hit=${c["dedup_hit"]} ≠ 0`);
      check(claimConflicts / TASKS <= 0.15, `claim 冲突率 ${(claimConflicts / TASKS).toFixed(3)} > 15%（无故障应为 0）`);

      // 8 消费者都领满其分派份额（1000/8），无未领 / 无重复 ack 增生
      for (const w of consumers()) {
        const inbox = await host.observer.inboxOf(w);
        const qc = inbox.conversations.find((cc) => cc.conversationId === q.id);
        check(qc !== undefined && qc.claimable === 0 && qc.unread === 0, `消费者 ${w} 仍有 claimable/unread 残留`);
      }
    },
    async close() {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("G06 基准 C：8 消费者 1000 任务 claim→ack", () => {
  it("恰好一次 + 0 冲突 + 吞吐（中位数）≥200/s", async () => {
    const r = await runBench("c-queue", makeScenario);
    // 纯账本吞吐按中位数判定（§8.1 测量口径）。
    expect(r.throughputMedian).toBeGreaterThanOrEqual(200);
  }, 300_000);
});