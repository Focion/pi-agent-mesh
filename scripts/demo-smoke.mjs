#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// demo-smoke —— 5-Tab 能力面板冒烟门（D6 方案①）。
//
// 假定 demo 服务已在 localhost:8787 就绪（不自行启动，不杀端口）。
// 逐条执行回归口径 7 项断言：
//   1. GET  /api/health        → ok:true, config.port, credentialSource 非空
//   2. POST /api/listAgents    → 至少 3 个 agent
//   3. POST /api/state         → accounts/endpoints 投影非空
//   4. POST /api/conversationsOf + /api/messages → envelope 形状
//   5. POST /api/sharedList    → 数组（可空）
//   6. POST /api/checkInvariants → ok:true 且无 violation
//   7. GET  /api/events (SSE)  → 首帧 hello, 随后 tick 到达
//
// 用法：
//   npm run demo:smoke           # 默认连 localhost:8787
//   DEMO_SMOKE_PORT=9000 node scripts/demo-smoke.mjs  # 自定义端口
//
// 任何一项失败即 exit 1；全部通过 exit 0。
// ═══════════════════════════════════════════════════════════════════════════

const PORT = Number(process.env.DEMO_SMOKE_PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function ok(label, detail) {
  passed++;
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, reason) {
  failed++;
  console.error(`  ✗ ${label} — ${reason}`);
}

// ── HTTP 工具 ─────────────────────────────────────────────────────────────────

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok && res.status !== 200) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function postJSON(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── 断言辅助 ──────────────────────────────────────────────────────────────────

function assert(condition, label, reason) {
  if (condition) {
    ok(label);
  } else {
    fail(label, reason);
  }
}

// ── 冒烟项 ────────────────────────────────────────────────────────────────────

console.log(`\n[demo-smoke] → ${BASE}\n`);

// 1. Health
try {
  const health = await getJSON("/api/health");
  if (health.ok !== true) {
    fail("1/health", `ok !== true: ${JSON.stringify(health)}`);
  } else {
    const cfg = health.result?.config;
    const cred = health.result?.credentialSource;
    assert(cfg?.port === PORT, "1/health.port", `期望 ${PORT}, 实得 ${cfg?.port}`);
    assert(cred && cred.length > 0, "1/health.credential", `credentialSource 为空`);
  }
} catch (err) {
  fail("1/health", `连接失败: ${err.message}`);
  console.error(`\n[demo-smoke] 服务不可达，后续断言跳过。退出。`);
  process.exit(1);
}

// 2. listAgents (chat tab)
try {
  const res = await postJSON("/api/listAgents");
  if (res.ok !== true) {
    fail("2/listAgents", `ok=false: ${res.error?.message}`);
  } else {
    const agents = res.result;
    assert(Array.isArray(agents) && agents.length >= 3,
      "2/listAgents.count",
      `期望 ≥3 agent, 实得 ${Array.isArray(agents) ? agents.length : "非数组"}`);
  }
} catch (err) {
  fail("2/listAgents", err.message);
}

// 3. state (topology tab)
let firstAccountId;
try {
  const res = await postJSON("/api/state");
  if (res.ok !== true) {
    fail("3/state", `ok=false: ${res.error?.message}`);
  } else {
    const accounts = res.result?.accounts;
    const endpoints = res.result?.endpoints;
    assert(Array.isArray(accounts) && accounts.length > 0,
      "3/state.accounts",
      `accounts 为空或非数组`);
    assert(Array.isArray(endpoints) && endpoints.length > 0,
      "3/state.endpoints",
      `endpoints 为空或非数组`);
    firstAccountId = accounts?.[0]?.id;
  }
} catch (err) {
  fail("3/state", err.message);
}

// 4. conversationsOf + messages (lab tab)
try {
  if (!firstAccountId) {
    fail("4/lab", "无可用 accountId，跳过");
  } else {
    const convRes = await postJSON("/api/conversationsOf", { accountId: firstAccountId });
    if (convRes.ok !== true) {
      fail("4/conversationsOf", `ok=false: ${convRes.error?.message}`);
    } else {
      const convs = convRes.result;
      assert(Array.isArray(convs), "4/conversationsOf.shape",
        `期望数组, 实得 ${typeof convs}`);
      // 尝试取第一条会话的消息
      if (Array.isArray(convs) && convs.length > 0) {
        const msgRes = await postJSON("/api/messages", { conversationId: convs[0].id ?? convs[0], limit: 5 });
        if (msgRes.ok !== true) {
          fail("4/messages", `ok=false: ${msgRes.error?.message}`);
        } else {
          const msgs = msgRes.result;
          assert(Array.isArray(msgs), "4/messages.shape", `期望数组`);
        }
      } else {
        ok("4/messages.skip", "无会话，消息检查跳过");
      }
    }
  }
} catch (err) {
  fail("4/lab", err.message);
}

// 5. sharedList (shared tab)
try {
  const agents = await postJSON("/api/listAgents");
  const asId = agents.result?.[0]?.id ?? firstAccountId;
  const res = await postJSON("/api/sharedList", { spaceId: "demo", as: asId });
  if (res.ok !== true) {
    fail("5/sharedList", `ok=false: ${res.error?.message}`);
  } else {
    const list = res.result;
    assert(Array.isArray(list), "5/sharedList.shape",
      `期望数组（可空）, 实得 ${typeof list}`);
  }
} catch (err) {
  fail("5/sharedList", err.message);
}

// 6. checkInvariants (observer tab)
try {
  const res = await postJSON("/api/checkInvariants");
  if (res.ok !== true) {
    fail("6/invariants", `ok=false: ${res.error?.message}`);
  } else {
    const violations = res.result?.violations ?? res.result;
    const hasViolation = Array.isArray(violations) ? violations.length > 0 : false;
    assert(!hasViolation, "6/invariants.clean",
      `存在 violation: ${JSON.stringify(violations)}`);
  }
} catch (err) {
  fail("6/invariants", err.message);
}

// 7. SSE 事件流
try {
  const controller = new AbortController();
  const { signal } = controller;
  const res = await fetch(`${BASE}/api/events`, { signal });
  if (!res.ok) {
    fail("7/sse", `HTTP ${res.status}`);
    controller.abort();
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let gotHello = false;
    let gotTick = false;
    const deadline = Date.now() + 5000; // 5s 内应收到 hello + tick

    while (Date.now() < deadline && (!gotHello || !gotTick)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 解析 SSE 帧
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? ""; // 最后不完整帧保留
      for (const frame of frames) {
        if (frame.includes("event: hello") || frame.includes("event:hello")) {
          gotHello = true;
        }
        if (frame.includes("event: tick") || frame.includes("event:tick")) {
          gotTick = true;
        }
      }
    }
    controller.abort();
    assert(gotHello, "7/sse.hello", "5s 内未收到 hello 帧");
    assert(gotTick, "7/sse.tick", "5s 内未收到 tick 帧");
  }
} catch (err) {
  if (err.name !== "AbortError") {
    fail("7/sse", err.message);
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────

console.log(`\n[demo-smoke] ${passed} passed, ${failed} failed / ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
