// ═══════════════════════════════════════════════════════════════════════════
// session-factory 集成测试（W00-L2/L4/L5）：真 SDK + faux，无网络无 LLM。
//
// L4（隔离装配）：createAssembledSessionFactory 用内存凭据库 + modelsPath:null +
//   内存 SettingsManager + DefaultResourceLoader 全 no*，绝不读 ~/.pi/agent。
// L5（工具白名单）：runtime.builtinTools:[] 产生「无内建、Mesh 工具完整」；
//   开单个内建只多出其名。语义用真实 SDK 的 getCallableToolsFn 断言。
// L2（失败基线）：临时 HOME 预置冲突的 models/auth/settings/extension 配置，
//   断言装配结果不受影响（回归护栏）。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLlmConfig } from "../../src/pi/llm-config.js";
import {
  createAssembledSessionFactory,
  createPiSessionFactory,
} from "../../src/pi/session-factory.js";
import {
  createFaux,
  loadFauxCompat,
  registerFauxInto,
  waitFor,
} from "../helpers/pi-session.js";

// 一个最小 mesh 工具（pi 只在意 name/inputSchema/handler）
const meshTool = {
  name: "mesh_send",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  handler: async () => ({ ok: true }),
};

/** 端点/账号最简占位（factory 只用 endpoint.id 与 tools） */
const ctx = (id = "e1", tools: unknown[] = [meshTool]) => ({
  endpoint: { id } as never,
  account: {} as never,
  tools: tools as never,
});

const callableNames = async (session: unknown): Promise<string[]> => {
  const s = session as { extensionRunner: { getCallableToolsFn(): Promise<Array<{ name: string }>> } };
  return (await s.extensionRunner.getCallableToolsFn()).map((t) => t.name).sort();
};

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-sf-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe("L5 工具白名单（createPiSessionFactory 高级路径 + 真实 SDK）", () => {
  it("builtinTools 缺省（tools:[]）→ 只有 Mesh 工具，无任何内建", async () => {
    const dir = tmp();
    const factory = createPiSessionFactory({ stateDir: dir, agentDir: dir, tools: [] });
    const { session } = await factory.create(ctx());
    expect(await callableNames(session)).toEqual(["mesh_send"]);
    (session as { dispose?: () => void })?.dispose?.();
  });

  it("tools:[\"read\"] → 只多出 read（不含 bash/write 等其它内建）", async () => {
    const dir = tmp();
    const factory = createPiSessionFactory({ stateDir: dir, agentDir: dir, tools: ["read"] });
    const { session } = await factory.create(ctx());
    expect(await callableNames(session)).toEqual(["mesh_send", "read"]);
    (session as { dispose?: () => void })?.dispose?.();
  });

  it("多 Mesh 工具全量进入白名单", async () => {
    const dir = tmp();
    const factory = createPiSessionFactory({ stateDir: dir, agentDir: dir, tools: [] });
    const t2 = { ...meshTool, name: "mesh_history" };
    const { session } = await factory.create(ctx("e1", [meshTool, t2]));
    expect(await callableNames(session)).toEqual(["mesh_history", "mesh_send"]);
    (session as { dispose?: () => void })?.dispose?.();
  });
});

describe("工厂装配 → 真实 turn 管线（faux）", () => {
  // 说明：起初曾误以为「faux 的 streamSimple 无法处理带工具定义的调用」——该结论已由
  // probe-hooks 矩阵 B 与 mesh-tool-turn.test.ts 推翻：用 compat.fauxAssistantMessage(
  // [compat.fauxToolCall(name, args)], { stopReason:"tool_use" }) 脚本化真实 tool_call，
  // 可在 faux 下点亮 tool_call / tool_execution_*。此处仍保留「空工具集」这一最小管线用例，
  // 专门断言 create→turn→事件 装配本身（磁盘 SessionManager + spawn）无需工具即可成立。
  it("空工具集端点经 createPiSessionFactory 起轮、返回、落定", async () => {
    const dir = tmp();
    const faux = await createFaux("faux-1");
    const compat = await loadFauxCompat();
    faux.setResponses([compat.fauxAssistantMessage("hi")]);
    const factory = createPiSessionFactory({ stateDir: dir, agentDir: dir, model: faux.getModel(), tools: [] });
    const { session, piSessionId } = await factory.create(ctx("e1", []));
    expect(typeof piSessionId).toBe("string");
    const s = session as {
      sendCustomMessage(m: unknown, o: unknown): Promise<unknown>;
      subscribe(l: (e: { type: string }) => void): () => void;
      isIdle: boolean;
      dispose(): void;
    };
    registerFauxInto(s, faux);
    const seen: string[] = [];
    s.subscribe((e) => seen.push(e.type));
    await s.sendCustomMessage(
      { customType: "mesh.msg", content: "wake", display: true },
      { triggerTurn: true },
    );
    await waitFor(() => s.isIdle && seen.includes("agent_settled"));
    expect(faux.state.callCount).toBeGreaterThan(0);
    s.dispose();
  });
});

