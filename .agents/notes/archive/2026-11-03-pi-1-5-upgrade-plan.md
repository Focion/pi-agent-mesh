---
title: pi-agent-mesh：pi 1.5.0 兼容适配计划
date: 2026-11-03
status: archived
archived_date: 2026-11-03
archived_from: notes/plan/2026-11-03-pi-1-5-upgrade-plan.md
archived_reason: 计划已全部执行并验证完成（683 通过 + 2 跳过，全部门禁绿，DDL 不变）。详见 notes/changelog/2026-11-02-pi-1-5-upgrade.md 与规范附录 L.4 1.0.4。
owner: Pi Agent Mesh Dev
tags: [plan, pi-sdk, upgrade, compatibility]
related:
  - notes/tech/2026-09-07-pi-agent-mesh-spec.md
  - notes/changelog/2026-11-02-pi-1-5-upgrade.md
  - notes/changelog/2026-11-01-v0.2.0.md
---

> **已归档（2026-11-03）**：本计划所列工作已全部完成并验证，不再作为当前依据；结果与使用者影响请参见 [notes/changelog/2026-11-02-pi-1-5-upgrade.md](../changelog/2026-11-02-pi-1-5-upgrade.md) 与规范附录 L.4 1.0.4。

# pi-agent-mesh：pi 1.5.0 兼容适配计划

## Context

用户在完成版本影响分析后要求继续。本次目标是升级 pi 依赖，并保持 mesh 既有投递、恢复、单写者和 core-only 隔离契约，不是只消除编译错误。

已验证：临时副本使用 Node 24.11.0、真实 SDK + faux provider，1.4.0 为 **665 passed / 2 skipped**；直接换为 1.5.0 后为 **656 passed / 9 failed / 2 skipped**，且类型检查和 DTS 构建失败。原仓库仍干净。验证资料在 `/tmp/pi-mesh-150-check-J3x6zV/` 和 `/tmp/pi-upstream-1.4-to-1.5/`。

阻断包括 tagged watch/end、schema 导出移除、continue union。更深的变化是 watch 回调合并和 50–100 条滚动窗口，不能再用它们保证条目通知及 busy→idle 边界不遗漏。新版持久化文档和任务也不能简单退回 1.4 读取。

## 范围与默认决策

- 升级 `chord`、`pi-ai`、`pi-durable` 至精确版本 **1.5.0**，显式声明使用的 `pi-schema@1.5.0`，更新锁文件；暂不改变 mesh 包版本、不发布。
- 保持 Node **24+**；不修改全局 Node/npm 配置。
- 不改 role 仓库、mesh SQLite DDL、业务策略；不增加 resources/MCP/skills、forkAt、成本系统或新 storage 后端。
- 不做双 SDK 兼容分支；默认工厂与契约测试统一用 1.5。
- 保留 mesh 的 **input/write** 提交契约；遇到 continue 投影显式报不支持，不伪装成 input/write，也不新增 continue 提交入口。
- 增加 `RuntimeConfig.progressPersistWithinMs?: number`，默认 **0**，保留接近旧版的逐 partial 落盘强度。允许宿主显式设为 1000 等非负安全整数；高级工厂的显式 settings 仍由宿主控制。
- 只做本任务必要的类型/接口扩展；保留 core 零 pi 依赖与既有禁用 API 门禁。

## 推荐实现

### 1. 先补回归与 schema/config 适配

- 使用现有 faux、gate、临时 SQLite 和 `waitFor` helper，不访问真实模型。
- `durable-runtime.ts` 不再从 pi-ai 导入 TSchema；使用 1.5 支持的 JSON Schema 类型边界。测试中的 Type.Object/Type.String 改用 pi-schema；对旧 schema 的开放属性语义保持等价，不批量重写宿主 schema。
- `toSubmissionProjection` 先明确检查 type，再生成 input/write 投影。
- `SessionEnd` 按 `kind` 分派；工厂 `onReport` 按新 report 对象传递，保留现有 unknown 回调的调用方兼容，不新增核心事件体系。
- 在 `llm-config.ts` 校验新配置，在 `buildDurableSettings` 中映射 `progress.persistWithinMs`；即使未提供 runtime，也传入默认 0。

### 2. 用已落盘提交观察替代 watch 驱动的确认链

采用 **`session.harness.observeCommits()`**。该方法由 `Harness extends Session` 继承，返回可 detach 的观察句柄。

