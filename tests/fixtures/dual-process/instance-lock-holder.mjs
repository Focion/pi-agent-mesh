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

/** 本进程启动时刻（与 EndpointLock.procStartedAt 同源：ps -p <pid> -o lstart=）。 */
function procStartedAt() {
  try {
    return execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
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