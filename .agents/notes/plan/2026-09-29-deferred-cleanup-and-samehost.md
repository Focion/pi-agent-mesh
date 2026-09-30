---
title: 未实现能力收尾（注释清理 + 恢复正确性 + topic history + 三向 ACL + 多进程 sameHost Transport）
date: 2026-09-29
status: active
owner: unassigned
tags: [plan, deferred, topic, acl, shared-space, transport, multi-process, recovery, p5]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/review/2026-09-29-deferred-capabilities-audit.md
  - notes/plan/2026-09-28-p2-p4-final-implementation.md
---

# 未实现能力收尾

## 目标

基于 [`notes/review/2026-09-29-deferred-capabilities-audit.md`](../review/2026-09-29-deferred-capabilities-audit.md) 的盘点，把剩余未实现项里「该做的」落地：注释清理、恢复正确性补全，以及中高优先级能力（topic history、共享空间三向 ACL、同机多进程 Transport）。**范围已与用户确认：不做跨机器，只做多进程同机（sameHost）。**

## 范围

| # | 事项 | 来源（review 编号） | 重要程度 | 依赖 |
| --- | --- | --- | --- | --- |
| A | 注释清理（5 处过时「P3/P4 延期」注释） | review §五 | 🟢 顺手 | 无 |
| B | `recomputeInboxCaches` 正确性补全（重算缓存字段） | review #8 | 🟡 正确性 | 无 |
| C | topic history（`mesh_history` / `host.history()` 对 topic 会话） | review #2 | 🟡 中 | 无 |
| D | 共享空间三向 ACL `{read,write,admin}` | review #5 | 🟡 中 | 无 |
| E | 同机多进程 Transport（`sameHost` + `mesh_outbox`） | review #3/#10 | 🔴 高（本轮主项） | 无（单独泳道） |

**不做（维持在 `MeshUnsupportedError` / 现状）**：`observer.forkAt`、跨机器部署、topic 逐订阅者 RetentionPolicy 裁剪、`PutResult`/`GetResult` 联合、保留窗口 `purged`。

## 关键设计决策

### D1（B 项）：恢复重算「只算缓存，不动权威」

规范 §8.4（line 2428）明确：`pending_count / pending_bytes / verbatim_bytes / overflow_count` 是**缓存字段**（真相在 `mesh_deliveries`），恢复时必须重算；`cursor_seq` 与 `folded_to_seq` 是**权威状态**，**不得**重算。当前 `recomputeInboxCaches`（`src/core/store.ts:227`）已算 `pending_count/pending_bytes`，缺 `verbatim_bytes` 与 `overflow_count`；其 TODO 注释把 `cursor_seq/folded_to_seq` 也列为要重算是**错的**（与 §8.4 漂移），一并改正。

- `verbatim_bytes`：对 `mesh_deliveries` 里 `path='P1'` 且 state 非终态的行，join `mesh_messages` 求 `LENGTH(payload)` 之和。
- `overflow_count` / `overflow_summary`：溢出折叠（§7.5）的产物，从 `mesh_deliveries` 里 `state IN ('parked','dropped')` 且 `reason` 相关 + `note` / `folded` 标记现算。若字段缺可直接派生，则以「恢复后摘要不脏」为最低目标：`overflow_count` 重算、`overflow_summary` 置 NULL（下次折叠重建），绝不伪造文本。

### D2（C 项）：topic history 读权 = 订阅区间

topic 无成员表（`members()` 已返回订阅者）。`history()` 对 topic 不再抛 `MeshUnsupportedError`，改为：订阅者按 `historyVisibility`（默认 `since_join`，等价「订阅时 `from_seq`」）读区间；未订阅者 `reject(NOT_A_MEMBER)`。命名上的 `since_join` 在此语义为「订阅起点」。direct/group/queue 路径不动。

### D3（D 项）：三向 ACL 是规范回归（撤销单列表简化）

把 `Acl = { rules: AclRule[] }` 收窄为规范 §18 的三向 `Acl = { read: AclRule[]; write: AclRule[]; admin: AclRule[] }`（`AclRule.kind` 保持五类不变）。语义：

- `canRead` / `canWrite` / `canAdmin` 分别裁决（fail-closed，策略槽 `AccessControl` 先于内建规则）。
- 默认 ACL：`conv:` → `{read:["conversation"], write:["conversation"], admin:[owner]}`；`acct:`/`global`/自定义 → 三向均 `[owner]`。
- `shared.put/del/append` 走 `canWrite`；`shared.get/list` 走 `canRead`；新增「改 ACL」（`shared.setAcl`?）走 `canAdmin`——若声明类型无此面，则 admin 权仅保留在类型上、本轮不暴露新方法，把「admin 谁有」写进注释。
- 同步更新 review 归档：撤下 #5「三向 ACL 简化」，改记「三向 ACL 已回归规范」。

### D4（E 项）：多进程 sameHost 的实现边界

