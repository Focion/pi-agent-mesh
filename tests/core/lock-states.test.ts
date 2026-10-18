// ═══════════════════════════════════════════════════════════════════════════
// I04：EndpointLock.inspect / ownerIsLive 五态判定。
// 缺失 → dead；损坏 JSON / shape 非法 → corrupted；不可读(权限) → unreadable；
// pid 不存在 → dead；pid 存活但启动时刻不符(pid 复用) → dead；启动时刻吻合 → alive；
// 取不到启动时刻 → unknown。
// 核心护栏（§19.6「绝不猜」）：损坏与不可读一律 unknown，绝不判 dead 触发回收。
// ═══════════════════════════════════════════════════════════════════════════

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EndpointLock } from "../../src/pi/lock.js";

describe("EndpointLock.inspect：判别联合（I04）", () => {
  let dir: string;
  const lockPath = () => join(dir, "test.lock");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mesh-lock-states-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("缺失 → missing", async () => {
    await expect(EndpointLock.inspect(lockPath())).resolves.toEqual({ status: "missing" });
  });

  it("坏 JSON → corrupted（绝不当 missing/dead）", async () => {
    writeFileSync(lockPath(), "{ not json");
    await expect(EndpointLock.inspect(lockPath())).resolves.toEqual({ status: "corrupted" });
  });

  it("shape 非法（缺 writerId / pid）→ corrupted", async () => {
    writeFileSync(lockPath(), JSON.stringify({ foo: 1 }));
    await expect(EndpointLock.inspect(lockPath())).resolves.toEqual({ status: "corrupted" });
  });

  it("不可读（chmod 000）→ unreadable", async () => {
    writeFileSync(lockPath(), JSON.stringify({ writerId: "w", pid: 1 }));
    chmodSync(lockPath(), 0o000);
    const r = await EndpointLock.inspect(lockPath());
    expect(r.status).toBe("unreadable");
    chmodSync(lockPath(), 0o644); // 恢复权限以便清理
  });

  it("正常锁 → ok + info（writersId/pid/lease/leaseUntil/procStartedAt 完整）", async () => {
    const lock = await EndpointLock.acquire(lockPath(), { writerId: "w-ok", lease: "shared" });
    const r = await EndpointLock.inspect(lockPath());
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.info.writerId).toBe("w-ok");
      expect(r.info.pid).toBe(process.pid);
      expect(r.info.lease).toBe("shared");
    }
    await lock.release();
  });
});

describe("EndpointLock.ownerIsLive：五态（死亡/存活/损坏/不可读/pid 复用）", () => {
  let dir: string;
  const lockPath = () => join(dir, "test.lock");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mesh-lock-live-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("缺失 → dead（无持有者，可回收）", async () => {
    expect(await EndpointLock.ownerIsLive(lockPath())).toBe("dead");
  });

  it("pid 不存在 → dead（kill -0 ESRCH，允许接管）", async () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({
        writerId: "w-dead",
        pid: 99_999_999,
        lease: "shared",
        acquiredAt: "",
        leaseUntil: null,
        procStartedAt: "",
      }),
    );
    expect(await EndpointLock.ownerIsLive(lockPath())).toBe("dead");
  });

  it("pid 存活但启动时刻不符 → dead（pid 已被复用，可回收）", async () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({
        writerId: "w-stale",
        pid: process.pid,
        lease: "shared",
        acquiredAt: "",
        leaseUntil: null,
        procStartedAt: "Thu Jan  1 00:00:00 1970",
      }),
    );
    expect(await EndpointLock.ownerIsLive(lockPath())).toBe("dead");
  });

  it("pid 存活且启动时刻吻合 → alive（拒绝接管）", async () => {
    const lock = await EndpointLock.acquire(lockPath(), { writerId: "w-live", lease: "shared" });
    expect(await EndpointLock.ownerIsLive(lockPath())).toBe("alive");
    await lock.release();
  });

  it("pid 存活但取不到启动时刻 → unknown（保守拒绝）", async () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({
        writerId: "w-old",
        pid: process.pid,
        lease: "shared",
        acquiredAt: "",
        leaseUntil: null,
        procStartedAt: "",
      }),
    );
    expect(await EndpointLock.ownerIsLive(lockPath())).toBe("unknown");
  });

  it("损坏 → unknown（绝不 dead，绝不触发回收）", async () => {
    writeFileSync(lockPath(), "{ broken json");
    expect(await EndpointLock.ownerIsLive(lockPath())).toBe("unknown");
  });

  it("不可读 → unknown（绝不 dead）", async () => {
    writeFileSync(lockPath(), JSON.stringify({ writerId: "w", pid: 1 }));
    chmodSync(lockPath(), 0o000);
    expect(await EndpointLock.ownerIsLive(lockPath())).toBe("unknown");
    chmodSync(lockPath(), 0o644);
  });
});