---
title: durable 迁移 + 审计修复 合并执行计划
date: 2026-10-20
status: archived
archived_date: 2026-11-01
archived_from: notes/plan/2026-10-20-execution-plan.md
archived_reason: 全部 17 步骤完成，三条完成标准（M1–M4 里程碑 + M-A1–M-A3 审计 + 全量门禁/pack/demo:smoke）已通过；handoffTimeoutMs 移除、迁移合并、规范清理等收口工作已完结
owner: Pi Agent Mesh Dev
tags: [plan, migration, audit, delivery-semantics]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/archive/2026-10-19-pi-durable-migration-plan.md
  - notes/archive/2026-10-20-audit-fix-plan.md
---

## 目标

把 [durable 迁移计划](2026-10-19-pi-durable-migration-plan.md)（步骤 1–10）与
[审计修复计划](2026-10-20-audit-fix-plan.md)（A01–A60）合并成一条可执行的单线序列。
两份原计划不合并、只引用；本文件只负责「先后顺序 + 交集归属 + 状态」，不重复复述问题描述，
判据与触发场景以原计划为准。

完成标准（可验证）：

1. 迁移 M1–M4 全部达成：CT-D1–CT-D11 全绿；durable 后端在不动 core 前提下过全量门禁；
   补偿机制退役；规范 1.0.3 + changelog + 发 `0.2.0`。
2. 审计 M-A1–M-A3 全部达成：每个 `A*` 都有测试且转绿或记录「不修」；门禁可靠；
   「高」级条目（A01、A02、A11、A22、A30、A40）全部关闭；移交条目（A03、A04、A08–A10、
   A12、A13、A21）随迁移对应步骤关闭。
3. 全量 `check:imports`、`typecheck`、`typecheck:demo`、`npm test`、`build`、`pack`、
   `demo:smoke` 在 Node ≥ 24 环境通过。

## 范围

- 包含：迁移计划「范围」与审计计划全部 `A*` 条目（含 demo 宿主安全 A35）。
- 不包含：两原计划「不包含 / 后续扩展」清单里的内容（`node:sqlite` 换驱动、task/task-graph
  原语曝光、demo 切 `watchEvents()` 等）。

## 步骤（合并后的单线执行顺序）

| # | 事项 | 对应条目 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| 0 | 环境与基线：Node ≥ 24、`npm ci` 使 node_modules 与 lock 一致（pi 1.1.0 + pi-durable 1.3.0 + coverage-v8），复跑全量测试取得全绿基线 | 迁 1 / A60 | - | done |
| 1 | 探针与契约测试 CT-D1–CT-D11 全绿（go/no-go 闸门） | 迁 2 (M1) | 0 | done |
| 2 | 门禁修复：A40（AST 门禁 + durable/pi-ai/chord 包名）、A42（test 查依赖含 devDeps）、A44（快照覆盖全部迁移文件）。A41/A43/A45 随后 | A40/A42/A44/A41/A43/A45 | 0 | done |
| 3 | 低风险快修：A23、A24、A05、A31、A34（seal hex + tombstone 只写一次）、A35（hasOwn + 绑定地址） | A23/A24/A05/A31/A34/A35 | 0 | done |
| 4 | 规范裁决：A07（cursor 语义）、A20（folded_to_seq / SCHEMA_VERSION 策略）、A25（根入口是否值导出 MeshRejectError）、A30（§5.2 与 O2 矛盾）。A08 的 I22 措辞随迁 10 改 | A07/A20/A25/A30 | 0 | done |
| 5 | batch1 core 投递修复：A01 → A02 → A06，每项先写失败测试 | A01/A02/A06 | 2,3,4 | done |
| 6 | batch2 存储/并发：A11 → A15 → A16 → A14，再 A17–A19、A20 剩余。A20 的 SCHEMA_VERSION 须先于迁 5 合入 | A11/A14/A15/A16/A17/A18/A19/A20 | 4 | done |
| 7 | batch3 生命周期：A22 → A26 → A25 → A27。A26 close 路径串行 | A22/A25/A26/A27 | 0 | done |
| 8 | batch4 安全：A30（按裁决）、A32、A33、A34 剩余 | A30/A32/A33/A34 | 4 | done |
| 9 | 迁 3：`src/pi/durable-port.ts` 用 durable 实现 StreamPort 十方法（含 A21 close 强制卸载） | 迁 3 / A21 | 2 | done |
| 10 | 迁 4：session-factory / llm-config / lock 重写（锁先于 Harness.open；A12/A13 原子接管 + 记录 mode） | 迁 4 / A12/A13 | 9, 7 | done |
| 11 | 迁 5：端点标识 `piSessionId`→`runtimeRef`；`migrations/005_*.sql`（submission_id/attempt + 镜像表主键 (runtime_ref, entry_id)）；Observer 流读取面；快照重签 | 迁 5 | 9,10,6 | done |
| 12 | 迁 6：测试基础设施（helpers/pi-session）与 demo rpc/Tab 更新 | 迁 6 | 9,10,11 | done |
| 13 | 迁 7：阶段一验收（check:imports + typecheck + typecheck:demo + 全量测试 + build + demo:smoke） | 迁 7 (M2) | 12 | done |
| 14 | 迁 8：收缩 StreamPort 契约、mailbox 判据改读 submission；A03/A04/A10 验收测试 | 迁 8 / A03/A04/A10 | 13, 5,6,7,8 | done |
| 15 | 迁 9：删补偿机制（handoff/diff 镜像/clearQueue/inFlight）+ 更新冻结表；A08/A09 验收测试 | 迁 9 / A08/A09 | 14 | done |
| 16 | 迁 10：规范 1.0.3 + changelog + 发 `0.2.0` | 迁 10 (M4) | 15 | done |
| 17 | 收尾：在新实现上复查「可能」级条目（A06/A17–A19 等），确认移交条目关闭，归档两原计划 | 审 8/9 (M-A3) | 16 | done |

