// L5 工具面测试：14 工具装配、身份闭包、8KB 双向截断、固定文案、
// caps 门（I8）、结构化错误、P3/P4 延期映射。
import { describe, expect, it } from "vitest";
import type {
  ConversationAdminOp,
  ContactRow,
  MemberRow,
  ToolContext,
} from "../../src/core/contracts.js";
import {
  buildToolSet,
  checkToolCopy,
  MESH_TOOL_NAMES,
  parseToolContent,
} from "../../src/core/tools.js";
import type {
  Account,
  Conversation,
  ConversationSummary,
  Envelope,
  InboxView,
  SendInput,
  ToolDefinition,
} from "../../src/core/types.js";
import { MeshRejectError, MeshUnsupportedError } from "../../src/core/types.js";

const NOW = "2026-02-01T00:00:00.000Z";

// ─── 夹具 ─────────────────────────────────────────────────────────────────

const CONV_ADMIN_HOLDER: ConversationSummary = {
  conversationId: "c_group",
  kind: "group",
  title: "g",
  state: "active",
  memberCount: 3,
  myCaps: ["speak", "read", "invite", "remove", "setCaps", "setTopic"],
  lastSeq: 9,
  lastAt: NOW,
};

const CONV_PLAIN_MEMBER: ConversationSummary = {
  ...CONV_ADMIN_HOLDER,
  myCaps: ["speak", "read"],
};

const CONV_TOPIC: ConversationSummary = {
  conversationId: "c_topic",
  kind: "topic",
  title: "t",
  state: "active",
  myCaps: [],
  lastSeq: 4,
  lastAt: NOW,
};

const MEMBERS: MemberRow[] = [
  {
    accountId: "acct_me",
    displayName: "Me",
    caps: ["speak", "read"],
    presence: "available",
  },
  {
    accountId: "acct_alice",
    displayName: "Alice",
    caps: ["speak", "read", "setCaps"],
    presence: "available",
  },
  {
    accountId: "acct_bob",
    displayName: "Bob",
    caps: ["speak", "read"],
    presence: "offline",
  },
];

const INBOX: InboxView = {
  conversations: [
    {
      conversationId: "c_group",
      kind: "group",
      topic: "g",
      unread: 3,
      overflow: 5,
      summary: "5 older messages folded",
      recent: [
        {
          seq: 9,
          from: "acct_alice",
          name: "Alice",
          preview: "hello there…",
          mentionsMe: false,
          expectsMyAck: false,
        },
      ],
      verbatim: true,
      lastSeq: 9,
      lastAt: NOW,
    },
    {
      conversationId: "d_1",
      kind: "direct",
      peer: "acct_alice",
      unread: 1,
      recent: [],
      verbatim: false,
      lastSeq: 2,
      lastAt: NOW,
    },
  ],
  awaitingMyAck: [
    {
      correlationId: "corr_1",
      from: "acct_alice",
      intent: "ping",
      deadlineIn: "18s",
    },
  ],
  awaitingTheirAck: [
    { correlationId: "corr_2", to: "acct_bob", deadlineIn: "2m" },
  ],
};

const ACCOUNTS: Account[] = [
  {
    id: "acct_alice",
    displayName: "Alice",
    endpointClass: "stream",
    capabilities: ["translate"],
    initiate: ["chat"],
  },
  { id: "acct_bob", displayName: "Bob", endpointClass: "sink", initiate: [] },
  {
    id: "acct_carol",
    displayName: "Carol",
    endpointClass: "stream",
    initiate: ["chat"],
  },
];

const CONTACTS: ContactRow[] = [
  { accountId: "acct_alice", displayName: "Alice", alias: "alice" },
  { accountId: "acct_bob", displayName: "Bob" },
];

function env(
  seq: number,
  text: string,
  over: Partial<Envelope> = {},
): Envelope {
  return {
    id: `m_${seq}`,
    seq,
    from: "acct_alice",
    fromEndpoint: null,
    routedAt: NOW,
    idempotencyKey: `key_${seq}`,
    conversationId: "c_group",
    kind: "chat",
    expect: "none",
    payload: { text },
    ...over,
  };
}

