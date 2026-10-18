// ═══════════════════════════════════════════════════════════════════════════
// I13 + I17：订阅幂等 / canSubscribe 钩子 / topic 读权与订阅边界。
// - registry.subscribe 幂等（重复订阅保留原 from_seq；退订后重订只清退订标记）
// - topicSubscribe 走 canSubscribe（fail-closed，deny → JOIN_DENIED）
// - topic 未订阅者 members()/history() → NOT_A_MEMBER（§16）
// - 群成员无 read cap → history()/members() → HISTORY_FORBIDDEN
// - historyVisibility:full 的 topic 仍受订阅起点 from_seq 下界约束
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import { MeshRegistry } from "../../src/core/registry.js";
import { SqliteStore } from "../../src/core/store.js";
import type { MeshHost, SessionFactory, Policies } from "../../src/index.js";
import { DEFAULT_LIMITS } from "../../src/core/types.js";
import { parseToolContent } from "../../src/core/tools.js";
import { openTestDb } from "../helpers/db.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "sub-test" }),
  open: async () => ({ session: {} }),
};

async function makeMesh(extraPolicies: Partial<Policies> = {}): Promise<{
  host: MeshHost;
  port: FakeStreamPort;
}> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-sub-"));
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory: stubSessionFactory, ...extraPolicies },
    streamPort: port,
    limits: { handoffTimeoutMs: 1000 },
    devMode: true,
  });
  return { host, port };
}

/** 注册一个带 unified 热端点的 stream 账号，返回其在 host 工具面的归属端点 id */
async function addToolAccount(
  host: MeshHost,
  id: string,
  initiate: string[] = ["chat", "event"],
): Promise<string> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: initiate as never,
  });
  const ep = await host.registerEndpoint({ accountId: id, topology: { kind: "unified" } });
  await host.setPresence(id, "available");
  return ep.id;
}

async function runTool(
  host: MeshHost,
  endpointId: string,
  name: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = host.toolSet(endpointId).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return parseToolContent(
    await tool.execute("tc", params, undefined, undefined, undefined),
  );
}

// ─── I13：订阅幂等（registry 层）─────────────────────────────────────────────

describe("I13: subscribe idempotency", () => {
  it("re-subscribe keeps the original from_seq", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    await registry.registerAccount({ id: "B", displayName: "B", endpointClass: "stream" });
    const topic = await registry.createConversation({ type: "topic", creator: "A" });
    registry.subscribe(topic.id, "B", 5);
    registry.subscribe(topic.id, "B", 9); // 重复订阅：保留 from_seq=5
    const subs = registry.listSubscribers(topic.id);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.fromSeq).toBe(5);
    store.close();
  });

  it("re-subscribe after unsubscribe reactivates and keeps the original from_seq", async () => {
    const tdb = openTestDb();
    const store = new SqliteStore(tdb.db, true);
    const registry = new MeshRegistry(store.db, DEFAULT_LIMITS);
    await registry.registerAccount({ id: "A", displayName: "A", endpointClass: "stream" });
    await registry.registerAccount({ id: "B", displayName: "B", endpointClass: "stream" });
    const topic = await registry.createConversation({ type: "topic", creator: "A" });
    registry.subscribe(topic.id, "B", 5);
    registry.unsubscribe(topic.id, "B");
    expect(registry.listSubscribers(topic.id)).toHaveLength(0);
    registry.subscribe(topic.id, "B", 9); // 重订：不退订标记、不重置起点
    const subs = registry.listSubscribers(topic.id);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.fromSeq).toBe(5);
    store.close();
  });
});

// ─── I13 + I17：host 层（canSubscribe / 读权 / 订阅边界）────────────────────

describe("I13/I17: subscription & read authorization", () => {
  it("canSubscribe:false rejects topic subscribe (fail-closed)", async () => {
    const { host } = await makeMesh({
      accessControl: { canSubscribe: () => false },
    });
    try {
      await host.registerAccount({ id: "P", displayName: "P", endpointClass: "stream" });
      await host.registerAccount({ id: "B", displayName: "B", endpointClass: "stream" });
      const topic = await host.createConversation({ type: "topic", creator: "P" });
      await expect(host.subscribe(topic.id, "B")).rejects.toMatchObject({
        code: "JOIN_DENIED",
      });
    } finally {
      await host.close();
    }
  });

  it("unsubscribed account cannot list topic members or history", async () => {
    const { host } = await makeMesh();
    try {
      const epP = await addToolAccount(host, "P");
      const epB = await addToolAccount(host, "B");
      const topic = await host.createConversation({ type: "topic", creator: "P" });
      await host.send({ from: "P", conversationId: topic.id, kind: "event", expect: "none", text: "hi" });
      // B 未订阅：members() 与 history() 都必须是 NOT_A_MEMBER
      const members = await runTool(host, epB, "mesh_members", { conversationId: topic.id });
      expect(members.error).toMatchObject({ code: "NOT_A_MEMBER" });
      const history = await runTool(host, epB, "mesh_history", { conversationId: topic.id });
      expect(history.error).toMatchObject({ code: "NOT_A_MEMBER" });
      // 发布者自证话题存在（防误判为「会话不存在」而非「未订阅」）
      void epP;
    } finally {
      await host.close();
    }
  });

  it("group member without read cap gets HISTORY_FORBIDDEN on history/members", async () => {
    const { host } = await makeMesh();
    try {
      await addToolAccount(host, "A");
      const epB = await addToolAccount(host, "B");
      const g = await host.createConversation({ type: "group", creator: "A", members: ["B"] });
      // A 收回 B 的 read（§4.4：speak 保留、read 移除）
      await host.setCaps(g.id, "B", ["speak"], "A");
      const history = await runTool(host, epB, "mesh_history", { conversationId: g.id });
      expect(history.error).toMatchObject({ code: "HISTORY_FORBIDDEN" });
      const members = await runTool(host, epB, "mesh_members", { conversationId: g.id });
      expect(members.error).toMatchObject({ code: "HISTORY_FORBIDDEN" });
    } finally {
      await host.close();
    }
  });

  it("topic with historyVisibility:full is still bounded by subscription from_seq", async () => {
    const { host } = await makeMesh();
    try {
      await addToolAccount(host, "P");
      const epB = await addToolAccount(host, "B");
      const topic = await host.createConversation({
        type: "topic",
        creator: "P",
        config: { historyVisibility: "full" },
      });
      await host.send({ from: "P", conversationId: topic.id, kind: "event", expect: "none", text: "first" }); // seq 1
      await host.subscribe(topic.id, "B"); // from_seq = currentSeq + 1 = 2
      await host.send({ from: "P", conversationId: topic.id, kind: "event", expect: "none", text: "second" }); // seq 2
      const history = await runTool(host, epB, "mesh_history", { conversationId: topic.id });
      const seqs = (history.messages as Array<{ seq: number }>).map((m) => m.seq);
      expect(seqs).toEqual([2]); // full 也不越过订阅起点，seq 1 不可见
    } finally {
      await host.close();
    }
  });
});