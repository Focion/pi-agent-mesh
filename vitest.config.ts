import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // better-sqlite3 is native; run each test file in its own process for isolation
    pool: "forks",
    fileParallelism: true,
    // pi SDK dlopes a clipboard native module that hangs in this environment;
    // TERMUX_VERSION=1 makes pi skip it (checked before any pi import)
    env: { TERMUX_VERSION: "1" },
    // G07：v8 运行时插桩覆盖 core；语句阈值 90% 由 `vitest --coverage` 门直接判定，
    // 四范围分支 ≥95% 由 scripts/coverage-gate.mjs 解析 coverage/coverage-final.json 另行收口。
    coverage: {
      provider: "v8",
      include: ["src/core/**"],
      exclude: ["src/core/index.ts"],
      reporter: ["json", "text-summary"],
      reportsDirectory: "coverage",
      thresholds: { statements: 90 },
    },
  },
});
