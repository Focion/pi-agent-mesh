---
title: P2–P4 最终实现（topic / request-response / queue / 共享空间 / observer.replay）+ Demo
date: 2026-09-28
status: active
owner: unassigned
tags: [plan, p2, p3, p4, topic, request-response, queue, shared-space, replay, demo]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/plan/2026-09-07-p0-p1-rollout.md
---

# P2–P4 最终实现 + Demo

## 目标

把 v0.1.0 已留 schema/类型面但仍是 `MeshUnsupportedError` 桩的五块能力做通，并让它们在 `demo/`（SSE + 静态页）界面上可点测。完成后五块能力均可经工具面 / `MeshHost` 面 / demo UI 触发，`checkInvariants` 全绿，`typecheck`/`vitest`/`check:imports`/`build` 全绿。

**范围**（已与用户确认）：核心四块 + observer.replay。

## 范围

- 包含：topic（订阅+扇出）、request-response（request/ack/超时/迟到/环检测）、queue（claim/requeue/attempts/maxAttempts/sweep 回收）、共享空间（get/put/append/del/list + 持久化 + 版本历史 + CAS + ACL）、observer.replay（零 LLM）。
- 不包含（维持 `MeshUnsupportedError`）：`observer.forkAt`、`sameHost`/`SqliteOutbox` 多进程 Transport、跨机部署；以及下述「简化记录」里的规范精细化条目。

## 关键设计决策

1. **声明类型 `src/core/types.ts` 是公共契约**，规范是语义依据；冲突处按「声明类型 + 最小必要修正」落地，偏离记入 `notes/review/`。唯一必须改的声明类型：给 `SharedObjectMeta` 增 `data?: unknown`。
2. **错误统一走 reject**（`MeshRejectError`），工具层 `toToolError` 已映射，工具面零改动。
3. **ACL 用声明版单一列表** `Acl = { rules: AclRule[] }`，语义「任一规则命中即放行」：`public`/`conversation`/`accounts`/`capabilities`/`custom`（custom → `AccessControl.resolveCustomTag`）。策略槽 `canRead/canWrite/canAdmin`（fail-closed）先于内建规则裁决。默认 ACL：`conv:`→`[{conversation}]`，其余→`[{accounts:[owner]}]`。
4. **`shared.get` 返回数据**：`SharedObjectMeta` 增 `data?`（`get` 填、`list` 不填）；「从未存在」与「已 `del`」统一返回 `null`（墓碑留库供审计，`list` 经 tombstoned=0 排除）。
5. **`shared.put` CAS + reject**：`expectedVersion` 缺省=盲写、`0`=断言不存在、不匹配→`VERSION_MISMATCH`。
6. **queue 每条消息 = 一条 delivery**，终态 `acked`，`expect` 恒 `ack`（pending_acks `sync=0`，`to_account/endpoint_id` 随重投更新）。
7. **`request()` 阻塞轴** = `mesh_pending_acks.sync=1`；环检测已有（只遍历 `sync=1` 边）。

## 分块实现

- **A 共享空间**：新增 `src/core/shared.ts`（`SharedSpace`：get/put/append/del/list + evalAcl + recordVersion 同事务）；扩展 `contracts.ts`（新增 `SharedSpace` 内部接口、`RouteInput.blocking?`、`Mailbox.ack/claim/requeue`）；`index.ts` 接线 `HostToolContext` 与 `MeshHost.shared.*`。
- **B request-response**：`router.ts` pending_acks 插入读 `input.blocking` 定 `sync` 并跑 `detectRequestCycle`；ack 实现（单事务，含幂等/late/nack/释放 exclusive/message_acked）；sweep ④ 已处理超时；`index.ts` 接线 `request`/`ack`。
- **C queue**：`router.ts` queue 用 `EndpointSelector` 选单消费者插一条 routed delivery + pending_acks；`mailbox.ts` 增 `claim`（delivered→claimed）、nack/回收回 `queued`+attempts、`MAX_ATTEMPTS` 死信；sweep ⑤ 回收（commit 后先跑一遍）满足 C13；`index.ts` 接线 `claim/requeue`。
- **D topic**：`index.ts` 接 `subscribe/unsubscribe`（含退订三规则）与 `groupAdmin` 订阅分支；`router.ts` topic 分支对 `from_seq<=seq` 的订阅者各插一条 silent/P3 delivery。
- **E observer.replay**：`observer.ts` 实现 `replay`（读 streamEntries 转写 transcript，零 LLM）；`forkAt` 保持 unsupported。
- **F 工具面**：`tools.ts` 只更新四个工具 description 去掉 deferred 措辞。

## 步骤

| # | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| 1 | `types.ts` 增 `SharedObjectMeta.data?`；`contracts.ts` 增 SharedSpace/Routing 扩展 | - | todo |
| 2 | 新增 `src/core/shared.ts`（SharedSpace 全量） | 1 | todo |
| 3 | `router.ts`：topic 扇出 / queue 单投递 / blocking-sync 环检测 | 1 | todo |
| 4 | `mailbox.ts`：ack / claim / requeue / sweep ⑤ 回收 | 3 | todo |
| 5 | `observer.ts`：replay 实现 | 1 | todo |
| 6 | `index.ts`：HostToolContext + MeshHost + groupAdmin 接线五块 | 2,3,4,5 | todo |
| 7 | `tools.ts`：更新四个工具文案 | 6 | todo |
| 8 | 测试：shared/queue/ack/topic/replay + e2e + tools 桩改造 | 2–7 | todo |
| 9 | demo：runtime/rpc/index.html/app.js 新增五 tab + 场景 | 6,7 | todo |
| 10 | demo README（配置与测试说明） | 9 | todo |

## 里程碑

- 2026-09-28：五块能力落地 + 测试全绿 + demo UI 可点测 + README。

## 风险与阻塞

| 项 | 影响 | 应对 |
| --- | --- | --- |
| 声明类型 vs 规范冲突 | get/ACL/put 分歧 | 按声明类型 + 最小修正，偏离记 `notes/review/` |
| `endpointSelector.perConversation` 是 P1 桩 | queue/topic 端点选择依赖 pooled/unified | 非本轮目标，不修复 |
| `conv:` 通知走投递管线 best-effort | 通知可能漏 | 一致性以「写库 + `shared_object_changed` 事件」为准 |

## 进度记录

- 2026-09-28：定稿本计划，开始实施。