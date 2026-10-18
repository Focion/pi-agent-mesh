// ═══════════════════════════════════════════════════════════════════════════
// G04(b)（本地验收·真实 SDK + faux）：abort → consumed(partial) 的归因口径。
//
// 保护的设计决定（实测 pi 1.1.0，与计划「若 turn_end 与 aborted 成对 ⇒ partial=false」
// 的预判不同，故把三件事实逐一钉死，供 W11 归因决策参考）：
//
//   1. abort → in-flight 流收到 signal → turn_end 照常点亮（paired），随后 agent_end →
//      agent_settled{aborted:true}。abort 不会把轮次静默悬着。
//   2. 但「成对」并不自动消费：stream-port 的消费归因点在 agent_settled，以其 aborted
//      分派——aborted:true 走「留 delivered」、不触发 mailbox.handleTurnEnd（那是正常轮次
//      partial=false 的归因），故投递停在 delivered。
//   3. 该 delivered 行由 reconcile 关闭：重新 warm（与崩溃重开走同一
//      mailbox.reconcileDeliveredForEndpoint → markConsumedPartial）后变为
//      consumed(partial=true)。types.ts 里 DeliveryTrace.partial 注明「只由 abort 造成」，
//      markConsumedPartial（mailbox.ts:1892）正是 partial=true 唯一来源。
//
// PiStreamPort 暴露的是窄化后的 PiSessionLike（无 abort），所以本测试经包装
// SessionFactory 闭包捕获 raw AgentSession.abort()；挂起响应用对 abort signal 感知的
// factory，令 rawSession.abort() 能真正终止模型调用。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionFactory } from "../../src/core/types.js";
import { createMesh, type MeshHost } from "../../src/index.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import {
  createFaux,
  registerFauxInto,
  waitFor,
  type FauxCore,
} from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

interface RawPiSession {
  abort(): Promise<void>;
  subscribe(listener: (e: { type: string; aborted?: boolean }) => void): () => void;
}

interface Captured {
  session: RawPiSession | undefined;
  events: Array<{ type: string; aborted?: boolean }>;
}

/** 包装 createPiSessionFactory：注入 faux + 捕获 raw session（拿 abort）并记录会话事件。 */
function wrapFactory(
  inner: SessionFactory,
  faux: FauxCore,
  captured: Captured,
): SessionFactory {
  const hook = (session: unknown): void => {
    registerFauxInto(session, faux);
    const s = session as { subscribe?: RawPiSession["subscribe"] };
    captured.session = session as RawPiSession;
    s.subscribe?.((e) => captured.events.push(e));
  };
  return {
    async create(ctx) {
      const r = await inner.create(ctx);
      hook(r.session);
      return r;
    },
    async open(ctx) {
      const r = await inner.open(ctx);
      hook(r.session);
      return r;
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("G04(b): abort → consumed(partial=true)（真实 SDK + faux）", () => {
  it("挂起轮次 abort：agent_settled{aborted:true} + turn_end 成对，投递经 reconcile 落 consumed(partial=true)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-abort-partial-"));
    const faux = await createFaux("faux-abort");
    // 挂起但感知 abort signal：abort 时 reject，令 stream 结束、turn_end 收尾。
    faux.setResponses([
      (_ctx: unknown, opts: { signal?: AbortSignal } | undefined) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted-by-signal")),
          );
        }),
    ]);

    const captured: Captured = { session: undefined, events: [] };
    const inner = createPiSessionFactory({
      stateDir: dir,
      agentDir: dir,
      model: faux.getModel(),
      tools: [],
    });
    const factory = wrapFactory(inner, faux, captured);

    const host: MeshHost = await createMesh({
      dbPath: join(dir, "mesh.db"),
      policies: { sessionFactory: factory },
      devMode: true,
      // 关掉周期 sweep，避免 reconcile 在断言窗口内提前触发（归因点可复现）。
      limits: { sweepIntervalMs: 0 },
    });
    cleanup.push(() => host.close());
    cleanup.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });

    await host.registerAccount({
      id: "alice",
      displayName: "Alice",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    await host.registerAccount({
      id: "bob",
      displayName: "Bob",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    const aliceEp = await host.registerEndpoint({ accountId: "alice", topology: { kind: "unified" } });
    await host.registerEndpoint({ accountId: "bob", topology: { kind: "unified" } });
    await host.setPresence("alice", "available");
    await host.setPresence("bob", "available");
    const dc = await host.ensureDirect("alice", "bob");

    await host.warm(aliceEp.id, "shared");

    const consumed: Array<{ messageId: string; partial: boolean }> = [];
    host.on("message_consumed", (p) =>
      consumed.push({ messageId: p.envelope.id, partial: p.partial }),
    );

    // bob → alice（steer，起真实轮次），模型调用挂起 ⇒ turn 停在执行中。
    // 不得 await host.send——deliver 的 entrySeen 要等 message_end(custom)/turn_end 触发
    // syncEntries 才 resolve，而模型恒挂起时该事件只在 abort 收尾后到来。先点火、等模型
    // 调用发出、再 abort，最后再收 host.send 的返回（此时 entry 已镜像）。
    const sendPromise = host.send({
      from: "bob",
      conversationId: dc.id,
      kind: "chat",
      expect: "reply",
      to: ["alice"],
      text: "hello alice",
    });

    // 等真实模型调用已发（此时 turn 已启动、模型挂在流上）。
    await waitFor(() => faux.state.callCount >= 1);
    expect(captured.session).toBeDefined();

    // abort：终止挂起中的模型调用。
    await captured.session!.abort();

    // ── 事实 1：abort → agent_settled{aborted:true} + turn_end 成对 ──
    await waitFor(() => captured.events.some((e) => e.type === "agent_settled"));
    const settled = captured.events.find((e) => e.type === "agent_settled");
    expect(settled?.aborted).toBe(true);
    expect(captured.events.some((e) => e.type === "turn_end")).toBe(true);

    const sent = await sendPromise;

    // ── 事实 2：成对 ≠ 自动消费。turn_end 只消费 delivered 行，abort 场景里
    //    镜像落在 turn_end 之后 → 投递停在 delivered（partial=false），未误标 partial=false 消费 ──
    let trace = (await host.observer.trace(sent.messageId)).find(
      (t) => t.accountId === "alice",
    );
    expect(trace?.state).toBe("delivered");
    expect(trace?.partial).toBe(false);
    expect(consumed.some((c) => c.messageId === sent.messageId && c.partial === false)).toBe(false);

    // ── 事实 3：reconcile 关闭（与崩溃重开同源）→ consumed(partial=true) ──
    await host.warm(aliceEp.id, "shared");
    await waitFor(() => consumed.some((c) => c.messageId === sent.messageId && c.partial === true));
    trace = (await host.observer.trace(sent.messageId)).find(
      (t) => t.accountId === "alice",
    );
    expect(trace?.state).toBe("consumed");
    expect(trace?.partial).toBe(true);

    await assertInvariants(host);
  });
});