// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 配置层（全真实）— 无密钥 fail-fast。
//
// 本面板只读 Mesh 配置：`demo/demo.config.json` 直接内嵌 `llm` + `runtime` 两个
// 对象（与 `createMesh({ llm, runtime })` 的公共入口同 schema）。**不再**镜像任何
// pi 配置：不读 `~/.pi/agent` 的 models.json / auth.json / settings，不查
// `@earendil-works/pi-ai` 的内建目录，不镜像 pi 的环境变量凭据表（LD2/LD4）。
// 模型 / Provider / 凭据全部收敛到 `resolveLlmConfig`（Mesh 侧 fail-fast）。
//
// 运行：bash demo/start.sh（Node ≥ 22.19 原生 type-stripping）。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MeshConfigError,
  configFingerprint,
  resolveLlmConfig,
  type LlmConfig,
  type ResolvedLlm,
  type RuntimeConfig,
} from "../../dist/index.js";

export const DEMO_VERSION = "0.1.0";

export interface DemoConfig {
  /** Mesh LLM 配置（与 createMesh 的 llm 字段同 schema） */
  llm: LlmConfig;
  /** Mesh 运行时配置（createMesh 的 runtime 字段） */
  runtime: RuntimeConfig;
  dbPath: string;
  stateDir: string;
  port: number;
}

export interface ResolvedDemo {
  config: DemoConfig;
  resolvedLlm: ResolvedLlm;
  /** {llm,runtime} 稳定指纹（已剔除 secret，LD6） */
  fingerprint: string;
  credentialSource: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 仓库根（demo/src/config.ts → ../../）——让默认路径与 cwd 无关。 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface DemoConfigFile {
  llm?: LlmConfig;
  runtime?: RuntimeConfig;
  dbPath?: string;
  stateDir?: string;
  port?: number;
  // 旧版（已废弃）顶层字段——仅用于给出迁移提示
  provider?: string;
  modelId?: string;
}

function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function readConfigFile(): DemoConfigFile {
  const explicit = envStr("MESH_DEMO_CONFIG");
  const path = explicit ?? join(ROOT, "demo", "demo.config.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DemoConfigFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    throw new ConfigError(
      `[mesh-demo] 无法解析配置文件 ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function loadConfig(): DemoConfig {
  const file = readConfigFile();

  // 旧版结构迁移提示：顶层 provider/modelId 已废弃，改由 llm.model = "providerId:modelId"。
  if (file.llm === undefined && (file.provider !== undefined || file.modelId !== undefined)) {
    throw new ConfigError(
      [
        `[mesh-demo] demo.config.json 结构已变更：`,
        `  旧字段 provider / modelId 已由 "llm": { "model": "<providerId>:<modelId>", ... } 取代；`,
        `  凭据由 "llm".{apiKey|apiKeyEnv} 或 "llm".providers."<id>".{apiKey|apiKeyEnv} 提供。`,
        `  请参照 demo/demo.config.example.json 改写（本面板不再读 ~/.pi 的 models.json / auth.json）。`,
      ].join("\n"),
    );
  }

  const portRaw = envStr("MESH_DEMO_PORT") ?? (file.port !== undefined ? String(file.port) : "8787");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`[mesh-demo] 非法端口: "${portRaw}"（须 1–65535）`);
  }

  // llm：文件为基；env 可覆盖 model / apiKey / apiKeyEnv / thinkingLevel。
  const llm: LlmConfig = {
    ...(file.llm ?? {}),
    model: envStr("MESH_DEMO_MODEL") ?? file.llm?.model ?? "anthropic:claude-sonnet-4-5",
  };
  if (envStr("MESH_DEMO_API_KEY")) llm.apiKey = envStr("MESH_DEMO_API_KEY");
  if (envStr("MESH_DEMO_API_KEY_ENV")) llm.apiKeyEnv = envStr("MESH_DEMO_API_KEY_ENV");
  if (envStr("MESH_DEMO_THINKING")) llm.thinkingLevel = envStr("MESH_DEMO_THINKING");

  const runtime: RuntimeConfig = { ...(file.runtime ?? {}) };

  // dbPath：显式覆盖（env 或文件）相对 cwd 解析；缺省用仓库内 demo/.data。
  const dbOverride = envStr("MESH_DEMO_DB") ?? file.dbPath;
  const dbPath = dbOverride ? resolve(process.cwd(), dbOverride) : join(ROOT, "demo", ".data", "mesh.db");

  const stateOverride = envStr("MESH_DEMO_STATE_DIR") ?? file.stateDir;
  const stateDir = stateOverride
    ? resolve(process.cwd(), stateOverride)
    : join(dirname(dbPath), "mesh");

  return { llm, runtime, dbPath, stateDir, port };
}

/**
 * 启动校验（无密钥 fail-fast）。任何一步失败即在 mesh 建立之前抛 ConfigError /
 * MeshConfigError。本面板 100% 真实，不提供 faux / 离线兜底。
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

  // ③ llm 解析 + 凭据 fail-fast（Mesh 侧；坏模型/缺凭据/坏 api 在此抛 MeshConfigError）。
  const resolvedLlm = resolveLlmConfig(config.llm);
  const fingerprint = configFingerprint(resolvedLlm, config.runtime);

  process.stderr.write(
    `[mesh-demo] llm=${resolvedLlm.providerId}/${resolvedLlm.modelId}` +
      ` · thinking=${resolvedLlm.thinkingLevel ?? "default"}` +
      ` · 内建工具=[${(config.runtime.builtinTools ?? []).join(", ") || "无"}]` +
      ` · 凭据来源=${resolvedLlm.credential.source} · db=${config.dbPath} · stateDir=${config.stateDir}\n`,
  );

  return {
    config,
    resolvedLlm,
    fingerprint,
    credentialSource: resolvedLlm.credential.source,
  };
}