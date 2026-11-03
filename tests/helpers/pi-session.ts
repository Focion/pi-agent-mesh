// 契约测试共享基建：真 pi-durable + faux provider（无网络、无 LLM）。
//
// durable 时代（MD1/OQ3）不再有 coding-agent 的 SessionManager / modelRuntime /
// extensionRunner。faux 模型走 pi-ai 公开的 `fauxProvider()` + `createModels()`：
// `createFaux` 产出「一个 provider 已挂好的 Models + 一道 ModelRef」，直接喂给
// `createPiSessionFactory({ stateDir, models, model })`（高级/低层路径），或用
// `createAssembledSessionFactory` 走缺省装配。脚本化应答用 pi-ai 的
// `fauxAssistantMessage` / `fauxToolCall`（见 tests/pi/durable-contract.test.ts）。
import {
  createModels,
  fauxProvider,
  type FauxProviderHandle,
  type Models,
} from "@earendil-works/pi-ai";

/** 一个 provider 已挂好的 faux 装配：喂给 createPiSessionFactory 的 models + model。 */
export interface Faux {
  /** pi-ai Models（faux provider 已 setProvider 进去）。 */
  readonly models: Models;
  /** ModelRef（provider + modelId），agent 装配用它。 */
  readonly model: { provider: string; modelId: string };
  readonly provider: FauxProviderHandle["provider"];
  readonly state: FauxProviderHandle["state"];
  setResponses(responses: Parameters<FauxProviderHandle["setResponses"]>[0]): void;
  appendResponses(responses: Parameters<FauxProviderHandle["appendResponses"]>[0]): void;
  getModel(): ReturnType<FauxProviderHandle["getModel"]>;
  callCount(): number;
}

/** 建 faux 装配（不触碰全局 provider 注册表，用例间天然隔离）。 */
export async function createFaux(modelId = "faux-1"): Promise<Faux> {
  const faux = fauxProvider({ models: [{ id: modelId }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return {
    models,
    model: { provider: model.provider, modelId: model.id },
    provider: faux.provider,
    state: faux.state,
    setResponses: (r) => faux.setResponses(r),
    appendResponses: (r) => faux.appendResponses(r),
    getModel: () => faux.getModel(),
    callCount: () => faux.state.callCount,
  };
}

/** 轮询直到条件满足（起轮 / 工具落位之间只有毫秒级窗口，sleep 固定值会脆）。条件可为异步。 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: condition not met within " + ms + "ms");
}

/** durable 会话面：会话里可读的转录条目（structural，避免把 pi-durable 类型拖进 core 契约背景）。 */
export interface DurableSessionSurface {
  root: {
    entries(
      opts: { order: "ascending" | "descending" },
      limit: number,
      cursor?: unknown,
      ctx?: unknown,
    ): Promise<{ items: Array<{ id: number; kind: string; data?: unknown }>; next?: unknown }>;
  };
  ctx?: unknown;
}

/**
 * 最小可过 durable-port `narrowDurableSession` 的假会话（无真 pi）。锁/租约/超时类
 * 用例只需 warm 成功与 deliver 落一个当场 done 的 submission，不需要真实转录。
 * pi 1.5：narrow 检查 harness.observeCommits / harness.resume / harness.closed，
 * 不再检查 root.watch（观察改走提交观察）。
 */
export function fakeDurableSession(): unknown {
  return {
    ctx: {},
    root: {
      submit: async () => ({ status: async () => ({ status: "done", entry: 1 }) }),
      watch: async () => ({
        value: { entries: [], docs: {} },
        start: () => {},
        stop: async () => {},
      }),
      entries: async () => ({ items: [], next: undefined }),
      waitForIdle: async () => {},
    },
    registry: { install: () => {} },
    harness: {
      observeCommits: () => ({ detach: () => {} }),
      resume: () => {},
      closed: new Promise<never>(() => {}),
    },
    configure: async () => {},
    close: async () => {},
  };
}

/** 读会话全部条目（升序全量），供「某 envelopeId 的 mesh.msg 恰好 N 条」这类断言。 */
export async function customEntries(session: DurableSessionSurface): Promise<
  Array<{ id: number; kind: string; data?: unknown }>
> {
  const out: Array<{ id: number; kind: string; data?: unknown }> = [];
  let cursor: unknown;
  for (;;) {
    const page = await session.root.entries({ order: "ascending" }, 1000, cursor, session.ctx);
    out.push(...page.items);
    if (!page.next) break;
    cursor = page.next;
  }
  return out;
}