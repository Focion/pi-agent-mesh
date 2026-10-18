// ═══════════════════════════════════════════════════════════════════════════
// createPiSessionFactory / createAssembledSessionFactory：SessionFactory 的两种装配。
//
// 约定（宿主可用自己的工厂完全替换，本文件不是架构假设）：
//  - 每端点一个 cwd：<stateDir>/endpoints/<endpointId>，session 目录其下 sessions/
//  - piSessionId 存的是 session 文件路径（对 mesh-core 是不透明字符串，
//    open 时直接喂给 SessionManager.open）
//
// 两种路径（LD1）：
//  - createPiSessionFactory（高级/低层）——宿主自备 model/agentDir，负责自己的
//    pi 配置；mesh 只负责 tool 白名单（L5）与 session 装配。
//  - createAssembledSessionFactory（缺省装配）——由 llm/runtime 配置做完全隔离
//    （LD2）：内存凭据库 + modelsPath:null + 内存 SettingsManager +
//    DefaultResourceLoader 全 no*，绝不读 ~/.pi/agent 的 models/auth/settings
//    与 extension/skill/prompt/theme/context 文件，也不回退 ambient env（LD4）。
//
// 工具白名单语义（L5，实测 pi 1.1.0）：tools 白名单会过滤掉未列名的一切工具，
// 包括 customTools；noTools:"all" 连 customTools 也禁掉；noTools:"builtin" 仍保留
// ast_grep/lens/mcp/web_search 等扩展内建。要得到「内建白名单 + mesh 工具」，
// 唯一正确配方是 tools = [...builtinTools, ...customToolNames]。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint, SessionFactory, ToolDefinition } from "../core/types.js";
import { loadPiSdk, type PiSdk } from "./pi-sdk.js";
import { MeshConfigError, type ResolvedLlm, type RuntimeConfig } from "./llm-config.js";

// ─── 内存凭据库（实现 pi-ai CredentialStore 接口；不依赖 pi-ai 运行时）─────────
// 空的即可：显式 secret 经 ModelRuntime.setRuntimeApiKey 进 RuntimeCredentials
// 覆盖层，本库只是挡住「缺省 DefaultAuthStorage 回读 ~/.pi/agent/auth.json」的
// 隔离漏洞（ModelRuntime.create 缺省 credentials 会去读 authPath 文件）。
interface MeshCredential {
  type: "api_key" | "oauth";
  key?: string;
  env?: Record<string, string>;
  [k: string]: unknown;
}

