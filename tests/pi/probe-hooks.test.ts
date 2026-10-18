// ═══════════════════════════════════════════════════════════════════════════
// W01 探针 · pi 1.1.0 hook 覆盖矩阵（供 W08 选上下文确认点、W11 选轮次归因点）。
//
// 两条事件体系一并探明：
//  A. session.subscribe 会话事件（stream-port 现在依赖的：message_end/turn_end/
//     agent_settled/entry_appended，F 系列契约测试也断言 agent_start/turn_start/
//     turn_end/agent_end）。
//  B. 扩展钩子（extensionRunner.extensions[].handlers，stream-port.injectContext
//     与 probe-p2-input 同机制）：context / context_with_system / before_agent_start
//     / agent_start / agent_end / agent_before_settle / agent_settled / turn_* /
//     message_* / before_provider_* / after_provider_response / provider_stream_event
//     / tool_execution_* / tool_call / tool_result。
//
// 覆盖矩阵本身是事实记录（哪个钩子在哪个场景点不点亮）；关键确认点用断言钉死，
// 变红即意味着 pi 升级后某确认点消失，需回 W08/W11 重选。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPiSdk } from "../../src/pi/pi-sdk.js";
import {
  createFaux,
  createPiTestSession,
  installExtensionHooks,
  loadFauxCompat,
  registerFauxInto,
  waitFor,
  type PiTestSession,
} from "../helpers/pi-session.js";

let t: PiTestSession | undefined;
afterEach(() => {
  t?.dispose();
  t = undefined;
});

/** 注册一整套扩展钩子 spy：记录每事件是否触发 + 首条事件的顶层键。 */
function installSpy(session: any, eventNames: string[]) {
  const fired = new Set<string>();
  const keys: Record<string, string[]> = {};
  const handlers: Record<string, Array<(event: any) => unknown>> = {};
  for (const name of eventNames) {
    handlers[name] = [
      (event: any) => {
        fired.add(name);
        if (!keys[name]) keys[name] = Object.keys(event ?? {}).sort();
        return undefined;
      },
    ];
  }
  installExtensionHooks(session, handlers, "probe:spy");
  return { fired, keys };
}

describe("probe hook 覆盖矩阵 A：单轮（faux 文本回复，无 tool call）", () => {
  it("会话事件与扩展钩子的触发矩阵符合 1.1.0 实测", async () => {
    const compat = await loadFauxCompat();
    t = await createPiTestSession([compat.fauxAssistantMessage("ok")]);
    const spy = installSpy(t.session, [
      "context",
      "context_with_system",
      "before_agent_start",
      "agent_start",
      "agent_end",
      "agent_before_settle",
      "agent_settled",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "before_provider_request",
      "after_provider_response",
      "provider_stream_event",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "tool_call",
      "tool_result",
      "input",
    ]);

    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "wake", display: true },
      { triggerTurn: true },
    );
    await waitFor(() => t!.session.isIdle);

    // ── 会话事件（session.subscribe）──
    const sessionTypes = new Set(t.events.map((e) => e.type));
    // stream-port 与 W11 依赖的归因/镜像点：普通起轮全点亮
    for (const expected of ["agent_start", "turn_start", "turn_end", "agent_end", "agent_settled", "message_start", "message_end"]) {
      expect(sessionTypes.has(expected), `session.subscribe 应触发 ${expected}`).toBe(true);
    }
    // entry_appended 不覆盖 sendCustomMessage 普通起轮：它只在工具上下文的
    // appendCustomEntry、boundary drafts 等路径发出（§8.4 镜像对 deliver 路径的
    // 触发点是 message_end(custom)/turn_end/agent_settled，不是 entry_appended）。
    expect(sessionTypes.has("entry_appended")).toBe(false);

    // ── 扩展钩子：必须点亮的确认点 ──
    for (const expected of ["context", "context_with_system", "agent_start", "agent_end", "agent_before_settle", "agent_settled", "turn_start", "turn_end", "message_start", "message_end"]) {
      expect(spy.fired.has(expected), `扩展钩子应触发 ${expected}`).toBe(true);
    }
    // before_agent_start 只走「用户 prompt 提交」路径（sendUserMessage/prompt）；
    // mesh 的投递走 sendCustomMessage + triggerTurn，不经该路径（I19 禁 sendUserMessage）。
    expect(spy.fired.has("before_agent_start")).toBe(false);
    // payload 形状钉死（供 W08/W11 选点；变红即契约漂移）
    expect(spy.keys["context"]).toEqual(["messages", "type"]);
    expect(spy.keys["context_with_system"]).toEqual(["messages", "type"]);
    expect(spy.keys["turn_start"]).toEqual(["timestamp", "turnIndex", "type"]);
    expect(spy.keys["turn_end"]).toEqual(
      expect.arrayContaining(["type", "turnIndex", "message", "toolResults", "messageEntryId", "toolResultEntryIds"]),
    );
    expect(spy.keys["agent_settled"]).toEqual(["aborted", "type"]);
    // message_end 是 §8.4 镜像触发点之一，载荷含 message
    expect(spy.keys["message_end"]).toEqual(expect.arrayContaining(["message"]));

    // ── 提供者 HTTP 路径钩子（faux streamSimple 的精确矩阵）──
    //  - before_provider_request：走 prepareRequest/HTTP 才点亮，faux streamSimple 直连不点亮。
    //  - after_provider_response：onResponse 包装流也执行，故 faux 下仍点亮。
    //  - provider_stream_event：只对「解析后的 provider 原始流事件」点亮；faux 直接产出整条
    //    assistant 消息、无原始 SSE 事件，不点亮。
    expect(spy.fired.has("after_provider_response")).toBe(true);
    expect(spy.fired.has("before_provider_request")).toBe(false);
    expect(spy.fired.has("provider_stream_event")).toBe(false);
    // ── tool 钩子：无 tool call 场景不点亮 ──
    for (const absent of ["tool_execution_start", "tool_execution_end"]) {
      expect(spy.fired.has(absent)).toBe(false);
    }
  });
});

