// ═══════════════════════════════════════════════════════════════════════════
// EndpointLock（M3 的可执行落点，§8.3/§8.4/§19.4）
//
// 单写者靠「锁文件」实现：wx（O_EXCL）原子创建，抢到即持有。
// 抢锁失败 ⇒ 调用方把 Endpoint 标记 unavailable，绝不接管（§8.4①）。
// 崩溃留下的陈旧锁不由库擅自清除——forceRelease 是显式的宿主/工具操作，
// 不是恢复流程的自动分支。
//
// 两种模式（mode）：
// - "single"（默认）＝严格单写者：O_EXCL 撞 EEXIST 即 LockHeldError，任何租约
//   都不允许多持有者。endpoint stream 锁用这个——M3「同一 endpointId 全局最多
//   一个持锁写者」（§19.4）。
// - "multi"＝多进程附着：shared 撞 shared 时共存（每个进程拿各自的锁对象，锁
//   文件保留首写者信息）。仅 `.instance.lock` 用这个——sameHost 下 N 个进程
//   合法共享同一 dbPath（§19.3），实例锁不再是一对一排他。
//
// devMode 的单写者检查（§23.7）以 assertHeld() 为判据：每次经 StreamPort
// 写入前校验本进程仍持有锁且租约未过期。
// ═══════════════════════════════════════════════════════════════════════════

import { constants } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MeshLease } from "../core/types.js";
import { isoNow } from "../core/util.js";

export interface LockInfo {
  writerId: string;
  pid: number;
  lease: MeshLease;
  acquiredAt: string;
  leaseUntil: string | null;
}

export type LockMode = "single" | "multi";

export class LockHeldError extends Error {
  readonly code = "LOCK_HELD" as const;
  readonly heldBy: LockInfo | undefined;
  constructor(lockPath: string, heldBy: LockInfo | undefined) {
    super(
      `mesh-pi: endpoint lock already held: ${lockPath}` +
        (heldBy ? ` (writer=${heldBy.writerId} pid=${heldBy.pid})` : ""),
    );
    this.name = "LockHeldError";
    this.heldBy = heldBy;
  }
}

export class EndpointLock {
  private released = false;

  private constructor(
    readonly lockPath: string,
    readonly writerId: string,
    private lease: MeshLease,
    private leaseUntilMs: number | null,
    private readonly mode: LockMode,
  ) {}

  /**
   * 原子抢锁（O_EXCL）。已存在 ⇒ LockHeldError（携带能读出的持锁者信息）。
   * lease="exclusive" 必须给 leaseTtlMs（§8.3：exclusive 必须有超时）。
   * mode="multi" 且双方 shared 时允许共存（仅 .instance.lock，§19.3）。
   */
  static async acquire(
    lockPath: string,
    opts: { writerId: string; lease?: MeshLease; leaseTtlMs?: number; mode?: LockMode },
  ): Promise<EndpointLock> {
    const lease = opts.lease ?? "exclusive";
    const mode = opts.mode ?? "single";
    const leaseUntilMs =
      lease === "exclusive" ? Date.now() + (opts.leaseTtlMs ?? 60_000) : null;
    const lock = new EndpointLock(lockPath, opts.writerId, lease, leaseUntilMs, mode);
    await mkdir(dirname(lockPath), { recursive: true });
    try {
      const fh = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      await fh.writeFile(JSON.stringify(lock.info(), null, 2));
      await fh.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // 仅 multi 模式（实例锁）允许 shared-shared 共存：N 进程共享同一 dbPath。
        const existing = await EndpointLock.readInfo(lockPath);
        if (mode === "multi" && lease === "shared" && existing?.lease === "shared") {
          return lock;
        }
        throw new LockHeldError(lockPath, existing);
      }
      throw err;
    }
    return lock;
  }

  /** 读出当前持锁者信息；锁不存在或内容不可解析 ⇒ undefined */
  static async readInfo(lockPath: string): Promise<LockInfo | undefined> {
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockInfo>;
      if (typeof parsed.writerId !== "string" || typeof parsed.pid !== "number") return undefined;
      return {
        writerId: parsed.writerId,
        pid: parsed.pid,
        lease: parsed.lease === "shared" ? "shared" : "exclusive",
        acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
        leaseUntil: typeof parsed.leaseUntil === "string" ? parsed.leaseUntil : null,
      };
    } catch {
      return undefined;
    }
  }

  /** 显式清除锁文件（宿主运维 / 测试用；恢复流程不得自动调用，M3） */
  static async forceRelease(lockPath: string): Promise<void> {
    await unlink(lockPath).catch(() => {});
  }

  private info(): LockInfo {
    return {
      writerId: this.writerId,
      pid: process.pid,
      lease: this.lease,
      acquiredAt: isoNow(),
      leaseUntil: this.leaseUntilMs === null ? null : new Date(this.leaseUntilMs).toISOString(),
    };
  }

  /** 本进程是否仍持有锁且租约未过期 */
  held(): boolean {
    if (this.released) return false;
    if (this.lease === "exclusive" && this.leaseUntilMs !== null && this.leaseUntilMs <= Date.now()) {
      return false; // 租约已过期：持有方必须按「已失去」处理（§8.3 超时强制释放）
    }
    return true;
  }

  /** devMode 单写者检查（§23.7）：写入前调用，失守即抛 */
  assertHeld(endpointId: string): void {
    if (!this.held()) {
      throw new Error(
        `invariant_violated: single-writer lock lost for endpoint ${endpointId} ` +
          `(${this.released ? "released" : "exclusive lease expired"})`,
      );
    }
  }

  /** 续租（exclusive 窗口需要延长时；重写锁文件里的 leaseUntil） */
  async refresh(leaseTtlMs: number): Promise<void> {
    if (this.released) return;
    if (this.lease === "exclusive") this.leaseUntilMs = Date.now() + leaseTtlMs;
    await writeFile(this.lockPath, JSON.stringify(this.info(), null, 2)).catch(() => {});
  }

  /** 释放（幂等） */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    // single（endpoint 锁）恒删文件：单写者释放即让位，下次 warm 可重新抢。
    // multi（实例锁）不删：多进程共享标记，退出方留下文件无害，他人以共存路径附着。
    if (this.mode === "single") {
      await unlink(this.lockPath).catch(() => {});
    }
  }
}