class MemoryCredentialStore {
  private map = new Map<string, MeshCredential>();
  async read(id: string): Promise<MeshCredential | undefined> {
    return this.map.get(id);
  }
  async list(): Promise<Array<{ providerId: string; type: "api_key" | "oauth" }>> {
    return [...this.map.entries()].map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  async modify(
    id: string,
    fn: (cur: MeshCredential | undefined) => Promise<MeshCredential | undefined>,
  ): Promise<MeshCredential | undefined> {
    const next = await fn(this.map.get(id));
    if (next === undefined) this.map.delete(id);
    else this.map.set(id, next);
    return next;
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

// ─── 工具白名单（L5）───────────────────────────────────────────────────────

function toolAllowlist(builtinTools: string[] | undefined, customTools: unknown[]): string[] {
  const meshNames = customTools
    .map((t) => (t as { name?: unknown } | undefined)?.name)
    .filter((n): n is string => typeof n === "string" && n !== "");
  return [...(builtinTools ?? []), ...meshNames];
}

// ─── mesh 工具 → pi 自定义工具桥接（§10.2 / M4）────────────────────────────
// mesh 的 ToolDefinition.execute 返回 { content: string | Array<{type:"text",text}> }；
// pi 1.1.0 的 AgentToolResult.content 恒为 (TextContent|ImageContent)[]。把 content 为
// 字符串时归一为单段文本块数组，使工具结果既能被 pi 运行时的 `.some()` 消费，又不改动
// mesh 公共契约（host.toolSet / parseToolContent 仍兼容两种形态）。桥接只发生在
// pi 边界，不回流 core（core-only 用户不加载本模块）。
function asPiCustomTools(customTools: unknown[]): unknown[] {
  return customTools.map((raw) => {
    const t = raw as ToolDefinition;
    return {
      ...t,
      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: unknown,
      ) {
        const r = await t.execute(toolCallId, params, signal, onUpdate, ctx);
        return {
          ...r,
          content:
            typeof r.content === "string"
              ? [{ type: "text", text: r.content }]
              : r.content,
        };
      },
    };
  });
}

/** 资源开关：缺省 false（隔离）；仅显式 true 才继承（LD2） */
function resourceEnabled(resources: RuntimeConfig["resources"], key: keyof NonNullable<RuntimeConfig["resources"]>): boolean {
  return resources?.[key] === true;
}

/** pi SettingsManager 实例（构造器私有，用静态 inMemory 的返回类型取得）。 */
type PiSettingsManager = ReturnType<PiSdk["SettingsManager"]["inMemory"]>;

/** 内存 SettingsManager：注入 retry/timeout/compaction 白名单，绝不落盘 */
function buildSettings(
  pi: PiSdk,
  runtime: RuntimeConfig | undefined,
): PiSettingsManager {
  const retry = runtime?.retry
    ? {
        ...(runtime.retry.enabled !== undefined ? { enabled: runtime.retry.enabled } : {}),
        ...(runtime.retry.maxRetries !== undefined ? { maxRetries: runtime.retry.maxRetries } : {}),
        ...(runtime.retry.baseDelayMs !== undefined ? { baseDelayMs: runtime.retry.baseDelayMs } : {}),
        ...(runtime.retry.maxAgentDelayMs !== undefined ? { maxAgentDelayMs: runtime.retry.maxAgentDelayMs } : {}),
      }
    : undefined;
  const retryMerged =
    retry || runtime?.timeout !== undefined
      ? { ...(retry ?? {}), ...(runtime?.timeout !== undefined ? { provider: { timeoutMs: runtime.timeout } } : {}) }
      : undefined;
  const compaction = runtime?.compaction
    ? {
        ...(runtime.compaction.enabled !== undefined ? { enabled: runtime.compaction.enabled } : {}),
        ...(runtime.compaction.reserveTokens !== undefined ? { reserveTokens: runtime.compaction.reserveTokens } : {}),
        ...(runtime.compaction.keepRecentTokens !== undefined ? { keepRecentTokens: runtime.compaction.keepRecentTokens } : {}),
      }
    : undefined;
  const settings: Record<string, unknown> = {};
  if (retryMerged) settings.retry = retryMerged;
  if (compaction) settings.compaction = compaction;
  return pi.SettingsManager.inMemory(settings as never);
}

/**
 * 缺省装配：由 llm/runtime 配置产出完全隔离的 SessionFactory（W00-L4/L5）。
 * 装配是异步的（惰性加载 pi + 建 ModelRuntime + 解析模型），失败即 fail-fast。
 */
export async function createAssembledSessionFactory(opts: {
  stateDir: string;
  llm: ResolvedLlm;
  runtime?: RuntimeConfig;
  cwdFor?(endpoint: Endpoint): string;
}): Promise<SessionFactory> {
  const pi = await loadPiSdk();
  const { stateDir, llm, runtime } = opts;
  const cwdFor = (e: Endpoint) => opts.cwdFor?.(e) ?? join(stateDir, "endpoints", e.id);

  // 私有 agentDir：只作为 DefaultResourceLoader 的无文件空目录，不放任何配置。
  const agentDir = join(stateDir, "pi-agents");
  const settings = buildSettings(pi, runtime);

  // ModelRuntime：modelsPath:null（不读 models.json）+ 内存凭据库（不读 auth.json）
  // + refreshOnCreate:false（不发网络目录刷新）。
  const rt = await pi.ModelRuntime.create({
    credentials: new MemoryCredentialStore() as never,
    modelsPath: null,
    refreshOnCreate: false,
  });

  if (llm.custom) {
    rt.registerProvider(llm.providerId, {
      baseUrl: llm.custom.baseUrl,
      api: llm.custom.api,
      ...(llm.custom.headers ? { headers: llm.custom.headers } : {}),
      ...(llm.custom.authHeader !== undefined ? { authHeader: llm.custom.authHeader } : {}),
      models: [
        {
          id: llm.modelId,
          name: llm.modelId,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: llm.custom.reasoning,
          contextWindow: llm.custom.contextWindow,
          maxTokens: llm.custom.maxTokens,
        },
      ],
    } as never);
  }

  // 显式 secret 进运行时凭据（不进 memory 库也不落盘；ambient env 被显式 key 遮蔽）。
  await rt.setRuntimeApiKey(llm.providerId, llm.credential.key);

  const model = rt.getModel(llm.providerId, llm.modelId);
  if (!model) {
    const hint = llm.custom
      ? `自定义 provider "${llm.providerId}" 的 models[] 中无 "${llm.modelId}"（model 字段按 "providerId:modelId" 书写）`
      : `provider "${llm.providerId}" 不是可解析的内建 provider 或目录无 "${llm.modelId}"`;
    throw new MeshConfigError("MESH_UNKNOWN_MODEL", hint);
  }

  async function resourceLoaderFor(cwd: string) {
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: !resourceEnabled(runtime?.resources, "extensions"),
      noSkills: !resourceEnabled(runtime?.resources, "skills"),
      noPromptTemplates: !resourceEnabled(runtime?.resources, "prompts"),
      noThemes: !resourceEnabled(runtime?.resources, "themes"),
      noContextFiles: !resourceEnabled(runtime?.resources, "contextFiles"),
    });
    await loader.reload();
    return loader;
  }