// ─── 覆盖矩阵 B：tool call 场景 ─────────────────────────────────────────────

/** 带一个 mesh 形自定义工具的会话（noTools 直禁内建、白名单进 probe_tool）。 */
async function makeToolSession(responses: unknown[]): Promise<PiTestSession> {
  const pi = await loadPiSdk();
  const faux = await createFaux("faux-tool");
  faux.setResponses(responses);
  const dir = mkdtempSync(join(tmpdir(), "pi-mesh-probe-tool-"));
  const sm = pi.SessionManager.inMemory(dir);
  const tool = {
    name: "probe_tool",
    label: "Probe tool",
    description: "探针工具（只确认 tool_execution_* 钩子）",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "probe result" }),
  };
  const { session } = await pi.createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel() as never,
    // noTools:"all" 会连 customTools 也禁掉；要得到「只有 probe_tool」用白名单（L5）。
    tools: ["probe_tool"],
    customTools: [tool] as never,
    sessionManager: sm,
  });
  registerFauxInto(session, faux);
  const events: PiTestSession["events"] = [];
  session.subscribe((e: { type: string }) => events.push(e));
  return {
    pi,
    session,
    sm,
    faux,
    dir,
    events,
    dispose() {
      try {
        session.dispose();
      } catch {
        // dispose 竞态不阻断清理
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("probe hook 覆盖矩阵 B：tool call 场景", () => {
  it("tool_execution_start/update/end 与 tool_call/tool_result 点亮", async () => {
    const compat = await loadFauxCompat();
    t = await makeToolSession([
      compat.fauxAssistantMessage([compat.fauxToolCall("probe_tool", {})], { stopReason: "tool_use" }),
      compat.fauxAssistantMessage("done"),
    ]);
    const spy = installSpy(t.session, [
      "tool_call",
      "tool_result",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "agent_start",
      "agent_end",
    ]);

    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "do the thing", display: true },
      { triggerTurn: true },
    );
    await waitFor(() => t!.session.isIdle);

    expect(spy.fired.has("tool_call")).toBe(true);
    expect(spy.fired.has("tool_execution_start")).toBe(true);
    expect(spy.fired.has("tool_execution_end")).toBe(true);
    expect(spy.fired.has("tool_result")).toBe(true);
    expect(spy.keys["tool_execution_start"]).toEqual(
      expect.arrayContaining(["toolCallId", "toolName", "args"]),
    );
    expect(spy.keys["tool_execution_end"]).toEqual(
      expect.arrayContaining(["toolCallId", "toolName", "result", "isError"]),
    );
  });
});