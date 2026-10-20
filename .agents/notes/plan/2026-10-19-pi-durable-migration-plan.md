---
title: 从 pi-coding-agent 迁移到 pi-durable 的实施计划
date: 2026-10-19
status: active
owner: 待指派
tags: [plan, pi-sdk, migration, delivery-semantics]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/tech/2026-10-13-pi-1.1.0-probe-findings.md
  - notes/tech/2026-10-13-mesh-llm-config-design.md
---

## 目标

把 mesh 的执行体从 `@earendil-works/pi-coding-agent`（AgentSession + JSONL session 文件）换成
`@earendil-works/pi-durable`（Harness + Conversation + 事务化 storage），并借此退役一批为补偿
coding-agent 缺陷而存在的机制。

完成标准（可验证）：

1. `src/pi/` 不再 import `@earendil-works/pi-coding-agent`；`src/core/` 仍零执行体依赖（门禁 G1/G2 通过）。
2. 投递语义以 durable 的 submission 记录为权威，按 submission 类型分两套判据（§9 F-A）：
   `input` 型 `delivered` ← `placed`、`consumed` ← `done`；`write` 型没有 `placed` 态，`delivered` ← `done`，
   `consumed` ← 之后第一个正常结束的 generation。`unanswered{reason}` 按「是否带 `entry`」分流：带 → 已进转录，
   记 `consumed(partial)`；不带 → 换新 `requestId` 重投。entry 差分镜像、`handoffTimeoutMs` 回退、
   `beforeClearQueue`（I22）三套补偿机制全部删除且测试覆盖其退役后的等价行为。
3. 新契约测试 CT-D1–CT-D11（步骤 2）在真 durable + pi-ai faux provider 上全绿，不接触真实 LLM。
4. 全量测试、`check:imports`、`typecheck`、`typecheck:demo`、`build`、demo 冒烟在 **Node ≥ 24** 环境通过；
   `snapshots/` 基线与 `contract-freeze` 冻结表按有意变更重签。
5. `package.json` 的 `engines.node` 与 `scripts/test.mjs` 的版本守卫同步抬到 `>=24.0.0`。
6. 规范升到 1.0.3：§2 平台基线换成 durable **与 Node 24 运行基线**，§7 投递、§8 端口契约按新语义重写，
   F1–F5 归档为「coding-agent 时代的负面知识」而不是当前约束。

## 范围

包含：

- `src/pi/**` 重写（stream-port、session-factory、llm-config、lock 的适配面）。
- `src/core/` 中 StreamPort 契约、mailbox 的 delivered/consumed 判据与恢复路径（第二阶段才动）。
- 端点标识（`piSessionId`）与 Observer 流读取面的公共 API 变更，含 `migrations/005_*.sql` 与快照重签。
- `tests/pi/**` 重写，`tests/helpers/pi-session.ts` 重写，`tests/e2e/**` 中依赖 pi session 文件的用例调整。
- `demo/` 后端 rpc 与前端受影响 Tab。
- `scripts/check-imports.mjs` 的包名与禁用 API 词表。
- 规范 1.0.3 修订 + changelog（破坏性变更）。

不包含：

- mesh 自己的消息库（`mesh_messages` / `mesh_deliveries` / 共享空间 / fts5）换存储驱动或与 durable 合并
  文件。主路径上继续用 better-sqlite3 + 独立 db 文件（MD2）；`node:sqlite` 替换本次不做（MD10）。
- 核心数据模型与对外 API 的功能扩张。本次是「换执行体 + 做减法」，不顺带加能力。
- durable 的 task / task-graph / codemode / 子 agent / usage 等新原语的对外暴露。值得做，见
  「可选后续扩展」，但都属于本计划之后的独立项目。

## 调研结论

调研基于上游 `packages/durable`（版本 1.3.0，源码 + README + 类型）与本仓现有实现对读。**所有 API 结论
来自读码，尚未运行验证**；步骤 2 的契约测试（M1）负责把它们变成实测结论。依赖可用性已确认：`@earendil-works/pi-durable@1.3.0`
及其 `chord` / `pi-ai` / `pi-codemode` / `pi-telemetry` 依赖在当前 npm registry 上都能取到。

### 0. 运行基线定在 Node 24

本次按 **Node ≥ 24** 设计（现行 LTS 线已到 24.22.x），不再迁就 22.19。三点直接影响：

- `node:sqlite` 在 Node 24 无需任何 flag 即可用，且就是 durable 存储的真实驱动：chord 的
  `sqlite/node.ts` 用的是 `node:sqlite` 的 **`DatabaseSync`**（同步 API），外面只套了一层串行队列
  来兑现 durable 要求的 promise 门面。**mesh 自己的同步 `Store.tx` 契约与这个驱动是同构的**，这改变了
  MD2 的取舍（见下）。
- `require(esm)` 在 Node 24 是常规能力，durable 的 ESM-only 发布不再构成 CJS 消费者的硬阻塞（R3 降级），
  但仍要用冒烟实测，不靠推断。
- Node 24 默认开启类型剥离，`node demo/src/server.ts` 这类现有写法不再依赖实验 flag，demo 与 scripts 的
  工具链可以少一层包装。

代价：`engines` 抬到 `>=24.0.0` 是对使用方的破坏性约束，要与 `resources` 废弃、`runtimeRef` 改名一起
写进 changelog 的同一条破坏性变更里。

### 1. durable 把 F1–F5 五个坑逐条消掉了

F1–F5（规范 §2.3）是 coding-agent 的实测缺陷，mesh 为它们各建了一套补偿机制。durable 上对应事实如下：

| 编号 | coding-agent 的问题 | durable 的对应事实 | mesh 可退役的补偿 |
| --- | --- | --- | --- |
| F1 | `deliverAs:"nextTurn"` 投出去永不进上下文 | 只有 `whenBusy: "steer" \| "followUp" \| "reject"`，外加 `type:"write"`；排队项全部落在可读文档 `pi.inbox` | 三档映射保留，但「第四档陷阱」不存在，档位矩阵的告警注释可以删 |
| F2 | `agent_settled` 无载荷，无法归因 consumed | 每条 submission 有独立生命周期：`queued → placed → done / unanswered{reason}`，按 `requestId` 可幂等重取 | `onEntry`+`onTurnEnd` 配对归因、`agent_settled.aborted` 判 partial 的整套逻辑 |
| F3 | 队列深度对库消息恒为 0，`clearQueue()` 还会销毁未落盘消息 | 队列就是 `pi.inbox` 文档，提交后可观测；没有 clearQueue 这类 API（已 grep 确认 durable 源码无 `clearQueue`/`sendUserMessage`/`forkFrom`/`.prompt(`）；撤回走 `submission.abort()` | 自持 inFlight 计数可简化为读 inbox；**I22 协议整体退役** |
| F4 | 条目无 seq、无游标、无查询 API | `conversation.entries(query, limit, cursor)` 有真游标与 `EntryQuery`；`conversation.fork(at)` 是真分叉 | `hasEntries` 逐条问；Observer.forkAt 的「fork 语义不对」免责声明 |
| F5 | `sendCustomMessage` 返回 ≠ 落盘 | `submit()` 在一次提交内准入；空闲路径直接返回 `status:"placed"` + entryId（已读 `admitSubmission` 确认），忙路径返回 `queued` 且排队项在文档里 | `handoff_at` + `handoffTimeoutMs` 超时回退重投 |

