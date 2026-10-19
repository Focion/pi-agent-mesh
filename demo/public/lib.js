// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 前端共享层（vanilla ES module，零依赖）。
//
// 提供：DOM 原语（$ / $$ / el / esc / fmtTime）、rpc 解包、toast、集中状态
// state、事件总线 bus、SSE 接入（initSse）、快照刷新（refreshSnapshot）、
// Tab 路由（initTabs）。各 tab 模块只 import 本层，避免重复与相互依赖。
// ═══════════════════════════════════════════════════════════════════════════

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// 安全清空容器（避免用 innerHTML 承载/清空数据）。
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

export function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "style") n.style.cssText = v;
    else if (k === "value") n.value = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    n.append(c && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

export const fmtTime = (d) => (d && d.toTimeString ? d.toTimeString().slice(0, 8) : "");
export const clock = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : fmtTime(d);
};

// ── rpc：POST /api/<command> → {ok, result?|error} 统一解包 ──────────────────
export async function rpc(cmd, args = {}) {
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (body && body.ok === false) {
    const e = body.error || {};
    throw new Error(`${e.name ?? "Error"}${e.code ? ` (${e.code})` : ""}: ${e.message ?? "rpc failed"}`);
  }
  return body ? body.result : undefined;
}

// 失败的 rpc 统一以 toast 呈现（返回 null）；成功返回 result。
export async function safeRpc(cmd, args = {}) {
  try {
    return await rpc(cmd, args);
  } catch (err) {
    toast(String(err?.message ?? err), "err");
    return null;
  }
}

export function toast(msg, kind = "ok") {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.className = `toast is-${kind}`;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.hidden = true;
  }, 3200);
}

// ── 集中状态（各 tab 读写；SSE/tick 增量维护）──────────────────────────────
export const state = {
  hello: null,
  health: null,
  group: null, // { groupId?, topic }
  roster: [], // AgentInfo[]（chat stream 账号）
  rosterById: new Map(),
  accounts: [], // Account[]
  endpoints: [], // Endpoint[]
  conversations: [], // Conversation[]
  presence: {}, // accountId -> PresenceView
  sinkModes: {}, // accountId -> 'accept' | 'refuse'
  counters: {}, // name -> number
  acceptance: null, // computeAcceptance()
  activity: [], // 汇聚的 MeshEvent（{type, payload, at}）
};

// ── 事件总线 ────────────────────────────────────────────────────────────────
const listeners = new Map();
export const bus = {
  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, []);
    listeners.get(ev).push(fn);
  },
  emit(ev, data) {
    for (const fn of listeners.get(ev) || []) {
      try {
        fn(data);
      } catch (e) {
        console.error("[bus]", ev, e);
      }
    }
  },
};

function pushActivity(type, payload) {
  if (!type) return;
  state.activity.unshift({ type, payload, at: payload?.at || new Date().toISOString() });
  if (state.activity.length > 300) state.activity.length = 300; // 有界，避免无限增长
}

function mergeTick(t) {
  if (t.counters) state.counters = t.counters;
  if (t.acceptance) state.acceptance = t.acceptance;
  if (Array.isArray(t.endpoints)) {
    for (const e of t.endpoints) {
      const ex = state.endpoints.find((x) => x.id === e.endpointId);
      if (ex) {
        ex.state = e.state;
        ex.lease = e.lease;
        ex.piSessionId = e.piSessionId;
      }
    }
  }
}

// ── SSE 接入：把 5 类帧路由到 bus + 维护共享状态 ─────────────────────────────
export function initSse() {
  const es = new EventSource("/api/events");
  const j = (e) => {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  };
  es.addEventListener("hello", (e) => {
    const d = j(e);
    if (d) {
      state.hello = d;
      bus.emit("hello", d);
    }
  });
  es.addEventListener("meshmsg", (e) => {
    const d = j(e);
    if (d) bus.emit("meshmsg", d);
  });
  es.addEventListener("mesh", (e) => {
    const d = j(e);
    if (!d) return;
    const { type, payload } = d;
    // 派生态实时更新共享状态（供拓扑/观测即时反映，无需等 tick）。
    if (type === "presence_changed" && payload?.accountId) {
      state.presence[payload.accountId] = {
        state: payload.to,
        source: payload.source ?? "host",
        ...(payload.until ? { until: payload.until } : {}),
        ...(payload.reason ? { reason: payload.reason } : {}),
        at: payload.at || new Date().toISOString(),
      };
    } else if (type === "endpoint_state_changed" && payload?.endpointId) {
      const ex = state.endpoints.find((x) => x.id === payload.endpointId);
      if (ex) ex.state = payload.to;
    }
    pushActivity(type, payload);
    bus.emit("mesh", d);
  });
  es.addEventListener("delivery", (e) => {
    const d = j(e);
    if (d) bus.emit("delivery", d);
  });
  es.addEventListener("tick", (e) => {
    const d = j(e);
    if (!d) return;
    mergeTick(d);
    bus.emit("tick", d);
  });
}

// ── 全量快照 → state（首屏 / tab 进入时拉一次）───────────────────────────────
export async function refreshSnapshot() {
  const s = await safeRpc("state", {});
  if (!s) return;
  state.accounts = s.accounts || [];
  state.endpoints = s.endpoints || [];
  state.conversations = s.conversations || [];
  state.presence = s.presence || {};
  state.sinkModes = s.sinkModes || {};
  if (s.counters) state.counters = s.counters;
  if (s.acceptance) state.acceptance = s.acceptance;
  bus.emit("snapshot", s);
}

// ── Tab 路由 ────────────────────────────────────────────────────────────────
export function initTabs(onSwitch) {
  const btns = $$(".tab-btn");
  const panels = $$(".tab-panel");
  const activate = (name) => {
    btns.forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle("is-active", p.dataset.tab === name));
    if (onSwitch) onSwitch(name);
  };
  btns.forEach((b) => b.addEventListener("click", () => activate(b.dataset.tab)));
  return activate;
}

// ── 视觉小工具 ──────────────────────────────────────────────────────────────
export function colorFor(id) {
  let h = 0;
  for (let i = 0; i < (id || "").length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 62% 52%)`;
}
export const initial = (name) => (name || "?").trim().charAt(0).toUpperCase();

export function displayName(id) {
  const acc = state.accounts.find((a) => a.id === id) || state.rosterById.get(id);
  return acc?.displayName || id;
}

// 账号选择下拉填充：把当前 state.accounts 填入某个 <select>。
export function fillAccountSelect(sel, { includeEmpty = false } = {}) {
  if (!sel) return;
  const prev = sel.value;
  clear(sel);
  if (includeEmpty) sel.append(el("option", { value: "", text: "—" }));
  for (const a of state.accounts) sel.append(el("option", { value: a.id, text: `${a.displayName} (${a.id})` }));
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
