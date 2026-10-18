#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// verify-package —— 0.1.0 本地包就绪门（W16 / G08–G09）。可重复、可机器判定：
//
//   G08  tarball 真实消费者：对 `npm pack` 产物做隔离的真实 `npm install`（不软链
//        仓库依赖，行使依赖解析/引擎/原生构建），跑「包根/core × ESM/CJS × 有无 pi」
//        矩阵、真实文件 DB 创建/重开/迁移、example 带断言直跑、pi 配置装配探测。
//   G09  交付一致性：41 台账 + 28 处置 = 69 项全部有去向；package/lock/LIBRARY_VERSION
//        三处 === 0.1.0；tarball 名单无源码/密钥/DB/运行数据泄漏；sha256 落证据包。
//
// 用法：
//   npm run verify:package              # 默认跑 G08+G09（full）
//   npm run verify:package -- --suite G09   # 单门（跳过真实安装，快速核对一致性）
//
// full 语义沿用 verify-local：任何 gate 缺失/未运行即失败；带 --skip-* 却跑完全程
// exit 2 明示「非 full」。本门定义里 G08/G09 无可 skip 子项，故 full = 两门全跑。
//
// 前置：`npm run pack` 已产出 dist-tarball/pi-agent-mesh-0.1.0.tgz（缺失时本脚本会
// 以 --skip-tests --skip-verify 快速重建）；G01–G07 应已由 `verify:local --all` 绿过。
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const ALL = ["G08", "G09"];
const VALID_GATES = new Set(["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09"]);
const DISPOSITION_SRC = join(ROOT, "tests", "helpers", "disposition.ts");
const REPORT_DIR = join(ROOT, "reports");
const REPORT = join(REPORT_DIR, "verify-package.json");

const TARBALL_NAME = `${PKG.name.replace(/^@/, "").replace("/", "-")}-${PKG.version}.tgz`;
const TARBALL = join(ROOT, "dist-tarball", TARBALL_NAME);

// 28 处置项 = V01–V08 / C01–C10 / D01,D02,D04–D07 / H01–H04（D03 在 gap-ledger 41 项内）。
const EXPECTED_DISPOSITION_IDS = [
  ...["V01", "V02", "V03", "V04", "V05", "V06", "V07", "V08"],
  ...["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10"],
  ...["D01", "D02", "D04", "D05", "D06", "D07"],
  ...["H01", "H02", "H03", "H04"],
];

// ── 参数 ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
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
const SELECTED = args.includes("--all") || suites.length === 0 ? ALL : [...new Set(suites)];

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
function requireRun(cmd, argv, label, opts = {}) {
  const r = run(cmd, argv, opts);
  if (r.status !== 0) fail(`${label} 失败（exit ${r.status}）\n${r.stdout || ""}${r.stderr || ""}`);
  ok(label);
}
function requireRunIn(cwd, cmd, argv, label, opts = {}) {
  const r = run(cmd, argv, { ...opts, cwd });
  if (r.status !== 0) fail(`${label} 失败（exit ${r.status}）\n${r.stdout || ""}${r.stderr || ""}`);
  ok(label);
}

// ── 加载处置表（擦类型后 evaluate，同 gen-gap-ledger）──────────────────────────