结论：这次迁移的主要收益不是新功能，而是**删掉约三分之一的投递期补偿代码，并把静默丢消息的风险面
换成可读的持久状态**。

### 2. 三档投递与 P1/P2/P3 的精确映射

读 `harness/inbox.ts` 的 `isDisplayOnly()` 与 `admitSubmission()` 得到的映射（这是本计划最关键的一张表）：

映射的主键是 `deliver()` 的 **`triggerTurn`（即 §7.3 的 `woke` 判定）**，档位只是次键。原表只按档位映射，漏了
这一维：durable 的 `type:"input"` 在空闲时**一定起轮**，没有「进上下文但不起轮的 input」（§9 F-C）。

| mesh 语义 | durable 调用 | 准入后的状态 |
| --- | --- | --- |
| P1 `steer`，`woke=true` | `submit({type:"input", content, entry:{kind:"mesh.msg",data}, whenBusy:"steer", requestId})` | 空闲 → `placed` 并起轮；忙 → `queued`，下一个 tool 轮边界落位 |
| P1 `followUp`，`woke=true` | 同上，`whenBusy:"followUp"` | 空闲 → `placed`；忙 → `queued`，本轮应答后落位 |
| P1 任意档，`woke=false`（含 `silent`、catch-up 固化 `mailbox.ts:1039`、忙流降档 `mailbox.ts:575`） | `submit({type:"write", entry:{kind:"mesh.msg", data, model:[{role:"user",content}]}, requestId})` | 空闲 → 当场追加 `done`、不起轮；忙 → `queued`，**下一个边界**落位。语义差：原 `followUp`+不唤醒在忙流上等本轮结束才落盘，这里会提前到下一个 tool 轮边界，需写进规范 |
| P2 收件箱注入 | `hook(GenerationTask, { beforeRequest })`，把注入体追加到该次请求的 messages 尾部；确认在同一钩子内经 `onInjectionConfirmed` 同步写进 **mesh 自己的账本**（OQ1 / R12） | 不新增转录条目、不碰 provider 缓存。`api.memo()` 只用来对同一 generation 的重试去重，**不是**持久确认：generation 一旦 `completing`/`terminal`，`memos` 就被清掉（§9 F-B） |
| P3 note（记账不进上下文） | `submit({type:"write", entry:{kind:"mesh.note", data}})`（display-only：无 `model`/`head`/`edits`） | 当场追加 `done`，永不排队，模型看不到 |
| 宿主 nudge | `submit({type:"input", content:cue, whenBusy:"steer"})`，不记 mesh 账 | 同 P1 steer，但不产生 delivery 行 |

要点：`silent` 与 `note` 在 coding-agent 上都是「appendCustomEntry 类」的模糊地带，在 durable 上由
`isDisplayOnly()` 一刀切开，语义反而更清楚。

`requestId` 原生幂等（同键返回原 submission，跨重启有效），但有两个必须照顾的细节（§9 F-A、F-D）：

- `admitSubmission` 对同键**无论原记录是什么状态都原样返回**，包括 `unanswered`。所以投递的 `requestId`
  必须是 `<deliveryId>:<attempt>`，重投先在 mesh 侧持久化 `attempt+1` 再提交；拿 envelope id 当键会让重投
  变成空操作。
- 同一个键也是跨库双写的恢复手段：先在 mesh 库落 `attempt`，再 `submit()`，再回写 `submission_id`。崩溃
  落在后两步之间时，恢复路径用同一 `requestId` 再 `submit()` 一次——已准入就拿回原记录，未准入就补交。

### 3. 能力缺口（必须显式处理，不能静默）

durable 不是 coding-agent 的超集。缺口如下：

| 现有能力 | durable 侧 | 处理方式 |
| --- | --- | --- |
| `DefaultResourceLoader`：skills / promptTemplates / themes / contextFiles / 第三方 extensions | 无对等物 | `RuntimeConfig.resources` 废弃。置 `true` 时抛配置错误，不默默无效。破坏性变更进 changelog |
| MCP 工具桥接 | 无内置 | 宿主自己用 `defineTool({callers:["tools"]})` 桥，mesh 不接管 |
| 内建工具白名单（`tools: [...builtinTools, ...customToolNames]` 配方，L5） | `/tools` 提供 read/write/edit/bash；选择走 `configure({tools, modelTools})` | 白名单配方整段删除，换成 extension 选择 + `modelTools` |
| `ModelRuntime` + 内存凭据库隔离（LD2/LD4） | `createModels({credentials, modelsStore})` + `createProvider({id, baseUrl, headers, auth, api, models})` | `llm-config.ts` 重写。durable 本身不读任何配置文件，隔离论证反而更短 |
| 模型随宿主配置走（`createAssembledSessionFactory` 每次建 session 都用当前 `llm`） | durable **没有宿主级缺省模型**：模型只存在每个 conversation 的 `pi.agent` 文档里，`root(ctx,{agent})` 只在首次创建时生效；未配置即 `failNoModel`（`generation.ts:139`） | 每次 `warm` 都对 root 调一次 `configure({model, thinkingLevel})`，否则改了 mesh 的 llm 配置对已有端点不生效（§9 F-G） |
| 压缩 / retry / 超时设置经 `SettingsManager` | `settings.{retry, compaction, stream, progress}`，且 compaction 支持 `modelOverrides` | 直接映射，能力略有增强 |

### 4. 关键设计决策（已定）

`MD*` 与 `OQ*` 是本计划内的临时编号（避免与归档计划里的 `D1–D6` 混淆）；收口时按规范的 `Q*` 体系落号。
**本节与 §4.1 的全部条目都已定案，开工前没有悬空项**；保留被否决的选项及其代价，便于日后复查「当时为什么
这么选」。

