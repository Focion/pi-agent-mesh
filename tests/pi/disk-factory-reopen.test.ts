// ═══════════════════════════════════════════════════════════════════════════
// G04(c)（本地验收·真实 SDK + faux）：mesh 级磁盘 SessionFactory.open 恢复链。
//
// 把 probe-disk-session.test.ts 的 pi 级探针升级到 mesh 级：createPiSessionFactory
// 走真实 durable storage（runtimeRef = JSON{storagePath, conversationId}），warm 时
// create / open 分支由 endpoint.runtimeRef（落进 mesh_endpoints）决定。
//
// durable 与 coding-agent 的关键差异：storage.sqlite 由 assemble 开立即建（不再有
// 「起轮后 .jsonl 才写出」的惰性门），故断言改为：
//  1. 首 warm 走 create，runtimeRef 解出的 storagePath 指向 <stateDir>/endpoints/<id>/storage.sqlite，
//     且文件已存在（durable 开 storage 即建）。
//  2. 同 dbPath 重开 host B 后 warm 走 open（不新建 session），恢复到同一 storagePath，
//     且能继续收投递。这条是崩溃恢复（W11/W13）里「session 存活则续收」的第一责任人。
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionFactory } from "../../src/core/types.js";
import { createMesh, type MeshHost } from "../../src/index.js";
import { createPiSessionFactory } from "../../src/pi/session-factory.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createFaux, waitFor, type Faux } from "../helpers/pi-session.js";
import { assertInvariants } from "../helpers/invariants.js";

interface FactoryTrace {
  creates: string[];
  opens: string[];
  createSessionFile: string | undefined;
  openSessionFile: string | undefined;
}

/** runtimeRef 的 storagePath 面（MD7：mesh-core 视作不透明，mesh-pi 在此编解码）。 */
function storagePathOf(runtimeRef: string): string {
  return (JSON.parse(runtimeRef) as { storagePath: string }).storagePath;
}

/** 包装 createPiSessionFactory：记录 create/open 分支与恢复的 session storage 路径。 */
function tracingFactory(
  inner: SessionFactory,
  trace: FactoryTrace,
): SessionFactory {
  return {
    async create(ctx) {
      trace.creates.push(ctx.endpoint.id);
      const r = await inner.create(ctx);
      trace.createSessionFile = storagePathOf(r.runtimeRef);
      return r;
    },
    async open(ctx) {
      trace.opens.push(ctx.endpoint.id);
      const r = await inner.open(ctx);
      // open 沿 runtimeRef 恢复 storage（不重新推导路径）；storage 路径即 ctx.runtimeRef 里的。
      trace.openSessionFile = storagePathOf(ctx.runtimeRef);
      return r;
    },
  };
}

async function registerWorld(host: MeshHost): Promise<{ aliceEp: string; dc: string }> {
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
  const aliceEp = (await host.registerEndpoint({ accountId: "alice", topology: { kind: "unified" } })).id;
  await host.registerEndpoint({ accountId: "bob", topology: { kind: "unified" } });
  await host.setPresence("alice", "available");
  await host.setPresence("bob", "available");
  const dc = await host.ensureDirect("alice", "bob");
  return { aliceEp, dc: dc.id as string };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("G04(c): mesh 级磁盘 SessionFactory.open 恢复链（真实 SDK + faux）", () => {
  it("首 warm 走 create（storage.sqlite），重开走 open 恢复同文件并续收", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-disk-reopen-"));
    const dbPath = join(dir, "mesh.db");
    const faux: Faux = await createFaux("faux-disk");
    faux.setResponses([fauxAssistantMessage("hi-1"), fauxAssistantMessage("hi-2")]);

    const trace: FactoryTrace = { creates: [], opens: [], createSessionFile: undefined, openSessionFile: undefined };
    const inner = createPiSessionFactory({ stateDir: dir, models: faux.models, model: faux.model });
    const factory = tracingFactory(inner, trace);

    const consumed: Array<{ id: string; partial: boolean }> = [];
    const mkHost = async (): Promise<MeshHost> => {
      const host: MeshHost = await createMesh({
        dbPath,
        policies: { sessionFactory: factory },
        devMode: true,
        limits: { sweepIntervalMs: 0 },
      });
      host.on("message_consumed", (p) =>
        consumed.push({ id: p.envelope.id, partial: p.partial }),
      );
      return host;
    };
    /** 该投递已按给定 partial 口径消费，且不再停留在 delivered（正常轮次归因，非 abort）。 */
    const expectConsumedPartial = async (
      host: MeshHost,
      messageId: string,
      partial: boolean,
    ): Promise<void> => {
      await waitFor(() => consumed.some((c) => c.id === messageId));
      expect(consumed.find((c) => c.id === messageId)?.partial).toBe(partial);
      const t = (await host.observer.trace(messageId)).find((x) => x.accountId === "alice");
      expect(t?.state).toBe("consumed");
      expect(t?.partial).toBe(partial);
    };

    // ── host A：首 warm 走 create ──
    const hostA = await mkHost();
    cleanup.push(() => hostA.close());
    cleanup.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });
    const { aliceEp, dc } = await registerWorld(hostA);

    await hostA.warm(aliceEp, "shared");
    expect(trace.creates).toEqual([aliceEp]);
    expect(trace.opens).toEqual([]);
    expect(typeof trace.createSessionFile).toBe("string");
    expect((trace.createSessionFile as string).includes(join("endpoints", aliceEp))).toBe(true);
    // durable 开 storage 即建（不再是 coding-agent 的「起轮后才写出 .jsonl」）
    expect(existsSync(trace.createSessionFile as string)).toBe(true);

    // 起一轮：bob → alice，faux 回 "hi-1"，正常轮次归因 consumed(partial=false)。
    const m1 = await hostA.send({
      from: "bob",
      conversationId: dc,
      kind: "chat",
      expect: "reply",
      to: ["alice"],
      text: "first",
    });
    await expectConsumedPartial(hostA, m1.messageId, false);

    const createSessionFile = trace.createSessionFile;
    await hostA.close();

    // ── host B：同 dbPath 重开，warm 走 open 恢复同一 storage ──
    const hostB = await mkHost();
    cleanup.push(() => hostB.close());

    await hostB.warm(aliceEp, "shared");
    // alice 的 runtimeRef 已落库 → 这次走 open，不再 create alice 的新 session。
    expect(trace.opens).toEqual([aliceEp]);
    expect(trace.creates).toEqual([aliceEp]); // 仍只有 host A 那一次 create
    expect(trace.openSessionFile).toBe(createSessionFile);

    // 续收：同一恢复 session 上再投一条，faux 回 "hi-2"，同样 partial=false。
    const m2 = await hostB.send({
      from: "bob",
      conversationId: dc,
      kind: "chat",
      expect: "reply",
      to: ["alice"],
      text: "second",
    });
    await expectConsumedPartial(hostB, m2.messageId, false);

    await assertInvariants(hostB);
  });
});