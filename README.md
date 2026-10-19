# Pi Agent Mesh

构建在 pi SDK 之上的多智能体消息与共享状态层——`@pi/agent-mesh`。

规范见 [`.agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md`](.agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md)（文档版本 v1.0.1），未完成事项见 [`.agents/notes/plan/`](.agents/notes/plan/)，v0.1.0 的落地与关闭记录见 [`.agents/notes/archive/`](.agents/notes/archive/)。

## 现状（v0.1.0）

| 功能块 | 状态 |
| --- | --- |
| **P0** — 双账号互发 + sink ack + checkInvariants | ✅ 全量 |
| **P1** — 20 账号群广播唤醒/原文预算/验收比值 | ✅ 全量 |
| **topic** — subscribe/unsubscribe + fanout (§16) | ✅ 全量 |
| **request-response** — request/ack + 超时/迟到/环检测 (§14) | ✅ 全量 |
| **queue** — claim/requeue + attempts/maxAttempts/sweep (§17) | ✅ 全量 |
| **共享空间** — get/put/append/del/list + CAS + ACL (§18) | ✅ 全量 |
| **observer.replay** — 基础转写（非历史精确重建） | ✅ 全量 |
| **observer.forkAt** — P5 deferred | ⏳ MeshUnsupportedError |
| **多进程 Transport** — sameHost 同机多进程（§19） | ✅ 全量（跨机 Transport 不在范围） |

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
  policies: { sessionFactory }, // 未配 llm 时 sessionFactory 仍是必填槽（§12.1）
});

const alice = await host.registerAccount({
  id: "alice", displayName: "Alice", endpointClass: "stream", initiate: ["chat"],
});

const dm = await host.ensureDirect("alice", "worker");
const { messageId } = await host.send({
  from: "alice", conversationId: dm.id, kind: "chat", expect: "none", text: "你好",
});
```

### 接真实 pi SDK（Mesh 统一 LLM 配置）

只要给 `llm`（与可选的 `runtime`）配置，库就在内部完成**完全隔离**的 pi 装配（不读 `~/.pi`，不启用内建工具），endpointClass 用 `"stream"`，warm 端点即可：

```ts
import { createMesh } from "@pi/agent-mesh";

const host = await createMesh({
  dbPath: "./mesh.db",
  llm: {
    model: "anthropic:claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY", // 生产首选；测试链路可用 apiKey
    // 自定义 OpenAI 兼容端点（可选）：
    // providers: { my: { baseUrl: "https://x.example.com/v1", apiKeyEnv: "MY_LLM_KEY" } },
    //   model: "my:gpt-4-mini",
  },
  runtime: { builtinTools: [] }, // [] = 全禁内建工具；mesh 工具恒保留
});

