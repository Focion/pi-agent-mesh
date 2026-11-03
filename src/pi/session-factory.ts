// ═══════════════════════════════════════════════════════════════════════════
// createPiSessionFactory / createAssembledSessionFactory：SessionFactory 的两种装配
// （durable 后端）。与旧 pi-coding-agent 版同构：宿主可用自己的工厂完全替换，本文件
// 不是架构假设。
//
// durable 约定（迁移 MD1 / R9）：
//  - 每端点一个 cwd：<stateDir>/endpoints/<endpointId>，storage 文件 fixed 名 storage.sqlite
//  - runtimeRef 包装 storage 文件路径 + conversationId（对 mesh-core 是不透明字符串，MD7）
//  - 端点锁由 PiStreamPort 在 warm 时抢、且先于本工厂的 Harness.open（R9：storage 无
//    跨进程锁，锁是正确性前提，不再是可选优化）
//
// 两种路径（LD1）：
//  - createPiSessionFactory（高级/低层）——宿主自备 pi-ai Models 与 ModelRef，负责自己的
//    凭据与 provider；mesh 只负责工具桥接（L5 退化为「mesh 工具恒注入」）与 session 装配。
//  - createAssembledSessionFactory（缺省装配）——由 llm/runtime 配置做完全隔离（LD2）：
//    buildModels 内存凭据库 seed 显式 key，durable 本身不读任何配置文件，隔离论证比 coding-agent
//    时代更短（无 models.json / auth.json / settings / extensions / skills / prompts / themes）。
//
// F-G：durable 没有宿主级缺省模型，模型只在每个 conversation 的 pi.agent 文档；丢了会在
// 改 mesh 的 llm 配置后对已有端点不生效。故首次 create 走 root(ctx,{agent})，此后每次 open
// 都对 root configure({model, thinkingLevel, tools, modelTools}) 重应用。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import type { Endpoint, SessionFactory, ToolDefinition } from "../core/types.js";
import { loadDurableSdk } from "./durable-sdk.js";
import { buildModels, bridgeTools, type DurableSession } from "./durable-runtime.js";
import { validateRuntimeConfig, type ResolvedLlm, type RuntimeConfig } from "./llm-config.js";

/** durable storage 文件名（每端点固定，锁与 reopen 都按它定位）。 */
const STORAGE_FILENAME = "storage.sqlite";

/** MD7：runtimeRef 是 core 看待的不透明字符串，pack 了 storagePath + conversationId。
 *  mesh-core 只把它当 key，mesh-pi 在这里编解码；每个端点恒用 root（conversationId=1）。 */
interface RuntimeRefPayload {
  storagePath: string;
  conversationId: number;
}

function encodeRuntimeRef(storagePath: string, conversationId: number): string {
  return JSON.stringify({ storagePath, conversationId });
}

/** 解码 runtimeRef；解不出（损坏 / 旧库裸路径）时把整串当作 storagePath 兜底。 */
function decodeRuntimeRef(runtimeRef: string | undefined): RuntimeRefPayload | undefined {
  if (!runtimeRef) return undefined;
  try {
    const p = JSON.parse(runtimeRef) as Partial<RuntimeRefPayload>;
    if (typeof p.storagePath === "string" && typeof p.conversationId === "number") {
      return p as RuntimeRefPayload;
    }
  } catch {
    // fall through：旧数据可能只是裸路径。
  }
  return { storagePath: runtimeRef, conversationId: 1 };
}

/** 端点 storage 文件路径（缺省 cwd 约定：<stateDir>/endpoints/<id>）。 */
export function endpointStoragePath(opts: {
  stateDir: string;
  endpoint: Endpoint;
  cwdFor?(endpoint: Endpoint): string;
}): string {
  const cwd = opts.cwdFor?.(opts.endpoint) ?? join(opts.stateDir, "endpoints", opts.endpoint.id);
  return join(cwd, STORAGE_FILENAME);
}

