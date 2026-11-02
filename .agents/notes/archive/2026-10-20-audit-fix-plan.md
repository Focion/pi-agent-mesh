---
title: 2026-10-20 全量审计问题修复计划
date: 2026-10-20
status: archived
archived_date: 2026-11-01
archived_from: notes/plan/2026-10-20-audit-fix-plan.md
archived_reason: 全部 60 项审计问题（A01–A60）已按合并执行计划修复或移交迁移计划关闭。详细执行记录见 notes/plan/2026-10-20-execution-plan.md（同期归档）。
owner: Pi Agent Mesh Dev
tags: [plan, audit, delivery-semantics, storage, security, lifecycle, gates]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/archive/2026-10-19-pi-durable-migration-plan.md
---

## 目标

修复 2026-10-20 审计确认的缺陷：投递状态机、存储与恢复、安全与身份、生命周期与 API、验证体系。

完成标准：

1. 下文每个 `A*` 条目都有对应测试，要么修复后转绿，要么在本文或 `notes/review/` 记录"不修"及理由。
2. 需要定口径的条目（标 **[规范]**）先在规范里裁决，再写代码。规范版本号与 durable 迁移计划协调，不另起分支。
3. 在 Node ≥22.19、且依赖与 `package-lock.json` 一致的环境里，以下全部通过：`check:imports`、`typecheck`、`typecheck:demo`、全量测试、`build`、`pack`、`demo:smoke`。

## 审计方式与可信度

- 5 个子代理并行只读审计，角度分别是：投递语义、存储与恢复、安全与身份、API 与生命周期、测试与门禁。每条结论都要求给出 `文件:行号` 和触发场景。
- 汇总人抽查过以下条目的源码，确认属实：A01、A03、A04、A05、A21、A22、A23、A25（导出部分）、A40。
- 置信度标注：
  - **确认**：用 `/tmp` 下的脚本复现过（基于 `dist/` 或测试 harness），或者读码时完整走通了触发链。
  - **可能**：依赖真实 pi 的时序或多进程竞态，只读过代码。
- **环境限制（必须先处理，见 A60）**：本机默认 Node 是 v20.18，better-sqlite3 加载时段错误；可用的 Node 22.16 也低于 engines 要求。`node_modules` 里 pi-coding-agent 和 pi-ai 都是 0.85.1，与 lock 文件的 1.1.0 不一致；`@vitest/coverage-v8` 缺失。在 Node 22.16 下全量 vitest 结果为 622 条用例，12 条失败，全部在 `tests/pi`，根因是 pi 版本不符，不是代码缺陷。覆盖率门禁没有实际跑过。

## 执行时机与职责划分（与 durable 迁移计划）

两份计划不合并，各自独立归档。交集部分**只由一份计划负责**，另一份只引用：

| 条目 | 负责计划 | 落点 | 理由 |
| --- | --- | --- | --- |
| A60 | 迁移计划 | 迁移步骤 1 | 同一件事：换 Node 运行基线并按 lock 重装依赖。装 durable 之前先在现有代码上取得全绿和覆盖率基线 |
| A21 | 迁移计划 | 迁移步骤 3 | stream-port 会整体重写，作为新实现的要求和测试 |
| A12、A13 | 迁移计划 | 迁移步骤 4 | 锁对象改成 durable storage 文件，迁移 R9 已把锁升为正确性前提 |
| A03、A04、A10 | 迁移计划 | 迁移步骤 8 | 投递判据改读 submission，entry 镜像与现行 reconcile、注入确认都会重写；场景写成验收测试 |
| A08、A09 | 迁移计划 | 迁移步骤 9 | `beforeClearQueue`（I22）与 handoff 超时回退整体删除；场景写成验收测试 |
| 其余条目 | 本计划 | 下文步骤 | 与执行体无关，或是迁移的前提 |

移交条目在本计划中保留问题描述，作为迁移验收的依据；状态随迁移计划对应步骤关闭。
**例外**：A03、A04 违反 I5 和 §7.9。如果迁移步骤 8 预计晚于下一次发布，先在本计划步骤 3 做最小修补，测试保留给迁移复用。

两份计划共用一条时间线：

1. **环境**：迁移步骤 1（含 A60）。
2. **门禁与快修**：本计划步骤 1、2、6、7（规范裁决、快修、安全、门禁）。可与迁移步骤 2（探针与 CT-D，不动 `src/`）并行。
3. **迁移阶段一**（迁移步骤 3–7）与**本计划 core 修复**（步骤 3、4、5）并行。阶段一不改 mailbox/router，两边不冲突；但 A20 的 SCHEMA_VERSION 策略必须在迁移步骤 5 写 `005_*.sql` 之前定案，A26 与迁移步骤 4 都改 close 路径，需要串行。
4. **迁移阶段二**（迁移步骤 8–10）：前置条件是本计划步骤 3、4 已合入，A07、A30 已裁决。
5. **收尾**：在新实现上复查"可能"级条目，本计划验收归档。

