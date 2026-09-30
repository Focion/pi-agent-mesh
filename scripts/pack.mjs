#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// mesh-pack — 把 @pi/agent-mesh 打成 npm tarball（外部可 `npm i <tgz>`），不上传。
//
// 用法：
//   node scripts/pack.mjs [--skip-tests] [--skip-verify] [--out <dir>]
//
// 步骤：
//   1. Node 版本守卫（>=20；完整 pi 测试套件需要 >=22.19）
//   2. tsc --noEmit + check:imports（G1–G4 门禁）
//   3. vitest（除非 --skip-tests）
//   4. `npm pack --json`（package.json 的 prepack 钩子已跑 `npm run build`）
//   5. 校验 tarball 文件名单
//   6. 离线消费者冒烟（除非 --skip-verify）：解包到临时 node_modules，只软链
//      better-sqlite3（模拟消费者只装了 dependencies），import/require 根入口与
//      core 子入口，确认无「静态 pi 依赖泄漏」且 ESM/CJS 双条件都能用。
//
// 产物落在 dist-tarball/（已 gitignore），不会 publish 到任何 registry。
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optValue = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SKIP_TESTS = flag("--skip-tests");
const SKIP_VERIFY = flag("--skip-verify");
const OUT = resolve(ROOT, optValue("--out", "dist-tarball"));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// ── 工具 ─────────────────────────────────────────────────────────────────────

function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
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
  if (r.status !== 0) {
    fail(`${label} 失败（exit ${r.status}）\n${r.stdout || ""}${r.stderr || ""}`);
  }
  ok(label);
}

// ── 1. Node 版本守卫 ─────────────────────────────────────────────────────────

{
  const [maj, min] = process.versions.node.split(".").map(Number);
  const full = process.versions.node;
  if (maj < 20) fail(`Node 版本要求 >=20（engines），当前 ${full}。`);
  const warnPi = maj < 22 || (maj === 22 && min < 19);
  process.stdout.write(`[pack] node ${full} · 包 ${PKG.name}@${PKG.version}\n`);
  if (warnPi) {
    process.stdout.write(`       提示：完整测试会加载 pi（需 >=22.19）；可用 --skip-tests 跳过。\n`);
  }
}

// ── 2. 源码门禁 ────────────────────────────────────────────────────────────

step("类型检查 + 边界门禁");
requireRun(npm, ["run", "typecheck"], "tsc --noEmit");
requireRun(npm, ["run", "check:imports"], "check:imports（G1–G4）");

// ── 3. 测试 ─────────────────────────────────────────────────────────────────

if (SKIP_TESTS) {
  ok("已跳过测试（--skip-tests）");
} else {
  step("全量测试");
  requireRun(npm, ["run", "test"], "vitest run");
}

// ── 4. 构建 + 打包 ─────────────────────────────────────────────────────────

step("构建 dist");
requireRun(npm, ["run", "build"], "tsup build");

step(`打包到 ${OUT}`);
mkdirSync(OUT, { recursive: true });
// --ignore-scripts：跳过 prepack（上面已显式 build），保证 pack 的 stdout 是纯 JSON。
const packRes = run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", OUT]);
if (packRes.status !== 0) fail(`npm pack 失败（exit ${packRes.status}）\n${packRes.stderr || ""}`);

let manifest;
try {
  const idx = packRes.stdout.indexOf("[");
  const jsonText = idx >= 0 ? packRes.stdout.slice(idx) : packRes.stdout;
  const json = JSON.parse(jsonText.trim());
  manifest = Array.isArray(json) ? json[0] : json;
} catch {
  fail(`无法解析 npm pack --json 输出：\n${packRes.stdout || packRes.stderr || ""}`);
}
if (!manifest?.filename) fail(`npm pack 未返回文件名：\n${packRes.stdout}`);

const tarball = join(OUT, manifest.filename);
if (!existsSync(tarball)) fail(`产物缺失：${tarball}`);
ok(`tarball: ${tarball}（${(statSync(tarball).size / 1024).toFixed(1)} KiB · ${manifest.files?.length ?? "?"} 文件）`);

// ── 5. 校验 tarball 名单 ───────────────────────────────────────────────────

