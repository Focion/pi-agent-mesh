// ═══════════════════════════════════════════════════════════════════════════
// G07（W15）默认策略零告警：默认策略 host（仅必填 sessionFactory，其余 9 槽全默认）
// 跑 A/B/C 三个精简场景，正常路径必须零告警——
//   counters()["policy_degraded"] === 0 && counters()["invariant_violated"] === 0。
//
// 随后经 devMode 故障注入缝（host._dev.injectFault，生产 no-op）驱动 I34 存储故障
// 执行链：注入 → 告警计数 + 停发（send 抛 InvariantViolationError("storage_fault")）、
// clearFault → 恢复放行。注入同样走 invariant_violated（§23.3「必须 0」的告警通道），
// 不新增计数器名、不触碰 policy_degraded（端口级降级与策略超时才用后者）。
//
// 预期计数单独列出（I34 幂等，同一 code 只在注入进入时告警一次）：
//   正常 A/B/C 收尾        invariant_violated = 0, policy_degraded = 0
//   injectFault("not_writable")   → invariant_violated = 1
//   injectFault("clock_rollback") → invariant_violated = 2（累加，计数器单调不回退）
//   clearFault 两码             → isStopSend()=false，send 恢复；计数仍为 2
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh, type MeshHost, type MessageKind, type SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

// src/index 不导出 StorageFaultCode（core 内部类型）；这里按 health.ts 的联合字面量对齐。
type StorageFaultCodeLike = "not_writable" | "clock_rollback" | "wal_over_threshold" | "integrity_failed";

/** devMode 下挂在 host 上的注入缝（index.ts L1747-1752）。 */
type DevFaults = { _dev: { injectFault: (c: StorageFaultCodeLike) => void; clearFault: (c: StorageFaultCodeLike) => void } };

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "obs-default" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function register(host: MeshHost, id: string, initiate: MessageKind[]): Promise<string> {
  await host.registerAccount({ id, displayName: id, endpointClass: "stream", initiate });
  return (await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } })).id;
}

describe("G07 默认策略零告警 + 存储故障执行链观测", () => {
  it("A/B/C 正常路径零告警；fault 注入计数 + clearFault 恢复", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-obs-"));
    const port = new FakeStreamPort();
    // 默认策略：只给必填 sessionFactory；devMode:true 仅为暴露 _dev 注入缝，不改变任何策略。
    const host: MeshHost = await createMesh({
      dbPath: join(dir, "mesh.db"),
      policies: { sessionFactory: stubSessionFactory },
      streamPort: port,
      limits: { sweepIntervalMs: 0, handoffTimeoutMs: 1000 },
      devMode: true,
    });
    const dev = (host as unknown as DevFaults)._dev;

    // ── A：双 Agent direct ─────────────────────────────────────────────────
    const aEp = await register(host, "alice", ["chat"]);
    const bEp = await register(host, "bob", ["chat"]);
    await host.setPresence("alice", "available");
    await host.setPresence("bob", "available");
    await host.warm(aEp, "shared");
    await host.warm(bEp, "shared");
    const dc = await host.ensureDirect("alice", "bob");
    await host.send({ from: "alice", conversationId: dc.id, kind: "chat", expect: "none", to: ["bob"], text: "hi" });
    await host.send({ from: "bob", conversationId: dc.id, kind: "chat", expect: "none", to: ["alice"], text: "yo" });

    // ── B：三人 group 广播 ────────────────────────────────────────────────
    const members = ["g0", "g1", "g2"];
    const gEps: string[] = [];
    for (const id of members) gEps.push(await register(host, id, ["chat"]));
    for (let i = 0; i < members.length; i++) {
      await host.setPresence(members[i]!, "available");
      await host.warm(gEps[i]!, "shared");
    }
    const gc = await host.createConversation({ type: "group", creator: "g0", members });
    await host.send({ from: "g0", conversationId: gc.id, kind: "chat", expect: "none", text: "hello group" });

    // ── C：queue 生产者 → 单消费者 claim→ack ──────────────────────────────
    await register(host, "producer", ["task"]);
    await register(host, "w1", ["task"]);
    await host.setPresence("w1", "available");
    const q = await host.createConversation({ type: "queue", creator: "producer", members: ["w1"] });
    const sent = await host.send({ from: "producer", conversationId: q.id, kind: "task", expect: "none", text: "job 1" });
    await flush();
    // Router 对 queue 强制 expect="ack"（§17.1），消费者待应答里应恰有一条；经公共 API 取 correlationId。
    const awaiting = (await host.observer.inboxOf("w1")).awaitingMyAck;
    expect(awaiting).toHaveLength(1);
    const claim = await host.claim(sent.messageId, "w1");
    expect(claim.ok).toBe(true);
    await host.ack({ correlationId: awaiting[0]!.correlationId, from: "w1" });

    // ── 正常路径零告警（默认策略 9 槽全默认，不允许 policy_degraded / invariant_violated）──
    await flush();
    let c = await host.observer.counters();
    expect(c["policy_degraded"] ?? 0, "默认策略正常路径 policy_degraded 必须为 0").toBe(0);
    expect(c["invariant_violated"] ?? 0, "默认策略正常路径 invariant_violated 必须为 0").toBe(0);
    await assertInvariants(host); // 正常收尾 C1–C16 全绿

    // ── I34 故障注入：告警计数 + 停发 ─────────────────────────────────────
    dev.injectFault("not_writable");
    c = await host.observer.counters();
    expect(c["invariant_violated"] ?? 0).toBe(1);

    dev.injectFault("clock_rollback");
    c = await host.observer.counters();
    expect(c["invariant_violated"] ?? 0).toBe(2);
    // 任一无毒故障激活即停发；policy_degraded 仍 0（存储故障与策略超时是两条通道）。
    expect(c["policy_degraded"] ?? 0).toBe(0);
    await expect(
      host.send({ from: "alice", conversationId: dc.id, kind: "chat", expect: "none", to: ["bob"], text: "blocked" }),
    ).rejects.toMatchObject({ code: "storage_fault" });

    // ── clearFault 恢复：停发解除、计数单调不回退 ─────────────────────────
    dev.clearFault("not_writable");
    dev.clearFault("clock_rollback");
    await host.send({ from: "alice", conversationId: dc.id, kind: "chat", expect: "none", to: ["bob"], text: "recovered" });
    await flush();
    c = await host.observer.counters();
    expect(c["invariant_violated"] ?? 0, "invariant_violated 是单调计数器，clearFault 不回退").toBe(2);
    expect(c["policy_degraded"] ?? 0).toBe(0);
    await assertInvariants(host);

    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
});