| 编号 | 决策 | 结论 | 理由 |
| --- | --- | --- | --- |
| MD1 | Harness 拓扑 | **每端点一个 Harness + 一个 storage 文件** | durable 明说「一个 storage 同时只由一个进程持有，自身无跨进程锁」。每端点一个 storage，与现有 per-endpoint 单写者锁（M3、§8.3 的 warm/evict/lease）一一对应，端点仍可独立冷热。单 Harness 多 conversation 会把单写者粒度抬到整个 mesh，并让 `abort`/`waitForIdle` 在端点间互相牵连 |
| MD2 | 存储边界 | **两个独立文件：mesh 库一个、durable 每端点一个**。驱动不统一，见 MD10 | 即使驱动相同，两个连接各自的事务管理器压同一文件仍会互相 BUSY/回滚，durable 也明说直连调用会绕过它的队列并可能被回滚。合并文件的收益（单文件备份）远小于风险，而且它不是迁移的前置条件——可以迁完再单独评估 |
| MD3 | 投递记账 | delivery 行加 `submission_id` 与 `attempt`，状态变成 durable submission 的投影；推进靠 watch、对账靠 sweep（OQ5）。跨库写序固定为「mesh 落 attempt → submit(`<deliveryId>:<attempt>`) → 回写 submission_id」，判据按 submission 类型分（§9 F-A） | `placed`/`done`/`unanswered{reason}` 是持久权威，恢复时按 id 精确读一条，取代「逐条问 entry 是否还在」。两个库之间没有原子提交，确定性 `requestId` 是唯一能让崩溃窗口自愈的东西 |
| MD4 | P2 注入 | **`hook(GenerationTask, { beforeRequest })` 注入；确认在钩子内经 `onInjectionConfirmed` 同步写 mesh 账本**。详见 OQ1 与 R12 | 与现有实现同位置、同语义，不写转录条目也不碰缓存；确认的持久性来自 mesh 自己的库，而不是 durable 的 memo（§9 F-B）。`extensionRunner` 私有数组 push 与 `context_with_system` 观测器一并退役。I23 **缩小但不退役**：`hooks.each` 按扩展顺序串行，后面的扩展可以替换掉 mesh 追加的消息（§9 F-H） |
| MD5 | 工具身份 | 闭包绑定**保持不变**，不做 conversationId 二次校验 | MD1 给了每端点独立 Harness，也就有独立 registry，所以现有的「每端点构建一套绑定身份的工具」原样可用，M6 不需要改。原写的「`api.conversationId` 二次校验」是空转：每端点只用 root，`ROOT_CONVERSATION_ID` 恒为 `1`，校验永远通过。只有在单 Harness 多 conversation 的拓扑下才需要反查 |
| MD6 | 历史会话 | 不平移。端点重建 conversation，mesh 自己的 `mesh_messages` 仍是跨端点真相 | JSONL session 与 durable 的 entry/doc/submission 模型不同构，写导入器的成本与收益不成比例。需要考古时旧 JSONL 文件原地留存 |
| MD7 | 端点标识 | `piSessionId` 换成 `{storagePath, conversationId}` 的不透明串，字段改名为 **`runtimeRef`** | 继续叫 `piSessionId` 会让「路径」与「conversation id」两件事挤在一个字段里，Observer 的流读取面也会继续按 session 文件取数。改名是破坏性的，但比语义漂移便宜 |
| MD8 | durable 失败通道 | `onReport` / `harness.closed` / parked 任务接进 mesh 的端点状态机与 park 原因 | 见下一节。不接的话 durable 的失败会表现成「端点一直 hot 但不动」 |
| MD9 | `mesh_stream_entries` 镜像表 | 保留 | durable 虽然给了游标，但读另一端点的 storage 要开它的 SQLite 文件（单写者约束）。规范 §11 的「跨流联查 + 脱离执行体进程读取」两条理由仍然成立；只有「无 seq 无游标」这条理由失效 |
| MD10 | 是否用 `node:sqlite` 换掉 better-sqlite3 | **已定：不换。** 保留 better-sqlite3，`node:sqlite` 只作为 durable 的内部驱动存在。方向上 `node:sqlite` 更好（见 §8 的逐条核实），但不要和换执行体并线：mesh 自己的库是权威账本，不能和投递状态机改造共担同一次风险 | 核实已完成，不再需要可行性探针；剩下的是 §8 列的 4 个适配点 + 性能复测。better-sqlite3 `engines: >=22`，Node 24 上可用（`snapshots/bench-baseline.json` 的指纹就是 node 24.19.0） |

MD6、MD7 与 Node 24 基线一样对使用方可见，三者合并成一条破坏性变更公告（见 OQ4）。

### 4.1 其余决策（已定，含被否决的选项）

| 编号 | 问题 | 结论 | 否决了什么、代价是什么 |
| --- | --- | --- | --- |
| OQ1 | P2 注入走 `beforeRequest` 还是 `section()` | **`beforeRequest` 注入 + mesh 账本落确认**。注入体追加在消息尾部、只作用于单次请求；确认在同一钩子内经 `onInjectionConfirmed` 同步写进 mesh 账本；`api.memo("mesh.p2.w<watermark>", …)` 只用于同一 generation 内多次请求尝试（provider 重试、恢复）的去重 | 否决 `section()`：它落成位置性 `pi.system` 条目，但注入体位于系统提示位置，而 mesh 的收件箱摘要天生多变（未读数一直在动）⇒ 每次变化都新增条目并击穿 provider prompt cache，durable README 明确把「每次返回不同内容的 section」列为反例。确认写 mesh 账本之后，`section()` 唯一的优势（可持久核对）也不再是优势，见 R12 |
| OQ2 | `pi.inbox` 允许多深 | **按模式各封顶 1**：steer 类（`input` steer、忙时排队的 `write`）一个槽，followUp 类一个槽（§9 F-E）。只对「影响模型上下文」的 submission 计额度，宿主 `nudge` 也占槽（display-only 的 P3 note 由 durable 当场追加、永不排队，不占额度）。积压留在 mesh，用既有折叠机制合成一条投递；`pi.inbox` 深度成为新的 inFlight 信号（F3 自持计数的替代） | 否决「全量提交」：那样 durable 持有积压，mesh 账上只剩「已交出」，§7.4 原文预算、溢出折叠、mute/游标在「入队到落位」之间的重算权全部失效，且 `conversation.abort()` 会把它们整批 `unanswered{aborted}` 需要批量回收。**吞吐几乎不是代价**：durable 的 `steeringMode`/`followUpMode` 缺省就是 `one-at-a-time`，每个边界本来只落位一条，堆深度并不会落得更快，见 R13 |
| OQ3 | 一次性切换，还是两套后端并存 | **一次性切**。`StreamPort` 只留 durable 实现 | 否决并存：接缝本来就是为换后端留的，但并存意味着 handoff 超时、entry 差分镜像、I22 协议全得留着——减法做不成，测试矩阵翻倍，而减法正是本次的主要收益。**代价**：仍在 Node 22 / coding-agent 上的使用方停在旧版本线 |
| OQ4 | 版本号与发布策略 | **`0.2.0`**，四条破坏性变更（`engines>=24`、`resources` 废弃、`runtimeRef` 改名、历史不平移）合并成一条公告；**不开 `0.1.x` 维护分支** | 否决 `1.0.0`（durable 自身是 Experimental，不宜在它上面宣称 1.0）与维护分支（没有已知外部使用方；出现了再补） |
| OQ5 | 投递确认靠 watch 还是 sweep | **watch 作主、sweep 兜底**：每端点挂 `watch()` 推进状态，sweep 仍按 submission id 对账 | 否决「只靠 sweep」（确认延迟到下一周期）与「只靠 watch」（漏事件或崩溃后无自愈）。**代价**：每端点一条订阅与内存视图 |
| OQ6 | demo 是否切 `watchEvents()` | **本次不切**，只做兼容性修复 | 否决顺带重构 demo：改动面大、5-Tab 冒烟口径要重订，与迁移风险耦合。留作迁移稳定后的单独一轮（见「可选后续扩展」） |
| OQ7 | `mesh_stream_entries` 存什么序号 | 存 durable 的 **EntryId + 游标**；`seq_in_stream` 保留为镜像内单调序；**主键改成 `(runtime_ref, entry_id)`**（§9 F-F） | 否决「只存 EntryId」：既有按 `seq_in_stream` 的查询会全部改写。保留两者的代价是一列冗余。durable 的 EntryId 是每个 storage 内自增的整数，每端点一个 storage（MD1）意味着不同端点必然出现相同 id，现在的 `entry_id TEXT PRIMARY KEY` 会撞键 |
| OQ8 | 每端点一个 Harness 的开销 | **按 MD1 做**，在 M2 用现有 bench（`vitest.bench.config.ts`）量一次 30 端点场景，超预期再谈端点分组 | 不预先优化。可调旋钮是 `contextRetentionMs` / `documentRetentionMs` |