describe("L4 隔离装配（createAssembledSessionFactory）", () => {
  it("自定义 provider 配置 → 模型在 modelsPath:null 下解析，create 产出 session + 白名单", async () => {
    const dir = tmp();
    const factory = await createAssembledSessionFactory({
      stateDir: dir,
      llm: resolveLlmConfig({
        model: "myllm:gpt-4-mini",
        providers: { myllm: { baseUrl: "https://api.example.com/v1", api: "openai-completions" } },
        apiKey: "sk-test",
      }),
      runtime: { builtinTools: [] },
    });
    const { session, piSessionId } = await factory.create(ctx());
    expect(typeof piSessionId).toBe("string");
    expect(piSessionId.length).toBeGreaterThan(0);
    expect(await callableNames(session)).toEqual(["mesh_send"]);
    (session as { dispose?: () => void })?.dispose?.();
  });

  it("内建 provider 配置 → 经捆绑目录解析（不读 models.json）", async () => {
    const dir = tmp();
    const factory = await createAssembledSessionFactory({
      stateDir: dir,
      llm: resolveLlmConfig({ model: "anthropic:claude-opus-5-5", apiKey: "sk-test" }),
      runtime: { builtinTools: ["read"] },
    });
    const { session } = await factory.create(ctx());
    expect(await callableNames(session)).toEqual(["mesh_send", "read"]);
    (session as { dispose?: () => void })?.dispose?.();
  });

  it("模型不存在 → MESH_UNKNOWN_MODEL fail-fast", async () => {
    const dir = tmp();
    await expect(
      createAssembledSessionFactory({
        stateDir: dir,
        llm: resolveLlmConfig({ model: "anthropic:no-such-model", apiKey: "sk-test" }),
      }),
    ).rejects.toThrow(/MESH_UNKNOWN_MODEL/);
  });
});

describe("L2 失败基线：临时 HOME 冲突配置不影响装配", () => {
  it("预置 models/auth/settings/extension 冲突文件后，装配与工具白名单仍按 Mesh 配置", async () => {
    const home = tmp();
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      // 冲突 models.json：把 anthropic 指向假的 providerId
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({ registry: { models: [{ id: "conflict-model", providers: ["conflict-provider"] }] } }),
      );
      // 冲突 auth.json：塞一个别的 provider 的 API key
      writeFileSync(join(agentDir, "auth.json"), JSON.stringify([{ providerId: "conflict-provider", type: "api_key", key: "should-never-be-read" }]));
      // 冲突 settings.json：默认模型与默认内建工具被 Mesh 禁掉
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "conflict-provider/conflict-model", defaultTools: ["bash", "write", "execute"] }));
      // 冲突 extension/skill/prompt 文件目录
      mkdirSync(join(agentDir, "extensions"), { recursive: true });
      mkdirSync(join(agentDir, "skills"), { recursive: true });
      mkdirSync(join(agentDir, "instructions"), { recursive: true });
      writeFileSync(join(agentDir, "instructions", "SYSTEM.md"), "conflict system prompt");

      const stateDir = tmp();
      const factory = await createAssembledSessionFactory({
        stateDir,
        llm: resolveLlmConfig({ model: "anthropic:claude-opus-5-5", apiKey: "sk-ok" }),
        runtime: { builtinTools: [] },
      });
      const { session } = await factory.create(ctx());
      // 内建工具未因 settings.defaultTools 泄漏；模型未因 conflict models.json 而失败
      expect(await callableNames(session)).toEqual(["mesh_send"]);
      (session as { dispose?: () => void })?.dispose?.();
    } finally {
      process.env.HOME = prev;
    }
  });
});