  async function spawn(
    endpoint: Endpoint,
    sessionManager: unknown,
    customTools: unknown[],
  ): Promise<{ session: unknown; piSessionId: string }> {
    const cwd = cwdFor(endpoint);
    await mkdir(cwd, { recursive: true });
    const { session } = await pi.createAgentSession({
      cwd,
      model: model as never,
      ...(llm.thinkingLevel ? { thinkingLevel: llm.thinkingLevel as never } : {}),
      modelRuntime: rt as never,
      settingsManager: settings as never,
      resourceLoader: await resourceLoaderFor(cwd),
      tools: toolAllowlist(runtime?.builtinTools, customTools),
      customTools: asPiCustomTools(customTools) as never,
      sessionManager: sessionManager as never,
    });
    const mgr = session.sessionManager;
    return { session, piSessionId: mgr.getSessionFile() ?? mgr.getSessionId() };
  }

  return {
    async create(ctx) {
      const cwd = cwdFor(ctx.endpoint);
      const sessionDir = join(cwd, "sessions");
      await mkdir(sessionDir, { recursive: true });
      const sm = pi.SessionManager.create(cwd, sessionDir);
      return spawn(ctx.endpoint, sm, ctx.tools as unknown[]);
    },
    async open(ctx) {
      const cwd = cwdFor(ctx.endpoint);
      const sessionDir = join(cwd, "sessions");
      await mkdir(sessionDir, { recursive: true });
      // piSessionId 即 session 文件路径（本实现的约定，见头注）
      const sm = pi.SessionManager.open(ctx.piSessionId, sessionDir, cwd);
      return { session: (await spawn(ctx.endpoint, sm, ctx.tools as unknown[])).session };
    },
  };
}

// ─── 高级/低层路径：宿主自备 model/agentDir（LD1 保留路径）─────────────────

export interface PiSessionFactoryOptions {
  /** 锁文件/端点工作目录的根（与 PiStreamPort 的 stateDir 一致） */
  stateDir: string;
  /** pi 全局配置目录（默认 ~/.pi/agent；测试给临时目录）。本路径不隔离——宿主自管 */
  agentDir?: string;
  /** 宿主选定的模型（pi-ai 的 Model<any>）；缺省由 pi 按 settings 解析 */
  model?: unknown;
  thinkingLevel?: string;
  /** 内建工具白名单（缺省 [] = 全禁内建）；mesh 工具恒经 customTools 注入 */
  tools?: string[];
  /** 端点 cwd 的自定义解析（默认 <stateDir>/endpoints/<id>） */
  cwdFor?(endpoint: Endpoint): string;
}

export function createPiSessionFactory(opts: PiSessionFactoryOptions): SessionFactory {
  const cwdFor = (e: Endpoint) => opts.cwdFor?.(e) ?? join(opts.stateDir, "endpoints", e.id);

  async function spawn(
    endpoint: Endpoint,
    sessionManager: unknown,
    customTools: unknown[],
  ): Promise<{ session: unknown; piSessionId: string }> {
    const pi = await loadPiSdk();
    const cwd = cwdFor(endpoint);
    await mkdir(cwd, { recursive: true });
    const { session } = await pi.createAgentSession({
      cwd,
      ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts.model ? { model: opts.model as never } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel as never } : {}),
      tools: toolAllowlist(opts.tools, customTools),
      customTools: asPiCustomTools(customTools) as never,
      sessionManager: sessionManager as never,
    });
    const sm = session.sessionManager;
    return { session, piSessionId: sm.getSessionFile() ?? sm.getSessionId() };
  }

  return {
    async create(ctx) {
      const pi = await loadPiSdk();
      const cwd = cwdFor(ctx.endpoint);
      const sessionDir = join(cwd, "sessions");
      await mkdir(sessionDir, { recursive: true });
      const sm = pi.SessionManager.create(cwd, sessionDir);
      return spawn(ctx.endpoint, sm, ctx.tools as unknown[]);
    },

    async open(ctx) {
      const pi = await loadPiSdk();
      const cwd = cwdFor(ctx.endpoint);
      const sessionDir = join(cwd, "sessions");
      await mkdir(sessionDir, { recursive: true });
      // piSessionId 即 session 文件路径（本实现的约定，见头注）
      const sm = pi.SessionManager.open(ctx.piSessionId, sessionDir, cwd);
      return { session: (await spawn(ctx.endpoint, sm, ctx.tools as unknown[])).session };
    },
  };
}