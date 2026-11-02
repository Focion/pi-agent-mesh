// ═══════════════════════════════════════════════════════════════════════════
// durable-runtime：durable 后端装配的运行时部件（模型目录 / API 适配器懒装 /
// mesh 工具桥接）。只持类型：所有 pi-durable / pi-ai / chord 的运行值都经
// DurableSdk（durable-sdk 惰性装载）传入，保持 core-only 隔离。
//
//   - buildModels：由 ResolvedLlm 产出 pi-ai 的 Models（内建目录或自定义 provider），
//     显式密钥 seed 进 InMemoryCredentialStore（不动 ~/.pi、不回退 ambient env，LD2/LD4）。
//   - loadProviderApi：按 api 名懒装对应 pi-ai adapter（.lazy 模块只在首次流式时
//     加载重型实现），返回 ProviderStreams。
//   - bridgeTools：mesh ToolDefinition → durable ToolRegistration。replay:"safe"
//     （F-D：执行中崩溃重开后以同一 callId 重跑，mesh 侧 ack/claim/shared 靠
//     tool-call id 幂等）。
// ═══════════════════════════════════════════════════════════════════════════

import type { Context, JsonValue } from "@earendil-works/chord";
import type {
  Conversation,
  Harness,
  ModelRef,
  Registry,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type {
  Api,
  Model,
  ModelThinkingLevel,
  Models,
  ProviderStreams,
  TSchema,
} from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../core/types.js";
import type { EndpointId } from "../core/types.js";
import { MeshConfigError, type ResolvedLlm } from "./llm-config.js";
import type { DurableSdk } from "./durable-sdk.js";

// ─── DurableSession：port 消费的 session 收窄面 ─────────────────────────────

/**
 * SessionFactory 产出的 durable session 结构。session 在 core 眼里是 unknown，
 * port 只在 warm 时把工厂产物收窄到这个面。`configure`/`close` 是 factory 绑定的
 * 便捷方法（F-G 每次 warm 重应用模型；A21 强制卸载真关 harness+storage）。
 */
export interface DurableSession {
  readonly endpointId: EndpointId;
  readonly ctx: Context;
  readonly harness: Harness;
  readonly root: Conversation;
  readonly registry: Registry;
  configure(model: ModelRef, thinkingLevel?: ModelThinkingLevel): Promise<void>;
  close(): Promise<void>;
}

// ─── 模型目录 ──────────────────────────────────────────────────────────────

/** 由 ResolvedLlm 组装一个自定义 provider 的 chat 模型条目（catalog 条目字段对齐 pi-ai Model）。 */
function customModelFor(resolved: ResolvedLlm): Model<Api> {
  const c = resolved.custom!;
  return {
    id: resolved.modelId,
    name: resolved.modelId,
    api: c.api,
    provider: resolved.providerId,
    baseUrl: c.baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: c.reasoning,
    contextWindow: c.contextWindow,
    maxTokens: c.maxTokens,
  };
}

/**
 * 按 api 名懒装 pi-ai adapter（.lazy 模块本身极轻，重型实现再进一层动态 import，
 * 首次流式才加载）。KNOWN_APIS 已由 llm-config 校验，这里 only-fall-through 兜底。
 */
export async function loadProviderApi(api: string): Promise<ProviderStreams> {
  switch (api) {
    case "anthropic-messages":
      return (await import("@earendil-works/pi-ai/api/anthropic-messages.lazy")).anthropicMessagesApi();
    case "openai-completions":
      return (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi();
    case "openai-responses":
      return (await import("@earendil-works/pi-ai/api/openai-responses.lazy")).openAIResponsesApi();
    case "openai-codex-responses":
      return (await import("@earendil-works/pi-ai/api/openai-codex-responses.lazy")).openAICodexResponsesApi();
    case "azure-openai-responses":
      return (await import("@earendil-works/pi-ai/api/azure-openai-responses.lazy")).azureOpenAIResponsesApi();
    case "google-generative-ai":
      return (await import("@earendil-works/pi-ai/api/google-generative-ai.lazy")).googleGenerativeAIApi();
    case "google-vertex":
      return (await import("@earendil-works/pi-ai/api/google-vertex.lazy")).googleVertexApi();
    case "mistral-conversations":
      return (await import("@earendil-works/pi-ai/api/mistral-conversations.lazy")).mistralConversationsApi();
    case "bedrock-converse-stream":
      return (await import("@earendil-works/pi-ai/api/bedrock-converse-stream.lazy")).bedrockConverseStreamApi();
    case "pi-messages":
      return (await import("@earendil-works/pi-ai/api/pi-messages.lazy")).piMessagesApi();
    default:
      throw new MeshConfigError("MESH_BAD_CONFIG", `未知 API 适配器 "${api}"`);
  }
}

/** 由 ResolvedLlm 产出 Models：内建目录（builtinModels）或自定义 provider（createProvider）。 */
export async function buildModels(resolved: ResolvedLlm, sdk: DurableSdk): Promise<Models> {
  const { piai } = sdk;
  const credentials = new piai.InMemoryCredentialStore();
  // 显式密钥进内存凭据库（不进 ~/.pi、不回退 ambient env）。provider id 为键。
  await credentials.modify(resolved.providerId, async () => ({
    type: "api_key" as const,
    key: resolved.credential.key,
  }));

  if (!resolved.custom) {
    const models = sdk.builtinModels({ credentials });
    if (!models.getModel(resolved.providerId, resolved.modelId)) {
      throw new MeshConfigError(
        "MESH_UNKNOWN_MODEL",
        `provider "${resolved.providerId}" 不是可解析的内建 provider 或目录无 "${resolved.modelId}"`,
      );
    }
    return models;
  }

  const provider = piai.createProvider({
    id: resolved.providerId,
    name: resolved.providerId,
    baseUrl: resolved.custom.baseUrl,
    ...(resolved.custom.headers ? { headers: resolved.custom.headers } : {}),
    auth: { apiKey: piai.envApiKeyAuth(resolved.providerId, []) },
    models: [customModelFor(resolved)],
    api: await loadProviderApi(resolved.custom.api),
  });
  const models = piai.createModels({ credentials });
  models.setProvider(provider);
  if (!models.getModel(resolved.providerId, resolved.modelId)) {
    throw new MeshConfigError(
      "MESH_UNKNOWN_MODEL",
      `自定义 provider "${resolved.providerId}" 的 models[] 中无 "${resolved.modelId}"（model 字段按 "providerId:modelId" 书写）`,
    );
  }
  return models;
}

// ─── mesh 工具 → durable 工具桥接（§10.2 / M4）─────────────────────────────

/**
 * mesh 的 ToolDefinition.execute 返回 { content: string | Array<{type:"text",text}> }；
 * durable 的 ToolExecutionResult.output 恒为 ToolResultMessage["content"]（文本块数组）。
 * replay:"safe" 使执行中崩溃重开后以同一 api.callId 重跑（CT-D11）；callId 又作为 mesh
 * toolCallId/clientToken 参与幂等，故 safe 重跑不会重复投递。
 */
export function bridgeTools(tools: ToolDefinition[], sdk: DurableSdk): ToolRegistration[] {
  const { durable } = sdk;
  return tools.map((t) =>
    durable.defineTool({
      name: t.name,
      description: t.description,
      // mesh 侧是 JSON Schema（TypeBox 兼容）；durable 用 TypeBox schema 校验参数（步骤 12 收敛）
      parameters: t.parameters as unknown as TSchema,
      replay: "safe",
      async execute(args, api, _ctx) {
        const r = await t.execute(api.callId, args as Record<string, unknown>, undefined, undefined, undefined);
        const content = typeof r.content === "string" ? r.content : (r.content ?? []).map((c) => c.text).join("\n");
        return { output: [{ type: "text" as const, text: content }] };
      },
    }),
  );
}

/** 进 durable 的 JsonValue 面前先做 JSON 往返：Envelope 的多数可选字段缺省是 `undefined`，
 *  不是严格 JSON（durable 存储会校验 JsonValue），往返顺带丢弃 undefined 字段。 */
export function toJsonValue(data: unknown): JsonValue {
  return JSON.parse(JSON.stringify(data)) as JsonValue;
}