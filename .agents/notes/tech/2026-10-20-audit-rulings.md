---
title: 审计裁决：cursor/fold/schema 版本/错误导出/投递集口径
date: 2026-10-20
status: done
owner: 待指派
tags: [audit, delivery-semantics, schema, api, ruling]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/plan/2026-10-20-execution-plan.md
  - notes/plan/2026-10-20-audit-fix-plan.md
---

# 审计裁决记录

本文件是 [审计修复计划](notes/plan/2026-10-20-audit-fix-plan.md) 步骤 4 的产物，对四处规范
歧义/实现漂移给出**定案口径**。代码修复在合并执行计划的步骤 5–8 实施，规范 1.0.3 文本修改统一在
步骤 16（迁 10）落盘，本文只记录「为什么这么裁」。裁决正文以结论先行，逐条给出裁决、依据与收口动作。

## 裁决 R1（A07）—— `cursor_seq` 是单调高水位，消费推进不得越过非终态 seq

**结论**：`cursor_seq` 是每会话的单调高水位。规范 §7.7 只声明「cursorSeq 只能单调前移，Mailbox 只投
cursorSeq 之后的连续段」，不要求每一 seq 都逐条投过——folding 可以合法地让游标跳跃。但这不授权
**消费路径**（`handleTurnEnd` / `markConsumed`）用 `MAX(cursor_seq, seq)` 越过尚未终态的消息。

**裁决口径**：

- 消费驱动的推进只有在区间 `(prev_cursor, target]` 内**每一条都已是终态**
  （consumed / dropped / folded）时才允许跳到 `target`；任何 queued / routed / parked / delivered
  中的 seq 都构成「越过非终态」的违约，必须停在最后一条连续终态之前。
- folding 路径跳跃是另一条被规范承认的路径，不受此限制；两者不得互相借用理由。
- 队列（queue）保持稀疏「acked-to」语义：`cursor_seq` 之后、尚未 ack 的 seq 允许继续保留在队列里，
  直到各自进入终态才可被消费推进覆盖。

**依据**：§7.7；§11（queue = acked-to 稀疏段）；`src/core/mailbox.ts` 的 `handleTurnEnd`
与 `markConsumed` 现存 `MAX()` 写法把「单调」误读成「可随意越过」。

**收口**：步骤 5（A07 项）改 `handleTurnEnd` / `markConsumed`，先写失败测试。

## 裁决 R2（A20）—— `folded_to_seq` 权威、由 fold 路径落盘；schema 校验加「未知迁移戳拒绝」

**结论**：`folded_to_seq` 是权威字段（§11），当前源码从未写入它。它必须由 folding 路径落盘，恢复逻辑
一律**只读不修**——与 `cursor_seq` 同级的权威字段不可重算。

`SCHEMA_VERSION` / 世代模型：§28.3 已确立「schema_version 世代 1.x 恒 '1'」+ 每迁移文件
`migration:<文件名>` 戳记 + 「>n → 拒绝启动」对照表。问题在于世代恒定不涨，导致「拒绝启动」分支
永远不触发。裁决：保留世代模型不动，但**补充显式校验**——启动时若库内有构建所知最大编号之外、
未知的 `migration:<NNN>` 戳记（编号 NNN 超出本次构建内置迁移清单），按「库比程序新」拒绝启动。

**裁决口径**：

- `folded_to_seq` 由 fold 路径写库，恢复流程可重算派生缓存（pending/overflow 统计等），
  不可重算该权威字段。
- 未知迁移戳（超出构建已知最大编号）→ 拒绝启动；迁移编号仍单调、一次一嵌。
- 文档层面明确 FTS 表 rowid 与 `VACUUM` 在迁移期的风险（§11 备注）。

**依据**：§11 权威字段清单、§28.3 世代/戳记模型；当前 `folded_to_seq` 只读不写、
世代恒 '1' 使拒绝分支失效。

**收口**：步骤 6（A20 项），其中 SCHEMA_VERSION 判定必须先于迁 5（`migrations/005_*.sql`）合入。

## 裁决 R3（A25）—— 根入口值导出 `MeshRejectError`；`tsup splitting` 开启统一类身份

**结论**：根入口（`src/index.ts`）**应当值导出** `MeshRejectError`。它是公开错误契约——
`host.send` / `request` 直接抛出它，根使用者必须能 `instanceof` 判定，而不是只能走
`code` 比对。当前只做 `export type`，且 `pack.mjs:201` 断言根入口**不得**暴露该错误，方向相反。

**裁决口径**：

- 开启 `tsup` `splitting: true`，让多个入口共享同一个错误类模块，消除
  core 入口与根入口各自实例导致 `instanceof` 跨入口判定失败的双类身份问题。
- 根入口值导出 `MeshRejectError`（公开契约，非内部实现细节）；反向修改 `pack.mjs:201` 的断言。
- 删除 `src/core/types.ts` 中遗留的 `export declare function createMesh` 死声明。

**依据**：`src/index.ts` 值导出表 / `types.ts` 类定义 / `pack.mjs` 反向断言；公开方法抛出的异常
属于 API 面，必须可判类型。

**收口**：步骤 7（A25 项）。

## 裁决 R4（A30）—— §5.2 优先；定向消息只对 `to ∪ mentions` 可见

**结论**：投递集 = 未读集 = `to ∪ mentions`（§5.2 / §6.2 / §9.4），定向消息**非收件人不可见**。
附录 J 的 O2 当前标「to_accounts 不读不写 / 未决」，与正文冲突。裁决 §5.2 正文优先。

**裁决口径**：

- `HostToolContext.history` 与 `injectJoinHistory` 在返回会话历史时按 `to_accounts`
  （收件人 + mentions）过滤，非收件人读不到定向消息。
- 附录 J O2 由「未决」改为「已决：非收件人不可见」，并注明裁决归属（R4）。

**依据**：§5.2 / §6.2 / §9.4 一致口径；附录 J O2 是唯一冲突点。正文多处一致 > 单一附录遗留。

**收口**：步骤 8（A30 项）；O2 措辞改动随迁 10 落规范。

## 记录型裁定（不改代码 / 不改规范正文）

- **A08 / I22 措辞**：随迁 10 一并调整规范措辞，不在步骤 4 单独改规范。
- **A45 sourcemap `sourcesContent`**：**取舍——保留**。本包开源，源码本就公开，留
  `sourcesContent` 换取更好的堆栈可读性，且产物体积代价可接受；不作为泄漏处理。