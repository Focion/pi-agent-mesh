// ═══════════════════════════════════════════════════════════════════════════
// A22（§12.1 全有全无）：createMesh 抢锁/开库之后的失败路径必须回滚资源，
// 让宿主能立即用同一 dbPath 重建——否则实例锁残留会让第二次 createMesh 抛 LockHeldError。
//
// 覆盖：
//   - 非法自定义 Transport（缺 publish/subscribe/ack 任一）在抢锁之前就 reject，
//     不留 .instance.lock，同一 dbPath 可重建。
//   - 非法自定义 StreamPort（缺 10 能力任一）同样在抢锁之前 reject、不留锁。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Transport } from "../../src/core/types.js";
import type { SessionFactory } from "../../src/index.js";
import { createMesh } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, runtimeRef: "e2e-session" }),
  open: async () => ({ session: {} }),
};

describe("A22: createMesh 失败回滚（不留实例锁 / 可重建）", () => {
  it("非法 Transport（缺 ack）在抢锁前 reject，同一 dbPath 立即可重建", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-a22-tx-"));
    const dbPath = join(dir, "mesh.db");
    // 只有 publish/subscribe、缺 ack —— 触发 C02 能力校验
    const badTransport = {
      publish: async () => {},
      subscribe: () => () => {},
    } as unknown as Transport;

    await expect(
      createMesh({
        dbPath,
        policies: { sessionFactory: stubSessionFactory },
        transport: badTransport,
        devMode: true,
      }),
    ).rejects.toThrow(/publish\/subscribe\/ack/);

    // 抢锁之前就拒：不得留下实例锁文件
    expect(existsSync(dbPath + ".instance.lock")).toBe(false);

    // 同一 dbPath 用合法配置重建成功
    const host = await createMesh({
      dbPath,
      policies: { sessionFactory: stubSessionFactory },
      streamPort: new FakeStreamPort(),
      devMode: true,
    });
    await host.close();
  });

  it("非法 StreamPort（缺方法）在抢锁前 reject，同一 dbPath 立即可重建", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-a22-sp-"));
    const dbPath = join(dir, "mesh.db");
    // 空对象即缺全部 10 能力，触发 C10 校验（报告第一个缺失方法）。
    const badPort = {} as unknown as FakeStreamPort;

    await expect(
      createMesh({
        dbPath,
        policies: { sessionFactory: stubSessionFactory },
        streamPort: badPort,
        devMode: true,
      }),
    ).rejects.toThrow(/custom StreamPort must implement/);

    expect(existsSync(dbPath + ".instance.lock")).toBe(false);

    const host = await createMesh({
      dbPath,
      policies: { sessionFactory: stubSessionFactory },
      streamPort: new FakeStreamPort(),
      devMode: true,
    });
    await host.close();
  });
});