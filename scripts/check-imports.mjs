#!/usr/bin/env node
// CI 门禁（§3.3 §29.2 §29.3）：
//  G1 依赖门禁：src/core/** 不得 import 任何 pi 包（I13），也不得经相对路径绕过
//     引 src/pi 或 src/index（装配桥）。判据是「解析后的真实路径」，不是文本。
//  G2 边界门禁：src/pi/** 只能 import core 的公共面（types/util/contracts），
//     不得引 src/core 内部模块，也不得引 src/index（根装配桥）绕过。
//  G3 禁用 API：源码不得出现 sendUserMessage/clearQueue/forkFrom/prompt（I19/I22/F4）。
//     按 TS AST 的「属性访问名 / 裸调用名」判定，覆盖 s["prompt"]()、s.prompt?.() 等形态。
//  G4 词表扫描：源码不得出现宿主业务词汇（M1）——判据是显式词表（文本级，含注释）。
// 任何一项命中即 exit 1。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const SRC_INDEX = new Set([
  join(SRC, "index.ts"),
  join(SRC, "index.js"),
  join(SRC, "index.mjs"),
  join(SRC, "index.mts"),
]);

const PI_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "pi-client",
  // R6：迁移到 durable 后，pi 侧的三个新依赖同样要纳入 G1（core 不得 import）门禁
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  "@earendil-works/chord",
];
// core 对 pi 开放的公共面（文件名去掉扩展名）。src/pi 只允许引这三个模块。
const CORE_PUBLIC_FOR_PI = new Set(["types", "util", "contracts"]);
// G3 按「访问名」判定：成员访问（含可选链 / 计算属性）用 FORBIDDEN_MEMBER，
// 裸调用（直接标识符）用 FORBIDDEN_BARE_CALL。
const FORBIDDEN_MEMBER = new Set(["sendUserMessage", "clearQueue", "forkFrom", "prompt"]);
const FORBIDDEN_BARE_CALL = new Set(["sendUserMessage", "forkFrom"]);
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
    else if (/\.(ts|tsx|mts|mjs|js|jsx|cjs|cts)$/.test(name)) files.push(p);
  }
}
walk(SRC);

// ── 解析辅助：把相对说明符解析为磁盘真实路径（NodeNext：*.js 可映射 *.ts；含 index 解析）──

const EXT_CHAIN = [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".cjs", ".cts", ".d.ts"];

function tryFile(p) {
  try {
    if (existsSync(p) && statSync(p).isFile()) return resolve(p);
  } catch {
    /* 忽略权限/IO 异常，按未解析处理 */
  }
  return null;
}

function resolveRelativeSpec(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  let r = tryFile(base);
  if (r) return r;
  // NodeNext 源码约定：import "./x.js" 在磁盘上是 x.ts / x.mts
  if (base.endsWith(".js")) {
    r = tryFile(base.slice(0, -3) + ".ts");
    if (r) return r;
    r = tryFile(base.slice(0, -3) + ".mts");
    if (r) return r;
  }
  for (const e of EXT_CHAIN) {
    r = tryFile(base + e);
    if (r) return r;
  }
  for (const idx of ["index.ts", "index.tsx", "index.mts", "index.mjs", "index.js", "index.d.ts"]) {
    r = tryFile(join(base, idx));
    if (r) return r;
  }
  return null;
}

// ── AST：枚举 import/export/require/动态 import 的模块说明符，与 G3 禁用调用 ─────────

