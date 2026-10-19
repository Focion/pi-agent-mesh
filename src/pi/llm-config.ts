// ═══════════════════════════════════════════════════════════════════════════
// llm-config：Mesh 统一 LLM 配置的解析与 fail-fast（W00-L3）。
//
// 设计依据：规范 §12.1（装配入口）与 §12.6 ⑦（LLM 与运行时配置类型）。
//   原始设计稿已归档：.agents/notes/archive/2026-10-13-mesh-llm-config-design.md
// 分层边界：本模块属于 mesh-pi（可依赖 core 的 util），公共类型只在此与
// src/index.ts 导出，不进 src/core/types.ts —— core 保持 LLM 盲（M1/M2）。
//
// 职责：
//  - 定义 LlmConfig / ProviderConfig / RuntimeConfig / Profile 配置 schema（LD4）
//  - resolveLlmConfig()：provider/model/凭据解析 + 同步 fail-fast（LD4：显式
//    apiKey 或显式 apiKeyEnv，绝不依赖 pi 隐式环境变量表/ambient env —— 实测定
//    性：pi 1.1.0 在无凭据时会静默回退 ANTHROPIC_AUTH_TOKEN 等 ambient env）
//  - configFingerprint()：对 {llm,runtime} 做稳定哈希且剔除 secret（LD6 局部）
// ═══════════════════════════════════════════════════════════════════════════

import { sha256Hex } from "../core/util.js";

// ─── 配置 schema（包根导出；不进 core）─────────────────────────────────────

/** 自定义 provider（Mesh 侧注册，不读 ~/.pi 的 models.json）。 */
export interface ProviderConfig {
  /** 请求端点；缺省时该 provider 视为内建 provider（走 pi 目录） */
  baseUrl?: string;
  /** API 适配器；缺省 "openai-completions"（OpenAI 兼容端点最常用） */
  api?: string;
  /** 显式密钥（仅测试/传输链路；不落盘、不进日志） */
  apiKey?: string;
  /** 显式环境变量名（生产首选）；Mesh 读它，不镜像 pi 的隐式 env 表 */
  apiKeyEnv?: string;
  /** 标准 Bearer 头（Authorization: Bearer <key>）；缺省 true；false 用 x-api-key */
  authHeader?: boolean;
  /** 额外请求头（自定义鉴权头等） */
  headers?: Record<string, string>;
  contextWindow?: number; // 缺省 128000
  maxTokens?: number; // 缺省 4096
  reasoning?: boolean; // 缺省 false
}

export interface LlmConfig {
  /** "providerId:modelId"（首个冒号切分） */
  model: string;
  /** 自定义 provider 表；未出现的 providerId 按 pi 内建目录解析 */
  providers?: Record<string, ProviderConfig>;
  thinkingLevel?: string;
  /** 顶层凭据（内建 provider 便捷）；优先级低于 providers.<id> */
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface RuntimeResources {
  /** 显式打开才继承（LD2：兼容开关只能显式打开）；缺省全部隔离 */
  extensions?: boolean;
  skills?: boolean;
  prompts?: boolean;
  themes?: boolean;
  contextFiles?: boolean;
}

export interface RuntimeConfig {
  /** 内建工具白名单；缺省 [] = 全禁内建（Mesh 工具恒经 customTools 注入，不受此白名单过滤） */
  builtinTools?: string[];
  /** pi 层重试/超时/压缩白名单（LD5）；语义与库自身 mailbox 折叠解耦 */
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxAgentDelayMs?: number };
  timeout?: number; // provider 请求超时（ms）
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  resources?: RuntimeResources;
}

/** 按 account.profileRef 选择（LD6）——本轮单 profile 主路径，多 profile 解析后续落地 */
export interface Profile {
  llm?: LlmConfig;
  runtime?: RuntimeConfig;
}

// ─── 解析结果 ─────────────────────────────────────────────────────────────

export interface ResolvedLlm {
  providerId: string;
  modelId: string;
  thinkingLevel?: string;
  /** 解析后的密钥（不进日志/事件/DB/指纹） */
  credential: { key: string; source: string };
  /** 存在即自定义 provider（Mesh 侧注册）；缺省按 pi 内建目录解析 */
  custom?: {
    baseUrl: string;
    api: string;
    headers?: Record<string, string>;
    authHeader?: boolean;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
  };
}

/** Mesh 配置/装配层的稳定错误码（W01 冻结：统一表；与 core 四族码分属两层，互不复用） */
export const MESH_ERROR_CODES = [
  "MESH_BAD_CONFIG",
  "MESH_MISSING_CREDENTIAL",
  "MESH_UNKNOWN_MODEL",
  "MESH_NO_SESSION_SOURCE",
] as const;
export type MeshConfigCode = (typeof MESH_ERROR_CODES)[number];

export class MeshConfigError extends Error {
  readonly code: MeshConfigCode;
  constructor(code: MeshConfigCode, message: string) {
    super(`[pi-agent-mesh] ${code}: ${message}`);
    this.name = "MeshConfigError";
    this.code = code;
  }
}

// pi-ai 已知的 API 适配器（镜像 demo 旧 config 的 KNOWN_APIS；registerProvider 会再校验一次）
const KNOWN_APIS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
  "pi-messages",
] as const;

const ENV = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const v = env[name];
  return v && v.trim() !== "" ? v : undefined;
};

