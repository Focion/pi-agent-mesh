// ═══════════════════════════════════════════════════════════════════════════
// D03 权威恢复 e2e（§8.4 §23.6 性质③④）：真实 createMesh 的重启对账面。
//   NoTurnPort 让投递永不回吐 turn_end（「已进上下文、未确认跑完」的窗口）；
//   同 DB 同 port 重启 = 窗口③（entry 存活）→ consumed(partial)；
//   同 DB 全新空 port = 窗口②（entry 丢失）→ queued 重投恰好一次，同 idempotencyKey 只出现一次。
// 启动 ③ 的 reconcileDelivered 在 createMesh 内同步跑（FakeStreamPort 默认 hot）。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import type { Envelope, Grade } from "../../src/core/types.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "e2e-session" }),
  open: async () => ({ session: {} }),
};

/** 投递永不 triggerTurn → 不回吐 turn_end，交付停在 delivered（崩溃窗口） */
class NoTurnPort extends FakeStreamPort {
  override async deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    _opts?: { triggerTurn?: boolean },
  ): Promise<{ entryId?: string }> {
    return super.deliver(endpointId, rendered, envelope, grade, {});
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const readOnly = (dbPath: string): Database.Database =>
  new Database(dbPath, { readonly: true });

async function makeWorld(dbPath: string, port: FakeStreamPort): Promise<{
  host: MeshHost;
  convId: string;
}> {
  const host = await createMesh({
    dbPath,
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits: { handoffTimeoutMs: 1000 },
    devMode: true,
  });
  await host.registerAccount({
    id: "producer",
    displayName: "producer",
    endpointClass: "stream",
    initiate: ["chat", "task"],
  });
  await host.registerEndpoint({ accountId: "producer", topology: { kind: "unified" } });
  await host.registerAccount({
    id: "worker",
    displayName: "worker",
    endpointClass: "stream",
    initiate: ["chat", "task"],
  });
  await host.registerEndpoint({ accountId: "worker", topology: { kind: "unified" } });
  await host.setPresence("worker", "available");
  const conv = await host.ensureDirect("producer", "worker");
  return { host, convId: conv.id };
}

describe("D03 authoritative recovery e2e (§8.4)", () => {
  it("window ③ (entry survives): restart consumes delivered as partial", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-recover3-"));
    const dbPath = join(dir, "mesh.db");
    const port = new NoTurnPort();
    const { host: host1, convId } = await makeWorld(dbPath, port);
    const sent = await host1.send({
      from: "producer",
      conversationId: convId,
      kind: "chat",
      expect: "none",
      text: "hello",
    });
    await flush();

    {
      const db = readOnly(dbPath);
      const row = db
        .prepare("SELECT state, entry_id FROM mesh_deliveries WHERE message_id = ?")
        .get(sent.messageId) as { state: string; entry_id: string | null };
      expect(row.state).toBe("delivered");
      expect(row.entry_id).toBeTruthy();
      db.close();
    }

    await host1.close();

    // 重启：同 DB + 同 port（session 存活）。createMesh 内启动 ③ 已同步对账。
    const host2 = await createMesh({
      dbPath,
      policies: { sessionFactory: stubSessionFactory },
      streamPort: port,
      limits: { handoffTimeoutMs: 1000 },
      devMode: true,
    });
    try {
      const db = readOnly(dbPath);
      const after = db
        .prepare("SELECT state, partial FROM mesh_deliveries WHERE message_id = ?")
        .get(sent.messageId) as { state: string; partial: number };
      expect(after.state).toBe("consumed");
      expect(after.partial).toBe(1);
      db.close();
      await assertInvariants(host2);
    } finally {
      await host2.close();
    }
  });

  it("window ② (entry lost): restart re-delivers exactly once (idempotencyKey once)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-recover2-"));
    const dbPath = join(dir, "mesh.db");
    const port1 = new NoTurnPort();
    const { host: host1, convId } = await makeWorld(dbPath, port1);
    const sent = await host1.send({
      from: "producer",
      conversationId: convId,
      kind: "chat",
      expect: "none",
      text: "hello",
    });
    await flush();

    {
      const db = readOnly(dbPath);
      const row = db
        .prepare("SELECT state, entry_id FROM mesh_deliveries WHERE message_id = ?")
        .get(sent.messageId) as { state: string; entry_id: string | null };
      expect(row.state).toBe("delivered");
      expect(row.entry_id).toBeTruthy();
      db.close();
    }

    await host1.close();

    // 重启：同 DB + 全新空 port（session 丢失）。对账判定 entry 不在 → queued 重投恰好一次。
    const port2 = new NoTurnPort();
    const host2 = await createMesh({
      dbPath,
      policies: { sessionFactory: stubSessionFactory },
      streamPort: port2,
      limits: { handoffTimeoutMs: 1000 },
      devMode: true,
    });
    try {
      expect(port2.delivered.length).toBe(1);
      expect(port2.delivered[0]!.envelope.id).toBe(sent.messageId); // 同 idempotencyKey 只出现一次
      await assertInvariants(host2);
    } finally {
      await host2.close();
    }
  });
});