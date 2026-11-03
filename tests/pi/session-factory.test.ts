// ═══════════════════════════════════════════════════════════════════════════
// session-factory 集成测试（durable 后端）：真 pi-durable + faux，无网络无 LLM。
//
// durable（LD1/LD2）不再有 coding-agent 的内建工具目录(models.json/settings ~/.pi)
// 与 modelsPath 隔离——模型要么来自 pi-ai 的捆绑目录(builtin)，要么由 mesh 用
// in-memory 凭据库 + createProvider 显式装配，根本不读 ~/.pi。故旧 L2/L4/L5 的
// 「隔离/白名单」语义退位为：
//   - LD2（createAssembledSessionFactory）产出 DurableSession（root+harness+registry）
//     且 runtimeRef 非空；模型不存在 → MESH_UNKNOWN_MODEL fail-fast（buildModels）
//   - LD1（createPiSessionFactory 高级路径）产出 DurableSession；mesh 工具经 bridgeTools
//     注入（tool 确实可执行见 mesh-tool-turn.test.ts / durable-contract.test.ts）
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionFactory } from "../../src/core/types.js";
import { resolveLlmConfig } from "../../src/pi/llm-config.js";
import {
  buildDurableSettings,
  createAssembledSessionFactory,
  createPiSessionFactory,
} from "../../src/pi/session-factory.js";
import { createFaux } from "../helpers/pi-session.js";

// 一个最小 mesh 工具（pi 只在意 name/description/parameters/execute）
const meshTool = {
  name: "mesh_send",
  description: "send",
  parameters: { type: "object" as const, properties: {}, additionalProperties: false },
  execute: async () => ({ content: "{}" }),
};

/** 端点/账号最简占位（factory 只用 endpoint.id 与 tools） */
const ctx = (id = "e1", tools: unknown[] = [meshTool]) => ({
  endpoint: { id, accountId: "a1" } as never,
  account: {} as never,
  tools: tools as never,
});

function assertDurableSession(session: unknown): void {
  const s = session as { root?: unknown; harness?: unknown; registry?: unknown; close?: unknown };
  expect(s.root).toBeDefined();
  expect(s.harness).toBeDefined();
  expect(s.registry).toBeDefined();
  expect(typeof s.close).toBe("function");
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-sf-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe("LD1 高级路径（createPiSessionFactory + faux）", () => {
  it("create 产出 DurableSession + 非空 runtimeRef", async () => {
    const dir = tmp();
    const faux = await createFaux("faux-sf");
    const factory = createPiSessionFactory({ stateDir: dir, models: faux.models, model: faux.model });
    const { session, runtimeRef } = await factory.create(ctx());
    expect(typeof runtimeRef).toBe("string");
    expect(runtimeRef.length).toBeGreaterThan(0);
    assertDurableSession(session);
    await (session as { close(): Promise<void> }).close();
  });
});

describe("LD2 缺省装配（createAssembledSessionFactory）", () => {
  it("自定义 provider 配置 → create 产出 DurableSession + runtimeRef", async () => {
    const dir = tmp();
    const factory = await createAssembledSessionFactory({
      stateDir: dir,
      llm: resolveLlmConfig({
        model: "myllm:gpt-4-mini",
        providers: { myllm: { baseUrl: "https://api.example.com/v1", api: "openai-completions" } },
        apiKey: "sk-test",
      }),
    });
    const { session, runtimeRef } = await factory.create(ctx());
    expect(typeof runtimeRef).toBe("string");
    expect(runtimeRef.length).toBeGreaterThan(0);
    assertDurableSession(session);
    await (session as { close(): Promise<void> }).close();
  });

  it("内建 provider 配置 → 经捆绑目录解析（不读 models.json）", async () => {
    const dir = tmp();
    const factory = await createAssembledSessionFactory({
      stateDir: dir,
      llm: resolveLlmConfig({ model: "anthropic:claude-opus-5-5", apiKey: "sk-test" }),
    });
    const { session } = await factory.create(ctx());
    assertDurableSession(session);
    await (session as { close(): Promise<void> }).close();
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

describe("pi 1.5：progress.persistWithinMs 映射（buildDurableSettings）", () => {
  it("未提供 runtime / 未设置字段 → 恒传 progress.persistWithinMs 0（保持旧版落盘强度）", () => {
    expect(buildDurableSettings(undefined)).toEqual({ progress: { persistWithinMs: 0 } });
    expect(buildDurableSettings({})).toEqual({ progress: { persistWithinMs: 0 } });
  });

  it("显式 progressPersistWithinMs 透传；retry/timeout/compaction 映射不变", () => {
    expect(buildDurableSettings({ progressPersistWithinMs: 1000 }).progress).toEqual({
      persistWithinMs: 1000,
    });
    expect(
      buildDurableSettings({ timeout: 5000, progressPersistWithinMs: 1000 }),
    ).toEqual({
      progress: { persistWithinMs: 1000 },
      stream: { timeoutMs: 5000 },
    });
    expect(buildDurableSettings({ retry: { enabled: true, maxRetries: 2 } })).toEqual({
      progress: { persistWithinMs: 0 },
      retry: { enabled: true, maxRetries: 2 },
    });
  });
});

describe("pi 1.5 启动顺序：factory 不 resume，由端口 warm 末尾 resume", () => {
  it("factory create/open 不调用 harness.resume（调度保持 paused，resume 归 port warm 末尾）", async () => {
    const dir = tmp();
    const faux = await createFaux("faux-order");
    const base = createPiSessionFactory({ stateDir: dir, models: faux.models, model: faux.model });
    let resumeCalls = 0;
    const wrapResume = (session: unknown): void => {
      const harness = (session as { harness: { resume(): void } }).harness;
      const orig = harness.resume.bind(harness);
      harness.resume = () => {
        resumeCalls += 1;
        orig();
      };
    };
    const spying: SessionFactory = {
      create: async (c) => {
        const r = await base.create(c);
        wrapResume(r.session);
        return r;
      },
      open: async (c) => {
        const r = await base.open(c);
        wrapResume(r.session);
        return r;
      },
    };
    const { session, runtimeRef } = await spying.create(ctx());
    expect(runtimeRef).toBeTruthy();
    expect(resumeCalls).toBe(0); // factory 不 resume（pi 1.5：submit 等进度调用会隐式 resume，但工厂本身不得启用调度）
    await (session as { close(): Promise<void> }).close();
    expect(resumeCalls).toBe(0);
  });
});