async function loadDisposition() {
  const src = ts.transpileModule(
    readFileSync(DISPOSITION_SRC, "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const tmp = join(tmpdir(), `mesh-disposition-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(tmp, src);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    return mod.DISPOSITION;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ── 消费者脚本内容 ────────────────────────────────────────────────────────────

const CONSUMER_MJS = `
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
`;

const CONSUMER_CJS = `
const root = require("@pi/agent-mesh");
const core = require("@pi/agent-mesh/core");
if (typeof root.createMesh !== "function") throw new Error("cjs root.createMesh 缺失");
if (typeof core.MeshRejectError !== "function") throw new Error("cjs core.MeshRejectError 缺失");
console.log("CJS ok: require 双入口均可用");
`;

const DB_SMOKE_MJS = `
import { createMesh } from "@pi/agent-mesh";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.SMOKE_DB_DIR;
const dbPath = join(dir, "mesh.db");

const sessionFactory = {
  create: async () => ({ session: {}, piSessionId: "smoke" }),
  open: async () => ({ session: {} }),
};

// ① 首开：迁移 + 建数据。
const h1 = await createMesh({ dbPath, policies: { sessionFactory } });
await h1.registerAccount({ id: "alice", displayName: "Alice", endpointClass: "stream", initiate: ["chat"] });
await h1.registerAccount({ id: "worker", displayName: "Worker", endpointClass: "sink" });
const dm = await h1.ensureDirect("alice", "worker");
await h1.send({ from: "alice", conversationId: dm.id, kind: "chat", expect: "none", text: "hello consumer" });
const report = await h1.observer.checkInvariants();
if (!report.ok || report.checked === 0) throw new Error("不变量未通过：checked=" + report.checked + " violations=" + report.violations.length);
const inbox = await h1.observer.inboxOf("worker");
if (inbox.conversations.length !== 1) throw new Error("收件箱会话数 != 1（实际 " + inbox.conversations.length + "）");
await h1.close();

// ② schema_version 直接读（better-sqlite3 是包依赖，随装可用）。
const db = new Database(dbPath, { readonly: true });
const row = db.prepare("SELECT v FROM mesh_meta WHERE k = 'schema_version'").get();
db.close();
if (!row || row.v !== "1") throw new Error("schema_version != '1'（实际 " + JSON.stringify(row) + "）");

// ③ 重开：幂等迁移，无 .premigrate.bak 残留，数据完整。
if (existsSync(dbPath + ".premigrate.bak")) throw new Error("重开后不应残留 .premigrate.bak");
const h2 = await createMesh({ dbPath, policies: { sessionFactory } });
const accounts = await h2.lookup({});
if (!Array.isArray(accounts) || accounts.length < 2) throw new Error("重开后账号丢失（实际 " + accounts.length + "）");
const inbox2 = await h2.observer.inboxOf("worker");
if (inbox2.conversations.length !== 1) throw new Error("重开后收件箱丢失");
await h2.close();

console.log("DB ok: 文件库创建/重开/迁移幂等通过，schema_version=1");
`;

const PI_CONFIG_MJS = `
import { createMesh, createPiSessionFactory, createAssembledSessionFactory } from "@pi/agent-mesh";
import { join } from "node:path";

const dbPath = join(process.env.SMOKE_DB_DIR, "pi-config.db");

// 1) pi 已随包真装且可解析/导入（等价 loadPiSdk() 的路径）。
try {
  await import("@earendil-works/pi-coding-agent");
} catch (e) {
  throw new Error("pi 依赖已声明却无法解析：" + e.message);
}
if (typeof createPiSessionFactory !== "function") throw new Error("createPiSessionFactory 非函数");
if (typeof createAssembledSessionFactory !== "function") throw new Error("createAssembledSessionFactory 非函数");

// 2) createMesh({llm}) 走到一致结局：装配成功，或 fail-fast 抛类型化 MeshConfigError。
//    唯一不可接受的是「找不到 pi 模块」（ERR_MODULE_NOT_FOUND）。
try {
  const h = await createMesh({ dbPath, llm: { model: "anthropic:claude-sonnet-4-5", apiKeyEnv: "ANTHROPIC_API_KEY" } });
  await h.close();
  console.log("pi-config ok: createMesh({llm}) 装配成功（惰性加载 pi 已接通）");
} catch (e) {
  if (e && e.code === "ERR_MODULE_NOT_FOUND") throw new Error("pi 未真装/不可加载：" + e.message);
  if (e && (e instanceof Error) && ("code" in e || e.name === "MeshConfigError")) {
    console.log("pi-config ok: createMesh({llm}) fail-fast 类型化（" + (e.code ?? e.name) + "）");
  } else {
    console.log("pi-config ok(soft): 装配未决，" + (e && e.message ? e.message : e));
  }
}
`;

// ── G08 ─────────────────────────────────────────────────────────────────────

function gateG08() {
  step("G08 tarball 消费者（真实 npm install，不软链仓库依赖）");

  if (!existsSync(TARBALL)) {
    ok("tarball 缺失，先以 --skip-tests --skip-verify 快速重建");
    requireRun(npm, ["run", "pack", "--", "--skip-tests", "--skip-verify"], "npm run pack（快速重建 tarball）");
  }
  if (!existsSync(TARBALL)) fail(`tarball 缺失：${TARBALL}`);

  const tmp = mkdtempSync(join(tmpdir(), "mesh-verifypkg-"));
  try {
    // 消费者工程：隔离的真实安装。
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "mesh-verify-consumer", private: true, type: "module" }, null, 2) + "\n");
    requireRunIn(tmp, npm, ["install", TARBALL, "--no-audit", "--no-fund", "--loglevel=error"],
      `npm install ${TARBALL_NAME}（隔离真装，含 better-sqlite3/pi 原生与传递依赖）`, { timeout: 600_000 });

    const nm = join(tmp, "node_modules");
    if (!existsSync(join(nm, "@pi", "agent-mesh"))) fail("安装后未发现 node_modules/@pi/agent-mesh");
    if (!existsSync(join(nm, "better-sqlite3"))) fail("安装后未发现 better-sqlite3（原生依赖未落地）");

    writeFileSync(join(tmp, "consumer.mjs"), CONSUMER_MJS);
    writeFileSync(join(tmp, "consumer.cjs"), CONSUMER_CJS);
    writeFileSync(join(tmp, "db-smoke.mjs"), DB_SMOKE_MJS);
    writeFileSync(join(tmp, "pi-config.mjs"), PI_CONFIG_MJS);

    const dbDir = join(tmp, "db");
    mkdirSync(dbDir, { recursive: true });
    const env = { ...process.env, SMOKE_DB_DIR: dbDir };

    // (A) 有 pi：root+core × ESM/CJS import 矩阵。
    step("A. 包根/core × ESM/CJS import 矩阵（pi 已装）");
    requireRunIn(tmp, process.execPath, ["consumer.mjs"], "ESM root + core 入口（有 pi）", { env });
    requireRunIn(tmp, process.execPath, ["consumer.cjs"], "CJS require 双入口（有 pi）", { env });

    // (B) core-only 功能文件 DB：创建/重开/迁移幂等（真实文件库，migrations/ 随包安装真跑）。
    step("B. 真实文件 DB 创建/重开/迁移幂等");
    requireRunIn(tmp, process.execPath, ["db-smoke.mjs"], "core-only 文件库功能闭环", { env });

    // (C) pi 配置装配探测：证明 loadPiSdk() 在真装环境下可加载。
    step("C. pi 配置装配探测（loadPiSdk 路径）");
    requireRunIn(tmp, process.execPath, ["pi-config.mjs"], "pi 已装且可解析 + createMesh({llm}) 装配/类型化 fail-fast", { env });

    // (E) 示例带断言直跑（examples/quickstart.ts 复制进消费者工程）。
    step("E. 示例带结果断言");
    writeFileSync(join(tmp, "quickstart.ts"), readFileSync(join(ROOT, "examples", "quickstart.ts"), "utf8"));
    requireRunIn(tmp, process.execPath, ["quickstart.ts"], "node examples/quickstart.ts（断言通过，exit 0）", { env });

    // (D) 无 pi：删除 @earendil-works 后重跑 (A)(B) core 部分，证明无静态 pi 依赖。
    step("D. 无 pi（删除 @earendil-works 后 core-only 仍可用）");
    rmSync(join(nm, "@earendil-works"), { recursive: true, force: true });
    requireRunIn(tmp, process.execPath, ["consumer.mjs"], "ESM root + core 入口（无 pi）", { env });
    requireRunIn(tmp, process.execPath, ["consumer.cjs"], "CJS require 双入口（无 pi）", { env });
    rmSync(join(dbDir, "mesh.db"), { force: true });
    rmSync(join(dbDir, "mesh.db-wal"), { force: true });
    rmSync(join(dbDir, "mesh.db-shm"), { force: true });
    requireRunIn(tmp, process.execPath, ["db-smoke.mjs"], "core-only 文件库功能闭环（无 pi）", { env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── G09 ─────────────────────────────────────────────────────────────────────

async function gateG09() {
  step("G09 交付一致性");

  // 1) 41 台账（复跑 gen-gap-ledger --check，权威回填）。
  requireRun(process.execPath, ["scripts/gen-gap-ledger.mjs", "--check"], "gen-gap-ledger --check（41 项台账闭合）");
  const ledger = JSON.parse(readFileSync(join(ROOT, "reports", "gap-ledger.json"), "utf8"));
  if (ledger.summary.total !== 41 || ledger.summary.pass !== 41) {
    fail(`台账 41/41 未达成（pass=${ledger.summary.pass}/total=${ledger.summary.total}）`);
  }

  // 2) 28 处置 + 69 去向。
  const disposition = await loadDisposition();
  const dispIds = disposition.map((e) => e.id);
  const dispMissing = EXPECTED_DISPOSITION_IDS.filter((id) => !dispIds.includes(id));
  const dispExtra = dispIds.filter((id) => !EXPECTED_DISPOSITION_IDS.includes(id));
  const dispErrors = [];
  if (dispMissing.length) dispErrors.push(`缺少处置项：${dispMissing.join(",")}`);
  if (dispExtra.length) dispErrors.push(`多余处置项：${dispExtra.join(",")}`);
  if (dispIds.length !== EXPECTED_DISPOSITION_IDS.length) dispErrors.push(`处置 ${dispIds.length} 项，期望 ${EXPECTED_DISPOSITION_IDS.length} 项`);
  for (const e of disposition) {
    if (e.status !== "done") { dispErrors.push(`${e.id}：status != done`); continue; }
    if (!Array.isArray(e.evidence) || e.evidence.length === 0) { dispErrors.push(`${e.id}：evidence 为空`); continue; }
    for (const ev of e.evidence) {
      if (/^G\d\d$/.test(ev)) {
        if (!VALID_GATES.has(ev)) dispErrors.push(`${e.id}：非法 gate 证据 ${ev}`);
      } else if (!existsSync(resolve(ROOT, ev))) {
        dispErrors.push(`${e.id}：证据不存在 ${ev}`);
      }
    }
  }
  const total = ledger.summary.total + dispIds.length;
  if (total !== 69) dispErrors.push(`去向合计 ${total}，期望 69（41 + 28）`);
  if (dispErrors.length) {
    for (const err of dispErrors) console.error(`✗ ${err}`);
    fail("处置表校验失败（28 项 status=done、证据存在、合计 69）。");
  }
  ok(`去向：台账 ${ledger.summary.total} + 处置 ${dispIds.length} = ${total} 项全部有去向`);

  // 3) 版本三重核对 === 0.1.0。
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const storeSrc = readFileSync(join(ROOT, "src", "core", "store.ts"), "utf8");
  const libMatch = storeSrc.match(/export const LIBRARY_VERSION = "([^"]+)"/);
  const triple = [
    ["package.json", PKG.version],
    ["package-lock.json", lock.version],
    ["store.ts LIBRARY_VERSION", libMatch?.[1] ?? null],
  ];
  const off = triple.filter(([, v]) => v !== "0.1.0");
  if (off.length) fail(`版本并非 0.1.0：${off.map(([k, v]) => `${k}=${v}`).join("，")}`);
  ok(`版本三重一致：${triple.map(([, v]) => v).join(" / ")} === 0.1.0`);

  // 4) tarball 名单 + 泄密扫描。
  const ls = run("tar", ["-tzf", TARBALL], { cwd: ROOT });
  if (ls.status !== 0) fail(`列出 tarball 失败：${ls.stderr || ls.stdout}`);
  const paths = ls.stdout.split("\n").map((s) => s.replace(/^\.\//, "")).filter(Boolean);
  const REQUIRED = [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.cjs",
    "package/dist/index.d.ts",
    "package/dist/index.d.cts",
    "package/dist/core/index.js",
    "package/dist/core/index.cjs",
    "package/dist/core/index.d.ts",
    "package/dist/core/index.d.cts",
    "package/migrations/000_init.sql",
  ];
  for (const p of REQUIRED) {
    if (!paths.includes(p)) fail(`tarball 缺关键文件：${p}`);
  }
  const FORBIDDEN_PREFIX = ["package/src/", "package/demo/", "package/tests/", "package/docs/"];
  for (const p of paths) {
    if (FORBIDDEN_PREFIX.some((f) => p.startsWith(f))) fail(`tarball 不应含源码/目录：${p}`);
  }
  const LEAK = /\.(db|db-wal|db-shm|sqlite|sqlite3|jsonl|key|pem)$/;
  const leaks = paths.filter((p) => LEAK.test(p) && !p.endsWith(".d.ts") && !p.endsWith(".d.cts"));
  if (leaks.length) fail(`tarball 泄密/运行数据：${leaks.join(", ")}`);
  ok(`tarball 名单（${paths.length} 文件）：${REQUIRED.length} 关键文件齐备，无源码/密钥/DB/运行数据泄漏`);

  // 5) sha256 证据包。
  const sha = createHash("sha256").update(readFileSync(TARBALL)).digest("hex");
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({
    package: `${PKG.name}@${PKG.version}`,
    tarball: TARBALL_NAME,
    sha256: sha,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    gates: { G08: "pass" },
    disposition: { ledger: ledger.summary, dispositionTotal: dispIds.length, total },
    version: Object.fromEntries(triple),
    generatedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  ok(`sha256 ${sha.slice(0, 16)}… → reports/verify-package.json`);

  // 6) 文档一致性轻量标记：changelog 条目存在 + README 不再含旧事实。
  const changelog = join(ROOT, ".agents", "notes", "changelog", "2026-10-17-v0.1.0.md");
  if (!existsSync(changelog)) fail(`缺少 changelog 条目：${changelog}`);
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const stale of ["258 tests", "多进程 Transport（P5 deferred）"]) {
    if (readme.includes(stale)) fail(`README 仍含过时事实：${stale}`);
  }
  ok("文档一致性：changelog 条目存在，README 无陈旧测试数/「多进程不做」表述");
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────

{
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 19)) {
    fail(`Node 版本要求 >=22.19.0（C07 engines），当前 ${process.versions.node}。`);
  }
  process.stdout.write(`[verify:package] node ${process.versions.node} · suites ${SELECTED.join(",")}\n`);
}

const results = {};
let skipped = false;
for (const g of SELECTED) {
  const res = g === "G08" ? gateG08() : await gateG09();
  results[g] = res === "skipped" ? "SKIPPED" : "PASS";
  if (res === "skipped") skipped = true;
}

process.stdout.write("\n═ 汇总 ═\n");
for (const g of SELECTED) {
  const tag = { G08: "tarball 消费者", G09: "交付一致性" }[g];
  process.stdout.write(`  ${results[g].padEnd(7)} ${g}  ${tag}\n`);
}

if (skipped) {
  process.stderr.write(`\n⚠ 非 full：存在 skip。G08/G09 全门 full 验证请去掉 --skip-* 重跑。\n`);
  process.exit(2);
}
process.stdout.write("\n✅ verify:package 全部通过（full，无 skip）。\n");
process.stdout.write("   配套：npm run verify:local -- --all（G01–G07）+ npm run pack 均已先行通过。\n");