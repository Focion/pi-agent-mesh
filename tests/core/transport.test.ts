// ═══════════════════════════════════════════════════════════════════════════
// SameHostTransport（§19.3）单元测试：outbox 发布/CAS 认领/回收/死信/幂等。
// 直接操作 transport 实例，不经过 createMesh。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { SameHostTransport } from "../../src/core/transport.js";
import type { PendingDelivery } from "../../src/core/types.js";
import { openTestDb } from "../helpers/db.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 构造一条最小 PendingDelivery */
function mkDelivery(
  deliveryId: string,
  endpointId: string,
  accountId: string,
): PendingDelivery {
  return {
    deliveryId,
    envelope: {
      id: `msg-${deliveryId}`,
      conversationId: "conv-1",
      seq: 1,
      from: "A",
      fromEndpoint: "ep-a",
      idempotencyKey: `ik-${deliveryId}`,
      kind: "chat",
      expect: "none",
      payload: { text: "hello" },
      routedAt: new Date().toISOString(),
    },
    grade: "silent",
    accountId,
    endpointId,
  };
}

describe("SameHostTransport", () => {
  it("publish writes to mesh_outbox ready", () => {
    const tdb = openTestDb();
    const t = new SameHostTransport(tdb.db, "w1");
    const d = mkDelivery("d1", "ep-a", "A");

    t.publish(d);

    const row = tdb.db
      .prepare("SELECT state, target_endpoint, attempts FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { state: string; target_endpoint: string; attempts: number };
    expect(row.state).toBe("ready");
    expect(row.target_endpoint).toBe("ep-a");
    expect(row.attempts).toBe(0);
    tdb.close();
  });

  it("publish is idempotent (INSERT OR IGNORE)", () => {
    const tdb = openTestDb();
    const t = new SameHostTransport(tdb.db, "w1");
    const d = mkDelivery("d1", "ep-a", "A");

    t.publish(d);
    t.publish(d); // 重复发布不抛错不覆盖

    const rows = tdb.db
      .prepare("SELECT COUNT(*) AS n FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { n: number };
    expect(rows.n).toBe(1);
    tdb.close();
  });

  it("poller CAS-claims ready entry and calls handler", async () => {
    const tdb = openTestDb();
    const t = new SameHostTransport(tdb.db, "w1", { pollIntervalMs: 100 });
    const d = mkDelivery("d1", "ep-a", "A");

    let handled: PendingDelivery | undefined;
    t.subscribe("ep-a", async (pd) => {
      handled = pd;
    });

    await t.publish(d);
    const result = await t.pollOnce();

    expect(result.claimed).toBe(1);
    expect(handled).toBeDefined();
    expect(handled!.deliveryId).toBe("d1");

    // 确认 outbox 行变为 done
    const row = tdb.db
      .prepare("SELECT state FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { state: string };
    // handler 内没调 ack，行仍 claimed
    expect(row.state).toBe("claimed");
    tdb.close();
  });

  it("ack moves outbox to done on delivered", async () => {
    const tdb = openTestDb();
    const t = new SameHostTransport(tdb.db, "w1", { pollIntervalMs: 100 });
    const d = mkDelivery("d1", "ep-a", "A");

    t.subscribe("ep-a", async (pd) => {
      await t.ack(pd.deliveryId, "delivered");
    });

    await t.publish(d);
    await t.pollOnce();

    const row = tdb.db
      .prepare("SELECT state FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { state: string };
    expect(row.state).toBe("done");
    tdb.close();
  });

  it("reclaims stale claimed entries", async () => {
    const tdb = openTestDb();
    // claimTtlMs = 1 → 1ms 后即被认为 stale
    const t = new SameHostTransport(tdb.db, "w1", {
      pollIntervalMs: 100,
      claimTtlMs: 1,
    });
    const d = mkDelivery("d1", "ep-a", "A");

    await t.publish(d);

    // 手动标记为 claimed（模拟另一进程认领后崩溃）
    tdb.db
      .prepare(
        "UPDATE mesh_outbox SET state = 'claimed', claimed_by = 'dead-process', claimed_at = ?, attempts = 1 " +
          "WHERE delivery_id = ?",
      )
      .run(new Date(Date.now() - 10_000).toISOString(), "d1");

    let handled = false;
    t.subscribe("ep-a", async () => {
      handled = true;
    });

    const result = await t.pollOnce();
    expect(result.reclaimed).toBe(1);
    expect(result.claimed).toBe(1);
    expect(handled).toBe(true);
    tdb.close();
  });

  it("maxAttempts exceeded → failed", async () => {
    const tdb = openTestDb();
    const t = new SameHostTransport(tdb.db, "w1", {
      pollIntervalMs: 100,
      maxAttempts: 2,
    });
    const d = mkDelivery("d1", "ep-a", "A");

    await t.publish(d);

    // 模拟已尝试 2 次
    tdb.db
      .prepare(
        "UPDATE mesh_outbox SET attempts = 2 WHERE delivery_id = ?",
      )
      .run("d1");

    const result = await t.pollOnce();
    expect(result.failed).toBe(1);

    const row = tdb.db
      .prepare("SELECT state FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { state: string };
    expect(row.state).toBe("failed");
    tdb.close();
  });

  it("no handler → entry stays ready (skipped by poller, left for other processes)", async () => {
    const tdb = openTestDb();
    const t = new SameHostTransport(tdb.db, "w1", { pollIntervalMs: 100 });
    const d = mkDelivery("d1", "ep-x", "A"); // ep-x 无 handler

    await t.publish(d);
    const result = await t.pollOnce();

    // 无 handler ⇒ 跳过，不认领（留给有 handler 的其他进程）
    expect(result.claimed).toBe(0);
    const row = tdb.db
      .prepare("SELECT state, attempts FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { state: string; attempts: number };
    expect(row.state).toBe("ready");
    expect(row.attempts).toBe(0);
    tdb.close();
  });

  it("subscribe returns unsubscribe that removes handler", async () => {
    const tdb = openTestDb();
    const t = new SameHostTransport(tdb.db, "w1", { pollIntervalMs: 100 });
    const d = mkDelivery("d1", "ep-a", "A");

    let count = 0;
    const unsub = t.subscribe("ep-a", async () => {
      count++;
    });

    await t.publish(d);
    await t.pollOnce();
    expect(count).toBe(1);

    unsub();

    // 重新发布一条新 delivery
    const d2 = mkDelivery("d2", "ep-a", "A");
    await t.publish(d2);
    await t.pollOnce();
    // handler 已移除，不触发
    expect(count).toBe(1);

    tdb.close();
  });

  it("start/stop controls poller lifecycle", async () => {
    const tdb = openTestDb();
    const t = new SameHostTransport(tdb.db, "w1", { pollIntervalMs: 50 });
    const d = mkDelivery("d1", "ep-a", "A");

    let delivered = 0;
    t.subscribe("ep-a", async (pd) => {
      delivered++;
      await t.ack(pd.deliveryId, "delivered");
    });

    t.start();
    await t.publish(d);

    // 等待至少一轮轮询
    await sleep(150);
    expect(delivered).toBeGreaterThanOrEqual(1);

    // 停掉 poller
    t.stop();

    const d2 = mkDelivery("d2", "ep-a", "A");
    await t.publish(d2);
    await sleep(150);
    // poller 已停，d2 不应被处理
    expect(delivered).toBe(1);

    tdb.close();
  });

  it("reclaimed entries get fresh claims and eventually fail", async () => {
    const tdb = openTestDb();
    // claimTtl 极短，maxAttempts=3。handler 抛错 → 行留 claimed → reclaim 循环。
    const t = new SameHostTransport(tdb.db, "w1", {
      pollIntervalMs: 5000, // 大间隔，避免自动轮询干扰
      claimTtlMs: 1,
      maxAttempts: 3,
    });
    const d = mkDelivery("d1", "ep-a", "A");

    // 注册一个会抛错的 handler：使 poller 认领后行留 claimed，靠 reclaim 回收
    t.subscribe("ep-a", async () => {
      throw new Error("simulated delivery failure");
    });

    await t.publish(d);

    // 轮 1：认领 → handler 抛错 → 行留 claimed（attempts=1）
    let r1 = await t.pollOnce();
    expect(r1.claimed).toBe(1);
    expect(r1.reclaimed).toBe(0);

    // 等 2ms 让 claimed 变 stale
    await sleep(5);

    // 轮 2：reclaim → ready，再 claim → handler 抛错（attempts=2）
    let r2 = await t.pollOnce();
    expect(r2.reclaimed).toBe(1);
    expect(r2.claimed).toBe(1);
    expect(r2.failed).toBe(0);

    let row = tdb.db
      .prepare("SELECT state, attempts FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { state: string; attempts: number };
    expect(row.state).toBe("claimed");
    expect(row.attempts).toBe(2);

    await sleep(5);

    // 轮 3：reclaim → ready（attempts=2），再 claim → handler 抛错（attempts=3）
    let r3 = await t.pollOnce();
    expect(r3.reclaimed).toBe(1);
    expect(r3.claimed).toBe(1);
    expect(r3.failed).toBe(0); // attempts=2 < maxAttempts=3 → 还没触发

    row = tdb.db
      .prepare("SELECT state, attempts FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { state: string; attempts: number };
    expect(row.attempts).toBe(3);

    await sleep(5);

    // 轮 4：reclaim → ready（attempts=3）→ failed 检查命中
    let r4 = await t.pollOnce();
    expect(r4.reclaimed).toBe(1);
    expect(r4.failed).toBe(1); // attempts=3 >= maxAttempts=3 → failed
    expect(r4.claimed).toBe(0);

    row = tdb.db
      .prepare("SELECT state, attempts FROM mesh_outbox WHERE delivery_id = ?")
      .get("d1") as { state: string; attempts: number };
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(3);

    tdb.close();
  });
});