#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// test —— `npm test` 入口（T6）。在裸 `vitest run` 之上加三道保险：
//   1. 依赖一致性：node_modules 与 package-lock 不符（含 devDependencies）时，测试
//      结果不可信——先拦（A42）。
//   2. Node 版本守卫：engines 要求 >=24.0.0（C07）。在更低 Node 上，vitest 的
//      fork 池会以 ERR_IPC_CHANNEL_CLOSED 静默退出 0，一个用例都不跑——必须先拦。
//   3. 用例数兜底：用 vitest 的 json reporter 读回 numTotalTests，即便未来 fork
//      池再次静默失败，只要实际跑到的用例数为 0 / 缺失，也判失败而非假绿。
//
// 额外参数透传给 vitest（如 `npm test -- tests/core/store.test.ts`）。
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertInstalledDepsMatch } from "./lib/deps.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

try {
  assertInstalledDepsMatch();
} catch (err) {
  process.stderr.write(`\n✗ ${err.message}\n`);
  process.exit(1);
}

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

let reportData = null;
try {
  reportData = JSON.parse(readFileSync(report, "utf8"));
} catch {
  // 报告缺失/损坏：下面的兜底判定不放行「0 退出 + 无报告」。
}
try {
  rmSync(outDir, { recursive: true, force: true });
} catch {
  // 清理失败不影响结果。
}

// A45：numTotalTests 包含 skipped/todo——「实际运行」应以 total 扣除 pending/todo 计，
// 否则大量 skip 的套件也会被当作「跑满了」。
const total = reportData?.numTotalTests ?? -1;
const skippedCnt = (reportData?.numPendingTests ?? 0) + (reportData?.numTodoTests ?? 0);
const executed = total >= 0 ? total - skippedCnt : -1;

if (child.status !== 0) {
  process.exit(child.status ?? 1);
}
if (!(executed > 0)) {
  process.stderr.write(
    `\n✗ vitest 退出码为 0，但实际运行用例数为 ${executed < 0 ? "不可读" : executed}` +
      `（total ${total < 0 ? "不可读" : total}，skipped/todo ${skippedCnt}）。\n` +
      `  这通常是 fork 池静默失败或用例全部被跳过——不得判为通过。\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `\n✓ ${total} 个用例（实际运行 ${executed} 个，skipped/todo ${skippedCnt} 个）。\n`,
);