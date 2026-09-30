// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 前端（vanilla，无 CDN，零依赖）。
// RPC：POST /api/<command>（同源）；事件：EventSource /api/events。
// ═══════════════════════════════════════════════════════════════════════════

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── DOM 小工具 ──────────────────────────────────────────────────────────────
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "style") n.style.cssText = v;
    else if (k === "value") n.value = v;
    else if (k === "checked") n.checked = !!v;
    else if (k === "disabled") n.disabled = !!v;
    else n.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    n.append(c && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const fmtTime = (iso) => (iso ? String(iso).replace("T", " ").slice(11, 23) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── RPC ─────────────────────────────────────────────────────────────────────
async function rpc(cmd, args = {}) {
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return res.json();
}

function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast is-${kind}`;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function showResult(json, tag) {
  const t = typeof tag === "string" ? $(tag) : tag;
  if (!t) return;
  t.hidden = false;
  t.textContent = JSON.stringify(json, null, 2);
}

function toastResult(r, doRefresh = true) {
  if (r.ok) {
    toast(r.result !== undefined ? "ok" : "ok ✓");
    if (doRefresh) refreshAfterDelay();
  } else {
    toast(`${r.error.name}: ${r.error.message}${r.error.code ? " (" + r.error.code + ")" : ""}`, "err");
  }
}

// ── 全局状态 ────────────────────────────────────────────────────────────────
const S = {
  config: null,
  credentialSource: null,
  accounts: [],
  endpoints: [],
  conversations: [],
  presence: {},
  sinkModes: {},
  counters: {},
  acceptance: null,
};

// ── Tab 切换 ────────────────────────────────────────────────────────────────
function initTabs() {
  $$("#tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#tabs .tab").forEach((b) => b.classList.remove("is-active"));
      $$(".panel").forEach((p) => p.classList.remove("is-visible"));
      btn.classList.add("is-active");
      $(`#tab-${btn.dataset.tab}`).classList.add("is-visible");
    });
  });
}

// ── 事件日志（Tab 1）────────────────────────────────────────────────────────
function pushEvent(ev) {
  const log = $("#eventlog");
  if (!log) return;
  const entry = el("div", { class: "ev" }, el("time", { text: fmtTime(new Date().toISOString()) }), el("span", { class: "t", text: ev.type }), el("span", { class: "d", text: JSON.stringify(ev.payload) }));
  log.prepend(entry);
  while (log.children.length > 200) log.lastChild.remove();
}

function pushSink(ev) {
  const log = $("#sinklog");
  if (!log) return;
  const p = ev.payload || {};
  const entry = el("div", { class: "ev" },
    el("time", { text: fmtTime(p.at) }),
    el("span", { class: "t", text: "sink_received" }),
    el("span", { class: "d", text: `${p.accountId} ← ${p.from}: ${JSON.stringify(p.text)} [${p.grade}] ${p.mode}${p.consumeImmediately ? " (auto)" : ""}` }));
  log.prepend(entry);
  while (log.children.length > 100) log.lastChild.remove();
}

function pushScenario(frame) {
  const box = $("#scenarioBox");
  if (!box) return;
  box.prepend(el("div", { class: `scenario-step ${frame.ok ? "is-ok" : "is-bad"}` },
    el("span", { class: "phase", text: frame.phase || frame.name }),
    el("span", { text: frame.step }),
    frame.detail !== undefined ? el("span", { class: "mono", style: "color:var(--muted)", text: " " + JSON.stringify(frame.detail) }) : null));
  while (box.children.length > 300) box.lastChild.remove();
}

// ── SSE ─────────────────────────────────────────────────────────────────────
function initSse() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", (e) => {
    try { const d = JSON.parse(e.data); $("#credBadge").textContent = "凭据 " + d.credential; $("#credBadge").className = "badge badge--muted"; } catch {}
  });
  es.addEventListener("mesh", (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    pushEvent(data);
    if (data.type === "sink_received") pushSink(data);
    if (data.type === "endpoint_state_changed") refreshAfterDelay();
    if (data.type.startsWith("message_")) refreshAfterDelay();
  });
  es.addEventListener("delivery", (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    pushTraceFeed(d);
  });
  es.addEventListener("scenario", (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    pushScenario(d);
  });
  es.addEventListener("tick", (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d.counters) S.counters = d.counters;
    if (d.acceptance) S.acceptance = d.acceptance;
    if (d.endpoints) mergeEndpointTicks(d.endpoints);
    renderDynamic();
  });
}

function pushTraceFeed(d) {
  const box = $("#traceFeed");
  if (!box) return;
  const row = el("div", { class: "ev" },
    el("time", { text: fmtTime(new Date().toISOString()) }),
    el("span", { class: "t", text: "trace" }),
    el("span", { class: "d", text: d.messageId + " → " + (d.traces || []).map((t) => `${t.accountId}:${t.state}`).join(", ") }));
  box.prepend(row);
  while (box.children.length > 100) box.lastChild.remove();
}

function mergeEndpointTicks(list) {
  for (const t of list || []) {
    const ep = S.endpoints.find((e) => e.id === t.endpointId);
    if (ep) { ep.state = t.state; ep.lease = t.lease; ep.piSessionId = t.piSessionId ?? ep.piSessionId; }
  }
}

let _refreshTimer = null;
function refreshAfterDelay() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(refreshState, 250);
}

async function refreshState() {
  const r = await rpc("state");
  if (r.ok) applyState(r.result);
}

function applyState(st) {
  if (!st) return;
  S.accounts = st.accounts || [];
  S.endpoints = st.endpoints || [];
  S.conversations = st.conversations || [];
  S.presence = st.presence || {};
  S.sinkModes = st.sinkModes || {};
  S.counters = st.counters || {};
  S.acceptance = st.acceptance || null;
  renderDynamic();
}

