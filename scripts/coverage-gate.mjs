#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// coverage-gate —— G07（W15）四范围分支覆盖率门。vitest 原生 threshold 只支持全局
// 或每文件，不支持「按语义子集聚合」，故这里解析 coverage/coverage-final.json
// （istanbul/v8 格式），按四范围文件集各自求「分支位置已覆盖 / 分支位置总数」，
// 任一范围 <95% 即 exit 1。
//
//   范围 → 文件（语义持有者：投递/状态机/折叠/溢出未读；映射按实现复核微调）：
//     delivery        mailbox.ts + router.ts
//     state-machine   mailbox.ts + registry.ts
//     fold            mailbox.ts
//     overflow/unread mailbox.ts + store.ts
//
// 分支口径与 istanbul-lib-coverage computeBranchTotals 一致：对每个 branch 的
// locations 命中数组逐项计数（hits>0 为覆盖，总项数为分母），而非「整支全覆盖」。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FINAL = join(ROOT, "coverage", "coverage-final.json");

const SCOPES = [
  { name: "delivery", files: ["mailbox.ts", "router.ts"] },
  { name: "state-machine", files: ["mailbox.ts", "registry.ts"] },
  { name: "fold", files: ["mailbox.ts"] },
  { name: "overflow/unread", files: ["mailbox.ts", "store.ts"] },
];

const THRESHOLD = 95;

if (!existsSync(FINAL)) {
  console.error(`✗ 未找到 ${FINAL} —— 先运行 \`vitest run --coverage\`（generate ${'coverage-final.json'}）。`);
  process.exit(1);
}

const cov = JSON.parse(readFileSync(FINAL, "utf8"));

/** 单文件分支统计：{ covered, total }（istanbul computeBranchTotals 口径）。 */
function branchStats(fileCov) {
  let covered = 0;
  let total = 0;
  const b = fileCov?.b ?? {};
  for (const key of Object.keys(b)) {
    const hits = b[key];
    if (!Array.isArray(hits)) continue;
    covered += hits.filter((h) => h > 0).length;
    total += hits.length;
  }
  return { covered, total };
}

/** 按相对 src/core 的文件名（跨 OS 用 / 归一）索引。 */
const byBasename = new Map();
for (const absPath of Object.keys(cov)) {
  const rel = relative(join(ROOT, "src", "core"), absPath).split(sep).join("/");
  if (rel.startsWith("..")) continue; // 只统计 src/core 内
  byBasename.set(rel.split("/").pop(), absPath);
}

let failed = false;
process.stdout.write("coverage-gate：四范围分支覆盖（阈值 95%）\n");
for (const scope of SCOPES) {
  let covered = 0;
  let total = 0;
  for (const f of scope.files) {
    const abs = byBasename.get(f);
    if (!abs) {
      console.error(`  ✗ ${scope.name}：找不到 ${f}（coverage-final.json 内无此文件）`);
      failed = true;
      continue;
    }
    const s = branchStats(cov[abs]);
    covered += s.covered;
    total += s.total;
  }
  const pct = total === 0 ? 100 : (covered / total) * 100;
  const mark = pct >= THRESHOLD ? "✓" : "✗";
  process.stdout.write(`  ${mark} ${scope.name.padEnd(16)} ${covered}/${total} (${pct.toFixed(1)}%)\n`);
  if (pct < THRESHOLD) failed = true;
}

if (failed) {
  process.stderr.write(`\n✗ coverage-gate 未通过：存在范围分支覆盖 <${THRESHOLD}%。\n`);
  process.exit(1);
}
process.stdout.write("\n✅ coverage-gate 通过：四范围分支覆盖均 ≥" + THRESHOLD + "%。\n");