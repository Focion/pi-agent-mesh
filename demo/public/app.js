// ═══════════════════════════════════════════════════════════════
// Pi Agent Mesh · 群聊前端（vanilla，零依赖）。
// RPC：POST /api/<command>；事件：EventSource /api/events（meshmsg）。
// ═══════════════════════════════════════════════════════════════

const $ = (s) => document.querySelector(s);

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
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

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const fmtTime = (d) => d.toTimeString().slice(0, 8);

// 后端所有 /api/<command> 返回封装体 {ok, result?|error}。统一在此解包：
// ok=false 抛错（携带 name: message），ok=true 返回 result —— 调用点直接拿数据。
async function rpc(cmd, args = {}) {
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (body && body.ok === false) {
    const e = body.error || {};
    throw new Error(`${e.name ?? "Error"}: ${e.message ?? "rpc failed"}`);
  }
  return body ? body.result : undefined;
}

function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast is-${kind}`;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ── 全局 ────────────────────────────────────────────────────────────────
let GROUP_ID = null;
const rosterById = new Map();
const seen = new Set();
// 乐观渲染：tmpId -> { from, text }，用于后端/SSE 回显到达时"认领"占位气泡、避免重复。
const pending = new Map();

const sendAsVal = () => $("#sendAs").value;

function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 62% 52%)`;
}
const initial = (name) => (name || "?").trim().charAt(0).toUpperCase();

// ── 渲染 ────────────────────────────────────────────────────────────────
function renderRoster(list) {
  $("#rosterCount").textContent = list.length;
  const ul = $("#rosterList");
  ul.innerHTML = "";
  for (const a of list) {
    ul.append(el("li", { class: "agent" + (a.isSeed ? " seed" : "") },
      el("span", { class: "avatar", style: `background:${colorFor(a.id)}`, text: initial(a.displayName) }),
      el("span", { class: "meta" },
        el("span", { class: "nm", text: a.displayName }),
        a.persona ? el("span", { class: "ps", text: a.persona }) : null),
      el("span", { class: "dot " + (a.state === "hot" ? "on" : "off") })));
  }
}

function renderSendAs(list) {
  const sel = $("#sendAs");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const a of list) sel.append(el("option", { value: a.id, text: a.displayName }));
  if (prev && list.find((x) => x.id === prev)) sel.value = prev;

  // 「定向」下拉：全体 + 每个成员。选中某人时仅该人回复一条；不选(全体)沿用接力。
  const rt = $("#replyTo");
  if (rt) {
    const rprev = rt.value;
    rt.innerHTML = "";
    rt.append(el("option", { value: "", text: "全体" }));
    for (const a of list) rt.append(el("option", { value: a.id, text: "@ " + a.displayName }));
    if (rprev !== "" && rprev && list.find((x) => x.id === rprev)) rt.value = rprev;
  }
}

// 归一化：历史 ChatEntry 与 SSE Envelope 共用一条渲染路径。
function appendMessage(m) {
  const id = m.id || m.messageId;
  if (!id) return;
  if (seen.has(id)) return;
  if (GROUP_ID && m.conversationId && m.conversationId !== GROUP_ID) return;

  const text = m.text ?? m.payload?.text ?? "";

  // 乐观认领：若这是"我自己刚发出、还在等回显"的那条，改写占位气泡而非新建，避免重复气泡。
  const pendId = findPendingId(m.from, text);
  if (pendId) {
    seen.add(id);
    pending.delete(pendId);
    const node = msgNodeById(pendId);
    if (node) {
      node.dataset.mid = id;
      node.classList.remove("pending");
      node.querySelector(".pend")?.remove();
      return; // 已认领占位气泡，无需再追加
    }
    // 占位节点已丢失（极端情况）：落到下面按普通消息补渲染
  }

  seen.add(id);
  const box = $("#messages");
  $("#chatEmpty")?.remove();
  box.append(buildMsgNode(m, id, false));
  box.scrollTop = box.scrollHeight;
}

// 构建一条消息 DOM（正常渲染与乐观占位共用），data-mid 携带其消息 id。
function buildMsgNode(m, id, isPending) {
  const isSys = m.kind === "system" || m.from === "system";
  const text = m.text ?? m.payload?.text ?? "";
  const at = m.at ? new Date(m.at) : new Date();
  let node;
  if (isSys) {
    node = el("div", { class: "sys", text });
  } else {
    const name = rosterById.get(m.from)?.displayName || m.fromName || m.from || "?";
    const mine = m.from === sendAsVal();
    node = el("div", { class: "msg" + (mine ? " me" : "") + (isPending ? " pending" : "") },
      el("span", { class: "avatar", style: `background:${colorFor(m.from)}`, text: initial(name) }),
      el("div", { class: "bw" },
        el("div", { class: "who" },
          el("span", { class: "nm", text: name }),
          el("span", { class: "time", text: fmtTime(at) }),
          isPending ? el("span", { class: "pend", text: "· 发送中" }) : null),
        el("div", { class: "bubble", text })));
  }
  if (id) node.dataset.mid = id;
  return node;
}

const msgNodeById = (id) => {
  const esc2 = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
  return document.querySelector(`#messages [data-mid="${esc2}"]`);
};