// ── 动态渲染 ────────────────────────────────────────────────────────────────
function renderDynamic() {
  refreshSelects();
  renderAccounts();
  renderEndpoints();
  renderConvos();
  renderSink();
  renderCounters();
  renderAcceptance();
}

// 同步下拉选项（.js-accounts / .js-convs / .js-endpoints / .js-pisessions）
function syncSelectOptions(sel, items, mkLabel) {
  const cur = sel.value;
  sel.innerHTML = "";
  for (const it of items) sel.append(el("option", { value: it, text: mkLabel ? mkLabel(it) : it }));
  if (items.includes(cur)) sel.value = cur;
}
function refreshSelects() {
  const accts = S.accounts.map((a) => a.id);
  const conv = S.conversations.map((c) => c.id);
  const eps = S.endpoints.map((e) => e.id);
  const pis = S.endpoints.filter((e) => e.piSessionId).map((e) => e.id);
  $$(".js-accounts").forEach((s) => syncSelectOptions(s, accts, (id) => { const a = S.accounts.find((x) => x.id === id); return `${id}${a ? " · " + a.displayName : ""}`; }));
  $$(".js-convs").forEach((s) => syncSelectOptions(s, conv));
  $$(".js-endpoints").forEach((s) => syncSelectOptions(s, eps, (id) => { const e = S.endpoints.find((x) => x.id === id); return `${id}${e ? " [" + e.state + "]" : ""}`; }));
  $$(".js-pisessions").forEach((s) => syncSelectOptions(s, pis, (id) => { const e = S.endpoints.find((x) => x.id === id); return `${e ? e.accountId : id} · ${e ? e.piSessionId : ""}`; }));
}

// ── 表单构建 ────────────────────────────────────────────────────────────────
function form(host, spec) {
  const fieldsRow = el("div", { class: "row" });
  const inputs = {};
  for (const f of spec.fields) {
    let input;
    if (f.type === "select") {
      input = el("select");
      if (f.cls) input.className = f.cls;
      for (const o of f.options || []) input.append(el("option", { value: typeof o === "object" ? o.value : o, text: typeof o === "object" ? o.label : o }));
    } else if (f.type === "checkboxes") {
      input = el("div", { class: "row", style: "align-items:center" });
      for (const o of f.options || []) {
        const cb = el("input", { type: "checkbox", value: o });
        input.append(el("label", { class: "tag", style: "cursor:pointer" }, cb, " " + o));
      }
    } else if (f.type === "checkbox") {
      input = el("input", { type: "checkbox", checked: !!f.value });
    } else if (f.type === "textarea") {
      input = el("textarea", { placeholder: f.placeholder || "", style: f.full ? "flex:2 1 100%" : "min-width:220px" }, f.value || "");
    } else {
      input = el("input", { type: f.type || "text", placeholder: f.placeholder || "", value: f.value || "" });
      if (f.cls) input.className = f.cls;
    }
    inputs[f.id] = input;
    fieldsRow.append(el("div", { class: "field", style: f.full ? "flex:1 1 100%" : "" }, el("label", { text: f.label || f.id }), input));
  }
  const btn = el("button", { class: "btn btn--primary", type: "submit", text: spec.submit || "执行" });
  const card = el("div", { class: "card" }, el("h3", { text: spec.title }), fieldsRow, el("div", { style: "margin-top:10px" }, btn));
  card.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = {};
    for (const f of spec.fields) {
      const inp = inputs[f.id];
      if (f.type === "checkboxes") values[f.id] = [...inp.querySelectorAll("input:checked")].map((c) => c.value);
      else if (f.type === "checkbox") values[f.id] = inp.checked;
      else if (f.type === "textarea") values[f.id] = inp.value;
      else values[f.id] = inp.value.trim();
    }
    spec.onRun(values);
  });
  el(host).append(card);
}

function maybeJson(s) {
  const t = (s || "").trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { toast(`JSON 解析失败：${t}`, "err"); throw new Error("bad json"); }
}
function csv(s) { return (s || "").split(",").map((x) => x.trim()).filter(Boolean); }

// ═══════════════════════════════════════════════════════════════════════════
// 各 Tab 构建（一次）
// ═══════════════════════════════════════════════════════════════════════════

function buildStatusTab() {
  const H = $("#tab-status");
  H.innerHTML = "";
  H.append(
    el("div", { class: "card" },
      el("h2", { text: "运行配置" }),
      el("div", { class: "kv", id: "configDump", text: "loading…" }),
      el("p", { style: "color:var(--muted);font-size:12px", text: "本面板 100% 真实：无密钥时启动即退出；凌晨密钥缺失会在此报错。" })),
    el("div", { class: "card" },
      el("h2", { text: "实时事件流（15 个 MeshEvent + sink_received）" }),
      el("div", { class: "eventlog", id: "eventlog" })),
  );
}