### 5. durable 的失败通道怎么接（MD8）

这是 coding-agent 上不存在、因此现有实现里没有对应物的一面。不接会变成静默卡死：

| durable 信号 | 含义 | mesh 侧动作 |
| --- | --- | --- |
| `onReport(err, {type:"session_failed"})` + `harness.closed` | storage 错误使 Harness 自行关闭 | 端点转 `unavailable`，该端点在途投递回退 `queued`，发 `endpoint_state_changed`；下次 warm 重开 storage |
| `onReport(..., {type:"task_faulted"})` | 某个任务（含 generation / tool）抛错终结 | 记 counter + 事件；是否 park 该端点投递按任务种类判断，不一刀切 |
| `onReport(..., {type:"task_parked"})`（达到 `restartLimit`，默认 5） | 任务反复被崩溃打断，已被停挂 | 端点降级告警；暴露 `harness.retryTask(id)` 给宿主，不要自动无限重试 |
| `onReport(..., {type:"extension_error"})` | mesh 自己的 section / tool / hook 抛错 | 这是 mesh 的 bug 通道，直接计数告警 |
| submission `unanswered{reason}` | `aborted` / `run_failed` / `stale` / `model_error` | **先看有没有 `entry`，再看 reason**（§9 F-A）。带 `entry` = 已经进了转录（`endRun` 会把整个 run 的 `inputs`，包括中途落位的 steer，一并结算成同一结果）⇒ 记 `consumed(partial)`，**不得重投**，否则消息重复。不带 `entry` = 在 `pi.inbox` 里被撤回或判 stale ⇒ `attempt+1`、换新 `requestId` 重投；`run_failed`/`model_error` 走退避，连续 N 次 `parked` |
| `settings.afterFailedRun` | run 失败后排队项的处置（`continue` / `withdraw`） | 取 **`continue`**，与 mesh「未读不丢」的既有承诺一致。OQ2 封顶 1 之后这里最多影响一条 |

### 6. 破坏面与冻结物清单

这几处是「改了就会红」的守卫，必须作为有意变更显式重签，不能在实现里绕过：

- `snapshots/api-surface.json`（`tests/e2e/api-snapshot.test.ts` + `scripts/gen-snapshots.mjs --check`）：
  公共导出枚举。改 `piSessionId`（MD7）、换掉 `PiStreamPort` / `createPiSessionFactory` /
  `createAssembledSessionFactory` 的导出名都会漂移。
- `snapshots/migrations/000_init.sha256`：DDL 只读。`submission_id` 列必须走新文件
  `migrations/005_submission_id.sql`，**不得**改 `000_init.sql`。
- `tests/core/contract-freeze.test.ts`：冻结 `mesh_deliveries.state` 的 8 态值域与 §7.9 转换表。
  删 handoff 回退、改 delivered/consumed 判据都会动这张表，要同步更新冻结表并在提交里说明。
- 公共类型里 `piSessionId` 出现 6 处（`Endpoint`、`RegisterEndpointInput`、`SessionFactory` 的
  create/open、`Observer.streamEntries`、`StreamEntry`），牵连 `mesh_stream_entries.pi_session_id` 列名。
- `Observer` 的 `streamEntries` / `replay` / `forkAt` 三个方法语义都变（`forkAt` 从「免责声明」变成真分叉）。

### 7. 测试基础设施

- faux provider 来自 `@earendil-works/pi-ai` 的公开导出 `fauxProvider`（durable 自己的测试就这么用），
  所以「真 SDK + 假 provider、不碰真实 LLM」的既有原则可以原样保留。`pi-ai` 需从 devDependency 升为
  直接依赖。
- `tests/helpers/pi-session.ts` 整体重写为 durable harness 夹具（参考上游 `test/chat-support.ts` 的
  `createModels` + `fauxProvider` + `createRegistry` + `Harness.open` 组合）。
- `vitest.config.ts` 里的 `TERMUX_VERSION=1` 是为规避 coding-agent 的 clipboard 原生模块在 import 期
  dlopen 挂死；durable 没有这个依赖（只有按需加载的 photon wasm）。迁移后应复核是否还需要，但
  **先不要删**——确认 durable 路径不触发原生模块后再单独一提交移除。
- durable 另有 `@earendil-works/pi-durable/testing` 的 storage / env 一致性套件。本次不自研 Storage 或
  ExecutionEnv，用不上；若将来自研则直接接它。

### 8. better-sqlite3 与 `node:sqlite` 在 Node 24 下的核实结果（MD10 依据）

核实方式：读 Node v24.x 分支的 `deps/sqlite/sqlite.gyp`、`doc/api/sqlite.md`、`src/node_sqlite.cc`。

原先担心的阻塞项全部解除：

- **FTS5 可用**。Node 24 内置 SQLite 3.53.4，编译开关含 `SQLITE_ENABLE_FTS5`（另有 FTS3/RTREE/
  MATH_FUNCTIONS/SESSION/PREUPDATE_HOOK/DBSTAT/COLUMN_METADATA）。trigram tokenizer 与 contentless
  表是 FTS5 自带能力，不需要额外开关。
- **同步 API**。`DatabaseSync` 是同步的，所以 `Store.tx` 的同步 IMMEDIATE 契约一行不用改。
- **`BEGIN IMMEDIATE` 手写事务照旧**，而且多了 `database.isTransaction`，比现在自己记嵌套标志更直接。

