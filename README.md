# Pi Agent Mesh

构建在 pi SDK 之上的多智能体消息与共享状态层——`@pi/agent-mesh`。

规范见 [`.agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md`](.agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md)（v1.0.0 规范），落地记录见 [`.agents/notes/plan/`](.agents/notes/plan/)。

## 现状（v0.1.0）

| 功能块 | 状态 |
| --- | --- |
| **P0** — 双账号互发 + sink ack + checkInvariants | ✅ 全量 |
| **P1** — 20 账号群广播唤醒/原文预算/验收比值 | ✅ 全量 |
| **topic** — subscribe/unsubscribe + fanout (§16) | ✅ 全量 |
| **request-response** — request/ack + 超时/迟到/环检测 (§14) | ✅ 全量 |
| **queue** — claim/requeue + attempts/maxAttempts/sweep (§17) | ✅ 全量 |
| **共享空间** — get/put/append/del/list + CAS + ACL (§18) | ✅ 全量 |
| **observer.replay** — 零 LLM 回放转写 | ✅ 全量 |
| **observer.forkAt** — P5 deferred | ⏳ MeshUnsupportedError |
| **多进程 Transport** — P5 deferred | ⏳ 不做 |

## 安装与起步

```bash
npm install
npm run build
```

### 最小闭环（不使用真实 LLM）

```ts
import { createMesh } from "@pi/agent-mesh";

const host = await createMesh({
  dbPath: "./mesh.db",
  policies: { sessionFactory }, // sessionFactory 是唯一必填槽（§12.1）
});

const alice = await host.registerAccount({
  id: "alice", displayName: "Alice", endpointClass: "stream", initiate: ["chat"],
});

const dm = await host.ensureDirect("alice", "worker");
const { messageId } = await host.send({
  from: "alice", conversationId: dm.id, kind: "chat", expect: "none", text: "你好",
});
```

### 接真实 pi SDK

把 `sessionFactory` 换成 `createPiSessionFactory`，endpointClass 用 `"stream"`，warm 端点即可：

```ts
import { createMesh, createPiSessionFactory } from "@pi/agent-mesh";

const host = await createMesh({
  dbPath: "./mesh.db",
  policies: {
    sessionFactory: createPiSessionFactory({ stateDir: "./.pi-state", model }),
  },
});

const alice = await host.registerAccount({
  id: "alice", displayName: "Alice", endpointClass: "stream", initiate: ["chat"],
});
const ep = await host.registerEndpoint({ accountId: "alice", topology: { kind: "unified" } });
await host.warm(ep.id, "shared"); // 真实 LLM 冷起
```

## 完整 API 面

### 账号与会话

- `registerAccount(opts)` → `Account`
- `registerEndpoint({ accountId, topology })` → `Endpoint`
- `registerSinkHandler(accountId, handler)` → `Unsubscribe`
- `setPresence(accountId, state, opts?)` — available/busy/dnd/away/offline
- `lookup({ query?, capabilities?, limit? })` → `Account[]`
- `upsertContact(ownerId, peerId, opts?)`

### 会话

- `ensureDirect(a, b)` → `Conversation`
- `createConversation({ type, creator, members?, topic? })` → `Conversation`
- `addMember` / `removeMember` / `join` / `leave`
- `setCaps` / `setTopic` / `setAnnouncement` / `mute` / `dissolve`
- `upgradeToGroup(directConv, extra, by)` → `Conversation`

### 发送与应答

- `send({ from, conversationId, kind, expect, text, ... })` → `{ messageId, seq }`
- **request** `request(m, opts?)` → `{ correlationId } | AckResult` — 非阻塞返回 correlationId；`{ await: true }` 阻塞等 `message_acked` 事件返回 `AckResult`
- **ack** `ack({ correlationId, from, data?, error? })` — error 非空 = nack，队列消息回队
- **subscribe** `subscribe(conv, account)` — 订阅 topic
- **unsubscribe** `unsubscribe(conv, account)` — 取消订阅，软删 + buffered 投递转 dropped(ACL_DENIED)