**现状**（已核实）：`Transport` 接口（`types.ts:753`）+ `mesh_outbox` 表（migrations 第 273 行）早已预留，但 `InProcessTransport` 是**装饰性死代码**——`Mailbox.deliverOne` 直接 `port.deliver`，`transport` 字段（`mailbox.ts:85`）从未被调用。故 E 项 = 「把 Transport 接进主链路」+「实现 `SameHostTransport` + outbox 轮询」，不是加个孤立类。

落点（遵循 §19.2/19.3）：

1. **接线**：`deliverOne` 在投递前判断目标 endpoint 是否本进程持有（`.lock` / `mesh_endpoints` 租约）。本进程 → 现状直派；非本进程 → `transport.publish(pendingDelivery)` 写 `mesh_outbox(row: delivery_id/target_endpoint/payload/state='ready')`。`publish` 与 `mesh_deliveries` 状态更新**同事务**（§19.3 规则 1）。
2. **`SameHostTransport`**（`src/core/transport.ts` 新增类，`kind:"sameHost"`）：
   - `publish`：INSERT outbox `ready`（幂等：`delivery_id` 主键 + `INSERT OR IGNORE`）。
   - 轮询认领：每进程起一个 poller，`UPDATE mesh_outbox SET state='claimed', claimed_by=me, claimed_at=now WHERE delivery_id=? AND state='ready'`（CAS，`changes()=1` 才继续）。
   - 认领后交给 `DeliveryHandler`（由 mailbox 装配：Renderer → `port.deliver` → entry_appended → `transport.ack(deliveryId,'delivered')` → outbox `done`）。
3. **回收**（§19.3 规则 2）：`claimed` 超 `claimTtlMs`（默认 5min）由任意进程回 `ready` + `attempts+=1`；`attempts > maxAttempts`（默认 3）→ outbox `failed` + 对应 delivery `dropped(TRANSPORT_FAILED)`。`done` 行按保留窗口清理、`failed` 不自动清理。
4. **端点归属**：非本进程 = `mesh_endpoints.lock_path` 的 `.lock` 被他人持有（或 `lease_mode`/`state` 指示他人进程）。复用 `EndpointLock.acquire` 的探测（已在 `index.ts:317` 有探测逻辑）。
5. **`createMesh({ transport })`**：接受自定义 `Transport`；默认仍 `InProcessTransport`；换 `SameHostTransport` 时启动 poller。**禁止跨机**（不新增 socket 实现，文档/事件不暗示跨机保证）。

> E 项只交付「两个同机进程共享 DB，outbox 中转投递 + 回收 + 幂等」，不交付文件通知加速、跨机、多实例 `external` 互联。

## 分步实现

| 步 | 事项 | 依赖 | 产出 |
| --- | --- | --- | --- |
| 1 | A：清理 5 处过时注释（`index.ts:197`、`router.ts:14-15`、`mailbox.ts:10-11`、`tools.ts:9`、`store.ts:229` TODO 措辞） | - | 注释准确 |
| 2 | B：`recomputeInboxCaches` 补 `verbatim_bytes`/`overflow_count`；改正 cursor_seq/folded_to_seq 措辞；加恢复单测 | 1 | 正确性 + 测试 |
| 3 | C：`history()` 移除 topic 抛错，按订阅区间读；`mesh_history` 工具文案；加 topic history 单测 | 1 | 能力 + 测试 |
| 4 | D：`types.ts` `Acl` 三向化；`shared.ts` `evalAcl` 三向 + 默认 ACL + canAdmin；`shared.test.ts` 增三向/越权用例；更新 review 归档 | 1 | 能力 + 测试 |
| 5 | E1：`transport.ts` 新增 `SameHostTransport`（publish 落库/认领 CAS/ack/回收） | 1 | 传输实现 |
| 6 | E2：`mailbox.ts` 接线 `deliverOne` → 非本进程走 `transport.publish`；`index.ts` 织入 poller、开放 `transport` 选项 | 5 | 主链路接线 |
| 7 | E3：双进程 e2e（同 DB 两实例 + outbox 投递/回收/幂等）+ `checkInvariants` 全绿 | 6 | 验收 |
| 8 | 收尾：`note review` 归档三向 ACL 状态、README 更新能力表、全量门禁 | 2–7 | 文档 + 门禁 |

## 验证

```bash
npm run typecheck          # 0 errors
npm test                   # 全绿（新增 B/C/D/E 用例）
node scripts/check-imports.mjs  # G1–G4 0 违规（SameHostTransport 在 core，零 pi）
npm run build              # tsup esm+cjs+dts
```

## 风险

| 项 | 影响 | 应对 |
| --- | --- | --- | --- |
| E 项「Transport 是死代码」 | 接线重构触及投递状态机核心 | 只改 `deliverOne` 的**投递出口**，不动状态机判定；本进程路径行为不变，先跑全量回归 |
| `verbatim_bytes`/`overflow_count` 派生二义 | 恢复后摘要不准 | 以「不伪造文本」为底线：数值重算、摘要置 NULL；实现前读 §7.5 折叠落库点确认字段来源 |
| 三向 ACL 改公开类型 | 破坏性 API 变更 | 这是回归规范（非简化），语义收窄到规范面；同步修 `shared.test` 与调用点 |

## 进度记录

- 2026-09-29：定稿本计划，开始实施。