// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 观测（F）。counters 网格（含本次新增 blind_write / claim_timeout /
// queue_cleared_detected / delivery_handoff_timeout）、§24.2 验收比值、15 个 MeshEvent
// 汇聚的活动流，以及只读观测入口 checkInvariants / search / replay / streamEntries。
// （observer.forkAt 不在 v0.1.0 范围，未接入。）
// ═══════════════════════════════════════════════════════════════════════════

import { $, el, clear, safeRpc, toast, state, bus, refreshSnapshot, displayName, clock } from "./lib.js";

const COUNTERS = [
  "messages_total", "deliveries_total", "dedup_hit", "wake_throttled", "backpressure_downgrade",
  "seq_gap", "blind_write", "request_timeout", "invariant_violated", "fanout_warn", "inbox_overflowed",
  "fold_events", "policy_degraded", "parked_total", "park_expired", "claim_timeout",
  "queue_cleared_detected", "delivery_handoff_timeout", "wake_per_message_idle", "wake_per_message_busy",
  "verbatim_copies", "silent_grade", "cold_hit",
];
const NEW_COUNTERS = new Set(["blind_write", "claim_timeout", "queue_cleared_detected", "delivery_handoff_timeout"]);

function renderCounters() {
  const box = $("#obsCounters");
  if (!box) return;
  clear(box);
  for (const name of COUNTERS) {
    const v = state.counters[name] ?? 0;
    box.append(
      el("div", { class: "ct-cell" + (NEW_COUNTERS.has(name) ? " ct-new" : "") },
        el("span", { class: "ct-val", text: String(v) }),
        el("span", { class: "ct-name mono", text: name })),
    );
  }
}

function renderAcceptance() {
  const box = $("#obsAcceptance");
  if (!box) return;
  clear(box);
  const a = state.acceptance;
  if (!a || !a.ratios) {
    box.append(el("p", { class: "muted", text: "等待首个 tick…" }));
    return;
  }
  box.append(el("div", { class: "muted small", text: `消息 ${a.messages ?? 0} · 投递 ${a.deliveries ?? 0}` }));
  for (const [k, r] of Object.entries(a.ratios)) {
    const val = r.value == null ? "—" : (typeof r.value === "number" ? r.value.toFixed(3) : r.value);
    const okc = r.ok === true ? "ok" : r.ok === false ? "bad" : "muted";
    box.append(
      el("div", { class: "ac-row" },
        el("span", { class: "ac-k mono", text: k }),
        el("span", { class: "ac-v " + okc, text: val }),
        el("span", { class: "ac-l muted small", text: r.limit || "" })),
    );
  }
}

const ACT_SUMMARY = (type, p) => {
  const env = p?.envelope;
  if (env) return `${env.kind}#${env.seq} ${displayName(env.from)}→ ${(env.payload?.text || "").slice(0, 40)}`;
  if (type === "presence_changed") return `${displayName(p.accountId)} ${p.from}→${p.to} (${p.source || "?"})`;
  if (type === "endpoint_state_changed") return `${p.endpointId?.slice(-6)} ${p.from}→${p.to}`;
  if (type === "message_acked") return `ack ${p.correlationId?.slice(-8) || ""} ok=${p.ok}`;
  if (type === "request_timeout") return `timeout ${p.correlationId?.slice(-8) || ""}`;
  if (type === "shared_object_changed") return `${p.spaceId}/${p.key} v${p.version}`;
  if (type === "sink_received") return `${displayName(p.accountId)} "${(p.text || "").slice(0, 30)}" ${p.mode}`;
  if (type === "conversation_changed") return `${p.conversationId?.slice(-6) || ""} ${p.change?.op || ""}`;
  if (type === "invariant_violated") return `${p.code}`;
  if (type === "policy_degraded") return `${p.slot} ${p.reason}`;
  return "";
};

let actFilter = "";
function renderActivity() {
  const box = $("#obsActivity");
  if (!box) return;
  clear(box);
  const items = state.activity.filter((a) => !actFilter || a.type === actFilter).slice(0, 120);
  if (items.length === 0) {
    box.append(el("p", { class: "muted", text: "暂无事件。" }));
    return;
  }
  for (const a of items) {
    box.append(
      el("div", { class: "ev-row" },
        el("span", { class: "ev-time mono muted small", text: clock(a.at) }),
        el("span", { class: "ev-type mono", text: a.type }),
        el("span", { class: "ev-body", text: ACT_SUMMARY(a.type, a.payload) })),
    );
  }
}

