// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 配置层（全真实）— 无密钥 fail-fast。
//
// 真相来源：
//  - model 构造        内建：@earendil-works/pi-ai/providers/all 的 getBuiltinModel
//                     自定义：<agentDir>/models.json（pi 的 ModelRuntime 会读同一份注册 provider）
//  - 凭据 env 名     @earendil-works/pi-ai/dist/env-api-keys.js（下方表镜像其优先级）
//  - 存储凭据       <agentDir>/auth.json（{ [providerId]: {type:"api_key",key?} }）
//  - agentDir 缺省    pi 的 getAgentDir() = ~/.pi/agent（createAgentSession 的默认）
//
// 运行：node demo/src/server.ts（Node ≥ 22.19 原生 type-stripping）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";

export const DEMO_VERSION = "0.1.0";

export interface DemoConfig {
  provider: string;
  modelId: string;
  thinkingLevel: string;
  tools: string[]; // pi 内建工具白名单（[] = 全禁，mesh 工具仍经 customTools 注册）
  dbPath: string;
  stateDir: string;
  agentDir?: string; // undefined = pi 缺省 ~/.pi/agent
  port: number;
}

export interface ResolvedDemo {
  config: DemoConfig;
  model: unknown; // pi-ai 的 Model<any>
  credential: { source: string };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 仓库根（demo/src/config.ts → ../../）——让默认路径与 cwd 无关。 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** pi 的默认 agentDir（config.js getAgentDir()）：~/.pi/agent */
function defaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

// ── 自定义 provider（models.json）────────────────────────────────────────────
// pi-coding-agent 的 ModelRuntime.create({modelsPath}) 会读 <agentDir>/models.json，
// 把自定义 provider（baseUrl + apiKey + api + models[]）注册进运行时，apiKey 走
// 「configured API key / models_json_key」鉴权。demo 在这里解析同一份文件，构造一个
// 「镜像该条目」的 Model 对象注入 createAgentSession；pi 内部按 model.provider/id
// 命中同一 provider，流时经 requireProvider + applyAuth 拿到 baseUrl 与 apiKey。
// 因此 demo 只需保证注入 Model 的 provider/id 与 models.json 一致即可，无需另造 Provider。

interface ModelsJsonModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  models?: ModelsJsonModel[];
}

interface ModelsJsonFile {
  providers?: Record<string, ModelsJsonProvider>;
}

/** pi-ai 已知的 API 适配器（types.d.ts 的 ApiOptionsMap 键）。 */
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

function customModelsPath(config: DemoConfig): string {
  return join(config.agentDir ?? defaultAgentDir(), "models.json");
}