function buildAccountsTab() {
  const H = $("#tab-accounts");
  H.innerHTML = "";
  form(H, {
    title: "注册账号",
    submit: "registerAccount",
    fields: [
      { id: "id", label: "id（留空自动）", placeholder: "alice" },
      { id: "displayName", label: "displayName" },
      { id: "endpointClass", label: "endpointClass", type: "select", options: ["stream", "sink", "external"] },
      { id: "initiate", label: "initiate（可多选）", type: "checkboxes", options: ["chat", "task", "event", "system", "tombstone"] },
      { id: "capabilities", label: "capabilities（逗号）", placeholder: "speak,read" },
      { id: "defaultGrade", label: "defaultGrade", type: "select", options: ["", "steer", "followUp", "silent"] },
    ],
    onRun: (v) => rpc("registerAccount", { id: v.id, displayName: v.displayName, endpointClass: v.endpointClass, initiate: v.initiate, capabilities: csv(v.capabilities), defaultGrade: v.defaultGrade || undefined }).then((r) => { toastResult(r, false); if (r.ok) refreshAfterDelay(); }),
  });
  form(H, {
    title: "注册端点",
    submit: "registerEndpoint",
    fields: [
      { id: "accountId", label: "accountId", type: "select", cls: "js-accounts" },
      { id: "topology", label: "topology（JSON）", type: "textarea", value: '{"kind":"unified"}', placeholder: '{"kind":"unified"} | {"kind":"perConversation","scope":"conversation","key":"x"} | {"kind":"pooled","size":4}' },
    ],
    onRun: (v) => rpc("registerEndpoint", { accountId: v.accountId, topology: maybeJson(v.topology) }).then((r) => { toastResult(r); }),
  });
  form(H, {
    title: "presence / contact / lookup",
    submit: "setPresence（或下方 lookup）",
    fields: [
      { id: "accountId", label: "accountId", type: "select", cls: "js-accounts" },
      { id: "state", label: "state", type: "select", options: ["available", "busy", "dnd", "away", "offline"] },
      { id: "until", label: "until（ISO，留空）", placeholder: "2026-01-01T00:00:00Z" },
    ],
    onRun: (v) => rpc("setPresence", { accountId: v.accountId, state: v.state, until: v.until }).then(toastResult),
  });
  form(H, {
    title: "upsertContact",
    submit: "upsertContact",
    fields: [
      { id: "ownerId", label: "ownerId", type: "select", cls: "js-accounts" },
      { id: "peerId", label: "peerId" },
      { id: "alias", label: "alias" },
    ],
    onRun: (v) => rpc("upsertContact", { ownerId: v.ownerId, peerId: v.peerId, alias: v.alias }).then(toastResult),
  });
  form(H, {
    title: "lookup（寻址）",
    submit: "lookup",
    fields: [
      { id: "query", label: "query" },
      { id: "capabilities", label: "capabilities（逗号）", placeholder: "speak" },
      { id: "limit", label: "limit", type: "number", value: "20" },
    ],
    onRun: (v) => rpc("lookup", { query: v.query, capabilities: csv(v.capabilities), limit: Number(v.limit) }).then((r) => showResult(r, "#dump-accounts")),
  });
  H.append(el("div", { class: "card", id: "accountsCard" }, el("h2", { text: "账号" }), el("div", { id: "accountsList", class: "grid" })));
  H.append(el("div", { class: "card", id: "endpointsCard" }, el("h2", { text: "端点" }), el("div", { id: "endpointsList", class: "grid" })));
  H.append(el("pre", { id: "dump-accounts", hidden: true }));
}

function buildConvosTab() {
  const H = $("#tab-convos");
  H.innerHTML = "";
  form(H, {
    title: "createConversation",
    submit: "createConversation",
    fields: [
      { id: "type", label: "type", type: "select", options: ["group", "topic", "queue"] },
      { id: "creator", label: "creator", type: "select", cls: "js-accounts" },
      { id: "members", label: "members（逗号）", placeholder: "bob,carol" },
      { id: "topic", label: "topic" },
    ],
    onRun: (v) => rpc("createConversation", { type: v.type, creator: v.creator, members: csv(v.members), topic: v.topic }).then(toastResult),
  });
  form(H, {
    title: "ensureDirect",
    submit: "ensureDirect",
    fields: [
      { id: "a", label: "a", type: "select", cls: "js-accounts" },
      { id: "b", label: "b", type: "select", cls: "js-accounts" },
    ],
    onRun: (v) => rpc("ensureDirect", { a: v.a, b: v.b }).then(toastResult),
  });
  const memberFields = [
    { id: "conv", label: "conversation", type: "select", cls: "js-convs" },
    { id: "account", label: "account", type: "select", cls: "js-accounts" },
    { id: "by", label: "by（操作者）", type: "select", cls: "js-accounts" },
    { id: "arg", label: "text/topic/announcement/until/caps/extra", placeholder: "文本、ISO 时间、逗号 caps、逗号 extra" },
  ];
  form(H, {
    title: "addMember / removeMember / join / leave",
    submit: "addMember",
    fields: memberFields,
    onRun: (v) => rpc("addMember", { conv: v.conv, account: v.account, by: v.by, caps: csv(v.arg) }).then(toastResult),
  });
  const memberActionForms = [
    ["setCaps", "setCaps", (v) => ({ conv: v.conv, account: v.account, by: v.by, caps: csv(v.arg) })],
    ["setTopic", "setTopic", (v) => ({ conv: v.conv, by: v.by, text: v.arg })],
    ["setAnnouncement", "setAnnouncement", (v) => ({ conv: v.conv, by: v.by, text: v.arg })],
    ["removeMember", "removeMember", (v) => ({ conv: v.conv, account: v.account, by: v.by })],
    ["join", "join", (v) => ({ conv: v.conv, account: v.account })],
    ["leave", "leave", (v) => ({ conv: v.conv, account: v.account })],
    ["mute", "mute", (v) => ({ conv: v.conv, account: v.account, until: v.arg })],
    ["dissolve", "dissolve", (v) => ({ conv: v.conv, by: v.by })],
    ["upgradeToGroup", "upgradeToGroup", (v) => ({ conv: v.conv, extra: csv(v.arg), by: v.by })],
    ["subscribe", "subscribe", (v) => ({ conv: v.conv, account: v.account })],
    ["unsubscribe", "unsubscribe", (v) => ({ conv: v.conv, account: v.account })],
  ];
  for (const [title, cmd, mk] of memberActionForms) {
    form(H, { title, submit: cmd, fields: memberFields, onRun: (v) => rpc(cmd, mk(v)).then(toastResult) });
  }
  H.append(el("div", { class: "card" }, el("h2", { text: "会话" }), el("div", { id: "convoList" })));
}