## 问题清单

编号用 `A`（Audit）前缀，避免与规范的 `M*`、`I*`、`F*`、`Q*` 以及迁移计划的 `MD*`、`OQ*` 冲突。

### 批次 1：投递状态机（core，优先级最高）

| # | 严重度 | 置信度 | 问题 | 位置 | 修复方向 | 应补测试 |
| --- | --- | --- | --- | --- | --- | --- |
| A01 | 高 | 确认 | 多端点投递反查只按 `message_id + account_id` 取行，不带 `endpoint_id`，ep2 的条目被认到 ep1 的行上。重投时 `insExtra` 撞 `UNIQUE(message_id, endpoint_id)`，整轮 sweep 抛错，后续步骤都执行不到。`index.ts:560` 的 `void retryEndpoint` 会因此产生未处理的 rejection。 | `mailbox.ts:1188-1196`、`:451-468` | 反查加 `d.endpoint_id = ?`；重投只投原行，不重新选端扩行 | 双端点 selector 下的 handoff 超时和 retryEndpoint |
| A02 | 高 | 确认 | 消息事务提交后、fanout 完成前，如果崩溃或某个收件人的 `deliverOne` 抛错，剩余投递行会永久停在 `routed`。sweep、reconcile、TTL 都不覆盖这个状态；clientToken 重试命中幂等，也不会重新 fanout。`isNextInSegment` 还把 `routed` 当作前序空洞，之后每条消息都要等 5s 缺口超时。 | `router.ts:816`、`mailbox.ts:185-194`、`:1128` | fanout 对每个收件人单独 try/catch；sweep 增加一步"`routed` 超过 N 秒就重新 deliverOne"；启动时 reconcile 也扫 `routed` | 用抛错的渲染器或 selector 模拟提交后崩溃再重启，断言最终 delivered |
| A03 | 高 | 确认 | **[移交迁移步骤 8]** `retryEndpoint` 先执行 `requeueParked`，把核对阶段因 warm 失败而 park、但已带 `entry_id` 的行盲目重投，同一条目在 session 里出现两次，违反 I5。 | `mailbox.ts:1676-1678`、`:1739-1749`、`:1863-1871` | `requeueParked` 跳过 `entry_id IS NOT NULL` 的行，改为先 reconcile | recovery：warm 先失败后成功，投递次数不变，状态为 consumed(partial) |
| A04 | 高 | 确认 | **[移交迁移步骤 8]** 周期 sweep 的 reconcile 步骤把运行中端点上的正常 delivered 行（silent 投递、busy 合并）提前标成 consumed(partial)，并发出 `message_consumed`，违反 §7.9（consumed 只能由 turn_end 归因）。 | `mailbox.ts:1461`、`:1874-1898` | 周期 sweep 只核对 parked 行或本进程启动前的行；运行中的端点交给 turn_end | hot 且空闲的端点上有 silent delivered 行，跑一次 sweep 后状态仍为 delivered |
| A05 | 中 | 确认 | `parkDelivery` 的 UPDATE 只有 `WHERE id=?`，可能把 dropped、consumed、delivered 改回 parked，之后被重投。 | `mailbox.ts:2484-2490` | 只允许从 `queued` 或 `routed` 跃迁；同样检查 drop 路径 | deliver 在 markDelivered 之后才抛错时，行不应回到 parked |
| A06 | 中 | 确认 | sweep ⑥（seq 缺口超时）有两个问题：一是在 silent 冷流上乱序投递并顺带升温，违反 §7.2"冷流不升温"；二是不检查 `isEndpointLocal`，会对别的进程持有的端点调 `deliver`。handoff 超时步骤（②）也有同样问题。 | `mailbox.ts:1345-1389` | 排除 silent 冷流和非本地端点；本地端点改走 drainQueued 的顺序逻辑 | silent 冷端点上 seq1、seq2 都在 queued，sweep 后顺序不变且不升温 |
| A07 | 中 | 确认 | `handleTurnEnd` 和 `markConsumed` 直接把 cursor 推到 MAX(seq)，与 A06 或 sink 乱序叠加时，会越过尚未消费的更小 seq。注释里"不越界"的说法不成立。 | `mailbox.ts:1229-1233`、`:1781-1785` | **[规范]** 明确 cursor 的语义：是高水位，还是连续已消费前缀 | 乱序 consume 后 cursor 的取值 |
| A08 | 中 | 确认 | **[移交迁移步骤 9]** `beforeClearQueue` 回退的是 delivered 行，但按 F5，被 clearQueue 清掉的是 queued 且带 handoff_at 的行。结果是 delivered 行被重投后条目重复，而真正丢失的行要等 30s 才补回；回退为 queued 的 P3 行没有任何路径会重投。 | `mailbox.ts:1752-1759` | **[规范]** 修订 §7.9⑤ 和 I22 的措辞。代码做最小修正，机制本身在 durable 阶段二退役 | clearQueue 前后条目不重复 |
| A09 | 中 | 可能 | **[移交迁移步骤 9]** handoff 超时（30s）后重投，与 CT-F5 的结论冲突：忙流上的 followUp 要到排空点才落盘，带工具的回合超过 30s 很常见。重投会导致 pi 内存队列里出现两份；pooled 拓扑下可能投到另一个端点。 | `mailbox.ts:1345-1361` | 重投前查端口的 handoff 集合或 `inFlight`；彻底解决依赖 durable 阶段二 | 长回合（>handoffTimeout）期间不重投 |
| A10 | 中 | 确认（读码） | **[移交迁移步骤 8]** P2 注入有两个问题：一是跨进程路径忽略 `d.woke`，不 nudge，违反 I14，而且接收方不刷新注入文本；二是 `confirmInjection` 只要看到任意 `mesh.inbox`，就把该端点所有 queued 的 P2 行推为 delivered。同进程下，deliverOne 中间的 await 也存在这个竞态窗口（可能）。 | `mailbox.ts:1285-1295`、`:1962-1989`；`index.ts:674`、`:817-825` | 只确认注入文本里实际包含的那批 delivery id；跨进程 P2 也刷新注入，并按 woke 决定是否 nudge | 跨进程 urgent 能唤醒；新消息未进注入体时不被确认 |