/** 读 <agentDir>/models.json 中 providers.<config.provider>（无文件 → undefined）。 */
function loadCustomProvider(config: DemoConfig): { path: string; provider?: ModelsJsonProvider } {
  const path = customModelsPath(config);
  if (!existsSync(path)) return { path };
  let parsed: ModelsJsonFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ModelsJsonFile;
  } catch (err) {
    throw new ConfigError(
      `[mesh-demo] 无法解析 models.json ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { path, provider: parsed?.providers?.[config.provider] };
}

/** 自定义 provider 是否带可用的鉴权凭据（apiKey，或 Authorization/x-api-key 头）。 */
function customProviderHasCredentials(p: ModelsJsonProvider): boolean {
  if (typeof p.apiKey === "string" && p.apiKey.trim() !== "") return true;
  const headers = p.headers;
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string" && v.trim() !== "") {
        const lk = k.toLowerCase();
        if (lk === "authorization" || lk === "x-api-key" || lk === "api-key") return true;
      }
    }
  }
  return false;
}

/** 由 models.json 的一条 model 定义构造可注入 pi 的 Model 对象（镜像 pi 的产物）。 */
function buildCustomModel(
  providerId: string,
  m: ModelsJsonModel,
  p: ModelsJsonProvider,
  path: string,
): unknown {
  const api = m.api ?? p.api ?? "openai-completions";
  if (!(KNOWN_APIS as readonly string[]).includes(api)) {
    throw new ConfigError(
      `[mesh-demo] 自定义 provider "${providerId}" 的 api "${api}" 未知。可用: ${KNOWN_APIS.join(", ")}。（${path}）`,
    );
  }
  const baseUrl = m.baseUrl ?? p.baseUrl;
  if (!baseUrl || baseUrl.trim() === "") {
    throw new ConfigError(
      `[mesh-demo] 自定义 provider "${providerId}" 缺少 baseUrl。请在 ${path} 的 providers."${providerId}"（或其 models[] 条目）填 baseUrl。`,
    );
  }
  const rawCost = m.cost ?? {};
  const compat = m.compat ?? p.compat;
  return {
    id: m.id,
    name: m.name ?? m.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: m.reasoning ?? false,
    ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
    input: m.input ?? ["text"],
    cost: {
      input: rawCost.input ?? 0,
      output: rawCost.output ?? 0,
      cacheRead: rawCost.cacheRead ?? 0,
      cacheWrite: rawCost.cacheWrite ?? 0,
    },
    contextWindow: m.contextWindow ?? 128000,
    maxTokens: m.maxTokens ?? 4096,
    ...(m.samplingParams ? { samplingParams: m.samplingParams } : {}),
    ...(m.headers ? { headers: m.headers } : {}),
    ...(compat ? { compat } : {}),
  };
}

// ── provider → 凭据 env 表（镜像 @earendil-works/pi-ai/dist/env-api-keys.js）──
// anthropic 特判：AUTH_TOKEN 走 Authorization: Bearer；解析顺序 AUTH_TOKEN →
// OAUTH_TOKEN → API_KEY（与 anthropic.js 一致）。
const CREDENTIAL_ENV: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
};

interface JsonConfigFile {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  tools?: string[];
  dbPath?: string;
  stateDir?: string;
  agentDir?: string;
  port?: number;
}

function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function readConfigFile(): JsonConfigFile {
  const explicit = envStr("MESH_DEMO_CONFIG");
  const path = explicit ?? join(ROOT, "demo", "demo.config.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as JsonConfigFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    throw new ConfigError(
      `[mesh-demo] 无法解析配置文件 ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function loadConfig(): DemoConfig {
  const file = readConfigFile();
  const portRaw = envStr("MESH_DEMO_PORT") ?? (file.port !== undefined ? String(file.port) : "8787");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`[mesh-demo] 非法端口: "${portRaw}"（须 1–65535）`);
  }

  const tools = envStr("MESH_DEMO_TOOLS")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? file.tools ?? [];

  // dbPath：显式覆盖（env 或文件）相对 cwd 解析；缺省用仓库内 demo/.data。
  const dbOverride = envStr("MESH_DEMO_DB") ?? file.dbPath;
  const dbPath = dbOverride ? resolve(process.cwd(), dbOverride) : join(ROOT, "demo", ".data", "mesh.db");

  const stateOverride = envStr("MESH_DEMO_STATE_DIR") ?? file.stateDir;
  const stateDir = stateOverride
    ? resolve(process.cwd(), stateOverride)
    : join(dirname(dbPath), "mesh");

  const agentDirOverride = envStr("MESH_DEMO_AGENT_DIR") ?? file.agentDir;

  return {
    provider: envStr("MESH_DEMO_PROVIDER") ?? file.provider ?? "anthropic",
    modelId: envStr("MESH_DEMO_MODEL") ?? file.modelId ?? "claude-sonnet-4-5",
    thinkingLevel: envStr("MESH_DEMO_THINKING") ?? file.thinkingLevel ?? "medium",
    tools,
    dbPath,
    stateDir,
    agentDir: agentDirOverride ? resolve(process.cwd(), agentDirOverride) : undefined,
    port,
  };
}

