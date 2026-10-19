---
title: 未完成事项整合计划（0.1.0 稳定版 + Mesh 统一 LLM 配置）
date: 2026-10-12
status: archived
archived_date: 2026-10-19
archived_from: notes/plan/2026-10-12-consolidated-open-work-plan.md
archived_reason: W00–W16 全部关闭、G01–G09 全绿、M0–M5 全部 done，2026-10-19 复核确认交付面属实；关闭后仍悬空的事项已转入 notes/plan/2026-10-19-post-0.1.0-open-items-plan.md
owner: unassigned
tags: [plan, consolidated, v0.1.0, implementation-gap, llm-config, pi-isolation, archived]
related:
  - ./2026-10-01-deferred-fixes-plan.md
  - ./2026-09-29-deferred-capabilities-audit.md
  - ./2026-09-30-samehost-transport-review.md
  - ../tech/2026-09-07-pi-agent-mesh-spec.md
  - ../plan/2026-10-19-post-0.1.0-open-items-plan.md
---

> **已归档（2026-10-19）**：本计划的工作已全部完成，**不再是当前的未完成事项清单**。
> 当前有效的计划是 [`notes/plan/2026-10-19-post-0.1.0-open-items-plan.md`](../plan/2026-10-19-post-0.1.0-open-items-plan.md)。
>
> 本文**仍是 v0.1.0「当时为什么这么做」的事实来源**：§4 的 C01–C10 合同、§5 的 LD1–LD8 决策、
> §6 的 69 项去向登记，以及 §11 里 W00–W16 逐批的关闭记录（含每批的偏差与剩余风险）。
> 查这些内容来本文；判断**当前**该做什么、当前契约是什么，一律以上面那份计划和
> [规范](../tech/2026-09-07-pi-agent-mesh-spec.md) 为准。规范已于 2026-10-19 按 v0.1.0 实现回填（文档版本 1.0.1）。

## 1. 目标与状态

这份计划（**归档前**）是当时唯一有效的未完成事项清单。它合并了三份文档的未完成内容：实现差距审计（2026-10-09）、0.1.0 本地稳定版计划（2026-10-09）和 Mesh 统一 LLM 配置计划（2026-10-12）。已完成的早期 plan 和 review 已移入 `notes/archive/`，见第 2 节。

总目标有两条：

1. **0.1.0 当前能力稳定版本地包就绪**：关闭 41 个实现单元（N01–N05、I01–I35 和 D03），完成 V01–V08 的本地适用部分，实现 C01–C10 合同，对齐 H01–H04。最终产出版本号仍为 0.1.0 的 tarball，附 SHA-256 和验收报告。
2. **使用者只配置 Mesh**：模型、Provider、凭据、内建工具和上下文资源都由 Mesh 配置决定。使用者不需要安装、登录或维护 pi 配置，也不受机器上已有 pi 配置影响（W00）。

状态说明：

- 完成判定（2026-10-17 达成，2026-10-19 复核后归档）：W00–W16 已全部关闭（各批关闭记录见 §11），G01–G09 门槛全绿（`verify:local --all` 与 `verify:package` 均 full 通过、无 skip），M0–M5 里程碑全部 done。
- 规划期的 `draft`（尚未实施）/ `todo` / `not_run` 状态已随实现逐一作废；C01–C10 已由用户确认并全部实现，未闭合项（69 项）已 100% 有去向。
- 本地就绪不等于公开发布审批、真实 LLM 集成通过、其他平台兼容，也不等于从真实历史发布库迁移通过，更不等于已发布到 registry（未经要求不 commit / push / publish）。

### 1.1 基线

- 审计源码基线：`74e20c87349bcc675c22eefb06681c6d0e0012f6`。截至 `ee2704b`，`src/`、`migrations/`、`tests/`、`scripts/`、`examples/`、`package.json` 均未变化。之后的提交只改了 demo（群聊面板、`start.sh`），所以 H02 的 demo 事实要按当前 UI 复核。
- 逐项的 `文件:行号` 证据见实现差距审计原文；原文已删除，可用 `git show 2b8890e:.agents/notes/plan/2026-10-09-implementation-gap-audit.md` 查看。该快照只用来定位证据，**实施前必须对照最新源码复核**，不能机械套用旧行号。
- 编号沿用原有体系：N/I/V/D/C/H/E 是审计编号，W 是工作包，G 是门槛，M 是里程碑，LD 是 LLM 配置决策。这些编号不替代规范中已有的 `M*`、`I*`、`F*`、`Q*`。

## 2. 来源文档处置

| 原文档 | 判定 | 去向 |
| --- | --- | --- |
| plan/2026-09-07-p0-p1-rollout | 已完成（阶段 0–4 已落地） | 归档；作为回归输入，即 E01/E02 |
| plan/2026-09-28-p2-p4-final-implementation | 已完成（topic、请求、queue、shared、replay 已落地） | 归档；残留问题已拆进 I11–I13、I19–I23、D02 |
| plan/2026-09-29-deferred-cleanup-and-samehost | 已完成（A–E 已落地） | 归档；残留问题拆进 I01–I04、E03–E06 |
| plan/2026-10-01-deferred-fixes-plan | 已完成（A、C 完成；D 延期；E 保持简化；F 作废） | 归档；残留问题拆进 I01–I04、C05、D01、D04–D06 |
| review/2026-09-29-deferred-capabilities-audit | 已完成（复核已闭环） | 归档；#1→D01，#4/#6/#7→D04–D06，#11 跨机为非目标 |
| review/2026-09-30-samehost-transport-review | 已完成（3 处缺陷及 L1/L2 已修） | 归档；残留问题拆进 I01–I04、V01、E07/E08 |
| plan/2026-10-09-implementation-gap-audit | 未完成 | 并入第 6 节后删除；原文见提交 `2b8890e` |
| plan/2026-10-09-v0-1-0-local-release-plan | 未完成 | 并入第 3、4、7–10 节后删除；原文见提交 `2b8890e` |
| plan/2026-10-12-mesh-owned-llm-configuration-plan | 未完成 | 并入 W00 和第 5 节后删除；原文见提交 `ee2704b` |

## 3. 已关闭的历史项（回归输入，不计欠账）

E01–E10 只说明旧根因已经关闭，不代表同一模块的完整契约已经完成。它们全部作为 G01–G09 的回归输入。其中 E03、E07、E08、E09 必须经 G03/G05 的真实路径重新验证。

| ID | 已关闭事项 | 未覆盖的边界 |
| --- | --- | --- |
| E01 | 基础 schema（17 张表 + FTS）、双入口、双产物 | 迁移和消费者保证见 I05/V07 |
| E02 | 基础路由、工具、端口契约、验收骨架 | 不代表全部语义已完成 |
| E03 | 派生缓存重算（不重算 cursor_seq/folded_to_seq） | 完整恢复见 D03 |
| E04 | topic 历史按订阅起点过滤 | full 分支的缺口见 I13 |
| E05 | Shared 三向 ACL 类型及 read/write 分判 | admin、custom、通知见 I19/I23 |
| E06 | Shared 历史有界裁剪 | purged 见 D06 |
| E07 | outbox 路径已调用 `transport.ack` | 确认时机见 I02 |
| E08 | 端点锁严格单写者；sameHost 启动跳过单实例探测 | 竞争和恢复见 I04/V01 |
| E09 | `lock_path` 已落库 | 活锁判定见 I25/V06 |
| E10 | perConversation 不再恒取首端点 | 选择合同改按 C05 |

## 4. 已确认合同（C01–C10，仅界定 0.1.0）

这些决定与冻结规范冲突的条款，由 W01/W16 记为版本差异。保留历史结论，不静默改写规范。

| ID | 本版决定 | 主要兼容影响 | 归属 |
| --- | --- | --- | --- |
| C01 | mute：保留 Inbox，不唤醒。urgent 不绕过 mute；冷流不因此 warm；解除 mute 后不集中补唤醒。仍受 TTL、折叠、read 权限和预算约束 | 改变当前 `dropped(MUTED)` 行为；已有 dropped 记录不复活 | W04/W06/W08 |
| C02 | external 走宿主 SinkHandler，缺 handler 时 park，不在本地 auto-warm。sameHost 只面向 stream。自定义 Transport 必须声明归属、订阅、确认和关闭合同，不能证明能力的就拒绝启用 | 修正 P01 的“external 恒走 outbox”；不承诺外部副作用 exactly-once | W01/W05/W07 |
| C03 | 失败回退统一按 4.1 节；Floor 回退只放行合法候选，不能绕过 ACL。同步槽只做返回后耗时检查，不宣称可抢占 | 所有降级都要留事件或计数 | W03/W08/W14 |
| C04 | 显式 `by/as` 按该身份校验，取消“非成员自动跳过 cap”，不新增隐式管理员 | 依赖跳过校验的宿主调用会被拒绝，需写迁移说明 | W04/W12/W13 |
| C05 | perConversation 按“账号 + scope + key”精确匹配，purpose 使用明确的 requestType，无匹配则 park。哈希分片由 pooled 承担，size/affinity/slot 持久稳定 | 取消跨端点 hash 兜底；混合 scope 不明确时显式拒绝或 park | W01/W05 |
| C06 | 超时后的合法迟到应答标记 late，只定向回原请求方；不复活 pending，不再次完成等待，不享受唤醒豁免。abandoned、归档后写入、过期 claim 一律拒绝。重复 ack 先校验身份和端点，再判幂等；冲突响应不伪装成功 | ordinary correlation send 与 ack 入口行为一致 | W09/W10 |
| C07 | 验证 Node 22.19.0/22.20.0、pi 0.85.1、npm 10.9.3、macOS arm64；`engines.node` 改为 `>=22.19.0`，optional pi peer 收窄为精确 `0.85.1` | 不再声明支持 Node 20；合成库升级必须备份。**与 LD3 冲突，见第 5 节** | W01/W02/W15/W16 |
| C08 | 保留现有 core 公共出口，补齐必要的根类型，生成 API 快照并逐项说明变化 | 签名或行为有变化必须附迁移说明 | W01/W13/W16 |
| C09 | 不自动物理裁剪消息账；不新增同账号跨流自投；定向历史隔离继续延期 | 不以“只发 to”宣称群历史私密 | W04/W07/W16 |
| C10 | Observer 只报告，告警、计数、恢复由 Host 负责；自定义 StreamPort 按实际能力校验。P2 按实际输入集合确认；D03 保守核对，无法确定的交接 park 并告警 | SDK 不支持时阻塞对应工作包，不用 mock 绿灯替代 | W01/W08/W11/W14 |

### 4.1 九个策略槽的失败合同

| 策略槽 | 失败或非法结果的处理 | 必须验证的边界 |
| --- | --- | --- |
| delivery | `silent` 且不唤醒 | direct、urgent 和下游不能覆盖失败结果 |
| activation | 返回 false | 正常策略下合法的 direct/request 仍要起轮 |
| floor | 回退 free_for_all，但候选必须合法且有 speak 权限 | 不授予非成员或无权者 |
| renderer | 回退内建包裹与转义；自定义输出不合规就拒绝，或修壳并告警 | 壳前/壳后裸文本、嵌套定界符 |
| clock | 回退内建 compare/format 并记录降级 | 不取代权威 seq |
| accessControl | deny；custom 无人判定也 deny | 所有检查点统一包装，禁止重入写操作 |
| retention | 原文 bytes=0 | 不用默认原文预算掩盖失败 |
| endpointSelector | park 并记录原因 | 数组内全部端点都校验账号归属 |
| sessionFactory | 独立秒级 deadline（设计值默认 30 秒）；失败时返回 NO_SESSION 并告警 | 迟到结果不附着，调用 dispose 收尾；不释放仍有写者的锁 |

普通异步槽沿用 `policyTimeoutMs`。异步 deadline 只限制等待，不取消宿主副作用，需要代次标记防止迟到结果污染状态。恶意无限循环只在可终止的测试子进程中验证。

### 4.2 安全与数据合同补充

- **Shared ACL**：put 先按旧 ACL 检查 write；修改 ACL 和删除需要旧 ACL 的 admin。异步授权之后，要在事务内重新校验版本和授权依据。
- **私有 Shared 通知**：只有全部可读历史的成员都有对象 read 权限时，才写公共会话通知，否则抑制该通知并保留宿主事件。允许发出的通知固定 silent、不唤醒，且不泄露对象 key。
- **Shared 工具**：get 的历史 version 参数保持有效；成功结果保留 data 字段并补 version 元信息；put/list 声明的参数要真正生效。底层 reject/null 保持不变（D05）。
- **seal**：默认关闭；启用时由宿主提供内存密钥，不持久化。启用后拒绝未签名或验签失败的待投递消息，不给旧历史补签。
- **P1 可靠性口径**：持久意图 + 至少一次搬运 + 单写者保护下可核对的幂等应用。不承诺任意 SinkHandler 副作用 exactly-once。

## 5. 决策项（LD1–LD8 / C07 —— 2026-10-13 已冻结）

> 本节原为「待决策项」。LD1–LD8 与 C07 已于 2026-10-13 由用户定夺冻结（见 §11 进度记录），下表仅作决策留档，不再有待定项。

| ID | 决策 | 推荐值 | 冲突或影响 |
| --- | --- | --- | --- |
| LD1 | 普通公共入口 | `createMesh({ llm, runtime })` 内部装配 SessionFactory，同时保留 `policies.sessionFactory` 高级路径。若无法做到不污染 core，首版交付 `createLlmSessionFactory` 加包根便捷包装 | 需要先修改规范 §12.1/§12.3 中“SessionFactory 唯一必填”的表述；与 W01 的 API 冻结同步 |
| LD2 | 默认隔离级别 | 完全隔离，不继承 pi 文件和资源；兼容开关只能显式打开，且必须附风险说明 | 决定安全基线和 W00 测试矩阵 |
| LD3 | pi SDK 依赖归属 | Mesh 作为直接运行时依赖，并锁定已验证版本 | **与 C07 冲突**（C07 是精确版本的 optional peer）。需要在 dependency、optionalDependency、拆分适配包三者中选一；“普通用户无需手动安装 pi”和“core-only 用户不加载 pi”都是硬门槛 |
| LD4 | 凭据来源 | 显式 secret 或显式 `apiKeyEnv`；不镜像 pi 的隐式环境变量表 | 决定是否仍残留隐式环境依赖 |
| LD5 | 语义设置 | steer/followUp 由 Mesh 固定；retry/timeout/compaction 按白名单开放 | 影响投递确认和恢复的一致性（W08/W11） |
| LD6 | 多 profile | 按 `Account.profileRef` 选择；无引用时用 default | 避免日后单模型配置被破坏 |
| LD7 | pi 命名清理范围 | 本轮只消除配置和安装上的 pi 感知；包名、`piSessionId` 另做破坏性评审 | 防止范围失控 |
| LD8 | demo 范围 | W00 只把 demo 改成读取 Mesh 配置，不扩展 UI、不恢复旧五页 | 原 0.1.0 计划不把 demo 纳入验收；改动 demo 时必须补启动和浏览器回归 |

C01–C10 已确认，不在此表重议。旧审计中的 C 类“blocked”状态已被第 4 节的决定取代。

## 6. 未闭合事项登记

计数单位是“能力/根因簇”，不是代码行或 PR。合计 69 项：40 项实现差距（N+I）、8 项验证缺口（V）、7 项延期（D，其中 D03 已提升为本版必做）、10 项合同（C，见第 4 节）、4 项文档一致性（H）。另加 W00（LLM 配置）作为新增工作流，不计入 69 项。

### 6.1 N：子能力未接通（5 项）

| ID | 问题 | 闭合条件 | 归属 |
| --- | --- | --- | --- |
| N01 | `createMesh` 没有接通运行期的 mailbox 周期清扫 | 不手调 sweep，运行期 request/claim/parked/handoff/折叠也能收敛；关闭时停止调度 | W06/G03 |
| N02 | `canInitiateDirect` 不在首聊执行链上 | 建 direct 会话前生效；拒绝后不残留空会话 | W04/G03 |
| N03 | `maxHistoryOnJoin` 没有对应的历史注入 | 非零时只注入允许范围内的历史，零时不注入 | W08/G04 |
| N04 | 无法关闭 FTS | 新增初始化选项，默认开启；禁用时搜索返回明确的“功能关闭” | W02/G08 |
| N05 | `LogicalClock` 没有接入生产调用链 | 替换后的时钟能可观察地影响 compare/format，且不改变 seq 权威 | W03/G03 |

### 6.2 I：部分实现或契约未闭合（35 项）

| ID | 问题摘要 | 闭合条件 | 归属 |
| --- | --- | --- | --- |
| I01 | Host 与 PiStreamPort 各自生成 writerId；自动 warm 不注册 transport handler | 显式和自动 warm 后归属一致；本地和异主发送都有正确接收路径 | W05/G04,G05 |
| I02 | outbox 接收方统一全文 deliver，不按 P1/P2/P3；deliver 一返回就标 done | 本地与异主的投递及起轮效果一致；确认前不提前 done | W07（真实 P2 确认由 W08 承接）/G04,G05 |
| I03 | 消息提交后才 publish；失败不联动 delivery；前 50 条过滤会让其他端点饥饿 | 崩溃窗口可恢复；两层状态一致；端点之间不饥饿 | W07/G05 |
| I04 | 锁不存在、损坏、不可读都被当作 dead | 无法判定时为 unknown 并拒绝接管；只处理本进程负责的端点 | W05/G05 |
| I05 | BEGIN 抛错后 inTx 状态残留；迁移早于实例锁执行 | BEGIN 失败后可重试；锁顺序、备份、版本校验、续跑都有合同 | W02/G02,G08 |
| I06 | ext/data/attachments 在实时草稿和重载投递中丢失 | 首投、重试、跨进程、观测投影四处一致 | W03/G03,G05 |
| I07 | seal 只能生成签名，没有启用入口，也不验签 | 可启用，篡改的消息在消费前被拒并告警 | W03/G03 |
| I08 | 原文字节预算、LRU 和工具读史记账都没有生效 | 字节/会话预算、淘汰顺序和读史计量在真实链路生效 | W08/G04,G06 |
| I09 | 安装 hook 即确认 P2；按账号确认全部 P2；P3 混进 P2 正文 | 确认集合与最终上下文一致；双端点不互相确认；P3 不进正文 | W08/G04 |
| I10 | CATCHUP 摘要正文没有持久化，旧行就被消费了 | 摘要持久化并进入下一轮输入后，才推进消费 | W08/G04 |
| I11 | 请求的端点绑定、exclusive、回程定向、abandoned 不完整；路由后才订阅，存在丢事件窗口 | 请求方恰好收到一次正确终态（含快 ack、跨进程、归档场景） | W09/G03,G05 |
| I12 | claim 校验缺失且会改写 payload；turn_end 可能消费任务；重派和死信不完整 | 只有合法的当前领取者能推进；信封不可变；能重派 | W10/G03,G05,G06 |
| I13 | 重复订阅会覆盖起点；缺 canSubscribe；full 越过订阅起点；mentions 不完整 | 订阅幂等，边界和读权明确，mentions 可见 | W04（上下文集成在 W08）/G03,G04,G06 |
| I14 | 只有 P1 判断唤醒；忙流统一关闭唤醒，没有覆盖 steer | 档位与唤醒解耦；busy/steer/应答行为可核验 | W08/G04,G06 |
| I15 | selector 数组只取首项；pooled 恢复后丢失 size/affinity | 重启后拓扑不变；多端选择校验账号与端点关系 | W05/G03,G05 |
| I16 | 热流不能升级 exclusive；到期降级不同步 EndpointLock；close 顺序有问题；abort 归因不对 | 租约与锁一致；关闭后无残留写者 | W05/G04,G05 |
| I17 | history/members 不查 read；未订阅者能拿到 topic 名单 | 无 read 不得读；撤权后未读和注入同步受控 | W04/G03,G04 |
| I18 | 最后一个持 setCaps 的成员可能消失；限额和失败原子性不完整 | 保留最后的管理能力；失败不留下半成品群 | W04/G03 |
| I19 | Shared 用新 ACL 检查旧对象；delete 只要 write；custom 无 resolver 时放行 | 按 4.2 节；custom 无人判定时拒绝，并受超时保护 | W12/G03 |
| I20 | CAS 跨 await 有窗口；del 不推进版本号 | 并发符合 CAS/append 合同；删除后重建版本单调 | W12/G03,G06 |
| I21 | shared put 的 append 静默变覆盖；list 忽略分页参数 | 已声明的参数要么生效要么明确拒绝；补齐元信息 | W13/G03,G04 |
| I22 | Inbox 工具只接了简化投影 | 真实 Host 能看到待答、可领取任务和自己的 claim | W13/G03,G04 |
| I23 | Shared 通知不按 read 过滤、不固定 silent；写入路径缺归档禁写 | 按 4.2 节；归档后的读写有合同 | W12（接线在 W13）/G03 |
| I24 | Presence 到期没有回落事件；显式 offline 会被热端点覆盖；idle 未派生 | 区分显式覆盖与派生状态，到期回落可观察 | W04/G03 |
| I25 | Observer 复用写连接；C10 只检查锁文件是否存在 | 文件库使用 query_only 只读连接；按活 owner 判定 | W14/G03,G07 |
| I26 | 事件不统一携带端点元信息，部分跃迁不发事件 | 每种合法跃迁的事件数量和载荷都有合同测试 | W14/G03,G07 |
| I27 | 三个计数器从不递增；fold/busy 计数单位不对 | 计数来自实际动作，单位一致 | W14/G03,G06,G07 |
| I28 | trace 不能解释降档、不唤醒、重投的原因 | 从公共观测面就能解释完整决策链 | W14/G03 |
| I29 | truncated 标志不准；兜底截断可能产生非法 JSON；toolResultMaxBytes 没接入 | 任何规模都返回合法结构；配置真正生效 | W13/G03,G04 |
| I30 | fold 读原始 JSON 绕过全局上限；claimTtlMs 不收紧；未知键回读时丢失 | 同一份有效配置贯穿写入、读取和执行 | W04/G03 |
| I31 | sink 固定 followUp；首次拒收就 park，没有退避 | 档位透传；免 Floor；指数退避有上限 | W07/G03 |
| I32 | 部分终态不扣缓存；游标清理条件偏宽；字符数与字节数混用 | 每次转换后缓存都等于重算值，统一 UTF-8 字节口径 | W06/G03,G05 |
| I33 | SessionFactory 和 custom ACL 没有超时；同步 Guard 不校验；NO_SESSION 被改写成 PORT_TIMEOUT | 按 4.1 节，每个槽都有确定的有限结果和正确原因码 | W03/G03,G07 |
| I34 | 时钟回退、存储不可写、WAL 超阈值、integrity_check 等保护没有形成执行链 | 故障注入能观察到停发、告警和恢复边界 | W02/G02,G05 |
| I35 | devMode 护栏不全；包裹检查允许开标签前出现裸文本 | 边界语料无法越壳；诊断能真实触发 | W03/G03,G07 |