function scriptKind(file) {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** 字符串字面量 / 无替换模板字面量（`...` 不含 ${}）→ 内容；其余（变量、拼接）→ null */
function moduleSpecText(spec) {
  if (ts.isStringLiteral(spec)) return spec.text;
  if (ts.isNoSubstitutionTemplateLiteral(spec)) return spec.text;
  return null;
}

function callName(expr) {
  if (ts.isIdentifier(expr)) return { name: expr.text, bare: true };
  if (ts.isPropertyAccessExpression(expr)) return { name: expr.name.text, bare: false };
  if (ts.isElementAccessExpression(expr)) {
    const t = moduleSpecText(expr.argumentExpression);
    if (t !== null) return { name: t, bare: false };
  }
  return null;
}

function collect(sf) {
  const specs = [];
  const calls = [];
  function visit(n) {
    if (ts.isImportDeclaration(n)) {
      const s = moduleSpecText(n.moduleSpecifier);
      if (s !== null) specs.push(s);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const s = moduleSpecText(n.moduleSpecifier);
      if (s !== null) specs.push(s);
    } else if (ts.isImportEqualsDeclaration(n)) {
      if (ts.isExternalModuleReference(n.moduleReference) && n.moduleReference.expression) {
        const s = moduleSpecText(n.moduleReference.expression);
        if (s !== null) specs.push(s);
      }
    } else if (ts.isCallExpression(n)) {
      const c = callName(n.expression);
      if (c) calls.push(c);
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const s = moduleSpecText(n.arguments[0]);
        if (s !== null) specs.push(s);
      } else if (ts.isIdentifier(n.expression) && n.expression.text === "require") {
        const s = moduleSpecText(n.arguments[0]);
        if (s !== null) specs.push(s);
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  return { specs, calls };
}

// ── 规则判定 ─────────────────────────────────────────────────────────────────────

for (const f of files) {
  const rel = relative(ROOT, f).replaceAll("\\", "/");
  const src = readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, scriptKind(f));
  const { specs, calls } = collect(sf);
  const isCore = rel.startsWith("src/core/");
  const isPi = rel.startsWith("src/pi/");

  for (const spec of specs) {
    if (isCore && spec.startsWith(".") ) {
      // G1b：相对引用落在 src/pi 或 src/index（装配桥）——按解析后的真实路径判定。
      const real = resolveRelativeSpec(f, spec);
      if (real) {
        const rrel = relative(ROOT, real).replaceAll("\\", "/");
        if (rrel.startsWith("src/pi/") || SRC_INDEX.has(real)) {
          violations.push(`G1 ${rel}: imports cross-layer "${spec}" (→ ${rrel})`);
        }
      }
    } else if (isCore) {
      // G1a：绝对/裸说明符命中 pi 包名。
      if (PI_PACKAGES.some((p) => spec === p || spec.startsWith(p + "/"))) {
        violations.push(`G1 ${rel}: imports pi package "${spec}"`);
      }
    }

    if (isPi && spec.startsWith(".")) {
      const real = resolveRelativeSpec(f, spec);
      if (real) {
        const rrel = relative(ROOT, real).replaceAll("\\", "/");
        if (rrel.startsWith("src/core/")) {
          const stem = basename(real).replace(/\.(ts|tsx|mts|mjs|js|jsx|cjs|cts|d\.ts)$/, "");
          if (!CORE_PUBLIC_FOR_PI.has(stem)) {
            violations.push(`G2 ${rel}: imports core internal module "${spec}" (only types/util/contracts allowed)`);
          }
        } else if (SRC_INDEX.has(real)) {
          violations.push(`G2 ${rel}: imports src root bridge "${spec}" (only core types/util/contracts allowed)`);
        }
      }
    }
  }

  for (const c of calls) {
    const hit = c.bare ? FORBIDDEN_BARE_CALL.has(c.name) : FORBIDDEN_MEMBER.has(c.name);
    if (hit) violations.push(`G3 ${rel}: forbidden API call "${c.name}" (I19/I22/F4)`);
  }

  const lower = src.toLowerCase();
  for (const w of BUSINESS_WORDS) {
    if (lower.includes(w.toLowerCase())) violations.push(`G4 ${rel}: business word "${w}" (M1)`);
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────────

if (violations.length) {
  console.error(`✗ mesh import/word gate FAILED (${violations.length} violation(s)):`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(`✓ mesh gates passed (${files.length} source files checked)`);