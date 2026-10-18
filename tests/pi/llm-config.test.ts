// ═══════════════════════════════════════════════════════════════════════════
// llm-config 解析 / fail-fast / 指纹（W00-L3，纯逻辑，无 pi 无网络）。
// 保护的设计决定（LD4）：显式 apiKey 或显式 apiKeyEnv，绝不回退 pi 隐式
// env 表/ambient env；secret 永不进日志/事件/DB/配置指纹。
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import {
  MeshConfigError,
  configFingerprint,
  resolveLlmConfig,
  type LlmConfig,
  type ResolvedLlm,
  type RuntimeConfig,
} from "../../src/pi/llm-config.js";

const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ...extra,
});

describe("resolveLlmConfig：model / provider 解析", () => {
  it("缺 model / 空 / 无冒号 / 只 provider → MESH_BAD_CONFIG", () => {
    for (const model of [undefined as never, "", "no-colon", "anthropic:", ":claude-opus-5-5", " : x "]) {
      expect(() => resolveLlmConfig({ model }, env({ ANTHROPIC_AUTH_TOKEN: "ambient" }))).toThrow(MeshConfigError);
    }
  });

  it("内建 provider（providers 无该项）→ custom 不存在，凭据取顶层 apiKey", () => {
    const r = resolveLlmConfig({ model: "anthropic:claude-opus-5-5", apiKey: "sk-top" });
    expect(r.providerId).toBe("anthropic");
    expect(r.modelId).toBe("claude-opus-5-5");
    expect(r.custom).toBeUndefined();
    expect(r.credential).toEqual({ key: "sk-top", source: "apiKey" });
  });

  it("自定义 provider：缺 baseUrl → MESH_BAD_CONFIG；未知 api → MESH_BAD_CONFIG", () => {
    expect(() =>
      resolveLlmConfig({ model: "myllm:gpt", providers: { myllm: {} }, apiKey: "k" }),
    ).toThrow(/baseUrl/);
    expect(() =>
      resolveLlmConfig({
        model: "myllm:gpt",
        providers: { myllm: { baseUrl: "https://x/v1", api: "not-an-api" } },
        apiKey: "k",
      }),
    ).toThrow(/api "not-an-api" 未知/);
  });

  it("自定义 provider 合法 → custom 装配 + 缺省值填齐", () => {
    const r = resolveLlmConfig({
      model: "myllm:gpt-4-mini",
      providers: { myllm: { baseUrl: "https://api.example.com/v1", api: "openai-completions" } },
      apiKey: "k",
    });
    expect(r.custom).toEqual({
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      contextWindow: 128_000,
      maxTokens: 4096,
      reasoning: false,
    });
  });
});