/** runtime.retry/timeout/compaction → durable HarnessSettings（settings.{retry,stream,compaction}）。
 *  HarnessSettings 的字段是 readonly，故整对象用字面量 + 条件展开构造，不先建空对象再逐个赋值。
 *  pi 1.5 起 progress.persistWithinMs 缺省 1000（部分输出最长滞留 1s 才落盘）；mesh 恒显式
 *  传 progress（缺省 0 ≈ 旧版每-partial 即落盘的强度），宿主可经 runtime.progressPersistWithinMs
 *  放宽。故本函数恒返回 settings 对象（不再返回 undefined）。导出供单测锁定映射。 */
export function buildDurableSettings(runtime: RuntimeConfig | undefined): HarnessSettings {
  const retry = runtime?.retry;
  const compaction = runtime?.compaction;
  const timeout = runtime?.timeout;
  return {
    progress: { persistWithinMs: runtime?.progressPersistWithinMs ?? 0 },
    ...(retry
      ? {
          retry: {
            ...(retry.enabled !== undefined ? { enabled: retry.enabled } : {}),
            ...(retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
            ...(retry.baseDelayMs !== undefined ? { baseDelayMs: retry.baseDelayMs } : {}),
            ...(retry.maxAgentDelayMs !== undefined ? { maxAgentDelayMs: retry.maxAgentDelayMs } : {}),
          },
        }
      : {}),
    ...(timeout !== undefined ? { stream: { timeoutMs: timeout } } : {}),
    ...(compaction
      ? {
          compaction: {
            ...(compaction.enabled !== undefined ? { enabled: compaction.enabled } : {}),
            ...(compaction.reserveTokens !== undefined ? { reserveTokens: compaction.reserveTokens } : {}),
            ...(compaction.keepRecentTokens !== undefined ? { keepRecentTokens: compaction.keepRecentTokens } : {}),
          },
        }
      : {}),
  };
}

/**
 * 每端点装配一个 DurableSession：开 storage → Harness.open → root。
 * create 用 root(ctx,{agent}) 首建；open 用 root(ctx) + configure 重应用（F-G）。
 * chord Context 只在 src/pi/ 内构造（sdk.BackgroundContext），绝不外泄到 core。
 * ⚠ 不在此处 resume：harness.resume() 由 PiStreamPort 在 warm 末尾调用（pi 1.5 升级，
 * 启动顺序归 port 统一编排，失败回滚见 durable-port）。
 */
async function assemble(
  sdk: Awaited<ReturnType<typeof loadDurableSdk>>,
  models: Models,
  modelRef: ModelRef,
  thinkingLevel: ModelThinkingLevel | undefined,
  settings: HarnessSettings,
  tools: ToolDefinition[],
  endpoint: Endpoint,
  storagePath: string,
  mode: "create" | "open",
  onReport?: (error: unknown) => void,
): Promise<{ session: DurableSession; runtimeRef: string }> {
  const ctx = sdk.BackgroundContext;
  const registry = sdk.durable.createRegistry();
  const bridged = bridgeTools(tools, sdk);
  if (bridged.length > 0) {
    registry.install(sdk.durable.defineExtension({ name: "pi-agent-mesh:mesh-tools", tools: bridged }));
  }

  await mkdir(dirname(storagePath), { recursive: true });
  const storage = await sdk.openNodeSqliteStorage(storagePath);
  const harness = await sdk.durable.Harness.open(
    storage,
    {
      models,
      registry,
      settings,
      // MD8：durable 的失败通道（task_faulted / task_parked / extension_error 等非致命失败）。
      ...(onReport ? { onReport } : {}),
    },
    ctx,
  );

  const agentChange = {
    model: modelRef,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools: bridged,
    modelTools: bridged,
  };

  let root;
  if (mode === "create") {
    root = await harness.root(ctx, { agent: agentChange });
  } else {
    root = await harness.root(ctx);
    // F-G：每次 warm 对 root 重应用当前 mesh 的 llm/工具配置。
    await root.configure(agentChange, ctx);
  }

  const session: DurableSession = {
    endpointId: endpoint.id,
    ctx,
    harness,
    root,
    registry,
    async configure(model, level) {
      await root.configure({ model, ...(level ? { thinkingLevel: level } : {}) }, ctx);
    },
    async close() {
      await harness.close(ctx);
    },
  };
  return { session, runtimeRef: encodeRuntimeRef(storagePath, root.id) };
}

/**
 * 缺省装配：由 llm/runtime 配置产出完全隔离的 SessionFactory（LD2）。装配异步（惰性加载
 * durable + buildModels + 解析模型），失败即 fail-fast。
 */
export async function createAssembledSessionFactory(opts: {
  stateDir: string;
  llm: ResolvedLlm;
  runtime?: RuntimeConfig;
  cwdFor?(endpoint: Endpoint): string;
  /** MD8 非致命失败通道（task_faulted / task_parked / extension_error）；可选 */
  onReport?(error: unknown): void;
}): Promise<SessionFactory> {
  const sdk = await loadDurableSdk();
  validateRuntimeConfig(opts.runtime);
  const { stateDir, llm, runtime } = opts;
  const models = await buildModels(llm, sdk);
  const modelRef: ModelRef = { provider: llm.providerId, modelId: llm.modelId };
  const thinkingLevel = llm.thinkingLevel as ModelThinkingLevel | undefined;
  const settings = buildDurableSettings(runtime);

  return {
    async create(ctx) {
      const storagePath = endpointStoragePath({ stateDir, endpoint: ctx.endpoint, cwdFor: opts.cwdFor });
      return assemble(sdk, models, modelRef, thinkingLevel, settings, ctx.tools, ctx.endpoint, storagePath, "create", opts.onReport);
    },
    async open(ctx) {
      // MD7：优先从 runtimeRef 解出 storagePath（未来 fork 后未必等于确定路径），解不出回退确定路径。
      const storagePath =
        decodeRuntimeRef(ctx.runtimeRef)?.storagePath ??
        endpointStoragePath({ stateDir, endpoint: ctx.endpoint, cwdFor: opts.cwdFor });
      const opened = await assemble(sdk, models, modelRef, thinkingLevel, settings, ctx.tools, ctx.endpoint, storagePath, "open", opts.onReport);
      return { session: opened.session };
    },
  };
}

// ─── 高级/低层路径：宿主自备 pi-ai Models + ModelRef（LD1 保留路径）─────────────────

export interface PiSessionFactoryOptions {
  /** 端点 storage 文件根目录（与 PiStreamPort 的 stateDir 一致） */
  stateDir: string;
  /** 宿主预建的 pi-ai Models（含 provider 与凭据）；durable 无缺省模型目录，必填 */
  models: unknown;
  /** agent 使用的 provider:modelId（ModelRef 结构体，node 里不强依赖 pi-ai 类型导出） */
  model: { provider: string; modelId: string };
  thinkingLevel?: string;
  /** durable HarnessSettings（retry/stream/compaction 等）；可选透传 */
  settings?: unknown;
  /** MD8 非致命失败通道（宿主接管 task_faulted / task_parked / extension_error） */
  onReport?(error: unknown): void;
  /** 端点 cwd 的自定义解析（默认 <stateDir>/endpoints/<id>） */
  cwdFor?(endpoint: Endpoint): string;
}

export function createPiSessionFactory(opts: PiSessionFactoryOptions): SessionFactory {
  const models = opts.models as Models;
  const modelRef: ModelRef = { provider: opts.model.provider, modelId: opts.model.modelId };
  const thinkingLevel = (opts.thinkingLevel as ModelThinkingLevel | undefined) ?? undefined;
  const settings = opts.settings as HarnessSettings | undefined;

  async function assembleAt(
    endpoint: Endpoint,
    tools: ToolDefinition[],
    mode: "create" | "open",
    runtimeRef?: string,
  ): Promise<{ session: DurableSession; runtimeRef: string }> {
    const sdk = await loadDurableSdk();
    const storagePath =
      (mode === "open" ? decodeRuntimeRef(runtimeRef)?.storagePath : undefined) ??
      endpointStoragePath({ stateDir: opts.stateDir, endpoint, cwdFor: opts.cwdFor });
    return assemble(sdk, models, modelRef, thinkingLevel, settings as HarnessSettings, tools, endpoint, storagePath, mode, opts.onReport);
  }

  return {
    async create(ctx) {
      return assembleAt(ctx.endpoint, ctx.tools as ToolDefinition[], "create");
    },
    async open(ctx) {
      const opened = await assembleAt(ctx.endpoint, ctx.tools as ToolDefinition[], "open", ctx.runtimeRef);
      return { session: opened.session };
    },
  };
}