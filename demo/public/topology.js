// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 拓扑与在场（C）。列 Account / Endpoint，展示 Presence 七态（含 host
// 手动 vs derived 派生），并提供 setPresence / warm / evict / nudge / sink 模式 /
// 注册账号·端点 等操作。实时由 presence_changed / endpoint_state_changed + tick 更新。
// ═══════════════════════════════════════════════════════════════════════════

import { $, el, clear, safeRpc, toast, state, bus, refreshSnapshot, fillAccountSelect } from "./lib.js";

const MANUAL_STATES = ["available", "busy", "dnd", "away", "offline"];
const DERIVED = new Set(["online", "idle"]);
const csv = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

const epOf = (accountId) => state.endpoints.find((e) => e.accountId === accountId);
const shortId = (s, n = 10) => (s && s.length > n ? "…" + s.slice(-n) : s || "—");

function stateBadge(pv) {
  if (!pv) return el("span", { class: "pill pill-off", text: "—" });
  const derived = DERIVED.has(pv.state) || pv.source === "derived";
  return el("span", { class: "pill " + (derived ? "pill-derived" : "pill-host"), text: pv.state + (derived ? " ·派生" : "") });
}

function renderAccounts() {
  const tb = $("#accBody");
  if (!tb) return;
  clear(tb);
  for (const a of state.accounts) {
    tb.append(
      el("tr", {},
        el("td", { class: "mono", text: a.id }),
        el("td", { text: a.displayName }),
        el("td", { text: a.endpointClass }),
        el("td", { class: "mono muted", text: (a.initiate || []).join("/") || "—（纯接收）" }),
        el("td", { class: "mono muted", text: (a.capabilities || []).join(",") || "—" }),
        el("td", { text: a.defaultGrade || "—" }),
        el("td", { class: "cell-actions" },
          el("button", { class: "mini", "data-act": "presence", "data-id": a.id, text: "在场" }))),
    );
  }
}

function renderPresence() {
  const wrap = $("#presenceList");
  if (!wrap) return;
  clear(wrap);
  const streamAccs = state.accounts.filter((a) => a.endpointClass === "stream");
  if (streamAccs.length === 0) {
    wrap.append(el("p", { class: "muted", text: "暂无 stream 账号。" }));
    return;
  }
  for (const a of streamAccs) {
    const pv = state.presence[a.id];
    wrap.append(
      el("div", { class: "pl-row" },
        el("span", { class: "pl-name", text: a.displayName }),
        stateBadge(pv),
        pv?.until ? el("span", { class: "muted small", text: "至 " + pv.until }) : null,
        pv?.reason ? el("span", { class: "muted small", text: "(" + pv.reason + ")" }) : null),
    );
  }
}

function renderEndpoints() {
  const tb = $("#epBody");
  if (!tb) return;
  clear(tb);
  for (const e of state.endpoints) {
    tb.append(
      el("tr", {},
        el("td", { class: "mono", text: shortId(e.id) }),
        el("td", { text: (state.accounts.find((a) => a.id === e.accountId) || {}).displayName || e.accountId }),
        el("td", {}, el("span", { class: "pill st-" + e.state, text: e.state })),
        el("td", { text: e.lease || "—" }),
        el("td", { class: "mono muted", text: shortId(e.piSessionId) }),
        el("td", { class: "cell-actions" },
          el("button", { class: "mini", "data-act": "warm-shared", "data-id": e.id, text: "warm·共享" }),
          el("button", { class: "mini", "data-act": "warm-excl", "data-id": e.id, text: "warm·独占" }),
          el("button", { class: "mini", "data-act": "evict", "data-id": e.id, text: "evict" }))),
    );
  }
}

function renderSinks() {
  const wrap = $("#sinkList");
  if (!wrap) return;
  clear(wrap);
  const sinks = state.accounts.filter((a) => a.endpointClass !== "stream");
  if (sinks.length === 0) {
    wrap.append(el("p", { class: "muted", text: "暂无 sink / external 账号（可在上方注册）。" }));
    return;
  }
  for (const a of sinks) {
    const mode = state.sinkModes[a.id] || "accept";
    wrap.append(
      el("div", { class: "pl-row" },
        el("span", { class: "pl-name", text: `${a.displayName} (${a.endpointClass})` }),
        el("button", { class: "mini " + (mode === "accept" ? "is-on" : ""), "data-act": "sink-accept", "data-id": a.id, text: "accept" }),
        el("button", { class: "mini " + (mode === "refuse" ? "is-danger" : ""), "data-act": "sink-refuse", "data-id": a.id, text: "refuse" })),
    );
  }
}

