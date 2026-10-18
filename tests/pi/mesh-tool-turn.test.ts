// ═══════════════════════════════════════════════════════════════════════════
// G04(a)（本地验收·真实 SDK + faux）：真实 mesh 工具在 session turn 内被调用。
//
// 保护的设计决定（推翻 W00 探针时代的过时结论「faux 无法带工具端到端」）：
// 用 compat.fauxToolCall(...{stopReason:"tool_use"}) 脚本化一次真实 tool_call，
// 令 warm 端点的轮次真的执行 mesh_inbox（由 14 个 Mesh 工具经 customTools 注入），
// 而非 fake/spy。断言 tool_execution_start/end 点亮且 toolName==="mesh_inbox"、
// 结果合法 JSON 且能反映 makeToolContext 闭包绑定的账号身份（读到 alice 自己的
// 未读会话），并在收尾跑 16 条不变量。
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionFactory } from "../../src/core/types.js";
import { createMesh, type MeshHost } from "../../src/index.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import {
  createFaux,
  installExtensionHooks,
  loadFauxCompat,
  registerFauxInto,
  waitFor,
  type FauxCore,
} from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

interface ToolEvent {
  type: string;
  toolName?: unknown;
  toolCallId?: unknown;
  args?: unknown;
  result?: unknown;
  isError?: unknown;
}

interface ToolSpy {
  events: ToolEvent[];
  nameOf(type: string): string | undefined;
  resultFor(name: string): unknown;
}

function makeSpy(): ToolSpy {
  const spy: ToolSpy = {
    events: [],
    nameOf(type: string) {
      const e = this.events.find((x) => x.type === type);
      return typeof e?.toolName === "string" ? e.toolName : undefined;
    },
    resultFor(_name: string) {
      const e = this.events.find((x) => x.type === "tool_execution_end");
      return e?.result;
    },
  };
  return spy;
}

function installToolSpy(session: unknown, spy: ToolSpy): void {
  const record =
    (type: string) =>
    (event: unknown): undefined => {
      const e = event as Record<string, unknown>;
      spy.events.push({
        type,
        toolName: e.toolName,
        toolCallId: e.toolCallId,
        args: e.args,
        result: e.result,
        isError: e.isError,
      });
      return undefined;
    };
  installExtensionHooks(session, {
    tool_call: [record("tool_call")],
    tool_result: [record("tool_result")],
    tool_execution_start: [record("tool_execution_start")],
    tool_execution_end: [record("tool_execution_end")],
  });
}

/** 包装 createPiSessionFactory：建/开 session 后注入 faux provider 与工具钩子。 */
function wrapFactory(
  inner: SessionFactory,
  faux: FauxCore,
  spy: ToolSpy,
): SessionFactory {
  const hook = (session: unknown): void => {
    registerFauxInto(session, faux);
    installToolSpy(session, spy);
  };
  return {
    async create(ctx) {
      const r = await inner.create(ctx);
      hook(r.session);
      return r;
    },
    async open(ctx) {
      const r = await inner.open(ctx);
      hook(r.session);
      return r;
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("G04(a): 真实 mesh 工具在 session turn 内被调用（真实 SDK + faux）", () => {
  it("warm 端点的轮次执行 mesh_inbox：tool_execution_* 点亮且身份闭包正确", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-tool-turn-"));
    const faux = await createFaux("faux-tool");
    const compat = await loadFauxCompat();
    // 首轮：真实 tool_call(mesh_inbox)；次轮：工具结果后的收尾文本。
    faux.setResponses([
      compat.fauxAssistantMessage([compat.fauxToolCall("mesh_inbox", { limit: 10 })], {
        stopReason: "tool_use",
      }),
      compat.fauxAssistantMessage("done"),
    ]);

    const spy = makeSpy();
    const inner = createPiSessionFactory({
      stateDir: dir,
      agentDir: dir,
      model: faux.getModel(),
      tools: [], // 只禁内建；mesh 工具恒经 customTools 注入（L5）
    });
    const factory = wrapFactory(inner, faux, spy);

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
    await waitFor(() => spy.events.some((e) => e.type === "tool_execution_end"));

    // ── 工具确实被调（非 spy 假象）──
    expect(spy.nameOf("tool_execution_start")).toBe("mesh_inbox");
    expect(spy.nameOf("tool_execution_end")).toBe("mesh_inbox");
    expect(spy.events.some((e) => e.type === "tool_call")).toBe(true);
    expect(spy.events.some((e) => e.type === "tool_result")).toBe(true);

    // ── 结果合法 JSON，且身份闭包读到 alice 自己的未读会话 ──
    const endEvent = spy.events.find((e) => e.type === "tool_execution_end")!;
    expect(endEvent.isError).toBe(false);
    // pi 边界桥接（session-factory.asPiCustomTools）把 mesh 的 {content:string} 归一成
    // 单段文本块数组；此处还原那一段 JSON 文本来校验工具面与身份闭包。
    const content = (endEvent.result as { content?: unknown } | undefined)?.content;
    const blockText = Array.isArray(content)
      ? ((content[0] as { text?: string } | undefined)?.text)
      : typeof content === "string"
        ? content
        : undefined;
    expect(typeof blockText).toBe("string");
    const parsed = JSON.parse(blockText as string) as {
      conversations: Array<{ conversationId?: string }>;
      awaitingMyAck: unknown;
    };
    expect(Array.isArray(parsed.conversations)).toBe(true);
    expect(Array.isArray(parsed.awaitingMyAck)).toBe(true);
    // 身份正确：mesh_inbox 读的是 alice 的收件箱（含 dc 会话），而非空库或他人。
    expect(parsed.conversations.map((c) => c.conversationId)).toContain(dc.id);

    // ── mes 工具确在白名单内（L5：tools:[] 只禁内建）──
    await assertInvariants(host);
  });
});