### Queue（§17）

- **claim** `claim(messageId, by)` → `{ ok, leaseUntil? }` — 认领 delivered 消息
- **requeue** `requeue(messageId, targetConv)` — 把消息转到另一队列，attempts 从 0 起

### 共享空间（§18）

- **shared.get** `shared.get(spaceId, key, { as, version? })` → `SharedObjectMeta | null`
- **shared.put** `shared.put(spaceId, key, data, { as, expectedVersion? })` → `{ version }`
- **shared.append** `shared.append(spaceId, key, item, { as, maxLen? })` → `{ version }`
- **shared.del** `shared.del(spaceId, key, { as })` — 软删（tombstone）
- **shared.list** `shared.list(spaceId, { as, keyPrefix? })` → `SharedObjectMeta[]`

spaceId 格式：`"global"` | `"conv:<conversationId>"` | `"acct:<accountId>"`。
CAS：`expectedVersion` 缺省 = 盲写，`0` = 断言不存在，不匹配 → `VERSION_MISMATCH`。
ACL：默认 `global`/`acct:` 仅 owner 可读写，`conv:` 会话成员可读写；可通过 `AccessControl` 策略自定义。

### 控制面

- `warm(endpointId, lease?)` — 预热端点
- `evict(endpointId)` — 驱逐端点
- `nudge(endpointId, cue, opts?)` — 发起真实 agent 轮
- `injectContext(endpointId, text)` — 注入上下文
- `beforeClearQueue(endpointId)` — 清队前收敛
- `markConsumed(deliveryId)` — 确认消费投递

### 观测

- `host.observer.trace(messageId)` — 投递轨迹
- `host.observer.messages({ conversationId?, from?, kind?, sinceSeq?, limit? })` — 信封列表
- `host.observer.inboxOf(accountId)` — 收件箱快照
- `host.observer.counters(names?, since?)` — 计数器
- `host.observer.checkInvariants()` — C1–C16 不变量自检（含 C13 claimed 不过期）
- `host.observer.replay(endpointId, { untilSeq? })` — 零 LLM 回放转写
- `host.observer.streamEntries(piSessionId, { sinceSeq? })` — 读取原始流条目

### 事件

```
message_routed → message_delivered → message_consumed
    ↓ message_parked    ↓ message_dropped
message_acked    request_timeout
conversation_changed    membership_caps_changed    shared_object_changed
presence_changed    endpoint_state_changed
policy_degraded    invariant_violated
```

## Demo 面板

全真实装配的面板（真实 PiStreamPort + 真实 LLM），本地 SSE + 静态页，支持所有能力的界面测试。

```bash
npm run demo:start        # 启动 → http://localhost:8787
```

### 配置

环境变量 `PI_API_KEY` 或 `demo/demo.config.example.json` → `demo/demo.config.json`：

```json
{
  "dbPath": "demo/.data/mesh.db",
  "stateDir": "demo/.data/pi-state",
  "thinkingLevel": "minimal",
  "tools": [],
  "port": 8787
}
```

模型凭据写在 `demo/models.json`（见 `demo/models.json.example`）。

### Tab 说明

| Tab | 功能 |
| --- | --- |
| 状态/事件 | 运行配置 + 实时事件流（15 个 MeshEvent + sink_received） |
| 账号与端点 | registerAccount / registerEndpoint / presence / contact / lookup |
| 会话与成员 | createConversation / ensureDirect / 九群操作 + subscribe/unsubscribe |
| 发送 | send 组合器（kind/expect/priority/to/mentions） |
| Sink | sink 模式切换（accept/refuse/auto-consume）+ sink_received 事件 |
| 流控制/Agent | warm/evict/nudge/injectContext/toolSet/streamEntries |
| Observer/Trace | trace/messages/search/inboxOf/counters/checkInvariants |
| 验收 P0/P1 | 一键场景 + 实时验收比值 |
| Topic | subscribe/unsubscribe + publish + inboxOf |
| 请求-应答 | request（非阻塞/阻塞）+ ack + trace |
| Queue | claim + ack/nack + requeue + trace |
| 共享空间 | get/put/append/del/list + CAS |
| Replay | observer.replay + streamEntries + forkAt（unsupported） |