// 找到最早匹配的待认领占位气泡（同一作者 + 同一文本）。
function findPendingId(from, text) {
  for (const [tmpId, p] of pending) {
    if (p.from === from && p.text === text) return tmpId;
  }
  return null;
}

// 乐观发送：立即贴出自己的消息气泡（占位 tmpId），不依赖 SSE/后端往返。
function appendOptimistic(from, text, tmpId) {
  const box = $("#messages");
  $("#chatEmpty")?.remove();
  pending.set(tmpId, { from, text });
  box.append(buildMsgNode({ from, text, at: new Date().toISOString(), conversationId: GROUP_ID }, tmpId, true));
  box.scrollTop = box.scrollHeight;
}

// 后端确认（postToGroup 返回 messageId）：升级占位气泡为正式 id，并吞掉随后到达的 SSE 回显。
function settleOptimistic(tmpId, serverId) {
  if (!pending.has(tmpId)) return; // SSE 抢先认领过，已处理
  pending.delete(tmpId);
  const node = msgNodeById(tmpId);
  if (serverId) seen.add(serverId);
  if (node) {
    if (serverId) node.dataset.mid = serverId;
    node.classList.remove("pending");
    node.querySelector(".pend")?.remove();
  }
}

// 发送失败：移除占位气泡（回滚）。
function rollbackOptimistic(tmpId) {
  pending.delete(tmpId);
  msgNodeById(tmpId)?.remove();
}

// ── 数据 ────────────────────────────────────────────────────────────────
async function loadRoster() {
  const list = await rpc("listAgents", {});
  const arr = Array.isArray(list) ? list : [];
  rosterById.clear();
  arr.forEach((a) => rosterById.set(a.id, a));
  renderRoster(arr);
  renderSendAs(arr);
}

async function doRegister() {
  const name = $("#agentName").value.trim();
  if (!name) { toast("请先填名字", "err"); return; }
  const persona = $("#agentPersona").value.trim();
  try {
    const agent = await rpc("registerAgent", { displayName: name, persona });
    $("#agentName").value = "";
    $("#agentPersona").value = "";
    await loadRoster();
    toast(`已注册 ${agent?.displayName ?? name} 并加入群聊`);
  } catch (err) {
    toast(String(err?.message ?? err), "err");
  }
}

async function doSend() {
  const ta = $("#msgInput");
  const text = ta.value.trim();
  if (!text) return;
  const asId = sendAsVal();
  if (!asId) { toast("还没有可用的 agent，先注册一个", "err"); return; }
  const rounds = parseInt($("#rounds").value, 10) || 0;
  const to = $("#replyTo")?.value || ""; // "" = 全体（后端：定向时只回 1 条，忽略 rounds）
  ta.value = "";

  // 乐观渲染：先本地贴出自己的消息气泡（占位 tmpId），不等 SSE/后端往返。
  const tmpId = "tmp-" + Math.random().toString(36).slice(2);
  appendOptimistic(asId, text, tmpId);
  try {
    const res = await rpc("postToGroup", { asId, text, rounds, ...(to ? { to } : {}) });
    settleOptimistic(tmpId, res?.messageId); // 升级为正式 id；SSE 回显随后被去重吞掉
  } catch (err) {
    rollbackOptimistic(tmpId); // 发送失败 → 撤下占位气泡
    toast(String(err?.message ?? err), "err");
  }
}

// ── SSE ─────────────────────────────────────────────────────────────────
function initSse() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", () => setMode());
  es.addEventListener("meshmsg", (e) => {
    try { appendMessage(JSON.parse(e.data)); } catch {}
  });
}

function setMode() {
  const mb = $("#modeBadge");
  if (!mb) return;
  mb.textContent = "实时 LLM 模式";
  mb.className = "badge";
}

// ── 启动 ────────────────────────────────────────────────────────────────
function bindUi() {
  // 先把交互监听绑上，保证即便下面的数据加载出错，按钮也始终可用。
  $("#btnRegister")?.addEventListener("click", doRegister);
  $("#btnSend")?.addEventListener("click", doSend);
  $("#msgInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
}

async function boot() {
  bindUi();
  initSse();

  try {
    const health = await (await fetch("/api/health")).json();
    setMode();
  } catch (e) {
    toast(`加载配置失败：${String(e)}`, "err");
  }

  try {
    const info = await rpc("chatInfo", {});
    GROUP_ID = info?.groupId || null;
    if (GROUP_ID) $("#chatTitle").textContent = info.topic || "# lounge";
  } catch (e) {
    toast(`加载群信息失败：${String(e)}`, "err");
  }

  try {
    await loadRoster();
  } catch (e) {
    toast(`加载成员失败：${String(e)}`, "err");
  }

  try {
    const hist = await rpc("chatHistory", {});
    (Array.isArray(hist) ? hist : []).forEach(appendMessage);
  } catch (e) {
    toast(`加载聊天记录失败：${String(e)}`, "err");
  }
}

// 任何未捕获的前端错误都弹出来，避免“点了没反应”却看不到原因。
window.addEventListener("error", (e) => toast(`前端错误：${e.message}`, "err"));
window.addEventListener("unhandledrejection", (e) =>
  toast(`前端错误：${e.reason?.message ?? String(e.reason)}`, "err"));

boot();
