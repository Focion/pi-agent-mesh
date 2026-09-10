// ═══════════════════════════════════════════════════════════════════════════
// Pi Agent Mesh — 五分钟起步（可运行）
//
// 运行方式（先构建产物，再用 Node 原生 TS 直行）：
//   npm install
//   npm run build
//   node examples/quickstart.ts
//
// 本示例用 sink 账号演示「注册 → 直聊 → 投递 → ack → 观测 → 不变量」全链路，
// 不跑真实 LLM、不 warm 流端，因此 sessionFactory 给一段占位实现即可（§12.1
// 唯一必填槽）。想接真实 pi SDK 时，把这段换成 createPiSessionFactory 返回的
// 工厂，并把 endpointClass 换成 "stream"、warm 你的端点（§8.3）。
// ═══════════════════════════════════════════════════════════════════════════

import {
  createMesh,
  type SessionFactory,
  type SinkHandler,
} from "../dist/index.js";

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

// 占位策略：sink 路径不建 session，这段不会被调用。真实接入时替换为
// createPiSessionFactory（见 src/pi/session-factory.ts）。
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

    // ⑤ 轨迹（§12.4）：先 delivered，再 ack。
    for (const { messageId } of sent) {
      const [trace] = await host.observer.trace(messageId);
      log(`delivery ${trace!.deliveryId.slice(0, 8)}… 状态 =`, trace!.state);
      await host.markConsumed(trace!.deliveryId);
    }

    // ⑥ 观测：收件箱 / 轨迹终态 / 计数器 / 不变量。
    log("收件箱 worker");
    const inbox = await host.observer.inboxOf("worker");
    log("会话数 =", inbox.conversations.length);
    log("待我处理的开集应答 =", inbox.awaitingMyAck.length);

    log("计数器");
    const counters = await host.observer.counters([
      "messages_total",
      "deliveries_total",
      "verbatim_copies",
    ]);
    log("  计数", counters);

    log("不变量自检（§23.4 C1–C16）");
    const report = await host.observer.checkInvariants();
    log(`ok = ${report.ok}, checked = ${report.checked}, violations = ${report.violations.length}`);

    log("lookup 全量账号");
    log("  账号列表", await host.lookup({}));
  } finally {
    await host.close();
  }
}

await main();