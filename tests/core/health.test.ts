// ═══════════════════════════════════════════════════════════════════════════
// 存储故障执行链（I34）：检测 → 告警（invariant_violated 事件 + 同名计数器）
// → 停发（host.send 拒绝）→ 恢复（清除/自愈 → 放行）。
// 故障注入走 devMode 缝（非公共面），四类故障各验一遍；真实检测在 store 层
// 验「便宜的」两例（query_only 不可写、时钟回退）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh, type MeshHost } from "../../src/index.js";
import type { StorageFaultCode } from "../../src/core/health.js";
import { SqliteStore } from "../../src/core/store.js";

const sessionFactory = {
  create: async () => ({ session: {}, piSessionId: "health-test" }),
  open: async () => ({ session: {} }),
};

interface FaultDevHook {
  _dev: { injectFault: (c: StorageFaultCode) => void; clearFault: (c: StorageFaultCode) => void };
}

async function makeHost(): Promise<MeshHost> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-health-"));
  return createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory },
    devMode: true,
  });
}

/** 注册一个可发消息的 stream 账号 + topic，供「发送恢复」断言。 */
async function readyTopic(host: MeshHost, id: string): Promise<{ id: string }> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat"],
  });
  await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
  return host.createConversation({ type: "topic", creator: id });
}

const FAULTS: StorageFaultCode[] = [
  "not_writable",
  "clock_rollback",
  "wal_over_threshold",
  "integrity_failed",
];

describe("storage fault execution chain via devMode injection (I34)", () => {
  for (const code of FAULTS) {
    it(`inject ${code} → stop-send + alert → clear → resume`, async () => {
      const host = await makeHost();
      const alerts: Array<{ code: string; detail: unknown }> = [];
      host.on("invariant_violated", (p) => alerts.push(p));
      try {
        const topic = await readyTopic(host, "pub");
        const send = () =>
          host.send({
            from: "pub",
            conversationId: topic.id,
            kind: "chat",
            expect: "none",
            text: "hello",
          });

        await send(); // 基线：无故障可正常发送

        (host as unknown as FaultDevHook)._dev.injectFault(code);
        // 停发门：route 前即拒绝，错误码明确 + 携带激活故障
        await expect(send()).rejects.toThrow(/storage_fault/);
        expect(alerts.some((a) => a.code === "storage:" + code)).toBe(true);

        (host as unknown as FaultDevHook)._dev.clearFault(code);
        await send(); // 恢复放行
      } finally {
        await host.close();
      }
    });
  }

  it("alert channel is idempotent per fault code (single event per entry)", async () => {
    const host = await makeHost();
    const alerts: Array<{ code: string }> = [];
    host.on("invariant_violated", (p) => alerts.push(p));
    try {
      const dev = (host as unknown as FaultDevHook)._dev;
      dev.injectFault("not_writable");
      dev.injectFault("not_writable"); // 幂等：已在故障态，不二次告警
      dev.injectFault("clock_rollback");
      expect(alerts.filter((a) => a.code === "storage:not_writable")).toHaveLength(1);
      expect(alerts.some((a) => a.code === "storage:clock_rollback")).toBe(true);
    } finally {
      await host.close();
    }
  });
});

describe("real fault detection at store level (I34)", () => {
  it("not_writable: query_only write hits READONLY → fault; successful tx recovers", () => {
    const store = SqliteStore.open(join(mkdtempSync(join(tmpdir(), "mesh-health-")), "mesh.db"));
    try {
      expect(store.health.isStopSend()).toBe(false);
      store.db.pragma("query_only = ON");
      expect(() =>
        store.tx(() => {
          store.db.prepare("UPDATE mesh_meta SET v = 'x' WHERE k = 'created_at'").run();
        }),
      ).toThrow();
      expect(store.health.isStopSend()).toBe(true);
      expect(store.health.activeFaults()).toContain("not_writable");

      store.db.pragma("query_only = OFF");
      store.tx(() => {
        store.setMeta("writable-again", "yes");
      });
      expect(store.health.isStopSend()).toBe(false);
      expect(store.getMeta("writable-again")).toBe("yes");
    } finally {
      store.close();
    }
  });

  it("clock_rollback: observed wall-clock recedes → fault; advancing clears it", () => {
    const store = SqliteStore.open(join(mkdtempSync(join(tmpdir(), "mesh-health-")), "mesh.db"));
    const setClock = (iso: string) =>
      store.db
        .prepare(
          "INSERT INTO mesh_meta (k, v) VALUES ('clock_observed_at', ?) " +
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        )
        .run(iso);
    try {
      // 预置「未来」观察值 → 检测到回退
      setClock(new Date(Date.now() + 60_000).toISOString());
      store.checkHealth();
      expect(store.health.isStopSend()).toBe(true);
      expect(store.health.activeFaults()).toContain("clock_rollback");

      // 推回过去 → 复检自愈
      setClock(new Date(Date.now() - 60_000).toISOString());
      store.checkHealth();
      expect(store.health.isStopSend()).toBe(false);
    } finally {
      store.close();
    }
  });
});