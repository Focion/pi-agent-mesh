// ═══════════════════════════════════════════════════════════════════════════
// I16（+I01 收敛验证）：PiStreamPort 的租约生命周期。
//  - warm 抢到的端点锁写的是「宿主注入的 writerId」，不是端口自产（I01）；
//  - 热流 shared → exclusive 升级：不重建流、锁文件/DB 租约同步、升级后仍能写；
//  - exclusive TTL 到期降级：锁文件同步回 shared、DB lease_until 清空；
//  - 宿主 close()（index.ts）：port.dispose() 抛错仍释放实例锁并关 DB，再重抛首个错误。
//
// 不依赖真 pi：narrowSession 用最小假 session；锁走真 EndpointLock（tmp 目录）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, Endpoint, Envelope, SessionFactory } from "../../src/core/types.js";
import { createMesh } from "../../src/index.js";
import { EndpointLock } from "../../src/pi/lock.js";
import { PiStreamPort } from "../../src/pi/stream-port.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

/** 异步轮询：等待条件成立（锁文件读取是异步的，waitFor 只支持同步条件） */
async function until(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("until: condition not met within " + ms + "ms");
}

function fakeSession(): unknown {
  return {
    isIdle: true,
    sessionManager: {
      getSessionId: () => "s-1",
      getEntry: () => undefined,
      getEntries: () => [],
      appendCustomEntry: () => "e-1",
    },
    sendCustomMessage: async () => {},
    steer: async () => {},
    followUp: async () => {},
    waitForIdle: async () => {},
    subscribe: () => () => {},
    dispose: () => {},
  };
}

const fastFactory: SessionFactory = {
  create: async () => ({ session: fakeSession(), piSessionId: "pi-1" }),
  open: async () => ({ session: fakeSession() }),
};

const stubFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "stub" }),
  open: async () => ({ session: {} }),
};

function makeAccount(id: string): Account {
  return { id, displayName: id, endpointClass: "stream", initiate: ["chat"] };
}

function makeEndpoint(id: string, accountId: string): Endpoint {
  return {
    id,
    accountId,
    topology: { kind: "unified" },
    state: "cold",
    piSessionId: null,
    lease: "shared",
    leaseUntil: null,
    lastActiveAt: null,
  };
}

interface LeaseHarness {
  port: PiStreamPort;
  endpoint: Endpoint;
  dir: string;
  lockPath: string;
}

function makePort(dir: string, writerId: string, exclusiveLeaseTtlMs?: number): LeaseHarness {
  const endpoint = makeEndpoint("ep1", "a1");
  const account = makeAccount("a1");
  const port = new PiStreamPort({
    writerId,
    sessionFactory: fastFactory,
    getEndpoint: (id) => (id === "ep1" ? endpoint : undefined),
    getAccount: (id) => (id === "a1" ? account : undefined),
    buildTools: () => [],
    setEndpointState: (_id, s) => {
      endpoint.state = s;
    },
    setEndpointSession: () => {},
    setEndpointLease: (_id, lease, until) => {
      endpoint.lease = lease;
      endpoint.leaseUntil = until;
    },
    setEndpointLock: () => {},
    stateDir: dir,
    exclusiveLeaseTtlMs,
    idleEvictMs: 0,
  });
  return { port, endpoint, dir, lockPath: join(dir, "locks", "ep1.lock") };
}

function env(id: string): Envelope {
  return {
    id,
    seq: 1,
    from: "alice",
    fromEndpoint: null,
    routedAt: new Date().toISOString(),
    idempotencyKey: `k_${id}`,
    conversationId: "c1",
    kind: "chat",
    expect: "none",
    payload: {},
  };
}

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-lease-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("I01：端点锁用宿主注入的 writerId", () => {
  it("warm 后锁文件 writerId === 注入值（非端口自产）", async () => {
    const h = makePort(tmp(), "host-writer");
    await h.port.warm("ep1", "shared");
    const info = await EndpointLock.readInfo(h.lockPath);
    expect(info?.writerId).toBe("host-writer");
    await h.port.dispose();
  });
});

describe("I16：shared → exclusive 升级 + 降级同步", () => {
  it("热流 shared 升温后 warm(exclusive) 升级：锁文件/DB 租约一致为 exclusive，仍能写", async () => {
    const h = makePort(tmp(), "w");
    await h.port.warm("ep1", "shared"); // 建流 shared
    expect(h.endpoint.lease).toBe("shared");
    await h.port.warm("ep1", "exclusive"); // 升级，不重建流
    expect(h.endpoint.lease).toBe("exclusive");
    expect(h.endpoint.leaseUntil).not.toBeNull();
    expect((await EndpointLock.readInfo(h.lockPath))?.lease).toBe("exclusive");
    // 升级后写路径仍可用（不丢单写者）
    await expect(h.port.deliver("ep1", "hi", env("m1"), "followUp", { triggerTurn: false })).resolves.toBeDefined();
    await h.port.dispose();
  });

  it("exclusive TTL 到期降级：锁文件同步回 shared、DB lease_until 清空", async () => {
    const h = makePort(tmp(), "w", 60); // 短 TTL
    await h.port.warm("ep1", "exclusive");
    expect((await EndpointLock.readInfo(h.lockPath))?.lease).toBe("exclusive");
    await until(async () => (await EndpointLock.readInfo(h.lockPath))?.lease === "shared");
    expect(h.endpoint.lease).toBe("shared");
    expect(h.endpoint.leaseUntil).toBeNull();
    await h.port.dispose();
  });
});

describe("I16：close() 遇 dispose 抛错仍释放实例锁并关 DB", () => {
  class ThrowingDisposePort extends FakeStreamPort {
    async dispose(): Promise<void> {
      throw new Error("dispose boom");
    }
  }

  it("dispose 抛错 → close 重抛，实例锁文件仍被删除，且同 dbPath 可重启", async () => {
    const dir = tmp();
    const dbPath = join(dir, "mesh.db");
    const instPath = dbPath + ".instance.lock";

    const port = new ThrowingDisposePort();
    const host = await createMesh({
      dbPath,
      policies: { sessionFactory: stubFactory },
      streamPort: port,
      limits: { handoffTimeoutMs: 1000 },
    });
    await host.registerAccount({ id: "A", displayName: "A", endpointClass: "stream", initiate: ["chat"] });
    await host.registerEndpoint({ accountId: "A", topology: { kind: "unified" } });

    expect(existsSync(instPath)).toBe(true);

    await expect(host.close()).rejects.toThrow("dispose boom");

    // dispose 抛错不得跳过实例锁释放（single 模式释放即删文件）
    expect(existsSync(instPath)).toBe(false);

    // 未泄漏实例锁 ⇒ 同 dbPath 可重新启动（残留写者会挡住 acquire）
    const again = await createMesh({
      dbPath,
      policies: { sessionFactory: stubFactory },
      streamPort: new FakeStreamPort(),
    });
    expect(again).toBeDefined();
    await again.close();
    expect(dirname(dbPath)).toBe(dir);
  });
});