function buildSendTab() {
  const H = $("#tab-send");
  H.innerHTML = "";
  form(H, {
    title: "send（组合器）",
    submit: "send",
    fields: [
      { id: "from", label: "from", type: "select", cls: "js-accounts" },
      { id: "conversationId", label: "conversationId", type: "select", cls: "js-convs" },
      { id: "text", label: "text", type: "textarea", full: true, value: "hello from the demo panel" },
      { id: "kind", label: "kind", type: "select", options: ["chat", "task", "event", "system", "tombstone"] },
      { id: "expect", label: "expect", type: "select", options: ["none", "ack", "reply"] },
      { id: "priority", label: "priority", type: "select", options: ["", "urgent", "normal", "low"] },
      { id: "to", label: "to（逗号；空=全体-自己）", placeholder: "bob" },
      { id: "mentions", label: "mentions（逗号）", placeholder: "@all 或 bob" },
      { id: "replyTo", label: "replyTo（messageId）" },
    ],
    onRun: (v) => rpc("send", { from: v.from, conversationId: v.conversationId, text: v.text, kind: v.kind, expect: v.expect, priority: v.priority || undefined, to: csv(v.to), mentions: csv(v.mentions), replyTo: v.replyTo }).then((r) => { showResult(r, "#dump-send"); toastResult(r); }),
  });
  H.append(el("pre", { id: "dump-send", hidden: false }));
}

function buildSinkTab() {
  const H = $("#tab-sink");
  H.innerHTML = "";
  H.append(el("p", { style: "color:var(--muted);font-size:12px", text: "对 sink 账号切换 accept/refuse；refuse → 投递落 parked(SINK_REFUSED)；accept + auto consume → 自动 consumed。" }));
  H.append(el("div", { class: "card", id: "sinkCard" }, el("h2", { text: "Sink 账号" }), el("div", { id: "sinkList" })));
  form(H, {
    title: "sink ack（markConsumed，需 deliveryId）",
    submit: "markConsumed",
    fields: [{ id: "deliveryId", label: "deliveryId", placeholder: "从 trace/sink_received 里拿" }],
    onRun: (v) => rpc("markConsumed", { deliveryId: v.deliveryId }).then(toastResult),
  });
  H.append(el("div", { class: "card" }, el("h2", { text: "sink_received 事件" }), el("div", { class: "eventlog", id: "sinklog" })));
}

function buildStreamTab() {
  const H = $("#tab-stream");
  H.innerHTML = "";
  H.append(el("p", { style: "color:var(--muted);font-size:12px", text: "warm 走真实 createAgentSession（首次冷起加载模型）；nudge 起真实 agent 轮（有 mesh 工具往返）；injectContext / beforeClearQueue / toolSet。" }));
  form(H, {
    title: "warm / evict",
    submit: "warm",
    fields: [
      { id: "endpointId", label: "endpointId", type: "select", cls: "js-endpoints" },
      { id: "lease", label: "lease", type: "select", options: ["shared", "exclusive"] },
    ],
    onRun: (v) => rpc("warm", { endpointId: v.endpointId, lease: v.lease }).then(toastResult),
  });
  form(H, {
    title: "nudge（真实轮次）",
    submit: "nudge",
    fields: [
      { id: "endpointId", label: "endpointId", type: "select", cls: "js-endpoints" },
      { id: "cue", label: "cue", type: "textarea", value: "查一下 mesh_inbox 并用 mesh_send 回复你看到的最新消息" },
      { id: "deliverAs", label: "deliverAs", type: "select", options: ["steer", "followUp"] },
      { id: "triggerTurn", label: "triggerTurn", type: "checkbox", value: true },
    ],
    onRun: (v) => rpc("nudge", { endpointId: v.endpointId, cue: v.cue, deliverAs: v.deliverAs, triggerTurn: v.triggerTurn }).then(toastResult),
  });
  form(H, {
    title: "injectContext / beforeClearQueue",
    submit: "injectContext",
    fields: [
      { id: "endpointId", label: "endpointId", type: "select", cls: "js-endpoints" },
      { id: "text", label: "text", type: "textarea", value: "额外注入的上下文" },
    ],
    onRun: (v) => rpc("injectContext", { endpointId: v.endpointId, text: v.text }).then(toastResult),
  });
  form(H, {
    title: "toolSet（端点可用工具元数据）",
    submit: "toolSet",
    fields: [
      { id: "endpointId", label: "endpointId", type: "select", cls: "js-endpoints" },
      { id: "only", label: "only（逗号白名单）", placeholder: "mesh_send,mesh_inbox" },
    ],
    onRun: (v) => rpc("toolSet", { endpointId: v.endpointId, only: csv(v.only) }).then((r) => showResult(r, "#dump-stream")),
  });
  form(H, {
    title: "streamEntries（真实 pi 流条目）",
    submit: "streamEntries",
    fields: [
      { id: "endpointId", label: "endpoint（已热）", type: "select", cls: "js-pisessions" },
      { id: "sinceSeq", label: "sinceSeq", type: "number", value: "0" },
    ],
    onRun: (v) => rpc("streamEntries", { endpointId: v.endpointId, piSessionId: (S.endpoints.find((e) => e.id === v.endpointId) || {}).piSessionId, sinceSeq: Number(v.sinceSeq) }).then((r) => showResult(r, "#dump-stream")),
  });
  H.append(el("div", { class: "card" }, el("h2", { text: "投递轨迹 feed（live）" }), el("div", { class: "eventlog", id: "traceFeed" })));
  H.append(el("pre", { id: "dump-stream", hidden: true }));
}

