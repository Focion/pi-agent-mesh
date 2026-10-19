// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 消息实验室（D）。演示 request-应答、queue 认领/requeue、投递轨迹与
// sink/收件箱。全部经既有 RPC 命令驱动（send/request/ack/claim/requeue/markConsumed/
// observer.messages/trace/inboxOf）。实时用 meshmsg + delivery + mesh 事件刷新轨迹。
// ═══════════════════════════════════════════════════════════════════════════

import { $, el, clear, rpc, safeRpc, toast, state, bus, refreshSnapshot, fillAccountSelect, displayName, clock } from "./lib.js";

const csv = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
let inspectId = null; // 当前查看轨迹的消息 id

function fillConvSelect() {
  const sel = $("#labConvSel");
  if (!sel) return;
  const prev = sel.value;
  clear(sel);
  sel.append(el("option", { value: "", text: "— 选择会话 —" }));
  for (const c of state.conversations) {
    sel.append(el("option", { value: c.id, text: `[${c.kind}] ${c.id}${c.topic ? " · " + c.topic : ""}` }));
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ── 会话消息列表 ────────────────────────────────────────────────────────────
function msgRow(env) {
  const text = env.payload?.text ?? "";
  const actions = el("span", { class: "cell-actions" },
    el("button", { class: "mini", "data-act": "trace", "data-id": env.id, text: "轨迹" }),
    el("button", { class: "mini", "data-act": "claim", "data-id": env.id, text: "claim" }),
    el("button", { class: "mini", "data-act": "requeue", "data-id": env.id, text: "requeue" }));
  return el("div", { class: "lm-row" },
    el("span", { class: "lm-seq mono muted", text: "#" + env.seq }),
    el("span", { class: "lm-from mono", text: displayName(env.from) }),
    el("span", { class: "pill", text: env.kind }),
    env.expect && env.expect !== "none" ? el("span", { class: "pill pill-host", text: "expect:" + env.expect }) : null,
    env.claim ? el("span", { class: "pill pill-derived", text: "claimed:" + displayName(env.claim.by) }) : null,
    el("span", { class: "lm-text", text: text }),
    actions);
}

async function loadMessages() {
  const conversationId = $("#labConvSel").value;
  const box = $("#labMsgs");
  clear(box);
  if (!conversationId) return;
  const list = await safeRpc("messages", { conversationId, limit: 50 });
  if (!Array.isArray(list) || list.length === 0) {
    box.append(el("p", { class: "muted", text: "该会话暂无消息。" }));
    return;
  }
  for (const env of [...list].reverse()) box.append(msgRow(env));
}

// ── 投递轨迹 ─────────────────────────────────────────────────────────────────
function traceRow(t) {
  return el("div", { class: "tr-row" },
    el("span", { class: "pill st-" + t.state, text: t.state }),
    el("span", { class: "tr-acct", text: displayName(t.accountId) }),
    t.endpointId ? el("span", { class: "mono muted small", text: "ep:" + (t.endpointId.slice(-6)) }) : null,
    t.grade ? el("span", { class: "pill", text: "grade:" + t.grade }) : null,
    el("span", { class: "pill " + (t.woke ? "pill-host" : "pill-off"), text: t.woke ? "woke" : "no-wake" }),
    el("span", { class: "muted small", text: `×${t.attempts}` }),
    t.reason ? el("span", { class: "pill pill-danger", text: "reason:" + t.reason }) : null,
    t.note ? el("span", { class: "muted small", text: "note:" + t.note }) : null,
    t.redeliverReason ? el("span", { class: "muted small", text: "redeliver:" + t.redeliverReason }) : null,
    el("span", { class: "muted small", text: clock(t.stateChangedAt) }),
    t.state === "delivered" ? el("button", { class: "mini", "data-act": "consume", "data-id": t.deliveryId, text: "markConsumed" }) : null);
}

async function renderTrace(messageId) {
  inspectId = messageId;
  const wrap = $("#labTrace");
  clear(wrap);
  wrap.append(el("div", { class: "tr-head" }, el("span", { class: "muted small", text: "消息 " }), el("code", { text: messageId })));
  const traces = await safeRpc("trace", { messageId });
  if (!Array.isArray(traces) || traces.length === 0) {
    wrap.append(el("p", { class: "muted", text: "尚无投递轨迹（路由后会出现）。" }));
    return;
  }
  for (const t of traces) wrap.append(traceRow(t));
}

// ── 收件箱 / ack ──────────────────────────────────────────────────────────────
function renderInbox(view) {
  const box = $("#labInbox");
  clear(box);
  if (!view) {
    box.append(el("p", { class: "muted", text: "无数据。" }));
    return;
  }
  box.append(el("div", { class: "ib-h", text: `未读会话 ${view.conversations?.length ?? 0}` }));
  for (const c of view.conversations || []) {
    box.append(
      el("div", { class: "ib-row" },
        el("span", { class: "mono muted", text: `[${c.kind}] ${c.conversationId.slice(-6)}` }),
        el("span", { class: "pill " + (c.unread ? "pill-host" : "pill-off"), text: "未读 " + c.unread }),
        c.claimable ? el("span", { class: "pill pill-derived", text: "可认领 " + c.claimable }) : null,
        c.verbatim ? el("span", { class: "muted small", text: "原文内" }) : null),
    );
  }
  const ackWrap = el("div", { class: "ib-ack" });
  ackWrap.append(el("div", { class: "ib-h", text: `待我应答 (${view.awaitingMyAck?.length ?? 0})` }));
  for (const r of view.awaitingMyAck || []) {
    ackWrap.append(
      el("div", { class: "ib-row" },
        el("span", { class: "mono", text: displayName(r.from) }),
        el("span", { class: "mono muted small", text: r.correlationId.slice(-8) }),
        el("span", { class: "muted small", text: "最后期限 " + clock(r.deadlineIn) }),
        el("button", { class: "mini is-on", "data-act": "ack", "data-cid": r.correlationId, text: "ack ✓" }),
        el("button", { class: "mini is-danger", "data-act": "nack", "data-cid": r.correlationId, text: "拒绝" })),
    );
  }
  box.append(ackWrap);
}

async function loadInbox() {
  const accountId = $("#labInboxAcct").value;
  if (!accountId) return toast("先选账号", "err");
  const view = await safeRpc("inboxOf", { accountId });
  renderInbox(view);
}

// ── 会话创建 / 发送 / 应答 ────────────────────────────────────────────────────
function parseCfg() {
  const raw = $("#labConvCfg").value.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    toast("config 不是合法 JSON", "err");
    return null;
  }
}

async function ensureDirect() {
  const a = $("#labDirectA").value;
  const b = $("#labDirectB").value;
  if (!a || !b) return toast("选择两个账号", "err");
  const res = await safeRpc("ensureDirect", { a, b });
  if (res) {
    toast(`direct ${res.id}`);
    await afterConvChange(res.id);
  }
}

async function createConv() {
  const type = $("#labConvType").value;
  const creator = $("#labConvCreator").value;
  if (!creator) return toast("选择创建者", "err");
  const cfg = parseCfg();
  if (cfg === null) return;
  const res = await safeRpc("createConversation", {
    type,
    creator,
    members: csv($("#labConvMembers").value),
    ...($("#labConvTopic").value.trim() ? { topic: $("#labConvTopic").value.trim() } : {}),
    ...(cfg ? { config: cfg } : {}),
  });
  if (res) {
    toast(`已创建 ${type} ${res.id}`);
    await afterConvChange(res.id);
  }
}

async function afterConvChange(convId) {
  await refreshSnapshot();
  fillConvSelect();
  $("#labConvSel").value = convId;
  $("#labInboxAcct") && fillAccountSelect($("#labInboxAcct"));
  await loadMessages();
}

async function doSend(expect) {
  const from = $("#labFrom").value;
  const conversationId = $("#labConvSel").value;
  const text = $("#labText").value.trim();
  if (!from || !conversationId) return toast("选择身份与会话", "err");
  if (!text) return toast("消息为空", "err");
  const body = {
    from,
    conversationId,
    kind: $("#labKind").value,
    expect,
    text,
    ...(csv($("#labTo").value).length ? { to: csv($("#labTo").value) } : {}),
    ...(csv($("#labMentions").value).length ? { mentions: csv($("#labMentions").value) } : {}),
    ...($("#labPriority").value ? { priority: $("#labPriority").value } : {}),
  };
  const res = await safeRpc(expect === "ack" ? "request" : "send", body);
  if (res) {
    $("#labLastResult").textContent = JSON.stringify(res);
    toast(expect === "ack" ? "request 已发出" : "send 已发出");
    if (res.messageId) renderTrace(res.messageId);
    await loadMessages();
  }
}

function wireOps() {
  $("#btnLabDirect")?.addEventListener("click", ensureDirect);
  $("#btnLabCreateConv")?.addEventListener("click", createConv);
  $("#btnLabReloadConv")?.addEventListener("click", loadMessages);
  $("#btnLabSend")?.addEventListener("click", () => doSend($("#labExpect").value));
  $("#btnLabInbox")?.addEventListener("click", loadInbox);
  $("#labConvSel")?.addEventListener("change", loadMessages);

  $("#labMsgs")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === "trace") return renderTrace(id);
    if (act === "claim") {
      const by = $("#labFrom").value;
      if (!by) return toast("选择身份（认领人）", "err");
      const r = await safeRpc("claim", { messageId: id, by });
      toast(r && r.ok ? "已认领" : "认领失败/不可认领");
      await loadMessages();
    } else if (act === "requeue") {
      const target = $("#labConvSel").value;
      const r = await safeRpc("requeue", { messageId: id, targetConversationId: target });
      if (r !== null) {
        toast("已 requeue");
        await loadMessages();
      }
    }
  });

  $("#labInbox")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const { act, cid } = btn.dataset;
    const from = $("#labInboxAcct").value;
    if (act === "ack" || act === "nack") {
      const r = await safeRpc("ack", {
        correlationId: cid,
        from,
        ...(act === "ack" ? { data: { ok: true } } : { error: "rejected-by-operator" }),
      });
      if (r !== null) {
        toast(act === "ack" ? "已应答" : "已拒绝");
        loadInbox();
      }
    }
  });
}

