# Pi Agent Mesh 落地实施计划

依据：`docs/Pi-Agent-Mesh.md`（v1.0.0 定稿）。本计划按 §25 落地步骤推进，本轮交付 **P0 全部 + P1 核心**。

## 0. 环境事实（已验证）

| 项 | 值 |
| --- | --- |
| Node / npm | v24.19.0 / 11.17.0（网络可用） |
| pi SDK | `@earendil-works/pi-coding-agent@0.85.1`（满足 ≥0.84.4；API 面已逐项核对：`sendCustomMessage`/`subscribe(entry_appended,turn_end)`/`SessionManager.appendCustomEntry | appendCustomMessageEntry | getEntry | getEntries`/`createAgentSessionServices`/`createAgentSessionFromServices({customTools})`） |
| SQLite 驱动 | better-sqlite3@13（WAL/busy_timeout 支持） |
| 可用 subagent | worker(fork,读写) / reviewer(只读) / scout / oracle / delegate |

**与规范的一处刻意偏差**：`SessionFactory` 的 `session` 字段在 core 类型中为 `unknown`（而非 pi 的 `AgentSession`），以保住「mesh-core 零 pi import」门禁（§3.3/§29.2）。mesh-pi 侧负责结构校验与收窄；宿主需要类型时自行在工厂内收窄。

## 1. 本轮范围

**P0（§25.1）全量**：17 表 schema、三层信封、mesh-core/mesh-pi 拆分 + StreamPort 10 方法 + CI 门禁、账号三轴、含 `parked` 的完整状态机、SessionHost + SessionFactory + .lock、unified 拓扑、InProcessTransport、ensureDirect/send/唤醒/SinkHandler、默认 Renderer、mesh_send/mesh_inbox/mesh_history、withPolicyTimeout + policy_degraded、dispose、FakeStreamPort + pi 契约测试。

**P1（§25.2）核心**：九个群操作 + caps 子集（I8）、mentions 寻址 + @all 节流、DeliveryPolicy 档位矩阵、ActivationPolicy A1/A2/A2'/A3、FloorPolicy 槽（free_for_all）、原文预算（两游标 + CATCHUP + maxVerbatimConversations）、未读 + 溢出折叠 + P2 注入、合并唤醒（仅空闲流）、historyVisibility、23 计数器接入。

**暂缓**：P2 冷热驱逐细节/崩溃恢复属性测试/topic、P3 请求-应答/queue/Presence、P4 共享空间、P5 replay 字节保真/多进程 outbox。（schema 与类型面已为它们预留，后续阶段无需迁移公共 API。）

## 2. 阶段与并行泳道

```
Stage 0 地基(父) ──► Stage 1 六条并行泳道(worktree 隔离) ──► Stage 2 集成(父) ──► Stage 3 评审(只读) ──► Stage 4 收尾(父)
```

### Stage 0 — 地基（父 agent 顺序执行，产出唯一契约）

| 文件 | 内容 |
| --- | --- |
| `package.json` 等 | 双入口 exports（`.` / `./core` / `./migrations/*`）、tsup 双产物、vitest |
| `migrations/000_init.sql` | 附录 G 全量 17 表 + fts5 DDL（一次到位，后续阶段免迁移） |
| `src/core/types.ts` | **全部公共类型**：§5.2 信封、§12.6 辅助类型、§12.3 九策略槽、§2.4 StreamPort、§19.2 Transport、附录 F.1 Limits(26 项)、§12.5 事件、Observer/MeshHost/createMesh 签名 |
| `src/core/contracts.ts` | **内部组件契约**（非公共 API）：Store / Registry / EventBus / ToolContext 接口 |
| `src/core/util.ts` | 单调 ULID、sha256 幂等键、direct 会话 id 派生（§9.1）、ISO 时钟 |
| `tests/helpers/db.ts` | 打开临时库并应用 DDL（各泳道测试共用） |
| `tests/helpers/fake-stream-port.ts` | §23.5 规定的 FakeStreamPort（同步回吐 entry、无 queueDepth、opts.triggerTurn） |
| `scripts/check-imports.mjs` | CI 门禁：src/core 不得 import pi；词表扫描(M1) |
| git commit | 泳道的公共基线 |

### Stage 1 — 并行泳道（6 lanes，`worktree:true`，文件所有权互斥）

| Lane | 交付物 | 主要规范节 |
| --- | --- | --- |
| **L1 store-registry** | `store.ts`(open/migrate/IMMEDIATE tx/seq 分配/counters) `registry.ts`(账号/端点/会话/成员/联系人 + I7/I8 校验) `events.ts` `transport.ts` + 单测 | §11 §12.5 §19.2 |
| **L2 router-mailbox** | `router.ts`(六步校验/信封签发/扇出) `mailbox.ts`(状态机/parked/handoff/折叠/预算/合并唤醒) + 单测 | §5.4 §7 §9.5 |
| **L3 policies** | 9 槽默认实现 + `withPolicyTimeout`（I21）+ 唤醒指标测试 | §7.2–7.4 §12.3 §13.2 |
| **L4 mesh-pi** | `pi/stream-port.ts`(10 方法/sendCustomMessage 唯一出口) `pi/lock.ts` + pi 契约测试 CT-F1..F5 | §2.4 §8.2-8.4 §23.5 |
| **L5 renderer-tools** | `renderer.ts`(M4 四防线/包裹/转义/sink JSON) `tools.ts`(14 工具 + 固定文案) + 单测 | §10 §5.7 |
| **L6 observer** | `observer.ts`(messages/trace/inboxOf/counters + C1–C16 SQL 断言) + 单测 | §12.4 §23.4 |

### Stage 2 — 集成（父 agent）

合并泳道产物 → `src/index.ts`(createMesh + MeshHost §12.2 全 API) → `src/core/index.ts` 子入口 → 端到端验收测试 → typecheck + 全量测试修复。

### Stage 3 — 评审（reviewer，只读）

按六约束 M1–M6 + F1–F5 + I21/I22/I23 审查合并结果；父 agent 修复。

### Stage 4 — 收尾（父 agent）

`examples/quickstart.ts`（可运行）+ README + CI 门禁脚本全绿 + 最终 commit。

## 3. 验收标准（本轮 Done 的定义）

**P0（§25.1）**

1. 两账号互发 10 条消息全部 `consumed`；2. sink 账号收 10 条并能 ack（markConsumed）；
2. `checkInvariants()` 全绿；4. mesh-core 不 import pi（门禁脚本绿）；5. pi 契约测试全绿。

**P1（§25.2）**

1. 20 账号群 × 50 消息：每消息平均唤醒 ≤1.2（idle）；2. 每消息平均原文份数 ≤3；
2. `expect:"reply"` 指向自己必唤醒（A1 无例外）；4. `expect:"none"` 触发 `triggerTurn:true` 次数 = 0。

**质量门禁**：`npx tsc --noEmit` 0 错；vitest 全绿；`node scripts/check-imports.mjs` 0 违规。

## 4. 泳道协议（每条泳道的任务包必须自含）

- 泳道只写自己名下的文件；禁改共享文件（package.json/types.ts/contracts.ts/migrations）——发现契约缺口时在任务回报中上报，由父裁决。
- worktree 内先 `ln -s <主仓>/node_modules node_modules`，跑 `npx vitest run <本泳道测试>` 验证。
- 完成后 `git add -A && git commit`，报告：文件清单、测试结果、契约疑点、未尽事项。