function buildObserverTab() {
  const H = $("#tab-observer");
  H.innerHTML = "";
  form(H, {
    title: "trace（投递轨迹）",
    submit: "trace",
    fields: [{ id: "messageId", label: "messageId", placeholder: "从 message_routed 事件拿" }],
    onRun: (v) => rpc("trace", { messageId: v.messageId }).then((r) => showResult(r, "#dump-observer")),
  });
  form(H, {
    title: "messages / search",
    submit: "messages",
    fields: [
      { id: "conversationId", label: "conversationId", type: "select", cls: "js-convs" },
      { id: "from", label: "from", type: "select", cls: "js-accounts" },
      { id: "text", label: "搜索文本（search 时用）", placeholder: "留空 = messages" },
      { id: "kind", label: "kind", type: "select", options: ["", "chat", "task", "event", "system", "tombstone"] },
      { id: "limit", label: "limit", type: "number", value: "50" },
    ],
    onRun: (v) => {
      const q = { conversationId: v.conversationId || undefined, from: v.from || undefined, kind: v.kind || undefined, limit: Number(v.limit) };
      if (v.text) return rpc("search", { text: v.text, ...q }).then((r) => showResult(r, "#dump-observer"));
      return rpc("messages", q).then((r) => showResult(r, "#dump-observer"));
    },
  });
  form(H, {
    title: "inboxOf / conversationsOf",
    submit: "inboxOf",
    fields: [{ id: "accountId", label: "accountId", type: "select", cls: "js-accounts" }],
    onRun: (v) => {
      rpc("inboxOf", { accountId: v.accountId }).then((r) => showResult(r, "#dump-observer"));
      rpc("conversationsOf", { accountId: v.accountId }).then((r) => { const out = $("#dump-convoOf"); if (out) { out.hidden = false; out.textContent = JSON.stringify(r, null, 2); } });
    },
  });
  H.append(el("pre", { id: "dump-convoOf", hidden: false }));
  form(H, {
    title: "counters / checkInvariants",
    submit: "counters",
    fields: [{ id: "names", label: "names（逗号白名单，空=全部）", placeholder: "messages_total,deliveries_total" }],
    onRun: (v) => {
      rpc("counters", { names: csv(v.names) }).then((r) => showResult(r, "#dump-observer"));
      rpc("checkInvariants").then((r) => { const out = $("#dump-invariant"); if (out) { out.hidden = false; out.textContent = JSON.stringify(r, null, 2); } });
    },
  });
  H.append(el("pre", { id: "dump-invariant", hidden: false }));
  H.append(el("div", { class: "card" }, el("h2", { text: "计数器（每秒 tick 快照）" }), el("div", { id: "countersList", class: "kv" })));
  H.append(el("pre", { id: "dump-observer", hidden: true }));
}

function buildAcceptTab() {
  const H = $("#tab-accept");
  H.innerHTML = "";
  H.append(el("div", { class: "card", id: "acceptCard" },
    el("h2", { text: "§24.2 验收比值（实时）" }),
    el("div", { id: "acceptList" }),
    el("p", { style: "color:var(--muted);font-size:12px", text: "比值由 counters 现算，不存比值。「唤醒决策」在投递时已定，与 LLM 轮时延/成本无关。" })));
  H.append(el("div", { class: "card", id: "scenarioCard" },
    el("h2", { text: "一键场景" }),
    el("div", { class: "row", style: "margin-bottom:8px" },
      el("button", { class: "btn btn--primary", text: "跑 P0（零 LLM 轮）", onclick: () => runScenario("P0") }),
      el("button", { class: "btn btn--primary", text: "跑 P1（3 真实轮）", onclick: () => runScenario("P1") })),
    el("p", { style: "color:var(--muted);font-size:12px", text: "P0：alice/bob warm + 10 条 expect:none 逐条 markConsumed + sink 自动 consumed，零 LLM 成本。P1：20 账号群，47 静默广播 + 3 条 expect:reply 唤醒真实轮。" }),
    el("div", { id: "scenarioBox" })));
}

async function runScenario(name) {
  $("#scenarioBox").innerHTML = "";
  const r = await rpc("runScenario", { name });
  if (!r.ok) toast(`${r.error.name}: ${r.error.message}`, "err");
  refreshAfterDelay();
}

function buildTopicTab() {
  const H = $("#tab-topic");
  H.innerHTML = "";
  H.append(el("p", { style: "color:var(--muted);font-size:12px", text: "Topic（§16）：订阅者 fanout 广播，每条消息对每个订阅者产生一条投递。静默投递、不唤醒。" }));
  form(H, {
    title: "subscribe（订阅 topic）",
    submit: "subscribe",
    fields: [
      { id: "conv", label: "topic conversation", type: "select", cls: "js-convs" },
      { id: "account", label: "account", type: "select", cls: "js-accounts" },
    ],
    onRun: (v) => rpc("subscribe", { conv: v.conv, account: v.account }).then(toastResult),
  });
  form(H, {
    title: "unsubscribe（取消订阅）",
    submit: "unsubscribe",
    fields: [
      { id: "conv", label: "topic conversation", type: "select", cls: "js-convs" },
      { id: "account", label: "account", type: "select", cls: "js-accounts" },
    ],
    onRun: (v) => rpc("unsubscribe", { conv: v.conv, account: v.account }).then(toastResult),
  });
  form(H, {
    title: "publish to topic（向 topic 发消息）",
    submit: "send",
    fields: [
      { id: "from", label: "from", type: "select", cls: "js-accounts" },
      { id: "conversationId", label: "topic conversation", type: "select", cls: "js-convs" },
      { id: "text", label: "text", type: "textarea", full: true, value: "topic broadcast message" },
    ],
    onRun: (v) => rpc("send", { from: v.from, conversationId: v.conversationId, kind: "event", expect: "none", text: v.text }).then((r) => { showResult(r, "#dump-topic"); toastResult(r); }),
  });
  form(H, {
    title: "inboxOf（查订阅者收件箱）",
    submit: "inboxOf",
    fields: [{ id: "accountId", label: "accountId", type: "select", cls: "js-accounts" }],
    onRun: (v) => rpc("inboxOf", { accountId: v.accountId }).then((r) => showResult(r, "#dump-topic")),
  });
  H.append(el("pre", { id: "dump-topic", hidden: false }));
}

