// ═══════════════════════════════════════════════════════════════════════════
// W01 探针 · P2 最终输入可确认性（§7.6 inboxInjection / markInjectedDelivered）。
//
// 设计问题：P2 注入体（injectContext 经 pi 扩展的 context 钩子）能否被「观测」
// 确认进入了交给模型的最终输入？这决定 W08 的 P2 确认点选在哪里。
//
// 实测机制（pi 1.1.0，读 dist/core/extensions/runner.js + core/sdk.js）：
//  - Agent.transformContext → runner.emitContext(messages)。emitContext 两阶段：
//    ① 每个 "context" 处理器只看非 system 消息，返回/原地改后可注入新消息，
//       Pi 用 restoreSystemMessages 把 system 前缀重新钉回最前；
//    ② 每个 "context_with_system" 处理器看到「全部 context 处理完 + system 已恢复」
//       的完整 transcript，其输出原样作为模型输入。
//  - 即：后一个 hook 能看见前一个 hook 的注入体 ⇒ 最终输入可确认。
//
// 结论在此固化：可确认（context_with_system 是最终输入确认点）。若变红则结论降级。
// ═══════════════════════════════════════════════════════════════════════════

import { afterEach, describe, expect, it } from "vitest";
import {
  createPiTestSession,
  installExtensionHooks,
  loadFauxCompat,
  waitFor,
  type PiTestSession,
} from "../helpers/pi-session.js";

const SENTINEL = "P2-INBOX-SENTINEL-42";

let t: PiTestSession | undefined;
afterEach(() => {
  t?.dispose();
  t = undefined;
});

/** 复刻 stream-port.injectContext 的注入 handler（mesh.inbox custom 消息）。 */
function inboxInjection(text: string) {
  return (event: { messages: unknown[] }) => ({
    messages: [
      ...event.messages,
      {
        role: "custom",
        customType: "mesh.inbox",
        content: [{ type: "text", text }],
        display: false,
        timestamp: Date.now(),
      },
    ],
  });
}

const messagesText = (msgs: unknown[]): string => JSON.stringify(msgs);

describe("probe P2：注入体是否可确认进入最终模型输入", () => {
  it("context 注入 → context_with_system 观测到注入体（最终输入可确认）", async () => {
    const compat = await loadFauxCompat();
    const observed: unknown[][] = [];
    t = await createPiTestSession([compat.fauxAssistantMessage("ok")]);

    // 注入点（先挂）与观测点（后挂）：同一 extensions 数组按序执行
    installExtensionHooks(t.session, { context: [inboxInjection(SENTINEL)] }, "probe:inject");
    installExtensionHooks(
      t.session,
      {
        context_with_system: [
          (event: { messages: unknown[] }) => {
            observed.push(event.messages);
            return undefined;
          },
        ],
      },
      "probe:observe",
    );

    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "wake", display: true },
      { triggerTurn: true },
    );
    await waitFor(() => t!.session.isIdle);

    // 至少一轮模型调用，观测点被点亮
    expect(observed.length).toBeGreaterThan(0);
    // 注入体出现在最终 transcript（经 context_with_system 观测）
    expect(messagesText(observed)).toContain(SENTINEL);
    // 注入体以 mesh.inbox 的「custom 消息」形态存在于最终 transcript（可被按序定位确认）
    const inbox = observed[0]!.filter(
      (m) => (m as { customType?: string })?.customType === "mesh.inbox",
    );
    expect(inbox).toHaveLength(1);
    expect((inbox[0]! as { role?: string }).role).toBe("custom");
  });

  it("空转（无起轮）不产生模型调用 ⇒ 注入体无从确认（确认点绑定真实 LLM 调用）", async () => {
    t = await createPiTestSession();
    installExtensionHooks(t.session, { context: [inboxInjection(SENTINEL)] }, "probe:inject");
    let fired = 0;
    installExtensionHooks(
      t.session,
      { context_with_system: [() => { fired++; return undefined; }] },
      "probe:observe",
    );
    // 仅 append 一条自定义条目、不起轮（π 的 F1 档）
    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "queued", display: true },
      {},
    );
    expect(fired).toBe(0);
    expect(t.faux.state.callCount).toBe(0);
  });
});