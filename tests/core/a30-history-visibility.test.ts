// ═══════════════════════════════════════════════════════════════════════════
// A30（裁决 R4 / §5.2 定向可见性）：非收件人读不到定向消息。
//
//  §5.2：定向消息的投递集 = to ∪ mentions（to 为空 = 全体成员减发送者）。发送方
//  `from` 始终可见自己发的消息。因此 history 与加入历史注入的可见性谓词是：
//
//    visible(reader) = reader == from
//                    ∨ to_accounts IS NULL / '[]'（未定向 = 全体成员）
//                    ∨ reader ∈ to ∨ reader ∈ mentions
//
//  本文件钉住两处查询：HostToolContext.history（mesh_history 工具走它）与
//  injectJoinHistory（加入历史注入走它）。carol 是同会话成员但不在 to/mentions，
//  必须读不到 alice 定向给 bob 的消息；bob（收件人）与 alice（发送方）必须读得到。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { MeshHost, SessionFactory } from "../../src/index.js";
import { parseToolContent } from "../../src/core/tools.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, runtimeRef: "a30" }),
  open: async () => ({ session: {} }),
};

interface HistoryItem {
  seq: number;
  from: string;
  text?: string;
}

async function makeMesh(): Promise<{ host: MeshHost; port: FakeStreamPort }> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-a30-"));
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits: {},
    devMode: true,
  });
  return { host, port };
}

async function addSpeaker(host: MeshHost, id: string): Promise<string> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat"],
  });
  const ep = await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
  await host.setPresence(id, "available");
  return ep.id;
}

async function readHistory(
  host: MeshHost,
  endpointId: string,
  conversationId: string,
): Promise<HistoryItem[]> {
  const tool = host.toolSet(endpointId).find((t) => t.name === "mesh_history");
  if (!tool) throw new Error("mesh_history tool not found");
  const res = parseToolContent(
    await tool.execute("tc", { conversationId }, undefined, undefined, undefined),
  );
  if (res.error) throw new Error(JSON.stringify(res.error));
  return (res.messages as HistoryItem[] | undefined) ?? [];
}

function texts(items: HistoryItem[]): string[] {
  return items.map((m) => m.text).filter((t): t is string => t !== undefined);
}

describe("A30: 定向消息对非收件人不可见", () => {
  it("history：定向 to:[bob] 的消息，carol（同会话非收件人）不可见", async () => {
    const { host } = await makeMesh();
    try {
      const aliceEp = await addSpeaker(host, "alice");
      const bobEp = await addSpeaker(host, "bob");
      const carolEp = await addSpeaker(host, "carol");
      const conv = await host.createConversation({
        type: "group",
        creator: "alice",
        members: ["bob", "carol"],
        config: { historyVisibility: "full" },
      });

      await host.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        to: ["bob"],
        text: "secret for bob",
      });

      // 发送方与收件人可见
      expect(texts(await readHistory(host, aliceEp, conv.id))).toContain("secret for bob");
      expect(texts(await readHistory(host, bobEp, conv.id))).toContain("secret for bob");
      // 非收件人不可见
      expect(texts(await readHistory(host, carolEp, conv.id))).not.toContain("secret for bob");
    } finally {
      await host.close();
    }
  });

  it("history：mentions 参与投递集，carol 被 mentions 后可读", async () => {
    const { host } = await makeMesh();
    try {
      const aliceEp = await addSpeaker(host, "alice");
      const bobEp = await addSpeaker(host, "bob");
      const carolEp = await addSpeaker(host, "carol");
      const conv = await host.createConversation({
        type: "group",
        creator: "alice",
        members: ["bob", "carol"],
        config: { historyVisibility: "full" },
      });

      await host.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        to: ["bob"],
        mentions: ["carol"],
        text: "for bob and carol",
      });

      expect(texts(await readHistory(host, bobEp, conv.id))).toContain("for bob and carol");
      expect(texts(await readHistory(host, carolEp, conv.id))).toContain("for bob and carol");
    } finally {
      await host.close();
    }
  });

  it("history：未定向（to 空）消息仍对全体成员可见", async () => {
    const { host } = await makeMesh();
    try {
      const aliceEp = await addSpeaker(host, "alice");
      await addSpeaker(host, "bob");
      const carolEp = await addSpeaker(host, "carol");
      const conv = await host.createConversation({
        type: "group",
        creator: "alice",
        members: ["bob", "carol"],
        config: { historyVisibility: "full" },
      });

      await host.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        text: "everyone",
      });

      expect(texts(await readHistory(host, aliceEp, conv.id))).toContain("everyone");
      expect(texts(await readHistory(host, carolEp, conv.id))).toContain("everyone");
    } finally {
      await host.close();
    }
  });

  it("injectJoinHistory：新成员加入时定向消息不被注入", async () => {
    const { host, port } = await makeMesh();
    try {
      await addSpeaker(host, "alice");
      await addSpeaker(host, "bob");
      const carolEp = await addSpeaker(host, "carol");
      const conv = await host.createConversation({
        type: "group",
        creator: "alice",
        members: ["bob"],
        config: { historyVisibility: "full", maxHistoryOnJoin: 10 },
      });

      // 加入前：一条定向给 bob、一条广播
      await host.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        to: ["bob"],
        text: "bob's secret pre-join",
      });
      await host.send({
        from: "alice",
        conversationId: conv.id,
        kind: "chat",
        expect: "none",
        text: "public pre-join",
      });

      await host.addMember(conv.id, "carol", { by: "alice" });

      const blocks = port.delivered
        .filter((d) => d.endpointId === carolEp && d.rendered.includes(`<<<HISTORY kind="join">>>`))
        .map((d) => d.rendered);
      expect(blocks.length).toBe(1);
      expect(blocks[0]).toContain("public pre-join");
      expect(blocks[0]).not.toContain("bob's secret pre-join");
    } finally {
      await host.close();
    }
  });
});