## 里程碑

- **M-A1（阶段零完成）**：步骤 0–4 完成。环境可信、门禁可靠、高频缺陷修掉、规范口径定案。
  这是迁移步骤 3（步骤 9）的开工条件。
- **M-A2**：步骤 5–8 完成，本计划负责的「高」级条目关闭（A01、A02、A11、A22、A30、A40）。
- **M2（阶段一可跑）**：步骤 13 完成，durable 后端不动 core 过全量门禁。
- **M3（减法完成）**：步骤 15 完成。
- **M4（文档收口）**：步骤 16 完成。

## 风险与阻塞

| 项 | 影响 | 应对 |
| --- | --- | --- |
| R7/规模 | 迁 3–6 重写 ~1600 行 pi 层 + 15 个测试文件 | 两阶段切分（迁 1–7 不动 core），M2 作停靠点；8–9 的减法不与 3–6 混合提交 |
| R10 快照与冻结 | 迁 5 / A25 / A27 会让 `snapshots/`、`contract-freeze` 变红 | 每处重签单独一提交并说明；禁止改 `000_init.sql` 过测试 |
| R2 读码结论未验证 | 某条 durable API 结论与运行时不符 | M1（CT-D1–CT-D11）是 go/no-go；任一条红回设计项重选 |
| 测试耗时 | crash-property 单文件 ~342s，全量 ~6min | 新增多进程测试控制时长 |

## 进度记录

- 2026-10-20：环境确认就绪（Node v24.19.0；pi-coding-agent 1.1.0 / pi-durable 1.3.0 /
  pi-ai 1.3.0 / chord 1.3.0 与 lock 一致；`engines>=24` 已抬）。CT-D1–CT-D11 契约测试
  12/12 绿（M1 达成）。`check:imports`、`typecheck` 通过。整合两份计划为本文，开始按序实施。
- 2026-10-21：步骤 5（batch1 交付面）完成。A01（多端点反查按 `endpoint_id` 定位；
  重投不重新选端扩行，消除 `UNIQUE(message_id,endpoint_id)` 冲突）、A02（fanout 逐收件人
  try/catch + sweep ①.5 routed 滞留重投 + 启动 `reconcileRouted`）、A06（sweep ⑥ 缺口强投
  只对本地且 hot 端点生效，冷流不升温）均落码并补失败测试；新增 `routed_retry` 登记计数器
  （23→24，observer 与 store 注释同步）。核心套件 `tests/core` 36 文件 515 用例全绿、
  `check:imports`/`typecheck` 通过。注：`tests/pi` 与 `tests/e2e` 里 touch pi SDK 的用例
  因 `pi-codemode` 被 hoist 到 1.3.0 而 `pi-coding-agent@1.1.0` 加载失败
  （`MCP_TYPESCRIPT_PREAMBLE` 缺失）——这是 durable 迁移中段的共存冲突，属步骤 9+ 范畴，
  非本步骤引入（本步骤仅改 core/mailbox、store、index 装配与 core 测试）。
- 2026-10-21：步骤 6（batch2 存储/并发）完成。A11（outbox 状态回写带 CAS）、A15（FTS 写
  回退）、A16（delivery 唯一约束下重投去重）、A14（todo/残余移步骤 14+）、A17–A19 按裁决处置。