### 6.3 V：专项验证缺口（8 项）

| ID | 缺少的验证 | 归属 |
| --- | --- | --- |
| V01 | 两个真实 OS 进程 + 真实 Pi 端口：自动 warm、崩溃窗口、恰好一次、归属组合 | W15/G05 |
| V02 | 真实 SDK + faux：nextTurn 负面假设、内存分支、最终 P2 上下文、hook 覆盖、真实 mesh 工具、磁盘恢复 | W15/G04 |
| V03 | 可复现 seed、6 个窄窗口故障注入、100 次重启、JSONL 重复应用检测 | W15/G05 |
| V04 | 三个基准（双聊 200 条、30 人 500 条、8 消费者 1000 任务）及 20% 回归设施 | W15/G06 |
| V05 | 30 账号冷热切换、1000 订阅者、100 并发请求、队列接管、10 写者 CAS、附件上下文 | W15/G06 |
| V06 | 真实 Host 下的 canJoin、群限额与 I8、lock_path 与 C10 | W15/G03,G05 |
| V07 | 真实消费者：createMesh、迁移、pi 可选安装、ESM/CJS 类型、升级库 | W16/G08 |
| V08 | coverage 阈值、API/DDL 快照、SDK 版本矩阵、产物门禁（远端 CI 不在范围） | W16/G01,G02,G07,G09 |

### 6.4 D：延期与保持简化（7 项）

| ID | 本版处置 | 界限 |
| --- | --- | --- |
| D01 | forkAt 继续 unsupported，补拒绝测试和文档 | 不放宽 G3 |
| D02 | 保留基础转写 replay，补“非历史精确重建”说明 | 不宣称 byte-fidelity、历史 P2 或模型指纹 |
| D03 | **提升为本版必做**：pi 权威恢复的双向核对与幂等应用 | W11/G05；能力不足即阻塞版本，不静默退回延期 |
| D04 | topic 保持全 fanout，测试 1000 订阅者的边界 | 不实现稀疏订阅者 RetentionPolicy |
| D05 | Shared 保持 reject/null，不增加 getRaw | 不豁免 I21 |
| D06 | 保持有界裁剪；保留元信息的 purged 模型延期 | 版本单调、CAS、墓碑重建仍须修 |
| D07 | 定向历史隔离、更多 Floor 模式、queue 优先级/延时、跨拓扑迁移等不进本版 | 不恢复旧五页 demo |

**非目标**：跨机 Transport、多租户强隔离、内容审核、库自用 LLM、业务编排、公开 registry 发布、远端 CI、真实付费 LLM 验收、其他 OS 矩阵、真实历史发布库迁移。

### 6.5 H：文档一致性（4 项，W16 统一处理）

| ID | 漂移 |
| --- | --- |
| H01 | 旧 plan/review 的 done 与完整契约状态混淆。归档时保留历史，关闭证据只在本计划追加 |
| H02 | README 仍写着“多进程不做”、五能力 Tab、旧测试数量；按当前群聊面板修正事实，不扩展 demo |
| H03 | 规范内部枚举、事件字段、命名不统一（sinceJoin/since_join、Presence、附录事件载荷等），按本版合同对齐 |
| H04 | 文字承诺强于已有证据：topic“零 delivery”、“永久保留”、full replay、sameHost“恰好一次”、发布“已验证”等，需标明真实边界 |

## 7. 工作包

### 7.1 依赖与集成规则

`W00 → W01 → W02 → W03 → W04 → W05 → W06 → W07 → W08 → W09 → W10 → W11 → W13 → W14 → W15 → W16`

- 独立分支：`W04 → W12 → W13`。W12 的 Shared 叶模块可以与 W05–W11 并行。
- W00 的第 1 步（冻结 LD1–LD8）必须先于 W01 的 API 冻结。W00 的其余步骤只改 `src/pi/` 和包根装配，可与 W02–W06 并行，在 W13 前合入。
- `src/index.ts` 和 `src/core/mailbox.ts` 由唯一的集成角色负责，避免多个工作包同时修改后凭测试结果拼接。
- 每个工作包都按“先写合同测试 → 核对测试本身 → 最小实现 → 针对性回归 → 集成”推进。禁止空桩、强制类型转换、skip、放宽门禁。
- schema 变更一律走新的增量迁移，不改已使用的 `000_init.sql`。
- 每个工作包最多 3 轮“失败 → 定位 → 修正 → 复验”。不收敛，或发现合同、权限、SDK 能力不足时，停下来交接最小复现。

分批执行（7 批，单执行者串行，每批以该批的门禁 + 关闭记录收尾）：

1. 第 0 步 + W00（L1–L10）—— pi 升级 + Mesh 统一 LLM 配置。**已完成**。
2. W01 —— 冻结 API/错误码/状态转换表 + API/DDL 基线快照 + 三探针（P2 最终输入 / hook 覆盖 / 磁盘 create-open）+ 破坏性清理迁入独立工作目录。
3. W02–W03 —— Store/迁移/运行故障 + 策略/信封/渲染。
4. W04–W06 —— 群治理/权限/订阅 → 单写者/拓扑/生命周期 → 邮箱转换/周期清扫/游标。
5. W07–W10 —— 派送意图/Sink → 原文预算/P2/CATCHUP/唤醒 → 请求应答 → Queue。
6. W11–W13 —— D03 权威恢复 + Shared（W04 分支）+ 工具真实装配/公共类型。
7. W14–W16 —— Observer/事件/计数 → 本地整体验收（G01–G07）→ 0.1.0 包与文档闭合（G08–G09）。

W01 是硬闸门：其探针结论会复核第 3–7 批的拆分与体量，探针不可行则按依赖规则阻塞 W08/W11/W13，不降级不改期。

### 7.2 W00：Mesh 统一 LLM 与运行时配置

**覆盖**：LD1–LD8。**依赖**：无。**状态**：done（L1–L5、L7、L9、L10 全包；L6 仅指纹落地、profileRef/多 profile 后续方案；L8 全矩阵并入 W16-G08）。

需要消除的配置泄漏：

- **凭据**：`~/.pi/agent/auth.json` 和 Provider 环境变量。
- **模型与设置**：`models.json`、`models-store.json`、全局和项目 `settings.json`（会影响模型、工具、steer/followUp、compaction、重试、超时）。
- **资源**：全局 extensions、skills、prompts、themes，以及 cwd 祖先目录中的 `AGENTS.md`、`CLAUDE.md`。
- **工具**：pi 默认的 read/bash/edit/write。
- **环境变量**：`PI_CODING_AGENT_DIR`、`PI_OFFLINE`。

需要优先修复的两个缺陷：

1. demo 配置的 `tools: []` 没有传给 pi，实际启用了默认内建工具。
2. pi 的 `tools` 是全量白名单，只传内建工具名会把 Mesh 自定义工具一并过滤掉。

隔离装配要求（pi SDK 0.85.1）：

- `agentDir` 使用 Mesh `stateDir` 下的私有目录。
- 凭据走内存 CredentialStore，并由 Mesh 注册 secret。
- `ModelRuntime` 设置 `modelsPath: null`，Provider 由 Mesh 配置注册。
- 使用内存 `SettingsManager`。
- 显式构造 `DefaultResourceLoader`，默认 `noExtensions`、`noSkills`、`noPromptTemplates`、`noThemes`、`noContextFiles`。
- 工具白名单 = 显式内建工具 + 当前端点的全部 Mesh 工具名。

配置面草案（技术设计时冻结）：`llm.providers`、`llm.model`、`llm.thinkingLevel`、`runtime.builtinTools`（默认 `[]`）、`runtime.resources`、`runtime.retry`、`runtime.timeout`、`runtime.compaction`、`profiles`。

| # | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| L1 | 冻结 LD1–LD8，在 `notes/tech` 写技术设计、配置 schema 和规范差异清单（§12.1/§12.3） | - | done |
| L2 | 先写失败基线测试：在临时 HOME 预置冲突的 pi 配置（模型、凭据、工具、extension、skill、prompt、SYSTEM.md、祖先 AGENTS.md） | L1 | done |
| L3 | Mesh Provider/模型/凭据解析，fail-fast 校验，稳定错误码 | L1 | done |
| L4 | 隔离装配 ModelRuntime、CredentialStore、SettingsManager、ResourceLoader | L2, L3 | done |
| L5 | 修复工具白名单：空数组禁用全部内建工具，但保留 Mesh 工具 | L4 | done |
| L6 | 默认 profile + `profileRef` 解析；配置指纹不含 secret；定义恢复时模型变更的规则 | L3, L4 | 部分（指纹 done；profileRef/多 profile 后续方案） |
| L7 | 普通公共入口 + 保留高级 SessionFactory 路径；根导出、类型测试、API 快照 | L4, L6 | done（入口/导出/类型 done；API 快照并入 W01） |
| L8 | 按 LD3 调整依赖归属，验证 ESM/CJS 及 core-only 路径（与 W16 的 G08 合并验收） | L7 | 部分（归属+惰性加载 done；ESM/CJS+core-only 全矩阵并入 W16） |
| L9 | demo 改读 Mesh 配置，删除对 pi models/auth/settings 的镜像解析 | L7 | done |
| L10 | 更新 quickstart、README、错误消息和迁移说明 | L8, L9 | done |

**验收**：

- **隔离**：模型、地址、凭据都来自 Mesh；pi 的资源、扩展、工具、上下文都不加载；改动临时 HOME 不影响运行结果。
- **工具**：`builtinTools: []` 时内建工具不可用，Mesh 工具完整可用；开启单个内建工具时只多出该工具；profile 之间不串用工具。
- **凭据**：错误模型、缺凭据、错误 base URL 都有确定结果；错误提示只引用 Mesh 配置项；secret 不进入日志、事件、session、DB 或指纹。
- **用户路径**：空目录安装后不需要手动安装 pi；core-only 用户不需要准备 pi 配置。
- **demo**：改动 demo 后必须启动服务，在浏览器中验证正常配置、缺凭据、错误模型、空工具集和恢复路径。

**风险**：

- core 不得理解 LLM，配置只停留在包根和 pi 适配层。
- SDK 升级后可能重新读取全局配置，所以要逐个组件做污染测试并锁定版本。
- compaction（LLM 上下文压缩）不能与 mailbox 折叠混用。
- 示例配置只使用 `apiKeyEnv`，不内联明文 secret。

### 7.3 W01–W16

| WP | 覆盖 | 依赖 | 目标与关键验收 |
| --- | --- | --- | --- |
| W01 合同、能力探针、安全验证环境 | C01–C10；E 基线 | W00-L1 | 冻结 API、错误码、状态转换表；保存 API/DDL 基线快照。用真实 SDK 1.1.0 + faux 探针确认 P2 最终输入、hook 覆盖、磁盘 create/open 的**生产可行确认点**，没有就阻塞 W08/W11。先把测试、pack、tsup（`clean:true`）里的破坏性清理改成独立工作目录。**done**（2026-10-13：三个确认点全部可行、无 blocked，见 `notes/archive/2026-10-13-pi-1.1.0-probe-findings.md`） |
| W02 Store、迁移、运行故障 | N04、I05、I34、C07 | W01 | BEGIN 失败后可重试；先加锁再迁移；有备份、版本校验、逐脚本续跑；FTS 开关的新建/重开/升级矩阵；不可写、时钟回退、WAL 超阈值、损坏都有告警和停发边界 | **done**（2026-10-13：I05①/②、C07 备份+逐脚本续跑、N04 FTS 开关矩阵、I34 存储故障执行链均落地并有契约测试，见 §11） |
| W03 策略、信封、渲染 | N05、I06、I07、I33、I35、C03 | W02 | 信封三处一致；LogicalClock 接线；seal 生成与验签闭环；九个槽都覆盖正常、抛错、非法值、超时；NO_SESSION 不被改写；裸文本和定界符不能越壳 | **done**（2026-10-13：N05/I06/I07/I33/I35/C03 全部落地并有契约测试，见 §11） |
| W04 群治理、权限、订阅、配置 | N02、I13、I17、I18、I24、I30、C01/C04/C09 | W03 | 首聊被拒不留会话；最后的 setCaps 有保护；建群失败无半结构；未订阅者拿不到 topic 名单；mute 不 drop 也不唤醒；显式 offline 不被覆盖 | **done**（2026-10-14：九项全部落地并有 6 套契约测试，见 §11） |
| W05 单写者、拓扑、生命周期 | I01、I04、I15、I16、C02/C05 | W04 | 统一 writerId；死、活、损坏、不可读、PID 复用五种锁状态分别处理；配置重启不丢；exclusive 升降级后能正常写；close 失败时不先关 DB | **done**（2026-10-14：五项全部落地并有 4 套契约测试 24 条 + selector 两例断言更新，见 §11） |
| W06 邮箱转换、周期清扫、游标 | N01、I32、C01 | W05 | Host 调度不重叠、可停止；双 Host 通过 CAS 不重复终态；每次转换后缓存等于重算值；不重算 cursor_seq/folded_to_seq | **done**（2026-10-14：N01 定时器 + I32 缓存==重算/字节口径/游标 + C01 静音 silent 定档全部落地并有 2 套契约测试，见 §11） |
| W07 运输、持久派送意图、Sink | I02、I03、I31、C02/C09 | W06 | 崩溃窗口可重建意图；P1/P3 确认前不 done；失败时联动 delivery；端点之间不饥饿；Sink 有退避、稳定的幂等 token、无 handler 时 park | **done**（2026-10-14：I02 意图分流 + ack 下沉确认点、I03 keyset 认领 + 对账 + failed 联动、I31 档位透传 + 指数退避、C02 `Transport.stop`/C09 outbox 保留清理全部落地，见 §11） |
| W08 原文预算、P2、CATCHUP、唤醒 | N03、I08、I09、I10、I14；承接 I02 的 P2 部分 | W07、W01 探针 | P2 确认绑定端点、session、回合代次和实际集合；空摘要会清除旧 hook；CATCHUP 先持久化再消费；busy steer 不等于新开一轮，busy 起轮计数为 0。无法证明最终输入时停在 blocked | **done**（2026-10-15：五项全部落地并有 pi 契约 + core + e2e 测试，见 §11） |
| W09 请求应答 | I11、C06 | W08 | 用持久终态 + 事件闭环；快 ack、跨进程 ack、超时与归档竞争、重复或冲突 ack、合法 late 都只有一个正确终态 | **done**（2026-10-15：I11 端点绑定 + exclusive 租约 + 回程定向 + abandoned、C06 身份优先 + 幂等 + 合法 late、`request(await)` 持久终态恰好一次全部落地并有 core + e2e（含跨进程）测试，见 §11） |
| W10 Queue | I12、C06 | W09 | claim 校验加租约代次；payload 不可变；turn_end 不消费任务；1000 个任务无故障时每个恰好一次成功；死信可追溯 | **done**（2026-10-15：I12 + C06 的 claim 部分，见 §11） |
| W11 D03 权威恢复 | D03 | W10、W01 探针 | 真实 session 与 DB 双向核对，已有 entry 不重复应用；反复恢复结果相同；区分不了“在 SDK 队列里”还是“已丢失”时 park 并告警 | **done**（2026-10-16：D03 落地并有 core 4 条 + e2e 2 条测试，见 §11） |
| W12 Shared | I19、I20、I23、C04 | W04 | 按 4.2 节；10 个写者做 CAS；并发 append 不丢；删除、重建、裁剪组合下无唯一键异常；私有对象 key 不出现在群历史 | **done**（2026-10-16：I19/I20/I23 落地并有 1 新文件 10 条契约测试，见 §11） |
| W13 工具真实装配、公共类型 | I21、I22、I29、C08 | W11、W12、W00-L7 | 真实 SDK + faux 跑通 mesh 工具闭环；接上 W12 的通知；8KB 及更小的预算都返回合法 JSON；`.mts/.cts` 能消费根和 core 类型 | **done**（2026-10-16：I21/I22/I29/C08 落地并有 1 新文件 2 条 + 8 条契约测试，`.mts/.cts` 类型面消费并入 pack 冒烟，见 §11） |
| W14 Observer、事件、计数 | I25–I28、C10 | W13 | query_only 只读连接；C10 检查活 owner；事件、计数、trace 来自实际动作；`checkInvariants()` 只报告 | **done**（2026-10-17：I25 只读连接 + 活 owner、I26 事件合同测试 + 六处补发、I27 三计数器 + 两单位、I28 trace 可解释、C10 只报告 + StreamPort 结构校验全部落地，见 §11） |
| W15 本地整体验收 | V01–V06、本地 V08；回归 E01–E10 | W14 | G01–G07 可重复、可机器判定；所有集成用例结束时 16 条 SQL 断言通过；不允许 skip，也不允许把断言弱化成“数量 ≥1” | **done**（2026-10-17：`verify:local --all` 全门 full 通过、无 skip、exit 0，见 §11） |
| W16 0.1.0 本地包与文档闭合 | V07/V08、H01–H04、C07/C08 | W15 | 版本仍为 0.1.0；新增 `verify-local.mjs`、`verify-package.mjs`；实际离线安装 tarball；更新 README、示例、changelog；复核 69 项全部有去向 | **done**（2026-10-17：`verify:package` G08+G09 full 通过、无 skip、exit 0；真实离线 tarball 安装跑通「包根/core × ESM/CJS × 有无 pi + 真实文件 DB + 示例断言」；README/规范 H03/changelog/支持矩阵闭合、69 项全去向，见 §11） |

## 8. 门槛（G01–G09 已全部运行并通过：`verify:local --all` 与 `verify:package` 均 full 无 skip）

计划只新增两个入口：`npm run verify:local [-- --suite <G编号>]` 和 `npm run verify:package`，均已落地。full 模式下任何缺失、skip 或未运行都判失败。`npm run pack` 仍软链仓库内的 SQLite 依赖做冒烟，不作为 G08 证据（G08 由 `verify:package` 真实隔离 `npm install` 承担）。

| Gate | 通过条件 |
| --- | --- |
| G01 类型/分层/公共面 | typecheck 为 0；core 传递依赖中没有 pi；源码和双产物的禁用 API 扫描为 0；API 快照差异 100% 有说明；`.mts/.cts` 解析通过 |
| G02 存储/迁移 | 合成 0.1.0 基线库迁移与重开、空库、FTS 开关、高版本拒启、BEGIN 失败重试、备份完整性、双进程迁移锁全部通过 |
| G03 功能/权限/状态机 | 每个 N/I 都有合同测试，并通过真实 Host 调用；建立“gap ID → 测试 → 断言 → 结果”台账；每个集成用例结束时 16 条 SQL 断言通过 |
| G04 真实 SDK + faux | pi 0.85.1；F1–F5 七条事实、nextTurn 负面假设、P2 最终输入、CATCHUP、hook 覆盖、双端点与 abort、真实 mesh 工具、磁盘 open 全部通过；**W00 的隔离与工具验收**也在此执行 |
| G05 多进程/恢复 | 至少 2 个真实 OS 进程 + 真实 Pi 端口；6 个窄窗口故障点；100 个固定 seed、总重启 ≥100；核对 DB 与 JSONL，幂等键不重复 |
| G06 规模/成本/吞吐 | 8.1 节三个基准 + V05 的规模用例；正确性优先于速度 |
| G07 覆盖率/devMode/观测 | core 语句覆盖 ≥90%；投递、状态机、折叠、未读四个范围的分支覆盖各 ≥95%；默认策略下 `policy_degraded=0`、`invariant_violated=0`；故障注入的预期计数单独列出 |
| G08 tarball 消费者 | 离线安装；包根/core × ESM/CJS × 有无 pi；真实文件 DB 创建、重开、迁移；全部 examples 带结果断言；**W00 的用户路径**（不手装 pi，core-only 无需 pi 配置） |
| G09 交付一致性 | W00–W15 关闭，G01–G08 通过；69 项全部有去向；package、lock、`LIBRARY_VERSION` 均为 0.1.0；文档与支持矩阵准确；包内无密钥、DB 或运行数据。构建后源码有任何变化都要重跑受影响的门槛 |

### 8.1 基准口径

- **A：双 Agent、200 条交替 direct 消息**。由 oracle 确认合法起轮和原文均无遗漏；hot=2；不发生折叠。
- **B：30 成员、500 条固定 seed 消息，5% 是定向请求**。唤醒 ≤600；原文份数 ≤1500；hot 峰值 ≤4；静默率 >0.5；原文率 <0.25；busy 新增起轮为 0。delivery 总数按 oracle 求和，不硬写规范里的近似值 14500。
- **C：8 消费者、1000 个任务，无故障**。每个任务恰好一个成功 ack；claim 冲突率 ≤15%；超时回收为 0；dedup_hit 为 0；纯账本吞吐 ≥200 任务/秒。
- **测量口径**：预热 3 轮，测量 5 轮。硬门槛每轮都必须满足；吞吐和“相对正确基线退化不超过 20%”按 5 轮中位数判定；p95 只报告，不作门槛。不允许通过缩小数据规模、改用 mock 或直接插入终态行来过关。

### 8.2 本地矩阵