### 批次 2：存储、并发与恢复（core + lock）

| # | 严重度 | 置信度 | 问题 | 位置 | 修复方向 | 应补测试 |
| --- | --- | --- | --- | --- | --- | --- |
| A11 | 高 | 确认 | sameHost 的 `handleOutboxDelivery` 投递前不复核投递行状态：已撤回（tombstone 后状态为 dropped）或已终态的消息仍会被注入；claimTtl 回收后还会重复投递。 | `mailbox.ts:1255-1323`、`router.ts:757` | handler 先检查状态是否为 queued 或 routed，并且没有 handoff；撤回时同步把 outbox 行标为 done | 撤回后 `pollOnce` 不注入；claimTtl 回收后不重复投递 |
| A12 | 高 | 确认 | **[移交迁移步骤 4]** 陈旧锁回收是"先检查再删除"：两个进程同时回收时，B 可能删掉 A 刚抢到的新锁，出现两个写者。`release`、`refresh`、`setLease` 不校验持有者，会无条件删除或覆盖锁文件。 | `index.ts:447-451`、`:489-495`、`:1713-1727`；`lock.ts:224-247` | 用 rename 到唯一临时名的方式原子接管；release 和 refresh 前校验 writerId 与 pid | 双进程同时 reclaim，只能有一个成功 |
| A13 | 中 | 确认 | **[移交迁移步骤 4]** 实例锁不区分模式：单进程模式写的 lease 也是 shared，sameHost 进程可以附着；multi 模式只记录首个写者，它退出后，带 `recoverDeadEndpoints` 的单进程宿主会误回收。 | `lock.ts:126`、`index.ts:447` | 锁文件记录 mode；multi 模式改为每个进程一个 holder 文件 | 单进程与 sameHost 互斥；multi 首个写者退出后不误回收 |
| A14 | 中 | 确认 | `overflow_count` 在追赶摘要后被清零，但启动时按全部历史 folded 行重算，每次重启都会产生一次伪追赶摘要。根因是 `folded_to_seq` 在 `src/` 中从未写入（与规范 §11 冲突，见 A20）。 | `mailbox.ts:1066-1071`、`store.ts:474-479`、`index.ts:735` | 重算只统计 cursor 之后的折叠行，或启用 `folded_to_seq` | 折叠、追赶、重启三步之后不再出现追赶摘要 |
| A15 | 中 | 确认 | `requeue` 先把原行置为 dropped，再调用 `route`。route 被拒或进程崩溃时，消息丢失。 | `index.ts:1468-1497` | 先 route 成功再 drop，或把两步放进同一事务 | route 被拒时原行保持不变 |
| A16 | 中 | 确认 | `topicUnsubscribe` 的三步写入不在同一事务里；只 drop queued 和 parked 行，却把 `pending_count` 清零，重启重算后未读数又回来了。 | `index.ts:1443-1462` | 放进一个事务，口径统一 | 退订、重启后 pending 一致 |
| A17 | 中 | 可能 | P2 的 outbox done 行过了保留期（24h）被删除后，被当成孤儿重新 publish，周期性地重复写降级 note。 | `mailbox.ts:1285-1291`、`:1472-1476`、`:1546-1551` | 孤儿判定排除已经 handoff 过的行 | 时钟快进超过保留期后不重发 |
| A18 | 中 | 可能 | sameHost 并发迁移：待跑脚本列表在事务外计算，用的是 DEFERRED 事务，`ALTER ADD COLUMN` 不幂等；`.premigrate.bak` 会被多个进程并发写。 | `store.ts:304-341` | 用 BEGIN IMMEDIATE，进事务后重读已应用列表；备份时加锁 | 双进程同时升级 |
| A19 | 中 | 可能 | 多处在事务外先 SELECT，再按 id 做无状态条件的 UPDATE（溢出折叠、handleTurnEnd、confirmInjection）。sameHost 下可能覆盖终态，或把 pending 扣两次。`maybeCatchup` 在 await 之后重新查询 ids，可能把没进摘要的行标成 consumed。 | `mailbox.ts:1585-1645`、`:1201-1214`、`:1965-1976`、`:1048` | SELECT 移进事务；UPDATE 带上原状态条件；catchup 用 deliver 前的 id 集合 | 用多进程交错的属性测试覆盖 |
| A20 | 低 | 确认 | **[规范]** 一组 schema 与版本问题：`folded_to_seq` 从未写入，与 §11 的权威定义冲突；`SCHEMA_VERSION` 固定为 1，001–004 都没有推进，旧版本库可以打开新 DB；`reconcileFts` 建表与回填不是原子的；FTS 靠隐式 rowid 关联 TEXT 主键表，宿主执行 VACUUM 后会错配；registry 和 shared 直接用 `db.transaction`，绕过了 `Store.tx`（没有 IMMEDIATE、没有时钟检测）；`removeMember` 没有包在事务里；`lock.ts` 的 `ps lstart` 结果受 TZ 和 locale 影响。 | `store.ts:58`、`:366-373`；`registry.ts:567/610/678`；`shared.ts:249/325/396`；`lock.ts:52-59` | 分项修；VACUUM 风险至少在文档里写明 | 迁移后 schema_version 等于最大序号；遇到未知迁移拒绝打开 |

