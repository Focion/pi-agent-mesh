# Pi Agent Mesh

构建在 pi SDK 之上的多智能体消息与共享状态层——`@pi/agent-mesh`。

规范与落地计划见 [`docs/Pi-Agent-Mesh.md`](docs/Pi-Agent-Mesh.md)（v1.0.0 规范）与 [`PLAN.md`](PLAN.md)（落地计划）。

## 现状（v0.1.0）

- ✅ **P0 全量**（§25.1）：双账号互发 10 条全 consumed、sink 收 10 条可 ack、`checkInvariants()` 全绿、mesh-core 不 import pi、契约测试全绿。
- ✅ **P1 核心**（§25.2）：20 账号群 × 50 条广播平均唤醒 ≤1.2（idle 分支）且 busy 分支 = 0、平均原文份数 ≤3、`expect:"reply"` 指向必醒、`expect:"none"` 零 `triggerTurn`。
- ⏳ **P2–P5 延后**：request-response、queue claim、shared spaces、观测面板等见 [`PLAN.md`](PLAN.md) §1。

## 安装与起步

```bash
npm install
npm run build
node examples/quickstart.ts   # Node 24 原生直行 TS；先 build 出 dist/
```

`examples/quickstart.ts` 是一条 sink 直聊的最小闭环：注册 → 直聊 → 投递 → ack → 观测 → 不变量自检，不跑真实 LLM，sessionFactory 用占位实现（§12.1 唯一必填槽）。接真实 pi SDK 时把占位工厂换成 `createPiSessionFactory`，并把账号 `endpointClass` 换成 `"stream"`、warm 端点（§8.3）。

## 一览

```ts
import { createMesh } from "@pi/agent-mesh";

const host = await createMesh({ dbPath: "./mesh.db", policies: { sessionFactory } });

const alice = await host.registerAccount({
  id: "alice", displayName: "Alice (agent)", endpointClass: "stream", initiate: ["chat"],
});

const dm = await host.ensureDirect("alice", "worker");
const { messageId } = await host.send({
  from: "alice", conversationId: dm.id, kind: "chat", expect: "none", text: "你好",
});
```

## 核心概念

- **账号三轴**（§4.2）：`endpointClass`（`stream`/`sink`）、`topology`（`unified`/…）、`initiate`（能主动发起的能力位，如 `"chat"`）。
- **投递状态机**（§5）：`routed → queued → delivered → consumed`；非终态 `parked`（带 TTL）、`dropped(reason)`。`delivered` 由 `entry_appended` 判定，而非 `deliver()` resolve。
- **唤醒守卫**（§7.3）：A1「无 speak 能力则不醒」、A2「presence ∈ {dnd,offline} 阻断（urgent 除外）」、A2'「sink/external 跳过唤醒」、A3「限流 20 次/60s」。
- **激活策略**（§7.3）：默认 `shouldWake = (correlationId 我正等待) || (expect !== "none" && (targetsMe || mentionsMe)) || urgent`；直聊由 Mailbox 在策略后强制 `want = true`。
- **原文预算**（§7.4 `isVerbatim`）：直聊恒全文；`expect:"reply"` 指向的成员因「被请求答复」跃迁为预算内；**从未发言且从未被 @ 的成员恒定超预算**（刚性条款），广播只走摘要路径。预算由 `verbatimGapK` / `maxVerbatimConversations`（=3）约束。
- **三条上下文路径**：P1（`sendCustomMessage`/原文）、P2（收件箱摘要注入，超预算）、P3（note/audit，不发言）。

## API 面

- `createMesh(options)` → `MeshHost`（§12.1）：`dbPath`、`policies`（9 槽，仅 `sessionFactory` 必填，`withPolicyTimeout`/`withPolicyGuard` 逐槽降级）、`streamPort`、`limits`、`devMode`。
- `MeshHost`：`registerAccount` / `registerEndpoint` / `registerSinkHandler` / `setPresence` / `ensureDirect` / `createConversation` / `send` / `markConsumed` / `lookup` / `close` 及控制面 `nudge` / `injectContext` / `beforeClearQueue`。
- `host.observer`（§12.4）：`trace(messageId)`、`inboxOf(accountId)`、`counters(names?, since?)`、`checkInvariants()`。

## 可观测性

- **计数器**：附录 E 登记 23 项（`REGISTERED_COUNTERS`），devMode 下写入未登记名直接抛错。派生指标：`messages_total`、`deliveries_total`、`wake_per_message_idle`、`wake_per_message_busy`、`verbatim_copies`。
- **不变量**（§23.4）：`checkInvariants()` 跑 16 条 SQL 断言 C1–C16（含 `delivered_at IS NOT NULL → queued_at IS NOT NULL`），返回 `{ ok, checked, violations }`。

## 工程结构

```
src/index.ts        mesh 包根装配：createMesh + MeshHost
src/core/           mesh-core：store/router/mailbox/observer/policies/tools/contracts
src/pi/             mesh-pi：PiStreamPort / SessionFactory / EndpointLock（可选 peerDep）
migrations/         SQLite 迁移（000_init.sql）
examples/           quickstart.ts（可运行）
tests/              core 单测 + pi 契约测试 + e2e 验收（createMesh + FakeStreamPort）
```

`result`：mesh-pi 是可选 peerDep（`@earendil-works/pi-coding-agent`），`tsup` 双入口 `index` + `core/index`，mesh-core 可单独 tree-shake（§29.1）。

## 开发门禁

```bash
npm run typecheck      # tsc --noEmit，0 errors
npm test               # vitest，154 tests
node scripts/check-imports.mjs   # mesh-core 不 import pi 的门禁脚本
npm run build          # tsup：esm + cjs + dts
```