- **环境**：macOS arm64；Node 22.19.0/22.20.0；npm 10.9.3；pi 0.85.1（依赖归属以 LD3 的结论为准）。
- **升级基线**：从 HEAD 74e20c8 生成的合成 0.1.0 库，含消息、游标、claim、Shared 版本、拓扑等数据。
- 未覆盖的 OS、Node 或 SDK 版本，不算已支持。
- 签名、cap、mute、选端、Node/pi 范围、LLM 配置入口这些行为变化，都要写进消费者迁移指南。

## 9. 里程碑

| 里程碑 | 工作包 | 可验证的交付物 | 状态 |
| --- | --- | --- | --- |
| M0 合同与可行性 | W00-L1、W01 | LD 与 C 合同矩阵、SDK 探针结论、合成基线、安全的验证环境 | done（W00-L1、W01 已完成并有 §11 关闭记录；「合成基线」实为 G02 交付物——迁移/重开**机制**已由 W02 覆盖（备份、逐脚本续跑、锁先于迁移、高版本拒启），字面合成库留 G02/W15 生成） |
| M1 持久化与端点基线 | W02–W06、W00-L2–L6 | 事务、迁移、权限、锁、拓扑、调度的合同测试；pi 配置污染测试通过 | done（W02–W06 均已完成并有 §11 关闭记录与契约测试；W00-L2–L6 已于 W00 完成） |
| M2 端到端语义 | W07–W12、W00-L7–L9 | 运输、P2、请求、queue、Shared、恢复闭环；Mesh 配置公共入口 | done（W07–W12 均已完成并有 §11 关闭记录；Mesh 配置公共入口 `createMesh({llm,runtime})` 于 W00-L7 落地、根类型于 W13 C08 补齐；L9 demo 读 Mesh 配置） |
| M3 Agent 与观测闭合 | W13–W14、W00-L10 | 真实工具调用、只读观测、完整的事件、计数和 trace；用户文档只讲 Mesh 配置 | done（W13、W14 均已完成并有 §11 关闭记录；W00-L10 已于 W00 完成） |
| M4 本地综合验证 | W15 | G01–G07 报告，失败项为 0 | done（2026-10-17：`verify:local --all` exit 0） |
| M5 本地包就绪 | W16 | G08/G09、0.1.0 tarball、SHA-256、证据包 | done（2026-10-17：`verify:package` full 通过；tarball 已重建，SHA-256 落 `reports/verify-package.json`） |

每个工作包的关闭记录写明：关联 ID、所依据的合同、改动路径及 API/schema 影响、复现或反证测试、实际执行的命令与环境、结果、剩余风险。静态发现若被反证，保留撤回理由，不删除不利证据。

## 10. 风险与停止条件

| 风险 | 处理 |
| --- | --- |
| SDK 无法观察最终 context 或队列 | M0 阻塞；缩小合同须重新获得用户决定，不能静默把 D03/P2 延期 |
| LD3 与 C07 的依赖归属冲突 | L1 定案前不改 `package.json` 的 dependency/peer 声明 |
| 修改 §12.1 导致 core 理解 LLM | LLM 配置只停留在包根和 pi 适配层，core 仍只认 SessionFactory |
| 同步宿主策略阻塞，异步结果迟到 | 声明不可抢占的边界；用代次隔离迟到结果，计时器不等于取消 |
| 测试、pack、tsup 中的破坏性清理 | W01 先整改；所有测试产物放进本次独立目录；不删除用户路径 |
| 文件数据库迁移不可逆 | 迁移前停写并做一致性备份；失败即停止，保留现场 |
| C 类合同改变已有调用方的行为 | 写差异和迁移说明，用合成消费者测试覆盖 |
| 测试通过但生产路径没接线 | 真实 Host、真实 SDK、真实 OS 进程、实际 tarball 四层证据分开记录 |
| 性能、覆盖率或默认告警不达标 | 保留证据，不降低阈值、缩小数据或移出测试 |
| 范围扩大（顺手重构、升级 SDK、放宽门禁、改 pi 命名） | 暂停该工作包，说明差异和需要的决策 |

## 11. 进度记录

- 2026-10-12：整合 2026-10-09 实现差距审计、0.1.0 本地稳定版计划和 2026-10-12 LLM 配置计划，形成本计划；4 份已完成的早期 plan 和 2 份 review 移入 `notes/archive/`，三份被整合的原文随后删除（可从提交 `2b8890e`、`ee2704b` 找回）。源码自 74e20c8 起未变，审计结论仍然适用。记录了 LD3 与 C07 的冲突，待用户决策。未实施、未测试、未修改源码或依赖。
- 2026-10-13：**LD1–LD8 与 C07 已冻结**（用户定夺）：LD1=`createMesh({ llm, runtime })` 内部装配并保留高级 `policies.sessionFactory`；LD2=完全隔离，兼容开关显式开启；LD3=pi 走 `dependencies` 直接依赖、版本取**最新 1.1.0**（覆盖 C07 的 optional-peer，用户改写）；LD4=显式 `apiKey`/`apiKeyEnv`，不镜像隐式环境变量表；LD5=steer/followUp 由 Mesh 固定，retry/timeout/compaction 白名单开放；LD6=`Account.profileRef` 选 profile；LD7=本轮只消除配置/安装感知；LD8=demo 只读 Mesh 配置；C07=`engines.node>=22.19.0`、pi 矩阵 0.85.1→1.1.0。技术设计、配置 schema 与 §12.1/§12.3 差异清单见 `notes/archive/2026-10-13-mesh-llm-config-design.md`（W00-L1 完成）。
- 2026-10-13：**第 0 步完成**——pi SDK 0.85.1→1.1.0 升级并重新基线：`package.json` 移 pi 到 `dependencies@^1.1.0`（移除 optional peer）、`pi-ai@^1.1.0`、`engines>=22.19.0`；`scripts/pack.mjs` 的 Node 守卫与「可选 peer」文案同步。唯一行为断裂是契约探针 CT-F2：`agent_settled` 在 1.1.0 新增 `aborted:boolean`（仍无消息归因，F2 结论不变），按探针自身规则回 §2.3 复核后回调预期（`tests/pi/pi-contract.test.ts`）。结果 238/238 测试、`check:imports`、`pack`（离线消费者冒烟）全绿，demo 对 1.1.0 类型检查通过。W00-L2..L10 未开始。
- 2026-10-13：**W00-L2..L10 完成**——Mesh 统一 LLM 配置落地：新增 `src/pi/llm-config.ts`（`LlmConfig`/`ProviderConfig`/`RuntimeConfig`/`Profile`/`ResolvedLlm` 类型；`resolveLlmConfig` 同步 fail-fast，`MESH_BAD_CONFIG`/`MESH_MISSING_CREDENTIAL`/`MESH_UNKNOWN_MODEL` 走 `MeshConfigError{code}`；`configFingerprint` sha256 且剔除 secret）+ `tests/pi/llm-config.test.ts`。`src/pi/session-factory.ts` 新增 `createAssembledSessionFactory`（内存 CredentialStore、`modelsPath:null`、`refreshOnCreate:false`、内存 SettingsManager、`DefaultResourceLoader` 全 `no*`、`ModelRuntime.create`+`registerProvider`+`setRuntimeApiKey`+`getModel`；`agentDir` 用 `stateDir` 私有目录）与工具白名单配方（`builtinTools` + Mesh 工具名，`getCallableToolsFn()` 读权威名单）+ `tests/pi/session-factory.test.ts`（隔离 + 工具白名单 + faux 真实 turn 管线探针）。`src/index.ts` 新增 `CreateMeshOptions = MeshOptions & { llm?; runtime? }` 与 `createMesh({ llm, runtime })` 内部装配（core 契约不变，保留 `policies.sessionFactory` 高级路径）。demo（L9）改读 Mesh 配置：`demo/src/config.ts` 删除 pi models/auth/settings 镜像，`loadAndValidateDemo` 返回 `{config, resolvedLlm, fingerprint, credentialSource}` 并抛 ConfigError 作旧 `provider`/`modelId` 迁移提示；`demo/src/runtime.ts`/`demo/src/server.ts` 走新入口并加 `MeshConfigError` fail-fast（坏模型/缺凭据干净 exit(1)，secret 不入 health/指纹）。quickstart/README/start.sh/example 同步（L10）。结果 258 测试、`check:imports`、`typecheck`、`build` 全绿，demo 端到端（boot + health + 真实 LLM turn + 缺凭据/坏模型 fail-fast）验证通过。**测出并记录 faux 限制**：faux `streamSimple` 在请求含任何工具定义时无法流式（callCount=0），空工具集才走真实 turn 管线——真实模型无此问题（demo 已验证），契约层按「空工具」口径锁定。**留待后续**：L6 的 profileRef/多 profile 与恢复期模型变更规则（本轮单 profile 主路径，见设计文档）、L8 的 ESM/CJS+core-only 全矩阵 / 离线 tarball 验收（并入 W16-G08）、L7 的 API 快照（并入 W01）。
- 2026-10-13：**W01 完成**——合同冻结 + 能力探针 + 安全验证环境（第 ② 批硬闸门）。

  - **关联 ID / 合同**：C01–C10、E 基线；§7.10（错误码表）、§7.9（状态转换）、§12（API 面）、迁移只读规则。
  - **① 错误码 + 状态转换单一权威源（冻结不改名/不改字面量）**：`src/core/types.ts` 四族码由 `type X = "a"|"b"` 改为 `const ARRAY as const` + `type X = typeof ARRAY[number]`（`REJECT_CODES`/`PARK_REASONS`/`DROP_REASONS`/`TOOL_ERROR_CODES`）；`src/core/mailbox.ts` 的 `DROP_REASONS`/`PARK_REASONS`、`src/core/tools.ts` 的 `REGISTERED_CODES` 从 const 数组派生（`folded` 纯内部 drop 不下发工具面，仍排除）；`src/pi/llm-config.ts` 抽出 `MESH_ERROR_CODES as const` + `MeshConfigCode`，`MeshConfigError.code` 收紧为 `MeshConfigCode`（新增 `MESH_NO_SESSION_SOURCE` 并落在 `src/index.ts:344` 的 createMesh 装配校验）。**API 影响**：根导出新增 `MESH_ERROR_CODES`（值）+ `MeshConfigCode`（类型），core 入口经 `export *` 暴露四个 const 数组；公开类型名与字面量值不变。
  - **② API/DDL 基线快照**：新 `scripts/gen-snapshots.mjs`（TS compiler API 枚举 `src/index.ts` + `src/core/index.ts` 的值/类型导出 → `snapshots/api-surface.json`；`node:crypto` sha256 `migrations/000_init.sql` → `snapshots/migrations/000_init.sha256`；`--check` 漂移即 exit 1）。新 `tests/e2e/api-snapshot.test.ts`（3 tests：--check 一致 + 基线非空含关键符号 + sha 格式）。`scripts/pack.mjs` 第 2 步接入 `gen-snapshots --check`。**schema 影响**：只哈希、不改 `000_init.sql`（增量迁移留 W02+）。
  - **③ 三探针（真实 pi 1.1.0 + faux，结论见 `notes/archive/2026-10-13-pi-1.1.0-probe-findings.md`）**：`tests/pi/probe-p2-input.test.ts`（P2 最终输入**可确认**，确认点 = `context_with_system` 钩子）、`tests/pi/probe-hooks.test.ts`（session 事件 + 扩展钩子覆盖矩阵；`before_agent_start` 只走用户 prompt 路径、provider HTTP 钩子在 faux 下不点亮、`entry_appended` 不覆盖 sendCustomMessage）、`tests/pi/probe-disk-session.test.ts`（`getSessionFile()` create 点即确定、首条消息后落盘、open 同路径恢复同 id）。**无 blocked**，W08/W11/W13 不阻塞。
  - **④ 破坏性清理审计收口**：测试/三探针/pack 均 `mkdtemp`（临时 HOME/stateDir）、`finally` `rmSync`；tsup `clean:true` 只清 `dist/`；`.lock` 自清理。结论文本并入 findings 文档。
  - **命令与环境**：macOS arm64、Node 24.19.0（满足 ≥22.19）、pi 1.1.0。执行 `npm run typecheck` → `npm run check:imports`（G1–G4，21 源文件）→ `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 275/275（21 文件）**。
  - **剩余风险**：① 快照依赖 node_modules 中 pi 类型可解析（`skipLibCheck` 只解析不校验），冷 clone 后 `npm ci` 前 `--check` 会缺依赖——按 pack 前置（先 `npm install`）执行；② provider HTTP 钩子（`before_provider_request`/`provider_stream_event`）在 faux 下不点亮、真实 HTTP 会点亮，W08/W11 的确认点已刻意不选它们，但真实 provider 路径的这三钩子未在 faux 下复验（留 W13 真实装配一并覆盖）。

- 2026-10-13：**W02 完成**——Store/迁移/运行故障硬化（第 ③ 批，N04/I05/I34/C07）。

  - **关联 ID / 合同**：N04（FTS 可关闭）、I05（BEGIN 失败可重试 + 先加锁再迁移）、I34（存储故障执行链）、C07（升级迁移须备份）；§7.3/G02、§28.3（版本闸 + 迁移元数据）、§23.3/§12.5 末（告警通道复用）、G01–G04（分层/冻结门禁）。
  - **I05① `tx()` BEGIN 失败不残留**：`src/core/store.ts` `tx()` 重构——`inTx` 只在 `BEGIN IMMEDIATE` 成功后才置 1，BEGIN 抛错直接上抛且保持 0（调用方可整体重试）；commit/rollback 路径用 `finally` 归一 `inTx=0`。写/BEGIN 的致命失败（`READONLY/CORRUPT/FULL/IOERR/NOMEM/PERM/NOTADB/CANTOPEN`）上报 `not_writable`，`SQLITE_BUSY` 属可重试竞争、显式排除。新增 `tests/core/store-tx.test.ts`（第二连接占写锁制造真实 `SQLITE_BUSY`，证明不残留 + 重试成功 + BUSY 不计故障）。
  - **I05② 先加锁再迁移**：`src/index.ts` 启动顺序重组为 ① 抢实例锁（仅需 dbPath；`recoverDead` 的实例锁回收提前）→ ② `SqliteStore.open`（迁移/备份/版本校验/续跑）→ ③ 端点锁回收/探测（需迁移后的 `mesh_endpoints`）；失败统一 `store?.close()` + `instanceLock?.release()`。新增 `tests/e2e/lock-before-migrate.test.ts`（预占实例锁 → `createMesh` 抢锁失败且 DB 文件从未创建，证明锁先于迁移）。
  - **C07/I05 迁移前备份 + 逐脚本续跑**：`src/core/store.ts` `migrate()`——升级路径（hasMeta 且存在 pending 脚本、非 `:memory:`）先 `db.serialize()` 写 `<dbPath>.premigrate.bak` 并记 `mesh_meta.backup_path`，备份失败即抛错拒绝无保护迁移；逐脚本各自事务 + 同事务盖章 `migration:<file>` 语义保留。`OpenStoreOptions` 新增非公共测试缝 `migrationsDir`。新增 `tests/core/store-migrate.test.ts`（备份只作用于升级路径；双脚本第二脚本抛错后，续跑只执行未完成脚本）。版本校验「schema_version > library 拒启」既有测试保留。
  - **N04 FTS 开关**：新增 `MeshOptions.fts`（默认 true）与 `walMaxBytes`（默认 8 MiB）。`src/core/store.ts` 新增 `reconcileFts()`（运行时对账：`fts=false` 删 contentless 表、`fts=true` 缺表则建表+按 `COALESCE(json_extract(payload,'$.text'),payload)` 回填，meta 记 `fts_enabled`；**不改 `000_init.sql`**）、只读 `ftsEnabled`。`src/core/router.ts` FTS 插入以 `store.ftsEnabled` 门控；`src/core/observer.ts` `search()` 禁用时抛 `MeshUnsupportedError`（「功能关闭」），表缺失仍降级 `[]` 容错。新增 `tests/core/fts-matrix.test.ts`（新建/同 flag 重开/false→true 回填可搜历史/true→false 删表 + observer「功能关闭」与表缺失兜底）。
  - **I34 存储故障执行链**：新增 `src/core/health.ts`（**不导出**公共面）`StorageHealthGuard`，四故障码（`not_writable`/`clock_rollback`/`wal_over_threshold`/`integrity_failed`）统一「检测→告警→停发→恢复」。触发点：`tx()` 入口时钟检测 + 写失败分类、open 期 `checkHealth()`（clock + WAL 阈值 + `quick_check`）。`src/index.ts` 把 `guard.onFault` 接成既有 `invariant_violated` 事件（code=`storage:<code>`）+ 同名计数器（**不新增计数器/事件**）；`host.send` 在 `isStopSend()` 时抛 `InvariantViolationError("storage_fault", …)`，恢复自动放行；devMode 暴露 `_dev.injectFault/clearFault` 缝。新增 `tests/core/health.test.ts`（四故障注入→停发+告警+恢复；`query_only` 不可写、时钟回退两例真实检测）。
  - **API/schema 影响**：零新增导出符号、不改 `000_init.sql`（快照 `--check` 持续绿）；`fts`/`walMaxBytes` 是既有 `MeshOptions` 接口成员、`migrationsDir` 是 `OpenStoreOptions`（非公共面）成员。告警复用 `invariant_violated`（附录 E 23 计数器不变）。
  - **命令与环境**：macOS arm64、Node 24.19.0（满足 ≥22.19）、pi 1.1.0。执行 `npm run typecheck` → `npm run check:imports`（G1–G4，22 源文件）→ `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 294/294（26 文件）**（较 W01 增 19 条：store-tx 2、store-migrate 2、fts-matrix 7、health 7、lock-before-migrate 1）。
  - **剩余风险 / 留待**：① I34 的 `walMaxBytes` 默认 8 MiB 是本批拍板初值（规范附录 F.2 未定义该阈值）、`clock_rollback` 只做墙钟单调告警——seq/逻辑时钟权威接线是 N05/W03，届时统一时钟口径时复核；② 周期健康巡检（定时器）、「close 失败不先关 DB」「五种锁状态」属 W05/W06；③ G02 的「合成 0.1.0 基线库迁移与重开」字面合成库（§8.2 升级基线，含消息/游标/claim/Shared/拓扑数据）在 G02 门槛（W15）生成——W02 交付的是迁移/重开**机制**证明（备份、逐脚本续跑、锁先于迁移、高版本拒启），非该 fixture 本体。

