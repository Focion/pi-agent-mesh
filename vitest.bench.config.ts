// G06 基准专用 vitest 配置（scripts/bench.mjs 驱动），默认不并入 `npm test`
// （vitest.config.ts 的 include 不变）。基准是普通 it 用例，自做 3 预热 + 5 测量，
// 因此只收 tests/bench/*.bench.ts，串行（fileParallelism:false）以压低计时噪声；
// 沿用 forks 池与 TERMUX_VERSION=1（better-sqlite3 / pi SDK 原生模块隔离）。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/bench/*.bench.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: "forks",
    fileParallelism: false,
    env: { TERMUX_VERSION: "1" },
  },
});