function render() {
  renderAccounts();
  renderPresence();
  renderEndpoints();
  renderSinks();
  fillAccountSelect($("#presAcct"));
  fillAccountSelect($("#nudgeAcct"));
  fillAccountSelect($("#epAcct"));
}

async function refresh() {
  await refreshSnapshot();
  render();
}

// ── 操作 ────────────────────────────────────────────────────────────────────
async function createAccount() {
  const displayName = $("#newAccName").value.trim();
  if (!displayName) return toast("请填账号名", "err");
  const endpointClass = $("#newAccClass").value;
  const res = await safeRpc("registerAccount", {
    displayName,
    endpointClass,
    capabilities: csv($("#newAccCaps").value),
    initiate: csv($("#newAccInitiate").value),
    defaultGrade: $("#newAccGrade").value || undefined,
  });
  if (res) {
    toast(`已注册账号 ${res.id}`);
    $("#newAccName").value = "";
    await refresh();
  }
}

async function createEndpoint() {
  const accountId = $("#epAcct").value;
  if (!accountId) return toast("先选账号", "err");
  const res = await safeRpc("registerEndpoint", { accountId, topology: { kind: "unified" } });
  if (res) {
    toast(`已注册端点 ${shortId(res.id)}`);
    await refresh();
  }
}

function wireOps() {
  $("#btnCreateAcc")?.addEventListener("click", createAccount);
  $("#btnCreateEp")?.addEventListener("click", createEndpoint);

  // 在场设置
  const presState = $("#presState");
  clear(presState);
  for (const s of MANUAL_STATES) presState.append(el("option", { value: s, text: s }));
  $("#btnSetPresence")?.addEventListener("click", async () => {
    const accountId = $("#presAcct").value;
    if (!accountId) return toast("先选账号", "err");
    const until = $("#presUntil").value.trim();
    const reason = $("#presReason").value.trim();
    const ok = await safeRpc("setPresence", {
      accountId,
      state: presState.value,
      ...(until ? { until } : {}),
      ...(reason ? { reason } : {}),
    });
    if (ok !== null) {
      toast("在场已更新");
      await refresh();
    }
  });

  // nudge
  $("#btnNudge")?.addEventListener("click", async () => {
    const accountId = $("#nudgeAcct").value;
    const ep = epOf(accountId);
    if (!ep) return toast("该账号尚无端点", "err");
    const cue = $("#nudgeCue").value.trim();
    if (!cue) return toast("请填写提示语", "err");
    const deliverAs = $("#nudgeDeliverAs").value || undefined;
    const triggerTurn = $("#nudgeTrigger").checked;
    const ok = await safeRpc("nudge", { endpointId: ep.id, cue, ...(deliverAs ? { deliverAs } : {}), ...(triggerTurn ? { triggerTurn: true } : {}) });
    if (ok !== null) toast("nudge 已发出");
  });

  $("#btnReloadTopo")?.addEventListener("click", refresh);

  // 表格 / 列表内的按钮（事件委托）
  $("#topoRoot")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === "presence") {
      $("#presAcct").value = id;
      document.querySelector('.tab-btn[data-tab="topology"]')?.scrollIntoView();
      toast("已在下方「在场设置」选中该账号");
    } else if (act === "warm-shared" || act === "warm-excl") {
      await safeRpc("warm", { endpointId: id, lease: act === "warm-shared" ? "shared" : "exclusive" });
      await refresh();
    } else if (act === "evict") {
      await safeRpc("evict", { endpointId: id });
      await refresh();
    } else if (act === "sink-accept" || act === "sink-refuse") {
      await safeRpc("setSinkMode", { accountId: id, mode: act === "sink-accept" ? "accept" : "refuse" });
      state.sinkModes[id] = act === "sink-accept" ? "accept" : "refuse";
      renderSinks();
      toast(`sink ${id} → ${act === "sink-accept" ? "accept" : "refuse"}`);
    }
  });
}

export function initTopology() {
  wireOps();
  bus.on("snapshot", render);
  bus.on("tick", () => {
    renderEndpoints();
    renderPresence();
  });
  bus.on("mesh", ({ type }) => {
    if (type === "presence_changed" || type === "endpoint_state_changed") render();
  });
}

export { refresh as refreshTopology };