function buildReqReplyTab() {
  const H = $("#tab-reqreply");
  H.innerHTML = "";
  H.append(el("p", { style: "color:var(--muted);font-size:12px", text: "请求-应答（§14）：send expect:ack → 对方用 ack 回复。非阻塞返回 correlationId；阻塞 await:true 等 message_acked 事件。" }));
  form(H, {
    title: "request（非阻塞，返回 correlationId）",
    submit: "request",
    fields: [
      { id: "from", label: "from", type: "select", cls: "js-accounts" },
      { id: "conversationId", label: "conversationId", type: "select", cls: "js-convs" },
      { id: "text", label: "text", type: "textarea", full: true, value: "please respond" },
      { id: "kind", label: "kind", type: "select", options: ["chat", "task"] },
    ],
    onRun: (v) => rpc("request", { from: v.from, conversationId: v.conversationId, kind: v.kind, text: v.text }).then((r) => showResult(r, "#dump-reqreply")),
  });
  form(H, {
    title: "request（阻塞，等应答返回 AckResult）",
    submit: "request (await)",
    fields: [
      { id: "from", label: "from", type: "select", cls: "js-accounts" },
      { id: "conversationId", label: "conversationId", type: "select", cls: "js-convs" },
      { id: "text", label: "text", type: "textarea", full: true, value: "blocking request" },
    ],
    onRun: (v) => rpc("request", { from: v.from, conversationId: v.conversationId, kind: "chat", text: v.text, blocking: true }).then((r) => showResult(r, "#dump-reqreply")),
  });
  form(H, {
    title: "ack（应答一个请求，需 correlationId）",
    submit: "ack",
    fields: [
      { id: "correlationId", label: "correlationId", placeholder: "从 message_routed 事件拿" },
      { id: "from", label: "from（应答者）", type: "select", cls: "js-accounts" },
      { id: "data", label: "data（JSON 应答体）", type: "textarea", placeholder: '{"answer": 42}' },
      { id: "error", label: "error（nack 时填）", placeholder: "something went wrong" },
    ],
    onRun: (v) => rpc("ack", { correlationId: v.correlationId, from: v.from, data: maybeJson(v.data), error: v.error || undefined }).then((r) => { showResult(r, "#dump-reqreply"); toastResult(r); }),
  });
  form(H, {
    title: "trace（追踪消息状态，看 claimed→acked）",
    submit: "trace",
    fields: [{ id: "messageId", label: "messageId", placeholder: "从 send/request 返回值拿" }],
    onRun: (v) => rpc("trace", { messageId: v.messageId }).then((r) => showResult(r, "#dump-reqreply")),
  });
  H.append(el("pre", { id: "dump-reqreply", hidden: false }));
}

function buildQueueTab() {
  const H = $("#tab-queue");
  H.innerHTML = "";
  H.append(el("p", { style: "color:var(--muted);font-size:12px", text: "Queue（§17）：竞争消费。send kind:task 入队 → 单消费者 claimed → ack/nack。messageId 从 send 返回值拿。" }));
  form(H, {
    title: "claim（认领队列任务）",
    submit: "claim",
    fields: [
      { id: "messageId", label: "messageId", placeholder: "从 send 返回值或 message_routed 事件拿" },
      { id: "by", label: "by（认领者）", type: "select", cls: "js-accounts" },
    ],
    onRun: (v) => rpc("claim", { messageId: v.messageId, by: v.by }).then((r) => showResult(r, "#dump-queue")),
  });
  form(H, {
    title: "ack queue task（确认完成队列任务）",
    submit: "ack",
    fields: [
      { id: "correlationId", label: "correlationId", placeholder: "从 message_routed 事件拿" },
      { id: "from", label: "from（认领者）", type: "select", cls: "js-accounts" },
      { id: "error", label: "error（nack 时填，消息回队）", placeholder: "retry later" },
    ],
    onRun: (v) => rpc("ack", { correlationId: v.correlationId, from: v.from, error: v.error || undefined }).then((r) => { showResult(r, "#dump-queue"); toastResult(r); }),
  });
  form(H, {
    title: "requeue（把任务转到另一队列）",
    submit: "requeue",
    fields: [
      { id: "messageId", label: "messageId", placeholder: "原消息 messageId" },
      { id: "targetConversationId", label: "targetConversationId（目标队列）", type: "select", cls: "js-convs" },
    ],
    onRun: (v) => rpc("requeue", { messageId: v.messageId, targetConversationId: v.targetConversationId }).then((r) => { showResult(r, "#dump-queue"); toastResult(r); }),
  });
  form(H, {
    title: "trace（追踪队列消息状态）",
    submit: "trace",
    fields: [{ id: "messageId", label: "messageId" }],
    onRun: (v) => rpc("trace", { messageId: v.messageId }).then((r) => showResult(r, "#dump-queue")),
  });
  H.append(el("pre", { id: "dump-queue", hidden: false }));
}