function firstOrThrow<T>(items: ReadonlyArray<T | undefined>, make: () => MeshConfigError): T {
  for (const it of items) if (it !== undefined) return it;
  throw make();
}

/**
 * 解析一条 LlmConfig：provider/model 切分、自定义 provider 装配、凭据 fail-fast。
 * 同步：createMesh 在打开 DB 之前调用，配置非法即 reject，绝不半可用。
 */
export function resolveLlmConfig(
  llm: LlmConfig,
  env: Record<string, string | undefined> = process.env,
): ResolvedLlm {
  if (!llm || typeof llm.model !== "string" || llm.model.trim() === "") {
    throw new MeshConfigError("MESH_BAD_CONFIG", "llm.model 必填，形如 \"providerId:modelId\"");
  }
  const colon = llm.model.indexOf(":");
  const providerId = colon > 0 ? llm.model.slice(0, colon).trim() : "";
  const modelId = colon > 0 ? llm.model.slice(colon + 1).trim() : "";
  if (!providerId || !modelId) {
    throw new MeshConfigError(
      "MESH_BAD_CONFIG",
      `无法切分 llm.model "${llm.model}"（须形如 "providerId:modelId"）`,
    );
  }

  const providerConf = llm.providers?.[providerId];

  // ── 凭据（LD4）：providers.<id> > 顶层；显式 apiKey / apiKeyEnv，二者皆无反 fail-fast。
  // 实测（pi 1.1.0）：不 seed 显式凭据时 getAuth 会静默回退 ambient env（如 ANTHROPIC_AUTH_TOKEN），
  // 破坏 LD2 完全隔离，故这里必须拒绝而不是放行给 pi。
  let key = providerConf?.apiKey ?? llm.apiKey;
  let source = providerConf?.apiKey !== undefined ? "apiKey" : llm.apiKey !== undefined ? "apiKey" : "";
  if (key === undefined) {
    const envName = firstOrThrow(
      [providerConf?.apiKeyEnv, llm.apiKeyEnv],
      () =>
        new MeshConfigError(
          "MESH_MISSING_CREDENTIAL",
          `provider "${providerId}"（model "${modelId}"）缺少凭据：请设 llm.apiKey、llm.apiKeyEnv，` +
            `或 providers."${providerId}" 的 apiKey/apiKeyEnv（Mesh 不继承 ~/.pi 或 ambient env）`,
        ),
    );
    key = ENV(env, envName);
    if (key === undefined) {
      throw new MeshConfigError(
        "MESH_MISSING_CREDENTIAL",
        `provider "${providerId}" 指定了 apiKeyEnv="${envName}"，但环境变量未设置或为空`,
      );
    }
    source = `env:${envName}`;
  }
  if (typeof key !== "string" || key.trim() === "") {
    throw new MeshConfigError("MESH_MISSING_CREDENTIAL", `provider "${providerId}" 的 apiKey 为空`);
  }

  // ── 自定义 provider ─────────────────────────────────────────────────────
  let custom: ResolvedLlm["custom"];
  if (providerConf) {
    const baseUrl = providerConf.baseUrl?.trim() ?? "";
    if (!baseUrl) {
      throw new MeshConfigError(
        "MESH_BAD_CONFIG",
        `自定义 provider "${providerId}" 缺少 baseUrl（providers."${providerId}".baseUrl）`,
      );
    }
    const api = providerConf.api ?? "openai-completions";
    if (!(KNOWN_APIS as readonly string[]).includes(api)) {
      throw new MeshConfigError(
        "MESH_BAD_CONFIG",
        `自定义 provider "${providerId}" 的 api "${api}" 未知。可用: ${KNOWN_APIS.join(", ")}`,
      );
    }
    custom = {
      baseUrl,
      api,
      ...(providerConf.headers ? { headers: providerConf.headers } : {}),
      ...(providerConf.authHeader !== undefined ? { authHeader: providerConf.authHeader } : {}),
      contextWindow: providerConf.contextWindow ?? 128_000,
      maxTokens: providerConf.maxTokens ?? 4096,
      reasoning: providerConf.reasoning ?? false,
    };
  }

  return {
    providerId,
    modelId,
    ...(llm.thinkingLevel ? { thinkingLevel: llm.thinkingLevel } : {}),
    credential: { key, source },
    ...(custom ? { custom } : {}),
  };
}

/**
 * 配置指纹（LD6 局部）：对 {llm,runtime} 做稳定哈希，剔除 secret（apiKey 的值、
 * apiKeyEnv 名也剔除，避免把生产环境变量名泄漏进指纹）。
 */
export function configFingerprint(
  llm: ResolvedLlm,
  runtime: RuntimeConfig | undefined,
): string {
  const llmShape = {
    providerId: llm.providerId,
    modelId: llm.modelId,
    thinkingLevel: llm.thinkingLevel ?? null,
    custom: llm.custom
      ? {
          baseUrl: llm.custom.baseUrl,
          api: llm.custom.api,
          contextWindow: llm.custom.contextWindow,
          maxTokens: llm.custom.maxTokens,
          reasoning: llm.custom.reasoning,
        }
      : null,
  };
  const rtShape = {
    builtinTools: runtime?.builtinTools ?? [],
    retry: runtime?.retry ?? null,
    timeout: runtime?.timeout ?? null,
    compaction: runtime?.compaction ?? null,
    resources: runtime?.resources ?? null,
  };
  return sha256Hex(JSON.stringify({ llm: llmShape, runtime: rtShape }));
}