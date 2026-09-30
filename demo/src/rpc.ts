// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · RPC 分发（POST /api/<command>）→ MeshController。
//
// 每个 handler 外包一层错误序列化：MeshRejectError → {name, code, message}、
// MeshUnsupportedError → {name, message}、InvariantViolationError → {name, code,
// message}、其他 Error → {name, message}。类型化错误都是「库里发生的正常拒绝」，
// 由前端如实渲染（不是 500）。
//
// 慢调用（warm/send/nudge）不设超时 —— 真实 LLM 冷起要几秒到几十秒。
// ═══════════════════════════════════════════════════════════════════════════

import type { MeshController } from "./runtime.ts";

export interface RpcError {
  name: string;
  message: string;
  code?: string;
}

export type RpcResult = { ok: true; result?: unknown } | { ok: false; error: RpcError };

export function serializeError(err: unknown): RpcError {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return { name: err.name, message: err.message, ...(code ? { code } : {}) };
  }
  return { name: "Error", message: String(err) };
}

type Handler = (c: MeshController, args: Record<string, unknown>) => unknown;

// ── 命令表（`args` 是 JSON 解析后的对象，字段名与 MeshHost 入参一一对应）──────

const HANDLERS: Record<string, Handler> = {
  // 账号 / 端点 / 寻址
  registerAccount: (c, a) =>
    c.registerAccount({
      id: str2(a.id),
      displayName: str(a.displayName, "unnamed"),
      endpointClass: (a.endpointClass as "stream" | "sink" | "external") ?? "stream",
      capabilities: arr(a.capabilities),
      initiate: arr(a.initiate),
      defaultGrade: (a.defaultGrade as "steer" | "followUp" | "silent") ?? undefined,
    }),
  registerEndpoint: (c, a) =>
    c.registerEndpoint({
      accountId: str(a.accountId),
      topology: (a.topology as never) ?? { kind: "unified" },
    }),
  setSinkMode: (c, a) =>
    c.setSinkMode(str(a.accountId), (a.mode as "accept" | "refuse") ?? "accept", a.consumeImmediately === true),
  setPresence: (c, a) =>
    c.setPresence(str(a.accountId), (a.state as never) ?? "available", {
      ...(str2(a.until) ? { until: String(a.until) } : {}),
      ...(str2(a.reason) ? { reason: String(a.reason) } : {}),
    }),
  upsertContact: (c, a) =>
    c.upsertContact(str(a.ownerId), str(a.peerId), {
      ...(str2(a.alias) ? { alias: String(a.alias) } : {}),
      ...(a.tags !== undefined ? { tags: a.tags } : {}),
    }),
  lookup: (c, a) =>
    c.lookup({
      ...(str2(a.query) ? { query: String(a.query) } : {}),
      ...(arr(a.capabilities).length ? { capabilities: arr(a.capabilities) } : {}),
      ...(num(a.limit) !== null ? { limit: Number(a.limit) } : {}),
    }),

  // 会话 / 成员
  ensureDirect: (c, a) => c.ensureDirect(str(a.a), str(a.b)),
  createConversation: (c, a) =>
    c.createConversation({
      type: (a.type as "group" | "topic" | "queue") ?? "group",
      creator: str(a.creator),
      members: arr(a.members),
      ...(str2(a.topic) ? { topic: String(a.topic) } : {}),
      ...(a.config ? { config: a.config as Record<string, unknown> } : {}),
    }),
  addMember: (c, a) =>
    c.addMember(str(a.conv), str(a.account), {
      ...(arr(a.caps).length ? { caps: arr(a.caps) } : {}),
      ...(str2(a.by) ? { by: String(a.by) } : {}),
    }),
  removeMember: (c, a) => c.removeMember(str(a.conv), str(a.account), str(a.by)),
  join: (c, a) => c.join(str(a.conv), str(a.account)),
  leave: (c, a) => c.leave(str(a.conv), str(a.account)),
  setCaps: (c, a) => c.setCaps(str(a.conv), str(a.account), arr(a.caps), str(a.by)),
  setTopic: (c, a) => c.setTopic(str(a.conv), str(a.text), str(a.by)),
  setAnnouncement: (c, a) => c.setAnnouncement(str(a.conv), str(a.text), str(a.by)),
  mute: (c, a) => c.mute(str(a.conv), str(a.account), str(a.until)),
  dissolve: (c, a) => c.dissolve(str(a.conv), str(a.by)),
  upgradeToGroup: (c, a) => c.upgradeToGroup(str(a.conv), arr(a.extra), str(a.by)),
  subscribe: (c, a) => c.subscribe(str(a.conv), str(a.account)),
  unsubscribe: (c, a) => c.unsubscribe(str(a.conv), str(a.account)),

  // 发送 / 应答
  send: (c, a) =>
    c.send({
      from: str(a.from),
      conversationId: str(a.conversationId),
      ...(str2(a.kind) ? { kind: String(a.kind) } : {}),
      ...(str2(a.expect) ? { expect: String(a.expect) } : {}),
      ...(str2(a.text) ? { text: String(a.text) } : {}),
      ...(str2(a.priority) ? { priority: String(a.priority) } : {}),
      ...(arr(a.to).length ? { to: arr(a.to) } : {}),
      ...(arr(a.mentions).length ? { mentions: arr(a.mentions) } : {}),
      ...(str2(a.replyTo) ? { replyTo: String(a.replyTo) } : {}),
    }),
  request: (c, a) =>
    c.request({
      from: str(a.from),
      conversationId: str(a.conversationId),
      kind: str2(a.kind),
      text: str2(a.text),
      to: arr(a.to),
      blocking: a.blocking === true,
    }),
  ack: (c, a) =>
    c.ack({
      correlationId: str(a.correlationId),
      from: str(a.from),
      data: a.data,
      error: str2(a.error),
    }),
  claim: (c, a) => c.claim(str(a.messageId), str(a.by)),
  requeue: (c, a) => c.requeue(str(a.messageId), str(a.targetConversationId)),

  // 控制面 / 流
  markConsumed: (c, a) => c.markConsumed(str(a.deliveryId)),
  warm: (c, a) => c.warm(str(a.endpointId), (a.lease as "shared" | "exclusive") ?? "shared"),
  evict: (c, a) => c.evict(str(a.endpointId)),
  nudge: (c, a) =>
    c.nudge(str(a.endpointId), str(a.cue), {
      ...(str2(a.deliverAs) ? { deliverAs: a.deliverAs as "steer" | "followUp" } : {}),
      ...(a.triggerTurn === true ? { triggerTurn: true } : {}),
    }),
  injectContext: (c, a) => c.injectContext(str(a.endpointId), str(a.text)),
  beforeClearQueue: (c, a) => c.beforeClearQueue(str(a.endpointId)),
  toolSet: (c, a) => c.toolSet(str(a.endpointId), arr(a.only).length ? arr(a.only) : undefined),

  // Observer（只读）
  messages: (c, a) =>
    c.observer.messages({
      ...(str2(a.conversationId) ? { conversationId: String(a.conversationId) } : {}),
      ...(str2(a.from) ? { from: String(a.from) } : {}),
      ...(str2(a.kind) ? { kind: String(a.kind) as never } : {}),
      ...(num(a.sinceSeq) !== null ? { sinceSeq: Number(a.sinceSeq) } : {}),
      ...(num(a.limit) !== null ? { limit: Number(a.limit) } : {}),
    }),
  search: (c, a) =>
    c.observer.search({
      text: str(a.text),
      ...(str2(a.conversationId) ? { conversationId: String(a.conversationId) } : {}),
      ...(num(a.limit) !== null ? { limit: Number(a.limit) } : {}),
    }),
  trace: (c, a) => c.observer.trace(str(a.messageId)),
  inboxOf: (c, a) => c.observer.inboxOf(str(a.accountId)),
  conversationsOf: (c, a) => c.observer.conversationsOf(str(a.accountId)),
  streamEntries: (c, a) =>
    c.observer.streamEntries(str(a.piSessionId), {
      ...(num(a.sinceSeq) !== null ? { sinceSeq: Number(a.sinceSeq) } : {}),
    }),
  counters: (c, a) => c.observer.counters(arr(a.names).length ? arr(a.names) : undefined, str2(a.since)),
  checkInvariants: (c) => c.observer.checkInvariants(),
  replay: (c, a) => c.observer.replay(str(a.endpointId)),
  forkAt: (c, a) => c.observer.forkAt(str(a.endpointId), str(a.entryId)),

  // 共享空间（§18）—— 已接线，委托 host.shared.*
  sharedGet: (c, a) => c.host.shared.get(str(a.spaceId), str(a.key), { as: str(a.as) }),
  sharedPut: (c, a) => c.host.shared.put(str(a.spaceId), str(a.key), a.data, { as: str(a.as) }),
  sharedAppend: (c, a) => c.host.shared.append(str(a.spaceId), str(a.key), a.item, { as: str(a.as) }),
  sharedDel: (c, a) => c.host.shared.del(str(a.spaceId), str(a.key), { as: str(a.as) }),
  sharedList: (c, a) => c.host.shared.list(str(a.spaceId), { as: str(a.as) }),

  // 综合
  state: (c) => c.snapshot(),
  runScenario: (c, a) => c.runScenario((a.name as "P0" | "P1") ?? "P0"),
};

export async function dispatch(
  controller: MeshController,
  cmd: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const handler = HANDLERS[cmd];
  if (!handler) {
    return { ok: false, error: { name: "UnknownCommand", message: `no such command: ${cmd}` } };
  }
  try {
    const result = await handler(controller, args ?? {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

// ── 参数卫生 ─────────────────────────────────────────────────────────────────

function str(v: unknown, d = ""): string {
  return typeof v === "string" && v.trim() !== "" ? v : d;
}
function str2(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}