// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · 入口（vanilla ES module）。装配各 tab，接 SSE，路由 Tab。
//
// 群聊 tab 首屏即加载；其余 tab 在进入时拉一次快照（refreshSnapshot）并按需刷新，
// 之后由 SSE（mesh / meshmsg / delivery / tick）增量更新。真实 LLM 只在群聊接力里
// 消耗；其余能力演示（request/queue/shared/observer/presence）走 sink/external 账号
// 或只读观测，不额外起真实模型轮次。
// ═══════════════════════════════════════════════════════════════════════════

import { initSse, initTabs, toast } from "./lib.js";
import { initChat, loadChatOnce } from "./chat.js";
import { initConfig, loadConfigOnce } from "./config.js";
import { initTopology, refreshTopology } from "./topology.js";
import { initLab, refreshLab } from "./lab.js";
import { initShared, refreshShared } from "./shared.js";
import { initObserver, refreshObserver } from "./observe.js";

const refreshers = {
  topology: refreshTopology,
  lab: refreshLab,
  shared: refreshShared,
  observer: refreshObserver,
};

async function boot() {
  initSse();
  initChat();
  initConfig();
  initTopology();
  initLab();
  initShared();
  initObserver();

  const activate = initTabs((name) => {
    const fn = refreshers[name];
    if (fn) fn().catch((e) => toast("刷新失败：" + (e?.message ?? e), "err"));
  });

  await loadConfigOnce();
  await loadChatOnce();
  activate("chat");
}

// 任何未捕获的前端错误都 toast 出来，避免「点了没反应」却看不到原因。
window.addEventListener("error", (e) => toast(`前端错误：${e.message}`, "err"));
window.addEventListener("unhandledrejection", (e) =>
  toast(`前端错误：${e.reason?.message ?? String(e.reason)}`, "err"));

boot();
