// ═══════════════════════════════════════════════════════════════════════════
// pi 契约测试 CT-F1..F5（§23.5）。
//
// 这一层不是验证库对，而是验证「库所依赖的 pi 实现细节仍然成立」。
// 每条测试的注释写明它保护的设计决定；pi 升版本后这里红一条，
// 含义是那条假设失效，必须回 §2.3 重审对应设计，而不是改测试迁就。
// ═══════════════════════════════════════════════════════════════════════════

import { afterEach, describe, expect, it } from "vitest";
import {
  createPiTestSession,
  customEntries,
  loadFauxCompat,
  waitFor,
  type PiTestSession,
} from "../helpers/pi-session.js";

let t: PiTestSession | undefined;
afterEach(() => {
  t?.dispose();
  t = undefined;
});

describe("pi contract CT-F1: 入队式追加（不带 triggerTurn）永不触发轮次", () => {
  // 保护：§7.1 三档（steer/followUp/silent），F1 —— nextTurn 不是第四档。
  // 变红意味着：出现了第四种注入时机，必须重审 §7.2 档位映射矩阵。
  it("idle + 无 triggerTurn：落盘、不起轮、保持空闲", async () => {
    t = await createPiTestSession();
    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "queued", display: true },
      {},
    );
    const turnEvents = t.events.filter((e) =>
      ["agent_start", "turn_start", "turn_end", "agent_end"].includes(e.type),
    );
    expect(turnEvents).toHaveLength(0);
    expect(t.session.isIdle).toBe(true);
    expect(customEntries(t.sm)).toHaveLength(1);
    // faux provider 一次都没被调（无 LLM 调用 = 无成本）
    expect(t.faux.state.callCount).toBe(0);
  });
});

describe("pi contract CT-F2: 轮次结束/安定事件无可用载荷", () => {
  // 保护：§7.9 consumed 靠 entry_appended + turn_end 归因（F2）。
  // 变红意味着：可以简化归因——但在本测试变绿前不得简化。
  it("agent_settled 除 type 外无任何字段，无法据它归因『哪条消息被消费』", async () => {
    const compat = await loadFauxCompat();
    t = await createPiTestSession([compat.fauxAssistantMessage("ok")]);
    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "wake", display: true },
      { triggerTurn: true },
    );
    const settled = t.events.filter((e) => e.type === "agent_settled");
    expect(settled.length).toBeGreaterThan(0);
    for (const s of settled) {
      expect(Object.keys(s)).toEqual(["type"]);
    }
  });
});

describe("pi contract CT-F3: clearQueue 销毁未落盘的自定义条目，且队列深度看不见它们", () => {
  // 保护：I22 的 beforeClearQueue 协议 + hasEntries 存在性核对 + 库自持 inFlight（§7.8，F3）。
  // 变红意味着：beforeClearQueue 可能不再必要；核对仍应保留。
  it("streaming 中 steer 的自定义条目：pendingMessageCount=0，clearQueue 后永不落盘", async () => {
    const compat = await loadFauxCompat();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t = await createPiTestSession([
      async () => {
        await gate;
        return compat.fauxAssistantMessage("slow");
      },
    ]);
    const turn = t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "wake", display: true },
      { triggerTurn: true },
    );
    await waitFor(() => t!.session.isStreaming);

    // 流忙时 steer：进 pi 的内存队列，尚未落 JSONL（§2.2① 的内存窗口）
    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "queued", display: true, details: { envelopeId: "envQ" } },
      { deliverAs: "steer" },
    );
    // F3：SDK 的队列深度对自定义条目是盲的 —— 背压必须走库自持计数
    expect(t.session.pendingMessageCount).toBe(0);
    expect(
      customEntries(t.sm).some((e: any) => e.details?.envelopeId === "envQ"),
    ).toBe(false);

    t.session.clearQueue();
    release();
    await turn;
    await waitFor(() => t!.session.isIdle);

    // 被 clearQueue 销毁：settle 之后也没有落盘（I22 核对必须能发现它不在）
    expect(
      customEntries(t.sm).some((e: any) => e.details?.envelopeId === "envQ"),
    ).toBe(false);
  });
});

describe("pi contract CT-F4: 扩展层只有 getEntry/getEntries/buildContextEntries，SessionEntry 无 seq", () => {
  // 保护：§8.4③ hasEntries「按 id 逐条问」的实现（F4）。
  // 变红意味着：出现了批量查询 API，恢复核对可以改快，但语义必须等价。
  it("查询面形状不变；条目无 seq 字段", async () => {
    t = await createPiTestSession();
    expect(typeof t.sm.getEntry).toBe("function");
    expect(typeof t.sm.getEntries).toBe("function");
    expect(typeof t.sm.buildContextEntries).toBe("function");
    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "x", display: true },
      {},
    );
    for (const e of t.sm.getEntries()) {
      expect(e).not.toHaveProperty("seq");
    }
  });
});

describe("pi contract CT-F5: 只有「空闲」两分支是返回即落盘", () => {
  // 保护：§7.9① delivered 的判据是 entry_appended 而非 deliver resolve（F5），
  //        以及 handoffTimeoutMs 的存在理由（交接窗口）。
  // 变红意味着：交接窗口与 handoff 超时可能可以取消。
  it("空闲+起轮 / 空闲+不起轮：resolve 时已落盘；忙流 steer：resolve 时未落盘", async () => {
    const compat = await loadFauxCompat();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t = await createPiTestSession([
      compat.fauxAssistantMessage("fast"), // 分支二（空闲+起轮）用
      async () => {
        await gate;
        return compat.fauxAssistantMessage("slow");
      }, // 分支三（忙流 steer 的底层轮次）用
    ]);

    // 分支一：空闲 + 不起轮 → 返回即落盘
    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "a", display: true, details: { envelopeId: "envA" } },
      {},
    );
    expect(customEntries(t.sm).some((e: any) => e.details?.envelopeId === "envA")).toBe(true);

    // 分支二：空闲 + 起轮 → 返回即落盘（且真的起了一轮）
    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "b", display: true, details: { envelopeId: "envB" } },
      { triggerTurn: true },
    );
    expect(customEntries(t.sm).some((e: any) => e.details?.envelopeId === "envB")).toBe(true);

    // 分支三：忙流 + steer → resolve 时条目还不存在（F5 的交接窗口）
    const turn = t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "c", display: true, details: { envelopeId: "envC" } },
      { triggerTurn: true },
    );
    await waitFor(() => t!.session.isStreaming);
    await t.session.sendCustomMessage(
      { customType: "mesh.msg", content: "d", display: true, details: { envelopeId: "envD" } },
      { deliverAs: "steer" },
    );
    expect(customEntries(t.sm).some((e: any) => e.details?.envelopeId === "envD")).toBe(false);
    release();
    await turn;
  });
});
