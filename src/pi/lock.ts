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

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MeshLease } from "../core/types.js";
import { isoNow } from "../core/util.js";

const execFileP = promisify(execFile);

export interface LockInfo {
  writerId: string;
  pid: number;
  lease: MeshLease;
  acquiredAt: string;
  leaseUntil: string | null;
  /** 持锁进程的启动时刻（M-R10 的 pid 复用护栏）；取不到 ⇒ 空串 */
  procStartedAt: string;
  /** single=严格单写者 / multi=多进程附着（A13：锁文件记录 mode，single 与 multi 互斥） */
  mode: LockMode;
}

/** 进程存活判据（§27.4）：kill -0 可为 ESRCH（死）/ EPERM（活但无权限）/ 0（活） */
async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读某 pid 的进程启动时刻（ps -o lstart=，macOS/Linux 一致）；失败 ⇒ undefined。
 *  A20：固定 TZ=UTC + LC_ALL=C，令 `lstart` 输出与调用方时区/语言无关——否则同样一个
 *  宿主进程在不同 TZ/locale 下会读出不同启动串，ownerIsLive 的字符串比对会误判「死」。 */
async function procStartedAt(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("ps", ["-p", String(pid), "-o", "lstart="], {
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    const s = stdout.trim();
    return s === "" ? undefined : s;
  } catch {
    return undefined;
  }
}

/** 把读出的原始 JSON 归一成 LockInfo（沿用 acquire 的宽容取值规则） */
function normalizeLockInfo(parsed: Partial<LockInfo>): LockInfo {
  return {
    writerId: parsed.writerId as string,
    pid: parsed.pid as number,
    lease: parsed.lease === "shared" ? "shared" : "exclusive",
    acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
    leaseUntil: typeof parsed.leaseUntil === "string" ? parsed.leaseUntil : null,
    procStartedAt: typeof parsed.procStartedAt === "string" ? parsed.procStartedAt : "",
    // 旧锁（single 时代）没有 mode ⇒ 按 single 归因；multi 只见于实例锁。
    mode: parsed.mode === "multi" ? "multi" : "single",
  };
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
    private readonly procStartedAt: string,
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
    // 记录本进程启动时刻（M-R10）：接管的 pid 复用护栏要拿它与候选 pid 比对
    const myStartedAt = (await procStartedAt(process.pid)) ?? "";
    const lock = new EndpointLock(lockPath, opts.writerId, lease, leaseUntilMs, mode, myStartedAt);
    await mkdir(dirname(lockPath), { recursive: true });
    try {
      const fh = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      await fh.writeFile(JSON.stringify(lock.info(), null, 2));
      await fh.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // 仅 multi 模式（实例锁）允许 shared-shared 共存：N 进程共享同一 dbPath。
        // A13：还要核对 existing.mode 也是 "multi" —— 一个 single 写者（哪怕 lease=shared）
        // 不能与 multi 写者共用同一锁文件，single/multi 互斥。
        const existing = await EndpointLock.readInfo(lockPath);
        if (mode === "multi" && lease === "shared" && existing?.mode === "multi" && existing?.lease === "shared") {
          return lock;
        }
        throw new LockHeldError(lockPath, existing);
      }
      throw err;
    }
    return lock;
  }

  /** 锁文件读结果的判别联合（I04：区分缺失 / 损坏 / 不可读 / 正常，绝不把坏文件当「无主」） */
  static async inspect(
    lockPath: string,
  ): Promise<
    | { status: "missing" }
    | { status: "corrupted" }
    | { status: "unreadable"; error: unknown }
    | { status: "ok"; info: LockInfo }
  > {
    let text: string;
    try {
      text = await readFile(lockPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "unreadable", error: err };
    }
    let parsed: Partial<LockInfo>;
    try {
      parsed = JSON.parse(text) as Partial<LockInfo>;
    } catch {
      return { status: "corrupted" };
    }
    if (typeof parsed.writerId !== "string" || typeof parsed.pid !== "number") {
      return { status: "corrupted" };
    }
    return { status: "ok", info: normalizeLockInfo(parsed) };
  }

  /** 读出当前持锁者信息；锁不存在或内容不可解析 ⇒ undefined（抢锁 EEXIST 分支沿用此语义） */
  static async readInfo(lockPath: string): Promise<LockInfo | undefined> {
    const r = await EndpointLock.inspect(lockPath);
    return r.status === "ok" ? r.info : undefined;
  }

  /**
   * 死写者判定（§27.4 / M-R10）：锁文件的持有者是否「进程真的不存在」。
   * - "dead"：锁文件缺失，或 pid 不存在（kill -0 失败），或其启动时刻与记录不符（pid 已被复用）——允许接管。
   * - "alive"：pid 存活且启动时刻吻合——另一活进程持有，拒绝接管。
   * - "unknown"：锁文件损坏 / 不可读，或读到 pid 存活但取不到启动时刻——两个判据取不齐，保守拒绝，绝不猜（§19.6）。
   */
  static async ownerIsLive(lockPath: string): Promise<"alive" | "dead" | "unknown"> {
    const r = await EndpointLock.inspect(lockPath);
    if (r.status === "missing") return "dead";
    if (r.status === "corrupted" || r.status === "unreadable") return "unknown";
    const info = r.info;
    if (!(await pidAlive(info.pid))) return "dead";
    if (!info.procStartedAt) return "unknown"; // 旧锁没有启动时刻，无法比对
    const cur = await procStartedAt(info.pid);
    if (cur === undefined) return "unknown";
    return cur === info.procStartedAt ? "alive" : "dead";
  }

  /** 显式清除锁文件（宿主运维 / 测试用；恢复流程不得自动调用，M3） */
  static async forceRelease(lockPath: string): Promise<void> {
    await unlink(lockPath).catch(() => {});
  }

  /**
   * 原子接管陈旧锁（A12/A13）：rename 抢占 + 抢到后再判活，替代「先 ownerIsLive 再
   * forceRelease」的 check-then-delete 序列——两个进程同时回收时，后 check 者会删掉先抢
   * 到的新锁，出现两个写者。rename 是原子操作：只有一个回收者能移走文件，移走后独占读取
   * 判据，成立才清、不成立原子放回，绝不删活锁/坏锁。
   *
   * 返回：
   * - "reclaimed"：文件缺失（无主）或遗留持有者确已死 → 已清除，可安全抢锁。
   * - "held"：遗留持有者仍活（或该锁是 multi，见 A13）→ 锁文件已还原，不可接管。
   * - "unknown"：判据取不齐（pid 活但启动时刻未知、文件损坏/不可读）→ 保守还原，拒绝接管（§19.6）。
   */
  static async reclaim(lockPath: string): Promise<"reclaimed" | "held" | "unknown"> {
    const tmp = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, tmp);
    } catch (err) {
      // 文件已不在：要么本就无主，要么被别的回收者抢走。返回 reclaimed 无妨——
      // 后续抢锁靠 O_EXCL 兜底（实例锁 acquire / 端点 warm 抢锁）。
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "reclaimed";
      throw err;
    }

    // A13：multi（实例锁）不按单个死 pid 判活回收——首写者退出后同一 dbPath 可能仍有
    // 其他 sameHost 进程附着。single 才走单写者 liveness。
    const heldBy = await EndpointLock.readInfo(tmp);
    if (heldBy?.mode === "multi") {
      await EndpointLock.restore(tmp, lockPath);
      return "held";
    }

    const verdict = await EndpointLock.ownerIsLive(tmp);
    if (verdict === "dead") {
      await unlink(tmp).catch(() => {});
      return "reclaimed";
    }
    // alive / unknown / 损坏锁：还回去。
    await EndpointLock.restore(tmp, lockPath);
    return verdict === "alive" ? "held" : "unknown";
  }

  /** 把移走的锁文件原子放回 lockPath（link 不覆盖：他人已重建 lockPath 则保留他人锁）。 */
  private static async restore(tmp: string, lockPath: string): Promise<void> {
    try {
      await link(tmp, lockPath);
    } catch {
      // lockPath 已被他人重建：保留他人锁文件，丢弃 tmp（我们移走的旧锁已过时）。
    }
    await unlink(tmp).catch(() => {});
  }

  private info(): LockInfo {
    return {
      writerId: this.writerId,
      pid: process.pid,
      lease: this.lease,
      acquiredAt: isoNow(),
      leaseUntil: this.leaseUntilMs === null ? null : new Date(this.leaseUntilMs).toISOString(),
      procStartedAt: this.procStartedAt,
      mode: this.mode,
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

  /** 本进程是否仍是锁文件的持有者（writerId+pid 匹配；文件缺失/损坏/不可读 ⇒ 否，绝不猜）。 */
  private async holdsCurrentFile(): Promise<boolean> {
    const heldBy = await EndpointLock.readInfo(this.lockPath);
    if (!heldBy) return false;
    return heldBy.writerId === this.writerId && heldBy.pid === process.pid;
  }

  /** 续租（exclusive 窗口需要延长时；重写锁文件里的 leaseUntil） */
  async refresh(leaseTtlMs: number): Promise<void> {
    if (this.released) return;
    // A12：续租前校验持有者——若锁已被他人接管，绝不覆盖他人锁文件。
    if (!(await this.holdsCurrentFile())) return;
    if (this.lease === "exclusive") this.leaseUntilMs = Date.now() + leaseTtlMs;
    await writeFile(this.lockPath, JSON.stringify(this.info(), null, 2)).catch(() => {});
  }

  /** 改写持有租约（I16：exclusive 升降级后锁文件与内存租约同步；重写 lease / leaseUntil） */
  async setLease(lease: MeshLease, leaseTtlMs?: number): Promise<void> {
    if (this.released) return;
    // A12：改写前校验持有者，绝不覆盖他人锁。
    if (!(await this.holdsCurrentFile())) return;
    this.lease = lease;
    this.leaseUntilMs = lease === "exclusive" ? Date.now() + (leaseTtlMs ?? 60_000) : null;
    await writeFile(this.lockPath, JSON.stringify(this.info(), null, 2)).catch(() => {});
  }

  /** 释放（幂等） */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    // single（endpoint 锁）恒删文件：单写者释放即让位，下次 warm 可重新抢。
    // multi（实例锁）不删：多进程共享标记，退出方留下文件无害，他人以共存路径附着。
    if (this.mode === "single") {
      // A12：删除前校验仍是本进程的锁文件，绝不误删他人（陈旧锁靠 reclaim 显式接管）。
      if (await this.holdsCurrentFile()) {
        await unlink(this.lockPath).catch(() => {});
      }
    }
  }
}