function buildSharedTab() {
  const H = $("#tab-shared");
  H.innerHTML = "";
  H.append(el("p", { style: "color:var(--muted);font-size:12px", text: "共享空间（§18）：get/put/append/del/list，版本化 + CAS。spaceId 为 global | conv:<id> | acct:<id>。" }));
  form(H, {
    title: "sharedGet（读取）",
    submit: "sharedGet",
    fields: [
      { id: "spaceId", label: "spaceId", value: "global" },
      { id: "key", label: "key", placeholder: "my-key" },
      { id: "as", label: "as（操作者）", type: "select", cls: "js-accounts" },
    ],
    onRun: (v) => rpc("sharedGet", { spaceId: v.spaceId, key: v.key, as: v.as }).then((r) => showResult(r, "#dump-shared")),
  });
  form(H, {
    title: "sharedPut（写入，可选 expectedVersion CAS）",
    submit: "sharedPut",
    fields: [
      { id: "spaceId", label: "spaceId", value: "global" },
      { id: "key", label: "key" },
      { id: "data", label: "data（JSON）", type: "textarea", value: '{"hello":"world"}' },
      { id: "as", label: "as（操作者）", type: "select", cls: "js-accounts" },
      { id: "expectedVersion", label: "expectedVersion（0=断言不存在，空=盲写）", type: "number" },
    ],
    onRun: (v) => rpc("sharedPut", { spaceId: v.spaceId, key: v.key, data: maybeJson(v.data), as: v.as, expectedVersion: Number(v.expectedVersion) || undefined }).then((r) => { showResult(r, "#dump-shared"); toastResult(r); }),
  });
  form(H, {
    title: "sharedAppend（追加到数组）",
    submit: "sharedAppend",
    fields: [
      { id: "spaceId", label: "spaceId", value: "global" },
      { id: "key", label: "key" },
      { id: "item", label: "item（JSON 元素）", type: "textarea", value: "1" },
      { id: "as", label: "as（操作者）", type: "select", cls: "js-accounts" },
    ],
    onRun: (v) => rpc("sharedAppend", { spaceId: v.spaceId, key: v.key, item: maybeJson(v.item), as: v.as }).then((r) => { showResult(r, "#dump-shared"); toastResult(r); }),
  });
  form(H, {
    title: "sharedDel（删除，软删 tombstone）",
    submit: "sharedDel",
    fields: [
      { id: "spaceId", label: "spaceId", value: "global" },
      { id: "key", label: "key" },
      { id: "as", label: "as（操作者）", type: "select", cls: "js-accounts" },
    ],
    onRun: (v) => rpc("sharedDel", { spaceId: v.spaceId, key: v.key, as: v.as }).then((r) => { showResult(r, "#dump-shared"); toastResult(r); }),
  });
  form(H, {
    title: "sharedList（列出空间下所有 key）",
    submit: "sharedList",
    fields: [
      { id: "spaceId", label: "spaceId", value: "global" },
      { id: "as", label: "as（操作者）", type: "select", cls: "js-accounts" },
    ],
    onRun: (v) => rpc("sharedList", { spaceId: v.spaceId, as: v.as }).then((r) => showResult(r, "#dump-shared")),
  });
  H.append(el("pre", { id: "dump-shared", hidden: false }));
}

function buildReplayTab() {
  const H = $("#tab-replay");
  H.innerHTML = "";
  H.append(el("p", { style: "color:var(--muted);font-size:12px", text: "Observer.replay（零 LLM 回放）：把端点流条目转写成 prompt + entries，供离线分析。forkAt 维持 unsupported。" }));
  form(H, {
    title: "replay（回放端点流，零 LLM）",
    submit: "replay",
    fields: [
      { id: "endpointId", label: "endpointId", type: "select", cls: "js-pisessions" },
    ],
    onRun: (v) => rpc("replay", { endpointId: v.endpointId }).then((r) => showResult(r, "#dump-replay")),
  });
  form(H, {
    title: "streamEntries（读端点原始流条目）",
    submit: "streamEntries",
    fields: [
      { id: "endpointId", label: "endpoint（已热）", type: "select", cls: "js-pisessions" },
      { id: "sinceSeq", label: "sinceSeq", type: "number", value: "0" },
    ],
    onRun: (v) => rpc("streamEntries", { endpointId: v.endpointId, piSessionId: (S.endpoints.find((e) => e.id === v.endpointId) || {}).piSessionId, sinceSeq: Number(v.sinceSeq) }).then((r) => showResult(r, "#dump-replay")),
  });
  form(H, {
    title: "forkAt（P2 deferred，抛 MeshUnsupportedError）",
    submit: "forkAt",
    fields: [
      { id: "endpointId", label: "endpointId", type: "select", cls: "js-pisessions" },
      { id: "entryId", label: "entryId", placeholder: "entry id" },
    ],
    onRun: (v) => rpc("forkAt", { endpointId: v.endpointId, entryId: v.entryId }).then((r) => showResult(r, "#dump-replay")),
  });
  H.append(el("pre", { id: "dump-replay", hidden: false }));
}

function buildUnwiredTab() {}

// ── 动态列表渲染 ────────────────────────────────────────────────────────────
function renderAccounts() {
  const box = $("#accountsList");
  if (!box) return;
  box.innerHTML = "";
  if (!S.accounts.length) { box.append(el("span", { class: "mono", style: "color:var(--muted)", text: "（无账号）" })); return; }
  for (const a of S.accounts) {
    box.append(el("div", { class: "card", style: "margin:0" },
      el("div", { class: "kv" }, el("b", { text: a.id }), el("span", { text: a.displayName })),
      el("div", {},
        el("span", { class: "tag", text: a.endpointClass }),
        ...(a.initiate || []).map((k) => el("span", { class: "tag tag--accent", text: k })),
        a.defaultGrade ? el("span", { class: "tag tag--amber", text: a.defaultGrade }) : null,
        el("span", { class: "tag", text: "presence: " + (S.presence[a.id] || "—") }))));
  }
}

function renderEndpoints() {
  const box = $("#endpointsList");
  if (!box) return;
  box.innerHTML = "";
  if (!S.endpoints.length) { box.append(el("span", { class: "mono", style: "color:var(--muted)", text: "（无端点）" })); return; }
  for (const e of S.endpoints) {
    const stateCls = { hot: "tag--green", cold: "", warming: "tag--amber", evicting: "tag--amber", unavailable: "tag--red" }[e.state] || "";
    box.append(el("div", { class: "card", style: "margin:0" },
      el("div", { class: "kv" }, el("b", { class: "mono", text: e.id }), el("span", { text: "← " + e.accountId })),
      el("div", { style: "margin:4px 0" },
        el("span", { class: `tag ${stateCls}`, text: e.state }),
        el("span", { class: "tag", text: e.lease }),
        e.piSessionId ? el("span", { class: "tag", text: "session ✓" }) : null),
      el("div", { class: "row", style: "gap:4px" },
        el("button", { class: "btn btn--sm", text: "warm", onclick: () => rpc("warm", { endpointId: e.id, lease: "shared" }).then(toastResult) }),
        el("button", { class: "btn btn--sm", text: "evict", onclick: () => rpc("evict", { endpointId: e.id }).then(toastResult) }),
        el("button", { class: "btn btn--sm", text: "nudge", onclick: () => rpc("nudge", { endpointId: e.id, cue: "查一下 mesh_inbox，用 mesh_send 回复最新一条", deliverAs: "steer", triggerTurn: true }).then(toastResult) }),
        el("button", { class: "btn btn--sm", text: "beforeClearQueue", onclick: () => rpc("beforeClearQueue", { endpointId: e.id }).then(toastResult) }))));
  }
}

