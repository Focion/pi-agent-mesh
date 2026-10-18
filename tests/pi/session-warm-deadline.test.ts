// ═══════════════════════════════════════════════════════════════════════════
// sessionFactory 自有秒级 deadline（I33 / §20.1）：sessionFactory 豁免
// policyTimeoutMs，但在 doWarm 里走 withWarmDeadline。永不解 resolve 的工厂 →
// 短 deadline 到点抛 NO_SESSION（非 ENDPOINT_GONE）、endpoint→unavailable、
// 写者锁释放；按时解 resolve 不受影响；工厂抛错仍映 NO_SESSION。两类失败都发
// policy_degraded {slot:"sessionFactory", degradedTo:"unrecoverable"}（reason
// 区分 timeout / threw）。
//
// 不依赖真 pi：deadline/抛错分支在 narrowSession 之前就短路，成功分支用一组
// 满足 narrowSession 的最小假 session 即可。锁走真 EndpointLock（tmp 目录）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Account,
  Endpoint,
  EndpointState,
  SessionFactory,
} from "../../src/core/types.js";
import { PiStreamPort } from "../../src/pi/stream-port.js";

type Degraded = { slot: string; reason: string; degradedTo: string };

interface Harness {
  port: PiStreamPort;
  states: EndpointState[];
  locks: (string | null)[];
  degraded: Degraded[];
  lockPath: string;
  remove(): void;
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

/** 永不解 resolve：供 deadline 象限（open/create 都 hang） */
const neverFactory: SessionFactory = {
  create: () => new Promise(() => {}),
  open: () => new Promise(() => {}),
};

const fastFactory: SessionFactory = {
  create: async () => ({ session: fakeSession(), piSessionId: "pi-1" }),
  open: async () => ({ session: fakeSession() }),
};

const throwFactory: SessionFactory = {
  create: async () => {
    throw new Error("factory boom");
  },
  open: async () => {
    throw new Error("factory boom");
  },
};

function makeHarness(factory: SessionFactory, warmTimeoutMs: number): Harness {
  const dir = mkdtempSync(join(tmpdir(), "mesh-warm-deadline-"));
  const endpoint: Endpoint = {
    id: "ep1",
    accountId: "a1",
    topology: { kind: "unified" },
    state: "cold",
    piSessionId: null,
    lease: "shared",
    leaseUntil: null,
    lastActiveAt: null,
  };
  const account: Account = { id: "a1", displayName: "A", endpointClass: "stream", initiate: ["chat"] };
  const states: EndpointState[] = [];
  const locks: (string | null)[] = [];
  const degraded: Degraded[] = [];
  const port = new PiStreamPort({
    writerId: "test-writer",
    sessionFactory: factory,
    getEndpoint: (id) => (id === "ep1" ? endpoint : undefined),
    getAccount: (id) => (id === "a1" ? account : undefined),
    buildTools: () => [],
    setEndpointState: (_id, s) => states.push(s),
    setEndpointSession: () => {},
    setEndpointLease: () => {},
    setEndpointLock: (_id, p) => locks.push(p),
    stateDir: dir,
    sessionWarmTimeoutMs: warmTimeoutMs,
    onPolicyDegraded: (info) =>
      degraded.push({ slot: info.slot, reason: info.reason, degradedTo: info.degradedTo }),
  });
  return {
    port,
    states,
    locks,
    degraded,
    lockPath: join(dir, "locks", "ep1.lock"),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("sessionFactory 自有 deadline（I33 §20.1）", () => {
  it("永不解 resolve 的工厂 → deadline 到点 NO_SESSION（非 ENDPOINT_GONE）、endpoint→unavailable、锁释放", async () => {
    const h = makeHarness(neverFactory, 40);
    await expect(h.port.warm("ep1", "exclusive")).rejects.toMatchObject({
      name: "PiPortError",
      code: "NO_SESSION",
    });
    expect(h.states).toContain("warming");
    expect(h.states.at(-1)).toBe("unavailable");
    // ① acquire 落锁 ② 失败释放（setEndpointLock 回 null），锁文件被删
    expect(h.locks[0]).toBe(h.lockPath);
    expect(h.locks.at(-1)).toBeNull();
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.degraded).toContainEqual({ slot: "sessionFactory", reason: "timeout", degradedTo: "unrecoverable" });
    h.remove();
  });

  it("按时解 resolve 的工厂 → hot、零降级、锁保持", async () => {
    const h = makeHarness(fastFactory, 5_000);
    await h.port.warm("ep1", "exclusive");
    expect(h.states.at(-1)).toBe("hot");
    expect(h.degraded).toHaveLength(0);
    expect(h.locks.at(-1)).not.toBeNull();
    await h.port.dispose(); // dispose 走 evict → 释放锁
    h.remove();
  });

  it("工厂抛错 → 仍映 NO_SESSION + policy_degraded reason:threw", async () => {
    const h = makeHarness(throwFactory, 5_000);
    await expect(h.port.warm("ep1", "exclusive")).rejects.toMatchObject({
      name: "PiPortError",
      code: "NO_SESSION",
    });
    expect(h.states.at(-1)).toBe("unavailable");
    expect(h.locks.at(-1)).toBeNull();
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.degraded).toContainEqual({ slot: "sessionFactory", reason: "threw", degradedTo: "unrecoverable" });
    h.remove();
  });
});