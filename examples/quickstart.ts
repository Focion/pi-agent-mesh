// ═══════════════════════════════════════════════════════════════════════════
// Pi Agent Mesh — 五分钟起步（可运行，带结果断言）
//
// 运行方式（先构建产物，再用 Node 原生 TS 直行）：
//   npm install
//   npm run build
//   node examples/quickstart.ts
//
// 仓库内经 Node 包自引用把 `@pi/agent-mesh` 解析到 dist/；消费者工程里则解析到
// 实际安装的包（G08 会把本文件复制进隔离工程直跑）。任一条 `check` 不通过会置
// `process.exitCode = 1`，故本文件本身即「example 带结果断言」的门。
//
// 本示例用 sink 账号演示「注册 → 直聊 → 投递 → ack → 观测 → 不变量」全链路，
// 不跑真实 LLM、不 warm 流端，因此 sessionFactory 给一段占位实现即可（§12.1：
// 未配 llm 时 sessionFactory 是必填槽）。想接真实 pi SDK 时，把这段换成
// createMesh({ llm, runtime })（库内部装配，见 README「接真实 pi SDK」），或
// 走高级路径 createAssembledSessionFactory（见 src/pi/session-factory.ts）。
// ═══════════════════════════════════════════════════════════════════════════

import {
  createMesh,
  type SessionFactory,
  type SinkHandler,
} from "@pi/agent-mesh";

const log = (label: string, value?: unknown): void => {
  if (value === undefined) {
    console.log(`\n── ${label} ──`);
    return;
  }
  console.log(
    label,
    typeof value === "string" ? value : JSON.stringify(value),
  );
};

// 断言助手：打印 ✓/✗，失败时记 exitCode，让本文件可直接作为门（非仅人肉看 log）。
const check = (label: string, cond: boolean): void => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// 占位策略：sink 路径不建 session，这段不会被调用。真实接入时改用
// createMesh({ llm, runtime }) 或 createAssembledSessionFactory（见 src/pi/）。
const sessionFactory: SessionFactory = {
  create: async () => ({ session: {}, piSessionId: "quickstart" }),
  open: async () => ({ session: {} }),
};

async function main(): Promise<void> {
  // ① 装配（§12.1）：:memory: 免实例锁；生产用文件路径 + 单实例锁。
  const host = await createMesh({
    dbPath: ":memory:",
    policies: { sessionFactory },
  });

  try {
    // ② 账号三轴（§4.2）：alice 是能主动发起 chat 的 stream；worker 是 host 侧 sink。
    const alice = await host.registerAccount({
      id: "alice",
      displayName: "Alice (agent)",
      endpointClass: "stream",
      initiate: ["chat"],
    });
    await host.registerAccount({
      id: "worker",
      displayName: "Worker (host UI)",
      endpointClass: "sink",
    });
    check("账号注册：alice + worker 均成功", alice.id === "alice");

    // ③ sink 处理器（§6.3③）：宿主自收寄，accepted 即 delivered。
    const received: string[] = [];
    const handler: SinkHandler = {
      deliver: async (_rendered, envelope) => {
        received.push(envelope.payload.text ?? "");
        log(`[sink] worker 收到:`, envelope.payload.text ?? "");
        return { accepted: true, consumedImmediately: false };
      },
    };
    host.registerSinkHandler("worker", handler);

    // ④ 直聊 + 发消息（§9.1 / §6.1）：三轴里 initiate:["chat"] 让 alice 能开口。
    const dm = await host.ensureDirect("alice", "worker");
    const sent = [];
    for (const text of ["你好 worker", "这个 ticket 帮我看看"]) {
      sent.push(await host.send({ from: "alice", conversationId: dm.id, kind: "chat", expect: "none", text }));
    }
    check("发送 2 条消息成功", sent.length === 2);

    // ⑤ 轨迹（§12.4）：先 delivered，再 ack。
    for (const { messageId } of sent) {
      const [trace] = await host.observer.trace(messageId);
      if (!trace) {
        check(`trace 存在（${messageId.slice(0, 8)}…）`, false);
        continue;
      }
      check(
        `delivery ${trace!.deliveryId.slice(0, 8)}… 状态 = delivered`,
        trace!.state === "delivered",
      );
      log(`delivery ${trace!.deliveryId.slice(0, 8)}… 状态 =`, trace!.state);
      await host.markConsumed(trace!.deliveryId);
    }

    // ⑥ 观测：收件箱 / 轨迹终态 / 计数器 / 不变量。
    log("收件箱 worker");
    const inbox = await host.observer.inboxOf("worker");
    log("会话数 =", inbox.conversations.length);
    log("待我处理的开集应答 =", inbox.awaitingMyAck.length);
    check("收件箱会话数 = 1", inbox.conversations.length === 1);
    check("待我处理的开集应答 = 0", inbox.awaitingMyAck.length === 0);

    log("计数器");
    const counters = await host.observer.counters([
      "messages_total",
      "deliveries_total",
      "verbatim_copies",
    ]);
    log("  计数", counters);
    check("messages_total = 2", counters.messages_total === 2);
    check("deliveries_total = 2", counters.deliveries_total === 2);

    log("不变量自检（§23.4 C1–C16）");
    const report = await host.observer.checkInvariants();
    log(`ok = ${report.ok}, checked = ${report.checked}, violations = ${report.violations.length}`);
    check("不变量 ok = true", report.ok === true);
    check("不变量 violations.length = 0", report.violations.length === 0);

    log("lookup 全量账号");
    const accounts = await host.lookup({});
    log("  账号列表", accounts);
    check(
      "lookup 含 alice 与 worker",
      accounts.some((a) => a.id === "alice") && accounts.some((a) => a.id === "worker"),
    );

    console.log(
      process.exitCode
        ? "\n⚠ 存在断言失败，请检查上方 ✗ 项。"
        : "\n✅ quickstart 全链路断言通过。",
    );
  } finally {
    await host.close();
  }
}

await main();