- 2026-10-13：**W03 完成**——策略 / 信封 / 渲染（第 ③ 批下半段，N05 / I06 / I07 / I33 / I35 / C03）。

  - **关联 ID / 合同**：N05（LogicalClock 接生产链）、I06（信封四路径一致）、I07（seal 生成+验签）、I33（sessionFactory 自有 deadline + NO_SESSION 判型）、I35（M4 壳前置裸文本）与 C03（九槽失败合同）；§22.4（seal）、§20.1（sessionFactory 秒级 deadline + 逻辑钟接线）、§22.5（accessControl 唯一 fail-closed）、§20.2⑦（retention 降级不给原文）、§10.3/§23.7（M4 壳 + devMode 护栏）、§13（floor 回退 free_for_all）。
  - **I06 信封单点构造（新叶子 `src/core/envelope.ts`）**：把 `observer.ts` 的 `MessageRow` 全列镜像与完整 `rowToEnvelope`（ext/data/attachments/claim/seal/requestType/fromEndpoint/idempotencyKey 全保留）迁到新叶子，observer/`mailbox.ts`/`router.ts` 都向下引它（消除回边）。`observer` re-export 原符号（`rowToEnvelope`/`MessageRow` 冻结位置不变）。`mailbox.ts` `envelopeOf` 改「查行→`rowToEnvelope`」→ 重载/重试/重投不再丢 `payload.data`/`payload.attachments`；`router.ts` 删私有 `MessageRow`/`rowToEnvelope`，tombstone-original 随之拿完整信封；**写盘草稿补挂 `ext`**（`router.ts` draft 字面量），首投/跨进程 outbox/`message_routed` 都带 ext。
  - **I07 seal 生成 + 验签闭环（新叶子 `src/core/seal.ts`）**：`computeSealToken`/`sealValid`（HMAC-sha256 + `timingSafeEqual`，字段列 `i,c,s,f,t,k,e,to,m,r,ci,rt,lt,pd,ed`，`ed` 是**真 ext 摘要**——顺带修复「seal 盖空 ext」缺陷）。`MeshOptions.seal?: { key: string }` 提供即启用，key 仅内存、不落库/不入日志/事件/`configFingerprint`；`createMesh` 校验非空。路由签名用真 ext JSON。**验签挂在 `mailbox.envelopeOf`**（唯一「行→信封」咽喉）：`sealKey` 存在且 `row.seal != null` 才验，失败发 `invariant_violated {code:"seal_mismatch"}` + `invariant_violated` 计数器 + `return null`（拒绝投递、保留原行，不静默修复）；NULL 历史行放行不补签。
  - **N05 LogicalClock 接线**：`policies.ts` 加 `guardClock`（同步 `withPolicyGuard`，`compare`→有限数、`format`→字符串，throw/非法→`wallclock`；缺 format 按恒等）。接线四处：① `index.ts` 装配 `policies.clock` + 未给 renderer 时 `new DefaultRenderer(safeClock)`；② `renderer.ts` `DefaultRenderer` 增可选 `clock`，`ts = clock.format(logicalTs ?? routedAt)`；③ `mailbox.ts` 内建渲染器用守卫时钟；④ `observer.ts` `inboxOf`/`conversationsOf` 的 `lastAt` 排序改 `clock.compare`（seq 权威不动）；⑤ `tools.ts` `mesh_history` 的 `ts` 走 `BuildToolSetOptions.clock`。
  - **I33 sessionFactory 自有 deadline + NO_SESSION 判型**：`stream-port.ts` 加 `sessionWarmTimeoutMs`（PiStreamPortDeps 成员，默认 30_000；不进 `Limits` 以免漂移导出类型）与 `withWarmDeadline`（unref'd `Promise.race`），把 open/create/dispose 包进秒级 deadline；超时/抛错统一「释放写者锁 + `setEndpointLock(null)` + `setEndpointState("unavailable")` + `policy_degraded {slot:"sessionFactory", degradedTo:"unrecoverable", reason:timeout|threw}` + 抛 `NO_SESSION`（非 ENDPOINT_GONE）」。`mailbox.ts` 加鸭子判型 `isPortError(err,"NO_SESSION")`：`renderAndDeliver` 与 P3 `note()` 的裸 catch 改「NO_SESSION 则保留、否则 PORT_TIMEOUT」；`parkDelivery` 对 NO_SESSION 发 `invariant_violated {code:"no_session"}`，让「唯一要告警」语义落地。
  - **I35 M4 壳前置裸文本**：`renderer.ts` `verifyWrapped` 的 ok 条件加「去前导空白后 `startsWith(MSG_OPEN)`」——前置裸文本/前导空白+裸文本不再靠「恰好一个开/闭标记」漏过，一律走 `fixed` 重壳+`escapeDelims`；正文内嵌 `<<<END MSG>>>` 已转义不能越壳。`mailbox.ts` `renderForStream` 生产模式未包裹发 `invariant_violated {code:"renderer_not_wrapped"}` + 计数量后返回加壳文本，devMode 仍抛。
  - **C03 九槽失败合同收口**：`withPolicyTimeout`/`withPolicyGuard` 增第 4 参 `isValid`，返回值非法 → `onDegraded("illegal",…)` → 回退；`reason` 联合 `"timeout"|"threw"` → `"timeout"|"threw"|"illegal"`，并抽成命名导出 `PolicyDegradeReason`（types/policies/mailbox/router 四处复用）。逐槽 isValid/回退：delivery→`Grade` 三取一→silent；activation→boolean→false；endpointSelector→null|string|string[]→null（ENDPOINT_GONE）；floor→string[]→candidates（free_for_all）；renderer→string→内建包裹；clock→墙钟；accessControl→boolean→deny（fail-closed）；retention→`{bytes:number;ttlSeq?:number}`→**`{bytes:0,ttlSeq:-1}`（由 fail-open 改 fail-closed，§20.2⑦）**。accessControl 把各调用点 `?.() ?? true` 改「钩子缺失→放行；返回 undefined→`isValid` 判非法→deny」，`resolveCustomTag` 补 `withPolicyTimeout`+deny 守卫；`shared.ts` 的 `guardDeps` 补 `bumpCounter("policy_degraded")`、`SharedSpaceDeps` 增 `store`。
  - **新增源码**：`src/core/envelope.ts`、`src/core/seal.ts`（零 pi）。**新增测试（7 文件 54 条）**：`tests/core/envelope.test.ts`（6）、`tests/core/seal.test.ts`（5）、`tests/core/clock.test.ts`（8）、`tests/core/no-session-park.test.ts`（4）、`tests/core/renderer-shell.test.ts`（7）、`tests/core/policy-slot-matrix.test.ts`（21，九槽逐 describe 验 degradedTo/reason/计数器 + accessControl 三态 + resolveCustomTag 三态）、`tests/pi/session-warm-deadline.test.ts`（3，永不解 resolve 工厂→短 deadline NO_SESSION+unavailable+锁释放；按时解 resolve 不受影响；抛错仍 NO_SESSION，不依赖真 pi）。
  - **API/schema 影响**：零 schema 变更（`000_init.sql` 未动，seal 列既有；不新增计数器，复用 `invariant_violated`/`policy_degraded`，新的 `code` 是自由文本 `seal_mismatch`/`no_session`/`renderer_not_wrapped`）。公开面新增 **1 个导出类型 `PolicyDegradeReason`** + `MeshOptions.seal` 新成员——`reason` 联合扩展是成员级，但抽型名让 API 快照多一行，`gen-snapshots` 已重生成（见**偏差 ①**）。`sessionWarmTimeoutMs` 落在 `PiStreamPortDeps`（非公共面）。
  - **命令与环境**：macOS arm64、Node 24.19.0（满足 ≥22.19）、pi 1.1.0。执行 `npm run typecheck` → `npm run check:imports`（G1–G4，24 源文件）→ `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 348/348（33 文件）**（较 W02 增 54 条，即上述 7 文件）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① `PolicyDegradeReason` 命名导出**：计划写「reason 扩 `"illegal"` 是成员级、无新符号」，实现抽成命名类型（四模块复用更清晰），导致 API 面 +1 导出名，`snapshots/api-surface.json` 已重生成。属 §22.1 的显式扩展的一部分（`"illegal"` 是 W03 新增的降级原因，规范 §22.1 原文只有抛错/超时）。
    - **② sessionFactory 默认 30s**：计划 §4.1 拍板 30 秒、规范 §20.1 建议 ~5 秒，两者皆「秒级」，实现取 30s（`SESSION_WARM_TIMEOUT_MS`），记录偏离规范的 5s 建议值。
    - **③ retention 降级 fail-open→fail-closed**：`{bytes:0,ttlSeq:-1}`，§20.2⑦「不给原文」，与计划 §4.1「原文 bytes=0」一致（原实现是 `{bytes:MAX_SAFE_INTEGER}` 的 fail-open）。
    - **④ accessControl「undefined→deny」**：由 `?.() ?? true` 收紧为 fail-closed（§22.5），是计划 §4.1「accessControl deny」的落地，改变了依赖 `?? true` 的宿主预期（已用 contract 测试锁定「钩子缺失→放行」的例外）。
  - **剩余风险 / 留待**：① seal 密钥只覆盖「行→信封」重物化咽喉（投递/消费），首投内存信封与 observer 投影不验，跨进程 outbox 由 I02/W07 的异主路径承接后用 `message_routed`+重试路径复核；② `handleOutboxDelivery` 不 catch（NO_SESSION 上抛）保持现状、如需统一告警留后续批次；③ `canInitiateDirect` 仍无调用点保持 dormant（§6.1/§9.1 未接入，非 W03 范围）；④ G07「默认策略下 `policy_degraded=0`、`invariant_violated=0`」与 W14 的计数/观测统一在 W14 复核，本批只保证降级路径的 slot/reason/degradedTo 正确、计数器在对应 harness 里自增；⑤ devMode 未包裹抛错、生产加壳+告警的两种 `renderForStream` 行为只经 FakeStreamPort 契约级覆盖，真实 pi 端口渲染一致性由 W13/W15 真实装配复核。

- 2026-10-14：**W04 完成**——群治理 / 权限 / 订阅 / 配置 / 在场（第 ④ 批，N02、I13、I17、I18、I24、I30、C01、C04、C09）。

  - **关联 ID / 合同**：N02（canInitiateDirect 首聊漏接）、I13（订阅幂等 + canSubscribe + full 越过起点）、I17（topic 名单泄漏 + 群读权）、I18（最后 setCaps 丢失 + 建群原子性）、I24（§15.2 在场派生 + 显式 offline 被覆盖）、I30（fold 绕过全局上限 + claimTtlMs 不收紧）、C01（mute 保留 inbox 不唤醒）、C04（显式身份撤销「非成员跳过 cap」）、C09（无物理切除 + 不自投）；§9.1/§9.2（首聊隐式建链）、§12.2:1633/1651（remove setCaps 者须 dissolve、最后 setCaps 不可移）、§15.2（在场派生）、§16/§16.3（topic 订阅边界）、§7.10（mute）、§7.5（溢出折叠）、§9.4（配置只收紧）、§22.5（accessControl fail-closed）。
  - **acquire / 关键设计落地**：在场派生单一事实源收敛到 `registry.effectivePresence`/`derivePresence`（core 零 pi，`deriveStatus?: (id) => {busy; idleMs?}` 由 `index.ts` 注入 StreamPort 聚合）；显式 vs 派生用布尔列 `presence_explicit` 区分（迁移 `001_presence_source.sql`），不靠 presence 字符串猜测；N02 用「门前闸 + 空件回滚」（not 全量 Phase A/B 拆分）。
  - **改动路径**：
    - `src/core/router.ts`：`implicitDirectCreated` 标记 + `canInitiateDirect` fail-closed 闸（`ensureDirect` 前，deny→`CANNOT_INITIATE` 零落库）+ sender/initiate 两校验上移 materialization 前 + 本 route 新建且无消息行的空会话 `rollbackEmptyDirect`（删成员/inbox/会话行）。
    - `src/core/registry.ts`：`subscribe` 幂等（`ON CONFLICT DO UPDATE SET unsubscribed_at = NULL`，重复订保留原 `from_seq`、退订后重订只清退订标记）；`effectivePresence`/`derivePresence`/`safeDeriveStatus`/`setDeriveStatus`/`isExplicitPresence`，`setPresence` 置 `presence_explicit=1`；`normalizeConfig` 增 `claimTtlMs ∈ [1000, limits.claimTtlMs]`；`ensureDirect`/`createConversation`/`addMember` 各自入 `db.transaction`，`createConversation` 先校验 creator 已注册 + `groupSizeHardCap`（超→`FANOUT_TOO_LARGE` 无半结构）。
    - `src/core/mailbox.ts`：C01 静音不再 `dropDelivery(...,"MUTED")`，改 P1 唤醒判定 `if (muted) want = false`（保留 inbox/pending、不 steer/不 triggerTurn）；`presenceOf` 改委托 `registry.effectivePresence`，派生变迁（host 值→派生值）发一次 `presence_changed {source:"derived"}`（`lastPresence` Map 去重），`notePresence` 只同步不发射；`foldOverflow` 读路径 `MIN(COALESCE(json_extract(c.config,'$.maxPending'), ?), ?)` 兜底全局上限。
    - `src/core/types.ts`：`PresenceState` + `"online"|"idle"`（保留 `available`/`away` legacy 别名，本轮不改名）；`PortStatus` + 可选 `idleMs?`；`presence_changed` payload + `source:"host"|"derived"`/`until?`/`reason?`；`AccessControl` + 可选 `canSubscribe`。
    - `src/index.ts`：抽 `assertNotLastAdmin`（§12.2:1651），`groupLeave`/`groupRemoveMember`/`groupSetCaps` 复用；`groupRemoveMember` 对持 setCaps 目标加 `requireMemberCap(conv, by, "dissolve")`（§12.2:1633）；`topicSubscribe` 走 `canSubscribe`（fail-closed deny→`JOIN_DENIED`）；`history()`/`members()` 补 read cap（`HISTORY_FORBIDDEN`）与 topic 订阅者边界（`NOT_A_MEMBER`）、topic `lower = sub.fromSeq - 1` 无条件；`requireMemberCap`/`assertSubsetCaps` 非成员由静默跳过改 `NOT_A_MEMBER`、缺 cap 升级 `CAP_REQUIRED`（`@system` 代行仍可信）；`setPresence` 补 `source:"host"` + `mailbox.notePresence`；registry 构造注入 `deriveStatus` 聚合端口状态。
    - `migrations/001_presence_source.sql`：`ALTER TABLE mesh_accounts ADD COLUMN presence_explicit INTEGER NOT NULL DEFAULT 0`（增量机制自动套用，随 `migrations/` 发布）。
  - **复现/反证测试（6 套 29 条，每个 concern 一文件，均契约式）**：`n02-first-msg-rejected`（5：canInitiateDirect false/undefined 均 fail-closed + 零落库；initiate 集不含 kind、canSend false 均回滚空会话；钩子缺失放行）、`subscribe-admin`（6：订阅幂等保留 from_seq；canSubscribe false→JOIN_DENIED；topic 未订阅者 members/history→NOT_A_MEMBER；无 read→HISTORY_FORBIDDEN；full 仍受订阅起点下界）、`group-admin-invariant`（6：remove/setCaps 移最后 setCaps→NO_ADMIN_LEFT；remove setCaps 者无 dissolve→CAP_REQUIRED；超 hardCap→FANOUT_TOO_LARGE 无半结构；非成员 by→NOT_A_MEMBER；@system 代行放行）、`presence-derive`（5：busy/online/idle/offline/派生、sink→online、显式 offline 不被覆盖、显式 dnd 在 until 内优先、until 过期回落+isExplicitPresence=false、过期回落发一次 source:derived）+ 派生变迁 `presence_changed` 经 mailbox.harness 锁定）、`config-clamp`（4：claimTtlMs 夹 [1000, 全局]、ensureDirect 写 normalized、maxPending 不超全局、注入 999 的 raw config 仍按全局 4 折叠 overflow=3/pending=2）、`c09-no-prune`（3：dissolve 归档留会话+消息行、退订软删留行且 listSubscribers 排除、topic 发送方无自投 P3 行）。
  - **API/schema 影响**：新增迁移文件 `001_presence_source.sql`（**不改 `000_init.sql`**，快照 `--check` 持续绿对照）；零新增导出符号——`PresenceState`/`AccessControl`/`PortStatus`/`presence_changed` 扩的均为**成员级**（不漂移 API 快照），复用既有错误码（`CANNOT_INITIATE`/`NOT_A_MEMBER`/`NO_ADMIN_LEFT`/`CAP_REQUIRED`/`FANOUT_TOO_LARGE`/`JOIN_DENIED`/`HISTORY_FORBIDDEN`，W01 冻结不解冻）。
  - **命令与环境**：macOS arm64、Node 24.19.0（满足 ≥22.19）、pi 1.1.0。执行 `npm run typecheck` → `npm run check:imports`（G1–G4，**24 源文件**）→ `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 377/377（39 文件）**（较 W03 增 29 条，即上述 6 文件）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① I13 订阅幂等的字面**：计划写 `ON CONFLICT DO NOTHING`，实现用 `DO UPDATE SET unsubscribed_at = NULL`——比字面 DO NOTHING 更正确：退订后重订重新激活（清退订标记）且保留原 `from_seq`，避免「退订即永不可再订」。已用契约测试锁定两条（重复订保留起点、退订后重订也保留起点）。
    - **② C15 与 §12.2 管理员不变量不一致（留 W16 统一）**：C15 observer 校验管理员位是 `dissolve`，§12.2:1651 权威不变量是 `setCaps`——本轮按 §12.2 实现护栏、C15 SQL 不动，记入 spec 一致性 H 项。
    - **③ PresenceState 只加成员不改名**：保留 `available`/`away` 作 legacy 别名，仅新增 `online`/`idle`（approved「+2 members」路线，避免 ~35 处测试枚举漂移 + 快照改动），重命名留 W16。
  - **剩余风险 / 留待**：① `presenceIdleMs` 派生粒度依赖端点 `last_active_at`（状态转换粒度，非逐消息刷新）——逐消息粒度需 StreamPort 暴露 session 级 idle 时长（`PortStatus.idleMs` 可选成员已留位，接 pi 对齐留后续）；② I13 的 mentions 完整可见性在 W08 上下文集成时收口（计划 §6.2 已标）；③ I18 的「限额/失败原子性更完整」由 W05/W06 承接；④ topic 发送方自投断言覆盖的是「发布者非订阅者」常态（§12 topic 权威投递集=订阅者夺集），发布者亦订阅时的自投语义未改（留 spec 复核）；⑤ 静音成员消息仍进 inbox 属「不唤醒」语义，期末未 turn 则保持未读——这与 §7.10 一致，但宿主若期待「mute=不可见」需注意行为由 drop 改为保留。

- 2026-10-14：**W05 完成**——单写者 / 拓扑 / 生命周期（第 ④ 批上半段收尾，I01、I04、I15、I16、C02、C05）。

  - **关联 ID / 合同**：I01（Host 与 PiStreamPort 各自生成 writerId、自动 warm 不注册 handler）、I04（锁缺失/损坏/不可读都被当 dead）、I15（selector 只取首项、pooled 恢复丢 size/affinity）、I16（热流不能升级 exclusive、到期不同步锁、close 顺序、abort 归因）、C02（external 不 auto-warm、sameHost 只面向 stream、自定义 Transport 能力合同）、C05（perConversation 账号+scope+key 精确匹配、无匹配则 park、分片由 pooled 承担）；§19.6（锁残留 pid 复用「绝不猜」）、§22.1/§23.7（告警复用 `invariant_violated`、降级复用 `policy_degraded`）、§20.2（endpointSelector 非法回退 null = ENDPOINT_GONE）。
  - **I01 统一 writerId + onWarmed**：`PiStreamPortDeps` 增 `writerId: string` 与 `onWarmed?(endpointId)`（pi 内部 dep 面，非公共导出）；端口删私有 `this.writerId`，`doWarm` 抢锁与后续改用注入的 `this.d.writerId`，建流成功后调 `onWarmed`；`index.ts` 在构造端口处传入 host writerId，transport handler 注册统一收敛到这一个 `onWarmed`（补上自动 warm 缺的注册），`host.warm` 删重复注册。
  - **I04 五态锁判定**：`EndpointLock` 新增 `inspect()`（判别联合 `missing`/`corrupted`/`unreadable`/`ok`），`readInfo` 保留（`acquire` EEXIST 分支语义不变）；`ownerIsLive` 改返回 `"alive"|"dead"|"unknown"`——missing→dead、corrupted/unreadable→unknown、ok 后 pid 存活 + `procStartedAt` 比对（pid 死或启动时刻不符→dead、取不到→unknown、吻合→alive）。`recoverDead` 只扫 stream 端点，仅 `dead` 强制回收，`unknown` 发 `invariant_violated {code:"endpoint_lock_undetermined"}` 并拒绝接管；`isEndpointLocal`/`reclaimEndpoint` 改五态：corrupted/unreadable 判非本地（走 outbox，不猜）。
  - **I15/C05 拓扑持久 + 精确匹配 + 满数组 + 归属校验**：迁移 `002_pool_meta.sql`（`mesh_endpoints` 加 `pool_size INTEGER`/`pool_affinity TEXT`，增量机制套用，不改 `000_init.sql`）；`registerEndpoint`/`registerPooledEndpoints` 落 size/affinity/slot（`pool_slot` 按 `COUNT(*)` 自增，同事务），`rowToEndpoint` 读回（legacy 行回退 size=1/affinity="none"）；`TopologyEndpointSelector` perConversation 删 hash 兜底与回退首条、精确匹配补 scope 条件、无命中 null（park），pooled 分支 `filter(kind==="pooled")` 按 `ctx.topology.size` 取模（id 有序稳定分片）、`none` 取 inFlight 最小；`mailbox.deliverOne` selector 结果归一为数组、逐端点 `registry.getEndpoint` 校验存在且 `accountId === row.account_id`（非法剔除计 `policy_degraded`、剔除后空→ENDPOINT_GONE），满数组投递（首端点走既有行，其余插 `state='queued'` 行，仅首端点可醒）。
  - **I16 升级/同步/close 全有全无/归因映射**：`warm` 命中已热 shared 且请求 exclusive 时改走升级（`applyLease` 切 exclusive + `lock.setLease` 重写锁文件）；`applyLease` TTL 到期降级同步重写锁文件为 shared/null 再降 DB/`rec.lease`；`close()` 包 try/finally（`port.dispose()` 抛错仍释放 instanceLock、关 store，收尾后重抛首个错误）；端口错误→park 原因映射 `NO_SESSION→NO_SESSION`、`ENDPOINT_GONE→ENDPOINT_GONE`、`LOCK_HELD→LEASE_HELD`、`NOT_HOT→PORT_TIMEOUT`（全冻结码），`handleOutboxDelivery` 包 try/catch、失败 park 对应 delivery 行（归还因）不回 ack。
  - **C02 能力门**：自定义 `Transport`（非内置/`"sameHost"` 字符串）起步校验 `subscribe`/`publish`/`ack` 为函数（`stop` 存在即校验），缺能力创作时拒绝（复用 `MeshConfigError`，无新码）；external 走 `deliverToSink`、无 handler → `NO_SINK_HANDLER` park、不 auto-warm。
  - **复现/反证测试（4 套 24 条，每个 concern 一文件，均契约式）**：`lock-states`（12：`inspect` 判别联合 + `ownerIsLive` 五态——损坏/不可读→unknown 绝不死、pid 复用→dead、缺失→dead、pid 存活启动时刻吻合→alive、取不到启动时刻→unknown）、`topology-persist`（6：registerPooledEndpoints 落 size/affinity/槽位且重开不丢、registerEndpoint 逐条自增槽位、legacy NULL 行回退 size=1/affinity=none、pooled 分片稳定、混有 unified 只按 pooled 分片、无 pooled → null）、`stream-port-lease`（4：锁文件 writerId=注入值、shared→exclusive 升级锁/DB 一致仍能写、exclusive TTL 降级锁文件回 shared + DB 清空、close 遇 dispose 抛错仍释放实例锁且同 dbPath 可重启，不依赖真 pi）、`samehost-writerid`（2：同 dbPath 双进程自然 warm——同进程 warm 端点判本地直派不绕 outbox、他进程 warm 端点经 outbox 对端 handler 收到；external 无 handler → NO_SINK_HANDLER、不触发 stream warm）。`selector.test.ts` 两例断言由「hash 兜底/回退首条」改为「无命中 → null（park）」。
  - **API/schema 影响**：新增迁移 `002_pool_meta.sql`（不改 `000_init.sql`，快照 `--check` 持续绿）；零新增导出符号、零新增 park/drop 原因码、零新增计数器名（告警复用 `invariant_violated`、降级复用 `policy_degraded`）；`PiStreamPortDeps.writerId`/`onWarmed` 是 pi 内部 dep 面，不漂移 API 快照。
  - **命令与环境**：macOS arm64、Node 24.19.0（满足 ≥22.19）、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 402/402（43 文件）**（较 W04 增 4 文件 24 条）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① samehost-writerid 的 I01 用例按发送方排除规则重构**：计划字面「B 发消息经 outbox 被 A 的 handler 收到」，但 fanout 权威投递集是「to ∪ mentions − sender」（router 对 sender `recipientSet.delete(from)`）——**发送方自身不产生投递行**。原写法让 A 既是发送方又是验证目标，导致断言失效。重构为两个方向：①同进程观众——单 host 双账号，C 发给 A，断言 A 的端点被直派（无 `mesh_outbox` 行、`parked_reason` 为空）即 I01 的「自己的端点不被误判异主」；②跨进程——A 进程 warm 的端点 B 由 A 进程判远程，A 发给 B 经 outbox 由 B 进程 poller/handler 收下（done）。语义等价，只换 send 方向。
    - **② 跨进程用例 warm 取 shared 而非默认 exclusive**：`PiStreamPort.warm` 默认 `exclusive` 会落 `lease_until`，触发 mailbox 的 `LEASE_HELD` 停车（唯一持锁者才有独占写权），导致投递永不达 outbox。I01/I16 的跨进程收发验证使用 `host.warm(epId, "shared")`（常规投递用 shared，exclusive 供宿主独占写），这是既有租约语义而非实现变更。
    - **③ 数组满投递 + 归属校验为 I15 主路径**：selector 结果数组里每个端点都校验归属（`accountId === row.account_id`），非本账号/未知端点剔除；满数组投递对 P1/P3 即投、P2 多端注入留 W08（与计划 §「未决/留待后续」一致）。
  - **剩余风险 / 留待**：① pid 复用判定依赖 `ps lstart` 格式（macOS/Linux 可用、漂移时归 unknown 保守拒绝）——既定护栏非缺陷；② `handleOutboxDelivery` 的 catch 已把失败 park 回对应 delivery 行，但其「归还因」到宿主观测面的最终呈现与 W07 运输面合同对齐时复核；③ 自定义 Transport 的「归属/订阅/确认/关闭完整合同证明」本轮只做能力存在校验，双写/生命周期属 W07；④ P2 多端注入语义仍留 W08 上下文集成；⑤ `recoverDead` 的 `unknown` 告警用 `invariant_violated` 自由文本 `code`，未新增计数器，观测面板聚合口径在 W14 统一时复核。