interface Recorded {
  sent: Array<SendInput & { clientToken: string }>;
  acks: Array<{ correlationId: string; data?: unknown; error?: unknown }>;
  admins: Array<{ conversationId: string; op: ConversationAdminOp }>;
  created: Array<Record<string, unknown>>;
  claims: string[];
  sharedGets: Array<[string, string, number | undefined]>;
  sharedPuts: Array<[string, string, unknown, number | undefined]>;
  sharedLists: Array<[string, string | undefined]>;
  historyCalls: Array<{
    conversationId: string;
    beforeSeq?: number;
    limit?: number;
  }>;
  inboxCalls: number;
  conversationsFilters: Array<{ type?: string; hasUnread?: boolean }>;
  membersCalls: string[];
  lookups: Array<{ query?: string; capabilities?: string[]; limit?: number }>;
  contactsQueries: Array<string | undefined>;
}

interface StubOptions {
  conversations?: ConversationSummary[];
  members?: (conversationId: string) => MemberRow[];
  inbox?: InboxView;
  history?: Envelope[];
  accounts?: Account[];
  sendThrows?: (input: SendInput & { clientToken: string }) => Error;
}

function makeCtx(o: StubOptions = {}): { ctx: ToolContext; rec: Recorded } {
  const rec: Recorded = {
    sent: [],
    acks: [],
    admins: [],
    created: [],
    claims: [],
    sharedGets: [],
    sharedPuts: [],
    sharedLists: [],
    historyCalls: [],
    inboxCalls: 0,
    conversationsFilters: [],
    membersCalls: [],
    lookups: [],
    contactsQueries: [],
  };
  const conversations = o.conversations ?? [CONV_ADMIN_HOLDER, CONV_TOPIC];
  const members =
    o.members ??
    ((conversationId: string) => (conversationId === "c_topic" ? [] : MEMBERS));
  const history = o.history ?? [
    env(7, "seven"),
    env(8, "eight"),
    env(9, "nine"),
  ];
  const accounts = o.accounts ?? ACCOUNTS;
  const ctx: ToolContext = {
    accountId: "acct_me",
    endpointId: "ep_me",
    async send(input) {
      if (o.sendThrows) throw o.sendThrows(input);
      rec.sent.push(input);
      return { messageId: "m_1", seq: 1 };
    },
    async inbox() {
      rec.inboxCalls++;
      return o.inbox ?? INBOX;
    },
    async history(conversationId, opts) {
      rec.historyCalls.push({ conversationId, ...opts });
      return history;
    },
    async conversations(filter) {
      rec.conversationsFilters.push(filter);
      return conversations;
    },
    async members(conversationId) {
      rec.membersCalls.push(conversationId);
      return members(conversationId);
    },
    async contacts(query) {
      rec.contactsQueries.push(query);
      return CONTACTS;
    },
    async lookup(q) {
      rec.lookups.push(q);
      return accounts;
    },
    async createConversation(input) {
      rec.created.push(input as Record<string, unknown>);
      const conv: Conversation = {
        id: "c_new",
        kind: input.type,
        state: "active",
        config: {
          historyVisibility: "since_join",
          maxHistoryOnJoin: 0,
          claimTtlMs: 300000,
          mentionAllPerHour: 3,
          maxPending: 50,
          maxPendingBytes: 32768,
        },
        createdBy: "acct_me",
        createdAt: NOW,
        lastSeq: 0,
      };
      return conv;
    },
    async conversationAdmin(conversationId, op) {
      rec.admins.push({ conversationId, op });
    },
    async ack(r) {
      rec.acks.push(r);
    },
    async claim(messageId) {
      rec.claims.push(messageId);
      throw new MeshUnsupportedError("queue claim (P3)");
    },
    async sharedGet(spaceId, key, version) {
      rec.sharedGets.push([spaceId, key, version]);
      throw new MeshUnsupportedError("shared spaces (P4)");
    },
    async sharedPut(spaceId, key, data, expectedVersion) {
      rec.sharedPuts.push([spaceId, key, data, expectedVersion]);
      throw new MeshUnsupportedError("shared spaces (P4)");
    },
    async sharedList(spaceId, keyPrefix) {
      rec.sharedLists.push([spaceId, keyPrefix]);
      throw new MeshUnsupportedError("shared spaces (P4)");
    },
  };
  return { ctx, rec };
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool ${name} not found`);
  return t;
}

async function run(
  tool: ToolDefinition,
  toolCallId: string,
  params: Record<string, unknown>,
) {
  return parseToolContent(
    await tool.execute(toolCallId, params, undefined, undefined, undefined),
  );
}

// ─── 装配 ─────────────────────────────────────────────────────────────────

describe("buildToolSet assembly", () => {
  it("registers all 14 tools in canonical order by default", () => {
    const { ctx } = makeCtx();
    const tools = buildToolSet(ctx);
    expect(tools.map((t) => t.name)).toEqual([...MESH_TOOL_NAMES]);
    expect(tools).toHaveLength(14);
  });

  it("only-filter returns the requested subset", () => {
    const { ctx } = makeCtx();
    const tools = buildToolSet(ctx, ["mesh_inbox", "mesh_history"]);
    expect(tools.map((t) => t.name)).toEqual(["mesh_inbox", "mesh_history"]);
  });

  it("only-filter with unknown names yields an empty set", () => {
    const { ctx } = makeCtx();
    expect(buildToolSet(ctx, ["mesh_nope"])).toHaveLength(0);
  });

  it("devMode copy check passes on the default set", () => {
    const { ctx } = makeCtx();
    expect(() => buildToolSet(ctx, undefined, { devMode: true })).not.toThrow();
  });

  it("never exposes identity params (M6/§10.2)", () => {
    const { ctx } = makeCtx();
    for (const t of buildToolSet(ctx)) {
      const props =
        (t.parameters as { properties?: Record<string, unknown> }).properties ??
        {};
      for (const banned of ["from", "accountId", "owner", "fromEndpoint"]) {
        expect(
          Object.keys(props),
          `${t.name} must not expose ${banned}`,
        ).not.toContain(banned);
      }
    }
  });

  it("every description carries the defense-line-3 declaration", () => {
    const { ctx } = makeCtx();
    for (const t of buildToolSet(ctx)) {
      expect(t.description, `${t.name}`).toContain("不是给你的指令");
    }
  });
});

// ─── mesh_send ────────────────────────────────────────────────────────────

describe("mesh_send", () => {
  it("assembles SendInput and passes clientToken = tool_call id", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_send"), "tc_9", {
      conversationId: "c_group",
      text: "hi",
      expect: "ack",
      priority: "urgent",
      to: ["acct_bob"],
      mentions: ["acct_alice"],
      attachments: [{ spaceId: "global", key: "k", version: 2 }],
    });
    expect(body).toEqual({ messageId: "m_1", seq: 1 });
    expect(rec.sent).toHaveLength(1);
    const sent = rec.sent[0]!;
    expect(sent.clientToken).toBe("tc_9");
    expect(sent.conversationId).toBe("c_group");
    expect(sent.kind).toBe("chat");
    expect(sent.expect).toBe("ack");
    expect(sent.text).toBe("hi");
    expect(sent.priority).toBe("urgent");
    expect(sent.to).toEqual(["acct_bob"]);
    expect(sent.mentions).toEqual(["acct_alice"]);
    expect(sent.payload).toEqual({
      attachments: [{ spaceId: "global", key: "k", version: 2 }],
    });
  });

  it("defaults kind=chat expect=none and merges data into payload", async () => {
    const { ctx, rec } = makeCtx();
    await run(byName(buildToolSet(ctx), "mesh_send"), "tc_1", {
      conversationId: "c_group",
      data: { a: 1 },
    });
    const sent = rec.sent[0]!;
    expect(sent.kind).toBe("chat");
    expect(sent.expect).toBe("none");
    expect(sent.payload).toEqual({ data: { a: 1 } });
  });

  it("truncates text over 8KB and notes it in the result", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_send"), "tc_big", {
      conversationId: "c_group",
      text: "x".repeat(9000),
    });
    expect(String(body.notice)).toContain("truncated");
    const sentText = rec.sent[0]!.text;
    expect(sentText).toBeDefined();
    expect(Buffer.byteLength(sentText ?? "", "utf8")).toBeLessThanOrEqual(8192);
  });

  it("rejects invalid params with ARG_INVALID", async () => {
    const { ctx } = makeCtx();
    const send = byName(buildToolSet(ctx), "mesh_send");
    expect((await run(send, "tc", {})).error).toMatchObject({
      code: "ARG_INVALID",
    });
    expect(
      (
        await run(send, "tc", {
          conversationId: "c",
          text: "hi",
          kind: "system",
        })
      ).error,
    ).toMatchObject({
      code: "ARG_INVALID",
    });
    expect(
      (
        await run(send, "tc", {
          conversationId: "c",
          text: "hi",
          expect: "maybe",
        })
      ).error,
    ).toMatchObject({
      code: "ARG_INVALID",
    });
    expect(
      (
        await run(send, "tc", {
          conversationId: "c",
          text: "hi",
          priority: "asap",
        })
      ).error,
    ).toMatchObject({
      code: "ARG_INVALID",
    });
    expect(
      (await run(send, "tc", { conversationId: "c", text: "hi", to: [7] }))
        .error,
    ).toMatchObject({
      code: "ARG_INVALID",
    });
    expect(
      (
        await run(send, "tc", {
          conversationId: "c",
          text: "hi",
          attachments: [{}],
        })
      ).error,
    ).toMatchObject({
      code: "ARG_INVALID",
    });
    expect(
      (await run(send, "tc", { conversationId: "c" })).error,
    ).toMatchObject({ code: "ARG_INVALID" });
  });

  it("maps MeshRejectError from the router to a structured error", async () => {
    const { ctx } = makeCtx({
      sendThrows: () => new MeshRejectError("NO_SPEAK_CAP"),
    });
    const body = await run(byName(buildToolSet(ctx), "mesh_send"), "tc", {
      conversationId: "c_group",
      text: "hi",
    });
    expect(body.error).toMatchObject({ code: "NO_SPEAK_CAP" });
  });
});

// ─── mesh_ack ─────────────────────────────────────────────────────────────

describe("mesh_ack", () => {
  it("passes correlationId/data/error through", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_ack"), "tc", {
      correlationId: "corr_1",
      data: { answer: 42 },
    });
    expect(body).toEqual({ ok: true });
    expect(rec.acks).toEqual([
      { correlationId: "corr_1", data: { answer: 42 } },
    ]);
  });

  it("requires correlationId", async () => {
    const { ctx } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_ack"), "tc", {});
    expect(body.error).toMatchObject({ code: "ARG_INVALID" });
  });
});

// ─── 只读工具 ─────────────────────────────────────────────────────────────

describe("read-only tools", () => {
  it("mesh_lookup filters by conversation membership and validates limit", async () => {
    // c_group 成员 = me/alice（bob 不在这个会话里）；lookup 命中 alice/bob/carol
    const { ctx, rec } = makeCtx({
      members: (conversationId) =>
        conversationId === "c_group"
          ? MEMBERS.filter((m) => m.accountId !== "acct_bob")
          : MEMBERS,
    });
    const body = await run(byName(buildToolSet(ctx), "mesh_lookup"), "tc", {
      capabilities: ["translate"],
      conversationId: "c_group",
      limit: 5,
    });
    const accounts = body.accounts as Account[];
    expect(accounts.map((a) => a.id)).toEqual(["acct_alice"]);
    expect(rec.lookups[0]).toMatchObject({
      limit: 5,
      capabilities: ["translate"],
    });
    const bad = await run(byName(buildToolSet(ctx), "mesh_lookup"), "tc", {
      limit: 0,
    });
    expect(bad.error).toMatchObject({ code: "ARG_INVALID" });
  });

  it("mesh_inbox returns the §10.4 shape with summary/digest separation", async () => {
    const { ctx } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_inbox"), "tc", {});
    const convs = body.conversations as Array<Record<string, unknown>>;
    expect(convs).toHaveLength(2);
    expect(convs[0]).toMatchObject({
      conversationId: "c_group",
      type: "group",
      unread: 3,
      verbatim: true,
      overflow: 5,
      overflowSummary: "5 older messages folded",
    });
    expect(convs[0]!.recent).toHaveLength(1);
    // direct 会话的 expectsMyAck 由 awaitingMyAck 对端推导
    expect(convs[1]).toMatchObject({
      conversationId: "d_1",
      type: "direct",
      expectsMyAck: true,
    });
    expect(body.awaitingMyAck).toEqual([
      {
        correlationId: "corr_1",
        from: "acct_alice",
        intent: "ping",
        deadlineIn: "18s",
      },
    ]);
    expect(body.awaitingTheirAck).toEqual([
      { correlationId: "corr_2", to: "acct_bob", deadlineIn: "2m" },
    ]);
  });

  it("mesh_inbox filters by conversationId and slices by limit", async () => {
    const { ctx } = makeCtx();
    const tools = buildToolSet(ctx);
    const one = await run(byName(tools, "mesh_inbox"), "tc", {
      conversationId: "d_1",
    });
    expect(
      (one.conversations as Array<Record<string, unknown>>).map(
        (c) => c.conversationId,
      ),
    ).toEqual(["d_1"]);
    const sliced = await run(byName(tools, "mesh_inbox"), "tc", { limit: 1 });
    expect(sliced.conversations).toHaveLength(1);
    expect(sliced.truncated).toBe(true);
  });

  it("mesh_history passes pagination and projects envelopes", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_history"), "tc", {
      conversationId: "c_group",
      beforeSeq: 10,
    });
    expect(rec.historyCalls[0]).toEqual({
      conversationId: "c_group",
      beforeSeq: 10,
      limit: 20,
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({
      seq: 7,
      from: "acct_alice",
      kind: "chat",
      text: "seven",
    });
  });

  it("mesh_history clamps limit to 100 and marks truncated", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_history"), "tc", {
      conversationId: "c_group",
      limit: 500,
    });
    expect(rec.historyCalls[0]!.limit).toBe(100);
    expect(body.truncated).toBe(true);
  });

  it("mesh_history caps results at 8KB from the tail with valid JSON", async () => {
    const bigHistory = Array.from({ length: 30 }, (_, i) =>
      env(i + 1, "y".repeat(1000)),
    );
    const { ctx } = makeCtx({ history: bigHistory });
    const tool = byName(buildToolSet(ctx), "mesh_history");
    const raw = await tool.execute(
      "tc",
      { conversationId: "c_group" },
      undefined,
      undefined,
      undefined,
    );
    const text =
      typeof raw.content === "string" ? raw.content : raw.content[0]!.text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192);
    const body = parseToolContent(raw);
    expect(body.truncated).toBe(true);
    expect((body.messages as unknown[]).length).toBeLessThan(30);
  });

  it("mesh_conversations passes the filter and validates type", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(
      byName(buildToolSet(ctx), "mesh_conversations"),
      "tc",
      { type: "group", hasUnread: true },
    );
    expect(rec.conversationsFilters[0]).toEqual({
      type: "group",
      hasUnread: true,
    });
    expect(Array.isArray(body.conversations)).toBe(true);
    const bad = await run(
      byName(buildToolSet(ctx), "mesh_conversations"),
      "tc",
      { type: "party" },
    );
    expect(bad.error).toMatchObject({ code: "ARG_INVALID" });
  });

  it("mesh_members returns rows; topic returns subscriberCount only", async () => {
    const { ctx } = makeCtx();
    const tools = buildToolSet(ctx);
    const groupBody = await run(byName(tools, "mesh_members"), "tc", {
      conversationId: "c_group",
    });
    expect(groupBody.members).toHaveLength(3);
    const topicBody = await run(byName(tools, "mesh_members"), "tc", {
      conversationId: "c_topic",
    });
    expect(topicBody).toEqual({ subscriberCount: 0, members: [] });
  });

  it("mesh_contacts passes the query through", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_contacts"), "tc", {
      query: "al",
    });
    expect(rec.contactsQueries).toEqual(["al"]);
    expect(body.contacts).toHaveLength(2);
  });
});

// ─── mesh_create_conversation ─────────────────────────────────────────────

describe("mesh_create_conversation", () => {
  it("passes fields without creator (identity is closed over)", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(
      byName(buildToolSet(ctx), "mesh_create_conversation"),
      "tc",
      {
        type: "group",
        topic: "proj",
        members: ["acct_alice", "acct_alice", "acct_bob"],
        config: { openJoin: false },
      },
    );
    expect(body).toEqual({ conversationId: "c_new" });
    expect(rec.created[0]).not.toHaveProperty("creator");
    expect(rec.created[0]).toMatchObject({
      type: "group",
      topic: "proj",
      members: ["acct_alice", "acct_bob"],
      config: { openJoin: false },
    });
  });

  it("rejects invalid type", async () => {
    const { ctx } = makeCtx();
    const body = await run(
      byName(buildToolSet(ctx), "mesh_create_conversation"),
      "tc",
      { type: "direct" },
    );
    expect(body.error).toMatchObject({ code: "ARG_INVALID" });
  });
});

// ─── mesh_conversation_admin（§9.3 caps 门 + I8）─────────────────────────

describe("mesh_conversation_admin", () => {
  it("rejects non-members with NOT_A_MEMBER", async () => {
    const { ctx } = makeCtx();
    const body = await run(
      byName(buildToolSet(ctx), "mesh_conversation_admin"),
      "tc",
      {
        conversationId: "c_unknown",
        op: "setTopic",
        topic: "x",
      },
    );
    expect(body.error).toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("rejects a missing cap with CAP_REQUIRED naming the cap", async () => {
    const { ctx } = makeCtx({ conversations: [CONV_PLAIN_MEMBER] });
    const body = await run(
      byName(buildToolSet(ctx), "mesh_conversation_admin"),
      "tc",
      {
        conversationId: "c_group",
        op: "addMember",
        account: "acct_carol",
      },
    );
    expect(body.error).toMatchObject({ code: "CAP_REQUIRED" });
    expect(String((body.error as Record<string, unknown>).message)).toContain(
      "invite",
    );
  });

  it("rejects caps beyond the caller's own (I8 subset), atomically", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(
      byName(buildToolSet(ctx), "mesh_conversation_admin"),
      "tc",
      {
        conversationId: "c_group",
        op: "addMember",
        account: "acct_carol",
        caps: ["speak", "dissolve"], // dissolve 不在 myCaps
      },
    );
    expect(body.error).toMatchObject({ code: "CAP_REQUIRED" });
    expect(String((body.error as Record<string, unknown>).message)).toContain(
      "subset",
    );
    expect(rec.admins).toHaveLength(0);
  });

  it("lets an invite holder add a member and records the op", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(
      byName(buildToolSet(ctx), "mesh_conversation_admin"),
      "tc",
      {
        conversationId: "c_group",
        op: "addMember",
        account: "acct_carol",
        caps: ["speak", "read"],
      },
    );
    expect(body).toEqual({ ok: true });
    expect(rec.admins[0]).toEqual({
      conversationId: "c_group",
      op: { op: "addMember", account: "acct_carol", caps: ["speak", "read"] },
    });
  });

  it("removing a setCaps holder additionally requires dissolve", async () => {
    const { ctx } = makeCtx();
    const tools = buildToolSet(ctx);
    const denied = await run(byName(tools, "mesh_conversation_admin"), "tc", {
      conversationId: "c_group",
      op: "removeMember",
      account: "acct_alice", // alice 持 setCaps；myCap 缺 dissolve
    });
    expect(denied.error).toMatchObject({ code: "CAP_REQUIRED" });
    expect(String((denied.error as Record<string, unknown>).message)).toContain(
      "dissolve",
    );

    const { ctx: ctx2 } = makeCtx({
      conversations: [
        {
          ...CONV_ADMIN_HOLDER,
          myCaps: [...CONV_ADMIN_HOLDER.myCaps, "dissolve"],
        },
      ],
    });
    const allowed = await run(
      byName(buildToolSet(ctx2), "mesh_conversation_admin"),
      "tc",
      {
        conversationId: "c_group",
        op: "removeMember",
        account: "acct_alice",
      },
    );
    expect(allowed).toEqual({ ok: true });
  });

  it("dissolve is TOOL_DISABLED unless the host opts in", async () => {
    const { ctx, rec } = makeCtx({
      conversations: [{ ...CONV_ADMIN_HOLDER, myCaps: ["dissolve"] }],
    });
    const tools = buildToolSet(ctx);
    const denied = await run(byName(tools, "mesh_conversation_admin"), "tc", {
      conversationId: "c_group",
      op: "dissolve",
    });
    expect(denied.error).toMatchObject({ code: "TOOL_DISABLED" });
    expect(rec.admins).toHaveLength(0);

    const { ctx: ctx2, rec: rec2 } = makeCtx({
      conversations: [{ ...CONV_ADMIN_HOLDER, myCaps: ["dissolve"] }],
    });
    const allowed = await run(
      buildToolSet(ctx2, undefined, { allowDissolve: true })[0] === undefined
        ? tools[0]!
        : byName(
            buildToolSet(ctx2, undefined, { allowDissolve: true }),
            "mesh_conversation_admin",
          ),
      "tc",
      {
        conversationId: "c_group",
        op: "dissolve",
      },
    );
    expect(allowed).toEqual({ ok: true });
    expect(rec2.admins[0]).toEqual({
      conversationId: "c_group",
      op: { op: "dissolve" },
    });
  });

  it("subscribe on an unknown conversation passes through (topic rule)", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(
      byName(buildToolSet(ctx), "mesh_conversation_admin"),
      "tc",
      {
        conversationId: "c_topic_new",
        op: "subscribe",
        fromSeq: 3,
      },
    );
    expect(body).toEqual({ ok: true });
    expect(rec.admins[0]).toEqual({
      conversationId: "c_topic_new",
      op: { op: "subscribe", fromSeq: 3 },
    });
  });

  it("validates op arguments", async () => {
    const { ctx } = makeCtx();
    const tools = buildToolSet(ctx);
    expect(
      (
        await run(byName(tools, "mesh_conversation_admin"), "tc", {
          conversationId: "c_group",
          op: "wat",
        })
      ).error,
    ).toMatchObject({ code: "ARG_INVALID" });
    expect(
      (
        await run(byName(tools, "mesh_conversation_admin"), "tc", {
          conversationId: "c_group",
          op: "addMember",
        })
      ).error,
    ).toMatchObject({ code: "ARG_INVALID" });
    expect(
      (
        await run(byName(tools, "mesh_conversation_admin"), "tc", {
          conversationId: "c_group",
          op: "setCaps",
          account: "acct_bob",
          caps: ["speak", "fly"],
        })
      ).error,
    ).toMatchObject({ code: "ARG_INVALID" });
  });
});

// ─── P3/P4 延期 ───────────────────────────────────────────────────────────

describe("deferred tools (P3/P4)", () => {
  it("mesh_claim maps MeshUnsupportedError to structured TOOL_DISABLED", async () => {
    const { ctx, rec } = makeCtx();
    const body = await run(byName(buildToolSet(ctx), "mesh_claim"), "tc", {
      messageId: "m_1",
    });
    expect(body.error).toMatchObject({ code: "TOOL_DISABLED" });
    expect(rec.claims).toEqual(["m_1"]);
  });

  it("mesh_shared_get/put/list map to structured TOOL_DISABLED", async () => {
    const { ctx } = makeCtx();
    const tools = buildToolSet(ctx);
    const get = await run(byName(tools, "mesh_shared_get"), "tc", {
      spaceId: "global",
      key: "k",
    });
    expect(get.error).toMatchObject({ code: "TOOL_DISABLED" });
    const put = await run(byName(tools, "mesh_shared_put"), "tc", {
      spaceId: "global",
      key: "k",
      data: { v: 1 },
      expectedVersion: 3,
    });
    expect(put.error).toMatchObject({ code: "TOOL_DISABLED" });
    const list = await run(byName(tools, "mesh_shared_list"), "tc", {
      spaceId: "global",
      keyPrefix: "k/",
    });
    expect(list.error).toMatchObject({ code: "TOOL_DISABLED" });
  });
});

// ─── §10.5 文案静态检查 ───────────────────────────────────────────────────

describe("checkToolCopy (§10.5)", () => {
  it("passes on the default set", () => {
    const { ctx } = makeCtx();
    expect(checkToolCopy(buildToolSet(ctx))).toEqual([]);
  });

  it("detects a missing fixed wording", () => {
    const { ctx } = makeCtx();
    const tampered = buildToolSet(ctx).map((t) =>
      t.name === "mesh_send"
        ? {
            ...t,
            description: t.description.replaceAll(
              "只写 mentions 不会唤醒任何人",
              "at anyone",
            ),
          }
        : t,
    );
    const violations = checkToolCopy(tampered);
    expect(
      violations.some(
        (v) => v.includes("mesh_send") && v.includes("fixed wording"),
      ),
    ).toBe(true);
  });

  it("detects forbidden promises and unregistered codes", () => {
    const { ctx } = makeCtx();
    const tampered = buildToolSet(ctx).map((t) =>
      t.name === "mesh_send"
        ? { ...t, description: "写操作。不可撤回。你可以撤回。SOME_BAD_CODE。" }
        : t,
    );
    const violations = checkToolCopy(tampered);
    expect(violations.some((v) => v.includes("forbidden promise"))).toBe(true);
    expect(violations.some((v) => v.includes("unregistered code"))).toBe(true);
  });
});
