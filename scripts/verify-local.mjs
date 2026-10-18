#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// verify-local —— 本地整体验收门（W15 / G01–G07）。可重复、可机器判定：
// 每一道门跑一组确定性命令，全部通过才 exit 0；任一失败 exit 1。
//
// 用法：
//   npm run verify:local                          # 默认跑全部 G01–G07（full）
//   npm run verify:local -- --suite G03           # 单门
//   npm run verify:local -- --suite G01,G02,G07   # 多门（逗号分隔）
//   npm run verify:local -- --suite G06 --skip-bench
//   npm run verify:local -- --suite G07 --skip-coverage
//
// full 语义（计划 §8）：任何 gate 缺失、未运行即失败；用 --skip-* 跳过某项后，
// 即使其余全绿也 exit 2（明示「非 full」，防止带 skip 却声称全绿）。
//
// verify:package（G08/G09）属 W16，由 scripts/verify-package.mjs 承担（此处只留
// package.json 占位，不做假绿）。
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateTypesConsumers } from "./lib/consume.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const ALL = ["G01", "G02", "G03", "G04", "G05", "G06", "G07"];

// ── 参数 ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const SKIP_BENCH = flag("--skip-bench");
const SKIP_COVERAGE = flag("--skip-coverage");
// 收集所有 --suite 值（可逗号分隔、可重复出现）。
const suites = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--suite" && args[i + 1]) {
    suites.push(...args[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
    i++;
  }
}
if (suites.some((s) => !ALL.includes(s))) {
  console.error(`✗ 未知 gate：${suites.filter((s) => !ALL.includes(s)).join(",")}（合法值 ${ALL.join(",")}）`);
  process.exit(1);
}
const SELECTED = flag("--all") || suites.length === 0 ? ALL : [...new Set(suites)];

// ── 工具 ─────────────────────────────────────────────────────────────────────

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function step(label) {
  process.stdout.write(`\n▶ ${label}\n`);
}
function ok(msg) {
  process.stdout.write(`  ✓ ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\n✗ ${msg}\n`);
  process.exit(1);
}
function requireRun(cmd, argv, label) {
  const r = run(cmd, argv);
  if (r.status !== 0) fail(`${label} 失败（exit ${r.status}）\n${r.stdout || ""}${r.stderr || ""}`);
  ok(label);
}
function vitest(...argv) {
  requireRun(process.execPath, [VITEST, "run", ...argv], `vitest run ${argv.join(" ")}`);
}

// ── 各门 ─────────────────────────────────────────────────────────────────────

function gateG01() {
  step("G01 类型/分层/公共面");
  requireRun(npm, ["run", "typecheck"], "tsc --noEmit");
  requireRun(npm, ["run", "check:imports"], "check:imports（G1–G4）");
  requireRun(process.execPath, ["scripts/gen-snapshots.mjs", "--check"], "gen-snapshots --check（API/DDL 基线）");
  requireRun(npm, ["run", "build"], "tsup build（类型消费依赖 dist）");
  const tmp = mkdtempSync(join(tmpdir(), "mesh-verify-"));
  try {
    const nm = join(tmp, "node_modules");
    const scoped = join(nm, "@pi");
    mkdirSync(scoped, { recursive: true });
    symlinkSync(ROOT, join(scoped, "agent-mesh"), "dir");
    validateTypesConsumers({ tmp, nm, run, ok, fail });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function gateG02() {
  step("G02 存储/迁移");
  if (!existsSync(join(ROOT, "node_modules"))) fail("node_modules 缺失——先 npm install。");
  vitest(
    "tests/core/store-migrate.test.ts",
    "tests/core/store.test.ts",
    "tests/core/store-tx.test.ts",
    "tests/core/health.test.ts",
    "tests/e2e/lock-before-migrate.test.ts",
    "tests/e2e/g02-baseline-reopen.test.ts",
    "tests/e2e/dual-process-migrate-lock.test.ts",
  );
}

function gateG03() {
  step("G03 功能/权限/状态机（台账 + 16 断言）");
  requireRun(process.execPath, ["scripts/gen-gap-ledger.mjs", "--check"], "gen-gap-ledger --check（41 项台账一致 + 映射测试并集）");
}

function gateG04() {
  step("G04 真实 SDK + faux");
  vitest("tests/pi/");
}

function gateG05() {
  step("G05 多进程/恢复");
  vitest(
    "tests/e2e/two-process.test.ts",
    "tests/e2e/crash-property.test.ts",
    "tests/pi/stream-port-lease.test.ts",
    "tests/core/recovery.test.ts",
    "tests/e2e/recovery.test.ts",
  );
}

function gateG06() {
  step("G06 规模/成本/吞吐");
  if (SKIP_BENCH) {
    ok("已跳过基准（--skip-bench）");
    return "skipped";
  }
  requireRun(process.execPath, ["scripts/bench.mjs"], "bench（3 基准 + V05）");
  return "pass";
}

function gateG07() {
  step("G07 覆盖率/devMode/观测");
  if (SKIP_COVERAGE) {
    ok("已跳过覆盖率（--skip-coverage）");
    return "skipped";
  }
  requireRun(process.execPath, [VITEST, "run", "--coverage", "--no-fileParallelism"], "vitest run --coverage（core 语句 ≥90%，串行 forks 避免 v8 临时文件合并竞态）");
  requireRun(process.execPath, ["scripts/coverage-gate.mjs"], "coverage-gate（四范围分支 ≥95%）");
  vitest("tests/e2e/default-policy-observability.test.ts");
  return "pass";
}

const GATES = {
  G01: { run: gateG01, tag: "类型/分层/公共面" },
  G02: { run: gateG02, tag: "存储/迁移" },
  G03: { run: gateG03, tag: "功能/权限/状态机" },
  G04: { run: gateG04, tag: "真实 SDK + faux" },
  G05: { run: gateG05, tag: "多进程/恢复" },
  G06: { run: gateG06, tag: "规模/成本/吞吐" },
  G07: { run: gateG07, tag: "覆盖率/devMode/观测" },
};

// ── 主流程 ───────────────────────────────────────────────────────────────────

{
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 19)) {
    fail(`Node 版本要求 >=22.19.0（C07 engines），当前 ${process.versions.node}。`);
  }
  process.stdout.write(`[verify:local] node ${process.versions.node} · suites ${SELECTED.join(",")}\n`);
}

const results = {};
let skipped = false;
for (const g of SELECTED) {
  const res = GATES[g].run();
  results[g] = res === "skipped" ? "SKIPPED" : "PASS";
  if (res === "skipped") skipped = true;
}

process.stdout.write("\n═ 汇总 ═\n");
for (const g of SELECTED) {
  process.stdout.write(`  ${results[g].padEnd(7)} ${g}  ${GATES[g].tag}\n`);
}

const skippedNames = Object.entries(results).filter(([, v]) => v === "SKIPPED").map(([k]) => k);
if (skipped) {
  process.stderr.write(`\n⚠ 非 full：${skippedNames.join(",")} 被 --skip-* 跳过（其余全绿）。G01–G07 全门 ` +
    `full 验证请去掉 --skip-* 重跑。\n`);
  process.exit(2);
}
process.stdout.write("\n✅ verify:local 全部通过（full，无 skip）。\n");