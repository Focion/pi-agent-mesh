// ═══════════════════════════════════════════════════════════════════════════
// G05（本地验收·崩溃恢复性质）：100 个确定性 seed 的「崩溃 → 重开」三性质。
//
// 每个 seed 生成 N 账户 / M 会话（direct·group·topic·queue 四型）/ K 随机操作
// （send / presence / join / leave / setCaps / subscribe / queue claim 不 ack / 折叠），
// 用 FakeStreamPort 走单进程毫秒级路径，无 pi、无网络。
//
// 崩溃注入（诚实标注）：K 步后不 close()（保 DB/WAL、弃内存态，等价 kill -9 无清理
// 退出）。因测试与被测宿主同 pid，锁文件的「死进程回收」由 recoverDeadEndpoints 在
// pid 真死时才做——这里以 EndpointLock.forceRelease 显式模拟该回收路径（锁生命周期
// 与数据完整性正交，性质断言只盯 DB/WAL）。之后直接 createMesh(dbPath) 重开。
//
// 重开后三性质（不弱化为「数量 ≥1」/「无违规即过」）：
//   ① assertInvariants——C1–C16 全 16 条零违规。这条同时是 §11.8 窄窗口①③④⑥
//      「同事务原子」的负向证明：seq 分配/扇出、镜像/落库、折叠前移/被折 drop、
//      claim/claim_until 都在单事务内封死，崩溃无法持久化半态。
//   ② idempotency_key UNIQUE（无重复键）+ 重发同 (conv,from,clientToken) 得同 messageId。
//   ③ 恰好一次：mesh_deliveries 无 (message,account) 重复行 + 崩溃前后 message/delivery
//      总行数不变（无重投新建、无丢失删除——reconcile 只改状态不改行集）。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMesh,
  type MeshHost,
  type SendInput,
  type SessionFactory,
} from "../../src/index.js";
import { EndpointLock } from "../../src/pi/lock.js";
import type { Cap } from "../../src/core/types.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";
import { bernoulli, mulberry32, pick, range, type Prng } from "../helpers/prng.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "crash-session" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const readOnly = (dbPath: string): Database.Database => new Database(dbPath, { readonly: true });

/** 单列积计的便捷查询（read-only） */
function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** pick 出 n 个去重元素（不足 n 则全返回） */
function msPick(rand: Prng, xs: string[], n: number): string[] {
  const out: string[] = [];
  const pool = [...xs];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
  return out;
}

interface ConvRef {
  id: string;
  kind: "direct" | "group" | "topic" | "queue";
}

interface ResendCandidate {
  convId: string;
  from: string;
  clientToken: string;
  expectedMessageId: string;
}

const CAP_PAIRS: Cap[][] = [["speak", "read"], ["speak"], ["speak", "read", "invite"]];

