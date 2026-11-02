// ═══════════════════════════════════════════════════════════════════════════
// A27（§12.1 / §19.3 配置与类型偏差收口）：逐项补用例。
//
//   ① 可选 stop 的合同：提供了就必须是函数，否则抢锁前 reject。
//   ② transportOptions 值域：pollIntervalMs/claimTtlMs/maxAttempts 为 0 或非整数 → reject。
//   ③ registerEndpoint topology 运行期校验（类型只能防编译期）。
//   ④ ensureDirect 校验失败返回 rejected promise（不再同步抛错）。
//   ⑤ 并发 close：第二次返回同一个在途 promise（缓存 close promise）。
//   ⑥ close 中途 dispose 抛错 → 仍释放实例锁 + 关库，之后重抛首个错误。
//   ⑦ dbPath=":memory:" 不进 cwd 的 ./mesh（配置校验路径全用 :memory: 作为回归佐证）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StreamTopology, Transport } from "../../src/core/types.js";
import { MeshRejectError } from "../../src/core/types.js";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, runtimeRef: "e2e-session" }),
  open: async () => ({ session: {} }),
};

/** close 中途 dispose 抛错的自定义流端口（其余能力继承 FakeStreamPort 原型） */
class ThrowingDisposePort extends FakeStreamPort {
  async dispose(): Promise<void> {
    throw new Error("dispose boom");
  }
}

async function makeMesh(port?: FakeStreamPort): Promise<{ host: MeshHost; dir: string; dbPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-a27-"));
  const dbPath = join(dir, "mesh.db");
  const host = await createMesh({
    dbPath,
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port ?? new FakeStreamPort(),
    devMode: true,
  });
  return { host, dir, dbPath };
}

describe("A27: 配置与类型偏差收口", () => {
  it("① 自定义 Transport 提供了非函数 stop → 抢锁前 reject", async () => {
    const badStop = {
      publish: async () => {},
      subscribe: () => () => {},
      ack: async () => {},
      stop: 42, // 提供了但不是函数
    } as unknown as Transport;
    await expect(
      createMesh({
        dbPath: ":memory:",
        policies: { sessionFactory: stubSessionFactory },
        transport: badStop,
        devMode: true,
      }),
    ).rejects.toThrow(/stop must be a function/);
  });

  it("② transportOptions 为 0 / 非整数 → 抢锁前 reject", async () => {
    await expect(
      createMesh({
        dbPath: ":memory:",
        policies: { sessionFactory: stubSessionFactory },
        transport: "sameHost",
        transportOptions: { pollIntervalMs: 0 },
      }),
    ).rejects.toThrow(/pollIntervalMs must be a positive integer/);

    await expect(
      createMesh({
        dbPath: ":memory:",
        policies: { sessionFactory: stubSessionFactory },
        transport: "sameHost",
        transportOptions: { claimTtlMs: 1.5 },
      }),
    ).rejects.toThrow(/claimTtlMs must be a positive integer/);
  });

  it("③ registerEndpoint 校验 topology（非法 kind / scope / size）", async () => {
    const { host } = await makeMesh();
    try {
      await host.registerAccount({
        id: "a",
        displayName: "A",
        endpointClass: "stream",
        initiate: ["chat"],
      });
      await expect(
        host.registerEndpoint({
          accountId: "a",
          topology: { kind: "bogus" } as unknown as StreamTopology,
        }),
      ).rejects.toBeInstanceOf(MeshRejectError);
      await expect(
        host.registerEndpoint({
          accountId: "a",
          topology: { kind: "perConversation", scope: "nope", key: "k" } as unknown as StreamTopology,
        }),
      ).rejects.toThrow(/scope/);
      await expect(
        host.registerEndpoint({
          accountId: "a",
          topology: { kind: "pooled", size: 0 },
        }),
      ).rejects.toThrow(/size/);
      // 合法 topology 仍通过
      const ok = await host.registerEndpoint({
        accountId: "a",
        topology: { kind: "perConversation", scope: "conversation", key: "k" },
      });
      expect(ok.id).toBeTruthy();
    } finally {
      await host.close();
    }
  });

  it("④ ensureDirect 校验失败 → rejected promise（非同步抛错）", async () => {
    const { host } = await makeMesh();
    try {
      await host.registerAccount({
        id: "a",
        displayName: "A",
        endpointClass: "stream",
        initiate: ["chat"],
      });
      await expect(host.ensureDirect("a", "ghost")).rejects.toBeInstanceOf(MeshRejectError);
    } finally {
      await host.close();
    }
  });

  it("⑤ 并发 close 返回同一个在途 promise", async () => {
    const { host } = await makeMesh();
    const p1 = host.close();
    const p2 = host.close();
    expect(p2).toBe(p1); // 缓存 close promise，不是第二个独立 resolve 的 promise
    await p1;
    await p2;
  });

  it("⑥ dispose 抛错 → 仍释放实例锁 + 关库，之后重抛", async () => {
    const { host, dbPath } = await makeMesh(new ThrowingDisposePort());
    await expect(host.close()).rejects.toThrow(/dispose boom/);
    // 实例锁已释放、DB 已关 ⇒ 同一 dbPath 可立即重建（残留写者才是不接受的失败模式）
    expect(existsSync(dbPath + ".instance.lock")).toBe(false);
    const host2 = await createMesh({
      dbPath,
      policies: { sessionFactory: stubSessionFactory },
      streamPort: new FakeStreamPort(),
      devMode: true,
    });
    await host2.close();
  });

  it("⑦ :memory: 全流程可用（配置校验/拓扑/close 皆以 :memory: 回归，不进 cwd ./mesh）", async () => {
    const host = await createMesh({
      dbPath: ":memory:",
      policies: { sessionFactory: stubSessionFactory },
      streamPort: new FakeStreamPort(),
      devMode: true,
    });
    await host.registerAccount({
      id: "a",
      displayName: "A",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    const ep = await host.registerEndpoint({
      accountId: "a",
      topology: { kind: "unified" },
    });
    expect(ep.id).toBeTruthy();
    await host.close();
  });
});