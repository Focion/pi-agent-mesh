// ═══════════════════════════════════════════════════════════════════════════
// G06 基准 A（§8.1）：双 Agent、200 条交替 direct。oracle 钉死：
//   - 原文无遗漏：direct 恒在预算内 ⇒ verbatim_copies === 200，每条恰一次 P1 落盘；
//   - 不发生折叠：fold_events / inbox_overflowed 均 0；
//   - hot=2：仅 warm 两个端点，峰值 2（无 evict）；
//   - 合法起轮：唤醒计数与 idle-wake 计数一致，且「起轮 + 限流扣记」恰覆盖 200 条
//     （默认 A3 唤醒限流 20/min/账号 生效——起轮之外的原样落盘，不丢原文）。
// 计量真实 createMesh + FakeStreamPort + stub SessionFactory + devMode:false。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { createMesh, type MeshHost, type SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { check, runBench, type Scenario } from "./helpers.js";

const N = 200;

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "bench-a" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function makeScenario(): Promise<Scenario> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-bench-a-"));
  const port = new FakeStreamPort();
  const host: MeshHost = await createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits: { sweepIntervalMs: 0, handoffTimeoutMs: 1000 },
    devMode: false,
  });

  let hotPeak = 0;
  let hot = 0;
  const warm = async (ep: string) => {
    await host.warm(ep, "shared");
    hot += 1;
    hotPeak = Math.max(hotPeak, hot);
  };

  await host.registerAccount({ id: "alice", displayName: "Alice", endpointClass: "stream", initiate: ["chat"] });
  await host.registerAccount({ id: "bob", displayName: "Bob", endpointClass: "stream", initiate: ["chat"] });
  const aliceEp = (await host.registerEndpoint({ accountId: "alice", topology: { kind: "unified" } })).id;
  const bobEp = (await host.registerEndpoint({ accountId: "bob", topology: { kind: "unified" } })).id;
  await host.setPresence("alice", "available");
  await host.setPresence("bob", "available");
  await warm(aliceEp);
  await warm(bobEp);
  const dc = await host.ensureDirect("alice", "bob");

  return {
    async op() {
      for (let i = 0; i < N; i++) {
        const from = i % 2 === 0 ? "alice" : "bob";
        const to = i % 2 === 0 ? "bob" : "alice";
        // expect:"none" 也不影响——direct 恒起轮（§7.3 规则②），这里避免 request 挂账。
        await host.send({ from, conversationId: dc.id, kind: "chat", expect: "none", to: [to], text: `m${i}` });
      }
      await flush();
      return N;
    },
    async assert() {
      const c = await host.observer.counters();
      check(c["messages_total"] === N, `messages_total=${c["messages_total"]} ≠ ${N}`);
      check(c["deliveries_total"] === N, `deliveries_total=${c["deliveries_total"]} ≠ ${N}`);
      check(c["verbatim_copies"] === N, `verbatim_copies=${c["verbatim_copies"]} ≠ ${N}（原文无遗漏）`);
      check((c["fold_events"] ?? 0) === 0, `fold_events=${c["fold_events"]} 应 0（不发生折叠）`);
      check((c["inbox_overflowed"] ?? 0) === 0, `inbox_overflowed=${c["inbox_overflowed"]} 应 0`);
      check(port.delivered.length === N, `落盘投递 ${port.delivered.length} ≠ ${N}`);
      const idle = c["wake_per_message_idle"] ?? 0;
      const throttled = c["wake_throttled"] ?? 0;
      check(port.wakeCount() === idle, `wakeCount=${port.wakeCount()} ≠ wake_per_message_idle=${idle}`);
      check(idle + throttled === N, `起轮 ${idle} + 限流 ${throttled} ≠ ${N}（每条均应被计一次）`);
      check(hotPeak === 2, `hot 峰值 ${hotPeak} ≠ 2`);
    },
    async close() {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("G06 基准 A：双 Agent 200 条交替 direct", () => {
  it("原文无遗漏 + 不折叠 + hot=2", async () => {
    await runBench("a-dual", makeScenario);
  }, 300_000);
});