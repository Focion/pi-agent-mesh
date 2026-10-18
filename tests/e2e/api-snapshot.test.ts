// ═══════════════════════════════════════════════════════════════════════════
// W01 API/DDL 基线快照守卫。
//
// scripts/gen-snapshots.mjs --check 会实时枚举 src/index.ts + src/core/index.ts
// 的值/类型导出、并对 migrations/000_init.sql 求 sha256，与提交的
// snapshots/ 基线比对，漂移即 exit 1。这里把它接进测试套件，让 `npm test`
// 也覆盖「公共 API 面 / DDL 只读」这条硬约束（§12 / 迁移只读规则）。
//
// 语义：改名/增删导出、改动 000_init.sql 都是漂移。若是有意的契约变更，先
// `node scripts/gen-snapshots.mjs` 重新生成基线再提交——本测试不自动放行。
// ═══════════════════════════════════════════════════════════════════════════

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function runCheck(): void {
  execFileSync(process.execPath, ["scripts/gen-snapshots.mjs", "--check"], {
    cwd: ROOT,
    stdio: "pipe",
    encoding: "utf8",
  });
}

describe("W01 API/DDL 基线快照", () => {
  it("现有源码与 snapshots/ 基线一致（导出面 + 000_init.sql）", () => {
    // 漂移 → 非零退出 → execFileSync 抛错，测试红。
    expect(() => runCheck()).not.toThrow();
  });

  it("api-surface 基线非空且包含关键符号（枚举未静默失效）", () => {
    const surface = JSON.parse(readFileSync(`${ROOT}snapshots/api-surface.json`, "utf8"));
    // 根入口：主装配函数 + 错误码表 + pi 层配置解析
    expect(surface.root.values).toContain("createMesh");
    expect(surface.root.values).toContain("MESH_ERROR_CODES");
    expect(surface.root.values).toContain("resolveLlmConfig");
    expect(surface.root.types).toContain("CreateMeshOptions");
    // core 子入口：冻结的四族错误码 const 数组（W01 单一权威源）
    expect(surface.core.values).toEqual(
      expect.arrayContaining(["REJECT_CODES", "PARK_REASONS", "DROP_REASONS", "TOOL_ERROR_CODES"]),
    );
  });

  it("000_init.sha256 基线为 64 位 hex（来源存在且格式正确）", () => {
    const sha = readFileSync(`${ROOT}snapshots/migrations/000_init.sha256`, "utf8").trim();
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });
});