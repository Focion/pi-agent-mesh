// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 群聊 tab（真实 LLM 多 agent 接力）。逻辑迁移自旧 app.js，改为使用
// 共享 lib（rpc / bus / state），并保留乐观渲染、thinking 气泡、@定向等全部行为。
// ═══════════════════════════════════════════════════════════════════════════

import { $, el, clear, fmtTime, rpc, safeRpc, toast, state, bus, colorFor, initial } from "./lib.js";

const seen = new Set();
const pending = new Map(); // tmpId -> { from, text }
const thinkingNodes = new Map(); // accountId -> node

const sendAsVal = () => $("#sendAs")?.value || "";
const groupId = () => state.group?.groupId || null;

function toTargets(m) {
  const raw = m?.to;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((x) => typeof x === "string" && x);
}

function targetNames(ids) {
  return ids.map((id) => (id === "@all" ? "所有人" : state.rosterById.get(id)?.displayName || id));
}

function renderRoster(list) {
  $("#rosterCount").textContent = list.length;
  const ul = $("#rosterList");
  clear(ul);
  for (const a of list) {
    ul.append(
      el("li", { class: "agent" + (a.isSeed ? " seed" : "") },
        el("span", { class: "avatar", style: `background:${colorFor(a.id)}`, text: initial(a.displayName) }),
        el("span", { class: "meta" },
          el("span", { class: "nm", text: a.displayName }),
          a.persona ? el("span", { class: "ps", text: a.persona }) : null),
        el("span", { class: "dot " + (a.state === "hot" ? "on" : "off") })),
    );
  }
}

function renderSendAs(list) {
  const sel = $("#sendAs");
  const prev = sel.value;
  clear(sel);
  for (const a of list) sel.append(el("option", { value: a.id, text: a.displayName }));
  if (prev && list.find((x) => x.id === prev)) sel.value = prev;

  const rt = $("#replyTo");
  if (rt) {
    const rprev = rt.value;
    clear(rt);
    rt.append(el("option", { value: "", text: "全体" }));
    for (const a of list) rt.append(el("option", { value: a.id, text: "@ " + a.displayName }));
    if (rprev !== "" && rprev && list.find((x) => x.id === rprev)) rt.value = rprev;
  }
}

function appendMessage(m) {
  const id = m.id || m.messageId;
  if (!id) return;
  if (seen.has(id)) return;
  const g = groupId();
  if (g && m.conversationId && m.conversationId !== g) return;

  const text = m.text ?? m.payload?.text ?? "";
  if (m.from) hideThinking(m.from);

  const pendId = findPendingId(m.from, text);
  if (pendId) {
    seen.add(id);
    pending.delete(pendId);
    const node = msgNodeById(pendId);
    if (node) {
      node.dataset.mid = id;
      node.classList.remove("pending");
      node.querySelector(".pend")?.remove();
      return;
    }
  }

  seen.add(id);
  const box = $("#messages");
  $("#chatEmpty")?.remove();
  box.append(buildMsgNode(m, id, false));
  box.scrollTop = box.scrollHeight;
}

function buildMsgNode(m, id, isPending) {
  const isSys = m.kind === "system" || m.from === "system";
  const text = m.text ?? m.payload?.text ?? "";
  const at = m.at ? new Date(m.at) : new Date();
  let node;
  if (isSys) {
    node = el("div", { class: "sys", text });
  } else {
    const name = state.rosterById.get(m.from)?.displayName || m.fromName || m.from || "?";
    const mine = m.from === sendAsVal();
    node = el("div", { class: "msg" + (mine ? " me" : "") + (isPending ? " pending" : "") },
      el("span", { class: "avatar", style: `background:${colorFor(m.from)}`, text: initial(name) }),
      el("div", { class: "bw" },
        el("div", { class: "who" },
          el("span", { class: "nm", text: name }),
          el("span", { class: "time", text: fmtTime(at) }),
          isPending ? el("span", { class: "pend", text: "· 发送中" }) : null),
        buildBubble(m, text)));
  }
  if (id) node.dataset.mid = id;
  return node;
}

function buildBubble(m, text) {
  const names = targetNames(toTargets(m));
  if (names.length === 0) return el("div", { class: "bubble", text });
  const kids = [];
  for (const n of names) {
    kids.push(el("span", { class: "at-chip", text: "@" + n }));
    kids.push(document.createTextNode(" "));
  }
  kids.push(document.createTextNode(text));
  return el("div", { class: "bubble has-at" }, ...kids);
}

const msgNodeById = (id) => {
  const esc2 = window.CSS && CSS.escape ? CSS.escape(id) : id;
  return document.querySelector(`#messages [data-mid="${esc2}"]`);
};

function findPendingId(from, text) {
  for (const [tmpId, p] of pending) if (p.from === from && p.text === text) return tmpId;
  return null;
}

function appendOptimistic(from, text, tmpId, to) {
  const box = $("#messages");
  $("#chatEmpty")?.remove();
  pending.set(tmpId, { from, text });
  box.append(buildMsgNode({ from, text, to, at: new Date().toISOString(), conversationId: groupId() }, tmpId, true));
  box.scrollTop = box.scrollHeight;
}