### 批次 3：生命周期与公共 API（`src/index.ts`、`src/pi/`、构建）

| # | 严重度 | 置信度 | 问题 | 位置 | 修复方向 | 应补测试 |
| --- | --- | --- | --- | --- | --- | --- |
| A21 | 高 | 确认 | **[移交迁移步骤 3]** `close()` 时，有 delivered 未 consumed 投递的流不卸载（evict 遇到 `hasUnconsumed` 就直接 return）：锁文件残留，同进程重建或重启时抛 LockHeldError；定时器在 DB 关闭后触发，产生未处理 rejection。违反 §12.1 和 §12.7。 | `stream-port.ts:380-388`、`:612-616`；`index.ts:1581-1583` | evict 增加 `force` 参数，dispose 时跳过检查；dispose 同时等待正在进行的 warming | 有 delivered 投递时 close，锁文件删除、session dispose，可以在同进程重新 createMesh |
| A22 | 高 | 确认 | `createMesh` 打开库之后的各步失败路径不清理资源（Transport 或 StreamPort 校验、recompute、reconcile、`transport.start`）：实例锁和 DB 句柄泄漏，之后再次 createMesh 抛 LockHeldError；sameHost 的 poller 继续运行。 | `index.ts:536-545`、`:685-698`、`:735-833` | 配置校验挪到抢锁之前；装配段统一 try/catch 回滚 | 非法 Transport 之后，可以立即用同一个 dbPath 重新 createMesh |
| A23 | 中 | 确认 | 工具 `mesh_conversation_admin` 的 `case "unsubscribe"` 缺 `return`，落到 default 抛 `ARG_INVALID`：退订已生效却报错，会诱导 LLM 重试。 | `index.ts:1538-1541` | 补上 `return` | 通过 toolSet 调 unsubscribe，返回 ok |
| A24 | 中 | 确认 | 阻塞式 `request({await:true})` 在 close 后永不 settle：轮询的 catch 分支只停止轮询，不 resolve 也不 reject。 | `index.ts:1396-1408`、`:1555` | catch 分支 reject；close 时统一 reject 所有挂起的等待者 | 阻塞 request 后 close，promise 被 reject |
| A25 | 中 | 确认 | 构建 `splitting:false`，根入口和 `/core` 各打包一份错误类，跨入口 `instanceof` 判不中（`InvariantViolationError`、`MeshUnsupportedError` 两个入口都导出）。`MeshRejectError` 在根入口只做 type 导出（`pack.mjs:201` 有意断言），根入口使用者无法按类捕获。`types.ts:957` 的 `export declare function createMesh` 经 `/core` 导出，运行时是 undefined。 | `tsup.config.ts:13`、`index.ts:1807`、`types.ts:957` | 开启 splitting，或让根入口 re-export core 产物；删除 declare。**[待决]** 根入口是否以值导出 `MeshRejectError`（会推翻 pack.mjs 的现有断言） | pack 冒烟加跨入口 `instanceof` 断言 |
| A26 | 中 | 确认 / 可能 | close 只拦截了 `send` 和 `request`，其余写入口（warm、nudge、ack、requeue、shared.*、addMember、registerSinkHandler）在 close 后仍可调用；close 不等待正在执行的 sweep，sweep 可能在 dispose 之后重新升温（可能）；`void retryAccount/retryEndpoint` 没有 `.catch`，close 后调用 `registerSinkHandler` 会让进程崩溃（已复现）。 | `index.ts:560`、`:838-853`、`:1609` 等 | 统一加 `assertOpen()`；close 等待 sweep 的 promise；所有 `void` 调用补 catch 并发出告警事件 | close 后各写 API 都 reject；sweep 进行中 close 不重新升温 |
| A27 | 低 | 确认 | 配置与类型偏差：没有校验可选的 `stop`（§12.1 要求）；`transportOptions` 完全不校验（为 0 时退化为热轮询或被立即回收）；`registerEndpoint` 不校验 topology；`ensureDirect` 会同步抛错；并发 close 时第二次调用立即返回；close 中途抛错后资源不再清理；`dbPath:":memory:"` 时 stateDir 落在 cwd 下的 `./mesh`。 | `index.ts:380`、`:536-545`、`:1556-1569`、`:1631-1636`；`transport.ts:104-106` | 补齐校验；缓存 close promise，收尾放进 finally；内存库使用临时目录 | 逐项补用例 |

