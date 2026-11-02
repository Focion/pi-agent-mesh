// ─────────────────────────────────────────────────────────────────────────────
// G02 双进程迁移锁：持有一个 dbPath + ".instance.lock" 的真实 OS 进程（fixture）。
//
// 用 O_EXCL（openSync "wx"）原子写入与 EndpointLock.acquire 同构的 LockInfo JSON
// （lease="shared"，与 createMesh 抢 .instance.lock 的写法一致），保活直到收到
// SIGTERM/SIGINT；锁文件落定后向 stdout 输出一行 "LOCKED" 作为测试侧的就绪信号。
// 纯 Node ESM——不 import TS，因此不依赖源码构建产物即可被 child_process 直接执行。
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { closeSync, openSync, mkdirSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const lockPath = process.argv[2];
if (!lockPath) {
  console.error("usage: instance-lock-holder.mjs <lockPath>");
  process.exit(2);
}

/** 本进程启动时刻（与 EndpointLock.procStartedAt 同源：ps -p <pid> -o lstart=）。
 *  固定 TZ=UTC + LC_ALL=C，与 lock.ts 的 A20 修正对齐——否则两边在时区/语言上不一致，
 *  ownerIsLive 的字符串比对会误判持锁者「死」。 */
function procStartedAt() {
  try {
    return execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    }).trim();
  } catch {
    return "";
  }
}

const lockInfo = {
  writerId: "fixture-instance-holder",
  pid: process.pid,
  lease: "shared",
  acquiredAt: new Date().toISOString(),
  leaseUntil: null,
  procStartedAt: procStartedAt(),
  // A13：实例锁在 sameHost 下以 mode="multi" 记入锁文件，sameHost 共存检查
  // （multi + shared + multi + shared）依赖它；缺省会被 normalizeLockInfo 归为 single。
  mode: "multi",
};

mkdirSync(dirname(lockPath), { recursive: true });
const fd = openSync(lockPath, "wx"); // O_WRONLY | O_CREAT | O_EXCL（与 EndpointLock.acquire 的抢锁同构）
writeSync(fd, JSON.stringify(lockInfo, null, 2));
closeSync(fd);

// 立即把就绪信号写进 stdout（fd 1 同步写，不依赖行缓冲）。
writeSync(1, "LOCKED\n");

// 保活：真实进程特征（pid 存活），直到测试侧 SIGTERM。
const keepalive = setInterval(() => {}, 60_000);
process.on("SIGTERM", () => {
  clearInterval(keepalive);
  process.exit(0);
});
process.on("SIGINT", () => {
  clearInterval(keepalive);
  process.exit(0);
});