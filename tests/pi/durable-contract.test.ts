// CT-D1–CT-D11：durable 契约测试（迁移 M1 go/no-go 闸门）。
//
// 这些测试不验证 mesh 的实现，而是把计划里的「read-code 结论」变成「实测结论」：
// 每条锁住 durable 1.3.0 的一条行为（§2 映射表 / §9 F-A–F-I / R12 / R14）。上游
// 变版本时这里红一条，就是对应假设失效，而不是测试坏了。
//
// 夹具：真 @earendil-works/pi-durable + pi-ai fauxProvider（无网络、无真实 LLM）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  InboxDoc,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";

const C = BACKGROUND_CONTEXT;

/** 轮询直到条件满足（起轮 / 工具落位之间只有毫秒级窗口，sleep 固定值会脆）。 */
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: condition not met within " + ms + "ms");
}

/** 一整套 faux + models + registry + 已 resume 的 Harness + root conversation。 */
async function setup(storage: Storage) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(storage, { models, registry }, C);
  harness.resume();
  const model = faux.getModel();
  const root = await harness.root(C, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { faux, models, model, registry, harness, root };
}

/** 建一个文件-backed storage（供 reopen 类用例：CT-D3 / CT-D6 / CT-D11）。 */
async function tmpStorage() {
  const dir = mkdtempSync(join(tmpdir(), "mesh-durable-"));
  const path = join(dir, "endpoint.sqlite");
  const storage = await openNodeSqliteStorage(path);
  return { dir, path, storage };
}

describe("CT-D1 空闲 submit 当场 placed 且带 entryId", () => {
  it("idle conversation: input submit resolves `placed` with an entry", async () => {
    const { faux, root, harness } = await setup(new MemoryStorage());
    faux.setResponses([fauxAssistantMessage("hi")]);
    try {
      const sub = await root.submit(
        { type: "input", content: "hello", requestId: "d1", whenBusy: "steer" },
        C,
      );
      const st = await sub.status(C);
      expect(st.status).toBe("placed");
      expect(typeof st.entry).toBe("number");
    } finally {
      await harness.close(C);
    }
  });
});

describe("CT-D2 忙时进 pi.inbox 且文档可读", () => {
  it("busy conversation: input queues to a readable pi.inbox", async () => {
    const { faux, root, harness } = await setup(new MemoryStorage());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    faux.appendResponses([async () => (await gate, fauxAssistantMessage("late"))]);
    try {
      await root.submit({ type: "input", content: "A", requestId: "a", whenBusy: "steer" }, C);
      await waitFor(() => faux.state.callCount >= 1);

      const subB = await root.submit(
        { type: "input", content: "B", requestId: "b", whenBusy: "steer" },
        C,
      );
      expect((await subB.status(C)).status).toBe("queued");

      const inbox = await harness.snapshot(InboxDoc, root.id, C);
      expect(inbox?.items.map((i) => i.mode)).toContain("steer");
      release();
      await subB.wait(C);
    } finally {
      release?.();
      await harness.close(C);
    }
  });
});