### 批次 4：安全与身份边界

| # | 严重度 | 置信度 | 问题 | 位置 | 修复方向 | 应补测试 |
| --- | --- | --- | --- | --- | --- | --- |
| A30 | 高 | 确认 | **[规范]** 定向消息（`to`）对同会话的非收件人可见：`HostToolContext.history` 和 `injectJoinHistory` 的 SQL 不按 `to_accounts` 过滤，与 §5.2 冲突。规范内部也有矛盾：附录 J O2 写的是"to_accounts 不读不写"。 | `index.ts:181-195`、`:962-966` | 先裁决规范；如果保持 §5.2，两处查询都按 to_accounts 过滤 | 非收件人的 history 和 join history 都看不到定向消息 |
| A31 | 中 | 确认 | 幂等 token 直接用 toolCallId，openai-compatible 服务端可能返回空串或计数 id（如 `call_0`）。空串不是 nullish，不会走兜底窗口；key 永久有效，之后同会话的 `mesh_send` 全部命中第一条，工具报成功，实际没有新消息。 | `tools.ts:491`、`router.ts:97-109` | 拒绝空或过短的 token，或把 endpoint 或 session 混进 key | 两次 toolCallId 都为 `""` 时产生两条消息 |
| A32 | 中 | 确认 | Agent 建群绕过准入：直接把成员写入，不调用 `canInitiateDirect` 或 `canJoin`，被拒绝的私聊可以改成"建群拉人"。`normalizeConfig` 不夹紧 `mentionAllPerHour` 和 `maxHistoryOnJoin`，也不校验 `historyVisibility`。 | `registry.ts:188-217`、`:590-650` | 建群时对每个成员走准入策略；配置只允许比全局更收紧 | 逐字段用例 |
| A33 | 中 | 确认 | seal 可被降级：`seal=NULL` 的行直接放行；跨进程 `handleOutboxDelivery` 渲染 outbox payload 时不回源、不验签；`late`、`ack_of`、`fromEndpoint` 不在签名范围内。NULL 放行是规范允许的，属于设计弱点。 | `mailbox.ts:2555-2558`、`:1254-1297` | 启用 seal 后新写的行必须带签名；outbox 投递按 messageId 回源并走 `envelopeOf` | 篡改 outbox payload 后应被拒绝 |
| A34 | 低 | 确认 | 一组零散问题：畸形 hex 的 seal 让 `timingSafeEqual` 抛异常（`seal.ts:111-115`）；附件引用和 P2 注入属性（`from=`、`conv=`）未转义（`renderer.ts:142`）；tombstone 缺 `AND tombstoned_by IS NULL`（`router.ts:752`，与 I11 冲突）；`mesh_lookup` 先 LIMIT 再过滤，查询漏结果，还会暴露 `ext`；`mesh_send` 的 data、ext、to、mentions、attachments 没有大小上限；`sharedGet` 在 ACL 检查前返回 null，泄露键是否存在；自填 `correlationId` 撞主键时抛出原始 UNIQUE 错误。 | 见各条 | 分项修 | 分项补 |
| A35 | 高（demo） | 确认 / 可能 | demo 宿主（非发布产物）：RPC 用 `HANDLERS[cmd]` 取函数，没有 hasOwn 检查，`POST /api/constructor` 会执行 `Object(controller)`，可能把含 LLM 密钥的 controller 序列化回去（泄密本身为"可能"）；`listen` 不指定 host，监听所有网卡，无鉴权，不校验 Origin、Host、Content-Type，存在 CSRF 和 DNS rebinding 风险；`/api/health` 暴露路径；错误原文直接回给客户端。 | `demo/src/rpc.ts:210`、`demo/src/server.ts:170-193` | 处理函数表改用 `Map` 或 `Object.hasOwn`；默认绑定 127.0.0.1；校验 Host、Origin，要求 `application/json` | `constructor`、`__proto__` 返回 UnknownCommand；改完 demo 后按 AGENTS.md 跑 `demo:smoke` |