## 测试

```bash
npm test                 # vitest，209 tests（11 个测试文件）
npm run typecheck        # tsc --noEmit，0 errors
node scripts/check-imports.mjs  # mesh-core 零 pi import（G1–G4）
npm run build            # tsup：esm + cjs + dts
```

### 测试文件

```
tests/core/mailbox.test.ts    — 投递状态机、claim/ack/超时/sweep
tests/core/observer.test.ts   — trace/inboxOf/counters/checkInvariants/replay
tests/core/policies.test.ts   — 策略槽
tests/core/router.test.ts     — 路由、环检测、topic fanout、queue consumer
tests/core/shared.test.ts     — 共享空间 get/put/append/del/list + CAS + ACL
tests/core/store.test.ts      — SQLite store
tests/core/tools.test.ts      — 工具定义与执行
tests/pi/stream-port.test.ts  — StreamPort 契约
tests/e2e/acceptance.test.ts  — P1/P0 + topic/request-reply/queue/shared 端到端
tests/e2e/options.test.ts     — createMesh options
tests/helpers/                — FakeStreamPort 等
```

## 工程结构

```
src/index.ts            mesh 包根装配：createMesh + MeshHost
src/core/               mesh-core：store/router/mailbox/observer/policies/tools/
                          shared/contracts（零 pi import）
src/pi/                 mesh-pi：PiStreamPort / SessionFactory / EndpointLock
migrations/             SQLite 迁移（000_init.sql，17 表）
demo/                   面板（node:http + SSE + 静态页）
  src/runtime.ts        控制器（MeshHost 全委托）
  src/rpc.ts            RPC 命令表
  src/server.ts         HTTP 服务
  src/sse.ts            SSE 事件推送
  public/               前端（vanilla JS，零依赖）
scripts/                check-imports.mjs / pack.mjs / start-demo.sh
tests/                  单测 + 契约 + e2e
```

`mesh-pi` 是可选 peerDep（`@earendil-works/pi-coding-agent`），`tsup` 双入口 `index` + `core/index`，mesh-core 可单独 tree-shake。

## 核心概念

- **账号三轴**（§4.2）：`endpointClass`（`stream`/`sink`/`external`）、`topology`（`unified`/`perConversation`/`pooled`）、`initiate`（能主动发起的 channel）。
- **投递状态机**（§5）：`routed → queued → delivered → consumed`；非终态 `parked`（带 TTL）、`dropped(reason)`。Queue 消息增加 `claimed` → `acked`（终态）。
- **唤醒守卫**（§7.3）：A1「无 speak 能力则不醒」、A2「presence ∈ {dnd,offline} 阻断」、A2'「sink/external 跳过」、A3「限流 20 次/60s」。
- **原文预算**（§7.4）：直聊恒全文；`expect:"reply"` 指向的成员因「被请求答复」跃迁为预算内；从未发言且从未被 @ 的成员恒定超预算。预算由 `verbatimGapK` / `maxVerbatimConversations`（=3）约束。
- **topic 静默投递**：每个订阅者生成一条 delivery（P3 路径），不唤醒。
- **queue 竞争消费**：单消费者由 `selectQueueConsumer`（least-in-flight + lex sort）选出，`sync=0` 不阻塞；`claim` 后可在 `leaseUntil` 内 `ack`（成功 → acked）或 `error`（nack → 回队，attempts++）。
- **request-response 环检测**：插入 `sync=1` pending_ack 前跑 `detectRequestCycle`，命中 → `REQUEST_CYCLE`；超时 → `request_timeout` + system 通知 + 释放租约。