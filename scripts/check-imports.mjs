#!/usr/bin/env node
// CI 门禁（§3.3 §29.2 §29.3）：
//  G1 依赖门禁：src/core/** 不得 import 任何 pi 包（I13）
//  G2 边界门禁：src/pi/** 只能 import core 的公共面（types/util/contracts）
//  G3 禁用 API：源码不得出现 sendUserMessage / clearQueue / forkFrom / prompt(（I19/I22/F4）
//  G4 词表扫描：源码不得出现宿主业务词汇（M1）——判据是显式词表
// 任何一项命中即 exit 1。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "pi-client"];
const CORE_PUBLIC_FOR_PI = new Set(["types.js", "types", "util.js", "util", "contracts.js", "contracts"]);
const FORBIDDEN_CALLS = [/sendUserMessage\s*\(/, /\.clearQueue\s*\(/, /forkFrom\s*\(/, /\.prompt\s*\(/];
const BUSINESS_WORDS = [
  // M1 词表：只收无歧义的宿主业务词；避免 order/学生 等会误伤技术词的项需用完整词匹配
  "teacher", "student", "classroom", "customer", "invoice", "ticket",
  "课程", "老师", "工单", "客服", "订单", "购物车"
];

const violations = [];
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) files.push(p);
  }
}
walk(SRC);

const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
const dynamicImportRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

for (const f of files) {
  const rel = relative(ROOT, f).replaceAll("\\", "/");
  const src = readFileSync(f, "utf8");
  const isCore = rel.startsWith("src/core/");
  const isPi = rel.startsWith("src/pi/");

  const specs = [];
  for (const m of src.matchAll(importRe)) specs.push(m[1]);
  for (const m of src.matchAll(dynamicImportRe)) specs.push(m[1]);

  for (const spec of specs) {
    if (isCore && PI_PACKAGES.some((p) => spec === p || spec.startsWith(p + "/"))) {
      violations.push(`G1 ${rel}: imports pi package "${spec}"`);
    }
    if (isPi && spec.startsWith(".")) {
      const target = spec.replace(/^\.\.\//, "").replace(/^\.\//, "pi/");
      const base = relative("src/pi", target).replaceAll("\\", "/");
      const cleaned = base.replace(/^(\.\.\/)+/, "");
      const seg = cleaned.split("/").pop() ?? "";
      const firstSeg = cleaned.split("/")[0] ?? "";
      if (firstSeg === "core" && !CORE_PUBLIC_FOR_PI.has(seg.replace(/\.(js|ts)$/, ""))) {
        violations.push(`G2 ${rel}: imports core internal module "${spec}" (only types/util/contracts allowed)`);
      }
    }
  }

  for (const re of FORBIDDEN_CALLS) {
    const m = src.match(re);
    if (m) violations.push(`G3 ${rel}: forbidden API call "${m[0].trim()}" (I19/I22/F4)`);
  }

  const lower = src.toLowerCase();
  for (const w of BUSINESS_WORDS) {
    if (lower.includes(w.toLowerCase())) violations.push(`G4 ${rel}: business word "${w}" (M1)`);
  }
}

if (violations.length) {
  console.error(`✗ mesh import/word gate FAILED (${violations.length} violation(s)):`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(`✓ mesh gates passed (${files.length} source files checked)`);