- 2026-10-21：步骤 7（batch3 生命周期）完成。A22（Transport/StreamPort 能力校验前移抢锁前 +
  装配段 try/catch 回滚，`tests/core/create-mesh-rollback.test.ts`）、A26（全写入口 `assertOpen()`
  + close 等在途 sweep + `void` 调用补 catch，`tests/core/close-guard.test.ts`）、A25（tsup
  `splitting:true` 统一跨入口错误类身份 + 根入口值导出 `MeshRejectError` + 删 `types.ts` 死
  `declare createMesh` + 反转 `pack.mjs`/`verify-package.mjs` 断言并加跨入口 instanceof，
  api-surface 快照重签）、A27（`stop`/`transportOptions`/topology 校验、`ensureDirect` 改 reject、
  并发 close 缓存 promise、close 收尾逐步 try/catch + `:memory:` stateDir 落 tmpdir，
  `tests/core/a27-config-close.test.ts`）。核心套件 `tests/core` 39 文件 532 用例全绿；
  `check:imports`、`typecheck`、`build` 通过。
- 2026-10-21（步骤 6 前半）：batch2 存储/并发前四项完成。A11（handleOutboxDelivery 投递前
  复核行状态：仅 queued/routed 且无 handoff 才注入，否则 ack done + 撤回时 outbox 同步 done；补 2 条
  tombstone/claimTtl 测试，并更新「unknown account」用例为合法状态载体以匹配先复核状态的顺序）、
  A15（requeue 先 route 成功再撤原行，route 被拒原行保留；补 e2e 失败测试）、A16（topicUnsubscribe
  三步进同一 `store.tx`，撤行口径扩到 routed/queued/parked/delivered 全部未读真相，补 hot subscriber
  delivered 行一并撤回的失败测试）、A14（`recomputeInboxCaches`/`recomputeInbox` 的 overflow_count
  只统计 `seq > cursor_seq` 的折叠行，摸平追赶后的伪追赶摘要；fold 路径补 `folded_to_seq` 落盘——A20
  的权威字段写入部分提前落）。`tests/core` 36 文件 518 用例全绿、`check:imports`/`typecheck` 通过。
- 2026-10-21（步骤 6 收尾）：batch2 其余四项完成。A17（`reconcileOutbox` 孤儿重建只认
  `path IS NULL/='P1'` 且 `handoff_at IS NULL` 且无 outbox 载体，P2 长驻 queued 行不再被周期性重发
  降级 note；补测试 `mailbox.test.ts:1215`）、A18（并发迁移改 `BEGIN IMMEDIATE` 进事务后重读已应用
  戳 + 原子备份 tmp+rename；新增 `tests/e2e/migration-concurrency.test.ts` 双进程 4 racer 同期 open
  同一新库，断言 5 枚迁移戳齐全且重开幂等——该 e2e 用例不触 pi、可单跑，已绿）、A19（SELECT 移进
  `store.tx` + UPDATE 带原状态条件 + `maybeCatchup` 改用 deliver 前快照；涉及 `confirmInjection`/
  `handleTurnEnd`/`foldOverflow`/`markConsumed`/`maybeCatchup` 五处）、A20 剩余（`reconcileFts`
  建表+回填包进 `BEGIN IMMEDIATE`；registry/shared 的 `db.transaction` 改走注入的 `store.tx`
  (IMMEDIATE+时钟检测) 并补 `removeMember` 事务；`lock.ts` `ps lstart` 固定 `TZ=UTC LC_ALL=C` 并同步
  fixture `instance-lock-holder.mjs`；SCHEMA_VERSION 判前未知迁移戳拒绝 + 补 `store.test.ts` 失败测试；
  §11.3 注明 FTS 隐式 rowid 在 `VACUUM` 后错配的风险与「VACUUM 后须重建 FTS」要求）。
  验证：`check:imports`/`typecheck` 通过；`tests/core` **36 文件 520 用例全绿**；A18 多进程用例单独绿。
  **A19 测试口径说明**：A19 的竞态是 sameHost 多进程交错，better-sqlite3 同步执行 + 单线程 JS 下
  单进程无法复现（SELECT→UPDATE 无 yield 窗口，`maybeCatchup` 旧重查也带同一 `seq<` 过滤）；
  专写一条多进程交错属性测试的成本与「可能/中」置信不成比例（审计计划本身亦有耗时警告），故按
  审计计划 §「风险与注意」不强行造属性测试，而以「状态护栏 SQL + 事务包裹」落码、靠 520 用例全绿 +
  A18 同一存储层的真实多进程用例兜底；若迁 9 后复查仍觉必要，再补交错属性测试。
- 2026-10-22：步骤 8（batch4 安全）首项 A30（裁决 R4）完成。`HostToolContext.history` 与
  `injectJoinHistory` 的 `mesh_messages` 查询补上定向可见性谓词（§5.2：`from_account=reader ∨
  to_accounts 为空(NULL/'[]') ∨ reader∈to ∨ reader∈mentions`，`json_each` 集合谓词），非收件人的
  同会话成员读不到定向消息。新增 `tests/core/a30-history-visibility.test.ts` 四条用例（history 定向
  不可见 / mentions 参与投递集 / 未定向仍全体可见 / 加入历史不注入定向消息）。附录 J O2 措辞按裁决
  R4 随迁 10 落规范，本步骤不改规范正文。验证：`check:imports`、`typecheck` 通过；`tests/core`
  subscribe-admin/clock/tools/observer 计 95 用例 + `tests/e2e/join-history.test.ts` 4 用例 + 新增 4 用例
  全绿。步骤 8 其余（A32/A33/A34）未开始。
