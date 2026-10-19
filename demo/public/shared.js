// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 共享空间（E）。host.shared 的 put/get/append/del/list（经既有 RPC）。
// 展示版本单调 / CAS、最后写入者、大小；shared_object_changed 事件即时刷新列表。
// put 传 expectedVersion 可复现 CAS 冲突（reject 由 safeRpc 以 name(code) 呈现）。
// ═══════════════════════════════════════════════════════════════════════════

import { $, el, clear, safeRpc, toast, bus, refreshSnapshot, fillAccountSelect, displayName, clock } from "./lib.js";

function parseJsonField(sel, label) {
  const raw = $(sel).value.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    toast(`${label} 不是合法 JSON`, "err");
    return null;
  }
}

const baseArgs = () => ({
  spaceId: $("#shSpace").value.trim() || "demo",
  key: $("#shKey").value.trim(),
  as: $("#shAs").value,
});

function renderMeta(m, withData) {
  const node = el("div", { class: "sh-row" },
    el("div", { class: "sh-main" },
      el("span", { class: "sh-key mono", text: m.key }),
      el("span", { class: "pill pill-host", text: "v" + m.version }),
      el("span", { class: "muted small", text: `owner ${displayName(m.ownerId)} · by ${displayName(m.updatedBy)}` }),
      el("span", { class: "muted small", text: `${m.size}B${m.contentType ? " · " + m.contentType : ""}` }),
      el("span", { class: "muted small", text: clock(m.updatedAt) })),
  );
  if (withData && m.data !== undefined) {
    node.append(el("pre", { class: "sh-data mono", text: JSON.stringify(m.data, null, 2) }));
  }
  return node;
}

async function doList() {
  const a = baseArgs();
  if (!a.as) return toast("选择身份", "err");
  const box = $("#shResult");
  clear(box);
  const list = await safeRpc("sharedList", { spaceId: a.spaceId, as: a.as });
  if (!Array.isArray(list) || list.length === 0) {
    box.append(el("p", { class: "muted", text: "该空间暂无对象。" }));
    return;
  }
  for (const m of list) box.append(renderMeta(m, false));
}

async function doGet() {
  const a = baseArgs();
  if (!a.as || !a.key) return toast("填 key 并选身份", "err");
  const box = $("#shResult");
  clear(box);
  const m = await safeRpc("sharedGet", { spaceId: a.spaceId, key: a.key, as: a.as });
  box.append(m ? renderMeta(m, true) : el("p", { class: "muted", text: `不存在：${a.key}` }));
}

async function doPut() {
  const a = baseArgs();
  if (!a.as || !a.key) return toast("填 key 并选身份", "err");
  const data = parseJsonField("#shData", "data");
  if (data === null) return;
  const exp = parseInt($("#shExpected").value, 10);
  const res = await safeRpc("sharedPut", {
    spaceId: a.spaceId,
    key: a.key,
    as: a.as,
    data: data ?? { note: "hello", at: new Date().toISOString() },
    ...(Number.isFinite(exp) ? { expectedVersion: exp } : {}),
  });
  if (res) {
    toast(`put 成功 → v${res.version}`);
    doList();
  }
}

async function doAppend() {
  const a = baseArgs();
  if (!a.as || !a.key) return toast("填 key 并选身份", "err");
  const item = parseJsonField("#shData", "item");
  if (item === null) return;
  const maxLen = parseInt($("#shMaxLen").value, 10);
  const res = await safeRpc("sharedAppend", {
    spaceId: a.spaceId,
    key: a.key,
    as: a.as,
    item: item ?? { at: new Date().toISOString() },
    ...(Number.isFinite(maxLen) ? { maxLen } : {}),
  });
  if (res) {
    toast(`append 成功 → v${res.version}`);
    doGet();
  }
}

async function doDel() {
  const a = baseArgs();
  if (!a.as || !a.key) return toast("填 key 并选身份", "err");
  const res = await safeRpc("sharedDel", { spaceId: a.spaceId, key: a.key, as: a.as });
  if (res !== null) {
    toast("已删除");
    doList();
  }
}

function wireOps() {
  $("#btnShList")?.addEventListener("click", doList);
  $("#btnShGet")?.addEventListener("click", doGet);
  $("#btnShPut")?.addEventListener("click", doPut);
  $("#btnShAppend")?.addEventListener("click", doAppend);
  $("#btnShDel")?.addEventListener("click", doDel);
}

export function initShared() {
  wireOps();
  bus.on("mesh", ({ type }) => {
    if (type === "shared_object_changed") doList();
  });
}

export async function refreshShared() {
  await refreshSnapshot();
  if ($("#shAs")) fillAccountSelect($("#shAs"));
  await doList();
}
