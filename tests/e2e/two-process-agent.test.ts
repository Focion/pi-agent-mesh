// ═══════════════════════════════════════════════════════════════════════════
// G05（本地验收·真实双 OS 进程）角色 B：被 `two-process.test.ts` fork 的第二进程。
//
// 不是独立用例：只在以 `MESH_ROLE=b` + `MESH_DB_PATH` 环境变量被 spawn 时生效；
// `npm test` 直接收集到本文件时（无 MESH_ROLE）整条 it 跳过。它与父进程共享同一
// dbPath（sameHost multi 模式），各自 `createMesh` + 真实 PiStreamPort + faux session：
//   - warm 时经 createPiSessionFactory 走磁盘 SessionManager（piSessionId = .jsonl），
//     且 PiStreamPort 以本进程 pid/writerId 写真实端点锁（ownerIsLive==="alive"）；
//   - alice 发往 bob 的消息在父进程因 bob 端点锁异主而进 outbox，由本进程 poller
//     认领后经 handleOutboxDelivery → PiStreamPort.deliver，落进 bob 真实磁盘 session。
//
// 就绪用 readyPath、结果用 resultPath 两个文件与父进程握手；断言（进磁盘 entry、
// 端点锁归属、16 条不变量）都在本进程内完成，父进程只等 result + 退出码。
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh, type MeshHost, type SessionFactory } from "../../src/index.js";
import { EndpointLock } from "../../src/pi/lock.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import { createFaux, customEntries, registerFauxInto, waitFor } from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

const role = process.env.MESH_ROLE;
const dbPath = process.env.MESH_DB_PATH;
const readyPath = process.env.MESH_READY_PATH;
const resultPath = process.env.MESH_RESULT_PATH;
const enabled = role === "b" && !!dbPath && !!readyPath && !!resultPath;

describe("G05 双进程角色 B（真实 OS 进程 + 真实 PiStreamPort/faux）", () => {
  it.skipIf(!enabled)(
    "bob 预热后经 sameHost outbox 收到 alice 的 PING，落进磁盘 session JSONL 且锁归属正确",
    async () => {
      const faux = await createFaux("faux-b");
      let bobSession: { sessionManager: { getEntries(): unknown[] } } | undefined;

      const inner = createPiSessionFactory({
        stateDir: join(dirname(dbPath!), "mesh"),
        agentDir: dirname(dbPath!),
        model: faux.getModel(),
        tools: [],
      });
      const factory: SessionFactory = {
        async create(ctx) {
          const r = await inner.create(ctx);
          registerFauxInto(r.session, faux);
          bobSession = r.session as never;
          return r;
        },
        async open(ctx) {
          const r = await inner.open(ctx);
          registerFauxInto(r.session, faux);
          bobSession = r.session as never;
          return r;
        },
      };

      const hostB: MeshHost = await createMesh({
        dbPath: dbPath!,
        transport: "sameHost",
        transportOptions: { pollIntervalMs: 50, claimTtlMs: 5000 },
        policies: { sessionFactory: factory },
        limits: { handoffTimeoutMs: 1000 },
        devMode: true,
      });

      await hostB.registerAccount({
        id: "bob",
        displayName: "Bob",
        endpointClass: "stream",
        initiate: ["chat"],
      });
      const bobEp = await hostB.registerEndpoint({ accountId: "bob", topology: { kind: "unified" } });
      await hostB.setPresence("bob", "available");
      await hostB.warm(bobEp.id, "shared");

      // warm 应已经 createPiSessionFactory.create 捕获 bob 的磁盘 session
      expect(bobSession).toBeDefined();

      // 就绪握手：bob 已注册 + 预热 + 端点锁已由本进程持有
      writeFileSync(readyPath!, "ready");

      // alice 的 PING 落进 bob 真实磁盘 session（custom_message 条目）
      await waitFor(
        () => customEntries(bobSession!.sessionManager).some((e) => JSON.stringify(e).includes("PING")),
        20_000,
      );
      expect(
        customEntries(bobSession!.sessionManager).filter((e) => JSON.stringify(e).includes("PING")).length,
      ).toBeGreaterThanOrEqual(1);

      await assertInvariants(hostB);

      // 端点锁归属：warm 时本进程应是 bob 端点锁的持锁者（pid 属本进程 = 单写者边界）。
      const lockPath = join(dirname(dbPath!), "mesh", "locks", `${bobEp.id}.lock`);
      const inspected = await EndpointLock.inspect(lockPath);
      expect(inspected.status).toBe("ok");
      if (inspected.status === "ok") expect(inspected.info.pid).toBe(process.pid);

      writeFileSync(resultPath!, "ok");
      await hostB.close();
    },
  );
});