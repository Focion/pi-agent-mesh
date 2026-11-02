// ═══════════════════════════════════════════════════════════════════════════
// D03(ii)（本地验收·真实 SDK + faux）：真实 session 条目级幂等（idempotencyKey ≤1）。
//
// durable 后端不再有 SessionManager 的「JSONL 行级去重」问题——DB 权幂等在路由层：
// 同 (conv, from, clientToken) 重发命中 dedup（同 messageId，dedup_hit 计数），
// 且不产生第二条投递，故 bob 的真实磁盘 session 里该 envelopeId 的 mesh.msg 只出现一次。
// D03 的 DB 唯一与重开不重复 consumed 分别由 crash-property 性质②③（tests/e2e/
// crash-property.test.ts）与 recovery e2e 窗口②（tests/e2e/recovery.test.ts）覆盖，
// 三者合成 D03 的能力等价证据。
//
// 捕获 bob 的 DurableSession（warm 时经 create 建流），用 root.entries() 全量扫描：
// 该 messageId（envelope.id ⇒ entry.data.envelopeId）的 mesh.msg 恰好 1 条。
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionFactory } from "../../src/core/types.js";
import { createMesh, type MeshHost, type SendInput } from "../../src/index.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import type { DurableSession } from "../../src/pi/durable-runtime.js";
import { createFaux, customEntries, waitFor, type DurableSessionSurface } from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("D03(ii): 真实 session 条目级幂等（idempotencyKey ≤1）", () => {
  it("同 (conv,from,clientToken) 重发得同 messageId，bob session 仅一条 mesh.msg", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-sess-idem-"));
    const dbPath = join(dir, "mesh.db");
    const faux = await createFaux("faux-idem");
    let bobSession: DurableSession | undefined;

    const inner = createPiSessionFactory({ stateDir: dir, models: faux.models, model: faux.model });
    const factory: SessionFactory = {
      async create(ctx) {
        const r = await inner.create(ctx);
        if (ctx.endpoint.accountId === "bob") bobSession = r.session as DurableSession;
        return r;
      },
      async open(ctx) {
        const r = await inner.open(ctx);
        if (ctx.endpoint.accountId === "bob") bobSession = r.session as DurableSession;
        return r;
      },
    };

    const host: MeshHost = await createMesh({
      dbPath,
      policies: { sessionFactory: factory },
      limits: { sweepIntervalMs: 0 },
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
    expect(bobSession).toBeDefined();

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

    // bob 真实磁盘 session：该 messageId（envelope.id ⇒ entry.data.envelopeId）的 mesh.msg 恰好 1 条。
    await waitFor(async () => {
      const entries = await customEntries(bobSession as unknown as DurableSessionSurface);
      const hits = entries.filter(
        (e) =>
          e.kind === "mesh.msg" &&
          (e.data as { envelopeId?: string } | undefined)?.envelopeId === r1.messageId,
      );
      return hits.length === 1;
    });

    await assertInvariants(host);
  });
});