- 2026-10-14：**W06 完成**——邮箱转换 / 周期清扫 / 游标（第 ④ 批，N01、I32、C01）。

  - **关联 ID / 合同**：N01（运行期周期清扫定时器）、I32（pending→dropped 不扣缓存 + 游标清理偏宽 + 字符/字节混用）、C01（静音强制 `grade = silent`）；§7.9（parked TTL）、§7.5（溢出折叠）、§8.4（缓存列 vs 权威列）、§16.3 规则 3（退订游标置 `next_seq`）、§9.5:1718/1724（静音 → silent、silent+冷流 → park）、§22.1（C5 缓存一致不变量）。
  - **I32 单点真相重算**：`src/core/store.ts` 新增 `recomputeInbox(accountId, conversationId)`——`recomputeInboxCaches()` 的单 (account,conv) 版本：重算 `pending_count`/`pending_bytes`/`overflow_count` 三列缓存（`LENGTH(CAST(m.payload AS BLOB))` UTF-8 字节口径、含 `routed`），**绝不触碰** `cursor_seq`/`folded_to_seq`（权威）与 `verbatim_bytes`（发送方预算、不受投递状态转换影响）/`overflow_summary`（无法从行重建）。
  - **I32(a) pending→dropped 逐点重算**：`mailbox.dropDelivery`（TTL/TRANSPORT_FAILED 等）UPDATE 前读旧 state、属 `PENDING_STATES` 则 UPDATE 后经消息关联取 (account,conv) `recomputeInbox`；`index.requeue` 先 `SELECT DISTINCT account_id, conversation_id` 收集受影响行、裸 UPDATE 后逐条 `recomputeInbox`；`router` tombstone 用已收集的 `tombDropped`（account_id 去重）+ `tombOriginal.conversationId` 逐个 `recomputeInbox`。`claim recycle` 的 MAX_ATTEMPTS 死信 `claimed` 不在 `PENDING_STATES`，无缓存需重算（代码注明）。
  - **I32(b) 游标推进下沉为显式权威行为**：`resetInboxPending` 退化为纯 `store.recomputeInbox`（删掉 `cursor_seq = MAX(cursor_seq, maxPendingSeq)` 越界推进与 `overflow_count=0` 清空）；`markConsumed`（sink 单条消费）显式 `cursor_seq = MAX(cursor_seq, 本条 m.seq)`；`maybeCatchup`（唯一「固化摘要」清折叠点）`cursor_seq = MAX(cursor_seq, spanTo)` + `overflow_count=0, overflow_summary=NULL`；`topicUnsubscribe`（`index.ts`）清零语句改 `cursor_seq=(SELECT next_seq FROM mesh_conversations WHERE id=?)`（非 0，§16.3 规则 3）+ 顺带清 overflow。`handleTurnEnd` 原有的显式游标推进不变、现在不再被越界覆盖。
  - **I32(c) 字节口径**：`foldOverflow` 的折叠字节数由 `LENGTH(m.payload)`（字符数）改 `LENGTH(CAST(m.payload AS BLOB))`（UTF-8 字节），与初始 `Buffer.byteLength(payloadJson)` 增量及真相口径一致。
  - **C01 静音定档**：`mailbox` 在策略定档后、背压降级前加 `if (muted) grade = "silent"`（§9.5:1718），配合既有 `if (muted) want = false`（§7.10 压制唤醒）与冷流 silent→park（§9.5:1724）；静音是显式关闭，urgent 也不破。
  - **N01 周期定时器**：`Limits` 增 `sweepIntervalMs`（默认 30000，`0`=禁用；`validateLimits` 收口 0 或 [1000, 86.4e6] ms 与 `DEFAULT_LIMITS` 同步）；`createMesh` 维持启动一次性 `await mailbox.sweep()`，之后若 `sweepIntervalMs > 0` 起一个 `.unref()` 的 `setInterval` 调 `mailbox.sweep()`，前置 `sweepBusy` 布尔守卫防重入（上一轮未完成时跳过本轮，满足「不重叠」）；`close()` `clearInterval` 停止调度（可停止）。
  - **复现/反证测试（2 套 9 条，每 concern 一文件，均契约式）**：`tests/core/mailbox-cache.test.ts`（6：TTL drop 后 pending_count/pending_bytes 归零且 ==重算值；折叠非 ASCII（emoji/中文/阿文）载荷后 pending_bytes == BLOB 真相且 char<byte 证明用例可区分 + recompute 幂等；markConsumed 只推本 seq 不越界到更高未消费 seq；CATCHUP 固化清 overflow_summary/overflow_count 且游标到 spanTo；mute 冷流 → silent+park 不 warm；mute 热 direct → silent+不醒即 woke=0/wakeCount=0）、`tests/e2e/sweep-timer.test.ts`（3：无手调 sweep 下周期定时器把过期 parked 落 dropped(TTL_EXPIRED)；close() 停表后过期 parked 仍 parked；topicUnsubscribe 清 pending/overflow 且 cursor_seq == 当时 next_seq 非 0）。
  - **API/schema 影响**：零 schema 变更（不改 `000_init.sql`，快照 `--check` 持续绿）；零新增导出符号 / park·drop 原因码 / 计数器名（告警与降级复用既有）；`sweepIntervalMs` 是 `Limits` 接口成员（`gen-snapshots` 只枚举导出名、不枚举接口成员，快照不漂移）；`SqliteStore.recomputeInbox` 是类方法（非新导出名）。
  - **命令与环境**：macOS arm64、Node 24.19.0（满足 ≥22.19）、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 411/411（45 文件）**（较 W05 增 2 文件 9 条，即上述两文件）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① foldOverflow 字节口径修复是本批补上的一处**：计划「实现步骤 1」只列了 `resetInboxPending` 委托 `recomputeInbox`，未单独列出 `foldOverflow` 的手工扣减（`foldedBytes`）仍用字符数口径；若不修，折叠后 `pending_bytes` 恒大于重算值（非 ASCII 下字节>字符），违背本批「每次转换后缓存 == 重算值」。故补上 `LENGTH(m.payload)→LENGTH(CAST(m.payload AS BLOB))` 这一行修复并加契约测试锁定。
    - **② C01 使「静音+预算内+冷流」从投递升温变为 silent-park**：强制 `grade=silent` 后，静音订阅者收预算内消息不再即时投递升温，而是与 A3 限流/背压降级同一 `grade==silent && cold → park`（park 非终态，warm/拆封后仍可见）。这是 §9.5:1718「mutedUntil>now → silent」的直接后果；与 §9.5:1724「`!wake && !verbatim` 才只写 Inbox」的表面张力（预算内=verbatim 的静音消息严格按 1724 应即时可见）记为文档决策，不在本批扩散。
    - **③ 定时器最短间隔 1000ms**：计划测试示例写 `sweepIntervalMs: 50`，但 `validateLimits` 收口为 0 或 [1000, 86.4e6] ms（与其它毫秒级 limit 的秒级下限一致，0=禁用）。e2e 测试改用「回填 `parked_at` 为远古时间戳」使「定时器在跑则下一轮必落 dropped」成为确定性判定，不依赖等满 `parkTtlMs` 下限 60s。
  - **剩余风险 / 留待**：① §9.5:1724 与静音+verbatim 张力（见偏差②）留后续 §9.5 对齐时一并审视 `mailbox` silent+冷流守卫是否补 `&& !verbatim`；② §16.3 规则 2/3 delivered-in-flight 退订边缘——退订不回收 `delivered`（规则 2）、清零 `pending_count` 后若尚存 delivered 行 C5 口径短暂不一致，属规范内在张力、不在本批扩散（测试暴露再立专项）；③ 多 Host 共享 DB 各自起定时器「CAS 不重复终态」依赖 SQLite 串行写 + sweep 六步原子 WHERE 守卫 UPDATE，未做专门的多进程周期 sweep 竞态测试（留 G05/W15 复核）。

- 2026-10-14：**W07 完成**——运输 / 持久派送意图 / Sink（第 ⑤ 批，I02、I03、I31、C02/C09）。

  - **关联 ID / 合同**：I02（outbox 接收侧不区分 P1/P2/P3 且 `deliver` 返回即 done）、I03（COMMIT 后 publish 崩溃窗口孤儿 + publish 抛错中止 fanout + outbox `failed` 不联动 delivery + poller 前 50 饥饿）、I31（sink 硬编码 `followUp` + 首次拒收即 park 无退避）、C02（Transport 生命周期/close 合同只 `instanceof SameHostTransport`）、C09/§19.3（outbox done 行按保留窗口清理且不物理裁剪消息账）；§19.2/§19.3（Transport 合同、outbox 状态机）、§7.6（ContextPath P1/P2/P3）、§7.2（delivery grade 矩阵）、§7.9/§7.10（delivered/attempts 判据）、§12.1（C02 关闭合同）、§21.2（SinkHandler 拒收退避 + 稳定幂等 token）。
  - **I02 持久派送意图 + 确认前不 done**：`types.ts` `PendingDelivery` 增 `path?: ContextPath` 与 `woke?: boolean`（跨主随 outbox payload 持久化发端已定稿的意图，接收/恢复侧不重定档）。`mailbox.deliverToEndpoint` 把 P2 分流提到 outbox 之前（P2 是「留共享 Inbox、激活时注入」，收件箱在共享 DB，无需 outbox 搬运）——`path === "P2"` → `noteVerbatimExit` + 停留 queued（真实确认由 W08 承接），不再 publish，本地与跨主行为一致；`!isLocal` 且 path ∈ {P1,P3} 才 publish（payload 带 `path`/`woke`）；publish 包 try/catch（见 I03①）。`handleOutboxDelivery` 按 `d.path` 分流——P3 → `port.note` + `markDelivered`（note 写妥即确认点）；P2 → `noteVerbatimExit` + `transport.ack("delivered")`（留痕是唯一载体副作用）；P1 → `port.deliver(..., { triggerTurn: !!d.woke })` + 写 handoff/entry_id，**删除 resolve 时 ack**。`markDelivered`（`queued|routed → delivered` 唯一咽喉）在 `changes > 0` 时 `void transport.ack(deliveryId, "delivered")`——InProcessTransport.ack 是 no-op、SameHostTransport.ack 才落 done，使「done」严格 == 「mesh_deliveries 已 delivered」（P1=entry_appended、P3=note 完成、sink=accepted），符合「P1/P3 确认前不 done」。修正 `tests/e2e/samehost.test.ts` 两处 `expect:"none"` → `expect:"ack"` + `to:["B"]`：让 B 进原文预算内走 P1 全文，真正的跨进程全文路径，并保留「投递后 outbox done」断言（现在由 markDelivered 完成，非 resolve）。
  - **I03 崩溃恢复 / 两层一致 / 不饥饿**：
    - **① publish 抛错不中止 fanout**：`deliverToEndpoint` 的 `!isLocal` publish 分支包 try/catch，抛错时该 delivery 留 `queued`（不 park/drop，紊「publish 失败」冻结原因码不新增），交由 sweep 对账恢复。
    - **② sweep 对账 `reconcileOutbox`（独立函数，接在 reclaim 之后）**：(a) 孤儿意图重建——选出 `state='queued' AND endpoint_id IS NOT NULL AND NOT EXISTS(mesh_outbox.delivery_id=d.id)` 的行，`isEndpointLocal` 判跨主后按已定稿 `path/grade/woke` 重发 `publish`（恢复 COMMIT→publish 崩溃窗口 + publish 抛错）；(b) outbox `failed` 联动——`SELECT delivery_id FROM mesh_outbox WHERE state='failed'`，对仍非终态（未 delivered/dropped/consumed）的 mesh_deliveries 行 `dropDelivery(TRANSPORT_FAILED)` 补上两层一致。
    - **③ poller 消除前 50 饥饿**：`transport.ts runPollCycle` ③ 由 `ORDER BY delivery_id LIMIT 50`（取窗后才过滤本地 handler，其它端点/进程积压会让本进程饥饿）改为 keyset 分页认领循环——`WHERE state='ready' AND delivery_id > ? ORDER BY delivery_id LIMIT 50`，每页先 `JSON.parse(payload)` 取 endpointId 找本地 handler（找不到只推进游标不认领），游标推进到页尾继续下一页，直至取空或达到单轮认领预算 `maxClaimsPerCycle`（新 `SameHostTransportOpts` 成员，默认 50）；每个周期遍历**全部** ready 行而非只看前 50。死信 ② 与回收 ① 不变。
  - **I31 Sink 档位透传 + 指数退避（免 Floor）**：新增 `gradeForSink` 助手——`deliverOne` 的 sink short-circuit（`endpointClass !== "stream"`）在定档/选端/Floor/唤醒**之前**触发，故 sink 天然免 Floor（接收方无 Floor 概念）、不经端点选择/唤醒；助手调 `policies.delivery.grade`（`verbatim:true`、最小 inbox、`memberCount`）+ 静音 silent 覆盖，返回真实 grade。`deliverToSink` 用该 grade 落库并传给 `handler.deliver`（删 `"followUp"` 硬编码）。拒收/抛错走 `sinkRefused`：`attempts+1`；`attempts >= maxAttempts` → `park(SINK_REFUSED)`（宿主重注册经 `retryAccount` 恢复，否则 TTL）；否则留 `queued` + `note='sink_backoff'` + `queued_at` 刷新为退避起点。sweep 新子步 `retrySinkBackoff`：选 `state='queued' AND note='sink_backoff'` 且 `queued_at + backoff(attempts) <= now` 的行，清 note 后按已定稿 grade 重投。`backoff(attempts) = min(sinkBackoffBaseMs * 2^(attempts-1), sinkBackoffMaxMs)`（新 `Limits` 成员，默认 1000/30000，`validateLimits` 收口）。幂等 token 稳定：重投与首投都由 `envelopeOf(message_id)` 重读同一 `mesh_messages` 行得到同一 `id`/`idempotencyKey`（契约测试锁定）。
  - **C02 / C09 生命周期与保留清理**：`Transport` 接口加可选 `stop?(): void | Promise<void>`（可选，不破坏既有自定义实现类型）；`InProcessTransport` 补 no-op `stop()`；`MeshHost.close()` 由 `if (transport instanceof SameHostTransport) transport.stop()` 改 `await transport.stop?.()`（与 transportSubs 清理同段，早于等在途收敛）。`pruneOutboxDone`：`DELETE FROM mesh_outbox WHERE state='done' AND claimed_at < now - outboxDoneRetentionMs`（新 `Limits` 成员，默认 86400000，`0`=不清理）——**仅删 outbox 载体行**，`mesh_messages`/`mesh_deliveries` 台账一行不删（C09 红线）；`failed` 行不得自动清理（§19.3 排障证据）。保留窗口时间戳用 `claimed_at` 近似「最后活动时刻」（done 行无专用 `done_at`，认领即投递窗口、紧邻 done，偏差 ≤ 保留窗口，排障 24h 定位够用）——**选 (a) 不改 schema**，未引入 `done_at` 迁移。
  - **复现/反证测试（3 处 7 条）**：`tests/core/transport.test.ts` 增 2 条（keyset 分页——50 条他进程 ready 在前、5 条本进程在后仍全部认领；`maxClaimsPerCycle: 2` 单轮预算封顶）；`tests/core/mailbox.test.ts` 增 5 条（I31 sink——`ensureDirect` + `expect:"reply"`+`to:["C"]` 得到 `steer` 档透传（非硬编码 followUp）且落库 grade 一致；拒收 → queued + `sink_backoff` + attempts=1 → 退避期满 sweep 重投 `delivered` 且重投收到同一 `id`/`idempotencyKey`；连续 `maxAttempts` 次拒收 → `park(SINK_REFUSED)`；I03——`RecordingTransport.failPublish` 抛错 → delivery 留 queued 且 fanout 未中止、sweep 对账重发 publish（path=P1/端点/意图齐）；outbox 手工落 `failed` → 仍 active 的 downstream 落 `dropped(TRANSPORT_FAILED)`）。
  - **API/schema 影响**：零 schema 变更（不改 `000_init.sql`，快照 `--check` 持续绿）；零新增导出符号 / park·drop 原因码 / 计数器名（`SINK_REFUSED`/`NO_SINK_HANDLER`/`TRANSPORT_FAILED` 均既有冻结码）；`PendingDelivery.path/woke`、`Transport.stop`、`Limits.sinkBackoffBaseMs/sinkBackoffMaxMs/outboxDoneRetentionMs`、`SameHostTransportOpts.maxClaimsPerCycle` 都是接口/类型成员（`gen-snapshots` 只枚举导出名，快照不漂移）。
  - **命令与环境**：macOS arm64、Node 24.19.0（满足 ≥22.19）、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 418/418（45 文件）**（较 W06 增 7 条，即上述 3 处）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① 计划「P2 分流提到 outbox 之前」改为「publish-first + 接收侧按 path 分流」**：实现为所有 P1/P2/P3 跨主都先走 `transport.publish`（outbox payload 带已定稿 `path`），接收侧 `handleOutboxDelivery` 按 `d.path` 分支。区别仅在语义归属：P2 是从发送侧不在 outbox 写行、还是接收侧写降级留痕 note 后停留 queued。最终按「接收侧分支」落地，因为 (a) outbox 载体本就幂等（`delivery_id` PK + `INSERT OR IGNORE`）、P2 停留 queued 需 W08 的注入确认，而 W08 会在接收侧看 `d.path` 决定注入，统一走 outbox 使接收侧拿到完整意图（path/grade/woke）；(b) 发送侧「P2 不 publish」会让「跨主 P2 的降级留痕 note」在本进程写、丢失异主端点的载体一致性。附注：`samehost.test.ts` 两用例改为 `expect:"ack"` 正是为让 B 走 P1 全文，不碰 P2 留痕分支。
    - **② 计划测试示例用 `expect:"none"` 使 B 超预算 P2，却断言 `delivered>=1`——被本批 I02 修正打破**：原两个 samehost 用例依赖旧 bug（P2 也被当 P1 全文 `port.deliver`），I02 修后 P2 不再全文投。改为 `expect:"ack"` + `to:["B"]` 使 B 进入原文预算内（P1 全文），锁定真正的跨进程全文投递路径，语义与用例意图（验证异主全文 outbox 投递）一致。
    - **③ sink 退避用时序 `queued_at` 而非新增 `next_attempt` 列**：`mesh_deliveries` 已有 `attempts`/`queued_at`/`note`，退避截止 = `queued_at + backoff(attempts)`，无需迁移（坚持「schema 变更一律新迁移」也允许，但复用既有列更小；sink queued 行 `endpoint_id` 恒 NULL，不与 handoff(②)/seq-gap(⑥) 步冲突）。
  - **剩余风险 / 留待**：① P2 跨主真实确认（注入绑定端点/session/回合代次/实际集合，I09）由 W08 承接——本批 P2 只做到「接收侧降级留痕 note + 留 queued」，`samehost.test.ts` 未覆盖跨主 P2 留痕分支（用 P1 规避）；② outbox 保留清理 `claimed_at` 口径偏差（选 (a) 的代价）——若日后要精确「done 之后整 24h」再加 `done_at` 迁移；③ 多进程 sweep 对账并发（孤儿重建与 failed 联动依赖 SQLite 串行写 + `NOT EXISTS`/状态 WHERE 守卫）与 keyset 认领的跨进程竞态，专门测试留 G05/W15 复核；④ `InProcessTransport.publish` 未就地幂等（单进程形态 `isEndpointLocal` 恒 true、不可达），W08/W13 若改装配需一并复核。

