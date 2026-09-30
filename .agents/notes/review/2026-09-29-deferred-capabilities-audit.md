---
title: 未实现能力盘点（P2–P5 遗留项 + 声明显式简化的偏离记录）
date: 2026-09-29
status: done
owner: unassigned
tags: [review, deferred, p2, p3, p4, p5, spec-drift]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/plan/2026-09-28-p2-p4-final-implementation.md
  - notes/plan/2026-09-07-p0-p1-rollout.md
---

# 未实现能力盘点

## 结论

本轮（P2–P4 最终实现）已把 topic / request-response / queue / 共享空间 / observer.replay 五块做通，209 测试全绿。剩余未实现项分三类：**① 运行时桩（抛 `MeshUnsupportedError`）**、**② 声明类型对规范的显式简化（静默偏离）**、**③ 内部恢复/选择器缺陷**，外加一组**已过时的「P3/P4 延期」注释**。整体看：**没有「现在就该做」的高优先级项**；唯一需要认真盯的是「崩溃恢复字段不完整重算」与「跨进程 Transport」，前者是正确性风险、后者是规模化天花板，都在生产化之前必须落地。

---

## 一、运行时桩（`MeshUnsupportedError`）

共 3 处（现已 1 处：#2 topic history + #3 sameHost Transport 均已实现），都是公共 API 面可见的「调用即抛」，工具层会把这些转成结构化 `TOOL_DISABLED`。

| # | 能力 | 位置 | 重要程度 | 作用 / 影响 | 为什么延后（触发条件） |
| --- | --- | --- | --- | --- | --- |
| 1 | `observer.forkAt(endpointId, entryId)` | `src/core/observer.ts:677` | 🟢 低 | 「如果那条消息没到会怎样」——从某个流条目分叉新 Endpoint 换输入重跑。取证工具，非核心平台能力；调 LLM、非确定；且依赖被门禁 G3 禁用的 pi `forkFrom` | 取证型 + 三件套里 `replay`（看到了什么）与压缩对比已覆盖大部分价值。触发：出现「replay 解释不了错误决策」的生产事故，或产品转向 agent 诊断 |
| 2 | `topic history`（`mesh_history` / `host.history()` 对 `topic` 会话） | `src/index.ts:129` | 🟡 中 ✅ 已实现（2026-09-29） | topic 订阅者现在按订阅区间（`from_seq`，含起）读历史；未订阅者 `NOT_A_MEMBER`。见 plan「D2」 | 见 `notes/plan/2026-09-29-deferred-cleanup-and-samehost.md` |
| 3 | `custom Transport`（跨进程 outbox） | `src/index.ts:296` | 🔴 高（规模化） ✅ 已实现（2026-09-30） | `SameHostTransport`（§19.3）已完整接线：publish→outbox→poller CAS claim→handler→ack done；`isEndpointLocal`（端点锁 writerId 比对）网关；自定义 Transport 通过 types 开放、不做校验收敛 | 跨机（#11）仍属 P5

---

## 二、声明类型对规范的显式简化（静默偏离，需登记）

这些不是「抛错」，而是**按声明类型实现了语义子集**，与规范 §16.4/§18 存在静默偏差。规划里已定界，此处按 AGENTS.md 约定 5「偏离记入 review，不与规范静默漂移」落档。

| # | 偏离点 | 规范 | 当前实现 | 重要程度 | 作用 / 影响 |
| --- | --- | --- | --- | --- | --- |
| 4 | topic 逐订阅者 RetentionPolicy 预算裁剪 | §16.4 | 「全部当前订阅者各一行 silent/P3 delivery」替代 | 🟢 低 | 订阅者多时少了按 RetentionPolicy 的差异化预算控制。当前 fanout 语义够用、不丢消息，只省预算 |
| 5 | 共享空间三向 ACL `{read,write,admin}` | §18 三向 | ✅ 已回归规范（2026-09-29）：`Acl = { read, write, admin }`，put/del/append 走 write 面、get/list 走 read 面、admin 面暂留类型 | 🟡 中（原） | 已恢复「admin 独立权限轴」的类型与裁决；`admin` 无公开改 ACL 入口（声明类型无 `setAcl`），暂仅落于类型与默认 ACL |
| 6 | `PutResult` / `GetResult` 联合类型 | §18 | `put` 用 reject（`VERSION_MISMATCH`），`get` 用 `null`（不区分「从未存在」与「已 del 墓碑」） | 🟢 低 | 调用方拿不到「当前版本 + hint」的结构化返回；墓碑与不存在合一。工具文案（`VERSION_MISMATCH` 已是 ToolErrorCode）已自洽 |
| 7 | 保留窗口 `purged` 分支 | §18 | 版本历史不做保留窗口裁剪，历史行永久保留 | 🟢 低 | 长期高频写入会致 `mesh_shared_versions` 膨胀；当前无裁剪，审计友好但有存储风险 |

