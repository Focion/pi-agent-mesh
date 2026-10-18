// ═══════════════════════════════════════════════════════════════════════════
// W06 N01 / I32(b)（宿主层）：周期清扫定时器（启动后自动 sweep、close 停止），
// 与 topicUnsubscribe 的游标清零口径（cursor_seq = 当时的 next_seq，非 0）。
//
// N01 定时器最短间隔 1000ms（validateLimits）；parkTtlMs 下限 60000ms 无法在测试内
// 用短 TTL 驱动。因此通过把 parked_at 回填为远古时间戳让「若定时器在跑，下一轮必落
// dropped」成为确定性判定，而不依赖等满一分钟 TTL。
// ═══════════════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "sweep-test" }),
  open: async () => ({ session: {} }),
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LONG_AGO = "1970-01-01T00:00:00.000Z"; // 远早于任何 TTL 阈值

interface World {
  host: MeshHost;
  port: FakeStreamPort;
  dbPath: string;
}

async function makeMesh(limits: Record<string, number>): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-sweep-"));
  const dbPath = join(dir, "mesh.db");
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath,
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits,
    devMode: true,
  });
  return { host, port, dbPath };
}

async function makeSpeaker(host: MeshHost, id: string): Promise<void> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat"],
  });
  await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
  await host.setPresence(id, "available");
}

/** 无端点的 stream 账号：投递必然 parked（ENDPOINT_GONE） */
async function makeParkedTarget(host: MeshHost, id: string): Promise<void> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
  });
}

function backdateParkedAt(dbPath: string, messageId: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE mesh_deliveries SET parked_at = ? WHERE message_id = ?").run(
      LONG_AGO,
      messageId,
    );
  } finally {
    db.close();
  }
}

function deliveryState(dbPath: string, messageId: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT state FROM mesh_deliveries WHERE message_id = ?")
      .get(messageId) as { state: string } | undefined;
    return row?.state;
  } finally {
    db.close();
  }
}

describe("W06 N01: periodic sweep timer", () => {
  it("drops a TTL-expired parked delivery without any manual sweep call", async () => {
    const { host, dbPath } = await makeMesh({ sweepIntervalMs: 1000 });
    try {
      await makeSpeaker(host, "A");
      await makeParkedTarget(host, "B");
      const conv = await host.ensureDirect("A", "B");
      const r = await host.send({
        from: "A",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        text: "ttl",
      });
      expect(deliveryState(dbPath, r.messageId)).toBe("parked");

      // 让 parked 的 TTL 已过：下一轮定时 sweep 必会落 dropped
      backdateParkedAt(dbPath, r.messageId);
      await sleep(2200); // 定时器（1s 间隔）至少跑一轮

      expect(deliveryState(dbPath, r.messageId)).toBe("dropped");
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });

  it("close() stops the timer; a TTL-expired parked delivery stays parked", async () => {
    const { host, dbPath } = await makeMesh({ sweepIntervalMs: 1000 });
    await makeSpeaker(host, "A");
    await makeParkedTarget(host, "B");
    const conv = await host.ensureDirect("A", "B");
    const r = await host.send({
      from: "A",
      conversationId: conv.id,
      kind: "chat",
      expect: "none",
      text: "stays-parked",
    });
    await host.close(); // 先停定时器，再把 parked 变成已过期

    backdateParkedAt(dbPath, r.messageId);
    await sleep(2200); // 若定时器泄漏仍在跑，早已跨过 TTL 落 dropped

    expect(deliveryState(dbPath, r.messageId)).toBe("parked");
  });
});

describe("W06 I32(b): topicUnsubscribe cursor = next_seq", () => {
  it("clears pending/overflow and sets cursor_seq to the current next_seq (not 0)", async () => {
    const { host, dbPath } = await makeMesh({ handoffTimeoutMs: 1000 });
    try {
      await makeSpeaker(host, "pub");
      await host.registerAccount({
        id: "sub",
        displayName: "sub",
        endpointClass: "stream",
      });
      const topic = await host.createConversation({ type: "topic", creator: "pub" });
      await host.subscribe(topic.id, "sub");
      // 发一条：sub 无端点 → parked（含一条 pending）；next_seq 随之前进
      await host.send({
        from: "pub",
        conversationId: topic.id,
        kind: "chat",
        expect: "none",
        text: "hello topic",
      });

      await host.unsubscribe(topic.id, "sub");

      const db = new Database(dbPath, { readonly: true });
      try {
        const inbox = db
          .prepare(
            "SELECT pending_count, pending_bytes, overflow_count, overflow_summary, cursor_seq FROM mesh_inboxes WHERE account_id = ? AND conversation_id = ?",
          )
          .get("sub", topic.id) as
          | {
              pending_count: number;
              pending_bytes: number;
              overflow_count: number;
              overflow_summary: string | null;
              cursor_seq: number;
            }
          | undefined;
        const nextSeq = db
          .prepare("SELECT next_seq FROM mesh_conversations WHERE id = ?")
          .get(topic.id) as { next_seq: number } | undefined;
        expect(inbox).toBeTruthy();
        expect(inbox!.pending_count).toBe(0);
        expect(inbox!.overflow_count).toBe(0);
        expect(inbox!.overflow_summary).toBeNull();
        expect(inbox!.cursor_seq).toBe(nextSeq!.next_seq);
        expect(inbox!.cursor_seq).toBeGreaterThan(0); // 非 0（§16.3 规则 3）
      } finally {
        db.close();
      }
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });
});