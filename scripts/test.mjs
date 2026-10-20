#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// test —— `npm test` 入口（T6）。在裸 `vitest run` 之上加两道保险：
//   1. Node 版本守卫：engines 要求 >=24.0.0（C07）。在更低 Node 上，vitest 的
//      fork 池会以 ERR_IPC_CHANNEL_CLOSED 静默退出 0，一个用例都不跑——必须先拦。
//   2. 用例数兜底：用 vitest 的 json reporter 读回 numTotalTests，即便未来 fork
//      池再次静默失败，只要实际跑到的用例数为 0 / 缺失，也判失败而非假绿。
//
// 额外参数透传给 vitest（如 `npm test -- tests/core/store.test.ts`）。
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 24) {
  process.stderr.write(
    `\n✗ Node 版本要求 >=24.0.0（C07 engines），当前 ${process.versions.node}。\n` +
      `  在更低 Node 上 vitest fork 池会静默退出 0、一个用例都不跑；请先切换 Node。\n`,
  );
  process.exit(1);
}

// json 报告写入临时目录（不污染仓库），跑完读回 numTotalTests。
const outDir = join(tmpdir(), `mesh-test-${process.pid}`);
const report = join(outDir, "report.json");
const extra = process.argv.slice(2);

const child = spawnSync(
  process.execPath,
  [VITEST, "run", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`, ...extra],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
);

if (child.error) {
  process.stderr.write(`\n✗ 无法启动 vitest：${child.error.message}\n`);
  process.exit(1);
}

let numTotal = -1;
try {
  numTotal = JSON.parse(readFileSync(report, "utf8")).numTotalTests ?? -1;
} catch {
  // 报告缺失/损坏：下面的兜底判定不放行「0 退出 + 无报告」。
}
try {
  rmSync(outDir, { recursive: true, force: true });
} catch {
  // 清理失败不影响结果。
}

if (child.status !== 0) {
  process.exit(child.status ?? 1);
}
if (!(numTotal > 0)) {
  process.stderr.write(
    `\n✗ vitest 退出码为 0，但实际跑到的用例数为 ${numTotal < 0 ? "不可读" : numTotal}。\n` +
      `  这通常是 fork 池静默失败（未运行任何用例）——不得判为通过。\n`,
  );
  process.exit(1);
}
process.stdout.write(`\n✓ ${numTotal} 个用例已实际运行。\n`);