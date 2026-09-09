// 契约测试共享基建：真 pi + faux provider（无网络、无 LLM）。
// 每条契约测试保护一条被 SDK 实测推翻过的设计决定（F1–F5，§2.3/§23.5）——
// pi 升级后这里红一条，就是那条假设失效了，不是测试坏了。
//
// faux 模型的接法（实测结论，0.85.1）：
// compat.registerFauxProvider 只注册 api 级 stream，ModelRuntime 的
// prepareRequest 仍会以 Unknown provider 拒掉；必须把 createFauxCore 的
// streamSimple 直接注册进 session.modelRuntime（registerProvider）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPiSdk, type PiSdk } from "../../src/pi/pi-sdk.js";

export interface FauxCore {
  provider: string;
  api: string;
  getModel(): any;
  setResponses(responses: Array<unknown>): void;
  appendResponses(responses: Array<unknown>): void;
  state: { callCount: number };
}

type FauxCompat = {
  fauxAssistantMessage(content: string, opts?: { stopReason?: string }): unknown;
};

export interface PiTestSession {
  pi: PiSdk;
  session: any;
  sm: any;
  faux: FauxCore;
  dir: string;
  events: Array<{ type: string; [k: string]: unknown }>;
  dispose(): void;
}

let compatCache: FauxCompat | undefined;
let fauxModuleCache: { createFauxCore(opts?: { models?: Array<{ id: string }> }): FauxCore & { streamSimple: unknown } } | undefined;

/** pi-ai/compat（fauxAssistantMessage 等剧本工具） */
export async function loadFauxCompat(): Promise<FauxCompat> {
  if (!compatCache) {
    compatCache = (await import("@earendil-works/pi-ai/compat")) as unknown as FauxCompat;
  }
  return compatCache;
}

/** 建 faux provider 内核（不触碰全局 api 注册表，用例间天然隔离） */
export async function createFaux(modelId = "faux-1"): Promise<FauxCore> {
  if (!fauxModuleCache) {
    fauxModuleCache = (await import("@earendil-works/pi-ai/providers/faux")) as never;
  }
  return fauxModuleCache.createFauxCore({ models: [{ id: modelId }] });
}

/** 把 faux 内核注册进一个已建好的 session 的 ModelRuntime */
export function registerFauxInto(session: any, faux: FauxCore & { streamSimple?: unknown }): void {
  const model = faux.getModel();
  session.modelRuntime.registerProvider(faux.provider, {
    apiKey: "faux-test-key",
    baseUrl: "http://faux.local", // 占位：faux streamSimple 不发请求，但校验要求 baseUrl
    api: faux.api,
    streamSimple: (faux as { streamSimple?: unknown }).streamSimple,
    models: [
      {
        id: model.id,
        name: model.id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  });
}

/**
 * 真 AgentSession + inMemory SessionManager + faux 模型。
 * responses：本轮及后续轮次的脚本化应答（可用 async factory 做闸门）。
 */
export async function createPiTestSession(
  responses: Array<unknown> = [],
): Promise<PiTestSession> {
  const pi = await loadPiSdk();
  const faux = await createFaux();
  if (responses.length > 0) faux.setResponses(responses);
  const dir = mkdtempSync(join(tmpdir(), "pi-mesh-contract-"));
  const sm = pi.SessionManager.inMemory(dir);
  const { session } = await pi.createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel() as never,
    noTools: "all",
    sessionManager: sm,
  });
  registerFauxInto(session, faux);
  const events: PiTestSession["events"] = [];
  session.subscribe((e: { type: string }) => events.push(e));
  return {
    pi,
    session,
    sm,
    faux,
    dir,
    events,
    dispose() {
      try {
        session.dispose();
      } catch {
        // dispose 竞态不阻断清理
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 轮询直到条件满足（起轮 → streaming 之间有窗口，sleep 固定值会脆） */
export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor: condition not met within " + ms + "ms");
}

export function customEntries(sm: any): any[] {
  return sm.getEntries().filter((e: any) => e.type === "custom_message");
}
