// G03：每个集成用例收尾统一检查全部 16 条 SQL 不变量（C1–C16）。
//
// 与旧式 `expect(report.violations).toEqual([])` 的区别：这里额外断言 `checked===16`，
// 防止某些用例因「根本没跑足够检查」而假绿；对刻意以合法终态收尾的场景（如手工写的
// 外国锁令 C10 判 dead），用 `expectViolations` 白名单精确钉住，其余 15 条仍必须绿——
// 这是「不弱化」的对立面，而非绕过。
import { expect } from "vitest";
import type { MeshHost } from "../../src/index.js";

export interface AssertInvariantsOptions {
  /** 该场景合法收尾时出现的违规 id 集合；默认 []（必须零违规）。 */
  expectViolations?: string[];
}

export async function assertInvariants(
  host: MeshHost,
  opts: AssertInvariantsOptions = {},
): Promise<void> {
  const report = await host.observer.checkInvariants();
  expect(report.checked).toBe(16); // C1–C16 全部执行（checkInvariants 无跳检分支）
  const ids = report.violations.map((v) => v.id).sort();
  expect(ids).toEqual([...(opts.expectViolations ?? [])].sort());
}