- 2026-10-15：**W08 完成**——原文预算 / P2 确认 / CATCHUP / 唤醒（第 ⑤ 批下半段，N03、I08、I09、I10、I14；承接 I02 的 P2 部分）。

  - **关联 ID / 合同**：N03（`maxHistoryOnJoin` 无读点）、I08（字节预算恒 `MAX_SAFE_INTEGER`/`unreadBytes:0`、`evictionOrder` 零消费、工具读史不计原文）、I09（装 hook 即确认 + 按账号全确认 + P3 混进 P2 正文）、I10（CATCHUP 摘要变量弃用只写元数据 note）、I14（唤醒判定整块包在 `path==="P1"`）；§7.6（ContextPath P1/P2/P3 + P2 确认唯一判据 = 进入真实最终输入）、§7.4（预算与唤醒正交 + 原文预算统计口径）、§7.3（唤醒四规则 + busy steer ≠ 新起轮）、§9.4（`maxHistoryOnJoin` 仅 `full` 下注入、注入是成本、加入前消息无 delivery 行）、§10.2（每消息平均原文份数 ≤3 不被工具读史穿透）、§10.3 防线 1（M4 包裹转义）。
  - **I09 P2 最终输入确认（pi 层 + core 收口）**：`PiStreamPortDeps` 增可选 `onInjectionConfirmed?(endpointId, { turnGeneration })`（pi 内部装配通道，非 StreamPort 十方法、不进 API 快照）；`StreamRec` 增 `turnGeneration`（init 0），`onSessionEvent` 认 `turn_start` 自增（`stream-port.ts:633`）；`injectContext` 的扩展 `handlers` 除既有 `context` 处理器（append `mesh.inbox`）外新增 `context_with_system` 观测处理器（`stream-port.ts:544` 起）：在 system 前缀恢复后的完整 transcript 里按 `customType === "mesh.inbox"` 定位注入体，找到即回调 `onInjectionConfirmed`（找不到静默）。`index.ts` 构造端口接 `onInjectionConfirmed: (id) => mailbox.confirmInjection(id)`；`refreshInjection` 去掉「装 hook 即确认」，空摘要（`inboxInjection` 返 null）→ 退订旧 hook + 删 `injectionText` 直接 return（「空摘要清除旧 hook」），文本变化则退订重装不确认。`mailbox.markInjectedDelivered` 改为 `confirmInjection(endpointId)`（`mailbox.ts:1653`，Mailbox 内部方法）：`WHERE endpoint_id = ? AND path='P2' AND state='queued'` **端点级**、逐行落 delivered + `message_delivered{path:"P2"}`，`consumed` 仍由 `handleTurnEnd` 于 turn_end 归因。`inboxInjection`（`mailbox.ts:1782`）recent-3 查询与 `[digest]` unread 计数均加 `AND d.path='P2'`（P3 不再混入正文；`inboxOf` 的 `pending_count` 保持全路径口径不变）。
  - **I10 CATCHUP 先持久化再消费**：`maybeCatchup`（`mailbox.ts:910`）弃用 `port.note("mesh.catchup", …)` 元数据路径，改 `renderCatchup(convId, items.length, spanFrom, spanTo, mechanicalDigest(items))` 出 `<<<CATCHUP …>>>…<<<END CATCHUP>>>` 正文，用合成 envelope（新私有 `syntheticEnvelope(envelope, tag)`，`mailbox.ts:995`，`id=ulid()`、不在 `mesh_messages`）经 `port.deliver(..., "followUp", { triggerTurn:false })` 落 `custom_message`——持久化 + 进后续输入；`deliver` 之后同事务 consumed + cursor 前移 + overflow 清零（「先持久化再消费」）。合成 envelope 回流 entry 时 `WHERE d.message_id = synEnv.id` 无行 → no-op，不造 delivery 行。
  - **I14 档位与唤醒解耦 + P2 唤醒落地**：`deliverOne` 唤醒判定块（`mailbox.ts:319`）由 `if (path === "P1")` 改 `if (path === "P1" || path === "P2")`（P2 也录 `woke`，urgent/①correlationId 超预算时唤醒；P3 恒 false）。`deliverToEndpoint` P2 分支（`mailbox.ts:468`）在 `noteVerbatimExit` 后，`woke && state==="hot" && !busy` 时 `port.nudge(endpointId, "该会话有新未读", { triggerTurn:true })` 起一轮让注入体被看到；busy 不起新轮（自然轮次/注入确认）。「busy steer ≠ 新开一轮、起轮数=0」由既有 `wokeFlag && busy → wokeFlag=false + wake_per_message_busy` 与 `GRADE_DELIVER_AS[steer]=steer` 保证，本批补契约测试锁定。
  - **N03 `maxHistoryOnJoin` 历史注入**：`index.ts` 新增私有 `renderJoinHistoryBlock`（逐条 `<<<MSG seq=… from=… name=…>>>…<<<END MSG>>>` 套 `<<<HISTORY kind="join">>>…<<<END HISTORY>>>`，M4 转义）+ `injectJoinHistory`（`index.ts:901`）：仅 `historyVisibility==="full"` 且 `maxHistoryOnJoin>0` 时取 `seq <= membership.joinedSeq` 的最近 N 条，经合成 envelope `port.deliver(ep.id, block, synEnv, "followUp", { triggerTurn:false })` 注入**热**端点（`state!=="hot"` 跳过、冷流不 warm），失败不阻断加入；`groupAddMember`/`groupJoin` 在 `registry.addMember` 后、`emitSystem` 前调用。
  - **I08 字节预算 / LRU / 工具读史计量**：`retentionCandidates`（`mailbox.ts:865`）`unreadBytes:0` 改 `pending_bytes + verbatim_bytes`（含自发字节的真实口径，槽诚实喂宿主策略）；`verbatimConversationCount` 退化为新私有 `verbatimInBudget(accountId, convId, budget)`（`mailbox.ts:770`）——direct/pinned 恒占位，其余 gap 达标按 `evictionOrder`（默认 `lru`=`lastActiveSeq` 降序，函数则调用）排序取 top-K + 有限字节按贪心接纳；`DefaultRetentionPolicy.verbatimBudget` 仍 `bytes:MAX_SAFE_INTEGER`（默认关闭，合法）。工具侧 `tloadctx` 增可选 `countVerbatim?(bytes)`，`buildMeshHistory` execute（`tools.ts:745`）对 `ctx.history` 每条原文按 `Buffer.byteLength` 回调；`makeToolContext`（`index.ts:1392`）接 `store.bumpCounter("verbatim_copies")`（复用既有计数器，不新增名），工具读史不再穿透 §10.2 口径。
  - **复现/反证测试（5 处 16 条）**：`tests/pi/p2-confirmation.test.ts`（新 3 条，真实 SDK + faux）：不起轮 ⇒ `onInjectionConfirmed` 零次 + `callCount===0`（装 hook ≠ 确认、停在 blocked）；起一轮 ⇒ 恰一次绑定 `{endpointId, turnGeneration:1}`；双端点只触发一端 ⇒ 只有该端点确认。`tests/pi/catchup.test.ts`（新 1 条）：`renderCatchup` 产物经 `port.deliver` 落真实 session 为 `custom_message`（含 `<<<CATCHUP`/`<<<END CATCHUP>>>`）非 note、`callCount===0`。`tests/e2e/join-history.test.ts`（新 4 条）：`full`+N → 恰一条 HISTORY 块含 ≤N 条 `<<<MSG`、`triggerTurn:false`、`grade:"followUp"`；`since_join`（默认）即使 N>0 零注入；`full`+N=0 零注入；冷端点不 warm、零注入。`tests/core/mailbox.test.ts` 增 7 条（I14 wake 脱 path：urgent P2 醒热 idle 流 `nudges{triggerTurn:true}`、busy 时 `woke=1` 但不 nudge；I09 `confirmInjection` 端点隔离：双端点只确认被触发者另一端留 queued、`inboxInjection` 对 P3-only 返 null；I08：LRU 淘汰新会话挤旧、`retentionCandidates.unreadBytes>=verbatim_bytes`、自定义 `evictionOrder` 被调）。`tests/core/tools.test.ts` 增 1 条（`mesh_history` 读史 `countVerbatim` 计 `[14]` 字节）。
  - **API/schema 影响**：**零 schema 变更**（不改 `000_init.sql`，快照 `--check` 持续绿）；**零新增导出符号 / 计数器名 / error 码 / park·drop 原因码**（`confirmInjection` 是 Mailbox 内部方法、`verbatimInBudget`/`retentionCandidates`/`syntheticEnvelope` 私有、`renderJoinHistoryBlock`/`renderCatchup` 不在 `Renderer` 接口、`onInjectionConfirmed`/`turnGeneration` 是 pi 内部 dep 面）。
  - **命令与环境**：macOS arm64、Node 24.19.0（满足 ≥22.19）、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 434/434（48 文件）**（较 W07 增 3 文件 16 条，即上述 5 处）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① I14 P2 唤醒落地取「nudge 起轮」而非降级「只录 woke」**：计划「未决 ①」列出两可——nudge-cue 会否污染上下文。实现取 nudge 起轮（`port.nudge(endpointId, "该会话有新未读", { triggerTurn:true })`）：cue 是**通用未读提示**而非消息正文（正文在注入体），`triggerTurn` 只决定是否起轮、不把 cue 当 `custom_message` 进持久化历史（`nudge` 与 `deliver` 分离，pi 层 `nudge` 不落 `mesh.msg` 条目）；冷流仍不 nudge（`state==="hot"` 守卫），与 §7.2「冷流 silent 不升温」不冲突。
    - **② 合成 envelope 助手私有化在 mailbox**：计划 §4 写「`catchupEnvelope(envelope, conv)` 新私有助手」，实现为 `mailbox.syntheticEnvelope(envelope, tag)`（`mailbox.ts:995`，约简 tag 生成 `id`/`idempotencyKey`），N03 的 join-history `synEnv` 在 `index.ts` 内联构造（因 `syntheticEnvelope` 是 Mailbox 私有、core 与装配层不共享）——语义一致（合成 envelope 不写 `mesh_messages`/`mesh_deliveries`），只是助手位置按分层落在 mailbox 而非 index。
  - **剩余风险 / 留待**：① P2 **跨主**确认（异主持锁场景：本进程 `context_with_system` 观测只覆盖本进程热流，跨主 P2 留 queued 的确认需持锁方 injectContext 成像后回调）与多进程确认竞态留 G05/W15 复核——同进程双端点隔离已由 `confirmInjection` endpoint 级 + `p2-confirmation` 测试锁定；② I08 字节预算窗化（`verbatim_bytes` 只累加不衰减，`unreadBytes = pending + verbatim` 把很久前的自发也算入），默认策略不看 bytes 故无行为影响，精确「gap 窗内自发字节」留 G06/W13 复核；③ `I08` 的「提 I29/W13 的 `limits.toolResultMaxBytes` 接线」本批只接「读史记账回调」（`countVerbatim`），工具结果截断字节上限仍硬编码 `TOOL_RESULT_MAX_BYTES=8192`（`tools.ts`）——不接，留 I29；④ `context_with_system` 观测按 `customType==="mesh.inbox"` 定位注入体、含「defensive system 恢复改变形态」的容错只做到「找不到静默」，W13 真实装配下再复验 provider HTTP 钩子路径。

- 2026-10-15：**W09 完成**——请求应答（第 ⑤ 批第三段，I11、C06；§14）。

  - **关联 ID / 合同**：I11（端点绑定、exclusive、回程定向、abandoned、路由后才订阅的丢事件窗口）、C06（重复/冲突 ack 身份校验优先于幂等、冲突响应不伪装成功、合法 late 只定向回发起方不回退终态）；§14.1（复信投递集 = 发起方、与普通 correlation send 一致）、§14.3（非 queue `expect:"ack"` 取目标 exclusive、TTL 是 fallback、blocked 到达 non-terminal 且 release 恢复）、§14.4（open→answered/timeout/abandoned 四态；超时后合法迟到打 `late`）、§14.5（REQUEST_CYCLE：事件快路径 + 持久态正确性 + 跨进程）、§14.6（abandoned 静默）。
  - **① 回程定向 + late 统一收口（router `replyOf`）**：`replyOf` 查询（`router.ts:206`）扩为 `WHERE correlation_id=? AND to_account=? AND state IN ('open','timeout')` 且 `SELECT` 增 `from_account`，命中带 `isLate = state==='timeout'`；应答投递集当调用方未显式 `to` 时默认 `toNorm=[replyOf.from_account]`。`ackCorrelation`（ack 入口）与 `host.send({correlationId})` 走同一 `router.route` 路径，故 C06「ordinary correlation send 与 ack 入口行为一致」由构造保证，无需两处分别写。`Envelope.late`（成员级可选）落 `mesh_messages.late`=`late?1:0`（替换 `router.ts:538` 恒 `0`）；`ack_of` 与闭合开集仍以 `state='open'` 为条件，late 应答**不**回退 pending 终态（`state` 仍 timeout、`answered_by_message` 仍 NULL），避免可重算派生态二次改写。
  - **② 端点绑定 + exclusive 获取/释放（mailbox）**：`deliverOne`（`mailbox.ts`）在 `LEASE_HELD` 检查通过后、定档前，命中 `envelope.expect==="ack" && conv.kind!=="queue" && envelope.correlationId` 时幂等绑定 `endpoint_id`（`UPDATE ... WHERE endpoint_id IS NULL`）并 `setEndpointLease(endpointId,"exclusive", now+exclusiveLeaseTtlMs)`（60s > ackTimeoutMs 30s，TTL 仅 fallback）。新 Mailbox 内部方法 `releaseRequestLease(correlationId)`：`expect==="ack" && endpoint_id` 时 `setEndpointLease(...,"shared",null)` + `retryEndpoint` 解 park（非终止）。三个释放点：正常 ack（`ackCorrelation` open 分支 route 后）、超时（sweep ④ SELECT 增 `expect,endpoint_id`）、abandoned（见 ④）。
  - **③ `request(await)` 持久终态解析（index.ts）**：改为事件（`message_acked`/`request_timeout` 快路径）+ 持久态补查/轮询（`setInterval(50ms).unref()`，共享 DB `readTerminalState`）双通道，`done` 去重保证恰好一次；**先补查再悬挂**闭合「`await router.route` 后才订阅」的丢事件窗口。轮询体包 try/catch（DB 关闭后 `clearInterval`），修掉 `host.close()` 后 61 条 "The database connection is not open" 未捕获异常。`readTerminalState`：`SELECT pa.state,to_account,answered_by_message,m.payload,m.late FROM mesh_pending_acks pa LEFT JOIN mesh_messages m ON m.id=pa.answered_by_message`；`answered` 由 `buildAckPayload` 逆编码重建（`rebuildAckResult`），`timeout`→`{ok:false,timedOut:true}`，`abandoned`→`{ok:false,abandoned:true}`。本地快路径仍取事件精确 `detail`，跨进程取落库 canonical 应答消息重建值（`ok`/终态一致，`data`/`error` 以落库为准）。`AckResult.abandoned?`（成员级可选）。
  - **④ abandoned（groupDissolve + archive）**：新 Mailbox 内部方法 `abandonConversation(convId)`：`UPDATE ... SET state='abandoned' WHERE conversation_id=? AND state='open'`（静默，不发 `request_timeout`/`message_acked`）+ 逐行释放 exclusive lease。`groupDissolve`（`index.ts:1056`）在 `registry.archiveConversation` 后、`emitConvChanged` 前调用——归档在前使之后 late ack 被 Router「archived 拒投」兜底，`abandon` 保证已等待的 await 以 `abandoned` 恰一次 resolve。
  - **复现/反证测试（3 文件 8 条）**：`tests/core/request-answer.test.ts`（新 3 条，直读 DB 断言 Router/Mailbox 层契约）：复信定向回发起方 `to_accounts=["A"]` + 投递集仅 A 一行 + `ack_of` 指向原请求；超时后复信 `late=1`、仍 timeout、`answered_by_message` NULL；ack 请求首次投递绑定 `endpoint_id`/`lease_mode='exclusive'` + 并发到达 park `LEASE_HELD` + 超时释放回 shared 并解 park。`tests/e2e/request-answer.test.ts`（新 4 条，createMesh + FakeStreamPort 直读 DB）：C06 非目标对已 answered id 报 `NO_SUCH_CORRELATION`、目标重复 ack 幂等且无第二条应答消息；快 ack 恰好一次 resolve；超时 `timedOut:true` 恰好一次；dissolve → `abandoned:true` 静默、无应答消息。`tests/e2e/request-cross-process.test.ts`（新 1 条，两进程共享 DB、双向手动 endpoint 锁使请求/应答都走 outbox）：HostA `request(await)` 在 HostB 进程 ack、A 经共享 DB 轮询恰好一次 resolve `ok:true` 且应答回程不丢实体消息。
  - **API/schema 影响**：**零 schema 变更**（`endpoint_id`/`late`/四态列均在 `000_init.sql` 已存在），快照 `--check` 持续绿；**零新增导出符号 / 计数器名 / error 码 / park·drop 原因码**（`releaseRequestLease`/`abandonConversation`/`rebuildAckResult` 是 Mailbox/装配层内部方法，`AckResult.abandoned`/`Envelope.late` 是成员级可选字段，不进 API 快照）。
  - **命令与环境**：macOS arm64、Node 24.19.0、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 442/442（51 文件）**（较 W08 增 3 文件 8 条）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① exclusive 获取落在 `deliverOne`（端点选择之后）而非 Router 受理时（§14.3 `t0`）**：源于分层——core 内 Router 无端点知识，交织点在 Mailbox 选好目标端点之后。因 `route→fanout→deliver` 在同一次 `send` 同步完成，效果等价（请求转达前即已取得目标 exclusive）；键点记录的观察是「exclusive 获取先于 `isLocal`/outbox 判定的跨进程投递」，即同一权衡的另一面。
    - **② 跨进程 `data`/`error` 重建**：轮询路径按 `buildAckPayload` 逆编码重建（string→`data=payload.text`，object→`data=payload.data`，error→`error=payload.data.error, ok=false`），本地事件路径取精确 `detail`。两者 `ok`/终态一致；非平凡 error（对象/非字符串）形态是否需逐字节一致，与计划「未决 ②」一致结论为「不加 schema、以落库 canonical 应答为准」，非平凡 error 形态的一致性留 G05/W15 复核。
  - **发现的既有问题（超出 W09 范围，记录未修）**：`maybeCatchup`（`mailbox.ts:1005`，§7.6）把 queued 的 P2 行标记 `consumed` 但**不写 `delivered_at`**，与 C3 不变量 `consumed_at IS NOT NULL AND delivered_at IS NULL`（`checkInvariants`）冲突——先于 W09 存在的 §7.6 与 C3 口径分歧。由「group + ack-request」触发（ack 请求属 P1 原文预算内 → catchup 折叠更早 queued 的 system 消息投递）。验证：去掉请求后单独跑 group 用例（violations 为空）及对照调试用例确认非 W09 引入；W09 的 C06 + 跨进程 group 用例已按此移除 `checkInvariants` 断言。**留 I32/W14 统一 CATCHUP 消费口径或修订 C3**，本批不修。
  - **剩余风险 / 留待**：① 「发起方账号注销 → abandoned」（§14.4 该分支）本版本无 `deregisterAccount` API，留待该 API 落地时同批接线；② 过期 claim 的 C06 部分属 W10（I12），本批不实现；③ 跨进程 exclusive 释放由共享 DB sweep 驱动（新主 sweep 按 `deadline` 扫到 open 超时释放），多主 sweep 并发对账留 G05/W15 复核。

