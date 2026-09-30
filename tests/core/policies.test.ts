// ═══════════════════════════════════════════════════════════════════════════
// 策略与渲染器的纯单元测试：规模档位列（§7.2/F.1）、M4 定界符转义（§10.3 防线 1）、
// 包裹校验（§23.7）。補角度④ 的 ④-E / ④-I。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { memberTier } from "../../src/core/policies.js";
import {
  DefaultRenderer,
  escapeDelims,
  verifyWrapped,
} from "../../src/core/renderer.js";
import type { Envelope } from "../../src/core/types.js";

describe("memberTier（§7.2 规模列 / F.1 groupTiers 语义）", () => {
  const tiers = [3, 8, 30] as [number, number, number];

  it("direct ≤2 → 0", () => {
    expect(memberTier(1, tiers)).toBe(0);
    expect(memberTier(2, tiers)).toBe(0);
  });

  it("小群 3–8 → 1（上界是 tiers[1]，不是 tiers[0]）", () => {
    expect(memberTier(3, tiers)).toBe(1);
    expect(memberTier(4, tiers)).toBe(1);
    expect(memberTier(8, tiers)).toBe(1);
  });

  it("中群 9–30 → 2（上界是 tiers[2]）", () => {
    expect(memberTier(9, tiers)).toBe(2);
    expect(memberTier(10, tiers)).toBe(2);
    expect(memberTier(30, tiers)).toBe(2);
  });

  it("大群 30+ → 3", () => {
    expect(memberTier(31, tiers)).toBe(3);
    expect(memberTier(100, tiers)).toBe(3);
  });
});

describe("Renderer M4 定界符转义（§10.3 防线 1，④-I/④-B）", () => {
  const r = new DefaultRenderer();
  const env = (over: Partial<Envelope>): Envelope =>
    ({
      id: "m1",
      seq: 1,
      conversationId: "c1",
      from: "alice",
      kind: "chat",
      expect: "none",
      priority: "normal",
      routedAt: "2024-01-01T00:00:00Z",
      payload: { text: "hi" },
      ...over,
    }) as Envelope;

  it("发送方可控的 ts/name 含 <<< / >>> 时仍只产生一个开标签", () => {
    // logicalTs 是发送方可控（router 直通 input.logicalTs），name 是显示名
    const out = r.renderMessage(
      env({ logicalTs: "2024<<<x>>>", payload: { text: "body has <<<nested>>> too" } }),
      { recipient: { endpointClass: "stream" } as never, senderName: "evil<<<name" },
    );
    expect(out.split("<<<MSG").length - 1).toBe(1);
    expect(verifyWrapped(out).ok).toBe(true);
    // 正文与属性值里的定界符合并转义为 \x3c… 形式，不残留裸 <<< / >>>
    expect(out).toContain("\\x3c\\x3c\\x3c");
    expect(out).toContain("\\x3e\\x3e\\x3e");
  });

  it("escapeDelims 同时转义 <<< 与 >>>", () => {
    expect(escapeDelims("a<<<b>>>c")).toBe("a\\x3c\\x3c\\x3cb\\x3e\\x3e\\x3ec");
  });

  it("verifyWrapped：未包裹文本在 devMode 下应被检出（生产强制加壳）", () => {
    const bad = "no wrapper at all";
    const check = verifyWrapped(bad);
    expect(check.ok).toBe(false);
    expect(check.fixed).toContain("<<<MSG");
    expect(check.fixed).toContain("<<<END MSG>>>");
  });

  it("verifyWrapped：正常包裹体 ok", () => {
    const good = r.renderMessage(env({}), {
      recipient: { endpointClass: "stream" } as never,
      senderName: "bob",
    });
    expect(verifyWrapped(good).ok).toBe(true);
  });
});