function settleOptimistic(tmpId, serverId) {
  if (!pending.has(tmpId)) return;
  pending.delete(tmpId);
  const node = msgNodeById(tmpId);
  if (serverId) seen.add(serverId);
  if (node) {
    if (serverId) node.dataset.mid = serverId;
    node.classList.remove("pending");
    node.querySelector(".pend")?.remove();
  }
}

function rollbackOptimistic(tmpId) {
  pending.delete(tmpId);
  msgNodeById(tmpId)?.remove();
}

function showThinking(p) {
  const accountId = p?.accountId;
  if (!accountId || thinkingNodes.has(accountId)) return;
  const box = $("#messages");
  $("#chatEmpty")?.remove();
  const name = state.rosterById.get(accountId)?.displayName || p.displayName || accountId;
  const node = el("div", { class: "msg thinking", "data-thinking": accountId },
    el("span", { class: "avatar", style: `background:${colorFor(accountId)}`, text: initial(name) }),
    el("div", { class: "bw" },
      el("div", { class: "who" },
        el("span", { class: "nm", text: name }),
        el("span", { class: "time", text: fmtTime(new Date()) })),
      el("div", { class: "bubble" },
        el("span", { class: "tt", text: "正在思考中" }),
        el("span", { class: "dots" },
          el("span", { class: "d", text: "·" }),
          el("span", { class: "d", text: "·" }),
          el("span", { class: "d", text: "·" })))));
  box.append(node);
  box.scrollTop = box.scrollHeight;
  thinkingNodes.set(accountId, node);
}

function hideThinking(accountId) {
  const node = thinkingNodes.get(accountId);
  if (node) {
    node.remove();
    thinkingNodes.delete(accountId);
  }
}

async function loadRoster() {
  const list = await safeRpc("listAgents", {});
  const arr = Array.isArray(list) ? list : [];
  state.roster = arr;
  state.rosterById.clear();
  arr.forEach((a) => state.rosterById.set(a.id, a));
  renderRoster(arr);
  renderSendAs(arr);
}

async function doRegister() {
  const name = $("#agentName").value.trim();
  if (!name) {
    toast("请先填名字", "err");
    return;
  }
  const persona = $("#agentPersona").value.trim();
  const agent = await safeRpc("registerAgent", { displayName: name, persona });
  if (!agent) return;
  $("#agentName").value = "";
  $("#agentPersona").value = "";
  await loadRoster();
  toast(`已注册 ${agent.displayName ?? name} 并加入群聊`);
}

function parseDirectedTarget(text) {
  const re = /@(\S+) /g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name === "所有人") return { kind: "all", match: m[0] };
    const hit = [...state.rosterById.values()].find((a) => a.displayName === name);
    if (hit) return { kind: "one", accountId: hit.id, match: m[0] };
  }
  return null;
}

async function doSend() {
  const ta = $("#msgInput");
  let text = ta.value.trim();
  if (!text) return;
  const asId = sendAsVal();
  if (!asId) {
    toast("还没有可用的 agent，先注册一个", "err");
    return;
  }
  const rounds = parseInt($("#rounds").value, 10) || 0;

  const parsed = parseDirectedTarget(text);
  let to;
  let chipTargets;
  if (parsed) {
    text = text.replace(parsed.match, "").trim();
    if (!text) {
      toast("剥离 @xxx 后正文为空", "err");
      return;
    }
    if (parsed.kind === "all") {
      to = "";
      chipTargets = ["@all"];
    } else {
      to = parsed.accountId;
      chipTargets = [parsed.accountId];
    }
  } else {
    to = $("#replyTo")?.value || "";
    chipTargets = to ? [to] : ["@all"];
  }
  ta.value = "";

  const tmpId = "tmp-" + Math.random().toString(36).slice(2);
  appendOptimistic(asId, text, tmpId, chipTargets);
  try {
    const res = await rpc("postToGroup", { asId, text, rounds, ...(to ? { to } : {}) });
    settleOptimistic(tmpId, res?.messageId);
  } catch (err) {
    rollbackOptimistic(tmpId);
    toast(String(err?.message ?? err), "err");
  }
}

export function initChat() {
  $("#btnRegister")?.addEventListener("click", doRegister);
  $("#btnSend")?.addEventListener("click", doSend);
  $("#msgInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  bus.on("meshmsg", (env) => appendMessage(env));
  bus.on("mesh", ({ type, payload }) => {
    if (type === "agent_thinking") showThinking(payload);
    else if (type === "agent_thinking_end") {
      if (payload?.ok === false) hideThinking(payload?.accountId);
    }
  });
}

// 首屏：群信息 + 花名册 + 历史（SSE 到达前先在 boot 里跑一次）。
export async function loadChatOnce() {
  const info = await safeRpc("chatInfo", {});
  if (info) {
    state.group = info;
    if (info.groupId) $("#chatTitle").textContent = info.topic || "# lounge";
  }
  await loadRoster();
  const hist = await safeRpc("chatHistory", {});
  (Array.isArray(hist) ? hist : []).forEach(appendMessage);
}