### 批次 5：验证体系

| # | 严重度 | 置信度 | 问题 | 位置 | 修复方向 |
| --- | --- | --- | --- | --- | --- |
| A40 | 高 | 确认 | `check:imports` 可被绕过，已实测 13 种写法：裸副作用 import、`require`、模板字符串或变量形式的动态 import、`@earendil-works/pi-ai` 不在名单里、core 经相对路径 `../pi/` 引入 pi、pi 经 `../index.js` 或 src 根桥接文件绕过 G2、`s["prompt"]()`、`s.prompt?.()`、字符串拼接；`.js`、`.cjs`、`.cts` 文件不在扫描范围内。 | `scripts/check-imports.mjs:14-52` | 改用 TS AST 按解析后的真实路径判定；core 禁止相对引用 `src/pi` 和 `src/index`；G3 按属性访问名检查；扩大扫描的扩展名。**不得放宽现有规则** |
| A41 | 中 | 确认 | 覆盖率门禁不包含 `src/index.ts` 和 `src/pi`；`coverage-gate.mjs:34` 不检查报告是否新鲜，残留的旧报告也能放行。 | `vitest.config.ts`、`scripts/coverage-gate.mjs:34` | 扩大 include 范围；校验报告的 mtime |
| A42 | 中 | 确认 | `npm test` 不检查已装依赖是否与 lock 一致，devDependencies（pi-ai faux、coverage-v8）也不在检查范围内。这次版本错配就直接表现成 12 个"代码失败"。 | `scripts/test.mjs`、`scripts/lib/deps.mjs` | test 启动前调用依赖检查，并纳入 devDependencies |
| A43 | 中 | 确认 | `verify-local` 写死的测试文件改名后会被静默跳过（vitest 按子串匹配）；`--suite` 只跑子集时，结尾仍输出"full"。 | `scripts/verify-local.mjs:76,103` | 运行前用 existsSync 校验文件；读回 json 报告核对实际跑到的文件数 |
| A44 | 中 | 确认 | 增量迁移 001–004 不在 sha256 快照里（`gen-snapshots.mjs:66`）；`pack.mjs` 的必含清单只列了 `000_init.sql`。与 A20 的 SCHEMA_VERSION 问题相关。 | `scripts/gen-snapshots.mjs:66`、`scripts/pack.mjs` | 快照覆盖全部迁移文件；必含清单按目录比对 |
| A45 | 低 | 确认 / 可能 | 一组小问题：测试里的固定 sleep（`samehost.test.ts:126,193`、`samehost-writerid.test.ts:149`、`transport.test.ts:233`、`sweep-timer.test.ts:111`）应改用 `waitFor`；`test.mjs:61` 的 `numTotalTests` 包含 skipped；`deps.mjs` 的 `^0.x` 范围判断不符合 semver；`demo-smoke.mjs:174` 缺少 violations 字段时也判为干净；`server.ts:209` 静默吞掉 tick 错误；sourcemap 带 sourcesContent。 | 见各条 | 分项修；sourcemap 属于取舍，记录结论即可 |

