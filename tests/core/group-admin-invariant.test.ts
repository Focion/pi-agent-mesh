// ═══════════════════════════════════════════════════════════════════════════
// I18 + C04：群管理员不变量与显式身份校验。
// - 移除/降权最后 setCaps 持有者 → NO_ADMIN_LEFT（§12.2:1651）
// - 移除持 setCaps 的目标且调用者无 dissolve → CAP_REQUIRED（§12.2:1633）
// - 非成员 `by` 的 addMember/removeMember/setCaps/dissolve → NOT_A_MEMBER（C04）
// - @system 代行豁免放行
// - createConversation 成员超 groupSizeHardCap → FANOUT_TOO_LARGE 且无半结构残留
// ═══════════════════════════════════════════════════════════════════════════

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMesh } from "../../src/index.js";
import type { Cap, MeshHost, SessionFactory } from "../../src/index.js";
import { FakeStreamPort } from "../helpers/fake-stream-port.js";

const stubSessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "grp-test" }),
  open: async () => ({ session: {} }),
};

async function makeMesh(): Promise<{ host: MeshHost; port: FakeStreamPort }> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-grp-"));
  const port = new FakeStreamPort();
  const host = await createMesh({
    dbPath: join(dir, "mesh.db"),
    policies: { sessionFactory: stubSessionFactory },
    streamPort: port,
    limits: { handoffTimeoutMs: 1000 },
    devMode: true,
  });
  return { host, port };
}

async function regAccount(host: MeshHost, id: string): Promise<void> {
  await host.registerAccount({
    id,
    displayName: id,
    endpointClass: "stream",
    initiate: ["chat"],
  });
}

describe("I18: group admin invariant", () => {
  it("removing the last setCaps holder is rejected with NO_ADMIN_LEFT", async () => {
    const { host } = await makeMesh();
    try {
      await regAccount(host, "A");
      await regAccount(host, "B");
      await regAccount(host, "C");
      const g = await host.createConversation({ type: "group", creator: "A", members: ["B", "C"] });
      // A 是唯一 setCaps 持有者；A 移除自己也不能让群失去管理员
      await expect(host.removeMember(g.id, "A", { by: "A" })).rejects.toMatchObject({
        code: "NO_ADMIN_LEFT",
      });
    } finally {
      await host.close();
    }
  });

  it("removing a setCaps holder without dissolve cap is rejected with CAP_REQUIRED", async () => {
    const { host } = await makeMesh();
    try {
      await regAccount(host, "A");
      await regAccount(host, "B");
      await regAccount(host, "C");
      const g = await host.createConversation({ type: "group", creator: "A", members: ["B", "C"] });
      // B 也成为 setCaps 持有者（非最后）；C 持 remove 但不持 dissolve
      await host.setCaps(g.id, "B", ["speak", "read", "setCaps"], "A");
      await host.setCaps(g.id, "C", ["speak", "read", "remove"], "A");
      await expect(host.removeMember(g.id, "B", { by: "C" })).rejects.toMatchObject({
        code: "CAP_REQUIRED",
      });
    } finally {
      await host.close();
    }
  });

  it("stripping the last setCaps via setCaps is rejected with NO_ADMIN_LEFT", async () => {
    const { host } = await makeMesh();
    try {
      await regAccount(host, "A");
      await regAccount(host, "B");
      const g = await host.createConversation({ type: "group", creator: "A", members: ["B"] });
      await expect(
        host.setCaps(g.id, "A", ["speak", "read"] as Cap[], "A"),
      ).rejects.toMatchObject({ code: "NO_ADMIN_LEFT" });
    } finally {
      await host.close();
    }
  });

  it("group creation over groupSizeHardCap is rejected and leaves no half-structure", async () => {
    const { host } = await makeMesh();
    try {
      await regAccount(host, "A");
      await regAccount(host, "B");
      await regAccount(host, "C");
      await expect(
        host.createConversation({
          type: "group",
          creator: "A",
          members: ["B", "C"],
          config: { groupSizeHardCap: 2 },
        }),
      ).rejects.toMatchObject({ code: "FANOUT_TOO_LARGE" });
      // 无半结构：A 名下没有任何会话
      const convs = await host.observer.conversationsOf("A");
      expect(convs).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("C04: explicit identity for admin ops", () => {
  it("non-member `by` is rejected with NOT_A_MEMBER for removeMember/setCaps/dissolve", async () => {
    const { host } = await makeMesh();
    try {
      await regAccount(host, "A");
      await regAccount(host, "B");
      await regAccount(host, "D"); // 注册但不入群
      const g = await host.createConversation({ type: "group", creator: "A", members: ["B"] });
      await expect(host.removeMember(g.id, "B", { by: "D" })).rejects.toMatchObject({
        code: "NOT_A_MEMBER",
      });
      await expect(
        host.setCaps(g.id, "B", ["speak", "read"] as Cap[], "D"),
      ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
      await expect(host.dissolve(g.id, "D")).rejects.toMatchObject({
        code: "NOT_A_MEMBER",
      });
    } finally {
      await host.close();
    }
  });

  it("@system delegated operation is allowed (no silent bypass, no false reject)", async () => {
    const { host } = await makeMesh();
    try {
      await regAccount(host, "A");
      await regAccount(host, "B");
      await regAccount(host, "D");
      const g = await host.createConversation({ type: "group", creator: "A", members: ["B"] });
      // 不带 by → 库代行 @system：允许把 D 加进群
      await host.addMember(g.id, "D", { caps: ["speak", "read"] });
      const members = await host.observer.conversationsOf("D");
      expect(members.some((m) => m.conversationId === g.id)).toBe(true);
    } finally {
      await host.close();
    }
  });
});