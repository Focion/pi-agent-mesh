// ═══════════════════════════════════════════════════════════════════════════
// W13 · mesh_inbox 宿主装配（I22）：HostToolContext.inbox() 必须接观测器的完整投影
// （待答 awaitingMyAck、可领取 claimable、自身 claim myClaims、direct peer），而不是
// mailbox.inboxOf 的简化投影。走 createMesh + FakeStreamPort，通过
// host.toolSet(endpointId, ["mesh_inbox"]) 执行真实工具，与 host.observer.inboxOf
// 对拍，证明工具面与观测面同源同形。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";
import { assertInvariants } from "../helpers/invariants.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "e2e-session" }),
  open: async () => ({ session: {} }),
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface World {
  host: MeshHost;
  port: FakeStreamPort;
}

async function makeWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-inbox-tool-"));
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits: { handoffTimeoutMs: 1000 },
    devMode: true,
  });
  return { host, port };
}

async function runInbox(host: MeshHost, endpointId: string): Promise<Record<string, unknown>> {
  const tool = host.toolSet(endpointId, ["mesh_inbox"])[0]!;
  const r = await tool.execute("tc", {}, undefined, undefined, undefined);
  const text = typeof r.content === "string" ? r.content : r.content[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe("W13: mesh_inbox 宿主装配（I22）", () => {
  it("工具面接观测投影：direct peer + 待答（awaitingMyAck）", async () => {
    const { host } = await makeWorld();
    try {
      await host.registerAccount({ id: "producer", displayName: "producer", endpointClass: "stream", initiate: ["chat"] });
      await host.registerEndpoint({ accountId: "producer", topology: { kind: "unified" } });
      await host.registerAccount({ id: "worker", displayName: "worker", endpointClass: "stream", initiate: ["chat"] });
      const workerEp = await host.registerEndpoint({ accountId: "worker", topology: { kind: "unified" } });
      await host.setPresence("worker", "available");

      const direct = await host.ensureDirect("producer", "worker");
      await host.send({ from: "producer", conversationId: direct.id, kind: "chat", expect: "none", text: "hi" });
      const req = (await host.request({
        from: "producer",
        conversationId: direct.id,
        kind: "chat",
        expect: "ack",
        to: ["worker"],
        text: "please answer",
      })) as { correlationId: string };

      const view = await host.observer.inboxOf("worker");
      const dView = view.conversations.find((c) => c.conversationId === direct.id)!;
      expect(dView.peer).toBe("producer");
      expect(view.awaitingMyAck.length).toBeGreaterThan(0);

      const body = await runInbox(host, workerEp.id);
      expect(body.awaitingMyAck).toEqual(view.awaitingMyAck);
      expect(body.awaitingMyAck).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ correlationId: req.correlationId, from: "producer" }),
        ]),
      );
      const entries = body.conversations as Array<Record<string, unknown>>;
      const dTool = entries.find((c) => c.conversationId === direct.id)!;
      expect(dTool.peer).toBe("producer");
      expect(dTool.expectsMyAck).toBe(true); // 对端 == awaitingMyAck.from 推导
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });

  it("工具面接观测投影：可领取（claimable）+ 自身 claim（myClaims）", async () => {
    const { host } = await makeWorld();
    try {
      await host.registerAccount({ id: "producer", displayName: "producer", endpointClass: "stream", initiate: ["task"] });
      await host.registerEndpoint({ accountId: "producer", topology: { kind: "unified" } });
      await host.registerAccount({ id: "worker", displayName: "worker", endpointClass: "stream", initiate: ["task"] });
      const workerEp = await host.registerEndpoint({ accountId: "worker", topology: { kind: "unified" } });
      await host.setPresence("worker", "available");
      const q = await host.createConversation({ type: "queue", creator: "producer", members: ["worker"] });

      // 热流 task 投成 delivered → claim 归 myClaims（§17.5：turn_end 不消费 queue 任务）
      const task = await host.send({ from: "producer", conversationId: q.id, kind: "task", expect: "none", text: "job 1" });
      await flush();
      expect((await host.claim(task.messageId, "worker")).ok).toBe(true);

      const view = await host.observer.inboxOf("worker");
      const qView = view.conversations.find((c) => c.conversationId === q.id)!;
      // myClaims 是钉死 I22 的强信号：简化投影 mailbox.inboxOf 没有它
      expect(qView.myClaims?.length).toBe(1);

      const body = await runInbox(host, workerEp.id);
      const qTool = (body.conversations as Array<Record<string, unknown>>).find(
        (c) => c.conversationId === q.id,
      )!;
      expect(qTool.myClaims).toEqual(qView.myClaims);
      // claimable 也随观测投影透传（本场景热流投成 delivered 故为 0，但仍应对拍同源）
      expect(qTool.claimable).toBe(qView.claimable);
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });
});