export function initLab() {
  wireOps();
  bus.on("meshmsg", (env) => {
    if (env?.conversationId && env.conversationId === $("#labConvSel")?.value) {
      const box = $("#labMsgs");
      box.prepend(msgRow(env));
    }
  });
  bus.on("delivery", (d) => {
    if (d?.messageId && d.messageId === inspectId && Array.isArray(d.traces)) {
      clear($("#labTrace"));
      $("#labTrace").append(el("div", { class: "tr-head" }, el("span", { class: "muted small", text: "消息 " }), el("code", { text: inspectId })));
      for (const t of d.traces) $("#labTrace").append(traceRow(t));
    }
  });
  bus.on("mesh", ({ type, payload }) => {
    const mid = payload?.envelope?.id;
    if (["message_routed", "message_delivered", "message_consumed", "message_parked", "message_dropped"].includes(type) && mid && mid === inspectId) {
      renderTrace(mid);
    }
  });
}

export async function refreshLab() {
  await refreshSnapshot();
  fillConvSelect();
  for (const selId of ["#labDirectA", "#labDirectB", "#labConvCreator", "#labConvMembersSel", "#labFrom", "#labInboxAcct"]) {
    const s = $(selId);
    if (s) fillAccountSelect(s, { includeEmpty: selId === "#labConvCreator" ? false : true });
  }
  await loadMessages();
}
