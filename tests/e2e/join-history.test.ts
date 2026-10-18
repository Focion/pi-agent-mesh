// ═══════════════════════════════════════════════════════════════════════════
// W08 · N03 · maxHistoryOnJoin 加入历史注入（§9.4）。
//
// 保护的设计决定：仅 `historyVisibility:"full"` 且 `maxHistoryOnJoin>0` 时，把
// 加入前的 ≤N 条消息渲染为 `<<<HISTORY kind="join">>>` 块，经 port.deliver 注入到
// 新成员的「热」端点（合成 envelope，triggerTurn:false，不产生 mesh_messages /
// mesh_deliveries 行——守追溯不变量 §9.4「加入前消息无 delivery 行」）。冷端点
// 不 warm（注入是成本）。`since_join`/`none` 或 N=0 → 零注入（现状保持）。
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
  create: async () => ({ session: {}, piSessionId: "join-hist" }),
  open: async () => ({ session: {} }),
};

interface MeshWorld {
  host: MeshHost;
  port: FakeStreamPort;
}

async function makeMesh(): Promise<MeshWorld> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-join-"));
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

/** 注册一个可说话的 stream 账号 + unified 端点（FakeStreamPort 默认 hot）。 */
async function makeSpeaker(host: MeshHost, id: string): Promise<{ endpointId: string }> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat"],
  });
  const endpoint = await host.registerEndpoint({
    accountId: id,
    topology: { kind: "unified" },
  });
  await host.setPresence(id, "available");
  return { endpointId: endpoint.id };
}

/** 取某端点收到过的 HISTORY 加入块（可能零条）。 */
function historyBlocksTo(port: FakeStreamPort, endpointId: string): string[] {
  return port.delivered
    .filter((d) => d.endpointId === endpointId)
    .map((d) => d.rendered)
    .filter((r) => r.includes(`<<<HISTORY kind="join">>>`));
}

describe("N03: maxHistoryOnJoin 加入历史注入 (§9.4)", () => {
  it("historyVisibility:full + maxHistoryOnJoin=N → 加入者只收到 ≤N 条加入前消息", async () => {
    const { host, port } = await makeMesh();
    try {
      const a = await makeSpeaker(host, "alice");
      const carol = await makeSpeaker(host, "carol");
      const conv = await host.createConversation({
        type: "group",
        creator: "alice",
        config: { historyVisibility: "full", maxHistoryOnJoin: 2 },
      });
      const carolEp = carol.endpointId;

      // 加入前 alice 发 4 条
      for (let i = 1; i <= 4; i++) {
        await host.send({
          from: "alice",
          conversationId: conv.id,
          kind: "chat",
          expect: "none",
          text: `pre-join message ${i}`,
        });
      }
      // 加入前 carol 无 HISTORY 注入
      expect(historyBlocksTo(port, carolEp)).toHaveLength(0);
      await assertInvariants(host);

      await host.addMember(conv.id, "carol", { by: "alice" });

      // 恰好一条 HISTORY 块，含 ≤2 条 <<<MSG 包裹体（recent-2）
      const blocks = historyBlocksTo(port, carolEp);
      expect(blocks).toHaveLength(1);
      const msgs = blocks[0]!.match(/<<<MSG /g) ?? [];
      expect(msgs.length).toBe(2);
      // 是加入前的消息正文，且含外框闭合
      expect(blocks[0]!).toContain("<<<END HISTORY>>>");
      expect(blocks[0]!).toContain("pre-join message 3");
      expect(blocks[0]!).toContain("pre-join message 4");
      // 不起轮（注入是上下文背景，不主动触发）
      const hist = port.delivered.find(
        (d) => d.endpointId === carolEp && d.rendered.includes(`<<<HISTORY kind="join">>>`),
      )!;
      expect(hist.triggerTurn).toBe(false);
      expect(hist.grade).toBe("followUp");
      // 不产生 mesh_deliveries 行（追溯不变量）
      expect(historyBlocksTo(port, a.endpointId)).toHaveLength(0);
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });

  it("historyVisibility:since_join（默认）即使 maxHistoryOnJoin>0 也零注入", async () => {
    const { host, port } = await makeMesh();
    try {
      await makeSpeaker(host, "alice");
      const carol = await makeSpeaker(host, "carol");
      const conv = await host.createConversation({
        type: "group",
        creator: "alice",
        config: { maxHistoryOnJoin: 2 }, // visibility 默认 since_join
      });
      const carolEp = carol.endpointId;

      await host.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        text: "before you joined",
      });
      await host.addMember(conv.id, "carol", { by: "alice" });

      expect(historyBlocksTo(port, carolEp)).toHaveLength(0);
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });

  it("historyVisibility:full + maxHistoryOnJoin=0 → 零注入", async () => {
    const { host, port } = await makeMesh();
    try {
      await makeSpeaker(host, "alice");
      const carol = await makeSpeaker(host, "carol");
      const conv = await host.createConversation({
        type: "group",
        creator: "alice",
        config: { historyVisibility: "full", maxHistoryOnJoin: 0 },
      });
      const carolEp = carol.endpointId;

      await host.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        text: "before you joined",
      });
      await host.addMember(conv.id, "carol", { by: "alice" });

      expect(historyBlocksTo(port, carolEp)).toHaveLength(0);
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });

  it("冷端点不 warm：加入历史不注入 cold 端点（注入是成本）", async () => {
    const { host, port } = await makeMesh();
    try {
      await makeSpeaker(host, "alice");
      await host.registerAccount({
        id: "carol",
        displayName: "carol",
        endpointClass: "stream",
        initiate: ["chat"],
      });
      const carolEp = await host.registerEndpoint({
        accountId: "carol",
        topology: { kind: "unified" },
      });
      port.setEndpointState(carolEp.id, "cold");
      await host.setPresence("carol", "available");

      const conv = await host.createConversation({
        type: "group",
        creator: "alice",
        config: { historyVisibility: "full", maxHistoryOnJoin: 2 },
      });
      await host.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        text: "before you joined",
      });
      await host.addMember(conv.id, "carol", { by: "alice" });

      expect(historyBlocksTo(port, carolEp.id)).toHaveLength(0);
      expect(port.warmed).not.toContain(carolEp.id);
      await assertInvariants(host);
    } finally {
      await host.close();
    }
  });
});