step("校验 tarball 名单");
const packed = new Set(manifest.files?.map((f) => f.path) ?? []);
const REQUIRED = [
  "package.json",
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/core/index.js",
  "dist/core/index.cjs",
  "dist/core/index.d.ts",
  "migrations/000_init.sql",
];
for (const p of REQUIRED) {
  if (!packed.has(p)) fail(`tarball 缺少关键文件：${p}`);
}
const FORBIDDEN = ["src/", "demo/", "tests/", "docs/", "node_modules/"];
for (const p of FORBIDDEN) {
  if ([...packed].some((f) => f.startsWith(p))) fail(`tarball 不应包含源码/目录：${p}`);
}
ok(`含 ${REQUIRED.length} 个关键文件，无 src/demo/tests/docs/node_modules 泄漏`);

// ── 6. 离线消费者冒烟 ─────────────────────────────────────────────────────

if (SKIP_VERIFY) {
  ok("已跳过消费者冒烟（--skip-verify）");
} else {
  step("离线消费者冒烟（仅 better-sqlite3，模拟外部 install 后 import）");
  const tmp = mkdtempSync(join(tmpdir(), "mesh-pack-"));
  try {
    const nm = join(tmp, "node_modules");
    const pkgDir = join(nm, "@pi", "agent-mesh");
    mkdirSync(pkgDir, { recursive: true });

    const tarRes = run("tar", ["-xzf", tarball, "-C", pkgDir, "--strip-components=1"]);
    if (tarRes.status !== 0) fail(`解包失败：${tarRes.stderr || tarRes.stdout}`);

    // 模拟消费者「只装了 dependencies」：软链 better-sqlite3 进临时 node_modules。
    // 关键断言：root/core 入口不静态 import pi（pi 是可选的动态加载 peer）。
    const bsqlRoot = join(ROOT, "node_modules", "better-sqlite3");
    if (!existsSync(bsqlRoot)) fail("仓库 node_modules/better-sqlite3 缺失——先 npm install。");
    symlinkSync(bsqlRoot, join(nm, "better-sqlite3"), "dir");

    writeFileSync(
      join(tmp, "consumer.mjs"),
      `
const root = await import("@pi/agent-mesh");
const core = await import("@pi/agent-mesh/core");
const f = (m, n, label) => { if (typeof m[n] !== "function") throw new Error(label + "." + n + " 非函数(实际 " + typeof m[n] + ")"); };
f(root, "createMesh", "root"); f(root, "createPiSessionFactory", "root");
f(root, "PiStreamPort", "root"); f(root, "EndpointLock", "root");
f(root, "LockHeldError", "root"); f(root, "PiPortError", "root");
f(root, "MeshUnsupportedError", "root"); f(root, "InvariantViolationError", "root");
if (typeof root.DEFAULT_LIMITS !== "object") throw new Error("root.DEFAULT_LIMITS 缺失");
if ("MeshRejectError" in root) throw new Error("root 不应暴露 MeshRejectError(type-only)，出现即边界泄漏");
f(core, "MeshRejectError", "core"); f(core, "MeshUnsupportedError", "core"); f(core, "InvariantViolationError", "core");
f(core, "InProcessTransport", "core"); f(core, "SqliteStore", "core"); f(core, "MeshRouter", "core"); f(core, "createDefaultPolicies", "core");
if (typeof core.DEFAULT_LIMITS !== "object") throw new Error("core.DEFAULT_LIMITS 缺失");
console.log("ESM ok: root + core 均可用，pi 未静态加载");
`,
    );

    writeFileSync(
      join(tmp, "consumer.cjs"),
      `
const root = require("@pi/agent-mesh");
const core = require("@pi/agent-mesh/core");
if (typeof root.createMesh !== "function") throw new Error("cjs root.createMesh 缺失");
if (typeof core.MeshRejectError !== "function") throw new Error("cjs core.MeshRejectError 缺失");
console.log("CJS ok: require 双入口均可用");
`,
    );

    const esmRes = run(process.execPath, ["consumer.mjs"], { cwd: tmp });
    if (esmRes.status !== 0) fail(`ESM 消费者失败：\n${esmRes.stderr || esmRes.stdout}`);
    ok(esmRes.stdout.trim());

    const cjsRes = run(process.execPath, ["consumer.cjs"], { cwd: tmp });
    if (cjsRes.status !== 0) fail(`CJS 消费者失败：\n${cjsRes.stderr || cjsRes.stdout}`);
    ok(cjsRes.stdout.trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 完成 ─────────────────────────────────────────────────────────────────────

process.stdout.write(`\n✅ 打包完成：${tarball}\n`);
process.stdout.write(`   外部安装：npm i ${tarball}\n`);
process.stdout.write(`   使用 pi 流（warm/nudge/stream）需另装可选 peer：npm i @earendil-works/pi-coding-agent\n`);
process.stdout.write(`   未上传到任何 registry（npm pack 本地产物）。\n`);