需要改的是 4 个点，都在 `src/core/store.ts` 与 `router.ts`：

| # | 适配点 | 现状 | `node:sqlite` 写法 |
| --- | --- | --- | --- |
| 1 | `db.pragma(...)`（7 处） | better-sqlite3 的便捷方法 | 无此方法。写用 `exec("PRAGMA ...")`，读用 `prepare("PRAGMA ...").get()`。`foreign_keys` 与 `busy_timeout` 可直接用构造选项 `enableForeignKeyConstraints` / `timeout` |
| 2 | `db.name`（`store.ts:129` 派生库路径） | 构造时的路径名 | `database.location()` |
| 3 | UNIQUE 冲突判定（`router.ts:892`，仅 `mesh_messages.idempotency_key`） | `err.code === "SQLITE_CONSTRAINT_UNIQUE"` 字符串 | 错误对象带 `errcode`（数值扩展码）与 `errstr`，`code` 恒为 `ERR_SQLITE_ERROR`；`sqlite.constants` 只导出 changeset 冲突常量，**不含**结果码。得在 mesh 侧自己定义 `SQLITE_CONSTRAINT_UNIQUE = 2067` 具名常量 |
| 4 | `import type Database from "better-sqlite3"`（core 6 个文件 + `Store.db`） | better-sqlite3 类型 | `DatabaseSync` 类型。`Store` 不从包根导出，所以不碰 `api-surface.json` |

接受两条新耦合，这是选 `node:sqlite` 的真实代价：

- **稳定级是 RC（`Stability: 1.2 - Release candidate`，v24.15.0 从 experimental 升上来）**，不是 Stable。
- **SQLite 版本跟着 Node 走**，不能独立升降。mesh 有 fts5 行为测试与 DDL 哈希快照，Node 升级带着
  SQLite 一起变时，FTS/BM25 行为可能在脚下变化——这正好是 `fts-matrix.test.ts` 要守的东西，但得知道
  它现在也在守 Node 版本。

整数读取两边都是「默认 `number`、超出安全范围报错」，mesh 的 seq 规模用不到 BigInt，无差异。

**结论（MD10）：不换。** 技术上可行且方向更优，但 mesh 自己的库是权威账本，不与投递状态机改造共担
一次风险；better-sqlite3 在 Node 24 上可用，没有强制替换的理由。本节留作将来重新评估时的依据，不要
当作待办。

### 9. 复查发现（2026-10-20）

对照 durable 源码复查本计划时发现的漏洞。修正已经写回上文对应位置，这里记录证据，便于以后复查。

| 编号 | 漏洞 | 证据 | 修正位置 |
| --- | --- | --- | --- |
| F-A | 「`delivered`←`placed`、`consumed`←`done`」只对 `input` 成立。`write` 没有 `placed`，`done` 只表示「已追加」。另外 `endRun` 用同一结果结算整个 run 的 `inputs`，中途落位的 steer 也会在 run 失败时变成 `unanswered`，但它已经在转录里，按原 §5「`aborted` → 重投」会重复投递 | `harness/live.ts:138-141` `endRun`；`generation.ts:731` 中途落位的 input 追加进 `run.inputs`；`types.ts` 中 `unanswered` 的 `entry?` 可选 | 完成标准 2、§5、MD3 |
| F-B | `api.memo()` 不是持久确认，R12 的「已解决」不成立 | `types.ts:690-703`：memos「retained while the task can run」，`completing`/`terminal` 时为 `never` | §2、MD4、OQ1、R12、CT-D7 |
| F-C | 映射表漏了 `triggerTurn`（`woke`）这一维。durable 的 input 空闲时必起轮，catch-up 固化（`followUp` + 不唤醒）与忙流降档都会被错映射成起轮 | `admitSubmission`：空闲 input 直接 `startRun`；`src/core/mailbox.ts:575, 623, 1039, 1304` | §2 映射表 |
| F-D | 用 envelope id 当 `requestId` 会让重投失效；mesh 工具缺省 `replay:"unsafe"`，执行中崩溃会让模型收到 `interrupted`，换新 `callId` 再调一次 ⇒ 重复发送 | `admitSubmission` 对同键直接返回原记录（含 `unanswered`）；`harness/tool.ts:173` `tool.replay ?? "unsafe"` | §2 要点、步骤 3、CT-D9/D11 |
| F-E | `pi.inbox` 全局封顶 1 会造成优先级反转：一条排队的 followUp 要等 run 结束才落位，期间占住唯一槽位，后来的 steer 无法提交、失去「插进当前 run」的语义 | `applyBoundary`：followUp 只在 `final` 边界被挑选 | OQ2 |
| F-F | `mesh_stream_entries.entry_id TEXT PRIMARY KEY` 会撞键。coding-agent 的 entry id 是全局唯一字符串；durable 的 EntryId 是每个 storage 内自增的整数，每端点一个 storage 必然重号 | `types.ts:21` `Id<…> = number & …`；`migrations/000_init.sql:230` | OQ7、步骤 5 |
| F-G | durable 没有宿主级缺省模型，模型只在 conversation 创建时写进 `pi.agent`。不在每次 warm 时 `configure()`，改了 mesh 的 llm 配置对已有端点不生效 | `generation.ts:139` 无模型即 `failNoModel`；`HarnessSettings` 无 model 字段 | §3、步骤 4 |
| F-H | I23 不能整体退役。`beforeRequest` 按扩展顺序串行，后面的钩子可以替换掉 mesh 追加的消息 | `generation.ts:222-225` `hooks.each` 依次覆盖 `messages` | MD4、步骤 3、步骤 10 |
| F-I | 关闭与驱逐。`harness.close()` 会打断运行中的任务（重开后续跑，不可重放的工具调用变成 `interrupted`），所以 evict 必须先等空闲；在 retry 退避里 sleep 的任务也算「不空闲」。不设 `onWake` 时，sleep 定时器会让 Node 进程保持存活，`createMesh` 的关闭路径若漏关某个 Harness，进程退不出去（C02） | README「Sleeping and Waking Up」「Errors」；`HarnessOptions.setTimer` 注释 | 步骤 3、步骤 4 |

复查中**确认成立**的原有结论：durable 源码无 `clearQueue`/`sendUserMessage`/`forkFrom`/`.prompt(`；
`steeringMode`/`followUpMode` 缺省 `one-at-a-time`（`harness/agent.ts:78-79`）；chord 的 Node 存储驱动是
`node:sqlite`（`packages/chord/src/sqlite/node.ts` 使用 `DatabaseSync`）；`snapshots/bench-baseline.json`
的指纹是 node 24.19.0。

## 步骤