describe("CT-D3 同 requestId 返回原 submission（含重开 Harness 后）", () => {
  it("same requestId returns the original submission record, also across reopen", async () => {
    const { dir, path, storage } = await tmpStorage();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const model = faux.getModel();

    try {
      let harness = await Harness.open(storage, { models, registry }, C);
      harness.resume();
      let root = await harness.root(C, {
        agent: { model: { provider: model.provider, modelId: model.id } },
      });
      faux.setResponses([fauxAssistantMessage("first")]);
      const sub1 = await root.submit(
        { type: "input", content: "a", requestId: "dup" },
        C,
      );
      const sub2 = await root.submit(
        { type: "input", content: "b", requestId: "dup" },
        C,
      );
      expect(sub1.id === sub2.id).toBe(true);
      await sub1.wait(C);
      await harness.close(C);

      // reopen：same models/registry，same requestId 仍返回原记录（done，不新建）
      const storage2 = await openNodeSqliteStorage(path);
      harness = await Harness.open(storage2, { models, registry }, C);
      harness.resume();
      root = await harness.root(C, {
        agent: { model: { provider: model.provider, modelId: model.id } },
      });
      const sub3 = await root.submit(
        { type: "input", content: "c", requestId: "dup" },
        C,
      );
      expect(sub3.id === sub1.id).toBe(true);
      expect((await sub3.status(C)).status).toBe("done");
      await harness.close(C);
    } finally {
      await storage.close(C).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CT-D4 display-only write 不进模型上下文；带 model 的 write 进上下文且不起轮", () => {
  it("note write has no model; model-carrying write enters context without a turn", async () => {
    const { faux, root, harness } = await setup(new MemoryStorage());
    try {
      const note = await root.submit(
        { type: "write", entry: { kind: "mesh.note", data: { n: 1 } } },
        C,
      );
      expect((await note.status(C)).status).toBe("done");

      const w = await root.submit(
        {
          type: "write",
          entry: {
            kind: "mesh.msg",
            data: { m: 1 },
            model: [{ role: "user", content: "w-body", timestamp: Date.now() }],
          },
        },
        C,
      );
      expect((await w.status(C)).status).toBe("done");

      // 两条 write 都不起轮
      expect(faux.state.callCount).toBe(0);

      const page = await root.entries({ order: "ascending" }, 100, undefined, C);
      const noteEntry = page.items.find((e) => e.kind === "mesh.note");
      const msgEntry = page.items.find((e) => e.kind === "mesh.msg");
      expect(noteEntry?.model).toBeUndefined();
      expect(msgEntry?.model).toBeDefined();
    } finally {
      await harness.close(C);
    }
  });
});

describe("CT-D5 beforeRequest 注入体进该次请求 messages 尾部且不新增条目", () => {
  it("injection lands at the tail of the request, no new transcript entry", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();

    const saw = { incoming: null as string[] | null, byModel: null as string[] | null };
    registry.install(
      defineExtension({
        name: "probe",
        hooks: [
          hook(GenerationTask, {
            async beforeRequest(req, _api, _ctx) {
              saw.incoming = req.messages.map((m) => m.role);
              return {
                messages: [
                  ...req.messages,
                  { role: "user" as const, content: "INJECTED", timestamp: Date.now() },
                ],
              };
            },
          }),
        ],
      }),
    );

    const harness = await Harness.open(new MemoryStorage(), { models, registry }, C);
    harness.resume();
    const model = faux.getModel();
    const root = await harness.root(C, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    faux.appendResponses([
      (ctx) => {
        saw.byModel = ctx.messages.map((m) =>
          typeof m.content === "string" ? m.content : String(m.content),
        );
        return fauxAssistantMessage("ok");
      },
    ]);

    try {
      const sub = await root.submit({ type: "input", content: "hello", requestId: "d5" }, C);
      await sub.wait(C);

      expect(saw.incoming).toEqual(["user"]);
      expect(saw.byModel?.at(-1)).toBe("INJECTED");

      const page = await root.entries({ order: "ascending" }, 100, undefined, C);
      expect(page.items.map((e) => e.kind)).toEqual(["pi.user", "pi.assistant"]);
    } finally {
      await harness.close(C);
    }
  });
});

describe("CT-D6 崩溃后重开 + resume() 继续未完成 run", () => {
  it("a run interrupted by crash resumes and settles after reopen+resume", async () => {
    const { dir, path, storage } = await tmpStorage();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const model = faux.getModel();

    // 第一个响应永不到达：把 run 停在「request」阶段，制造可被重开的未完成状态。
    // 重开后的重请求取第二个补答（F-I：harness.close 会 join 运行中任务，不模拟进程死亡）。
    faux.appendResponses([
      async () => (await new Promise<void>(() => {}), fauxAssistantMessage("never")),
      fauxAssistantMessage("resumed"),
    ]);

    try {
      let harness = await Harness.open(storage, { models, registry }, C);
      harness.resume();
      let root = await harness.root(C, {
        agent: { model: { provider: model.provider, modelId: model.id } },
      });
      const sub = await root.submit({ type: "input", content: "go", requestId: "d6" }, C);
      await waitFor(() => faux.state.callCount >= 1);
      expect((await sub.status(C)).status).toBe("placed");
      const subId = sub.id;
      // 崩溃：直接关 storage，让 run 的 request 断点留在盘上
      await storage.close(C).catch(() => {});

      const storage2 = await openNodeSqliteStorage(path);
      harness = await Harness.open(storage2, { models, registry }, C);
      harness.resume();
      // 重开后 run 重新发起请求（消耗第二个补答），并经 harness.submission 重取收据
      const sub2 = await harness.submission(subId, C);
      expect(sub2).toBeDefined();
      const settled = await sub2!.wait(C);
      expect(settled.status).toBe("done");
      expect(faux.state.callCount).toBeGreaterThanOrEqual(2);
      await harness.close(C);
    } finally {
      await storage.close(C).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CT-D7 memo 同名重复写返回首次值；generation 结束后不可读", () => {
  it("memo is first-writer-wins during generation and gone once terminal", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();

    let first: unknown;
    let second: unknown;
    const memoSeenAtRuntime = { taskId: null as unknown };
    registry.install(
      defineExtension({
        name: "probe",
        hooks: [
          hook(GenerationTask, {
            async beforeRequest(_req, api, _ctx) {
              (memoSeenAtRuntime.taskId as unknown) = api.taskId;
              first = await api.memo("p2.w1", "v1", C);
              second = await api.memo("p2.w1", "v2", C);
              return undefined;
            },
          }),
        ],
      }),
    );

    const harness = await Harness.open(new MemoryStorage(), { models, registry }, C);
    harness.resume();
    const model = faux.getModel();
    const root = await harness.root(C, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    faux.setResponses([fauxAssistantMessage("ok")]);

    try {
      await (await root.submit({ type: "input", content: "hi", requestId: "d7" }, C)).wait(C);

      expect(first).toBe("v1");
      expect(second).toBe("v1");

      // §9 F-B / R12：generation terminal 后 memos 被清掉
      const rec = await harness.getTask(memoSeenAtRuntime.taskId as never, C);
      expect(rec?.state.status).toBe("terminal");
      expect(rec?.memos).toBeUndefined();
    } finally {
      await harness.close(C);
    }
  });
});

describe("CT-D8 endRun 结算：run 中途落位的 steer 随 run 变 unanswered 且带 entry", () => {
  it("the placed steer carries its entry when the answering run trips model_error", async () => {
    const { faux, root, harness } = await setup(new MemoryStorage());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    faux.appendResponses([
      async () => (await gate, fauxAssistantMessage("ok")),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
    ]);
    try {
      const subA = await root.submit(
        { type: "input", content: "A", requestId: "a", whenBusy: "steer" },
        C,
      );
      await waitFor(() => faux.state.callCount >= 1);
      const subB = await root.submit(
        { type: "input", content: "B", requestId: "b", whenBusy: "steer" },
        C,
      );
      release();
      await subA.wait(C);

      // subB 在 A 的 final 边界落位后起新 run，模型返回 model_error ⇒ unanswered(带 entry)
      const settledB = await subB.wait(C);
      expect(settledB.status).toBe("unanswered");
      expect(typeof settledB.entry).toBe("number");
      expect(settledB.reason).toBe("model_error");
    } finally {
      release?.();
      await harness.close(C);
    }
  });
});

describe("CT-D9 同 requestId 对 unanswered 记录再 submit 返回原记录、不新建", () => {
  it("resubmitting the same requestId on an unanswered record is a no-op", async () => {
    const { faux, root, harness } = await setup(new MemoryStorage());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    faux.appendResponses([
      async () => (await gate, fauxAssistantMessage("ok")),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
    ]);
    try {
      await root.submit({ type: "input", content: "A", requestId: "a", whenBusy: "steer" }, C);
      await waitFor(() => faux.state.callCount >= 1);
      const subB = await root.submit(
        { type: "input", content: "B", requestId: "b", whenBusy: "steer" },
        C,
      );
      release();
      await subB.wait(C);
      expect((await subB.status(C)).status).toBe("unanswered");

      const subB2 = await root.submit(
        { type: "input", content: "B again", requestId: "b" },
        C,
      );
      expect(subB2.id === subB.id).toBe(true);
      expect((await subB2.status(C)).status).toBe("unanswered");
    } finally {
      release?.();
      await harness.close(C);
    }
  });
});

describe("CT-D10 带 model 的 write：空闲不起轮、忙时下一个边界落位", () => {
  it("idle: appended without a turn", async () => {
    const { faux, root, harness } = await setup(new MemoryStorage());
    try {
      const w = await root.submit(
        {
          type: "write",
          entry: {
            kind: "mesh.msg",
            data: {},
            model: [{ role: "user", content: "body", timestamp: Date.now() }],
          },
        },
        C,
      );
      expect((await w.status(C)).status).toBe("done");
      expect(faux.state.callCount).toBe(0);
    } finally {
      await harness.close(C);
    }
  });

  it("busy: queued, then placed at the next boundary", async () => {
    const { faux, root, harness } = await setup(new MemoryStorage());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    faux.appendResponses([async () => (await gate, fauxAssistantMessage("done"))]);
    try {
      const subA = await root.submit(
        { type: "input", content: "A", requestId: "a", whenBusy: "steer" },
        C,
      );
      await waitFor(() => faux.state.callCount >= 1);

      const w = await root.submit(
        {
          type: "write",
          entry: {
            kind: "mesh.msg",
            data: {},
            model: [{ role: "user", content: "body", timestamp: Date.now() }],
          },
        },
        C,
      );
      expect((await w.status(C)).status).toBe("queued");
      release();
      await subA.wait(C);
      await waitFor(async () => (await w.status(C)).status === "done");
    } finally {
      release?.();
      await harness.close(C);
    }
  });
});

describe("CT-D11 mesh 工具 replay:safe 后执行中崩溃重开以同一 callId 重跑", () => {
  it("a replay-safe tool reruns with the same callId after crash+reopen", async () => {
    const { dir, path, storage } = await tmpStorage();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const model = faux.getModel();

    const callIds: string[] = [];

    const crashy = defineTool({
      name: "crashy",
      description: "blocks on first call, to simulate an execution interrupted by process death",
      parameters: Type.Object({ v: Type.String() }),
      replay: "safe",
      async execute(args, api) {
        callIds.push(api.callId);
        // 首次调用「进程死亡」：永不返回，让 running 断点留在盘上。
        if (callIds.length === 1) await new Promise<void>(() => {});
        return { output: [{ type: "text" as const, text: "did " + args.v }] };
      },
    });
    registry.install(defineExtension({ name: "probe", tools: [crashy] }));

    const agent = {
      model: { provider: model.provider, modelId: model.id },
      tools: [crashy],
      modelTools: [crashy],
    };

    try {
      let harness = await Harness.open(storage, { models, registry }, C);
      harness.resume();
      let root = await harness.root(C, { agent });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("crashy", { v: "x" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("final"),
      ]);
      const sub = await root.submit({ type: "input", content: "go", requestId: "d11" }, C);
      const subId = sub.id;
      await waitFor(() => callIds.length === 1);

      // 崩溃：直接关 storage（harness.close 会 join 运行中任务）
      await storage.close(C).catch(() => {});

      const storage2 = await openNodeSqliteStorage(path);
      harness = await Harness.open(storage2, { models, registry }, C);
      harness.resume();
      root = await harness.root(C, { agent });

      // replay:safe ⇒ 重开以同一 callId 重跑（F-D / R12）
      await waitFor(() => callIds.length === 2);
      expect(callIds[1]).toBe(callIds[0]);

      const sub2 = await harness.submission(subId, C);
      const settled = await sub2!.wait(C);
      expect(settled.status).toBe("done");
      await harness.close(C);
    } finally {
      await storage.close(C).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});