- 同步 `advance` 只记录不可变 publication；不 await、不调用 Session、不触发宿主或 mailbox 回调。
- 在 Session 调用栈外，按提交顺序运行每端点独立的串行 drain；不合并不同 commit。
- 按 root conversation 过滤变化；publication 含完整 entry record，不依赖 50/100 条视窗，不用扩大窗口掩盖漏条目。
- changes 的内部顺序不保证：先收集 entries 和文档更新，完成条目处理，再应用相应 `pi.live` / `pi.inbox` 状态与轮次结束通知。
- 复用 `envelopeIdOf`、既有 head-marker 跳过规则、seen 去重、handoff 清理与流内编号。条目镜像继续输出完整 rawJson；确认仍读取 submission 权威状态。
- 初始化时先挂提交缓冲，再建立状态和历史基线；历史通过 `root.entries` 分页，不能把最后 50 条当完整基线。排除已经纳入基线的条目，保留初始化期间的新提交，防止基线覆盖新增状态。
- busy/inFlight 缓存按顺序更新，并跟踪 SDK 的 run 身份；同时覆盖 busy→idle 和旧 run→新 run 的边界，不能只比较 busy 布尔值。turnEnd 对应实际保存下来的 run 结束，不从最终 idle 猜测。
- 不观察或镜像未落盘的 streamed partial 来确认 delivery；默认 0 与高级 settings 的延迟进度都不能改变 entry/submission 的确认判据。

### 3. 建立条目确认完成屏障

当前 `handleEntryAppended` 内部用 void 丢弃 `confirmEntryDelivery` Promise。只按次序发 onEntry、onTurnEnd 不能保证先 delivered 后 consumed。

- 让 `handleEntryAppended` 返回实际确认的完成信号（`void | Promise<void>`），同步镜像路径保持同步。
- 内部 Mailbox 契约及 StreamPort 的 entry-handler 返回类型做必要的兼容扩展；原同步监听不需要修改。
- drain 等待 entry handler 返回的确认 Promise，再发对应 turnEnd；`src/index.ts` 必须透传该 Promise，不能在装配层丢弃。
- **完成屏障还必须带消费边界**：SDK 可以领先 drain，后续 write 的 deliver 返回值已将其置为 delivered，但较早的 turnEnd 尚未处理。现有 `handleTurnEnd` 会选中全部 delivered，单纯串行仍会提前消费。
- 给 turnEnd 事件增加可选 `eligibleEntryIds: readonly string[]`：它是该提交边界已经纳入基线/entry 通知的条目 ID 快照，不包含后续提交。装配层透传到 Mailbox；消费事务仅选择 `entry_id` 在此集合的 delivered 行。基线包含已有条目，涵盖重开前的 delivery；不依赖 ID 连续、字符串大小或当前滚窗。自定义/Fake port 不传该字段时保留原行为。
- 复用 `confirmEntryDelivery`、`markDelivered` 的 CAS/outbox ack，以及 `handleTurnEnd` 的更新/游标/事件事务和 `drainQueued`；仅增加候选过滤，不改状态机或 DDL，不伪造 consumed。
- 回归必须验证慢确认和快速连续轮次，包括后续 write 在早一轮 turnEnd 处理前已 delivered：只能在自己的有效结束边界 consumed。回调抛错不得使 SDK 观察句柄静默 detach；确认失败保留既有恢复/重试语义。

### 4. 调整启动与清理顺序

- 将本项目工厂 `assemble` 中的 `harness.resume()` 移到端口 warm：配置/root → 提交观察与基线 → P2 注入 → runtimeRef/租约/状态就绪 → resume。
- `resume` 幂等，不新增 start/afterAttached 公共方法；就绪前不调用会隐式 resume 的 waitForIdle/compact/abort。
- 本项目默认、高级工厂均遵守该顺序。外部工厂若交付已运行 Harness，说明保证从接入后开始，不能冒称补回接入前的生命周期变化；推荐交付尚未 resume 的会话。
- warm 装配后半段加失败回滚，避免新观察接线失败留下 Session 或锁。
- 正常 evict/dispose 与 observer/listener/session failure 分开处理。使用流实例身份和 closing 标记隔离旧回调，清理幂等；收敛 drain、关闭旧写者后释放锁，不让旧流影响新流。
- 更新 `watchFailure` 对 SessionEnd 的分派，补观察结束通道。意外终止走现有 unavailable/降级/恢复路径，不能仍显示正常 hot。

### 5. 验收后更新说明