分两大阶段。**阶段一（步骤 1–7）不动 `src/core/`**：StreamPort 十方法契约原样保留，用 durable 重新实现
它们，先把「能跑」做出来。**阶段二（步骤 8–10）才改 core**，把补偿机制删掉。这样任一阶段中断都能停在可交付状态，也便于对照两套
实现跑同一批 e2e。

| # | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| 1 | 前置：备好 Node 24 环境（建议钉当前 LTS 小版本）；`engines.node` 与 `scripts/test.mjs` 守卫抬到 `>=24.0.0`，CI/本地文档同步；`npm i @earendil-works/pi-durable@1.3.0 @earendil-works/pi-ai@1.3.0 @earendil-works/chord@1.3.0`（精确版本、不用 `^`，且必须与 durable 自己声明的版本逐一对齐——durable 对 pi-ai/chord 钉的就是 `1.3.0`，装出两份会让 `Models` / `Context` 类型不互认），`pi-ai` 与 `chord` 升为直接依赖 | 决策确认 | done |
| 2 | 探针与新契约测试 CT-D1–CT-D11（先写，红着开工）：①空闲 submit 当场 `placed` 且带 entryId ②忙时进 `pi.inbox` 且文档可读 ③同 `requestId` 返回原 submission（含重开 Harness 后）④display-only write 不进模型上下文、带 `model` 的 write 进上下文且不起轮 ⑤`beforeRequest` 钩子的注入体进入该次请求的 messages、位于尾部、且不新增任何条目 ⑥崩溃后重开 + `resume()` 继续未完成 run ⑦（CT-D7，锁住 §9 F-B 的事实）钩子里 `api.memo()` 同名重复写返回首次的值；generation 运行中 `getTask()` 能读到 `memos`，结束后读不到——这条若某天变绿成「结束后仍可读」，R12 的方案才可以简化 ⑧（CT-D8）`endRun` 结算：run 中途落位的 steer 在 run 失败/中止时随 run 一起变 `unanswered` 且**带 `entry`** ⑨（CT-D9）同 `requestId` 对 `unanswered` 记录再次 `submit()` 返回原记录、不新建 ⑩（CT-D10）带 `model` 的 write 在空闲 conversation 上不起轮、在忙 conversation 上下一个边界落位 ⑪（CT-D11）mesh 工具声明 `replay:"safe"` 后，执行中崩溃重开会以**同一 `callId`** 重跑 | 1 | done |
| 3 | `src/pi/durable-port.ts`：以 durable 实现 StreamPort 十方法。`warm`→开 storage+`Harness.open`+`resume()`；`deliver`→按档位 submit；`note`→display-only write；`injectContext`→装/卸 `beforeRequest` 钩子（mesh 扩展装在 registry 最后，确认经 `onInjectionConfirmed` 写 mesh 账本）；`status`→读 watch 维护的内存视图（`status()` 是同步方法，durable 的文档读取都是异步的，不能现读；深度按模式封顶 1，OQ2）；`deliver` 按 `triggerTurn` 分 input / write（§2）；`hasEntries`→`entries()` 查询；`onEntry`/`onTurnEnd`→每端点 `watch()` 适配（OQ5），状态从 `value` 推导而不是逐条重放 `ops`——watch 积压超过 100 帧会被合并成一帧全量视图；`evict`→先 `waitForIdle` 再 `harness.close()`（§9 F-I）；mesh 工具逐个审 `replay` 策略（§9 F-D）。chord `Context` 只在 `src/pi/` 内构造，绝不外泄到 core | 2 | todo |
| 4 | `session-factory.ts` 重写：产出 `{harness, conversationId}`；`llm-config.ts` 重写到 pi-ai `createModels`/`createProvider`；`RuntimeConfig.resources` 改为显式拒绝；每次 warm 对 root `configure({model, thinkingLevel})`（§9 F-G）；`lock.ts` 的锁对象从 session 文件改为 durable storage 文件，且锁必须先于 `Harness.open`；接入 MD8 的失败通道；`createMesh` 的关闭路径逐个 `harness.close()`（§9 F-I） | 2 | todo |
| 5 | 端点标识与 Observer 迁移（MD7/MD9）：`piSessionId` → `runtimeRef`；`migrations/005_*.sql`（`mesh_deliveries` 加 `submission_id`/`attempt`；`mesh_stream_entries` 主键改 `(runtime_ref, entry_id)`——SQLite 不能改主键，得建新表、拷数据、换名，旧行的 `pi_session_id` 原样迁入 `runtime_ref`；不动 000）；`streamEntries`/`replay`/`forkAt` 按 durable 语义重写，`forkAt` 落到 `conversation.fork()`；`snapshots/` 重签 | 3, 4 | todo |
| 6 | 测试基础设施与 demo：`tests/helpers/pi-session.ts` 重写（用了 fake timers 的用例要把 `setTimer`/`now` 传给 `Harness.open`，见 §7）；`tests/pi/**` 15 个文件重写；`tests/e2e` 中 `g02-baseline-reopen` / `disk-factory-reopen` / `two-process-*` / `dual-process-migrate-lock` 按新存储形态调整；demo rpc 与受影响 Tab 更新 | 3, 4, 5 | todo |
| 7 | 阶段一验收：`check:imports`（`PI_PACKAGES` 已含 durable/pi-ai/chord）、`typecheck`、`typecheck:demo`、全量测试、`build`、`demo:smoke` 全绿 | 6 | todo |
| 8 | 收缩 StreamPort 契约（动 core）：`deliver` 返回 `{submissionId, status}`；mailbox 的 delivered/consumed 改读 submission；`reconcileDelivered` 改为按 submission id 精确读 | 7 | todo |
| 9 | 删补偿机制并更新冻结表：`handoff_at`/`handoffTimeoutMs` 回退、entry 差分镜像、`beforeClearQueue`(I22)、`inFlightCount` 自持计数。每删一处先把对应测试改成断言新路径再删实现；同步更新 `contract-freeze` 的状态域与转换表 | 8 | todo |
| 10 | 规范 1.0.3 + changelog + 发 `0.2.0`（OQ4）：§2 平台基线（durable + Node 24）、§7 投递、§8 端口契约重写；F1–F5 移入附录「coding-agent 时代的负面知识」；I22 标注退役、I23 改写为「mesh 扩展必须排在最后」；MD1–MD10 与 OQ1–OQ8 落成 `Q*`；四条破坏性变更（`engines>=24`、`resources` 废弃、`runtimeRef` 改名、历史不平移）合并成一条公告 | 9 | todo |

## 里程碑

按交付物排序，不预设日期（决策已全部定案，只取决于开工时间）：

- **M1 探针成立**（步骤 2 完成）：CT-D1–CT-D11 在真 durable 上全绿。这是 go/no-go 闸门——任一条不成立，
  回到对应设计项重选，不绕过。
- **M2 阶段一可跑**（步骤 7 完成）：durable 后端在不动 core 的前提下通过全量门禁与 demo 冒烟。此时
  补偿代码仍在，只是不再被触发。
