// ═══════════════════════════════════════════════════════════════════════════
// G06（本地验收·基准口径，§8.1）：3 预热 + 5 测量、硬门槛每轮必过、吞吐/回归
// 按中位数、p95 只报告。基线冻结在 snapshots/bench-baseline.json；`--record`
// （scripts/bench.mjs）首跑生成，非 record 模式把「相对正确基线退化 >20%」当失败。
// 环境指纹（机器/Node/CPU）由 scripts/bench.mjs 在入口校验：跨机比较直接拒绝，本模块
// 只做「同机相对基线」的比较，不再对绝对值设门槛。
//
// 计量对象一律是真实 createMesh + FakeStreamPort + stub SessionFactory +
// devMode:false（无 LLM、无网络）；计数用 host.observer.counters() 与
// FakeStreamPort.wakeCount()。不允许缩小数据规模 / mock / 直接插入终态行。
// ═══════════════════════════════════════════════════════════════════════════

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type BenchRecord = {
  timeMedianMs: number;
  throughputMedian: number; // work units / second
};

/** 单轮场景：op 是被计时的账本操作（返回工作单元数），assert 是本轮硬门槛。 */
export interface Scenario {
  op(): Promise<number>;
  assert(): Promise<void>;
  close(): Promise<void>;
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty list");
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function p95(xs: number[]): number {
  if (xs.length === 0) throw new Error("p95 of empty list");
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
}

function readBaseline(): Record<string, BenchRecord> {
  const path = process.env.BENCH_BASELINE_PATH ?? join(REPO_ROOT, "snapshots", "bench-baseline.json");
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, BenchRecord>;
  } catch {
    return {};
  }
}

function recordBenchmark(id: string, rec: BenchRecord): void {
  const path = process.env.BENCH_RECORD_PATH;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify({ id, ...rec })}\n`, "utf8");
}

/**
 * 3 预热 + 5 测量。每轮独立 `make()`（含建库/数据，不计时），只对 `op()` 计时；
 * `assert()` 每轮必过（硬门槛）。吞吐与时间按 5 轮中位判定，p95 仅报告。
 * 非 record 模式且存在基线时，退化 >20%（时间 >1.2×，或吞吐 <1/1.2）判失败。
 */
export async function runBench(
  id: string,
  make: () => Promise<Scenario>,
  opts: { warmup?: number; measure?: number } = {},
): Promise<{ timeMedianMs: number; throughputMedian: number; p95Ms: number }> {
  const warmup = opts.warmup ?? 3;
  const measure = opts.measure ?? 5;

  for (let i = 0; i < warmup; i++) {
    const s = await make();
    try {
      await s.op();
      await s.assert();
    } finally {
      await s.close().catch(() => {});
    }
  }

  const times: number[] = [];
  const throughputs: number[] = [];
  for (let i = 0; i < measure; i++) {
    const s = await make();
    try {
      const t0 = performance.now();
      const n = await s.op();
      const elapsed = performance.now() - t0;
      await s.assert();
      times.push(elapsed);
      throughputs.push(n / (elapsed / 1000));
    } finally {
      await s.close().catch(() => {});
    }
  }

  const timeMedianMs = median(times);
  const throughputMedian = median(throughputs);
  const p95Ms = p95(times);

  process.stdout.write(
    `  [bench:${id}] n=${measure} time(median)=${timeMedianMs.toFixed(1)}ms ` +
      `p95=${p95Ms.toFixed(1)}ms throughput(median)=${throughputMedian.toFixed(1)}/s\n`,
  );

  if (process.env.BENCH_RECORD === "1") {
    recordBenchmark(id, { timeMedianMs, throughputMedian });
    return { timeMedianMs, throughputMedian, p95Ms };
  }

  const baseline = readBaseline()[id];
  if (baseline) {
    const timeRatio = timeMedianMs / baseline.timeMedianMs;
    const throughputRatio = throughputMedian / baseline.throughputMedian;
    if (timeRatio > 1.2) {
      throw new Error(
        `bench:${id} 时间退化 ${((timeRatio - 1) * 100).toFixed(1)}%（${timeMedianMs.toFixed(1)}ms vs ` +
          `基线 ${baseline.timeMedianMs.toFixed(1)}ms），超过 20% 回归阈值`,
      );
    }
    if (throughputRatio < 1 / 1.2) {
      throw new Error(
        `bench:${id} 吞吐退化 ${((1 - throughputRatio) * 100).toFixed(1)}%（${throughputMedian.toFixed(1)}/s vs ` +
          `基线 ${baseline.throughputMedian.toFixed(1)}/s），超过 20% 回归阈值`,
      );
    }
  } else {
    process.stdout.write(`  [bench:${id}] 无基线，跳过 20% 回归判定（首跑请 --record）。\n`);
  }

  return { timeMedianMs, throughputMedian, p95Ms };
}

/** 断言住一个硬门槛；失败信息带 bench 名与实测值。 */
export function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`bench 硬门槛失败：${msg}`);
}