function renderJson(title, obj) {
  const box = $("#obsResult");
  clear(box);
  box.append(el("div", { class: "rs-title", text: title }));
  box.append(el("pre", { class: "rs-pre mono", text: JSON.stringify(obj, null, 2) }));
}

function wireOps() {
  $("#btnObsInvariants")?.addEventListener("click", async () => {
    const r = await safeRpc("checkInvariants", {});
    if (!r) return;
    const box = $("#obsInvariant");
    clear(box);
    box.append(
      el("div", { class: "iv-head " + (r.ok ? "ok" : "bad"), text: r.ok ? `✓ 不变量通过（检查 ${r.checked} 项）` : `✗ ${r.violations.length} 处违例（检查 ${r.checked} 项）` }),
    );
    for (const v of r.violations || []) {
      box.append(el("div", { class: "iv-row" },
        el("span", { class: "mono", text: v.id }),
        el("span", { class: "muted small", text: v.assertion }),
        el("span", { class: "pill pill-danger", text: "×" + v.count })));
    }
  });

  $("#btnObsSearch")?.addEventListener("click", async () => {
    const text = $("#obsSearchText").value.trim();
    if (!text) return toast("填写搜索词", "err");
    const list = await safeRpc("search", { text, limit: 20 });
    renderJson(`search "${text}" → ${Array.isArray(list) ? list.length : 0} 条`, (list || []).map((e) => ({ seq: e.seq, from: e.from, kind: e.kind, text: e.payload?.text })));
  });

  $("#btnObsReplay")?.addEventListener("click", async () => {
    const endpointId = $("#obsEpSel").value;
    if (!endpointId) return toast("选择端点", "err");
    const r = await safeRpc("replay", { endpointId });
    if (r) renderJson(`replay ${endpointId.slice(-8)}`, { prompt: (r.prompt || "").slice(0, 400), entries: r.entries?.length ?? 0, injected: r.injected, inboxConversations: r.inbox?.conversations?.length ?? 0 });
  });

  $("#btnObsStream")?.addEventListener("click", async () => {
    const piSessionId = $("#obsStreamSid").value.trim();
    if (!piSessionId) return toast("填写 piSessionId", "err");
    const list = await safeRpc("streamEntries", { piSessionId });
    renderJson(`streamEntries → ${Array.isArray(list) ? list.length : 0} 条`, (list || []).map((s) => ({ seq: s.seqInStream, type: s.entryType, bytes: s.rawJson?.length ?? 0 })));
  });

  $("#obsActFilter")?.addEventListener("change", (e) => {
    actFilter = e.target.value;
    renderActivity();
  });

  // 活动流筛选下拉：首次填入已知事件类型。
  const types = ["", "message_routed", "message_delivered", "message_consumed", "message_parked", "message_dropped", "message_acked", "request_timeout", "presence_changed", "endpoint_state_changed", "conversation_changed", "membership_caps_changed", "shared_object_changed", "inbox_overflowed", "policy_degraded", "invariant_violated", "sink_received", "agent_thinking"];
  const sel = $("#obsActFilter");
  if (sel && sel.options.length === 0) {
    for (const t of types) sel.append(el("option", { value: t, text: t || "全部事件" }));
  }
}

export function initObserver() {
  wireOps();
  bus.on("tick", () => {
    renderCounters();
    renderAcceptance();
  });
  bus.on("mesh", () => renderActivity());
  bus.on("snapshot", () => renderCounters());
}

export async function refreshObserver() {
  await refreshSnapshot();
  renderCounters();
  renderAcceptance();
  renderActivity();
  const sel = $("#obsEpSel");
  if (sel) {
    const prev = sel.value;
    clear(sel);
    sel.append(el("option", { value: "", text: "— 选择端点 —" }));
    for (const e of state.endpoints) sel.append(el("option", { value: e.id, text: `${displayName(e.accountId)} · ${e.state} · ${e.id.slice(-8)}` }));
    if (prev) sel.value = prev;
  }
}
