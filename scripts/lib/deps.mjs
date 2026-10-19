// ═══════════════════════════════════════════════════════════════════════════
// deps —— 关键依赖「安装版本 vs package.json 声明」一致性断言（T7）。
//
// 复核时曾出现 node_modules 里是 pi 0.85.1、而 package.json / lock 要 ^1.1.0 的
// 情况，导致 12 个 tests/pi 用例失败、看起来像代码缺陷。在 verify:local / pack
// 前断言 runtime dependencies 的实际版本满足声明范围，把「装错版本」在门禁最前段
// 拦下，而不是让它伪装成测试失败。
//
// 范围：只查 package.json 的 `dependencies`（运行时/发布物依赖）；devDependencies
// 不进包，且其版本漂移不影响消费者。semver 断言覆盖本项目当前用到的 `^` / `~`
// 区间与精确/裸版本号；遇到不支持的范围宁可报错（fail-closed）也不放行。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}
function cmp(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** 最小 semver 断言：支持 `^x.y.z` / `~x.y.z` / 精确或裸 `x.y.z`；其余范围 fail-closed。 */
function satisfies(version, range) {
  const v = parse(version);
  const r = String(range).trim();
  if (r.startsWith("^")) {
    const lo = parse(r.slice(1));
    if (!lo) throw new Error(`无法解析依赖范围 "${range}"`);
    if (!v) return false;
    return v.major === lo.major && cmp(v, lo) >= 0;
  }
  if (r.startsWith("~")) {
    const lo = parse(r.slice(1));
    if (!lo) throw new Error(`无法解析依赖范围 "${range}"`);
    if (!v) return false;
    return v.major === lo.major && v.minor === lo.minor && cmp(v, lo) >= 0;
  }
  const exact = parse(r);
  if (exact) return !!v && cmp(v, exact) === 0;
  throw new Error(`不支持的依赖范围 "${range}"（仅支持 ^x.y.z / ~x.y.z / x.y.z）`);
}

/**
 * 断言 node_modules 里 runtime dependencies 的实际版本满足 package.json 声明。
 * 任一缺失或版本不满足即 throw Error（message 可直接交给调用方的 fail()）。
 */
export function assertInstalledDepsMatch() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  for (const [name, range] of Object.entries(deps)) {
    const pkgJson = join(ROOT, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(pkgJson)) {
      throw new Error(`依赖 ${name} 未安装（缺少 ${pkgJson}）——先 npm install。`);
    }
    const installed = JSON.parse(readFileSync(pkgJson, "utf8")).version;
    if (!satisfies(installed, range)) {
      throw new Error(
        `依赖 ${name} 实际版本 ${installed} 不满足 package.json 的 "${range}"（node_modules 与 ` +
          `package-lock 不一致，先 npm install）。`,
      );
    }
  }
}