- **M3 减法完成**（步骤 9 完成）：补偿机制删除，投递状态机以 submission 为单一判据。
- **M4 文档收口**（步骤 10 完成）：规范 1.0.3 发布，破坏性变更登记完毕。

## 可选后续扩展（不在本次范围）

durable 白送了一批 mesh 现在没有的原语。登记在此，便于迁移后按价值排序，**不要**在本次迁移里夹带：

| 扩展 | 价值 | 备注 |
| --- | --- | --- |
| 事务化 task + task graph | mesh 的 sweep / 退避重投 / claim 租约回收可以从「定时器 + 自己记账」变成 durable 任务，崩溃可续 | 但 mesh 的记账在自己的库里，跨两套存储的任务要想清事务边界 |
| 子 agent 归属（`ownership:{kind:"task"}`） | mesh 现在只有「端点之间发消息」；durable 原生支持「agent 派生并拥有子 agent」，可做临时工作者 | 与 mesh 的账号/端点模型如何对齐需要设计 |
| `usage` 账（`pi.usage`） | 按账号/会话给出 token 与成本，mesh 目前完全没有 | 几乎零成本就能暴露 |
| `watchEvents()`（OQ6 推后的那一轮） | demo 的实时视图可以直接用 coding-agent 风格事件流，省掉自建观测管线 | demo 侧收益最大 |
| codemode + tool-search / deferred tools | 14 个 mesh 工具可以改成 deferred，不再长期占用上下文；脚本里批量调 mesh 工具 | 需要 QuickJS sandbox 依赖 |
| compaction hooks（`beforeCompact`） | 压缩时保住收件箱摘要与未读游标，解决「压缩后 agent 忘了还有未读」 | 现有实现没有这条保障 |
| ~~`node:sqlite` 换掉 better-sqlite3~~ | 去掉全仓唯一的原生依赖，与 durable 共用同一个 SQLite 驱动与版本 | **已决定不做（MD10）**。可行性与适配点记在 §8，将来若要重评直接看那节 |
| Cloudflare Durable Object 拓扑（`onWake`） | mesh 可以跑在无常驻进程的环境，`StreamTopology` 增一档 | 前置是 mesh 自己的库不再依赖 Node 原生驱动（MD10 之后才谈） |

## 风险与阻塞

| 项 | 影响 | 应对 / 待谁解决 |
| --- | --- | --- |
| R1 durable 自述 "Experimental. The API changes without notice between releases." | 小版本升级即可能破坏实现 | 依赖钉死精确版本 `1.3.0`；CT-D1–CT-D11 作为升级第一道闸（延续 F1–F5 契约测试的做法：测试职责不是验证库对，而是在上游变了的那一刻立刻红） |
| R2 本计划的 API 结论全部来自读码 | 某条结论与运行时行为不符时，依赖它的设计项会整体失效 | M1 是 go/no-go 闸门：CT-D1–CT-D11 在 Node 24 + 真 durable 上全绿之前不进入步骤 3；任一条红，回到对应设计项重选 |
| R3 durable 是 ESM-only（exports 无 `require` 条件） | mesh 发 CJS 产物，CJS 消费者加载 pi 层可能失败 | Node 24 的 `require(esm)` 让这条基本不成立（前提是依赖图里没有顶层 await），风险降为「需实测确认」：保持 `loadPiSdk()` 式动态 `import()` 惰性加载，并在 `verify:package` 冒烟里加一条 CJS 消费者实际触达 pi 层的用例 |
| R11 `engines` 抬到 `>=24` | 仍在 Node 22 上的使用方无法升级 | 与 MD6/MD7 合并成一条破坏性变更公告（OQ4，发 `0.2.0`）；不开维护分支，这类使用方停在旧版本线 |
| R12 P2 注入确认的持久性 | 若确认只存在内存里，崩溃窗口内「注入体是否进了那次请求」事后不可核对，表现为静默丢未读 | **方案已改（2026-10-20 复查）**。原方案靠 `api.memo()` 把确认存在 generation 任务上、重启后 `getTask()` 读回——**不成立**：`TaskRecord.memos` 只在任务可运行时保留，`completing`/`terminal` 时类型就是 `never`。generation 正常结束后 memo 随之消失，而崩溃后最需要核对的恰恰是这种已结束的 generation。现方案：`beforeRequest` 钩子里同步调用 `onInjectionConfirmed`，由 mailbox 在 mesh 库里落确认（better-sqlite3 同步事务，钩子返回前即持久）。memo 只留作同一 generation 多次请求尝试的去重。判据强度与 coding-agent 时代相同：证明的是「进了已准备好的请求」，consumed 仍由 generation 正常结束推进。CT-D7 改为锁住「结束后 memo 不可读」这一事实 |
| R13 `pi.inbox` 按模式封顶 1 的吞吐代价 | 高频投递下端点吞吐与 steer 即时性下降 | **基本不成立**：durable 的 `steeringMode`/`followUpMode` 缺省是 `one-at-a-time`，每个边界只落位一条，所以把积压堆进 `pi.inbox` 不会让它落得更快，只是换个地方存。另两条让它进一步收敛：display-only 的 P3 note 当场追加、不占额度；突发流量用 mesh 既有的折叠合成一条投递，比 `steeringMode:"all"` + 深度 N 更好（后者会让 mesh 失去逐条预算控制）。**残留**：相邻两次落位之间多一个 watch 回调 + 一次提交的往返（毫秒级），相对边界本身的秒级节奏可忽略。M2 用 bench 量 30 端点场景复核 |
| R14 跨库双写没有原子提交（mesh 库 ↔ 端点 storage） | 崩溃落在「durable 已准入」与「mesh 回写 submission_id」之间，delivery 行看起来从没交出去 | 固定写序 + 确定性 `requestId`（MD3）：恢复路径用同一键再 `submit()`，已准入就拿回原记录、未准入就补交。`crash-property.test.ts` 加一个在两步之间注入崩溃的用例 |
| R15 依赖体积 | durable 根入口会加载 TypeBox（README：未打包约 23 MB 峰值 RSS），且 `pi-codemode`（QuickJS）与 `@silvia-odwyer/photon`（wasm）是硬依赖，即使不用也会装 | 移除 coding-agent 后总量未必变大，但要在步骤 7 用 `npm pack` 体积与安装体积各量一次，写进 changelog；保持 `loadPiSdk()` 惰性加载，core-only 使用者不受影响 |
| R4 历史会话不可平移（MD6） | 升级后端点失去可见历史上下文 | 旧 JSONL 原地保留供考古；升级说明写清「端点 conversation 重建」；必要时宿主自己用 display-only write 回灌摘要 |
| R5 能力缺口（skills/prompts/contextFiles/MCP） | 依赖这些的宿主无法升级 | `resources` 显式抛错而非静默无效；changelog 列明缺口与替代路径；是否阻塞发布由使用方确认 |
| R6 chord `Context` 贯穿 durable 所有异步调用 | 稍不留意就渗进 `src/core/`，破 G1 分层 | `check:imports` 的 `PI_PACKAGES` 增加 `@earendil-works/pi-durable`、`@earendil-works/pi-ai`、`@earendil-works/chord`；Context 的构造只允许出现在 `src/pi/` |
| R7 工作量被低估 | `src/pi/` 现有约 1 600 行基本全换，mailbox 投递状态机、`tests/pi` 15 个文件、Observer 流读取面、demo 同步改 | 坚持两阶段切分，M2 作为可停靠点；不要把步骤 8–9 的减法与步骤 3–6 的重写混在一个提交里 |
| R8 G3 禁用 API 门禁对 durable 失去意义 | 词表看起来仍在生效，实则空转 | 保留词表（防 coding-agent 回流），但在脚本注释里改写理由；不把「门禁绿」当作 durable 侧安全的证据 |
| R9 durable 自身无跨进程保护，且 SQLite WAL 允许第二个进程打开同一文件 | 两个进程各开一个 Harness 调度同一 storage ⇒ 逻辑状态互相破坏，比 coding-agent 时代更危险 | 端点锁从「可选优化」升为**正确性前提**：`warm` 必须先拿到锁再 `Harness.open`，失败即 `unavailable` 绝不接管（M3 不变但权重上升）；`two-process-*` / `dual-process-migrate-lock` 用例要覆盖「第二个进程开同一 storage 被拒」 |
| R10 快照与冻结表（§6 清单）会在实现中途变红 | 容易被当成「测试坏了」而放宽守卫 | 每次重签都必须是单独一提交、说明是哪条有意变更；禁止为过测试改 `000_init.sql` |