- 同步根 `AGENTS.md`、`.agents/AGENTS.md` 的依赖和观察方式；清理本次涉及的旧 coding-agent/Node 基线说明，不做历史文档全面整理。
- 针对权威规范更新平台基线、§2.4 的观察实现和 entry 完成信号说明，保留 §7.9 的 input/write 投递语义；记录新的配置默认值和迁移依据，不静默推翻既有契约。
- 新增 `.agents/notes/changelog/2026-11-02-pi-1-5-upgrade.md`，说明使用者影响、旧 durable 数据升级和回滚边界，更新索引。
- 必要时更新 API 类型快照；**DDL 快照必须保持不变**，不放宽 snapshot 或导入门禁。

## 关键文件与复用点

| 文件 | 改动/复用 |
|---|---|
| `package.json`、`package-lock.json` | 精确依赖和锁文件 |
| `src/pi/durable-port.ts` | `warm`、观察/drain、`toSubmissionProjection`、`envelopeIdOf`、失败/驱逐 |
| `src/pi/session-factory.ts`、`src/pi/llm-config.ts` | settings 映射、启动顺序、新配置/Report |
| `src/pi/durable-runtime.ts` | 工具 schema 类型桥接 |
| `src/core/mailbox.ts`、`src/core/contracts.ts` | 透传 `handleEntryAppended` 完成信号及 turnEnd 候选过滤；复用确认/CAS/消费事务 |
| `src/core/types.ts`、`src/index.ts` | 兼容的 entry-handler 返回类型、可选消费边界和接线；不引入 pi 依赖到 core |
| `tests/pi/stream-port.test.ts`、`durable-contract.test.ts` | 现有 factory/setup/faux/gate/waitFor helper |
| `tests/pi/disk-factory-reopen.test.ts`、`tests/e2e/two-process*.test.ts` | 真 SDK 重开与跨进程闭环 |
| `tests/pi/llm-config.test.ts`、`session-factory.test.ts` | 配置默认/显式映射与启动顺序 |

## 验证

先跑新增和受影响的测试，再做完整门禁。异步通知断言可以使用 waitFor，但不降低语义断言、不放宽超时来掩盖丢通知、不增加 skip。

必测场景：

1. 普通 input、忙流 steer/followUp、model-write、display-only note，queued→placed/done→delivered→consumed 与 outbox ack。
2. 超过 50/100 条、单批超过 100 条、慢 entry handler、快速连续多个 run：条目无漏/重/乱序，轮次不漏、消费不提前。
3. 异常 observer/listener/session 结束、正常 evict/dispose、warm 接线失败、旧流迟到回调：状态、锁、资源和重开均正确。
4. 磁盘重开在观察/P2 就绪后恢复；requestId 和 tool-call ID 重放幂等。
5. 真实 SDK + faux 的在途生成/工具崩溃，1.5 retry/backoff、interrupted、restart_limit、done/unanswered 分支；不以 FakeStreamPort 结果代替。
6. 旧 1.4 SQLite 文档及实际 generation/tool phase 在 1.5 读取、迁移、继续执行；包含新配置默认 0 和显式延迟的崩溃边界。
7. 沿用已有回滚烟测：1.5 写 v3/new task 后 1.4 不能正常读取/恢复。只使用临时测试库，不碰用户数据。

使用 Node 24+ 和现有 npm；保留 forks / TERMUX_VERSION=1。验证顺序：

```bash
npm run check:imports
npm run build                 # 先生成自身包类型，避免 quickstart 自引用缺产物
npm run typecheck
npm test -- tests/pi
npm test -- tests/e2e/two-process.test.ts
npm test
npm run typecheck:demo
npm run pack                  # 本地 tarball、API/DDL 快照、ESM/CJS/类型消费者；不发布
npm run verify:package
```

目标：原先运行的 **665 条恢复通过**，原 2 条跳过不增加，新增测试另计；DTS、消费者验证及所有相关门禁通过。demo 前端不在修改范围，不擅自启动会杀端口进程的 demo:start；demo GUI/真实模型未验证则明确说明。

## 数据与交付约束

- 本次实现不操作已有运行库、不自动清库、不执行线上迁移。
- 真正部署前在停止写者后备份 **mesh DB 和每端点 durable storage**；SQLite schema 仍 2 不代表数据可回滚。新版写入后需恢复升级前副本或另设逆向迁移策略，不能只退锁文件。
- 不提交、不推送、不发布。结束时报告改动、实际执行的检查、跳过/失败和未验证范围，并核对工作区范围。