---

## 三、内部缺陷（非公共 API，但真实缺口）

| # | 缺陷 | 位置 | 重要程度 | 作用 / 影响 |
| --- | --- | --- | --- | --- |
| 8 | 崩溃恢复收件箱重算不完整 | `src/core/store.ts` `recomputeInboxCaches` | 🟡 中（正确性） ✅ 已修复（2026-09-29） | 现已补 `verbatim_bytes`（`from_account` 原文预算，字节口径，topic 不计）与 `overflow_count`（`dropped/folded`）；`overflow_summary` 恢复置 NULL（不伪造）。`cursor_seq / folded_to_seq` 按 §8.4 是**权威状态**、**不重算**——原 TODO 把两者列为待重算是与规范漂移，已改正 |
| 9 | `endpointSelector` 的 `perConversation` 不哈希 | `src/core/policies.ts:324` | 🟢 低 ✅ 已修复（2026-10-01） | `select` 的 ctx 补全 `conversationId` + 完整 `StreamTopology`；`perConversation` 分支按 `anchor = scope==="purpose" ? requestType : conversationId`、`idx = sha256Hex(accountId+":"+anchor) % N` 稳选槽位；无 perConversation 端点回退 `eps[0]`。`EndpointLookupDeps.endpointsOf` 已携带 `topology`。见 `tests/core/selector.test.ts`（5 用例） |

---

## 四、跨进程 / 跨机（P5 尾巴）

| # | 项 | 重要程度 | 作用 / 影响 |
| --- | --- | --- | --- |
| 10 | 多进程 Transport（`SqliteOutboxTransport` / `sameHost`） | 🔴 高（规模化） ✅ 已实现（2026-09-30） | 同机多进程：端点锁 writerId 判本/他进程、outbox 发布/CAS 认领/循环回收（claimer TTL/maxAttempts 死信）、warm 时注册 handler。见 `SameHostTransport`（§19.3） |
| 11 | 跨机部署 | 🔴 高（部署）｜🟢 低（当前） | 依赖 #10 的 outbox + 锁语义先用。当前 `.lock` 单写者语义本机可行，跨机需重做锁与投递 |

---

## 五、过时注释（顺带发现的清理项）

这些「P3/P4 延期」注释描述的能力**已经实现**，注释未跟上。✅ 已全部清理（2026-09-29）：

| 位置 | 过时内容 | 处置 |
| --- | --- | --- |
| `src/index.ts:197` | 「P3/P4 延后面」 | 已改为「应答与队列（ToolContext 面）」 |
| `src/core/router.ts:14-15` | 「queue 只存消息」「pending_acks 全部 sync=0」 | 已改为当前分发规则描述（含 sync=1 阻塞轴） |
| `src/core/mailbox.ts:10-11` | 「queue 的 claim/requeue 是 P3」 | 已改为 sweep 五段式描述 |
| `src/core/tools.ts:9` | 「P3/P4 延期：mesh_claim / mesh_shared_*」 | 已改为 P5 延期面（forkAt 等） |
| `src/core/store.ts` `recomputeInboxCaches` | TODO 把 cursor_seq/folded_to_seq 列为待重算 | 已改正：这两个是权威字段、不重算 |
| `src/core/router.ts:325` | 「queue 只存消息 / claim·requeue 是 P3 / 不落 pending_acks」 | 已改正（2026-09-30）：queue 已写 pending_acks（sync=0，to_account=消费者，§17.6），claim/requeue 已实现 |
| `demo/src/rpc.ts:168` | 「未接线（共享空间 P4）」 | 已改正（2026-09-30）：shared* 已委托 `host.shared.*`，改为「已接线」 |
| `src/core/transport.ts:41` | 「多进程形态走 SqliteOutboxTransport（P5）」 | 已改正（2026-09-30）：现为 SameHostTransport（§19.3） |

---

## 遗留项

- [x] **#3/#10 跨进程 sameHost**：已实现——SameHostTransport（outbox 发布/CAS 认领/循环回收）、isEndpointLocal 网关、warm 订阅 handler、poller 启动/关闭、自定义 Transport 接受。e2e 两进程测试（step 7）已补（`tests/e2e/samehost.test.ts`，2 测试 + `tests/core/transport.test.ts` 10 测试）。
- [ ] **#1 forkAt**：产出共识后再开——需先解决 pi `forkFrom` 被门禁 G3 禁用 + F4 分支语义选型 + §23.2 exclusive 租约三件事，非「填个方法」。
- [x] **#5 三向 ACL**：已回归规范三向 ACL（`{read,write,admin}`）；`admin` 改 ACL 的公开入口待声明类型扩展时再暴露。
- [ ] **#11 跨机部署**：生产化前的主线技术债，依赖 #10 的 outbox + 锁语义但需重做锁与投递
- [x] **注释清理**：第五节过时注释已全部改正（含 2026-09-30 复核追加的 `router.ts:325`、`demo/src/rpc.ts:168`、`transport.ts:41` 三处）。

