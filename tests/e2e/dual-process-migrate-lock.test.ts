// ═══════════════════════════════════════════════════════════════════════════
// G02（本地验收·存储与迁移）：双进程实例锁先于迁移（I05 可执行证明）。
//
// 用第二个真实 OS 进程（tests/fixtures/dual-process/instance-lock-holder.mjs）
// O_EXCL 原子持有 dbPath + ".instance.lock"，再在本进程调用 createMesh 验证：
//   ① 单进程形态（默认）撞 EEXIST → 抛 LockHeldError，且 DB 尚未创建（锁先于迁移）；
//   ② sameHost（multi 模式）下 shared-shared 共存，同一 dbPath 可正常打开；
// 收尾显式 forceRelease 清理第二个进程遗留的锁文件。
// ═══════════════════════════════════════════════════════════════════════════

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMesh, type MeshHost, type SessionFactory } from "../../src/index.js";
import { EndpointLock, LockHeldError } from "../../src/pi/lock.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/dual-process/instance-lock-holder.mjs", import.meta.url),
);

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "dual-lock" }),
  open: async () => ({ session: {} }),
};

/** 启动持有锁的第二个进程，等它就绪（stdout 出现 "LOCKED"）后返回句柄。 */
function spawnHolder(lockPath: string): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(process.execPath, [FIXTURE, lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => {
      reject(new Error("instance-lock-holder did not become ready within 10s; stderr=" + stderr));
    }, 10_000);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.includes("LOCKED")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`instance-lock-holder exited early (code=${code} signal=${signal}) stderr=${stderr}`));
    });
  });
  return { child, ready };
}

function openSameHost(dbPath: string): Promise<MeshHost> {
  return createMesh({
    dbPath,
    transport: "sameHost",
    streamPort: new FakeStreamPort(),
    policies: { sessionFactory: stubSessionFactory },
    devMode: true,
  });
}

describe("G02: 双进程实例锁先于迁移（I05）", () => {
  const live: ChildProcess[] = [];
  afterEach(async () => {
    for (const c of live) {
      if (c.exitCode === null) c.kill("SIGTERM");
    }
    live.length = 0;
  });

  it("他进程持有实例锁 → 单进程形态拒绝启动且不建库；sameHost 共存", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-dual-lock-"));
    const dbPath = join(dir, "mesh.db");
    const lockPath = dbPath + ".instance.lock";

    const { child, ready } = spawnHolder(lockPath);
    live.push(child);
    await ready;
    expect(existsSync(lockPath)).toBe(true);

    // ① 单进程（默认 single）：撞 EEXIST → LockHeldError 携带持锁者，DB 未创建。
    await expect(
      createMesh({
        dbPath,
        streamPort: new FakeStreamPort(),
        policies: { sessionFactory: stubSessionFactory },
        devMode: true,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof LockHeldError &&
        err.code === "LOCK_HELD" &&
        err.heldBy?.pid === child.pid,
      "should throw LockHeldError naming the live holder process",
    );
    expect(existsSync(dbPath)).toBe(false); // 锁先于迁移：DB 尚未创建（I05）

    // ② sameHost（multi）：shared-shared 共存，同一 dbPath 正常打开（§19.3）。
    const host = await openSameHost(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true); // 迁移此刻才发生
    } finally {
      await host.close();
    }

    // 清理：显式 forceRelease 清掉第二个进程遗留的锁文件。
    await EndpointLock.forceRelease(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });
});