describe("G05: 崩溃恢复性质（100 seed · FakeStreamPort）", () => {
  it("每个 seed：崩溃重开后 C1–C16 全绿 + 幂等唯一 + 恰好一次（不多不少）", async () => {
    // 100 seed × 最大 500 随机操作 + 每 seed 两次 createMesh（迁移/对账/清扫），
    // 单 it 聚合须跨过默认 60s testTimeout；以确定性 PRNG 保证可复现，不做并行。
    for (let seed = 1; seed <= 100; seed++) {
      const dir = mkdtempSync(join(tmpdir(), `mesh-crash-${seed}-`));
      const dbPath = join(dir, "mesh.db");
      let hostA: MeshHost | undefined;
      let hostB: MeshHost | undefined;
      try {
        hostA = await createMesh({
          dbPath,
          policies: { sessionFactory: stubSessionFactory },
          streamPort: new FakeStreamPort(),
          limits: { sweepIntervalMs: 0, maxPending: 8, maxPendingBytes: 4096, handoffTimeoutMs: 1000 },
          devMode: true,
        });

        const rand = mulberry32(seed);
        const accounts: string[] = [];
        const N = range(rand, 2, 31);
        for (let i = 0; i < N; i++) {
          const id = `a${i}`;
          await hostA.registerAccount({
            id,
            displayName: `A${i}`,
            endpointClass: "stream",
            initiate: ["chat", "task"],
          });
          await hostA.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
          await hostA.setPresence(id, "available");
          accounts.push(id);
        }

        const convs: ConvRef[] = [];
        const members = new Map<string, Set<string>>(); // convId → 可合法操作的账号集（生产/发言/消费）
        const M = range(rand, 1, 11);
        for (let i = 0; i < M; i++) {
          const a = pick(rand, accounts);
          const b = pick(rand, accounts.filter((x) => x !== a));
          const kind = pick(
            rand,
            ["direct", "direct", "direct", "group", "group", "topic", "queue"] as const,
          );
          if (kind === "direct") {
            const c = await hostA.ensureDirect(a, b);
            convs.push({ id: c.id, kind });
            members.set(c.id, new Set([a, b]));
          } else if (kind === "group") {
            const size = range(rand, 2, Math.min(6, N + 1));
            const base = new Set([a, b]);
            while (base.size < size) base.add(pick(rand, accounts));
            const ms = [...base];
            const c = await hostA.createConversation({ type: "group", creator: a, members: ms });
            convs.push({ id: c.id, kind });
            members.set(c.id, new Set(ms));
          } else {
            // topic：creator 建会话 + 若干订阅者；queue：creator 为生产者，members 为消费者
            const c = await hostA.createConversation({
              type: kind,
              creator: a,
              ...(kind === "queue" ? { members: [b] } : {}),
            });
            convs.push({ id: c.id, kind });
            members.set(c.id, new Set(kind === "queue" ? [a, b] : [a]));
            if (kind === "topic") {
              for (const m of msPick(rand, accounts, 2)) {
                try {
                  await hostA.subscribe(c.id, m);
                  members.get(c.id)!.add(m);
                } catch {
                  /* 未知订阅反向拒绝合法 */
                }
              }
            }
          }
        }

        const frames: ResendCandidate[] = [];
        const K = range(rand, 1, 501);
        for (let k = 0; k < K; k++) {
          const op = pick(
            rand,
            ["send", "send", "send", "send", "presence", "join", "leave", "setCaps", "subscribe", "claim", "topic"] as const,
          );
          try {
            if (op === "send") {
              const conv = pick(rand, convs);
              const ms = [...(members.get(conv.id) ?? [])];
              if (ms.length < 2) continue;
              // queue 生产者固定为 creator（ms[0]），且不支持定向（TARGETING_NOT_SUPPORTED）
              const from = conv.kind === "queue" ? ms[0]! : pick(rand, ms);
              const others = ms.filter((x) => x !== from);
              const to =
                conv.kind === "direct"
                  ? others
                  : conv.kind === "queue"
                    ? undefined
                    : bernoulli(rand, 0.7)
                      ? others.filter(() => bernoulli(rand, 0.6))
                      : [];
              const clientToken = `ct:${seed}:${k}`;
              const r = await hostA.send({
                from,
                conversationId: conv.id,
                kind: conv.kind === "queue" ? "task" : "chat",
                expect: conv.kind === "queue" || conv.kind === "topic" ? "none" : pick(rand, ["none", "none", "reply"] as const),
                to: to?.length ? to : undefined,
                text: `m${seed}.${k}`,
                clientToken,
              } as SendInput & { from: string; clientToken: string });
              // direct 会话稳定（不参与 leave/setCaps），作为重发幂等的权威候选
              if (conv.kind === "direct" && frames.length < 8) {
                frames.push({ convId: conv.id, from, clientToken, expectedMessageId: r.messageId });
              }
            } else if (op === "presence") {
              await hostA.setPresence(
                pick(rand, accounts),
                pick(rand, ["available", "away", "dnd", "offline"] as const),
              );
            } else if (op === "join") {
              const conv = pick(rand, convs.filter((c) => c.kind === "group"));
              const m = pick(rand, accounts);
              await hostA.join(conv.id, m);
              members.get(conv.id)!.add(m);
            } else if (op === "leave") {
              const conv = pick(rand, convs.filter((c) => c.kind === "group"));
              const ms = [...(members.get(conv.id) ?? [])];
              if (ms.length > 1) {
                const who = pick(rand, ms);
                await hostA.leave(conv.id, who);
                members.get(conv.id)!.delete(who);
              }
            } else if (op === "setCaps") {
              const conv = pick(rand, convs.filter((c) => c.kind === "group"));
              const ms = [...(members.get(conv.id) ?? [])];
              if (ms.length >= 2) {
                const by = pick(rand, ms);
                const target = pick(rand, ms.filter((x) => x !== by));
                await hostA.setCaps(conv.id, target, pick(rand, CAP_PAIRS), by);
              }
            } else if (op === "subscribe") {
              const conv = pick(rand, convs.filter((c) => c.kind === "topic"));
              const m = pick(rand, accounts);
              await hostA.subscribe(conv.id, m);
              members.get(conv.id)!.add(m);
            } else if (op === "claim") {
              // queue 任务由消费者 claim 后不 ack：投递停在 claimed，穿透崩溃恢复
              const conv = pick(rand, convs.filter((c) => c.kind === "queue"));
              const mems = [...(members.get(conv.id) ?? [])];
              const workers = mems.slice(1);
              if (workers.length) {
                const task = await hostA.send({
                  from: mems[0]!,
                  conversationId: conv.id,
                  kind: "task",
                  expect: "none",
                  text: `task${seed}.${k}`,
                  clientToken: `qct:${seed}:${k}`,
                } as SendInput & { from: string; clientToken: string });
                await flush();
                await hostA.claim(task.messageId, pick(rand, workers));
              }
            } else {
              const conv = pick(rand, convs);
              await hostA.setTopic(conv.id, `t${seed}.${k}`, pick(rand, accounts));
            }
          } catch {
            /* 随机组合产生的合法反向拒绝（越权/非成员/最后管理员等）是合法终态，不计数 */
          }
        }
        await flush();

        const rdb = readOnly(dbPath);
        const preMessages = count(rdb, "SELECT COUNT(*) AS n FROM mesh_messages");
        const preDeliveries = count(rdb, "SELECT COUNT(*) AS n FROM mesh_deliveries");
        rdb.close();

        // ── 崩溃注入：不 close hostA（保 DB/WAL），仅显式回收实例锁模拟死进程回收 ──
        await EndpointLock.forceRelease(dbPath + ".instance.lock");

        // ── 重开（启动期同步跑 reconcileDelivered + sweep，只改状态不改行集）──
        hostB = await createMesh({
          dbPath,
          policies: { sessionFactory: stubSessionFactory },
          streamPort: new FakeStreamPort(),
          limits: { sweepIntervalMs: 0, maxPending: 8, maxPendingBytes: 4096, handoffTimeoutMs: 1000 },
          devMode: true,
        });
        await flush();

        // ① C1–C16 全绿（窄窗口①③④⑥的负向证明）
        await assertInvariants(hostB);

        const bdb = readOnly(dbPath);

        // ② 幂等：唯一键无重复
        expect(
          count(bdb, "SELECT COUNT(*) AS n FROM (SELECT idempotency_key FROM mesh_messages GROUP BY idempotency_key HAVING COUNT(*) > 1)"),
          `seed ${seed}: idempotency_key 出现重复`,
        ).toBe(0);

        // ② 幂等：重发同 (conv,from,clientToken) 得同 messageId（direct 会话稳定，agent_settled 已钉）
        for (const f of frames) {
          const r2 = await hostB.send({
            from: f.from,
            conversationId: f.convId,
            kind: "chat",
            expect: "none",
            text: "resend",
            clientToken: f.clientToken,
          } as SendInput & { from: string; clientToken: string });
          expect(r2.messageId, `seed ${seed}: 重发应命中原 messageId`).toBe(f.expectedMessageId);
        }
        await flush();

        // ③ 恰好一次：无 (message,account) 重复行 + 行数守恒（不多不少）
        expect(
          count(bdb, "SELECT COUNT(*) AS n FROM (SELECT 1 FROM mesh_deliveries GROUP BY message_id, account_id HAVING COUNT(*) > 1)"),
          `seed ${seed}: (message,account) 出现重复投递行`,
        ).toBe(0);
        expect(count(bdb, "SELECT COUNT(*) AS n FROM mesh_messages"), `seed ${seed}: message 行数在崩溃前后变化`).toBe(preMessages);
        expect(count(bdb, "SELECT COUNT(*) AS n FROM mesh_deliveries"), `seed ${seed}: delivery 行数在崩溃前后变化`).toBe(preDeliveries);

        bdb.close();
      } finally {
        if (hostB) await hostB.close().catch(() => {});
        // hostA 崩溃后资源回收：锁文件已 forceRelease、hostB 已释放，close 仅关自身连接
        if (hostA) await hostA.close().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 600_000);
});