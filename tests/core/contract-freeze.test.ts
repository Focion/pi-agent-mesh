// ═══════════════════════════════════════════════════════════════════════════
// W01 合同冻结：错误码单一权威源 + 投递状态域/转换表。
//
// 冻结的东西（改任何一条都应当是有意的破坏，需要显式更新本表 / 在 commit 里说明）：
//  1. 四族错误码的「值域」与「互不复用」约束（§7.10 / §10.1）。
//  2. 运行时登记表（mailbox 的 DROP/PARK、tools 的 REGISTERED_CODES）与
//     types.js 的 const 数组单一值源（不再手写二份字面量）。
//  3. pi 层 MESH_* 码与 core 四族码分层、互不复用。
//  4. mesh_deliveries.state 的 8 态值域（DDL CHECK ≡ 冻结表 ≡ 源码 SET 目标）。
//  5. 投递状态转换表（§7.9）的完整性与终态无出边。
//
// 这是一个「漂移即红」的守卫，不是行为测试（行为仍由 mailbox.test.ts 覆盖）。
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DROP_REASONS,
  PARK_REASONS,
  REJECT_CODES,
  TOOL_ERROR_CODES,
} from "../../src/core/types.js";
import { MESH_ERROR_CODES } from "../../src/pi/llm-config.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** mesh_deliveries.state 的冻结 8 态（§7.9；唯一初始态 routed，其余为 UPDATE 可写目标/终态） */
const DELIVERY_STATES = [
  "routed",
  "queued",
  "parked",
  "delivered",
  "consumed",
  "dropped",
  "claimed",
  "acked",
] as const;

const overlap = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((x) => b.includes(x));

// ─── ① 四族错误码：值域 + 互不复用 ─────────────────────────────────────────

describe("W01 错误码冻结（§7.10 / §10.1）", () => {
  const families = [REJECT_CODES, PARK_REASONS, DROP_REASONS, TOOL_ERROR_CODES];

  it("四族之间互不复用同一个词", () => {
    for (let i = 0; i < families.length; i++) {
      for (let j = i + 1; j < families.length; j++) {
        expect(overlap(families[i]!, families[j]!)).toEqual([]);
      }
    }
  });

  it("每族无重复、无空码，值域完整", () => {
    for (const f of families) {
      expect(new Set(f).size).toBe(f.length);
      f.forEach((c) => expect(c.length).toBeGreaterThan(0));
    }
  });

  it("MESH_* 属 pi 层，不与 core 四族复用", () => {
    const core = [...REJECT_CODES, ...PARK_REASONS, ...DROP_REASONS, ...TOOL_ERROR_CODES];
    expect(new Set(MESH_ERROR_CODES).size).toBe(MESH_ERROR_CODES.length);
    for (const c of MESH_ERROR_CODES) expect(core).not.toContain(c);
  });

  it("运行时登记表单一值源：mailbox / tools 从 types 派生，不再手写字面量", () => {
    const mailbox = readFileSync(`${ROOT}src/core/mailbox.ts`, "utf8");
    const tools = readFileSync(`${ROOT}src/core/tools.ts`, "utf8");
    // mailbox 的 DROP/PARK 登记 = types.js const 数组构造的 Set
    expect(mailbox).toContain("new Set<string>(DROP_REASON_CODES)");
    expect(mailbox).toContain("new Set<string>(PARK_REASON_CODES)");
    // tools 的 REGISTERED_CODES 由四族数组派生，唯 folded（纯内部 drop，不下发工具面）排除
    expect(tools).toContain('...DROP_REASONS.filter((c) => c !== "folded")');
    expect(tools).toContain("...TOOL_ERROR_CODES");
  });
});

// ─── ② 状态域：DDL CHECK ≡ 冻结 8 态 ≡ 源码 SET 目标 ────────────────────────

function source(): string {
  const rels = ["src/core/mailbox.ts", "src/core/router.ts", "src/index.ts"];
  return rels.map((r) => readFileSync(`${ROOT}${r}`, "utf8")).join("\n");
}

/** 从某行 `UPDATE mesh_deliveries` 提取 SET state = 'X' 的目标值（无则 undefined）。 */
function setTarget(line: string): string | undefined {
  return line.match(/state\s*=\s*'([a-z_]+)'/)?.[1];
}

describe("W01 投递状态域冻结", () => {
  it("DDL 的 mesh_deliveries.state CHECK 与冻结 8 态一致", () => {
    const sql = readFileSync(`${ROOT}migrations/000_init.sql`, "utf8");
    const table = sql.match(/CREATE TABLE IF NOT EXISTS mesh_deliveries\s*\([\s\S]*?\)\s*;/)?.[0];
    expect(table).toBeTruthy();
    const check = table!.match(/CHECK \(state IN\s*\(([^)]*)\)\)/)?.[1];
    expect(check).toBeTruthy();
    const listed = (check!.match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect([...listed].sort()).toEqual([...DELIVERY_STATES].sort());
  });

  it("仅这 8 态可被 UPDATE 写入；routed 只能由 INSERT 落库", () => {
    const targets = source()
      .split("\n")
      .filter((l) => /UPDATE\s+mesh_deliveries/.test(l))
      .map(setTarget)
      .filter((s): s is string => s !== undefined);

    // 无越域字面量、无 typo 态
    const domain = new Set(DELIVERY_STATES);
    for (const t of targets) expect(domain.has(t as (typeof DELIVERY_STATES)[number])).toBe(true);

    // routed 是唯一初始态，永不作 UPDATE 的 SET 目标
    expect(targets).not.toContain("routed");

    // 除 routed 外，每个态都是可达的 SET 目标（状态机完整接线）
    const nonInitial = DELIVERY_STATES.filter((s) => s !== "routed");
    for (const s of nonInitial) expect(targets).toContain(s);
  });

  it("routed 由 INSERT 落库（router 初始态）", () => {
    const router = readFileSync(`${ROOT}src/core/router.ts`, "utf8");
    expect(router).toMatch(/INSERT\s+INTO\s+mesh_deliveries\s*\(/);
    // 初始态作为 bound 参数传入（state 占位符 ?），不是 UPDATE 的 SET 目标
    expect(router).toMatch(/"routed"/);
  });
});

// ─── ③ 状态转换表（§7.9）：自洽 + 终态无出边 ────────────────────────────────

// 冻结的合法迁移（from → to）。routed→delivered 是 markDelivered 的 WHERE 守卫
// `state IN ('queued','routed')` 兼容的容错边；delivered→queued 是 beforeClearQueue(I22)
// 补偿边；delivered→claimed 是 queue 竞争消费（claim 要求 row.state==='delivered'）。
const LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  routed: ["queued", "parked", "delivered", "dropped"],
  queued: ["delivered", "parked", "dropped"],
  delivered: ["consumed", "queued", "claimed"],
  parked: ["queued", "dropped"],
  claimed: ["acked", "queued", "dropped"], // queued = nack/reclaim 回队；dropped = MAX_ATTEMPTS 回收
  consumed: [],
  dropped: [],
  acked: [],
};

describe("W01 状态转换表冻结（§7.9）", () => {
  it("所有 from/to 都在 8 态内；routed 不可作为转换目标；终态无出边", () => {
    const states = new Set<string>(DELIVERY_STATES);
    for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS)) {
      expect(states.has(from)).toBe(true);
      for (const to of tos) {
        expect(states.has(to)).toBe(true);
        expect(to).not.toBe("routed");
      }
    }
    for (const terminal of ["consumed", "dropped", "acked"]) {
      expect(LEGAL_TRANSITIONS[terminal]).toEqual([]);
    }
  });
});