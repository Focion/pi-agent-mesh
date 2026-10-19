// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 配置 / 健康头（B）。展示 /api/health 的真实配置：provider / model /
// thinking / 内建工具 / db / stateDir / port / 指纹 / 凭据来源。落实 §286「正常配置
// / 空工具集」的浏览器可见验证。builtinTools:[] = 仅 Mesh 工具、无 pi 内建。
// ═══════════════════════════════════════════════════════════════════════════

import { $, el, clear, toast, state, bus } from "./lib.js";

function row(label, value, kind = "") {
  return el("div", { class: "kv" + (kind ? ` ${kind}` : "") },
    el("span", { class: "k", text: label }),
    el("span", { class: "v", text: String(value) }));
}

async function fetchHealth() {
  const res = await fetch("/api/health").catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => null);
  return body && body.ok ? body.result : null;
}

function renderQuickline(h) {
  const line = $("#healthLine");
  if (!line || !h) return;
  clear(line);
  const c = h.config || {};
  line.append(
    el("span", { class: "hl-item", text: `模型 ${c.provider ?? "?"}/${c.modelId ?? "?"}` }),
    el("span", { class: "hl-sep", text: "·" }),
    el("span", { class: "hl-item", text: `thinking ${c.thinkingLevel ?? "(default)"}` }),
    el("span", { class: "hl-sep", text: "·" }),
    el("span", { class: "hl-item", text: `内建工具 ${(c.tools && c.tools.length) ? c.tools.join("/") : "无（仅 Mesh）"}` }),
  );
}

function renderDrawer(h) {
  const body = $("#configBody");
  if (!body) return;
  clear(body);
  if (!h) {
    body.append(el("p", { class: "muted", text: "无法读取 /api/health。" }));
    return;
  }
  const c = h.config || {};
  body.append(
    row("面板", `${h.demo} v${h.version}`),
    row("Provider", c.provider),
    row("模型", c.modelId),
    row("思考档", c.thinkingLevel),
    row("内建工具", (c.tools && c.tools.length) ? c.tools.join(", ") : "[]（仅 Mesh 工具，无 pi 内建）", c.tools && c.tools.length ? "" : "ok"),
    row("凭据来源", h.credentialSource),
    row("dbPath", c.dbPath),
    row("stateDir", c.stateDir),
    row("端口", c.port),
    row("配置指纹", c.fingerprint),
  );
  body.append(el("p", { class: "muted note", text: "本面板 100% 真实：不读 ~/.pi，模型 / Provider / 凭据全部来自 Mesh 配置（createMesh({ llm, runtime })）。" }));
}

export function initConfig() {
  const drawer = $("#configDrawer");
  const btn = $("#btnConfig");
  btn?.addEventListener("click", async () => {
    if (drawer.classList.contains("is-open")) {
      drawer.classList.remove("is-open");
      return;
    }
    if (!state.health) state.health = await fetchHealth();
    renderDrawer(state.health);
    drawer.classList.add("is-open");
  });
  $("#btnConfigClose")?.addEventListener("click", () => drawer.classList.remove("is-open"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") drawer?.classList.remove("is-open");
  });

  bus.on("hello", async () => {
    state.health = await fetchHealth();
    if (state.health) renderQuickline(state.health);
  });
}

export async function loadConfigOnce() {
  state.health = await fetchHealth();
  if (state.health) {
    renderQuickline(state.health);
  } else {
    toast("读取 /api/health 失败", "err");
  }
}