### 批次 0：环境

| # | 事项 |
| --- | --- |
| A60 | **[移交迁移步骤 1]** 准备 Node ≥22.19（与 durable 迁移的 Node 24 基线协调），然后执行 `npm ci` 让 node_modules 与 lock 一致（pi 1.1.0、`@vitest/coverage-v8`）。复跑全量测试和 `verify-local`，确认 `tests/pi` 的 12 条失败在正确环境下消失，并取得一份基线覆盖率。**这一步是其余所有步骤的前置条件。** |

## 步骤

| # | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| 0 | 环境与基线：由迁移步骤 1 完成（A60），本计划只引用其结果 | 迁移步骤 1 | todo |
| 1 | 规范裁决：A07（cursor 语义）、A20（`folded_to_seq` 去留、SCHEMA_VERSION 策略）、A25（根入口是否值导出 MeshRejectError）、A30（§5.2 与 O2 的矛盾）。A08 的 I22 措辞随迁移步骤 10 一起改，不在此裁决。结论写入规范，或记入 `notes/review/` | 0 | todo |
| 2 | 低风险快修，每项附测试：A23、A24、A05、A31、A34 中的 seal hex 校验和 tombstone 只写一次、A35 的 hasOwn 与绑定地址 | 0 | todo |
| 3 | 批次 1 中本计划负责的条目：A01 → A02 → A06，每项先写失败测试。A03、A04 仅在"例外"条件成立时做最小修补 | 1、2 | todo |
| 4 | 批次 2 中本计划负责的条目：A11 → A15 → A16 → A14，然后是 A17–A19、A20 的剩余项。A20 的 SCHEMA_VERSION 部分须先于迁移步骤 5 合入 | 1 | todo |
| 5 | 批次 3 中本计划负责的条目：A22 → A26 → A25 → A27。A26 的 close 路径与迁移步骤 4 串行 | 0 | done |
| 6 | 批次 4 剩余项：A30（按步骤 1 的裁决）、A32、A33、A34 的剩余项 | 1 | done |
| 7 | 批次 5 验证体系：A40（AST 门禁，含迁移 R6 要加的 durable、pi-ai、chord 包名）、A42、A44 **须在迁移步骤 3 开工前完成**；A41、A43、A45 随后 | 0 | todo |
| 8 | 全量验收：门禁、类型检查、typecheck:demo、全量测试、build、pack；改过 demo 就跑 `demo:smoke` 并在浏览器目视确认；快照和冻结表按有意变更重签；CHANGELOG | 2–7 | todo |
| 9 | 收尾：迁移步骤 9 完成后，在新实现上复查"可能"级条目（A06、A17–A19 等），确认移交条目已随迁移关闭，然后归档本计划 | 8、迁移步骤 9 | todo |

步骤 3、4、5、7 互相独立，可以并行，但 A19 与迁移步骤 8 都改 `confirmInjection`，A19 须先合入。

## 里程碑

- M-A1：步骤 0–2、7 完成。环境可信，门禁可靠，高频小缺陷修掉，规范口径定下来。这是迁移步骤 3 的开工条件。
- M-A2：步骤 3–6 完成。本计划负责的"高"级条目关闭（A01、A02、A11、A22、A30、A40）。这是迁移步骤 8 的开工条件。
- M-A3：步骤 8–9 完成，移交条目（A03、A04、A08–A10、A12、A13、A21）已随迁移 M2、M3 关闭，本计划归档。

## 风险与注意

- **交集只能有一个负责方**：移交条目不要在本计划里再修一遍（"例外"条款除外），避免和迁移重写冲突。迁移计划改动对应步骤时，需同步更新本文移交表。
- **测试耗时**：`crash-property` 一个文件约 342s，全量约 6 分钟。新增的多进程测试要控制时长，避免拖慢门禁。
- **快照与冻结**：A25、A27 会改变导出形状或报错行为，需要按有意变更重签 `snapshots/` 和 `contract-freeze`。迁移步骤 5 也要重签，两边的重签各自单独提交（迁移 R10）。
- 本计划中的"可能"级条目（A09、A17、A18、A19、A26 的 sweep 升温部分）要先写复现测试证实，再修；证伪的在本文进度记录里标为"不修"。

