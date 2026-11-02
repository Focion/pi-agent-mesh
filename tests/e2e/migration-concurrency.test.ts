// ═══════════════════════════════════════════════════════════════════════════
// G（本地验收·A18 并发迁移）：N 个真实 OS 进程在 ready 屏障后同时 `SqliteStore.open`
// 同一 dbPath，验证 BEGIN IMMEDIATE + 锁内重读 applied/hasMeta 之下：
//   ① 无一个 racer 因「表已存在/迁移重复」而失败（exit 全 0）；
//   ② 迁移戳齐全且无重复（每脚本给戳一次）；
//   ③ 最终 DB 可被父进程再次正常打开（幂等）。
//
// 子进程经 fork 运行 tests/e2e/migration-racer.test.ts（真实 vitest 子进程）。
// ═══════════════════════════════════════════════════════════════════════════

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/core/store.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITEST_CLI = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const RACER_FILE = join(ROOT, "tests", "e2e", "migration-racer.test.ts");
const MIGRATIONS_ROOT = fileURLToPath(new URL("../../migrations/", import.meta.url));

const RACERS = 4;

type Racer = { child: ChildProcess; exited: Promise<number | null>; output: () => string };

function spawnRacer(env: NodeJS.ProcessEnv): Racer {
  const child = spawn(process.execPath, [VITEST_CLI, "run", RACER_FILE, "--no-color"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (d: Buffer) => (logs += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (logs += d.toString()));
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  return { child, exited, output: () => logs };
}

describe("G: 并发迁移（A18 双进程同时升级）", () => {
  const live: ChildProcess[] = [];
  afterEach(() => {
    for (const c of live) {
      if (c.exitCode === null) c.kill("SIGKILL");
    }
    live.length = 0;
  });

  it("N 进程同期 open 同一新库全部成功，迁移戳齐全且重开幂等", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-mig-race-"));
    const dbPath = join(dir, "mesh.db");
    const migDir = join(dir, "migrations");
    const readyDir = join(dir, "ready");
    cpSync(MIGRATIONS_ROOT, migDir, { recursive: true });

    const racers: Racer[] = [];
    for (let i = 0; i < RACERS; i++) {
      const r = spawnRacer({
        MESH_RACE: "1",
        MESH_DB_PATH: dbPath,
        MESH_MIG_DIR: migDir,
        MESH_RACER_ID: `r${i}`,
        MESH_RACER_N: String(RACERS),
        MESH_READY_DIR: readyDir,
      });
      racers.push(r);
      live.push(r.child);
    }

    for (let i = 0; i < RACERS; i++) {
      const code = await racers[i]!.exited;
      expect(
        code,
        `racer ${i} 异常退出（code=${code}）：\n${racers[i]!.output()}`,
      ).toBe(0);
    }

    // 父进程再打开一次：幂等 + 迁移戳 1 个（无重复、无缺失）。
    expect(existsSync(dbPath)).toBe(true);
    const store = SqliteStore.open(dbPath);
    try {
      const stamps = (
        store.db
          .prepare("SELECT k FROM mesh_meta WHERE k LIKE 'migration:%'")
          .all() as Array<{ k: string }>
      ).map((r) => r.k);
      expect(stamps).toHaveLength(1);
    } finally {
      store.close();
    }

    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});