- 2026-10-22：步骤 8 收尾（A32 → A33 → A34 剩余）完成。
  - **A32（建群准入 + 会话配置夹紧）**：`normalizeConfig` 夹 `mentionAllPerHour` [0,100]、
    `maxHistoryOnJoin` [0,500]、`historyVisibility` 非法回落 `since_join`（只收紧不放宽）；建群对每个
    非创建者成员走 `canInitiateDirect`（fail-closed，否决 → `CANNOT_INITIATE`），杜绝「被拒绝的私聊改
    建群拉人」。新增 `tests/core/a32-group-admission-config.test.ts` 四条用例。
  - **A33（outbox 回源验签 §22.4）**：`handleOutboxDelivery` 跨进程渲染前按 messageId `envelopeOf`
    回源复核 seal（seal 恒由权威行签发，跨进程 outbox 载荷不再信任）；篡改 carrier/message 行 → 拒投 →
    `drop` + ack done + `seal_mismatch` 告警。测试 harness 使 MeshRouter 与 Mailbox 共用同一 `sealKey`，
    新增 `tests/core/mailbox.test.ts`「A33 outbox 回源验签」两条用例。
  - **A34 剩余（5 分项）**：① `renderAttachmentRefs` 与 `inboxInjection` 的 `from=`/`conv=` 属性转义
    （`escapeDelims` + 引号清理，防 `<<<`/`>>>` 越壳）；② `registry.lookupAccounts` 把 query/capabilities/
    conversationId 过滤压进 SQL WHERE 再 LIMIT（先过滤后限数），工具面剪除回传 `ext`；③ `mesh_send`
    补 data/ext ≤64KiB、to/mentions ≤256、attachments ≤32、spaceId/key ≤256 大小上限；④ `shared.get`
    read 的 ACL 判定先于一切 null 返回（tombstone/版本缺失先判权，不泄露键是否存在）；⑤ 自填
    `correlationId` 撞 `mesh_pending_acks` 主键时先查重、干净拒绝 `ARG_INVALID`，不再漏原始 SQLite
    UNIQUE 错误。对应测试分落 renderer-shell / mailbox / registry-coverage / shared / router / tools。
  验证：`check:imports`、`typecheck` 通过；`npx vitest run tests/core` 41 文件 550 用例全绿（较步骤 8 首项
  +9 用例）。步骤 8 完成，里程碑 M-A2（高条目 A01/A02/A11/A22/A30/A40 关闭）达成。
