// ═══════════════════════════════════════════════════════════════════════════
// 装配期选项校验（附录 F 通条③ / F.1 / F.2）：越界值在 createMesh 直接 reject。
// 补角度⑤的 ⑤-A / ⑤-B / ⑤-F。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { Transport } from "../../src/core/types.js";

const sessionFactory = {
  create: async () => ({ session: {}, piSessionId: "opt-test" }),
  open: async () => ({ session: {} }),
};

const base = {
  dbPath: ":memory:",
  policies: { sessionFactory },
};

describe("createMesh 选项校验（附录 F 通条③）", () => {
  it("limits.groupTiers 非严格递增 → reject", async () => {
    await expect(
      createMesh({ ...base, limits: { groupTiers: [3, 3, 30] } }),
    ).rejects.toThrow(/groupTiers/);
  });

  it("limits.groupSizeHardCap > 10⁴ → reject", async () => {
    await expect(
      createMesh({ ...base, limits: { groupSizeHardCap: 10001 } }),
    ).rejects.toThrow(/groupSizeHardCap/);
  });

  it("limits.maxInFlight < maxPending → reject", async () => {
    await expect(
      createMesh({ ...base, limits: { maxInFlight: 1 } }),
    ).rejects.toThrow(/maxInFlight/);
  });

  it("busyTimeoutMs 越界（>60000）→ reject", async () => {
    await expect(
      createMesh({ ...base, busyTimeoutMs: 999999 }),
    ).rejects.toThrow(/busyTimeoutMs/);
  });

  it("自定义 Transport → 接受（§19：宿主传入的其它 Transport 实现将直接使用，不做校验收敛）", async () => {
    let subscribed = false;
    let published: Array<unknown> = [];
    const custom = {
      publish: async (d: unknown) => { published.push(d); },
      subscribe: () => { subscribed = true; return () => {}; },
      ack: async () => {},
      kind: "customTestTransport",
    } as unknown as Transport;
    const host = await createMesh({ ...base, transport: custom });
    expect(subscribed).toBe(false); // 自定义 Transport 的 poller/subscription 由宿主自管
    expect(published.length).toBe(0); // 无 delivery 产生 before warm
    await host.close();
  });
});