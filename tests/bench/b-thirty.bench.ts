// ═══════════════════════════════════════════════════════════════════════════
// G06 基准 B（§8.1）：30 成员、500 条固定 seed 消息，5% 定向请求（expect:"reply"）。
//
// 场景：30 成员单群；仅 3 个「活跃发言者」（m0–m2）发言，其余 27 人从未发言 ⇒
// 恒定超预算（silent→P2 只记账）；host 只 warm 这 3 个发言者（hot 峰值 ≤4）。
// 发送者轮转（gap≤3 ⇒ 恒在预算内、稳定 verbatim）。oracle 口径：
//   - deliveries/messages 按「增量」折算（群创建先扇出 1 条 system 消息给全部 30 人，
//     已入 base 不计入本轮）：广播 475 × 29 人 + 定向 25 × 1 目标 = 13800（不硬写，由成员数推出）；
//   - 唤醒 ≤600（只有 25 条定向请求起轮，每个 ≤1 次）；
//   - 原文份数 ≤1500；原文率 <0.25；静默率 >0.5；busy 新增起轮（wake_per_message_busy）恒 0；
//   - hot 峰值 ≤4。
// 计量真实 createMesh + FakeStreamPort + stub SessionFactory + devMode:false。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { createMesh, type MeshHost, type SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { mulberry32, pick } from "../helpers/prng.js";
import { check, runBench, type Scenario } from "./helpers.js";

const MEMBERS = 30;
const MESSAGES = 500;
const SPEAKERS = ["m0", "m1", "m2"];

function allMembers(): string[] {
  return Array.from({ length: MEMBERS }, (_, i) => `m${i}`);
}

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "bench-b" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function makeScenario(): Promise<Scenario> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-bench-b-"));
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

  const members = allMembers();
  const endpoints = new Map<string, string>();
  for (const id of members) {
    await host.registerAccount({ id, displayName: id, endpointClass: "stream", initiate: ["chat"] });
    endpoints.set(id, (await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } })).id);
    await host.setPresence(id, "available");
  }
  // host 只 warm 活跃发言者（3 ≤ 4）；其余成员从不 warm（成本模型里保持冷）。
  for (const s of SPEAKERS) await warm(endpoints.get(s)!);

  const conv = await host.createConversation({ type: "group", creator: "m0", members });

  // 群创建先发 1 条 system 消息扇出给全部 30 人（from=@system 不在成员里，无自排除）；
  // 落账基准锚在创建后、广播前，assert 用「增量」折算，避免把 system 贡献硬写进 oracle。
  const base = await host.observer.counters();

  const rand = mulberry32(0x8ab1 /* 固定 seed：目标选取可复现 */);

  return {
    async op() {
      for (let i = 0; i < MESSAGES; i++) {
        const sender = SPEAKERS[i % SPEAKERS.length]!;
        const directed = i % 20 === 0; // 恰好 5%（25 条）定向请求
        if (directed) {
          const others = SPEAKERS.filter((s) => s !== sender);
          const target = pick(rand, others);
          await host.send({
            from: sender,
            conversationId: conv.id,
            kind: "chat",
            expect: "reply",
            to: [target],
            text: `dir${i}`,
          });
        } else {
          await host.send({
            from: sender,
            conversationId: conv.id,
            kind: "chat",
            expect: "none",
            text: `broadcast${i}`,
          });
        }
      }
      await flush();
      return MESSAGES;
    },
    async assert() {
      const c = await host.observer.counters();
      // 增量折算：distinct system 消息已含在 base，本轮 500 条的 oracle 只算广播/定向扇出。
      const delta = (k: string) => (c[k] ?? 0) - (base[k] ?? 0);
      // oracle：广播 475 条 × 29 人 + 定向 25 条 × 1 目标（to:[target] 只投目标，不做全群扇出）
      const DIRECTED = MESSAGES / 20; // i % 20 === 0 ⇒ 25 条
      const BROADCASTS = MESSAGES - DIRECTED;
      const oracleDeliveries = BROADCASTS * (MEMBERS - 1) + DIRECTED * 1;
      check(delta("deliveries_total") === oracleDeliveries, `deliveries_total=${delta("deliveries_total")} ≠ oracle ${oracleDeliveries}`);
      check(delta("messages_total") === MESSAGES, `messages_total=${delta("messages_total")} ≠ ${MESSAGES}`);

      const silent = delta("silent_grade");
      const verbatim = delta("verbatim_copies");
      check(port.wakeCount() <= 600, `唤醒 ${port.wakeCount()} > 600`);
      check(verbatim <= 1500, `原文份数 ${verbatim} > 1500`);
      check(silent / oracleDeliveries > 0.5, `静默率 ${(silent / oracleDeliveries).toFixed(3)} ≤ 0.5`);
      check(verbatim / oracleDeliveries < 0.25, `原文率 ${(verbatim / oracleDeliveries).toFixed(3)} ≥ 0.25`);
      check(delta("wake_per_message_busy") === 0, `wake_per_message_busy=${delta("wake_per_message_busy")} ≠ 0（busy 新增起轮应为 0）`);
      check(hotPeak <= 4, `hot 峰值 ${hotPeak} > 4`);
    },
    async close() {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("G06 基准 B：30 成员 500 条固定 seed 消息（5% 定向）", () => {
  it("唤醒/原文/静默/折叠各率达标且 deliveries 按 oracle 求和", async () => {
    await runBench("b-thirty", makeScenario);
  }, 300_000);
});