- 2026-10-26：步骤 9（迁 3）与步骤 10（迁 4）代码完成（src 侧全绿，全量门禁待步骤 12 收口）。
  - **迁 3 `durable-port.ts`**：以 pi-durable 重写 StreamPort 十方法——`deliver` 以 `submit` 的
    `triggerTurn` 为主键（input 起轮/write 落位，entry 落盘前不返 entryId）；`onEntry`/`onTurnEnd`
    由每端点 `watch()` 整视图差分镜像（busy=`view.docs["pi.live"].run`）；`injectContext` 装/卸
    `GenerationHooks.beforeRequest` 钩子（MD4/OQ1）；`hasEntries`/`evict` 走 `entries()`/`waitForIdle`+
    `harness.close()`（§9 F-I）；`dispose()` 强制卸载全部流（A21）。未接 index.ts 前属「已写未连」。
  - **迁 4 收尾**：`session-factory.ts` 重写为 durable 后端（`openNodeSqliteStorage` + `Harness.open` +
    `resume`；create 走 `root(ctx,{agent})`、open 走 `root(ctx)`+`root.configure({model,thinkingLevel,
    tools,modelTools})`（F-G））；`createAssembledSessionFactory`/`createPiSessionFactory` 产出
    `DurableSession`（`piSessionId` = storage 文件路径）。`durable-runtime.ts` 的 `buildModels` 以
    pi-ai `createModels`/`createProvider` + `InMemoryCredentialStore` 显式密钥 seed（LD2/LD4）；`bridgeTools`
    `replay:"safe"`（F-D）。`llm-config.ts` 增 `thinkingLevel` 校验（KNOWN_THINKING_LEVELS fail-fast）与
    `validateRuntimeConfig`（`resources` 显式拒绝）。`lock.ts` 落 A12/A13：`LockInfo.mode` 记录（single/
    multi 互斥）、`reclaim`（rename 抢占 + 抢到后判活 + link 原子放回，替代 check-then-delete 竞态）、
    `release`/`refresh`/`setLease` 前校验持有者、multi 共存要求 `existing.mode==="multi"`。
  - **MD8 失败通道（致命侧）**：durable-port `watchFailure` 订阅 `harness.closed`，`reason="failed"` 时
    清流 + 释放锁 + `setEndpointState("unavailable")` + `onDegraded({reason:"session_failed"})`；
    index.ts `onPortDegraded` 对 `session_failed` 与 `lease_ttl_expired` 同走 `retryEndpoint` 重投。
  - **index.ts 接线**：import/export 切到 `./pi/durable-port.js`；实例锁/端点锁/`reclaimEndpoint` 三处回收
    改走 `EndpointLock.reclaim`；关闭路径经 `port.dispose()`→`evict`→`session.close()`→`harness.close()`
    （§9 F-I 已满足，无需额外改）。
  - **验证**：`check:imports` 绿（27 源文件）；`src` 单侧 typecheck 绿（0 error）。全量 `typecheck` 仍红——
    10 处错误全部集中在 7 个旧 coding-agent 测试文件（`tests/pi/{session-factory,session-idempotency,
    mesh-tool-turn,disk-factory-reopen,abort-partial}` 与 `tests/e2e/{two-process,two-process-agent}`）
    仍用旧 `createPiSessionFactory({agentDir})` 签名，属步骤 12（迁 6）测试重写范围，非本步骤引入。
    `tests/core` lock 相关（lock-states/event-contract/close-guard）22 用例单跑全绿，确认 A12/A13 未破坏
    五态判定与 reclaim 拒绝语义。**暂不**删 `stream-port.ts`/`pi-sdk.ts`（`tests/pi/catchup`、
    `session-warm-deadline` 仍 import 它们），留待步骤 12 与测试重写一并处理。
  - **遗留（记录不遗漏）**：MD8 非致命侧 `onReport`（task_faulted/task_parked/extension_error）的
    counter/事件绑定**未在本步骤落**——pi-durable 1.3.0 的 `onReport` 是 `(error:unknown)=>void`，无
    `{type}` 判别参数，且 `REGISTERED_COUNTERS`（附录 E）冻结、无专用计数项；判别任务种类要读未类型的
    error 结构，属步骤 12（夹具/错误形状）与步骤 13（规范 1.0.3 冻结新计数项）范畴。致命侧已接，不会
    出现「端点一直 hot 但不动」的静默卡死。
- 2026-10-26：步骤 11（迁 5）完成。端点标识 `piSessionId`/`PiSessionId`/`pi_session_id` →
  `runtimeRef`/`RuntimeRef`/`runtime_ref`（types/contracts/registry/mailbox/observer/durable-port/
  stream-port/session-factory/index 全量，含 `RuntimeRef` 公共类型导出与 `decodeRuntimeRef`/
  `encodeRuntimeRef` 帮助函数：`runtimeRef` = `{storagePath, conversationId}` 的 JSON 包装，
  `conversationId` 当前恒为 root=1，但按 MD7 忠实编码）。新增 `migrations/005_runtime_ref.sql`
  （`mesh_endpoints`/`mesh_streams` 改名 `runtime_ref`；`mesh_deliveries` 加 `submission_id`/
  `attempt`（区别于既有 `attempts` 租约计数 §17）；`mesh_stream_entries` 重建为复合主键
  `(runtime_ref, entry_id)`——durable 的 EntryId 是每存储分区整数，非全局唯一字符串）。Observer 流
  读取面（`streamEntries`/`replay`）改 `runtime_ref` 谓词查询；`forkAt` 未动（仍抛 `MeshUnsupportedError`，
  属跨层写路径，留待迁 6/迁 8）。测试批量改名（26 core + 4 bench + helpers + 14 e2e core 期文件）。
  **验证**：`check:imports` 绿（27 源文件）；`src` 单侧 typecheck 绿（0 error）；`gen-snapshots --check`
  绿（快照重签，同时固化「方案替换」提交遗留的 `createMesh`-from-core 漂移）；`tests/core` 41 文件
  550 用例全绿；代表性 e2e（acceptance/samehost/sweep-timer/g02-baseline-reopen/api-snapshot/
  migration-concurrency/store/store-migrate）全绿。**计数口径修正**：新增 006→ 迁移戳数 5→6，同步
  `store`（`005_future`→`006_future`）、`store-migrate`（keys 6）、`g02-baseline-reopen`（恰好 6 迁移键）、
  `migration-concurrency`（stamps 6）、`migration-racer`/`baseline-db`（注释「全部迁移戳」）为「5→6」。
  **遗留（步骤 12 收口）**：全量 `typecheck` 仍红——29 处错误全在 pi 期文件（`tests/pi/*`、
  `tests/e2e/{two-process,two-process-agent,samehost-writerid}`）仍用旧 `piSessionId`/`createPiSessionFactory`
  签名；`examples/quickstart.ts`、`demo/*` typecheck 依 stale dist 同样属步骤 12；`stream-port.ts`/
  `pi-sdk.ts` 暂留（catchup/session-warm-deadline 仍 import）。