function renderConvos() {
  const box = $("#convoList");
  if (!box) return;
  box.innerHTML = "";
  if (!S.conversations.length) { box.append(el("span", { class: "mono", style: "color:var(--muted)", text: "（无会话）" })); return; }
  for (const c of S.conversations) {
    box.append(el("div", { class: "card" },
      el("div", { class: "kv" }, el("b", { class: "mono", text: c.id }), el("span", { text: c.kind }), el("span", { text: c.state })),
      c.topic ? el("div", { text: "topic: " + c.topic }) : null,
      el("div", { class: "kv" }, el("span", { text: "createdBy " + c.createdBy }), el("span", { text: "lastSeq " + c.lastSeq }))));
  }
}

function renderSink() {
  const box = $("#sinkList");
  if (!box) return;
  box.innerHTML = "";
  const sinks = S.accounts.filter((a) => a.endpointClass === "sink");
  if (!sinks.length) { box.append(el("span", { class: "mono", style: "color:var(--muted)", text: "（无 sink 账号，去「账号与端点」注册 endpointClass=sink）" })); return; }
  for (const a of sinks) {
    const mode = S.sinkModes[a.id] || "accept";
    box.append(el("div", { class: "card", style: "margin:0" },
      el("div", { class: "kv" }, el("b", { text: a.id }), el("span", { text: a.displayName })),
      el("div", { class: "row", style: "margin-top:6px" },
        el("button", { class: `btn btn--sm ${mode === "accept" ? "" : "btn--danger"}`, text: "accept", onclick: () => { rpc("setSinkMode", { accountId: a.id, mode: "accept", consumeImmediately: false }).then(toastResult); refreshAfterDelay(); } }),
        el("button", { class: `btn btn--sm ${mode === "refuse" ? "" : "btn--danger"}`, text: "refuse", onclick: () => { rpc("setSinkMode", { accountId: a.id, mode: "refuse" }).then(toastResult); refreshAfterDelay(); } }),
        el("button", { class: "btn btn--sm", text: "auto-consume", onclick: () => { rpc("setSinkMode", { accountId: a.id, mode: "accept", consumeImmediately: true }).then(toastResult); refreshAfterDelay(); } }))));
  }
}

const COUNTER_NAMES = {
  messages_total: "消息总数",
  deliveries_total: "投递总数",
  verbatim_copies: "原文份数",
  silent_grade: "沉默档",
  cold_hit: "冷命中",
  wake_per_message_idle: "唤醒·idle",
  wake_per_message_busy: "唤醒·busy",
  dedup_hit: "去重命中",
  fanout_warn: "扇出告警",
  invariant_violated: "不变量违规",
};

function renderCounters() {
  const box = $("#countersList");
  if (!box) return;
  box.innerHTML = "";
  const c = S.counters || {};
  const keys = Object.keys(c).sort();
  if (!keys.length) { box.append(el("span", { class: "mono", text: "（无计数器）" })); return; }
  for (const k of keys) {
    box.append(el("span", {}, el("b", { text: (COUNTER_NAMES[k] || k) + " " }), el("span", { class: "mono", text: String(c[k]) })));
  }
}

function renderAcceptance() {
  const box = $("#acceptList");
  if (!box) return;
  box.innerHTML = "";
  const acc = S.acceptance;
  if (!acc || !acc.ratios) { box.append(el("span", { class: "mono", style: "color:var(--muted)", text: "（还没有消息，发几条后再看）" })); return; }
  const names = [
    ["avgWake", "平均唤醒 (idle+busy)/messages"],
    ["busy", "busy 分支 / messages"],
    ["verbatimPerMsg", "原文份数 / messages"],
    ["silence", "沉默率 silent/deliveries"],
    ["verbatimRate", "原文率 verbatim/deliveries"],
    ["coldHit", "冷命中 cold/silent"],
  ];
  const base = `${acc.messages ?? 0} 条消息 · ${acc.deliveries ?? 0} 条投递`;
  box.append(el("div", { class: "kv", style: "margin-bottom:8px" }, el("b", { text: base })));
  for (const [key, label] of names) {
    const r = acc.ratios[key];
    if (!r) continue;
    const ok = r.ok === null ? "na" : r.ok ? "ok" : "no";
    const okText = r.ok === null ? "参考" : r.ok ? "达标 ✓" : "未达标 ✗";
    box.append(el("div", { class: "ratio" },
      el("span", { class: "name", text: label + "   [" + r.limit + "]" }),
      el("span", { class: "val", text: r.value === null ? "—" : r.value.toFixed(3) }),
      el("span", { class: ok, text: okText })));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════════════════════
async function boot() {
  initTabs();
  buildStatusTab();
  buildAccountsTab();
  buildConvosTab();
  buildSendTab();
  buildSinkTab();
  buildStreamTab();
  buildObserverTab();
  buildAcceptTab();
  buildTopicTab();
  buildReqReplyTab();
  buildQueueTab();
  buildSharedTab();
  buildReplayTab();
  initSse();

  const health = await rpc("health");
  if (health.ok && health.result) {
    const cfg = health.result.config || {};
    $("#configDump").innerHTML = Object.entries(cfg).map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join("");
    $("#credBadge").textContent = "凭据 " + health.result.credentialSource;
    $("#credBadge").className = "badge";
    S.config = cfg;
  }
  await refreshState();
}

boot();