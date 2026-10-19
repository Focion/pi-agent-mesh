#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// bench —— G06 基准门（W15 §6 / §8.1）。驱动 `vitest run --config
// vitest.bench.config.ts` 跑三个基准（A 双聊 200、B 三十人 500、C 八消费者 1000）
// 与 V05 规模正确性用例，并把「相对正确基线退化 >20%」接进判定。
//
//   node scripts/bench.mjs            # 对比 snapshots/bench-baseline.json（20% 回归）
//   node scripts/bench.mjs --record   # 首跑生成基线（覆盖写）
//
// 基线经各 bench 用例以 append 方式写入一个临时 JSONL（BENCH_RECORD_PATH），
// 本脚本结束时聚合为 snapshots/bench-baseline.json。非 record 模式只读基线。
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const BASELINE = join(ROOT, "snapshots", "bench-baseline.json");

const args = process.argv.slice(2);
const record = args.includes("--record");

if (record && !existsSync(VITEST)) {
  console.error("✗ node_modules 缺失——先 npm install。");
  process.exit(1);
}

const env = { ...process.env };
if (record) {
  const recordPath = join(tmpdir(), `mesh-bench-record-${process.pid}-${Date.now()}.jsonl`);
  try {
    rmSync(recordPath, { force: true });
  } catch {}
  env.BENCH_RECORD = "1";
  env.BENCH_RECORD_PATH = recordPath;
} else {
  env.BENCH_BASELINE_PATH = BASELINE;
}

// ── 环境指纹（D5）：基准数字绑定机器/Node，跨机比较会误报退化 ────────────
function currentFingerprint() {
  return {
    platform: platform(),
    arch: arch(),
    node: process.versions.node,
    cpuModel: cpus()[0]?.model ?? "unknown",
  };
}
function sameFingerprint(a, b) {
  return (
    !!a && !!b &&
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.node === b.node &&
    a.cpuModel === b.cpuModel
  );
}
if (!record && existsSync(BASELINE)) {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const fp = baseline.fingerprint;
  const cur = currentFingerprint();
  if (!fp) {
    console.error("✗ 基准基线缺少环境指纹（旧格式）——请 `node scripts/bench.mjs --record` 重录。");
    process.exit(1);
  }
  if (!sameFingerprint(fp, cur)) {
    console.error(
      `✗ 基准基线环境指纹不匹配，拒绝跨机比较（会误报退化）：\n` +
        `  基线 ${JSON.stringify(fp)}\n  当前 ${JSON.stringify(cur)}\n` +
        `  若本机就是参考机 → node scripts/bench.mjs --record 重录；` +
        `否则跑 verify:local 时用 --skip-bench 跳过 G06。`,
    );
    process.exit(1);
  }
}

// G06 与「G05 already filtered tests」无关——这里只跑 packages 里声明要跑的文件集，
// 由 vitest.bench.config.ts 的 include 收口（A/B/C + scale-v05）。
const r = spawnSync(process.execPath, [VITEST, "run", "--config", "vitest.bench.config.ts"], {
  cwd: ROOT,
  env,
  stdio: "inherit",
});
if (r.status !== 0) {
  process.exit(r.status ?? 1);
}

if (record) {
  // 聚合各 benchmark 记录的 JSONL → BASELINE 映射（顶层带环境指纹）。
  const recordPath = env.BENCH_RECORD_PATH;
  const out = {};
  const lines = readFileSync(recordPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const { id, timeMedianMs, throughputMedian } = JSON.parse(line);
    out[id] = { timeMedianMs, throughputMedian };
  }
  const baseline = { fingerprint: currentFingerprint(), ...out };
  mkdirSync(join(ROOT, "snapshots"), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  try {
    rmSync(recordPath, { force: true });
  } catch {}
  console.log(`✅ 已写入基准基线 ${BASELINE}（fingerprint: ${JSON.stringify(baseline.fingerprint)}）`);
}