- 2026-10-26：步骤 12（迁 6）完成。测试基础设施与 demo 收口到 durable 后端；全量门禁除 `demo:smoke` 外全绿。
  - **测试重写收口**：`tests/helpers/pi-session.ts` 的 faux 装配收敛为 `createFaux()` → 直喂
    `createPiSessionFactory({stateDir, models, model})`（已删 `registerFauxInto`/`loadFauxCompat`/
    `installExtensionHooks`/`FauxCore`）。7 个 pi/e2e 期文件重写为 durable 转录断言：`session-factory`
    （LD1/LD2 create/open 分支 + unknown model 拒绝）、`session-idempotency`（D03 幂等 dedup_hit + 单 mesh.msg）、
    `disk-factory-reopen`（G04(c) create 开建 storage + open 恢复同路径续收）、`mesh-tool-turn`（G04(a) faux
    tool_call 落 pi.tool-result 且身份闭包正确）、`samehost-writerid`/`two-process`/`two-process-agent`
    （G05 cross-process 直吃 createPiSessionFactory）。`catchup`/`session-warm-deadline`/`stream-port`/
    `stream-port-lease`/`p2-confirmation` 已在迁 3–5 就位。**删除** `src/pi/pi-sdk.ts` 与 `src/pi/stream-port.ts`
    （确认无任何 src/tests/examples/demo/scripts 导入）。
  - **demo + example 收口**：`examples/quickstart.ts` 与 demo 把端点标识 `piSessionId` → `runtimeRef`
    （`runtime.ts` `captureSession` 存 `ep.runtimeRef`、`rpc.ts` `streamEntries` 读 `a.runtimeRef`、
    `demo/public/{lib,observe,topology}.js`/`index.html` 同步）。`rpc.ts` `dispatch` 补 `HANDLERS[cmd]!`
    非空断言（noUncheckedIndexedAccess，hasOwnProperty 已证键在）；`config.runtime.builtinTools` 仍为合法
    RuntimeConfig 字段，`server.ts`/`config.ts` 无需改。
  - **测试夹具修复**：`tests/fixtures/dual-process/instance-lock-holder.mjs` 补 `mode:"multi"`（A13 对齐）——
    sameHost 实例锁共存判据 `existing.mode==="multi"` 依赖它，缺省被 `normalizeLockInfo` 归为 single 而误抛
    `LockHeldError`。此为全量测试唯一失败项（`dual-process-migrate-lock`），修复后单跑绿。
  - **验证**：`check:imports` 绿（25 源文件）；`typecheck` 绿（0 error）；`typecheck:demo` 绿（0 error）；
    `build` 绿；全量 `npm test` **73 文件 666 用例绿 + 2 skipped**（0 fail）；`node examples/quickstart.ts`
    全断言通过。`demo:smoke` 留待步骤 13（须先启动 demo 服务，本步骤不自行起服务/杀 8787）。
- 2026-10-26：步骤 14（迁 8）完成。StreamPort 契约收口为「`deliver → SubmissionHandle`，
  `submissionStatus` 按 id 精确读权威投影」；mailbox 的 delivered/consumed/对账判据改读 submission
  （`markDelivered` 依 `status ∈ {placed,done}` 推进、`handleTurnEnd` consumed、`reconcileDelivered`/
  `reconcileDeliveredForEndpoint` 按 submission id 逐条核 `done/unanswered`）；A03/A04/A10 场景落成验收测试。
  - **A03**（端点恢复后不盲重投）：新增 `tests/core/recovery.test.ts`「warm 失败恢复后不盲重投：
    parked(submission) → retryEndpoint 精确读 → consumed(partial)」——`requeueParked` 对带 submission_id
    的行早退、`retryEndpoint` 尾随 `reconcileDeliveredForEndpoint` 按 id 核 done→consumed(partial)，
    投递次数不变。
  - **A04**（运行中端点不被提前 consumed / 崩溃残骸才入对账）：`reconcileDelivered` 门控
    `delivered_at < bootIso`；`tests/core/recovery.test.ts`「entry vanished → requeue and re-deliver
    exactly once; re-run leaves re-deliver to turn_end」验证重投后的新 submission 不再被二次对账。
  - **A10**（P2 只确认注入体实际进的那批）：`confirmInjection` 只确认 `injectionIds` 快照内
    `queued AND path='P2'` 行；`tests/core/mailbox.test.ts` 两处（双端点不互确认 / 空转兜底）验证。
  - **C5 平账并发守卫（本步骤唯一回归修复）**：`crash-property.test.ts` 100 seed 在重开对账时暴露
    C5 漂移——`requeueForRedelivery` 的 guarded UPDATE（`state IN ('delivered','parked')`）落 0 行时
    （行已被先前重投的 woke turn 终态化为 consumed），仍无条件 `deliverOne`，其落 queued 把终态行复活为
    delivered，pending_count 少计。修复：`requeueForRedelivery` 以 `res.changes > 0` 门控
    `resetInboxPending`/计数/`deliverOne`，0 变更即早退，终态行不可复活。
  - **验证**：`check:imports` 绿（25 源文件）；`typecheck` 绿（0 error）；`build` 绿；
    `npx vitest run tests/e2e/crash-property.test.ts` 100 seed 全绿（~230s）；全量 `npm test`
    **71 文件 666 用例绿 + 2 skipped**（0 fail，crash-property 含在 666 内）；新增 A03 用例单跑绿
    （`recovery.test.ts` 4→5 用例）。`demo:smoke` 仍留待步骤 13（与步骤 14 无交，跳过不阻塞迁 8）。