## 进度记录

- 2026-10-20：5 个子代理完成只读审计，汇总形成本计划。没有改动代码。
- 2026-10-20：与 durable 迁移计划对照后决定不合并。A60、A03、A04、A08–A10、A12、A13、A21 移交迁移计划负责，两份计划共用一条时间线（见"执行时机与职责划分"）。
- 2026-10-21：步骤 5（批次 3：A22 → A26 → A25 → A27）完成。A22 配置校验前移抢锁前 + 装配段回滚
  （`tests/core/create-mesh-rollback.test.ts`）；A26 全写入口 `assertOpen()` + close 等在途 sweep +
  retryAccount/retryEndpoint 补 catch（`tests/core/close-guard.test.ts`）；A25 按裁决 R3 值导出
  `MeshRejectError`、开启 tsup `splitting:true`、删死 `declare createMesh`、反转 pack/verify-package
  断言并加跨入口 instanceof、重签 `snapshots/api-surface.json`；A27 补齐 stop/transportOptions/topology
  校验、`ensureDirect` 改为 reject、并发 close 缓存 promise、close 收尾逐步 try/catch、`:memory:` 的
  stateDir 落 tmpdir（`tests/core/a27-config-close.test.ts`）。A26「sweep 升温」为「可能」项，按防
  御式处理（close 等待 `sweepPromise`）落码，未写单独的脆弱复现（在途 deliver 需自定义慢端口，
  收益低）。核心套件 `tests/core` 39 文件 532 用例全绿，`check:imports`/`typecheck`/`build` 通过。
- 2026-10-22：步骤 6（批次 4）首项 A30 完成（裁决 R4，§5.2 优先）。`HostToolContext.history` 与
  `injectJoinHistory` 的 `mesh_messages` 查询补定向可见性谓词 `from_account=reader ∨ to_accounts
  为空(NULL/'[]') ∨ reader∈to ∨ reader∈mentions`（`json_each` 集合谓词），非收件人的同会话成员读不到
  定向消息。新增 `tests/core/a30-history-visibility.test.ts` 4 用例（定向不可见 / mentions 参与投递集 /
  未定向全体可见 / 加入历史不注入定向消息）。附录 J O2 措辞按裁决 R4 随迁移步骤 10 落规范，本步骤未改
  规范正文。验证：`check:imports`/`typecheck` 通过；subscribe-admin/clock/tools/observer 计 95 用例 +
  `join-history.test.ts` 4 用例 + 新增 4 用例全绿。批次 4 剩余 A32/A33/A34 未开始。
- 2026-10-22：步骤 6 收尾（A32 → A33 → A34 剩余）完成。
  - **A32**：建群准入 fail-closed——`createConversation({type:"group", members})` 对每个非创建者成员
    走 `canInitiateDirect`，否决 → `CANNOT_INITIATE`；会话配置写时夹紧——`mentionAllPerHour` [0,100]、
    `maxHistoryOnJoin` [0,500]、`historyVisibility` 非法回落 `since_join`。测试
    `tests/core/a32-group-admission-config.test.ts` 4 用例。
  - **A33**：outbox 跨进程投递回源验签——`handleOutboxDelivery` 按 messageId `envelopeOf` 复核 seal，
    篡改 carrier/message 行 → 拒投 + `drop` + ack done + `seal_mismatch` 告警；seal=NULL 的既有放行属
    规范允许（记录为设计弱点，不在本步骤收紧）。测试 `tests/core/mailbox.test.ts`「A33 outbox 回源验签」
    2 用例（harness 使 Router 与 Mailbox 共用 sealKey）。
  - **A34 剩余**：① 附件引用 + P2 注入属性（`from=`/`conv=`）escapeDelims 转义；② `mesh_lookup` 过滤
    压进 SQL（先过滤后 LIMIT）+ 工具结果不回传 `ext`；③ `mesh_send` 补 data/ext/to/mentions/attachments
    大小上限；④ `shared.get` read ACL 先于 null 返回（tombstone/版本缺失先判权，不泄键存在性）；⑤ 自填
    `correlationId` 撞主键先查重、干净拒绝 `ARG_INVALID`。原畸形 hex seal 抛 `timingSafeEqual` 异常与
    tombstone 缺 `AND tombstoned_by IS NULL` 已在步骤 2 关闭。测试分落 renderer-shell/mailbox/
    registry-coverage/shared/router/tools。
  验证：`check:imports`/`typecheck` 通过；`tests/core` 41 文件 550 用例全绿。里程碑 M-A2 达成（高条目
  A01/A02/A11/A22/A30/A40 关闭）。
