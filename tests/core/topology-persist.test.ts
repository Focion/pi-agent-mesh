// ═══════════════════════════════════════════════════════════════════════════
// I15/C05：pooled 拓扑 size/affinity/槽位持久化 + legacy 回退 + 按 size 分片稳定。
// 关键点：
//  - registerEndpoint / registerPooledEndpoints 落 pool_size/pool_affinity/pool_slot；
//  - 重开 store 后 endpointsOf 读回 {kind:"pooled", size, affinity}（配置重启不丢）；
//  - legacy 行（迁移前，pool_size/pool_affinity 为 NULL）读回 size=1/affinity="none"；
//  - TopologyEndpointSelector pooled 分支只按 size 取模分片，同 anchor 恒同编号。
//
// 注意：本文件用 SqliteStore.open（应用全量迁移 000/001/002），不用 openTestDb
// （后者只跑 000_init.sql，缺 pool_size/pool_affinity 列）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TopologyEndpointSelector } from "../../src/core/policies.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { SqliteStore } from "../../src/core/store.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import type { Envelope, StreamTopology } from "../../src/core/types.js";

function env(conversationId: string, from = "alice"): Envelope {
  return {
    id: "m1",
    seq: 1,
    from,
    fromEndpoint: null,
    routedAt: new Date().toISOString(),
    idempotencyKey: "ik",
    conversationId,
    kind: "chat",
    expect: "none",
    payload: {},
  };
}

describe("I15：pooled 拓扑 size/affinity/槽位持久化", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mesh-topo-"));
    dbPath = join(dir, "mesh.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registerPooledEndpoints 落 size/affinity/槽位，重开 store 读回（重启不丢）", async () => {
    {
      const store = SqliteStore.open(dbPath);
      const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
      await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
      const eps = await registry.registerPooledEndpoints("A", 3, "conversation");
      expect(eps).toHaveLength(3);

      const read = registry.endpointsOf("A");
      expect(read).toHaveLength(3);
      for (const e of read) {
        expect(e.topology).toEqual({ kind: "pooled", size: 3, affinity: "conversation" });
      }

      // 槽位自增 0..2，且每行都落同一 size/affinity
      const slots = store.db
        .prepare(
          "SELECT pool_slot, pool_size, pool_affinity FROM mesh_endpoints WHERE account_id = ? ORDER BY pool_slot",
        )
        .all("A") as Array<{ pool_slot: number; pool_size: number; pool_affinity: string }>;
      expect(slots.map((r) => r.pool_slot)).toEqual([0, 1, 2]);
      for (const r of slots) {
        expect(r.pool_size).toBe(3);
        expect(r.pool_affinity).toBe("conversation");
      }
      store.close();
    }

    // 重开：拓扑不丢（I15/C05 配置重启不丢）
    {
      const store = SqliteStore.open(dbPath);
      const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
      const read = registry.endpointsOf("A");
      expect(read).toHaveLength(3);
      for (const e of read) {
        expect(e.topology).toEqual({ kind: "pooled", size: 3, affinity: "conversation" });
      }
      store.close();
    }
  });

  it("registerEndpoint 逐条 pooled 自动递增槽位，size/affinity 落列", async () => {
    const store = SqliteStore.open(dbPath);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    await registry.registerEndpoint({ accountId: "A", topology: { kind: "pooled", size: 2, affinity: "sender" } });
    await registry.registerEndpoint({ accountId: "A", topology: { kind: "pooled", size: 2, affinity: "sender" } });

    const slots = store.db
      .prepare("SELECT pool_slot, pool_size, pool_affinity FROM mesh_endpoints WHERE account_id = ? ORDER BY pool_slot")
      .all("A") as Array<{ pool_slot: number; pool_size: number; pool_affinity: string }>;
    expect(slots.map((r) => r.pool_slot)).toEqual([0, 1]);
    for (const r of slots) {
      expect(r.pool_size).toBe(2);
      expect(r.pool_affinity).toBe("sender");
    }
    store.close();
  });

  it("legacy 行（pool_size/pool_affinity NULL）读回 size=1/affinity=none", async () => {
    const store = SqliteStore.open(dbPath);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    // 模拟迁移前手工插入的 pooled 行：无 pool_size/pool_affinity/pool_slot
    store.db
      .prepare("INSERT INTO mesh_endpoints (id, account_id, topology) VALUES (?,?,?)")
      .run("ep-legacy", "A", "pooled");
    const ep = registry.getEndpoint("ep-legacy");
    expect(ep).toBeDefined();
    expect(ep!.topology).toEqual({ kind: "pooled", size: 1, affinity: "none" });
    store.close();
  });
});

describe("I15/C05：选择器 pooled 分片稳定 + perConversation 精确", () => {
  it("pooled 按 size 取模分片：同 conversation anchor 恒同编号，且结果落在 pooled 集内", () => {
    const pooled: Array<{ id: string; inFlight: number; topology: StreamTopology }> = [
      { id: "p0", inFlight: 0, topology: { kind: "pooled", size: 3, affinity: "conversation" } },
      { id: "p1", inFlight: 1, topology: { kind: "pooled", size: 3, affinity: "conversation" } },
      { id: "p2", inFlight: 0, topology: { kind: "pooled", size: 3, affinity: "conversation" } },
    ];
    const s = new TopologyEndpointSelector({ endpointsOf: () => pooled });
    const ids = new Set(pooled.map((p) => p.id));
    const topo: StreamTopology = { kind: "pooled", size: 3, affinity: "conversation" };
    const first = s.select({ accountId: "a", conversationId: "conv-x", envelope: env("conv-x"), topology: topo });
    for (let i = 0; i < 5; i++) {
      const again = s.select({ accountId: "a", conversationId: "conv-x", envelope: env("conv-x"), topology: topo });
      expect(again).toBe(first); // 同 anchor 稳定
    }
    expect(ids.has(first as string)).toBe(true); // 结果必属 pooled 集
  });

  it("pooled 混有 unified/perConversation 端点时只按 pooled 分片", () => {
    const mixed: Array<{ id: string; inFlight: number; topology: StreamTopology }> = [
      { id: "u", inFlight: 0, topology: { kind: "unified" } },
      { id: "p0", inFlight: 0, topology: { kind: "pooled", size: 2, affinity: "sender" } },
      { id: "p1", inFlight: 0, topology: { kind: "pooled", size: 2, affinity: "sender" } },
    ];
    const s = new TopologyEndpointSelector({ endpointsOf: () => mixed });
    const r = s.select({
      accountId: "a",
      conversationId: "c",
      envelope: env("c", "bob"),
      topology: { kind: "pooled", size: 2, affinity: "sender" },
    });
    expect(r === "p0" || r === "p1").toBe(true);
  });

  it("pooled 但账号无 pooled 端点 → null（park，不回落 unified 首条）", () => {
    const s = new TopologyEndpointSelector({
      endpointsOf: () => [{ id: "u", inFlight: 0, topology: { kind: "unified" } }],
    });
    expect(
      s.select({
        accountId: "a",
        conversationId: "c",
        envelope: env("c"),
        topology: { kind: "pooled", size: 1, affinity: "none" },
      }),
    ).toBeNull();
  });
});