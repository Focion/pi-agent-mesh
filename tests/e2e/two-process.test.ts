// ═══════════════════════════════════════════════════════════════════════════
// G05（本地验收·真实双 OS 进程）：A 进程内联（本测试），B 进程经 fork 运行
// tests/e2e/two-process-agent.test.ts（真实 vitest 子进程 → 真实 pi 会话 + faux）。
//
// 与 samehost.test.ts 的区别：那里「跨进程」是方案内模拟（FakeStreamPort + 手写
// 外国锁文件）；这里两个真 OS 进程各自 createMesh（transport:"sameHost"）+ 真实
// PiStreamPort + createPiSessionFactory(faux)，warm 各自端点后由 PiStreamPort 以
// 自身 pid/writerId 写真实端点锁。alice 发 bob 的消息因 bob 端点锁异主进 outbox，
// 由 B 进程 poller 认领 → PiStreamPort.deliver → bob 真实磁盘 session JSONL。
//
// 握手全用共享 tmpdir 的文件（ready/result）+ 环境变量传参，避免 vitest 的 `--`
// arg 转发差异；断言「跨进程正文进 session + 端点锁归属 + dedup_hit===0 + 两端
// 16 条不变量」分别落在拥有 session 的一方。
// ═══════════════════════════════════════════════════════════════════════════

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMesh, type MeshHost, type SessionFactory } from "../../src/index.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import { createFaux, registerFauxInto, waitFor, type FauxCore } from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITEST_CLI = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const AGENT_FILE = join(ROOT, "tests", "e2e", "two-process-agent.test.ts");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 用真 faux 包一层 SessionFactory（alice 侧：起真 pi 会话、暖端点写锁但不跑轮）。 */
function fauxFactory(stateDir: string, agentDir: string, faux: FauxCore): SessionFactory {
  const inner = createPiSessionFactory({ stateDir, agentDir, model: faux.getModel(), tools: [] });
  return {
    async create(ctx) {
      const r = await inner.create(ctx);
      registerFauxInto(r.session, faux);
      return r;
    },
    async open(ctx) {
      const r = await inner.open(ctx);
      registerFauxInto(r.session, faux);
      return r;
    },
  };
}

function spawnRoleB(
  dbPath: string,
  readyPath: string,
  resultPath: string,
): { child: ChildProcess; exited: Promise<number | null>; output: () => string } {
  const env = {
    ...process.env,
    MESH_ROLE: "b",
    MESH_DB_PATH: dbPath,
    MESH_READY_PATH: readyPath,
    MESH_RESULT_PATH: resultPath,
  };
  const child = spawn(process.execPath, [VITEST_CLI, "run", AGENT_FILE, "--no-color"], {
    cwd: ROOT,
    env,
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

describe("G05: 真实双 OS 进程 + 真实 Pi 端口跨进程投递（§19.3 + §23.5）", () => {
  const live: ChildProcess[] = [];
  afterEach(() => {
    for (const c of live) {
      if (c.exitCode === null) c.kill("SIGKILL");
    }
    live.length = 0;
  });

  it("A→B 跨进程投递落进 bob 真实 session JSONL，两端 16 绿 + dedup_hit===0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-2proc-"));
    const dbPath = join(dir, "mesh.db");
    const readyPath = join(dir, "ready");
    const resultPath = join(dir, "result");
    const stateDir = join(dir, "mesh");

    // ── A 进程：alice（真 PiStreamPort + faux），暖端点写真实锁 ──
    const fauxA = await createFaux("faux-a");
    const hostA: MeshHost = await createMesh({
      dbPath,
      transport: "sameHost",
      transportOptions: { pollIntervalMs: 50, claimTtlMs: 5000 },
      policies: { sessionFactory: fauxFactory(stateDir, dir, fauxA) },
      limits: { handoffTimeoutMs: 1000 },
      devMode: true,
    });
    await hostA.registerAccount({
      id: "alice",
      displayName: "Alice",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    const aliceEp = await hostA.registerEndpoint({ accountId: "alice", topology: { kind: "unified" } });
    await hostA.setPresence("alice", "available");
    await hostA.warm(aliceEp.id, "shared");

    try {
      // ── B 进程：bob（真实 vitest 子进程，注册/预热 bob 后写 ready）──
      const { child, exited, output } = spawnRoleB(dbPath, readyPath, resultPath);
      live.push(child);

      await waitFor(() => existsSync(readyPath), 30_000);

      // alice —组会话→ bob。用 group + expect:"ack"（同 samehost.test.ts）：ack 使 bob 进入
      // 原文预算内（§7.4 P1 全文），真正走 outbox→PiStreamPort.deliver→磁盘 session 的
      // 跨进程全文路径；全文以 custom_message 条目落进 bob session，供子进程断言。
      const conv = await hostA.createConversation({
        type: "group",
        creator: "alice",
        members: ["bob"],
      });
      await hostA.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "ack",
        to: ["bob"],
        text: "PING",
      });

      // bob 在真实磁盘 session 里看到 PING 后写 result（本进程侧断言照旧内部完成）
      await waitFor(() => existsSync(resultPath), 30_000).catch(() => {
        throw new Error(`resultPath 30s 未写；role B 退出码=${child.exitCode}\n=== ROLE B OUTPUT ===\n${output()}`);
      });
      expect(readFileSync(resultPath, "utf8")).toBe("ok");

      // B 进程退出码 0（其内部：entry 落盘 + 端点锁归属 + 16 绿）
      const code = await Promise.race([exited, sleep(30_000).then(() => "timeout" as const)]);
      expect(code, `role B vitest 异常退出：\n${output()}`).toBe(0);

      // A 进程侧：无幂等命中 + 16 绿
      expect((await hostA.observer.counters())["dedup_hit"] ?? 0).toBe(0);
      await assertInvariants(hostA);
    } finally {
      await hostA.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});