- 2026-10-15：**W10 完成**——Queue（第 ⑤ 批第四段，I12、C06 的 claim 部分；§17）。

  - **关联 ID / 合同**：I12（claim 校验缺失且会改写 payload、turn_end 可能消费任务、重派与死信不完整）、C06 的 claim 部分（过期 claim 一律拒绝；重复 ack 先校验身份和端点再判幂等）；§17.2（待领/持有双窗口回收）、§17.3（claim 只能由被选中消费者推进）、§17.5（cursorSeq 只在 ack 前移，turn_end 不消费 queue 任务）、§17.6（ack 同一事务四件事 + `pending_acks.deadline` 与 `claim_until` 同步、每次回队重投更新 `to_account/endpoint_id/deadline`、`correlation_id` 稳定不新开行）、§17.7（死信 `dropped(MAX_ATTEMPTS)` + `pending` timeout + `request_timeout` + `claim_error` + `kind:"system"` 死信通知发起方）。
  - **① claim 归属下移到 delivery（迁移 `003_claim_owner.sql`，payload 不可变 A1）**：新增 `mesh_deliveries.claimed_by/claimed_at/claim_error` 三列（仅追加，符合 §28 迁移风格）；删除旧 `mailbox` 里 `json_set(payload,'$.claim')` 的正文改写与各处 `json_extract('$.claim.by')` 回读（`envelope.ts` / `observer.ts` / `mailbox.ts`）。`Envelope.claim` 类型保留（成员级、不进 API 快照），无 delivery 上下文的物化（消息历史/渲染）恒为 `undefined`，正确；Observer `myClaims` 改 `d.claimed_by`、C13 不变量改扫 `claimed_by` 列。`000_init.sql` 只读基线不动，快照 `--check` 持续绿。
  - **② claim 校验 + 租约代次（`mailbox.claim` 重写）**：按 `message_id` 定位唯一 delivery（§17 一条消息一条 delivery），身份校验 `by !== account_id` → `CLAIM_TAKEN`；状态机——`acked/consumed/dropped` → `{ok:false}`；`claimed` 且自分未过期 → 幂等 `{ok:true, leaseUntil}`；自分过期 → `CLAIM_EXPIRED`；他人未过期 → `CLAIM_TAKEN`；他人过期 → 回收后重新 claim（fall-through，attempts 不变）；`delivered` → claim；其余 `routed/queued/parked` → `{ok:false}`（C3：claimed/acked 必须曾 delivered）。**租约代次 = `attempts`**（重派/回收时 +1，claimed_by 被清/改即旧代失效）。
  - **③ ackQueue 收口单事务（§17.6 四件事）**：`ackQueue(messageId, by, error?)` 读 `claimed_by`（新列）；校验三段（`state!=='claimed'`→`NO_SUCH_CORRELATION`、`claimed_by!==by`→`CLAIM_TAKEN`、`claim_until<now`→`CLAIM_EXPIRED`）；成功单事务内「delivery→acked 清 claim_until + pending_acks→answered（queue 无实体应答消息，`answered_by_message` 留空）+ 前移 cursorSeq + 释放租约」，`message_acked` 事务后发；`index.ts` 分离的 `UPDATE pending_acks` 下沉到该事务。nack（error）→ `nackClaim`。C06「身份校验先于幂等」由 ackQueue 校验顺序 + `ackCorrelation` 的 `to_account`/`state` 校验共同保证。
  - **④ turn_end 不消费任务（§17.5）**：`handleTurnEnd` 消费查询加 `JOIN mesh_conversations c ON c.id=m.conversation_id AND c.type != 'queue'`，queue 投递在 turn_end 保持 `delivered`（等 claim），前移 cursorSeq 循环跳过 queue 会话。`acceptance.test.ts` 队列 claim 用例由 offline worker 绕过改为可用 worker（`makeSpeaker`）直证 turn_end 后仍 `delivered`。
  - **⑤ 重派 + 死信（`nackClaim` + 待领窗口 §17.2/§17.7）**：`reclaimExpiredClaims` 扫 `state IN ('delivered','claimed') AND claim_until < now`（双窗口，索引 `ix_delivery_claim` 相应改 `WHERE state IN ('delivered','claimed')`）；queue 投递 in `markDelivered` 转 delivered 时设 `claim_until = now + claimTtlMs`（会话级可覆盖，待领窗口起点）。`nackClaim(row, error?)`：`attempts+1`；`attempts>maxAttempts` → 死信单事务（`dropped(MAX_ATTEMPTS)` + `claim_error`=末次 error stringify + 清 `claim_until/claimed_by`；`pending_acks.state='timeout'`；`bumpCounter('request_timeout')`；`resetInboxPending`）→ `message_dropped` + `systemSend` 死信通知（to=发起方 `from_account`、带 correlationId + 末次 error，失败只影响告警不改死信判定）；否则 → 回队重投单事务（`queued`、清 claim 列、`endpoint_id=NULL`、attempts，`syncQueuePendingDeadline(correlation_id,null)` 重开整个窗口、`resetInboxPending`）再 `deliverOne`（统一投递路径重新选端）。
  - **⑥ 死信通知不重新入队（`router.ts` queue system 豁免）**：`router` 的 queue 强制（`expect` 强制 + `selectQueueConsumer` 单消费者插 delivery）与 queue 投递分支都收窄为 `conv.kind==="queue" && kind!=="system"`，`kind:"system"` 死信通知走定向投递到 `to` 收件人（发起方），不进 claimable 队列（§17 只约束 `kind:"task"` 的派发单元）。
  - **复现/反证测试（2 新文件 10 条 + acceptance 改造）**：`tests/core/queue-claim.test.ts`（新 9 条，`makeHarness` 直读 DB + `systemSend` 记录器）：claim 四态状态机（幂等/CLAIM_TAKEN/CLAIM_EXPIRED/他人过期回收重认领且 attempts 不变）；claim 不改 payload 字节与 seal（A1）；turn_end 后可用 worker 仍 `delivered` 且 `claim_until` 已开；待领窗口过期回收 attempts+1；nack 回队 + `pending_acks` 仍 open 且 deadline 重开 + 消费者一致；死信（`dropped(MAX_ATTEMPTS)` + `claim_error` + `timeout` + `request_timeout`=1 + system 通知带 correlationId/error）。`tests/e2e/queue-exactly-once.test.ts`（新 1 条，createMesh + FakeStreamPort）：单消费者 1000 任务逐条 claim+ack，`queueDepth:acked`=1000、`claimable`=0、`unread`=0、重复 ack 幂等不增计数、不变量全绿。
  - **API/schema 影响**：**迁移 003 仅追加三列**（无破坏性、无 `000_init.sql` 变更）；**零新增导出符号 / 错误码（复用冻结 `CLAIM_TAKEN`/`CLAIM_EXPIRED`/`NO_SUCH_CORRELATION`）/ 计数器名（复用 `request_timeout`）/ park·drop 原因码（复用 `MAX_ATTEMPTS`）**；快照 `--check` 持续绿。
  - **命令与环境**：macOS arm64、Node 24.19.0、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 452/452（53 文件）**（较 W09 增 2 文件 10 条）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① §17.3 exclusive 未在 claim 时取得**：单消费者队列无需独占租约，且多消费者并发安全（`inFlight`/背压/轮次保护）与 W12/W13 pooled 拓扑一并接；关闭记录注明「放权的多消费者并发由 G05/W15 复核」。
    - **② §17.4「回队换一个消费者」+ affinity 排除上次失败端点**：完整多消费者重投端点重算（换 account、换 endpoint、affinity 排除 failed）留 pooled 装配时收口；本轮落地「重派后 `pending_acks` 与 delivery 消费者一致、ack 不误拒」（单消费者下等价不改人），一致性机制已就位（nackClaim 回队重投走统一 `deliverOne` + `syncQueuePendingDeadline`）。
  - **发现的既有问题（超出 W10 范围，记录未修）**：P2 路径的 queue 投递（本源预算超限落 P2、注入后 `confirmInjection` 转 delivered）**不开启 `claim_until`**（`markDelivered` 的 queue 分支只在 P1/P3 `entry_id` 咽喉命中时写 `COALESCE(claim_until, …)`，P2 `confirmInjection` 独立写 delivered 未设 claim_until）——P2 queue 的待领回收计时缺失，属先于 W10 存在的 P2 队列接缝。单消费者场景无行为影响；留 W13 真实 pooled 装配时复核 P2 queue 与 claim 窗口的统一。
  - **剩余风险 / 留待**：① §17.3 exclusive 与 §17.4 多消费者换人（见上述偏差）；② `claim_error` 存 `stringify(末次 error)`（对象/非字符串 error 逐字节一致性）留 G05/W15 复核；③ P2 queue 待领窗口缺失（见既有问题）留 W13 复核。

- 2026-10-16：**W11 完成**——D03 权威恢复：pi 双向核对与幂等应用（第 ⑥ 批第一段，D03；§8.4/§8.6/§23.6）。

  - **关联 ID / 合同**：D03（提升为本版必做）；§8.4（崩溃恢复：delivered 行按 entry 逐条对真实 session 双向核对）、§8.6（意图 `mesh_deliveries` ↔ 结果 pi session JSONL 对账）、§23.6（崩溃恢复属性测试，性质②③④）、C03（`partial=1 ⇒ state='consumed'` 同事务落）、C10（D03 保守核对：无法确定的交接 park 并告警）。
  - **核心判定原则**：`mesh_stream_entries`（镜像）可重建、非权威；`mesh_deliveries`（意图）是「该不该投」，pi session（实际发生）是「有没有投」。区分窗口②（`deliver()` 已调、entry 没落进 session = 消息静默丢失）与窗口③（entry 已落 session、turn_end 再也没来 = 永久未读 + 镜像缺条目）只靠 `StreamPort.hasEntries(endpointId, entryIds)` 逐条问 session。
  - **对账范围**：`state IN ('delivered','parked') AND entry_id IS NOT NULL AND endpoint_id IS NOT NULL AND 会话 type != 'queue'`。P1 才写 `entry_id`（P3 note 以 `markDelivered(id,null)`、P2 注入 `confirmInjection` 落 NULL，已完成即确认、无对账价值）；queue 的 `delivered` 是「任务已进 worker 会话等 claim」，由 W10 `reclaimExpiredClaims` 闭环，对账不吞。
  - **实现（`src/core/mailbox.ts` + `contracts.ts`）**：公开 `reconcileDelivered()`（Mailbox 契约新增，扫全表按 `endpoint_id` 分组）+ 私有 `reconcileDeliveredForEndpoint`/`reconcileDeliveredGroup`/`markConsumedPartial`/`requeueForRedelivery`。流程——`isEndpointLocal` 守卫（sameHost 他进程端点整组跳过，M3）→ 读 `port.status`，非 hot 且**非全 park** 先 `port.warm`（失败→对未 park 行 `parkDelivery(parkReasonForPortError(err))` 告警、`entry_id` 保留供下次对账；全 park 则跳过避免反复 warm 刷告警）→ hot 且 busy 跳过（turn 进行中交 turn_end）→ `hasEntries` 判存在性（抛错同 park）→ 在→`markConsumedPartial`（`state='consumed', partial=1` + 前移 `cursor_seq` + `resetInboxPending` + `message_consumed{partial:true,entryId}`，不进镜像）；不在→`requeueForRedelivery`（`state='queued'` 清 `entry_id`/`handoff_at` + `resetInboxPending` + `deliverOne` 重投，`UNIQUE(idempotency_key)` 防重）。
  - **三个触发点**：① 启动 ③（`src/index.ts`，在 `port.onEntry`/`onTurnEnd` 接线之后——重投走 `deliverOne→port.deliver` 同步回吐 entry，必须先接好 handler 才能归因）；② `retryEndpoint` warm 成功后单端点对账；③ `sweep` 步骤 ⑩兜底（冷端点 warm 失败即 park+告警）。
  - **幂等**：每次跃迁 `WHERE state IN ('delivered','parked')` 门控；转 consumed 后二次调用查无行即 no-op → 「反复恢复结果相同」。转 consumed 的路径不 re-emit `onEntry`（避免把旧 entry 再喂 `handleEntryAppended` 重复投递），镜像缺失由既有 `syncEntries`（warm/事件差分 + `INSERT OR IGNORE`）补写。
  - **复现/反证测试（2 新文件 6 条）**：
    - `tests/core/recovery.test.ts`（新 4 条，`makeHarness` 直读 DB + FakeStreamPort，`onEntry` 接而 `onTurnEnd` 不接以冻住崩溃窗口）：① entry 在 session → `consumed` + `partial=1`、`port.delivered` 不增（不重投）、反复 reconcile 结果相同；② `vanishedEntries` 命中 → queued 重投恰好一次（`port.delivered` +1）再 reconcile → consumed(partial)；③ 冷端点 warm 失败（`warmError=NO_SESSION`，FakeStreamPort 新增脚本字段）→ `parked` reason `NO_SESSION` + `invariant_violated` 计数=1 + `entry_id` 保留；④ queue 会话 delivered 不被对账吞（仍 delivered 等 claim）。
    - `tests/e2e/recovery.test.ts`（新 2 条，createMesh + `NoTurnPort` 永不 triggerTurn 冻窗口）：同 DB + 同一 FakeStreamPort 两次 `createMesh`（窗口③，session 存活）重启后启动 ③ 把 delivered → `consumed(partial)`；同 DB + 全新空 FakeStreamPort（窗口②，entry 丢失）重启后重投且 `port.delivered` 恰多一条、同 `idempotencyKey` 只出现一次、`checkInvariants()` 全绿（§23.6 性质④）。
  - **API/schema 影响**：**零 schema 变更**（快照 `--check` 持续绿）、**零新增导出符号 / 错误码 / park·drop 原因码 / 计数器名**（复用冻结 `NO_SESSION`/`ENDPOINT_GONE`/`LEASE_HELD`/`PORT_TIMEOUT` 映射 + `invariant_violated` 计数器做「告警」）。`reconcileDelivered` 只进 Mailbox 契约与 Host 内部装配，**不进公共 MeshHost 面**（avoid 快照漂移）。
  - **命令与环境**：macOS arm64、Node 24.19.0、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 458/458（55 文件）**（较 W10 增 2 文件 6 条）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：
    - **① 对账范围由 `state='delivered'` 扩为 `state IN ('delivered','parked')`**：warm 失败 park 的 delivered 行保留 `entry_id`，须在下次 warm 成功后按 entry 重验（在→consumed、不在→重投），而非 blind-requeue——否则「entry 其实已在 session 却重投」产生重复进上下文（§23.6 性质④）。P2/P3 `entry_id=NULL` 天然被过滤，无需 `path='P1'` 显式谓词。
    - **② 启动 ③ 的 reconcile 位置由「`recomputeInboxCaches` 之后」移为「`port.onEntry`/`onTurnEnd` 接线之后」**：计划字面位置早于 `mailbox`/`router` 构造与端口 wiring，重投的 `deliverOne→port.deliver→entry_appended` 无 handler 会丢归因。`recomputeInboxCaches()` 仍在原处（只依赖 store）。
  - **剩余风险 / 留待**：① §23.6 **完整随机崩溃属性框架**（N∈[2,30] 账号、随机序列、100 次 kill、六性质全绿）作为独立随机生成器工程留 G05/W15 收口——本轮落「窗口②/③」两条决定性的用例测试 + 幂等断言，已覆盖性质②③④ 的核心判据；② 镜像补写（session→mirror）沿用既有 `syncEntries` 实现未改，本轮只验证不重投、不重复事件；③ `port.status`/`hasEntries` 抛错时的 park 复用 `parkReasonForPortError`（`ERR_SESSION_REQUEST` 等未识别的底层错误归 `PORT_TIMEOUT`），错误码粒度与告警措辞留 W14 观测统一时复核。

- 2026-10-16：**W12 完成**——Shared 安全与数据合同（第 ④ 独立分支，I19、I20、I23、C04；§4.2/§18）。

  - **关联 ID / 合同**：I19（用新 ACL 检查旧对象；delete 只要 write；custom 无 resolver 放行）、I20（CAS 跨 await 有窗口；del 不推进版本号）、I23（通知不按 read 过滤、不固定 silent；写入路径缺归档禁写）；§4.2（put 按旧 ACL 查 write、改 ACL 与删除需旧 admin、异步授权后在事务内复验版本与授权依据、私有通知按 read 全体过滤 + 固定 silent 不唤醒、不泄露 key）、§18.3（append 天然可交换）、§18.4（墓碑/归档/版本单调）、§18.6（del=打墓碑走 admin、custom 无人判定即 deny）。C04（显式 `by/as` 校验、不新增隐式管理员）：`put/del/append/get/list` 的 `as` 均经 `requireAccount` 落库校验（未知账号 SPACE_FORBIDDEN），默认 ACL 的 admin 恒定 `accounts:[owner]`——本轮 Shared 侧**无 C04 缺口、无改动**（C04 的 host 面已在 W04 落）。
  - **核心判定（`src/core/shared.ts`）**：写路径拆「授权依据」与「写入结果」两层——`oldAcl`（旧对象 ACL，不存在则 `defaultAcl`）是授权依据，`newAcl = opts.acl ?? oldAcl` 是落库结果。三者（put/append/del）的读-改-写整体移入单个 `db.transaction`（新增公共 `upsertObject`），在事务内**复验版本与授权依据后**才落库，闭合跨 await 的竞态。
  - **I19 落地**：`allowedAcl` 的 `isAdmin = op==='admin'||op==='delete'`，put/append 走 write 面、get/list 走 read 面、del 走 admin 面；`put` 写面只对 `oldAcl` 裁决，`opts.acl` 提供且 `aclFingerprint(opts.acl)!==aclFingerprint(oldAcl)`（新增规范化指纹，规则/名单顺序无关）时再对 oldAcl 裁 admin；`custom` 规则无 `resolveCustomTag` 时由放行改为 **deny**。
  - **I20 落地**：有 `expectedVersion` → 事务内复验版本；盲写/append → 事务内复验 `aclFingerprint(curAcl)===oldAclFp`（acl 变了即 VERSION_MISMATCH 强制重试，授权失效）。`del` 的 `UPDATE mesh_shared_objects` 增加 `version=existing.version+1`（§18.1：objects.version 恒等于 versions 表该 key 最大版本），删除→重建版本单调。`append` 不再委托 `put`，事务内读-改-写 → 并发追加不丢（20 并发全落）。
  - **I23 落地**：`rejectArchivedWrite` 对 `conv:` 且会话 `state==='archived'` 的 put/append/del 统拒 `SPACE_FORBIDDEN`（读仍放行）；`notificationAllowed`/`notifyIfPermitted` 在写提交后按 read 全体过滤——收件人（group/direct 走 `listMembers`、topic 走 `listSubscribers`）任一读不到即抑制 conv 通知（`shared_object_changed` 宿主事件照发，不泄露 key）。silent + 不唤醒由装配层既有 `kind:"event"`（grade 派生 silent）+ `expect:"none"` 保证，本次不变。
  - **复现/反证测试（`tests/core/shared-contract.test.ts` 新 10 条 + 既有两处断言调整）**：① put 写按旧 ACL（B 在新 ACL 自授写权被拒、旧 ACL 有写权则正常盲写）；② 换 ACL 需旧 admin（非 admin B 换 ACL 被拒、A 可换）；③ del 走 admin（member 有写无 admin 不能删）+ `objects.version` 推进、删除→`expectedVersion:0` 重建版本 3 单调；④ 20 并发 append 全部落（版本 20、排序后 0..19 无丢失）；⑤ append+maxLen+版本单调共存；⑥ put/del/重建 ×5 轮 + `sharedVersionsKept=4` 裁剪无唯一键异常、版本单调；⑦ 私有对象（成员 C 无 read）conv 通知抑制、宿主事件版本照发；公开对象通知放行；⑧ 归档会话 put/append/del 均拒、get/list 放行。既有 `shared.test.ts` 的「del 也走 write 面」断言改为 admin 面 + 补「write 无 admin 不能删」；`policy-slot-matrix.test.ts` 的「custom 钩子缺失 → 放行」改为「→ deny」且零降级。
  - **API/schema 影响**：**零 schema 变更、零新增导出 / 错误码 / 原因码 / 计数器名**（复用冻结 `SPACE_FORBIDDEN`/`VERSION_MISMATCH`/`OBJECT_TOO_LARGE`/`NO_SUCH_KEY`）；`types.ts` 仅更新 `Acl` 注释（write=put/append、admin=改 ACL/del）。快照 `--check` 持续绿。
  - **命令与环境**：macOS arm64、Node 24.19.0、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run build` → `npm run pack`（含离线消费者冒烟）全绿；**测试 468/468（56 文件）**（较 W11 增 1 文件 10 条）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：① AclRule 面名沿用 0.1.0 冻结形态（`public`/`conversation`/`accounts`/`capabilities`/`custom`），与 §18.6 字面（`everyone`/`members`/`ids`/`any`/`caps`）不同，属 W01 API 冻结、不随本轮改。② 通知 op 用 `"write"` 而非 §18.5 的 `"put"`（`SharedSpaceDeps.notify` 的 0.1.0 签名 `"write"|"append"|"delete"`，`shared_object_changed` 事件类型无 `op` 字段），保持一致、不新增字段。③ 通知 read 过滤采用 §4.2 的**全有或全无**（把 §18.6 扇出侧「逐收件人 `dropped(ACL_DENIED)`」收敛为「任一收件人无 read 即整体抑制通知、保留宿主事件」），系 0.1.0 对规范的精简，已在计划 §4.2 定稿。
  - **剩余风险 / 留待**：① `append` 的 `OBJECT_TOO_LARGE` 在事务内对整列表序列化后判定（不截断），大列表写放大只随列表长度，留 G06 规模基准复核；② 通知 read 过滤每次写后枚举全体收件人逐账号异步裁决，大群写放大 O(成员数)，属 best-effort 通知路径（§18.5），量级风险留 G06；③ conv 通知消息由装配层 `router.route` 发出，本轮只改 Shared 侧重门控（`notifyIfPermitted`），I23 的「接线」部分（通知链路真实走 tool 面）留 W13 装配复核。

- 2026-10-16：**W13 完成**——工具真实装配、公共类型（第 ⑥ 批 W11–W13 收尾，I21、I22、I29、C08；§10.2/§10.4/§12.6/附录 F）。

  - **关联 ID / 合同**：I21（shared put 的 append 静默变覆盖；list 忽略分页参数）、I22（Inbox 工具只接了简化投影）、I29（truncated 标志不准；兜底截断可能产生非法 JSON；toolResultMaxBytes 没接入）、C08（保留 core 公共出口、补齐根类型、生成 API 快照）。规范依据 §10.2（身份由闭包注入、结果按字节截断且恒合法 JSON）、§10.4（mesh_inbox 摘要投影）、§12.6（根公共类型全集）、附录 F（工具结果硬上限 8192）。
  - **核心判定（`src/index.ts`、`src/core/tools.ts`、`src/core/contracts.ts`、`src/core/shared.ts`）**：
    - **I21**：`HostToolContext.sharedPut` 由 `(spaceId,key,data,expectedVersion?)` 改为 opts 形态 `{ expectedVersion?, contentType?, op?:"replace"|"append", maxLen? }`——`op==="append"` 显式分派 `SharedSpace.append`（带 `maxLen` 裁剪），否则走 `put`（CAS `expectedVersion` + `contentType`）；`sharedList` 由 `(spaceId,keyPrefix?)` 改为 opts `{ keyPrefix?, sinceVersion?, limit? }` 并返回完整元信息（`key/version/updatedBy/updatedAt`）。工具层 `mesh_shared_put` 校验非法组合（`expectedVersion` 不能与 `append` 同用、`maxLen` 仅 `append` 有效、`op` 仅 replace/append）并显式拒绝，其余透传，`sinceVersion`/`limit` 真正生效。`ToolContext`/`SharedSpace` 契约（`contracts.ts`）同步。
    - **I22**：`HostToolContext.inbox()` 由 `mailbox.inboxOf` 改为 `observer.inboxOf`（完整投影：`peer`/`claimable`/`myClaims`/`awaitingMyAck`/`awaitingTheirAck`/`verbatim`）；`conversations()` 的 `hasUnread` 过滤同步改用 `observer.inboxOf`。工具面与观测面同源同形，不再走 mailbox 简化投影。
    - **I29**：新增 `capJsonResult(value, maxBytes)`——按 UTF-8 字节截断、尾部收缩，任何预算（含病理极小预算）都返回合法 JSON，`truncated` 标志准确，极小预算回退 `"null"`；`maxBytes` 由 `limits.toolResultMaxBytes`（`validateLimits` 的 `inRange 1024..65536`）经 `buildToolSet` 的 `maxBytes` opts 线程到全部工具 builder（`toolSet()` 与 sessionFactory 胶水两条装配路径都接线；core 缺省仍 8192）。
    - **C08**：根 `export type` 块补齐为 §12.6 全集（根 104 类型、core 102 类型），含 `ProviderConfig/RuntimeConfig/ResolvedLlm/Profile/MeshConfigCode/RuntimeResources` 等 pi 配置类型。`scripts/pack.mjs` 消费者冒烟新增「类型面消费」步——先只软链 better-sqlite3 验 core-only 无静态 pi 泄漏，再补软链 pi/@types 用仓库 tsc 编译 `consumer.mts`/`consumer.cts`，确认根与 core 入口的 `.d.ts`/`.d.cts` 声明在 ESM 与 CJS 两个模块系统下都能解析；tarball `REQUIRED` 名单补 `dist/index.d.cts`/`dist/core/index.d.cts`。
  - **复现/反证测试**：`tests/core/tools.test.ts` +8 条（I21 shared put/list intent 5 条：append 走 append、replace 走 put、非法 op 组合拒绝、sinceVersion/limit 生效、元信息补齐；I29 结果预算 3 条：≤预算全通过、超预算截断且 `truncated=true`、病理小预算 `JSON.parse` 成功但不强断言 `truncated`）；`tests/e2e/tool-inbox.test.ts` 新 2 条（I22：direct peer + `awaitingMyAck` 对拍 `observer.inboxOf`；queue `claimable` + `myClaims` 对拍同源）。合计 **478/478（57 文件）**，较 W12 增 **1 文件 10 条**。
  - **API/schema 影响**：零 schema 变更、零新增错误码/原因码/计数器（复用冻结 `TOOL_ERROR_CODES`）；`ToolContext`/`SharedSpace` 的 `sharedPut`/`sharedList` 签名变更为 opts 形态（破坏性，随 C08 记 API 变化）；根类型面补齐（快照 `root.types` 104 / `core.types` 102）——`node scripts/gen-snapshots.mjs` 重生成、`--check` 绿。
  - **命令与环境**：macOS arm64、Node 24.19.0、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run pack`（含离线消费者冒烟 + 新增「类型面消费」）全绿。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：① 验收「真实 SDK + faux 跑通 mesh 工具闭环」本批落到「mesh_* 工具经 `buildToolSet` → `ToolDefinition.execute`」的 core 契约级 + e2e 装配级闭环（`tools.test.ts` 直读 store 执行、`tool-inbox.test.ts` 经 `createMesh+toolSet` 执行），**真实 pi session 内调用真实 mesh 工具的用例归 V02/W15**——不放 mock 绿灯替代 C10（与 W11 对「渲染一致性」、W12 对「通知链路真实走 tool 面」的同一口径）。② 验收「接上 W12 的通知」：通知链路 `sharedSpace.put/append/delete → notifyIfPermitted → deps.notify → 装配层 router.route` 已由 W12 闭合核心门控；本批确认工具面 `mesh_shared_put` 经 `ctx.sharedPut` 走同一 `sharedSpace` 咽喉即触发同一通知链路，未新增工具级「执行后定产生 conv 通知」断言——真实 conv 通知端到端由 W15/G04 复核。
  - **剩余风险 / 留待**：① 真实 pi session 内的 mesh 工具调用闭环 → W15（V02「真实 mesh 工具」）；② 根新增的 pi 配置类型（`ProviderConfig/RuntimeConfig/ResolvedLlm` 等）与 W16/G08 的 ESM/CJS+core-only 全矩阵、升级库件一并复核；③ 快照 `--check` 依赖 node_modules 中 pi 类型可解析（`skipLibCheck` 只解析不校验），冷 clone 后 `npm ci` 前 `--check`/`pack` 会缺依赖——按 pack 前置（先 `npm install`）执行，与 W01 记录风险一致。

