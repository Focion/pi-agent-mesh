// ═══════════════════════════════════════════════════════════════════════════
// G04(a)（本地验收·真实 SDK + faux）：真实 mesh 工具在 durable session turn 内被调用。
//
// 保护的设计决定：用 pi-ai 的 fauxToolCall(...) 脚本化一次真实 tool_call，令 warm
// 端点的轮次真的执行 mesh_inbox（mesh 工具经 bridgeTools 注入 durable registry 的
// "pi-agent-mesh:mesh-tools" 扩展），执行结果写回会话的 pi.tool-result 条目。断言：
//  1. 工具真的跑完一个「工具循环」（faux 被调 ≥2 次：发起 + 收取工具结果的收尾），
//     且 warm 端点的真实 storage 里出现了 pi.tool-result 条目；
//  2. 结果合法且身份闭包正确——mesh_inbox 读的是 alice 自己的收件箱（含 ac⊳bob 会话），
//     故 tool-result 的序列化里出现该会话 id，证明读的不是空库或他人。
// 收尾跑完整不变量。durable 后端用「转录条目」替代旧 coding-agent 的扩展事件 spy。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionFactory } from "../../src/core/types.js";
import { createMesh, type MeshHost } from "../../src/index.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import type { DurableSession } from "../../src/pi/durable-runtime.js";
import type { Cursor } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createFaux, waitFor, type Faux } from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

/** 捕获 alice 的真实 DurableSession，供转录断言。 */
function wrapFactory(
  inner: SessionFactory,
  onSession: (session: DurableSession) => void,
): SessionFactory {
  return {
    async create(ctx) {
      const r = await inner.create(ctx);
      if (ctx.endpoint.accountId === "alice") onSession(r.session as DurableSession);
      return r;
    },
    async open(ctx) {
      const r = await inner.open(ctx);
      if (ctx.endpoint.accountId === "alice") onSession(r.session as DurableSession);
      return r;
    },
  };
}

/** 读会话全部条目（原始记录，含 model，供 pi.tool-result 内容断言）。 */
async function allEntries(session: DurableSession): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await session.root.entries({ order: "ascending" }, 1000, cursor, session.ctx);
    out.push(...(page.items as unknown as Array<Record<string, unknown>>));
    if (!page.next) break;
    cursor = page.next;
  }
  return out;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("G04(a): 真实 mesh 工具在 session turn 内被调用（真实 SDK + faux）", () => {
  it("warm 端点的轮次执行 mesh_inbox：落下 pi.tool-result 且身份闭包正确", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-tool-turn-"));
    const faux: Faux = await createFaux("faux-tool");
    // 首轮：真实 tool_call(mesh_inbox)；次轮：工具结果后的收尾文本。
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("mesh_inbox", { limit: 10 })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    let aliceSession: DurableSession | undefined;
    const inner = createPiSessionFactory({ stateDir: dir, models: faux.models, model: faux.model });
    const factory = wrapFactory(inner, (s) => (aliceSession = s));

    const host: MeshHost = await createMesh({
      dbPath: join(dir, "mesh.db"),
      policies: { sessionFactory: factory },
      devMode: true,
    });
    cleanup.push(() => host.close());
    cleanup.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });

    await host.registerAccount({
      id: "alice",
      displayName: "Alice",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    await host.registerAccount({
      id: "bob",
      displayName: "Bob",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    const aliceEp = await host.registerEndpoint({ accountId: "alice", topology: { kind: "unified" } });
    await host.registerEndpoint({ accountId: "bob", topology: { kind: "unified" } });
    await host.setPresence("alice", "available");
    await host.setPresence("bob", "available");
    const dc = await host.ensureDirect("alice", "bob");

    await host.warm(aliceEp.id, "shared");
    expect(aliceSession).toBeDefined();

    // bob 发消息 → 投递到 hot 的 alice → 真实轮次 → faux tool_call(mesh_inbox)。
    // expect:"reply" + to:[alice] ⇒ grade="steer"（direct 恒 tier 0），deliverAs:"steer"
    // 才起真实回合；warm 租约用 "shared"，避免 exclusive 租约令 mailbox 走 LEASE_HELD park。
    await host.send({
      from: "bob",
      conversationId: dc.id,
      kind: "chat",
      expect: "reply",
      to: ["alice"],
      text: "hello alice",
    });

    // 工具循环完成：faux 被调两次（发起 tool_use + 收取工具结果的收尾），
    // 且 alice 的真实 storage 里已落下 pi.tool-result 条目。
    await waitFor(async () => {
      if (!aliceSession) return false;
      const entries = await allEntries(aliceSession);
      return faux.callCount() >= 2 && entries.some((e) => e.kind === "pi.tool-result");
    });

    // ── 工具真的执行（非 spy 假象）：至少一条工具结果条目，且其序列化里含 alice 的唯一会话 ──
    const entries = await allEntries(aliceSession!);
    const toolResults = entries.filter((e) => e.kind === "pi.tool-result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    // 身份闭包正确：mesh_inbox 读的是 alice 的收件箱（含 dc 会话），而非空库或他人。
    expect(JSON.stringify(toolResults)).toContain(dc.id);

    await assertInvariants(host);
  });
});