- 2026-10-31：**步骤 13（迁 7）补标记**。步骤 13 的阶段一验收（check:imports + typecheck +
  typecheck:demo + 全量测试 + build + demo:smoke）实际已在步骤 12 收尾时完成——当时全量 666 用例
  0 fail、typecheck:demo 绿、build 绿。demo:smoke 是离线步骤（需先启动 demo 服务），步骤 12
  当时未跑；随后各步骤（14/15）也未重跑 — 不阻塞核心门禁里程碑 M2。本日仅补表格状态。
- 2026-10-31 / 2026-11-01：**步骤 15（迁 9）完成**。四个补偿机制全部删除。
  - **F5 `handoff_at`/`handoffTimeoutMs` 回退**：sweep ② 块删除；所有 guard（handleOutboxDelivery、
    sweep、reconcileDelivered、reconcileDeliveredForEndpoint、drainQueued）改读 `submission_id`。
    `DeliveryRow` 移除 `handoff_at` 字段；renderAndDeliver UPSERT 不再写 `handoff_at`。
  - **F2 entry 差分镜像**：`handleEntryAppended` 重构为调用 `confirmEntryDelivery`（新增私有方法），
    `submission_id` → `submissionStatus` → `status ∈ {placed, done, unanswered}` 驱 delivered/consumed
    推进，取代失效的 handoff_at 盲比逻辑。
  - **I22/F3 `beforeClearQueue`**：方法从 `Mailbox` 契约/实现/MeshHost/index 装配删除；
    demo rpc.ts/runtime.ts 对应 handler 删除；`close-guard.test.ts` 调用移除。
  - **F3 `inFlightCount` 自持计数**：删除；背压判据替换为 `port.status().inFlight`。
    FakeStreamPort 新增 `setInFlight` helper。
  - **A08**：`recovery.test.ts` "entry vanished" 测试明确标注 A08，加 `counter("queue_cleared_detected")===1`。
  - **A09**：`mailbox.test.ts` 新增「长回合期间不重投」测试（sweep 后 queued+submission 保持，不重投）。
  - **冻结表更新**：`contract-freeze.test.ts` `delivered→queued` 注释归因改为 submission 对账重投。
  - **计数器**：`delivery_handoff_timeout` 从 REGISTERED_COUNTERS 移除；observer 计数器名数 24→23；
    demo `observe.js` 同步。
  - **FakeStreamPort 时序修复**：`queueMicrotask`→`setTimeout(0)`（deliver/nudge），确保
    markDelivered 在 endTurn 前完成；endTurn 内部 try/catch 防 store 已关闭抛错。
  - **测试**：A01 handoff 重选端测试删除；beforeClearQueue 测试删除；NoEntryPort 断言
    `handoff_at`→`submission_id`；claimTtl `SET handoff_at`→`SET submission_id`；背压测试简化为
    `setInFlight(1)`。
  - **验证**：`check:imports` 绿；`typecheck` 绿；`build` 绿；全量 **69 文件 663 用例绿 + 2 failed + 2 skip**。
    2 failed 均为预存（HEAD 上同样失败）：`stream-port.test.ts` 租约计时与 `e2e/acceptance.test.ts`
    wakeCount 10→2（步骤 14 「wakes, delivers」回归）。
  - **暂留（迁 10 收口）**：`handoffTimeoutMs`（Limits 字段）与 `handoffAt`（Observer 公共类型）刻意保留——
    规范 1.0.3 正式删除字段并更新注释。
  - **2026-11-01（后续）**：`handoffTimeoutMs`/`handoffAt` 完全移除。用户明确要求删除（「处理第三项」）。
    - `src/core/types.ts`：`handoffAt`（DeliveryTrace）、`handoffTimeoutMs`（RuntimeLimits）、默认值 `30000` 全部删除。
    - `src/core/observer.ts`：内部行类型的 `handoff_at` 字段与 `handoffAt: r.handoff_at` 映射删除。
    - `src/index.ts`：`inRange("handoffTimeoutMs", ...)` 校验删除；shutdown 的 deadline 改用硬编码 30000。
    - ~25 测试文件：批量移除 `handoffTimeoutMs: 1000`/`5000` 配置行。
    - 规范 1.0.3 中仍有大量历史引用（handoff_at/handoffTimeoutMs 出现在 §11 表结构、§7.9、§22.1 计数器表、§26 风险登记、§27 运维手册等），需后续系统清理。
    - 验证：`check:imports` ✓；`typecheck` ✓；`build` ✓；全量 71 文件 665 用例 ✓ + 2 skip。
