// ═══════════════════════════════════════════════════════════════════════════
// D03(ii)（本地验收·真实 SDK + faux）：真实 session 条目级幂等（idempotencyKey ≤1）。
//
// JSONL 是 pi 自有会话文件、mesh 不拥有其格式，故不承诺「JSONL 文件行级去重」；
// 这里钉死能力等价的那条：同 (conv, from, clientToken) 重发命中 DB 幂等（同一个
// messageId，dedup_hit 计数），且不产生第二条自定义条目——bob 的真实磁盘 session 里
// 该 envelopeId 的 custom_message 只出现一次。D03 的 DB 唯一与重开不重复 consumed
// 分别由 crash-property 性质②③（tests/e2e/crash-property.test.ts）与 recovery e2e
// 窗口②（tests/e2e/recovery.test.ts）覆盖，三者合成 D03 的能力等价证据。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionFactory } from "../../src/core/types.js";
import { createMesh, type MeshHost, type SendInput } from "../../src/index.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import { createFaux, customEntries, registerFauxInto } from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("D03(ii): 真实 session 条目级幂等（idempotencyKey ≤1）", () => {
  it("同 (conv,from,clientToken) 重发得同 messageId，bob session 仅一条自定义条目", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-sess-idem-"));
    const dbPath = join(dir, "mesh.db");
    const faux = await createFaux("faux-idem");
    let bobSM: { getEntries(): unknown[] } | undefined;

    const inner = createPiSessionFactory({ stateDir: dir, agentDir: dir, model: faux.getModel(), tools: [] });
    const factory: SessionFactory = {
      async create(ctx) {
        const r = await inner.create(ctx);
        registerFauxInto(r.session, faux);
        if (ctx.endpoint.accountId === "bob") bobSM = (r.session as unknown as { sessionManager: { getEntries(): unknown[] } }).sessionManager;
        return r;
      },
      async open(ctx) {
        const r = await inner.open(ctx);
        registerFauxInto(r.session, faux);
        if (ctx.endpoint.accountId === "bob") bobSM = (r.session as unknown as { sessionManager: { getEntries(): unknown[] } }).sessionManager;
        return r;
      },
    };

    const host: MeshHost = await createMesh({
      dbPath,
      policies: { sessionFactory: factory },
      limits: { handoffTimeoutMs: 1000, sweepIntervalMs: 0 },
      devMode: true,
    });
    cleanup.push(() => host.close());
    cleanup.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });

    await host.registerAccount({ id: "alice", displayName: "Alice", endpointClass: "stream", initiate: ["chat"] });
    await host.registerAccount({ id: "bob", displayName: "Bob", endpointClass: "stream", initiate: ["chat"] });
    const aliceEp = (await host.registerEndpoint({ accountId: "alice", topology: { kind: "unified" } })).id;
    const bobEp = (await host.registerEndpoint({ accountId: "bob", topology: { kind: "unified" } })).id;
    await host.setPresence("alice", "available");
    await host.setPresence("bob", "available");
    await host.warm(aliceEp, "shared");
    await host.warm(bobEp, "shared");
    const dc = await host.ensureDirect("alice", "bob");
    expect(bobSM).toBeDefined();

    const clientToken = "ct:idem:1";
    const send = (text: string) =>
      host.send({
        from: "alice",
        conversationId: dc.id,
        kind: "chat",
        expect: "none",
        to: ["bob"],
        text,
        clientToken,
      } as SendInput & { from: string; clientToken: string });

    const r1 = await send("first");
    const r2 = await send("second (same clientToken)");
    expect(r2.messageId).toBe(r1.messageId);

    // dedup 命中计数：第二次 send 走 findIdempotentDup 快路径，不重新路由/投递。
    expect((await host.observer.counters())["dedup_hit"] ?? 0).toBeGreaterThanOrEqual(1);

    // bob 真实磁盘 session：该 messageId（envelope.id 序列化进条目）的 custom_message 恰好 1 条。
    const entries = customEntries(bobSM!).filter((e) => JSON.stringify(e).includes(r1.messageId));
    expect(entries.length).toBe(1);

    await assertInvariants(host);
  });
});