## 进度记录

- 2026-10-20：**M1 探针成立。** 步骤 1/2 完成（`engines.node` 与 `scripts/test.mjs` 守卫抬到 `>=24.0.0`，
  durable/pi-ai/chord 以精确 `1.3.0` 装为直接依赖；`tests/pi/durable-contract.test.ts` 落地 CT-D1–CT-D11，
  共 12 个用例在真 durable + pi-ai faux provider 上全绿）。实测钉住的关键行为：崩溃模拟必须直接
  `storage.close()` 而非 `harness.close()`——后者 `beforeClose()` 会 `#tasks.join()` 等运行中任务，对
  `await` 悬崖上不响应 abort 的 tool/generation 会永久挂起，不能作为「进程死亡」的替身；`replay:"safe"`
  工具在 storage 直接关闭 + 重开 + `resume()` 后以同一 `callId` 重跑，generation 中断的 run 在重开后重新
  发起请求（callCount 1→2）并 `done`。
- 2026-10-19：完成上游 `packages/durable` 1.3.0 的读码调研（README + 类型 + `admitSubmission`/`inbox.ts`/
  storage adapter + 失败通道 + 上游测试夹具），确认 F1–F5 逐条消解、三档映射、能力缺口、破坏面清单与
  MD1–MD9 决策项，产出本计划。尚未安装依赖、未运行任何 durable 代码。
- 2026-10-19：R12 / R13 两项「接受的代价」复查后都有解，不再作为代价承担。R12：`HookApi` 没有 `commit()`
  但有 `memo(name, candidate)`（「若无则存、返回持久胜者」，落在任务记录的 `memos` 上），于是 P2 注入的
  确认可以做成持久、幂等、重启后可读回，且不写转录条目、不碰 provider 缓存；新增 CT-D7 守这条依赖。
  R13：durable 的 `steeringMode`/`followUpMode` 缺省就是 `one-at-a-time`，每个边界只落位一条，所以封顶 1
  并不降低落位速率；再加上 display-only 的 P3 不占额度、突发走既有折叠，残留只剩毫秒级往返。
- 2026-10-19：**全部决策定案，计划进入可开工状态。** MD1–MD10 与 OQ1–OQ8 全部按推荐值确定：每端点一个
  Harness；保留 better-sqlite3（MD10 不换驱动，原步骤 11 移除）；P2 注入改走 `GenerationHooks.beforeRequest`
  而非 `section()`（OQ1，理由是系统提示位的多变内容会击穿 provider 缓存）；`pi.inbox` 深度封顶 1，积压留在
  mesh（OQ2，保住折叠与原文预算语义）；一次性切换、不并存双后端（OQ3）；发 `0.2.0`、不开维护分支（OQ4）；
  watch 作主 sweep 兜底（OQ5）；demo 本次不切 `watchEvents()`（OQ6）；镜像表存 EntryId + 游标（OQ7）；
  Harness 开销在 M2 用 bench 实测（OQ8）。两项接受的代价登记为 R12（P2 确认是内存事实）与 R13（封顶 1 的
  吞吐代价）。另修正 MD5：MD1 的每端点独立 Harness 让现有闭包绑定身份原样可用，不必改成 conversationId 反查。
- 2026-10-19：核实 Node 24 下两个 SQLite 驱动的取舍（§8，依据 v24.x 分支的 `sqlite.gyp` /
  `doc/api/sqlite.md` / `node_sqlite.cc`）。结论：`node:sqlite` 方向上更优且阻塞项全部解除（FTS5 已编译进
  内置的 SQLite 3.53.4、`DatabaseSync` 同步），但 MD10 定为「本次保留 better-sqlite3，迁完再单独换」——
  权威账本不与投递状态机改造共担风险。步骤 11 从「可行性探针」改为「后续换驱动」。
- 2026-10-19：运行基线按要求定为 **Node ≥ 24**（原拟 22.19）。连带修订：`engines` 与 test 守卫抬到 24；
  R3（ESM-only）因 `require(esm)` 降级；查明 chord 的 Node 存储底层就是 `node:sqlite` 的同步
  `DatabaseSync`，据此新增 MD10 与步骤 11——「用 `node:sqlite` 替掉 better-sqlite3」从需要改 core 异步
  变成同构替换。
- 2026-10-20：对照 durable 源码复查，发现 9 处漏洞（§9 F-A–F-I）并写回原位。影响最大的三条：R12 的
  memo 确认方案不成立（generation 结束即清掉 memos），改为在 mesh 账本落确认；`unanswered` 带 `entry` 时
  不得重投，否则消息重复；`mesh_stream_entries` 主键在每端点一个 storage 下必然撞键。另补投递映射的
  `triggerTurn` 维度、按模式分槽的 `pi.inbox` 上限、`<deliveryId>:<attempt>` 的 requestId 规则、warm 时
  `configure()` 模型、关闭路径，以及 R14/R15 与 CT-D8–CT-D11。删去已废止的「步骤 11」残留引用。
  注：上方 2026-10-19 第三条记录里「R12（P2 确认是内存事实）」与同日第二条的「已解决」都已被本条取代。