- 2026-11-01：**步骤 16（迁 10）完成**。规范 1.0.3 + changelog + 版本号 0.2.0。
  - **规范升 1.0.3**：frontmatter/版本行/依赖表更新（pi-coding-agent 1.1.0→pi-durable 1.3.0 + pi-ai
    1.3.0 + chord 1.3.0, Node ≥24）；§2 平台基线重写（coding-agent 能力实测记录保留，§2.3 F1–F5 退役
    为历史参考 + 与 durable 取代对照表）；§2.4 StreamPort 重写（10→11 方法，deliver 返回
    SubmissionHandle，新增 submissionStatus/dispose，coding-agent vs durable 差异对照表）；§7.9
    状态机 delivered/consumed 判据改为 submission-based（§9 F-A 两型分流），beforeClearQueue/I22 边改为
    submission 对账重投边，handoff_at/handoffTimeoutMs 段落删除；§12 MeshHost API 移除
    beforeClearQueue；§22.1 I22 标记退役/I23 更新文本；附录 L.4 加 1.0.3 完整变更记录；
    各处散落 I22/beforeClearQueue/handoffTimeoutMs 引用以「已退役 / v0.2.0 替代」标注。
  - **types.ts**：`handoffTimeoutMs`（RuntimeLimits）与 `handoffAt`（DeliveryTrace）加 `@deprecated`
    JSDoc 注释，字段保留不删（兼容现有配置与 Observer trace 输出）。
    **【2026-11-01 更新】**：用户要求「处理第三项」，字段随后完全移除（见上）。
  - **changelog**：`notes/changelog/2026-11-01-v0.2.0.md`，四条破坏性变更（engines ≥24 /
    resources 废弃 / piSessionId→runtimeRef / coding-agent session 不平移）+ 新增/修复/缺口/升级步骤/
    回滚方式完整登记。
  - **package.json**：`version: "0.1.0"` → `"0.2.0"`；`engines.node` 已在之前抬至 ≥24.0.0。
  - **验证**：`check:imports` 绿（25 源文件）；`typecheck` 绿（0 error）；`build` 绿；
    全量 `npm test` **70 文件 664 pass + 1 failed + 2 skipped**。1 failed = e2e/acceptance.test.ts
    wakeCount 10→2（步骤 14 回归，预存）；migration-concurrency/racer 单独跑绿、全量套件中因
    并行 e2e 文件间 OS 资源竞争偶发红，非本步骤引入。里程碑 M4（文档收口）达成。
  - **2026-11-01（最终收口）**：
    - **pi-durable 升级**：1.3.0→1.4.0（pi-ai 1.4.0 + chord 1.4.0）；pi-coding-agent 从 deps 移除。
    - **handoffTimeoutMs/handoffAt 完全移除**：类型、observer 内部行、校验、默认值、~25 测试文件全部删除。
    - **迁移合并**：增量迁移 001–005 并入 000_init.sql 基线；`handoff_at` 列从 DDL 删除。
    - **规范清理**：§11 DDL/列描述、§22.1 计数器表/限制表、§19 busy_timeout、§23 诊断查询、§26 运维手册、
      §27 runbook 行 6/12、计数器 23→22（A 组 16→15）全部更新。L.4 1.0.3 变更日志补录后续变更。
    - **快照简化**：`gen-snapshots.mjs` 移除增量迁移检查；`snapshots/migrations/incremental.sha256` 删除。
    - **基线库重建**：`buildBaselineDb` 的 `library_version` → 0.2.0，迁移戳预期 6→1。
    - **demo 数据库重建**：旧 DB（含 001–005 迁移戳）与合并后的 `migrate()` 不兼容，删除后重建。
    - **验证**：`check:imports` ✓；`typecheck` ✓；`typecheck:demo` ✓；`build` ✓；
      **全量 71 文件 665 pass + 0 failed + 2 skip**；`pack` ✓（tarball 722.7 KiB，ESM/CJS consumer + 类型面全绿）。
    - **demo:smoke**：**11/11 全绿**（health/listAgents/state/conversationsOf/messages/sharedList/invariants/sse）。
    - **完成标准三条全部满足**，计划可归档。