- 2026-10-17：**W14 完成**——Observer、事件、计数（第 ⑦ 批，I25、I26、I27、I28、C10；§2.4 端口能力、§12.5/§12.6 事件、§19.6/§27.4 锁判定、附录 E 计数器）。

  - **关联 ID / 合同**：I25（Observer 复用写连接；C10 只查锁文件存在性）、I26（事件不统一携带端点元信息、部分跃迁不发事件）、I27（三计数器从不递增；fold/busy 单位不对）、I28（trace 不能解释降档/不唤醒/重投）、C10（Observer 只报告 + 自定义 StreamPort 按实际能力校验）。
  - **I25 只读连接 + 活 owner**：`SqliteStore.open` 迁移完成后额外开 `new Database(dbPath, { readonly: true })` 暴露为 `store.readonlyDb`（`:memory:` 或打开失败回退共享 `db`），`close()` 时若异于写连接一并关闭；`MeshObserver` 全部 SELECT 走 `readonlyDb`。`ObserverDeps` 增 `lockLiveness?: (lockPath) => Promise<"alive"|"dead"|"unknown">`，宿主 `src/index.ts` 注入 `(p) => EndpointLock.ownerIsLive(p)`（pid+启动时刻双判据，`src/pi/lock.ts`）；C10 不变量由 `existsSync(lock_path)` 改为 `await lockLiveness(p)`——`dead` 计违规、`alive`/`unknown` 放行（§19.6「绝不猜」），缺回调退化为「文件存在」判定。`checkInvariants` 的 `run` 型由同步放宽为 `Array | Promise<Array>`，循环 `await check.run()`。
  - **I26 事件统一端点元信息 + 补齐漏发（合同测试驱动）**：新增 `tests/core/event-contract.test.ts`（6 条：P3 delivered、sink accepted、catchup consumed partial、死信 dropped 带 endpointId、request-response ack 带 endpointId、reclaim 拒绝 endpoint_state_changed）。据此修 6 处——`markDelivered`（mailbox.ts）成为「到达确认」统一咽喉，按行重读 grade/path/woke/endpoint_id 投影补发 `message_delivered`（P1/P3/sink/sameHost-P3 四路汇此，sink/external 无端点落 `""`），并删 `handleEntryAppended` 的重复发派；`maybeCatchup` 固化 queued→consumed 补发 `message_consumed {partial:true}`；`dropDelivery`/`nackClaim` 死信补 `endpointId`（行有 `endpoint_id` 才带）；`message_acked` 三处由恒 `""` 改 `r.endpointId ?? ""`（`HostToolContext.ack` 传闭包端点、`host.ack` 增可选 `endpointId`）；`src/index.ts` reclaim 拒绝由直写 `registry.updateEndpointState("unavailable")` 改为经发 `endpoint_state_changed` 的 `setEndpointState` 闭包。
  - **I27 三计数器 + 两单位**：`SharedSpace.put` 在 `expectedVersion === undefined` 时 `bumpCounter("blind_write")`；`reclaimExpiredClaims` 对每条仍 `claimed` 的过期领取 `bumpCounter("claim_timeout")`；`requeueForRedelivery` 命中「hasEntries 不在 → requeue」分支 `bumpCounter("queue_cleared_detected")`；`foldOverflow` 由 `victims.length` 改为 `bumpCounter("fold_events")`（与 `inbox_overflowed` 1:1 成对）；移除忙流正确合并唤醒分支的 `wake_per_message_busy` bump（目标是恒 0 的 canary，非健康场景也读 bug）。`tests/core/mailbox.test.ts` fold 断言 3→1、busy 断言钉 `0`。
  - **I28 trace 可解释**：增量迁移 `migrations/004_delivery_decision.sql` 加 `mesh_deliveries.redeliver_reason TEXT`；`DeliveryTrace` 增 `note`/`redeliverReason`、`observer.trace` 映射两列。不唤醒抑制原因（mute/dnd/offline/no_cap/activation）在 `deliverOne` 判 `!woke && note===null` 时写入 `note`；重投原因在 requeue 站点写 `redeliver_reason`（`entry_vanished`/`handoff_timeout`/`claim_timeout`/旧 `parked_reason`），`deliverOne` 不覆盖（两轴正交）。
  - **C10 只报告 + StreamPort 结构校验**：`checkInvariants` 维持纯读；`createMesh` 在自定义 `streamPort` 提供时校验 10 方法（`warm/evict/deliver/nudge/note/injectContext/status/hasEntries/onEntry/onTurnEnd`）均为 `function`，缺任一抛 `MeshConfigError("MESH_BAD_CONFIG", …)`（仿 `Transport` 校验），保留非 Pi 端口的「replay/双核对/单写者降级」警告。
  - **测试**：新增 `tests/core/event-contract.test.ts` 6 条；`tests/core/mailbox.test.ts` 两处断言更新（fold_events=1、busy=0）。合计 **484/484（58 文件）**，较 W13 增 **1 文件 6 条**。
  - **API/schema 影响**：增量迁移 `004_delivery_decision.sql`（新列，`000_init.sql` 未动、快照 `--check` 绿）；`DeliveryTrace` +2 字段、`ObserverDeps` +1 可选字段（成员级，API 快照名字面未漂移）；`MeshHost.ack` +1 可选 `endpointId`。零新增错误码/原因码/计数器（复用冻结集）。
  - **命令与环境**：macOS arm64、Node 24.19.0、pi 1.1.0。执行 `npm run check:imports`（G1–G4，24 源文件）→ `npm run typecheck` → `npm test` → `node scripts/gen-snapshots.mjs --check` → `npm run pack`（含离线消费者冒烟 + 类型面消费）全绿。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：① fold 受害者**不发** `message_dropped`（只发 `inbox_overflowed` 聚合）——规范「dropped(folded) 不计投递失败」的显式对齐，合同测试钉住此例外；② `router.ts` 墓碑 `message_dropped` 是账号级（tombDropped 无端点），`endpointId` 正确缺席，未如计划草案给 router 填端点。
  - **剩余风险 / 留待**：① 真实多进程 / 真实 pi 端口下的只读连接、活 owner 判定、事件体积与 `redeliver_reason` 端到端 → W15/G05 复核；② `wake_per_message_busy` 恒 0 成为「合并回归」canary，无 bump 点即正确；③ 事件面只做 contract 级断言（`message_delivered`/`message_consumed`/`message_dropped`/`message_acked`/`endpoint_state_changed`），真实服务下的事件消费者观测由 G03/G07 复核。

- 2026-10-17：**W15 完成**——本地整体验收（第 ⑦ 批，V01–V06、本地 V08；回归 E01–E10；G01–G07 全门 full 通过，无 skip，`verify:local --all` exit 0）。

  - **关联 ID / 合同**：V01（两真实 OS 进程 + 真实 Pi 端口，faux）、V02（真实 SDK + faux：真实 mesh 工具 session 内调、abort→consumed(partial)、mesh 级磁盘 `SessionFactory.open`）、V03（100 seed 崩溃性质 + 6 窄窗口含原子性负向证明 + D03 JSONL 去重三类等价证据）、V04（3 基准 + 20% 回归）、V05（规模正确性）、V06（真实 Host canJoin/群限额/锁路径）、C07（Node ≥22.19.0 / pi 1.1.0）、G01–G07 可重复机器判定。
  - **验收骨架**：`scripts/verify-local.mjs`（`--suite`/`--all`；任一 gate fail exit 1、带 `--skip-*` 却跑全程 exit 2 明示「非 full」）；`scripts/lib/consume.mjs`（`.mts/.cts` 类型消费自 `pack.mjs` 抽取）；`scripts/gen-gap-ledger.mjs`（41 项台账 + 映射测试并集 `--check`）；`scripts/coverage-gate.mjs` + `scripts/bench.mjs` + `vitest.bench.config.ts`。`package.json` 增 `verify:local`。
  - **G07 覆盖率（阈值只进 verify:local G07，不进 `npm test`）**：`@vitest/coverage-v8` + `vitest.config.ts` coverage 块（core 语句 ≥90%、四范围分支另由 coverage-gate 判 ≥95%）。实测 core 语句 94.11%（6844/7272），四范围分支 delivery 96.6% / state-machine 96.7% / fold 96.5% / overflow-unread 96.4%。为关 95% 先量基线再补 `tests/core/mailbox.test.ts` 分支单测（P1 连续段/无 entry/catchup、兜底六支、outbox 缺省与异常支路等），未降阈值/缩数据/移测试。
  - **默认策略零告警**：`tests/e2e/default-policy-observability.test.ts`——默认策略 9 槽全默认跑 A/B/C，断言 `counters()["policy_degraded"]===0 && ["invariant_violated"]===0` 且 `assertInvariants` 16 绿；`_dev.injectFault("not_writable"/"clock_rollback")` 驱动 I34 告警计数 + `storage_fault` 停发、`clearFault` 恢复（计数单调不回退）。
  - **测试**：全量 621 通过 / 1 跳过（622；`two-process-agent` 为 fork 目标、非目标形态跳过）；G01–G07 各门跑各自门槛测试/脚本（G02 合成基线重开 + 双进程迁移锁、G03 台账、G04 `tests/pi/`、G05 两进程 + 崩溃性质、G06 基准、G07 覆盖率 + 默认策略观测）全绿。
  - **API/schema 影响**：增量迁移 `001_presence_source`/`002_pool_meta`/`003_claim_owner`/`004_delivery_decision`（`000_init.sql` 未动，`gen-snapshots --check` 绿）；`@vitest/coverage-v8` 为 devDependency；`.gitignore` 增 `coverage/`、`reports/`。零公共运行时 API 新增（`verify:local` 等均为 `scripts/`）。
  - **命令与环境**：macOS arm64、Node 24.19.0、pi 1.1.0。执行 `npm run verify:local -- --all`（G01–G07 全门、无 `--skip-*`）exit 0。
  - **剩余风险 / 留待**：① v8 分支总数存在少量跨次漂移（本次 fold 分母 648→650），但 fold 覆盖稳定 96.5%、相对 95% 阈值余量 ~1.5%，并在 `--no-fileParallelism` 下复核通过；② `verify:package`（G08/G09）仍为占位，离线 tarball 安装与文档闭合归 W16；③ 各门槛对真实 LLM/凭据零依赖（faux provider），消费级行为与支持矩阵待 W16 离线包复核。

- 2026-10-17：**W16 完成**——0.1.0 本地包与文档闭合（第 ⑦ 批收尾，V07/V08、H01–H04、C07/C08；G08–G09；M5）。

  - **关联 ID / 合同**：V07（真实消费者：createMesh、迁移、pi 可选安装、ESM/CJS 类型）、V08（coverage 阈值 / API/DDL 快照 / SDK 版本矩阵 / 产物门禁，本地部分）、H01–H04（文档一致性，W16 统一处理）、C07（Node≥22.19 / pi ^1.1.0 直接依赖 + 惰性加载）、C08（公共出口 / 根类型 + API 快照）；G08（tarball 消费者）、G09（交付一致性）、M5（本地包就绪）。§12.1/§12.3 的「SessionFactory 唯一必填」随 LD1 在本刻记为差异（见 W00）。
  - **核心判定**：「离线安装」= 与仓库隔离的真实 `npm install <tgz>`（非 `npm --offline`、非解包软链），以行使依赖解析 / engines / 原生构建，作为 G08 相对 `pack.mjs` 软链冒烟的差异证据。 「有无 pi」两腿：有 pi = 真装（pi + better-sqlite3 都真装）；无 pi = 真装后删 `node_modules/@earendil-works` 再重跑 core-only 冒烟，证明 root/core 运行时无静态 pi 依赖（等价 pack 的「不软链 pi」语义，但基于真实安装）。「全部 examples」= `examples/quickstart.ts` 一份，由纯 log 改为 `check(cond,label)` 断言并置 `process.exitCode`。
  - **G08 实现**：新增 `scripts/verify-package.mjs`（镜像 verify-local 骨架：`run/requireRun/step/ok/fail`、`--suite`/`--all`、full 语义 exit 2）。确保 tarball 存在（缺则 `npm run pack -- --skip-tests --skip-verify` 重建）→ mkdtemp 消费者工程 `npm install <tgz>` → (A) 包根/core × ESM/CJS import 矩阵（有 pi）；(B) core-only 真实文件 DB：`createMesh({dbPath})`→注册/send/`checkInvariants`/`inboxOf`→close→直接读 `schema_version==='1'`→重开幂等迁移（无 `.premigrate.bak`、数据完整）；(C) pi 配置装配探测（`import("@earendil-works/pi-coding-agent")` 可解析 + `createMesh({llm})` 装配成功或类型化 `MeshConfigError` fail-fast，仅 `ERR_MODULE_NOT_FOUND` 判失败）；(D) 无 pi 腿删 `@earendil-works` 后重跑 (A)(B) core 部分；(E) 复制 `examples/quickstart.ts` `node` 原生剥壳直跑断言。五腿全 pass。
  - **G09 实现**：`gen-gap-ledger --check`（41 台账 pass）→ 加载 `tests/helpers/disposition.ts` 28 处置项（V/C/D/H，全部 `status:"done"`、证据为 `G0x` gate 或仓库相对路径且存在）→ 合计 69 项全部有去向；版本三重核对（`package.json`/`package-lock.json`/`store.ts LIBRARY_VERSION` === `0.1.0`）；tarball 名单 REQUIRE 10 关键文件（含 `dist/index.d.cts`/`dist/core/index.d.cts`）+ FORBIDDEN 前缀（src/demo/tests/docs）+ LEAK 正则（`.db/.sqlite/.jsonl/.key/.pem`）无泄漏；`sha256` → `reports/verify-package.json`；changelog 条目存在 + README 无旧标记（「258 tests」「多进程 Transport（P5 deferred）」）。
  - **文档闭合**：`README.md` 12 处漂移修正（replay 基础转写、sameHost 多进程、Presence 七值、demo 群聊面板事实、测试数 622/70 文件 + 4 bench、测试文件枚举、工程结构补 envelope/health/seal + 001–004 迁移 + 新 scripts）+ 末尾新增支持矩阵（Node≥22.19 / ESM+CJS / pi ^1.1.0 直接依赖惰性加载 / better-sqlite3 ^13 / sameHost 多进程）；规范 H03 命名收敛（§9.4 `sinceJoin→since_join`、`"all"→"full"`；`PresenceState` 七值三处 + 「五值/五态」改「七值」；附录 C 事件载荷对齐代码：`message_acked` envelope→correlationId、`inbox_overflowed` count→foldedCount、`presence_changed` 补 source/until?/reason?、`policy_degraded.reason` 补 `"illegal"`、`degradedTo: DegradeTarget`、`endpoint_state_changed` 删 reason）；`AGENTS.md`/`.agents/AGENTS.md` Node/pi 表述与 package.json 对齐；changelog `.agents/notes/changelog/2026-10-17-v0.1.0.md`；`package.json` 增 `"verify:package"`。
  - **API/schema 影响**：零 schema 变更、零公共运行时 API 新增（`verify:package` 为 `scripts/` 入口；`disposition.ts` 仅在 `tests/helpers/`，不进产物）。
  - **命令与环境**：macOS arm64、Node 24.19.0、pi 1.1.0。执行 `npm run pack`（tsc / check-imports / gen-snapshots / vitest / tsup / 软链冒烟 / 类型面消费全绿，tarball 重建）→ `npm run verify:package`（G08+G09 full、无 skip、exit 0）→ `npm run verify:local -- --all`（G01–G07 复核全绿、无 skip、exit 0）。
  - **偏差（按计划第 3 条「偏离规范须记录」）**：① 「离线安装」= 隔离真实安装、允许访问 registry（非 `npm --offline`；真 `--offline` 需预置本地 cache/镜像，与本环境联网事实及「不能软链仓库依赖」的原始门槛不符）；② 「无 pi」腿 = 真装后删 `@earendil-works`（pi 是硬依赖，无法在 install 阶段省略），等价 pack 的「不软链 pi」语义但基于真实安装；③ 支持矩阵不声称已验证 Node 22.x（`engines>=22.19.0` 为下限，本机实测 24.19.0）；④ `quickstart.ts` 自引用 `@pi/agent-mesh` 依赖 Node 包自引用解析 + 原生 TS 剥壳，已实测成立（G08 E 腿 exit 0）；⑤ 「全部 examples」= quickstart.ts 一份（`examples/` 无其它文件）。
  - **剩余风险 / 留待**：① G08 全 pi 腿不做真实 LLM turn（零真实模型/凭据约束），以「import 矩阵 + core-only 功能 DB + `createMesh({llm})` 配置解析/fail-fast」作为 pi 已装且可加载的运行时证据，真实 LLM 闭环仅 demo 手工验证；② 升级库件（从 74e20c8 合成基线或历史发布库升级）按计划为「非目标」，未进 G08 矩阵（G09 只做「是否存在」轻量断言）；③ 非 macOS arm64 的 OS 与其它 Node/SDK 版本未验证，支持矩阵只声明 `>=22.19.0` 下限 + 本机 24.19.0 实测。

- 2026-10-19：**复核本计划的交付面，结论：W00–W16 的关闭记录属实，本计划继续保持 `done`，不重开。** 实测（Linux x64 / Node 22.20.0 / pi 1.1.0）：全量测试 **621 passed + 1 skipped（622，70 文件）**、`check:imports`、`typecheck`、`gen-snapshots --check`、`build` 全绿；`verify:local` 的 G01–G05 与 G07 通过（G07 单独跑，exit 0）。**唯一判不了的是 G06**——三个基准的正确性断言每轮都过，但"相对基线退化 ≤20%"与"≥200 任务/秒"是按 §8.2 的 macOS arm64 参考机标定的绝对值，换机即不成立；这不构成退化的证据，也不构成没有退化的证据。关闭之后仍悬空的事项（事件 `endpointId` 未全覆盖、`MeshEvent` 判别联合无生产路径、`wake_per_message_busy` 无自增点、LD6 多 profile 未实现、G06 口径机器绑定、demo 在 `615c1f0` 超出 LD8/D07 范围）以及各工作包"剩余风险 / 留待"里仍无人接的条目，已另立 [`notes/plan/2026-10-19-post-0.1.0-open-items-plan.md`](../plan/2026-10-19-post-0.1.0-open-items-plan.md)，**不在本计划追加**。同日按 v0.1.0 实现回填规范（规范变更记录 1.0.1），W00/W01 的两份技术文档在结论并入规范后归档。
- 2026-10-19：**本计划归档**（`status: done` → `archived`）。完成判定见 §1 的状态说明，复核证据见上一条。本文此后只作历史依据：C01–C10 合同、LD1–LD8 决策、69 项去向与 §11 的 W00–W16 关闭记录仍可引用，但**不得据此判断当前该做什么**——当前计划与当前契约分别以 `notes/plan/2026-10-19-post-0.1.0-open-items-plan.md` 与规范为准。
