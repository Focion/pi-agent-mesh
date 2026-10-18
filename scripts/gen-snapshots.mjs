#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// gen-snapshots — 生成 / 校验 W01 的 API 面与 DDL 基线快照。
//
// 用法：
//   node scripts/gen-snapshots.mjs          # 重新生成快照（漂移后显式更新）
//   node scripts/gen-snapshots.mjs --check  # 只比对，不一致 exit 1（CI/测试/pack 用）
//
// 快照：
//   snapshots/api-surface.json            根入口 + core 子入口的值/类型导出名清单
//     （根 = src/index.ts；core = src/core/index.ts；经 TS compiler API 枚举，
//       value 与 type-only 分开，均排序，确定性输出）
//   snapshots/migrations/000_init.sha256  migrations/000_init.sql 的 sha256
//     （DDL 每次失败应改走增量迁移，基线文件本身只读）
//
// 语义：这是「基线」。改名/增删导出、改 DDL 都算漂移——要么是有意契约变更（此时
// 重新生成并 commit），要么是误改（此时修复）。不做自动「更新通过」。
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── API 面枚举（TS compiler API：值导出 vs type-only 导出，均排序）───────────

function collectExports(entry) {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entry);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) return { values: [], types: [] };
  const values = [];
  const types = [];
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    // 值导出（class/enum/function/const 也含类型面）= SymbolFlags.Value；
    // 其余（interface / type alias / export type{}）归 type-only。
    // re-export 的符号是 Alias，需要追到目标符号再看 flags（否则 class/const 会被误判为 type）。
    let target = sym;
    for (let depth = 0; depth < 8 && (target.flags & ts.SymbolFlags.Alias) !== 0; depth++) {
      target = checker.getAliasedSymbol(target);
    }
    if ((target.flags & ts.SymbolFlags.Value) !== 0) values.push(sym.name);
    else types.push(sym.name);
  }
  return { values: values.sort(), types: types.sort() };
}

function apiSurface() {
  return {
    root: collectExports(`${ROOT}src/index.ts`),
    core: collectExports(`${ROOT}src/core/index.ts`),
  };
}

function ddlHash() {
  const sql = readFileSync(`${ROOT}migrations/000_init.sql`, "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

// ── 生成 / 校验 ─────────────────────────────────────────────────────────────

const target = {
  api: `${ROOT}snapshots/api-surface.json`,
  ddl: `${ROOT}snapshots/migrations/000_init.sha256`,
};
const CHECK = process.argv.includes("--check");
const apiPayload = JSON.stringify(apiSurface(), null, 2) + "\n";
const ddlPayload = ddlHash() + "\n";

if (CHECK) {
  let drift = 0;
  try {
    if (readFileSync(target.api, "utf8") !== apiPayload) {
      console.error("✗ API 面漂移：snapshots/api-surface.json 与当前导出不一致。");
      console.error("  若是有意的契约变更：node scripts/gen-snapshots.mjs 重新生成并提交。");
      drift = 1;
    }
  } catch {
    console.error("✗ 缺少 snapshots/api-surface.json（先运行 node scripts/gen-snapshots.mjs）");
    drift = 1;
  }
  try {
    if (readFileSync(target.ddl, "utf8") !== ddlPayload) {
      console.error("✗ DDL 漂移：migrations/000_init.sql 与基线 sha256 不一致（基线只读，变更走增量迁移）。");
      drift = 1;
    }
  } catch {
    console.error("✗ 缺少 snapshots/migrations/000_init.sha256（先运行 node scripts/gen-snapshots.mjs）");
    drift = 1;
  }
  if (drift) process.exit(1);
  console.log("✓ 快照一致：API 面 + migrations/000_init.sql 均未漂移。");
  process.exit(0);
}

mkdirSync(dirname(target.api), { recursive: true });
mkdirSync(dirname(target.ddl), { recursive: true });
writeFileSync(target.api, apiPayload);
writeFileSync(target.ddl, ddlPayload);
console.log(`✓ 已生成 ${JSON.stringify(target.api)}`);
console.log(`✓ 已生成 ${JSON.stringify(target.ddl)}`);