/** 从 auth.json 判断 provider 是否有「真实」存储凭据（key / oauth / 非空 env）。 */
function storedCredentialPresent(parsed: unknown, provider: string): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const entry = (parsed as Record<string, unknown>)[provider];
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (e.type === "oauth" && typeof e.access === "string") return true;
  if (e.type === "api_key") {
    if (typeof e.key === "string" && e.key.trim() !== "") return true;
    if (e.env && typeof e.env === "object" && Object.keys(e.env).length > 0) return true;
  }
  return false;
}

function resolveCredentials(
  config: DemoConfig,
  custom?: { path: string; provider: ModelsJsonProvider },
): { source: string } {
  const provider = config.provider;

  // ① 自定义 provider：凭据内联在 models.json（apiKey / Authorization 头），不走 auth.json/env。
  if (custom?.provider) {
    if (customProviderHasCredentials(custom.provider)) {
      return { source: `models.json@${custom.path}` };
    }
    throw new ConfigError(
      [
        `[mesh-demo] missing credentials for custom provider "${provider}" (model "${config.modelId}").`,
        `  models.json: ${custom.path} 的 providers."${provider}" 既无 apiKey，也无 Authorization/x-api-key 头。`,
        ``,
        `  Fix: 在 ${custom.path} 给 providers."${provider}" 加 "apiKey":"...";`,
        `       标准 Bearer 再加 "authHeader":true；自定义鉴权头用 "headers" 字段。`,
      ].join("\n"),
    );
  }

  const agentDir = config.agentDir ?? defaultAgentDir();
  const authFile = join(agentDir, "auth.json");

  if (existsSync(authFile)) {
    try {
      if (storedCredentialPresent(JSON.parse(readFileSync(authFile, "utf8")), provider)) {
        return { source: `auth.json@${authFile}` };
      }
    } catch {
      // 读取失败 → 当无存储，继续走 env
    }
  }

  const envs = CREDENTIAL_ENV[provider];
  if (envs) {
    for (const e of envs) {
      if (envStr(e)) return { source: e };
    }
  }

  const envList = envs && envs.length > 0 ? envs.join(" / ") : "(未知 provider，无 env 映射)";
  throw new ConfigError(
    [
      `[mesh-demo] missing credentials for provider "${provider}" (model "${config.modelId}").`,
      `  Stored: none in ${authFile}`,
      `  Env:    none of ${envList} are set.`,
      ``,
      `  Fix (任一即可):`,
      `    export ${envs?.[envs.length - 1] ?? "ANTHROPIC_API_KEY"}=...`,
      `    或先运行 pi 登录（写入 ~/.pi/agent/auth.json）；`,
      `    或在 ${authFile} 写入 {"${provider}":{"type":"api_key","key":"..."}}。`,
    ].join("\n"),
  );
}

interface ModelResolution {
  model: unknown;
  source: "builtin" | "custom";
  validIds: string[];
  custom?: { path: string; provider: ModelsJsonProvider };
}

