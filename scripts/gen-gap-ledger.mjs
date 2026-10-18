#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// gen-gap-ledger —— 生成 / 校验 G03 台账（41 项 gap 与合同测试的映射）。
//
// 用法：
//   node scripts/gen-gap-ledger.mjs           # 只生成 reports/gap-ledger.json，
//                                             #   result 全部标 "untested"（供评审）
//   node scripts/gen-gap-ledger.mjs --check   # 核文件存在、断言非空、并跑映射测试
//                                             #   并集回填 result，任一缺失/失败 exit 1
//
// 真源：tests/helpers/gap-ledger.ts 的 GAP_LEDGER（N01–N05/I01–I35/D03 共 41 项）。
// 加载方式：ts.transpileModule 擦类型后于临时 .mjs evaluate（与 Node 版本解耦，
// 不依赖 node 的类型剥离开关；台账是纯数据、无 import）。
//
// 语义：这是「单一真源」。gap 与测试/断言的映射在这里维护，`--check` 是机器可判定的
// 一致性校验——文件不存在、断言为空、映射测试红，都让 G03 失败，不做「数量≥1」弱化。
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const LEDGER_SRC = join(ROOT, "tests", "helpers", "gap-ledger.ts");
const REPORT_DIR = join(ROOT, "reports");
const REPORT = join(REPORT_DIR, "gap-ledger.json");

// 41 项 = N01–N05 + I01–I35 + D03（闭合清单，供 id 集合校验）。
const EXPECTED_IDS = [
  ...["N01", "N02", "N03", "N04", "N05"],
  ...Array.from({ length: 35 }, (_, i) => `I${String(i + 1).padStart(2, "0")}`),
  "D03",
];

// ── 加载台账（擦类型后 evaluate）───────────────────────────────────────────────

async function loadLedger() {
  const src = ts.transpileModule(
    readFileSync(LEDGER_SRC, "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const tmp = join(tmpdir(), `gap-ledger-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(tmp, src);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    return mod.GAP_LEDGER;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function normalizeFile(file) {
  return file.startsWith("/") ? file : resolve(ROOT, file);
}

// ── 校验结构（不跑测试）────────────────────────────────────────────────────────

function validateStructure(ledger) {
  const ids = ledger.map((e) => e.id);
  const missing = EXPECTED_IDS.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !EXPECTED_IDS.includes(id));
  const errors = [];
  if (missing.length) errors.push(`缺少 gap 项：${missing.join(",")}`);
  if (extra.length) errors.push(`多余 gap 项：${extra.join(",")}`);
  if (ids.length !== EXPECTED_IDS.length) {
    errors.push(`台账 ${ids.length} 项，期望 ${EXPECTED_IDS.length} 项`);
  }
  for (const e of ledger) {
    if (!Array.isArray(e.files) || e.files.length === 0) {
      errors.push(`${e.id}：files 为空`);
      continue;
    }
    for (const f of e.files) {
      if (!existsSync(normalizeFile(f))) {
        errors.push(`${e.id}：测试文件不存在 ${f}`);
      }
    }
    if (!Array.isArray(e.assertions) || e.assertions.length === 0) {
      errors.push(`${e.id}：assertions 为空（闭合条件必须翻译为 ≥1 条断言）`);
    }
  }
  return errors;
}

// ── 跑映射并集（vitest --reporter=json）────────────────────────────────────────

function runUnion(ledger) {
  const union = [...new Set(ledger.flatMap((e) => e.files))];
  if (union.length === 0) return { ok: false, byFile: new Map(), detail: "无映射文件" };
  const tmp = join(tmpdir(), `mesh-gap-ledger-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const outFile = join(tmp, "result.json");
  const r = spawnSync(
    process.execPath,
    [VITEST, "run", ...union, "--reporter=json", `--outputFile=${outFile}`],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const byFile = new Map();
  if (r.status !== 0) {
    return {
      ok: false,
      byFile,
      detail: `vitest 退出码 ${r.status}\n${(r.stdout || "")}${(r.stderr || "")}`,
      hadRun: true,
    };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(outFile, "utf8"));
  } catch (err) {
    return { ok: false, byFile, detail: `解析 vitest JSON 失败：${err.message}`, hadRun: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const tr of report.testResults || []) {
    byFile.set(normalizeFile(tr.name), tr.status);
  }
  return { ok: true, byFile, hadRun: true };
}

// ── 生成 / 校验 ─────────────────────────────────────────────────────────────

const CHECK = process.argv.includes("--check");
const header = await loadLedger();

if (!CHECK) {
  const entries = header.map((e) => ({
    id: e.id,
    summary: e.summary,
    result: "untested",
    files: e.files,
    assertions: e.assertions,
  }));
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ mode: "generate", entries, summary: { total: entries.length } }, null, 2) + "\n");
  console.log(`✓ 已生成 ${JSON.stringify(REPORT)}（${entries.length} 项，result=untested）`);
  process.exit(0);
}

const errors = validateStructure(header);
if (errors.length) {
  for (const err of errors) console.error(`✗ ${err}`);
  console.error("✗ 台账结构校验失败（files 存在、assertions≥1、id 集合 == 41 项）。");
  process.exit(1);
}

const { ok, byFile } = runUnion(header);
if (!ok) {
  console.error("✗ 映射测试并集存在失败（见 vitest 输出）。");
  process.exit(1);
}

const fileStatus = (file) => {
  const st = byFile.get(normalizeFile(file));
  if (st === undefined) return "missing";
  return st === "passed" ? "pass" : "fail"; // 跳过（skipped）不提供覆盖 → 按失败计
};
const entries = header.map((e) => {
  const results = e.files.map((f) => ({ file: f, status: fileStatus(f) }));
  const result = results.every((r) => r.status === "pass") ? "pass" : "fail";
  return { id: e.id, summary: e.summary, result, files: e.files, assertions: e.assertions, results };
});

mkdirSync(REPORT_DIR, { recursive: true });
const summary = { total: entries.length, pass: entries.filter((e) => e.result === "pass").length, fail: entries.filter((e) => e.result === "fail").length };
writeFileSync(REPORT, JSON.stringify({ mode: "check", entries, summary }, null, 2) + "\n");

const failed = entries.filter((e) => e.result === "fail");
if (failed.length) {
  for (const f of failed) console.error(`✗ ${f.id} 未闭合：${f.results.filter((r) => r.status !== "pass").map((r) => `${r.file}(${r.status})`).join(", ")}`);
  console.error(`✗ 台账 ${summary.fail}/${summary.total} 项未闭合。`);
  process.exit(1);
}
console.log(`✓ 台账 41 项全部闭合（${summary.pass}/${summary.total}），无 skip 弱化。`);
console.log(`  产物 ${JSON.stringify(REPORT)}`);