const alice = await host.registerAccount({
  id: "alice", displayName: "Alice", endpointClass: "stream", initiate: ["chat"],
});
const ep = await host.registerEndpoint({ accountId: "alice", topology: { kind: "unified" } });
await host.warm(ep.id, "shared"); // 真实 LLM 冷起
```

需要拿到 session 内部（自行驱动 LLM 轮）的宿主可走高级路径：`policies.sessionFactory: await createAssembledSessionFactory({ stateDir, llm, runtime })`（`llm`/`runtime` 与上面同 schema）。

## 完整 API 面

### 账号与会话

- `registerAccount(opts)` → `Account`
- `registerEndpoint({ accountId, topology })` → `Endpoint`
- `registerSinkHandler(accountId, handler)` → `Unsubscribe`
- `setPresence(accountId, state, opts?)` — available/busy/dnd/away/online/idle/offline（`online`/`idle` 为 stream 派生态，`available`/`away` 为 legacy 别名）
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
- `host.observer.replay(endpointId, { untilSeq? })` — 基础转写（非历史精确重建）
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

全真实装配的**能力演示面板**（5 Tab：群聊 / 拓扑与在场 / 消息实验室 / 共享空间 / 观测），本地 SSE + 静态页。群聊首启预置 Alice / Bob / Carol 三个 agent，真实 LLM 接力回复；其余 Tab 覆盖 request-应答、queue claim/requeue、shared CAS、observer 计数器/不变量/投递轨迹/replay、presence 七态 (host + derived) 等能力展示。不覆盖 forkAt / 跨机 Transport / 多进程 UI。

```bash
npm run demo:start        # 启动 → http://localhost:8787
```

### 配置

`demo/demo.config.json`（首次运行由 `demo.config.example.json` 复制）直接内嵌 Mesh 的 `llm` / `runtime` 配置：

```json
{
  "llm": {
    "model": "anthropic:claude-sonnet-4-5",
    "thinkingLevel": "medium",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "runtime": {
    "builtinTools": []
  },
  "port": 8787
}
```

自定义 OpenAI 兼容端点写在 `llm.providers`（本面板不读 `~/.pi` 的 models.json / auth.json）：

```json
{
  "llm": {
    "model": "my:gpt-4-mini",
    "providers": {
      "my": { "baseUrl": "https://your-host.example.com/v1", "apiKeyEnv": "MY_LLM_KEY" }
    }
  }
}
```

凭据可由 `llm.apiKey`（仅测试链路）或 `llm.apiKeyEnv`（生产首选，指向环境变量名）提供；无凭据 / 坏模型会 fail-fast 退出。

### 面板功能

| Tab | 区域 | 功能 |
| --- | --- | --- |
| 群聊 | 注册 / 群成员 | 名字+人设注册 stream agent；花名册实时列表 |
| 群聊 | 消息流 / 发送 | SSE 实时消息、1–3 轮自动接力、@定向、模型异常回显 |
| 拓扑与在场 | Account / Endpoint | 注册账号(stream/sink/external) 与端点；表格展示 id/类别/state/lease/session |
| 拓扑与在场 | Presence 七态 | setPresence(available/busy/dnd/away/offline + until/reason)；区分 host vs derived(online/idle) |
| 拓扑与在场 | 操作 | warm(shared/exclusive) / evict / nudge(deliverAs/triggerTurn) / sinkMode(accept\|refuse) |
| 消息实验室 | 会话 | 创建 direct/group/topic/queue + config JSON(historyVisibility/claimTtlMs) |
| 消息实验室 | send / request | chat/event/task + expect:ack 双路径对照；priority/mentions/to |
| 消息实验室 | Delivery Trace | routed→delivered→consumed/parked/dropped；note/redeliverReason/attempts/grade/path |
| 消息实验室 | queue & ack | claim/requeue/markConsumed；inboxOf→awaitingMyAck→ack/nack |
| 共享空间 | host.shared | put/get/append/del/list；CAS(expectedVersion)；shared_object_changed 实时刷新 |
| 观测 | 计数器网格 | 23 个 REGISTERED_COUNTERS；新增(blind_write/claim_timeout/queue_cleared_detected/delivery_handoff_timeout) 高亮 |
| 观测 | 验收比值 | §24.2 computeAcceptance + 每秒 tick |
| 观测 | 只读入口 | checkInvariants / search / replay / streamEntries |
| 观测 | 活动流 | 15 MeshEvent + delivery/sink 汇聚可筛选时间线 |
| 配置抽屉 | 健康头 | /api/health 展示 provider/model/thinking/tools/dbPath/port/fingerprint/credentialSource |

## 测试

```bash
npm test                 # vitest，622 tests（70 文件）+ 4 bench
npm run typecheck        # tsc --noEmit，0 errors
node scripts/check-imports.mjs  # mesh-core 零 pi import（G1–G4）
npm run build            # tsup：esm + cjs + dts
```

### 测试文件

```
tests/core/     36 文件 — 存储/迁移/恢复、投递状态机、路由、邮箱、策略、共享空间、
                         工具、渲染、观测、envelope/health/seal/transport 等单测
tests/pi/       15 文件 — StreamPort 契约、pi SDK 适配、LLM 配置解析、session 工厂
                         （真实 SDK + faux provider）
tests/e2e/      19 文件 — P0/P1、topic、request-应答、queue、共享空间、sameHost §19 端到端
tests/bench/     4 文件 — 基准（bench），不参与门禁
tests/helpers/          — 公共辅助（FakeStreamPort、gap-ledger、disposition、invariants…）
```

## 工程结构

```
src/index.ts            mesh 包根装配：createMesh + MeshHost
src/core/               mesh-core：store/router/mailbox/observer/policies/tools/
                          shared/contracts/envelope/health/seal/transport（零 pi import）
src/pi/                 mesh-pi：PiStreamPort / SessionFactory / EndpointLock
migrations/             SQLite 迁移（000_init.sql + 001–004）
demo/                   群聊面板（node:http + SSE + 静态页）
  src/runtime.ts        控制器（MeshHost 全委托）
  src/rpc.ts            RPC 命令表
  src/server.ts         HTTP 服务
  src/sse.ts            SSE 事件推送
  src/config.ts         demo 配置（llm/runtime/port，从 example 复制）
  public/               前端（vanilla JS，零依赖）
examples/               quickstart.ts（带断言的最小闭环示例）
scripts/                check-imports.mjs / pack.mjs / verify-local.mjs /
                          verify-package.mjs / bench.mjs / gen-gap-ledger.mjs /
                          gen-snapshots.mjs / coverage-gate.mjs / start-demo.sh
tests/                  单测（core/pi）+ 契约 + e2e + bench
```

`pi`（`@earendil-works/pi-coding-agent`）是**直接依赖**，但经 `src/pi/pi-sdk.ts` 惰性加载；`tsup` 双入口 `index` + `core/index`，mesh-core 可单独 tree-shake 且零 pi 依赖。

## 核心概念

- **账号三轴**（§4.2）：`endpointClass`（`stream`/`sink`/`external`）、`topology`（`unified`/`perConversation`/`pooled`）、`initiate`（能主动发起的 channel）。
- **投递状态机**（§5）：`routed → queued → delivered → consumed`；非终态 `parked`（带 TTL）、`dropped(reason)`。Queue 消息增加 `claimed` → `acked`（终态）。
- **唤醒守卫**（§7.3）：A1「无 speak 能力则不醒」、A2「presence ∈ {dnd,offline} 阻断」、A2'「sink/external 跳过」、A3「限流 20 次/60s」。
- **原文预算**（§7.4）：直聊恒全文；`expect:"reply"` 指向的成员因「被请求答复」跃迁为预算内；从未发言且从未被 @ 的成员恒定超预算。预算由 `verbatimGapK` / `maxVerbatimConversations`（=3）约束。
- **topic 静默投递**：每个订阅者生成一条 delivery（P3 路径），不唤醒。
- **queue 竞争消费**：单消费者由 `selectQueueConsumer`（least-in-flight + lex sort）选出，`sync=0` 不阻塞；`claim` 后可在 `leaseUntil` 内 `ack`（成功 → acked）或 `error`（nack → 回队，attempts++）。
- **request-response 环检测**：插入 `sync=1` pending_ack 前跑 `detectRequestCycle`，命中 → `REQUEST_CYCLE`；超时 → `request_timeout` + system 通知 + 释放租约。

## 支持矩阵

| 维度 | 声明 | 验证口径 |
| --- | --- | --- |
| Node.js | `>=22.19.0`（engines 下限） | 实测于 Node 24.19.0（macOS arm64）与 Node 22.20.0（Linux x64）；低于下限时 vitest 的 fork 池会直接失败 |
| 模块系统 | ESM + CJS 双产物（`index` / `core/index` + `.d.ts` / `.d.cts`） | `npm run verify:package`（G08 消费者矩阵） |
| pi SDK | `@earendil-works/pi-coding-agent@^1.1.0` 直接依赖，`loadPiSdk()` 惰性加载 | core-only 冒烟不加载 pi（G08 无 pi 腿） |
| 存储 | better-sqlite3 `^13`（SQLite，原生模块） | 真实文件 DB 创建/重开/迁移（G08 B 腿） |
| 多进程 | sameHost 同机多进程（§19） | `tests/e2e/samehost.test.ts` 等 e2e |

> 跨机 Transport 与 `observer.forkAt` 不在 v0.1.0 范围；真实 LLM 仅在 demo / 示例中按 `llm` 配置接入，测试与非交互命令行不消耗真实模型或凭据。