## 六、2026-09-30 复核结论

对全部条目逐一核对了代码，结论与本文一致，无新发现的高优先级缺口：

| 核对项 | 结果 |
| --- | --- |
| 运行时桩 | 仅剩 `observer.forkAt`（`observer.ts:677`）一处 `throw new MeshUnsupportedError`；topic history、request-response、queue、共享空间、replay 均已落地 |
| sameHost Transport | 已完全接线：`isEndpointLocal`（`index.ts:464`）、poller start/stop（`:509`/`:1031`）、warm subscribe（`:1137`）、evict unsubscribe（`:1145`）、close 清理（`:1029`） |
| `recomputeInboxCaches` | 已补 `verbatim_bytes`（topic 不计，字节口径）与 `overflow_count`（`state='dropped' && drop_reason='folded'`），`overflow_summary` 置 NULL，`cursor_seq/folded_to_seq` 不重算（权威字段） |
| 三向 ACL | `Acl = { read, write, admin }`（`types.ts:361-364`）已回归规范 |
| `perConversation` 选择器 | 仍恒取 `eps[0]`、不哈希（`policies.ts:324-327`）——#9 未动，🟢 低 |
| demo 能力页 | 五页齐全（Topic / 请求-应答 / Queue / 共享空间 / Replay），但 `runScenario` 仍只支持 `"P0"|"P1"`，未加新能力的「一键场景」——demo 打磨项，非能力缺口 |

**当前唯一 `MeshUnsupportedError` 运行时桩：`observer.forkAt`（#1，🟢 低，取证型）。** 其余均为声明类型对规范的显式简化（§16.4 逐订阅者预算、PutResult/GetResult 联合、保留窗口裁剪）与几处内部细节（#9 选择器哈希、demo 一键场景），无「现在就该做」的项。

## 七、2026-10-01 复核结论（A/C 落地，D 维持延后）

按 `notes/plan/2026-10-01-deferred-fixes-plan.md` 落地结果，逐项对账：

| 核对项 | 结果 |
| --- | --- |
| **A. sameHost 端点归属 + 死写者恢复**（30 日 review L1/L2 + 新发现 C10） | ✅ 已修：`lock_path` 首次真正落库（warm/evict 经 `registry.setEndpointLock`，C10 不再恒触发）；`isEndpointLocal` 改读 DB `lock_path` + `endpointClass`（`external` 恒 outbox）；`EndpointLock.ownerIsLive` 三态判活（`kill -0` + 启动时刻 pid 复用护栏）；`MeshHost.reclaimEndpoint` + `createMesh({recoverDeadEndpoints})` 显式接管开关。测试：`tests/pi/stream-port.test.ts`（ownerIsLive 5 用例 + lock_path 落库 1 用例）、`tests/e2e/samehost.test.ts`（reclaimEndpoint 3 子用例） |
| **#9 perConversation 选择器哈希** | ✅ 已修：`select` 补 `conversationId` + 完整 `StreamTopology`，按 `sha256Hex(accountId:key) % N` 稳选槽位（读法 2）。`tests/core/selector.test.ts` 5 用例 |
| **#4 topic 逐订阅者 RetentionPolicy 预算** | 保持 fanout 简化，不改（🟢 低）。风险点仅订阅者极多时的写放大，已记入技术债 |
| **#6 `PutResult`/`GetResult` 联合类型** | 保持 reject/null，不改（🟢 低）。`shared.getRaw()` 按既定决定**不做**，等真实需求 |
| **#7 保留窗口 `purged` 分支** | 单列后续「裁剪」小项：按保留窗口删 `mesh_shared_versions` 旧行 + `purged` 标记，一次小 PR，不并入本计划 |
| **#1 forkAt** | 维持延后（🟢 低，取证型），触发条件不变。仍为唯一 `MeshUnsupportedError` 运行时桩 |
| **F. demo runScenario 一键场景** | **作废**：demo 已重构为「群聊-only」形态（`demo/public/app.js` 1018→211 行，五能力页未保留）。能力面的 RPC/控制器委托仍在（`rpc.ts` 的 `subscribe/unsubscribe/request/ack/claim/requeue/shared*/replay` 均透传 host），未来若要能力页可直接在其上搭 UI，无需新插桩 |

**本轮净结果**：L1/L2 + C10（3 处正确性相关）与 #9（确定性路由）关闭；#1 与 #11（跨机）维持延后；#4/#6/#7 维持「声明类型显式简化」定界，其中 #7 单独挂技术债。