describe("resolveLlmConfig：凭据 fail-fast（LD4）", () => {
  it("无 apiKey 也无 apiKeyEnv（即使 ambient env 存在）→ MESH_MISSING_CREDENTIAL", () => {
    // 关键：pi 会静默回退 ambient env，Mesh 必须在此拒绝，而不是放行给 pi。
    expect(() =>
      resolveLlmConfig({ model: "anthropic:claude-opus-5-5" }, env({ ANTHROPIC_AUTH_TOKEN: "ambient-key" })),
    ).toThrow(/MESH_MISSING_CREDENTIAL/);
  });

  it("apiKeyEnv 指定但环境变量未设 → MESH_MISSING_CREDENTIAL 且提及变量名", () => {
    try {
      resolveLlmConfig({ model: "anthropic:claude-opus-5-5", apiKeyEnv: "MY_API_KEY" }, env({}));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MeshConfigError);
      expect((e as MeshConfigError).code).toBe("MESH_MISSING_CREDENTIAL");
      expect((e as Error).message).toContain("MY_API_KEY");
    }
  });

  it("apiKeyEnv 命中 → 取环境变量值，source 记 env:NAME", () => {
    const r = resolveLlmConfig({ model: "anthropic:claude-opus-5-5", apiKeyEnv: "MY_API_KEY" }, env({ MY_API_KEY: "from-env" }));
    expect(r.credential).toEqual({ key: "from-env", source: "env:MY_API_KEY" });
  });

  it("优先级：providers.<id>.apiKey > 顶层 apiKey > providers.<id>.apiKeyEnv > 顶层 apiKeyEnv", () => {
    const cfg: LlmConfig = {
      model: "myllm:gpt",
      apiKey: "top-key",
      apiKeyEnv: "TOP_ENV",
      providers: { myllm: { baseUrl: "https://x/v1", apiKeyEnv: "PROV_ENV" } },
    };
    const e = env({ TOP_ENV: "top-env-val", PROV_ENV: "prov-env-val" });
    // 无 provider apiKey → 顶层 apiKey 胜出
    expect(resolveLlmConfig(cfg, e).credential).toEqual({ key: "top-key", source: "apiKey" });
    // 加 provider apiKey → provider 胜出
    const cfg2: LlmConfig = { ...cfg, providers: { myllm: { baseUrl: "https://x/v1", apiKey: "prov-key", apiKeyEnv: "PROV_ENV" } } };
    expect(resolveLlmConfig(cfg2, e).credential).toEqual({ key: "prov-key", source: "apiKey" });
    // 只留顶层 apiKeyEnv + provider apiKeyEnv → provider env 胜出
    const cfg3: LlmConfig = { model: "myllm:gpt", apiKeyEnv: "TOP_ENV", providers: { myllm: { baseUrl: "https://x/v1", apiKeyEnv: "PROV_ENV" } } };
    expect(resolveLlmConfig(cfg3, e).credential).toEqual({ key: "prov-env-val", source: "env:PROV_ENV" });
  });

  it("thinkingLevel 透传", () => {
    const r = resolveLlmConfig({ model: "anthropic:claude-opus-5-5", apiKey: "k", thinkingLevel: "high" });
    expect(r.thinkingLevel).toBe("high");
  });
});

describe("configFingerprint：稳定且剔除 secret（LD6 局部）", () => {
  const rt: RuntimeConfig = { builtinTools: [] };

  it("不同 secret 值（apiKey 直写 vs apiKeyEnv）→ 指纹相同", () => {
    const a: ResolvedLlm = {
      providerId: "anthropic", modelId: "claude-opus-5-5",
      credential: { key: "sk-secret-A", source: "apiKey" },
    };
    const b: ResolvedLlm = {
      providerId: "anthropic", modelId: "claude-opus-5-5",
      credential: { key: "sk-secret-B", source: "env:PROD_KEY" },
    };
    expect(configFingerprint(a, rt)).toBe(configFingerprint(b, rt));
    // 且不含任何 secret 字面量
    const fp = configFingerprint(a, rt);
    expect(fp).not.toContain("sk-secret-A");
    expect(fp).not.toContain("secret");
  });

  it("modelId / providerId / builtinTools / thinkingLevel 任一变化 → 指纹变化", () => {
    const base: ResolvedLlm = { providerId: "a", modelId: "m", credential: { key: "k", source: "apiKey" } };
    const fp = configFingerprint(base, { builtinTools: [] });
    expect(configFingerprint({ ...base, modelId: "m2" }, { builtinTools: [] })).not.toBe(fp);
    expect(configFingerprint({ ...base, providerId: "b" }, { builtinTools: [] })).not.toBe(fp);
    expect(configFingerprint({ ...base, thinkingLevel: "high" }, { builtinTools: [] })).not.toBe(fp);
    expect(configFingerprint(base, { builtinTools: ["read"] })).not.toBe(fp);
  });

  it("同一配置多次调用稳定", () => {
    const a: ResolvedLlm = { providerId: "a", modelId: "m", credential: { key: "k", source: "env:X" } };
    expect(configFingerprint(a, rt)).toBe(configFingerprint(a, rt));
  });
});