function resolveModel(config: DemoConfig): ModelResolution {
  // ① 内建目录。
  try {
    const model = getBuiltinModel(config.provider as never, config.modelId as never);
    if (model) {
      const validIds = (getBuiltinModels(config.provider as never) ?? []).map((m) => m.id);
      return { model, source: "builtin", validIds };
    }
  } catch {
    // 非内建 provider（或目录读取失败）→ 尝试 models.json。
  }

  // ② 自定义 models.json。
  const custom = loadCustomProvider(config);
  if (custom.provider) {
    const entry = custom.provider.models?.find((m) => m.id === config.modelId);
    if (entry) {
      return {
        model: buildCustomModel(config.provider, entry, custom.provider, custom.path),
        source: "custom",
        validIds: custom.provider.models?.map((m) => m.id) ?? [],
        // 此处 custom.provider 已被上面的 if 收窄为非空，显式构造以匹配返回类型。
        custom: { path: custom.path, provider: custom.provider },
      };
    }
    throw new ConfigError(
      [
        `[mesh-demo] model "${config.modelId}" 不在自定义 provider "${config.provider}" 的 models[] 中。`,
        `  models.json: ${custom.path}`,
        `  可用 model id: ${(custom.provider.models ?? []).map((m) => m.id).join(", ") || "（models 为空）"}`,
      ].join("\n"),
    );
  }

  // ③ 内建与自定义都无命中 → 综合报错。
  const providers = getBuiltinProviders() as unknown as string[];
  const lines = [
    `[mesh-demo] cannot resolve model "${config.modelId}" for provider "${config.provider}".`,
  ];
  if (providers.includes(config.provider)) {
    const ids = (getBuiltinModels(config.provider as never) ?? []).map((m) => m.id);
    lines.push(`  provider "${config.provider}" 是内建 provider，但目录中没有 "${config.modelId}"。`);
    lines.push(`  可用 modelId: ${ids.join(", ")}`);
  } else {
    lines.push(`  provider "${config.provider}" 既不是内建 provider，<agentDir>/models.json 里也没有它。`);
    lines.push(`  自定义端点：写 ${customModelsPath(config)}（providers."${config.provider}"），或改用内建 provider。`);
  }
  lines.push(`  内建 provider（部分）: ${providers.slice(0, 12).join(", ")}…`);
  lines.push(`  Known-good: anthropic/claude-sonnet-4-5, anthropic/claude-opus-4-5, openai/gpt-4o`);
  throw new ConfigError(lines.join("\n"));
}

/**
 * 启动校验（§配置层 5 步）。任何一步失败即在 mesh 建立之前抛 ConfigError。
 *
 * 本面板 100% 真实：必须解析到模型 + 检测到真实 LLM 凭据，否则 fail-fast。
 * 不提供 faux / 离线 / EchoStreamPort 兜底——没有凭据就起不来，绝不假装真 LLM。
 */
export function loadAndValidateDemo(): ResolvedDemo {
  // ① Node 版本守卫（pi-ai/pi-coding-agent 需要 ≥22.19）。
  const [maj, min] = process.versions.node.split(".").map((n) => Number(n));
  if (maj! < 22 || (maj === 22 && (min ?? 0) < 19)) {
    throw new ConfigError(
      `[mesh-demo] Node 版本要求 ≥ 22.19（pi 引擎约束），当前 ${process.versions.node}。`,
    );
  }

  const config = loadConfig();

  // ② dbPath 必须是真实可写路径、且非 :memory:。
  if (config.dbPath === ":memory:") {
    throw new ConfigError(
      `[mesh-demo] dbPath 不能是 ":memory:"（会跳过实例锁/端点锁/持久化），已用 ${config.dbPath}。`,
    );
  }
  mkdirSync(dirname(config.dbPath), { recursive: true });

  // ②b stateDir 必须与 createMesh 内部推导一致（join(dirname(dbPath), "mesh")）。
  const expectedState = join(dirname(config.dbPath), "mesh");
  if (config.stateDir !== expectedState) {
    process.stderr.write(
      `[mesh-demo] 提示：stateDir "${config.stateDir}" 与 createMesh 内部 lock/session 根 "${expectedState}" 不一致，锁与会话 cwd 将错位。建议删除 MESH_DEMO_STATE_DIR 覆盖。\n`,
    );
  }
  mkdirSync(config.stateDir, { recursive: true });

  // ③ model 解析（内建 → 自定义 models.json；失败内部已抛详尽 ConfigError）。
  const { model, source, custom } = resolveModel(config);
  // ④ 凭据（无密钥不跑）。
  const credential = resolveCredentials(config, custom);
  process.stderr.write(
    `[mesh-demo] model=${config.provider}/${config.modelId} [${source}] · thinking=${config.thinkingLevel} · 凭据来源=${credential.source} · db=${config.dbPath} · stateDir=${config.stateDir}\n`,
  );
  return { config, model, credential };
}