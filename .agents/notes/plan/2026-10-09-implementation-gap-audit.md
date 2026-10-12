---
title: 实现差距审计清单（plan / review / tech 全量静态核对）
date: 2026-10-09
status: draft
owner: unassigned
tags: [plan, audit, implementation-gap, static-review, no-implementation]
related:
  - 2026-09-07-p0-p1-rollout.md
  - 2026-09-28-p2-p4-final-implementation.md
  - 2026-09-29-deferred-cleanup-and-samehost.md
  - 2026-10-01-deferred-fixes-plan.md
  - ../review/2026-09-29-deferred-capabilities-audit.md
  - ../review/2026-09-30-samehost-transport-review.md
  - ../tech/2026-09-07-pi-agent-mesh-spec.md
---

## 结论

按本清单的去重粒度，现有材料留下 **69 个未闭合审计单元**，其中 **40 项是静态可定位的实现或接线差距**：5 项具体子能力未接通，35 项部分实现或契约未闭合。其余是 8 项专项验证缺口、7 项明确延期、10 项待裁决/待核实、4 项文档一致性问题。另有 10 组历史事项已有实现证据，不计入剩余数量。

**69 不等于“69 个功能完全未实现”，40 也不等于“40 个模块没有代码”。** topic、queue、shared、request、sameHost、replay 等均有实现；问题集中在真实装配、状态转换、权限条件、恢复、可观测性和验收证据。旧计划的 `done`、测试文件存在、类型接口齐全，都不能单独证明完整规范已兑现。

本文件是用户要求放在 `plan/` 下的**审计清单式计划**，不是实施授权：不安排优先级、实施顺序、里程碑、工期或负责人，不修改现有实现、配置、测试和历史文档。表中的“闭合条件”仅说明将来怎样验证结论，不要求现在执行。

### 本次确认的口径

- 全部核对，并分类统计已实现、未实现、部分实现、专项验证不足、明确延期及文档过时。
- 只做静态核对：不运行测试、不安装依赖、不启动服务、不调用真实模型、不查询远端发布状态。
- 用户选择“仅列审计清单”，不据此选择“稳定当前版本”或“补齐完整 1.0 规范”的实施路线。
- 群消息定向历史隔离继续延期；缺少 `read` 检查与定向历史隔离是不同问题。
- 静音语义、external 走 SinkHandler 还是 outbox，用户暂不裁决，保持 `blocked`。
- 已登记的 forkAt、精确回放、topic 预算和共享返回简化不自动重新变成必做项。其他矛盾保留原文与当前行为，不替用户决定。

## 审计边界、来源与覆盖

### 快照与方法

- 基线提交：`74e20c87349bcc675c22eefb06681c6d0e0012f6`，分支 `main`；审计日期 2026-10-09，Asia/Shanghai。
- 开始时仅有上一任务生成的未跟踪根 `AGENTS.md`；本次保留不动。
- 范围：4 篇 plan、2 篇 review、1 篇 tech 正文，以及三个目录 README；按文件行数共 9,141 行，其中规范 8,309 行。不是按创建日期筛选历史提交。
- 六个只读分组完成全文阅读和源码对照；另外两个只读分组复核权限误报与关键接线。主审合并重复、抽查调用链，并记录用户裁决。未把分组各自统计相加。
- 第一遍提取承诺与边界，第二遍对照源码/测试并去重，第三遍反证关键结论与检查分类。此次不做文案精简，不删除引用块或改写原始文档。
- “已实现”仅表示有静态执行路径，必要时有对应断言；不表示本次测试通过。“待核实”不升级为已复现故障。全文阅读不等于已动态穷举所有不变量、并发时序或版本组合。
- 代码证据以仓库根目录为基准，`路径:行号` 指上述快照；文档缩写见下表。`related` 路径以本文件目录为基准。

| 缩写 | 来源文件 | 阅读覆盖 |
| --- | --- | --- |
| P07 | [2026-09-07-p0-p1-rollout.md](2026-09-07-p0-p1-rollout.md) | 全文，95 行 |
| P28 | [2026-09-28-p2-p4-final-implementation.md](2026-09-28-p2-p4-final-implementation.md) | 全文，72 行 |
| P29 | [2026-09-29-deferred-cleanup-and-samehost.md](2026-09-29-deferred-cleanup-and-samehost.md) | 全文，101 行 |
| P01 | [2026-10-01-deferred-fixes-plan.md](2026-10-01-deferred-fixes-plan.md) | 全文，157 行 |
| R29 | [2026-09-29-deferred-capabilities-audit.md](../review/2026-09-29-deferred-capabilities-audit.md) | 全文，117 行 |
| R30 | [2026-09-30-samehost-transport-review.md](../review/2026-09-30-samehost-transport-review.md) | 全文，105 行 |
| S | [pi-agent-mesh 规范](../tech/2026-09-07-pi-agent-mesh-spec.md) | 全文，8,309 行 |
| 目录约定 | [plan README](README.md)、[review README](../review/README.md)、[tech README](../tech/README.md) | 全文，共185行 |

### 规范全文覆盖矩阵

| 连续区间 | 范围 | 对照内容及主要剩余归属 |
| --- | --- | --- |
| S:1–1523 | 前言、§1–8 | 定位/非目标、SDK基线、分层、寻址、信封、投递、生命周期；N01/N05、I06–I10、I14–I16、D01–D03 |
| S:1524–3481 | §9–12 | 群治理、14工具、17表与FTS、公共API；N02–N04、I17/I18、I21/I22/I29、C04/C08 |
| S:3482–4966 | §13–21 | Floor、请求、Presence、topic、queue、Shared、Transport、九槽与扩展；I01–I05、I11–I13、I19/I20、I23/I24/I31、D04–D06 |
| S:4967–6413 | §22–26 | 不变量、观测、性能、分期验收、集成；I25–I28/I35、V01–V06、C03/C06/C10 |
| S:6414–8309 | §27–29、附录A–L | 运维、迁移、版本/发布、事件/原因码/配置/风险/开放问题；I26–I28/I30/I32–I35、V07/V08、C07–C10、H01–H04 |

附录风险和开放问题全部纳入阅读，但风险、示例、未来设想不自动算“承诺尚未实现”。未授权访问的外链、远端仓库、registry 和真实运行日志不在验证范围。

## 统计与去重规则

| 主分类 | ID范围 | 数量 | 是否计入40项实现差距 |
| --- | --- | ---: | --- |
| 具体子能力未接通 | N01–N05 | 5 | 是；不代表所在模块整体不存在 |
| 部分实现/契约未闭合 | I01–I35 | 35 | 是；含条件性静态问题，不等于均已复现 |
| 已有基础实现、缺专项验证 | V01–V08 | 8 | 否 |
| 明确延期/保持简化 | D01–D07 | 7 | 否 |
| 待裁决/待核实 | C01–C10 | 10 | 否 |
| 文档一致性问题 | H01–H04 | 4 | 否 |
| 未闭合合计 | N/I/V/D/C/H | 69 | 其中40项实现差距 |
| 已有实现证据的历史关闭项 | E01–E10 | 10 | 不进入69项 |

计数单位是可独立复核的能力/根因簇，不是规范句子、代码行、TODO 数或工时。一个簇可含多个同根因表现；同一事项横跨 plan/review/tech 只计一次。例如周期清扫缺失只计 N01，不因它影响请求、claim、handoff 再增加三项；对应专项测试作为 V 类验收设施记录，不重复计算为功能未实现。**没有建立全部已完成需求的同粒度分母，因此不给“完成百分比”。**

## N：具体子能力未接通（5项）

| ID | 核对结论 | 文档与实现证据 | 未来闭合条件（当前不执行） |
| --- | --- | --- | --- |
| N01 | `createMesh` 未接通运行期 mailbox 周期清扫。启动后新产生的 request/claim/parked/handoff/折叠/缺口维护不能依赖启动时的一次 sweep 自动推进。不是“所有TTL无效”：outbox和exclusive租约有自己的定时器。 | S:1254–1267、3711–3716、4118–4125；`src/index.ts:547–577`；`src/core/mailbox.ts:883–995`；`tests/core/mailbox.test.ts:530–630`、657–679手调sweep。 | 不重启、不手调底层方法，运行期超时状态、事件和等待者都能收敛；关闭时停止调度。 |
| N02 | `AccessControl.canInitiateDirect` 的首聊专用钩子没有进入首聊执行链；有声明和默认实现不等于被调用。 | S:2867；`src/core/router.ts:140–146,415–440`：先ensureDirect，后通用canSend。 | 首次建direct前验证专用拒绝/异常/超时；拒绝不遗留非预期空会话。 |
| N03 | `maxHistoryOnJoin` 可配置/读回，但加入流程没有对应历史注入动作。 | S:1686；`src/core/registry.ts:193–204`；`src/index.ts:655–697`。 | 非零配置仅注入允许范围和数量的历史；零配置无注入。 |
| N04 | 规范所述关闭FTS的初始化能力未提供；DDL和发送链仍固定创建/写FTS。 | S:2337；`migrations/000_init.sql:157–159`；`src/core/router.ts:527–536`；`src/core/types.ts:885–911`。 | 明确支持开关及搜索降级，或正式收窄该承诺；当前只记差距。 |
| N05 | `LogicalClock` 有策略声明/默认实现，生产消息处理未体现可替换时钟的实际调用链。 | S:4752–4760、4782–4792；`src/core/router.ts:386`；`src/core/renderer.ts:118`；`src/core/policies.ts`默认策略装配。 | 替换时钟可观察地影响声明由其负责的行为，并有定点契约验证；不以单纯导出类型关闭。 |

## I：部分实现或契约未闭合（35项）

### 同机运输与持久化恢复边界

| ID | 核对结论、适用条件 | 文档与实现证据 | 未来闭合条件 |
| --- | --- | --- | --- |
| I01 | **sameHost归属与订阅接线**：Host和真实PiStreamPort分别生成writerId，而本地判断比较Host ID；自动warm不经过Host注册transport handler。显式warm仍可能由本机poller投递，不应夸大为sameHost全部不可用。external语义另见C02。 | P01:49–60；`src/index.ts:286,458–477,495–520,1176–1186`；`src/pi/stream-port.ts:172,203–216,515–523`。 | 真实端口显式/自动warm后归属一致；连续两次本地发送、异主发送都有正确接收路径。 |
| I02 | **outbox接收语义与确认**：`handleOutboxDelivery` 不按已存P1/P2/P3及woke执行，统一全文deliver且`triggerTurn:false`；deliver resolve即运输done，entry仍可能未确认。不要混称为delivery已变delivered或已实测丢失。 | P29:59–64；S:4654–4673；`src/core/mailbox.ts:326–373,855–878`；`src/core/transport.ts:120–126`；`src/pi/stream-port.ts:377–392`。 | 本地/异主的投递路径和起轮效果一致；确认窗口不提前结束重试保障。 |
| I03 | **outbox入账原子性与终态收尾**：消息/delivery提交后才publish；失败仅改outbox，未联动delivery；全局前50条后按handler筛选可导致其他端点积压阻塞；done清理未齐。 | S:4654–4673；`src/core/router.ts:480–765`；`src/core/mailbox.ts:326–347`；`src/core/transport.ts:158–216`。 | 崩溃窗口可恢复、失败两层状态一致、端点间不因筛选顺序饥饿；保留清理语义明确。 |
| I04 | **死写者判活保守性**：不存在、损坏、不可读锁被合并为undefined，再按dead处理；未知状态告警及启动恢复范围不完整。已有三态判活与回收入口，不重新算“完全无死锁恢复”。 | P01:43–67；`src/pi/lock.ts:125–156`；`src/index.ts:327–350,1194–1205`。 | 不可读取/无法比对为unknown且拒接管；只处理明确负责的端点，真实死owner才允许回收。 |
| I05 | **Store事务与安全迁移**：BEGIN在try外且先增inTx，若BEGIN抛错，同一Store后续可能被误判嵌套；打开Store及迁移早于实例锁。已有SQLite迁移事务，不能推断并发启动必然损坏。 | S:2616、6659–6701；`src/core/store.ts:81–174,177–200`；`src/index.ts:313–338`；`tests/core/store.test.ts:13–48`。 | BEGIN失败后可重试；迁移锁序、备份前置、版本合法性、失败续跑按明确契约验证。上一发布基线另见C07。 |

### 消息保真、投递与运行时

| ID | 核对结论、适用条件 | 文档与实现证据 | 未来闭合条件 |
| --- | --- | --- | --- |
| I06 | **信封端到端保真**：ext保存到DB，但实时草稿遗漏；重载投递信封只保留payload.text，data/attachments等信息不完整，首投、事件、重投可能不一致。 | S:765–809、878–885、4839–4854；`src/core/router.ts:370–388,524,752–761`；`src/core/mailbox.ts:1660–1696`。 | 带ext/data/attachments的首投、重试、跨进程和观测投影一致，符合不可变信封约束。 |
| I07 | **seal闭环**：底层MeshRouter能生成HMAC，core入口也可被外部手工装配；但createMesh无启用接线，库内消费验签未闭环，不可宣称完整篡改检测。 | S:5085–5115；`src/core/router.ts:825–849`；`src/index.ts:556–575`；`src/core/types.ts:885–911`；`tests/core/router.test.ts:1095–1120`仅测生成。 | 如保留该承诺，支持入口可启用，篡改消息在消费前拒绝且有告警；否则明确仅底层生成能力。 |
| I08 | **原文预算执行**：retention返回bytes未使用，unreadBytes传0；达到会话预算上限的判断不等于按LRU保留若干会话；evictionOrder与工具读史记账未闭合。 | S:1057–1096、1914；`src/core/mailbox.ts:532–611`；`src/index.ts:152–162`；`src/core/tools.ts:721–732`。 | 字节/会话预算、淘汰选择和工具读史计量在真实调用链生效；失败降级口径先处理C03。 |
| I09 | **P2实际使用与确认**：安装hook即确认，runner缺失返回空函数也可确认；空文本不清旧hook；按账号确认全部queued P2而非实际端点/集合。生成注入预览未排除P3，只读note可能被混入正文。 | S:1139–1160、5588–5601；`src/index.ts:443–452`；`src/pi/stream-port.ts:430–466`；`src/core/mailbox.ts:1181–1197,1310–1348`。 | hook未执行/被覆盖不误确认；最终上下文与确认集合一致；双端点不互相确认，P3不进入P2正文。 |
| I10 | **CATCHUP摘要固化**：digest被计算，note只保存计数和区间，随后旧queued行被消费；库内没有把该摘要正文持久化并送入上下文的对应路径。不是断言任意宿主扩展都绝不可能入模。 | S:1162–1174；`src/core/mailbox.ts:650–682`；`src/pi/stream-port.ts:418–425`；`tests/core/mailbox.test.ts:466–479`只断言note与清零。 | 可辨识旧正文进入持久摘要及下一轮最终输入后再推进消费；状态与注入路径一致。 |
| I11 | **请求应答闭环**：登记/ack已实现，但端点绑定、exclusive窗口、group回程定向、归档abandoned与普通correlation应答事件不全；阻塞request在route后订阅，存在快ack丢事件窗口。late是否接受先见C06。 | S:3633–3774；`src/core/router.ts:650–697`；`src/index.ts:785–951`；`src/core/registry.ts:555–559`；`tests/e2e/acceptance.test.ts:545–575`仅基础往返。 | 请求方收到一次正确终态；快响应/跨进程/归档/端点归属/租约均有闭环。deadline持续推进归N01，不重复加项。 |
| I12 | **queue任务生命周期与授权**：claim缺queue类型/成员/收件归属校验并改写原信封payload；通用turn_end可在claim前消费任务；未领取期限、重派目标/pending同步、死信通知不完整。已有claim/ack/nack不等于竞争消费契约完整。 | S:4099–4219；`src/core/mailbox.ts:800–834,1363–1474,1560–1596`；`src/core/router.ts:669–685`；`tests/core/mailbox.test.ts:861–883,924–976`；`tests/e2e/acceptance.test.ts:497`绕开自动消费。 | 只有合法当前领取者能推进任务；未领取/失联可重派，任务仅按认可终态推进游标；信封不因claim被改写。定时基础归N01。 |
| I13 | **topic订阅与当前投递语义**：重复订阅覆盖起点/时间，退订游标处理不符，缺canSubscribe接线；full历史可越订阅起点；stream订阅者按无membership归P3，mentions原文承诺不完整。 | S:3971–4001、4061；`src/core/registry.ts:728–736`；`src/index.ts:130–144,957–989`；`src/core/mailbox.ts:267–275`。 | 重复订阅幂等，订阅边界/读权明确，mentions按约定可见。全fanout预算优化属于D04，不并入此项。 |
| I14 | **唤醒与忙流调度**：仅P1判唤醒，使预算外urgent/请求可能不醒；忙流统一关闭唤醒未覆盖steer语义和合并；默认等待应答归因链需校正。 | S:374–380、1027–1048、1096、1230；`src/core/mailbox.ts:279–324,390–401`；`src/index.ts:414–429`；`src/core/router.ts:689–696`。 | 呈现档位与唤醒按契约解耦，busy/steer/应答有可核验行为和解释；direct失败降级不强行裁决，见C03。 |
| I15 | **拓扑持久化与多端路由**：selector数组只取首项；pooled恢复成size=1/affinity=none；返回端点归属未统一验证。perConversation已有精确key+hash，不能重新说恒取首端点；scope/key取舍见C05。 | S:974、1332–1363；`src/core/mailbox.ts:195–203`；`src/core/registry.ts:148–149,359–378`；`src/core/policies.ts:326–337`。 | 拓扑重启前后不变，多端选择按合同执行并校验账号/端点关系；策略语义裁决后再补验收。 |
| I16 | **生命周期/租约/关闭**：热流重复warm不升级exclusive；exclusive到期降级仅更新DB和StreamRec，未同步底层EndpointLock，devMode后续写入仍可能被过期exclusive判定拒绝；存在未消费行时evict可拒绝，close仍可能继续关DB；abort消费归因固定partial=false。 | S:1273、1388–1436；`src/pi/stream-port.ts:181–182,281–308,507–510`；`src/pi/lock.ts:175–190`；`src/index.ts:1088–1091`；`src/core/mailbox.ts:843`。 | 租约升级/到期和锁信息一致；关闭后没有遗留session写者；正常/中断回合归因与端点附着边界明确。 |

### 权限、共享状态和工具装配

| ID | 核对结论、适用条件 | 文档与实现证据 | 未来闭合条件 |
| --- | --- | --- | --- |
| I17 | **读权限与topic名单隔离**：history/members只查成员不查read；未订阅者调用topic members可因工具无法识别topic而得到完整名单。仅定向历史不过滤不算本项漏洞，见D07。 | S:745、1834–1836；`src/index.ts:122–192`；`src/core/tools.ts:805–816`；`src/core/observer.ts:539–552`。 | 无read成员不得读；topic按订阅权限/计数契约返回，撤权后的未读与注入同步受控。 |
| I18 | **群治理I8与操作边界**：setCaps/remove/最后一人成员leave可失去最后setCaps；建群/入群/升级限额和失败原子性不完整。宿主nonmember by是否override另见C04，不能直接宣称Agent可越权管理。 | S:756、1631–1653、1704、1786–1812；`src/index.ts:643–768`；`src/core/registry.ts:490–534,662–668`；`src/core/observer.ts:930–943`检查dissolve而非setCaps。 | 保留最后管理能力；失败不留下半完成群结构；人数/群数、升级历史默认和身份边界一致。 |
| I19 | **Shared ACL执行**：put优先用调用方的新ACL检查旧对象；delete按write而非admin；custom tag缺resolver/default resolver可放行且绕过超时。新ACL入口属于宿主按as调用，Agent工具本身不能传ACL，不能误称任意Agent可提交新ACL接管对象。 | S:4325–4329、4475–4503；`src/core/shared.ts:194–206,269–276,336–379`；`src/core/policies.ts:234–258`；`src/index.ts:223–227,1167–1172`。 | 旧ACL与admin修改边界明确；无人判定custom应按规范拒绝且受超时保护；宿主可信不抹去声明的as权限语义。 |
| I20 | **Shared CAS/append/墓碑版本**：事务前读版本，跨ACL await后写入，存在并发旧版本窗口；版本唯一键可能回滚，不能无条件断言丢更新。del写历史v+1却不推进当前version，重建可撞版本键。 | S:4283、4315–4317、4353–4382；`src/core/shared.ts:176–266,279–285,454–485`；`tests/core/shared.test.ts:106–139,201–215`为顺序场景。 | 并发结果满足已选CAS/append合同，返回标准冲突而非意外SQL错误；删除再建单调推进版本。 |
| I21 | **工具输入/结果契约接线**：shared put声明append却仍覆盖写，contentType等参数未完整传递；list声明sinceVersion/limit却忽略。get历史version入参实际已透传，但成功结果只返data；list仍可取版本，不能说CAS完全不可用。 | S:1841–1843、1872–1875、2025；`src/core/tools.ts:1196–1305`；`src/index.ts:219–234`。 | 支持的参数必须生效或明确拒绝，append不得静默变replace；成功结果元信息与D05的返回简化分开裁定。 |
| I22 | **Agent Inbox装配**：工具接Mailbox简化投影，recent/verbatim/两向ack/claimable/myClaims等没有达到完整Observer投影；完整假Context测试掩盖装配差距。 | S:1955–1999、4215–4219；`src/index.ts:118–120`；`src/core/mailbox.ts:1269–1306`；`tests/core/tools.test.ts:224–238`。 | 真实mesh工具能看见当前待答、可领取任务和必要上下文，不以独立Observer或mock返回完整替代。 |
| I23 | **Shared通知与归档边界**：通知直接发会话普通event，未按对象read ACL筛接收者，也未固定silent；写入路径缺归档禁写。best-effort本身允许，不能把允许丢通知列为缺陷。 | S:4424–4429、4447–4455、4510–4512；`src/index.ts:589–603`；`src/core/shared.ts:154–246`。 | 私有对象通知不泄露给无read者，不意外唤醒；归档读写按既定合同验证。 |
| I24 | **Presence状态派生与覆盖**：到期简单视offline，无回落事件；显式offline可能又按热端点改available；idle时长派生未接，busy规则/事件元信息不完整。online/idle与available/away命名也需统一。 | S:3807–3859、3901–3913；`src/core/types.ts:32`；`src/core/registry.ts:278–302`；`src/core/mailbox.ts:1708–1725`；`src/index.ts:1109–1113`。 | 区分无显式覆盖与显式offline，到期回落可观察，状态/唤醒/事件采用同一语义。 |

### 可观测性、配置与保护机制

| ID | 核对结论、适用条件 | 文档与实现证据 | 未来闭合条件 |
| --- | --- | --- | --- |
| I25 | **Observer强制只读与C10**：有只读API实现，但复用写连接，没有DB层query_only隔离；C10仅检查锁文件存在，不检查活owner；违反报告没有完整告警闭环。 | S:4994、5381、5470–5474；`src/core/observer.ts:182–185,852–882,956–974`；`tests/core/observer.test.ts:425–439,905–942`。 | 不能借Observer改库；活锁判定真实；告警由谁负责先见C10，避免让只读查询偷偷写计数。 |
| I26 | **事件载荷与分支覆盖**：EventBus不统一补端点元信息；sink/P3成功、fold终态等路径没有全部对应事件；Presence/Shared事件缺部分约定归因字段。 | S:2990、3305、7338–7358；`src/core/events.ts:33–44`；`src/core/mailbox.ts:350–363,505–507,1060–1088,1602–1611`。 | 各认可状态跃迁的事件数量、身份/端点、载荷有合同测试；附录与正文载荷冲突先按H03对齐，不误报已有字段。 |
| I27 | **计数器生产及单位**：23名称和补零存在，但blind_write/claim_timeout/queue_cleared_detected无生产递增；fold_events按受害行而非动作计，busy未实际起轮仍加busy；部分降级事件不加计数。 | S:5330–5351、7460–7528；`src/core/store.ts:17–43,212–225`；`src/core/mailbox.ts:392–397,1081–1082`；`src/core/shared.ts:502–509`。 | 计数有实际生产入口，单位/事务一致；测试测行为引起的增量，不只测名称与零填充。 |
| I28 | **决策轨迹解释性**：trace主要返回当前delivery投影，非默认决策note/时间线不全；忙流抑制不写原因。 | S:5207–5248；`src/core/observer.ts:300–314`；`src/core/mailbox.ts:390–401`；`tests/core/observer.test.ts:635–675`。 | 可从公共观测面解释为何降档、不醒、重投及终态，不要求人工拼接内部表猜原因。 |
| I29 | **工具输出与描述护栏**：限额收缩后truncated标志不总反映真实截断，极端兜底切字符串不保证合法JSON；toolResultMaxBytes校验但未传入实际固定8192的构造；描述语义标记/生产回退不齐。 | S:1889–1891、2032–2035、7552–7553；`src/core/tools.ts:32,95–129,250–268,1382–1440`；`src/index.ts:278,465,1207–1210`。 | 所有输入规模返回合法结构和正确截断提示；配置确实控制输出；描述护栏覆盖生产与开发模式。 |
| I30 | **会话配置收紧与回读**：读取投影夹取限额，但fold直接读原JSON可绕过全局上限；claimTtlMs不收紧；未知键落库后回读丢失。 | S:1704、2204、6424–6430、7591–7593；`src/core/registry.ts:179–204,490–513`；`src/core/mailbox.ts:1013–1020,1416–1417`。 | 同一有效配置贯穿写入、读取和执行；会话不能扩大全局硬限制；未知扩展键按合同保留。 |
| I31 | **sink投递重试与档位**：handler接收/消费基本链存在，但固定followUp、首次拒收即park，缺约定的指数退避/连续拒绝处理；普通sink/external发言仍可能经过Floor。 | S:958–972、4872–4876；`src/core/mailbox.ts:475–507`；`src/core/router.ts:390–413`。 | 非stream的档位、免Floor、拒收次数及退避按合同；external运输方式须等待C02，不借本项先重定义。 |
| I32 | **收件箱缓存/折叠运行态一致性**：部分终态drop不扣缓存，markRead游标/overflow清理条件偏宽，字符长度与字节计量混用。重启重算已实现，不等于运行期每个转换正确。 | S:1114–1133、1181–1189；`src/core/mailbox.ts:687–705,1640–1657`；`src/core/router.ts:699–716`；`src/core/store.ts:227–260`。 | 每次状态转换后缓存可与权威delivery重算对齐；游标不越过未完成内容，UTF-8字节口径一致。 |
| I33 | **策略保护的实际覆盖**：部分异步槽已有超时，SessionFactory/custom ACL等仍直接await；同步Guard无耗时/非法返回校验，工厂NO_SESSION最终可被统一改成PORT_TIMEOUT；九槽统一保护和重入检测未齐。具体失败放行/拒绝口径见C03。 | S:4782–4822、4995、5138–5164；`src/core/policies.ts:58–94`；`src/pi/stream-port.ts:218–246`；`src/core/shared.ts:366–379`；`src/core/mailbox.ts:428–439`。 | 各槽慢/抛错/非法值/重入有明确有限结果及正确原因码，不将冲突的fallback先当确定修法。 |
| I34 | **运行故障监测**：基本PRAGMA/回滚/锁已有，但CLOCK_REGRESSION、STORE_UNWRITABLE停发、WAL阈值告警、启动integrity_check及断言拒启等所述保护未形成完整执行链。 | S:4735–4738、§27；`src/core/store.ts:81–110`；`src/index.ts:313–367,490–577`。 | 通过明确故障注入观察停发/告警/恢复边界；不把正常运行未出错视为保护已验证。 |
| I35 | **devMode与自定义渲染安全**：已有转义/包裹/部分断言，但ext Proxy、纯函数双跑、事务后增量断言、跃迁/事件记录等未齐；包裹检查不要求开标签前无裸文本，生产修壳缺告警。 | S:4989–4990、5074–5079、5644–5663；`src/core/renderer.ts:62–72`；`src/core/mailbox.ts:450–461`；`src/core/store.ts:177–200`；`tests/core/policies.test.ts:57–87`。 | 边界语料无法越壳；已承诺的诊断护栏有真实触发路径。策略重入归I33，不重复计一项。 |

## V：专项验证缺口（8项，不等于功能未实现）

现有测试未在本次执行；下表只记录测试源代码/设施与验收要求之间的具体差距，而不是把“本次没跑”当缺陷。

| ID | 已有证据与尚缺的专项验证 | 依据与边界 |
| --- | --- | --- |
| V01 | sameHost已有同进程双Host、FakePort和手造锁测试；缺真正两个OS进程、真实Pi端口、自动warm、崩溃窗口、恰好一次及归属组合验证。 | S:6019–6020、6331、6342；`tests/e2e/samehost.test.ts:39–97,127–142,152–202`，部分只断言数量≥1。实现问题归I01–I04。 |
| V02 | 已有真实SDK+faux CT测试；缺精确nextTurn负面假设、全部内存分支、最终P2上下文、后注册覆盖、真实mesh工具调用、磁盘open/恢复的完整契约矩阵。 | S:451、5531–5603；`tests/pi/pi-contract.test.ts:24–41,124–169`；`tests/pi/stream-port.test.ts:32–59,290–297`。不用真实付费LLM也能验证多数契约；并非强制联网。 |
| V03 | 有手工TTL、假死锁、clearQueue前置测试；缺可复现seed/缩减、六窄窗口故障注入、100次重启和真实JSONL重复应用检测。 | S:5605–5642、5953、6337；`tests/core/mailbox.test.ts:530–586`；`tests/e2e/samehost.test.ts:209–239`。双向恢复实现另见D03。 |
| V04 | 有零唤醒广播成本用例；缺双聊200条、30人500条混合请求、8消费者1000任务三个完整基准，以及吞吐/争用/20%回归设施。 | S:5784–5830；`tests/e2e/acceptance.test.ts:210–250`。不把成本估算公式或旧工时估计当必须实现的功能。 |
| V05 | topic/shared/queue/request有基础e2e；缺30账号冷热、1000订阅者、100并发请求、3消费者100任务及接管、10写者CAS、附件最终上下文等规模/故障验收。 | S:5951–5953、5976–5997；`tests/e2e/acceptance.test.ts:329–363,445–468,485–505,545–575`。并发结果当前只作静态推导。 |
| V06 | 群工具多用mock Context，lock_path多用Map；缺真实Host对canJoin拒绝/异常/超时、群限额/I8、lock_path数据库/C10的闭环验收。 | P01:74–78；`tests/core/tools.test.ts:276–278,795–825`；`tests/pi/stream-port.test.ts:413–436`。实现存在的canJoin不重新列未实现。 |
| V07 | pack有本地ESM/CJS符号冒烟；缺消费者实际createMesh/开库/迁移、Fake端口闭环、pi可选安装、Quickstart、CJS/ESM类型解析及升级数据库验证。 | S:6802、6830、6852、6872；`scripts/pack.mjs:177–213`；`src/core/store.ts:55`；`package.json:13–23`。CJS迁移路径是否运行失败仍待动态验证；发布基线见C07。 |
| V08 | 本地typecheck/G1–G4/test/build/pack存在；未见coverage阈值、公共API/DDL快照关联、最低SDK版本矩阵、完整打包产物门禁及自动CI接线。 | S:6840–6849；`vitest.config.ts:3–14`；`scripts/check-imports.mjs:14–73`；`scripts/pack.mjs:92–154`；`package.json:44–54`。按验收设施计，不把没发布/tag本身算漏功能。 |

## D：明确延期或保持简化（7项）

| ID | 能力与当前界限 | 依据 | 状态 |
| --- | --- | --- | --- |
| D01 | forkAt分叉：唯一明确unsupported的观测方法之一；需要分支语义与租约决定，不能因签名存在算完成。 | P01:108–118、143；`src/core/observer.ts:677–678`；`tests/core/observer.test.ts:902`。 | deferred |
| D02 | 历史时点/字节保真replay：已有零LLM条目转写，但取当前Inbox，未恢复parent/compaction/P2历史输入、模型指纹和byte-fidelity；不把基础replay重复开为全无实现。 | P07:32；P28:41；S:5268–5312；`src/core/observer.ts:636–674`；`src/pi/stream-port.ts:265–270,552–580,642–647`。 | deferred |
| D03 | pi权威恢复双向核对与幂等应用：已有缓存重算和主动beforeClearQueue，缺真实session逐条对账、hasEntries消费接线与绕过清队协议的自动恢复。属于已知正确性债务，不表示已经安全或已完成。 | P07:32；S:1443–1485；`src/index.ts:490–493`；`src/pi/stream-port.ts:484–491`；`src/core/mailbox.ts:1139–1145`。 | deferred；主要依据现有分期及代码注释，未新批准延期 |
| D04 | topic逐订阅者RetentionPolicy/稀疏delivery：最新计划明确保持全fanout，不能按规范某处“零行”断言必须删除现有delivery。 | P01:124–126；S:4011–4016；`src/core/router.ts:546–568`。 | 保持简化 |
| D05 | Shared PutResult/GetResult联合类型及getRaw：保持reject/null，不能强制恢复原联合返回。工具已声明参数却忽略另见I21，不被此豁免。 | P01:127；`src/core/shared.ts:95–123,154–165`。 | 保持简化 |
| D06 | Shared保留窗口/purged：已有按版本数裁剪，不再是无限增长；当前硬删版本行而非仅清data保元信息，purged与tombstone/missing无法完整区分。该项承接既定延期，不再把硬删差异另计为必修缺陷。 | P01:128；S:4392–4419、6539–6542；`src/core/shared.ts:470–485`；`tests/core/shared.test.ts:378–392`。 | deferred；设计保留模型待后续确认 |
| D07 | 定向历史隔离与非GA扩展：用户确认to/mentions历史可见性保持延期。更多Floor轮转/token、queue优先级/deliverAfter、topic分区、Shared增量/自动合并、跨拓扑历史迁移/滚动升级等不纳当前交付承诺，作为未来扩展集合记录，不按每个设想制造欠项。 | 用户本次确认；S:6705–6717、8104–8114、3519–3547。Floor默认free_for_all已存在。 | deferred/未来范围；集合计1个，不用作工作量比较 |

## C：待裁决或待核实（10项，不计确定实现缺陷）

| ID | 冲突/疑问与当前行为 | 证据 | 当前处置 |
| --- | --- | --- | --- |
| C01 | 静音保留Inbox但不唤醒，还是dropped(MUTED)？当前采用后者，规范两者都有。 | S:1748与2235、2772；`src/core/mailbox.ts:166–172`。 | blocked；用户明确暂不裁决。 |
| C02 | external由SinkHandler负责，还是必须选端点走sameHost outbox？当前先走sink分支，P01要求恒outbox。自定义Transport非内建类时如何确认远端归属也需定义。 | P01:55–60；S:958–972、4617–4634；`src/core/mailbox.ts:175–178`；`src/index.ts:495–520`。 | blocked；用户明确暂不裁决；I01只处理明确stream接线。 |
| C03 | floor失败放行全集还是不授予；activation/direct、retention失败与同步策略超时后的fallback以哪处为准？不能将现有floor放行直接标安全缺陷。 | S:2826、3582–3594与5159；S:4752–4792、5138–5164；`src/core/router.ts:396–405`；`src/core/mailbox.ts:282–305,532–546`。 | blocked；保留相互矛盾的要求。 |
| C04 | 宿主可信代行与按by/as检查的边界：nonmember by跳过cap是否正式认可？常规Agent工具有成员/cap前置校验，不能等同Agent越权。 | S:2769、2779、2786；`src/index.ts:621–632`；`src/core/tools.ts:1010–1055`。 | blocked；I18的最后管理员保护不依赖此裁决。 |
| C05 | perConversation为精确key、hash槽位还是先匹配再hash？purpose/conversation混合scope、无匹配时可否复用其他流需要一致定义。 | P01:88–102；S:1332–1363；`src/core/policies.ts:326–337`；`tests/core/selector.test.ts:33–95`。 | blocked；旧“恒eps[0]”问题已关闭，不重复开单。 |
| C06 | 非open的late应答到底允许入账还是必须拒绝？重复ack如何保持身份与幂等，不可从冲突条款直接选一套。 | S:3677–3729；`src/index.ts:791–839`；`src/core/router.ts:203–215,495–524`。 | blocked；I11仍保留不依赖late取舍的确定接线差距。 |
| C07 | 发布目标、上一真实发布DB、Node/pi支持矩阵、备份豁免与真实LLM验收是否需要？包是0.1.0，开发SDK0.85.1，peer下界0.84.4；没有查询registry，不能断言已发布或从未发布。 | S:6659–6740、6840–6872；`package.json:3,10–12,44–54`；`package-lock.json:551–583`。 | 待用户将来确定发布/验证范围；不安排发布任务。 |
| C08 | 公共出口应严格只保留规范公共面，还是认可现有core实现类出口？根缺若干Observer/策略/投影类型，但core暴露内部实现；可能涉及兼容性。 | S:2630–2634、6588–6600、7914–8001；`src/index.ts:1224–1274`；`src/core/index.ts:7–57`。 | blocked；记录差异，不自行加减导出或收紧门禁。 |
| C09 | 历史保留/自省投递语义：topic历史裁剪与消息不可删除如何兼容；发送者排除与同账号另一流可收如何协调？ | S:928–974、6544–6548；`src/core/router.ts:595–628`。 | blocked；D06只涉及Shared版本，不能拿它回答消息保留问题。 |
| C10 | Observer只读时谁发告警/记数；精确回放的exclusive由谁持有；自定义StreamPort按能力认证还是统一降级；clearQueue检测的保证边界为何？ | S:513、4994、5002、5308–5310、5470–5474、6205、6384；`src/index.ts:479–485`。 | blocked；与I25/D02/D03关联，但不重复增加功能缺口。 |

其余仅静态无法证明的运行表现，例如SQLITE_BUSY是否在特定机器出现、并发CAS最终异常类型、CJS迁移路径实际表现、SDK是否自行校验宿主工具 `mesh_*` 命名冲突，都不得写成“已复现”。对应验证归I05/I20/V02/V07，不额外凑数量。

## H：文档一致性问题（4项，原文均未修改）

| ID | 需要记录的漂移 | 证据与处置 |
| --- | --- | --- |
| H01 | 旧计划todo/done、review“关闭”混淆了子项已落地与完整契约。P01声明归属/死写者完成，仍有I01–I04；旧perConversation桩已消失但选择契约仍待定。 | P01:4、30–104；R29/R30；后续如更新状态必须保留历史事实，本次不改原文件。 |
| H02 | README仍有多进程不做、五能力Tab、旧测试数量等过时叙述；demo已是群聊面板，旧五页/一键场景曾被作废，不能据旧todo强制恢复UI。 | `README.md:18–19,167–188`；R29:116；`demo/public/app.js:224–310`；P01:132–134与当前UI不一致。 |
| H03 | 规范内部枚举、事件字段、失败分支与命名未统一：history sinceJoin/all与since_join/full，Presence命名，grade是否NULL，附录事件载荷与§12.5，F编号、hybrid/correction、dispose/close等。 | S:1673、2355、2990、3116、3186、5586、7338–7358、8156、8182、8250–8309；有语义影响的冲突按C类阻塞，不把全部文字差异计代码缺陷。 |
| H04 | 说明中的保证强于已有证据：topic“零delivery”、历史“永久保留/无限增长”、full replay、sameHost“多进程恰好一次”、最低SDK和发布/打包“已验证”等需要标明真正边界。 | P01:128；R29:42、114；S:1775、4011–4016、6339；`tests/e2e/samehost.test.ts:39–97,132`；当前Shared确有prune，包发布未查询。 |

## E：已有实现证据、不重新算未实现（10组历史项）

这些是对旧plan/review的关闭映射，不是全仓功能完成清单，也不抵消同模块的其他差距。

| ID | 历史事项 | 当前证据与关闭边界 |
| --- | --- | --- |
| E01 | P07基础schema、双入口与构建骨架 | `migrations/000_init.sql:10–290`已有17表/FTS；`tsup.config.ts:4–11`、`package.json:13–30`有双入口/双产物。迁移/消费者保证另见I05/V07。 |
| E02 | P07基础路由、工具、端口契约、验收骨架 | `src/core/router.ts:480–765`、`src/core/tools.ts:233–291`；`tests/e2e/acceptance.test.ts:108–320`、`tests/pi/pi-contract.test.ts:24–169`。不能由此标全语义完成。 |
| E03 | R29 #8/P29缓存重算缺失 | `src/core/store.ts:233–260`重算派生缓存且不重算cursor_seq/folded_to_seq；`tests/core/store.test.ts:89–110`。完整恢复另见D03。 |
| E04 | R29 #2/P29 topic历史接口 | `src/index.ts:122–162`工具历史入口已有订阅起点过滤；`tests/e2e/acceptance.test.ts:391–437`有区间/非订阅者验证。不是公开host.history方法；full分支余缺见I13。 |
| E05 | R29 #5三向ACL类型与read/write分判 | `src/core/shared.ts:336–379`；`tests/core/shared.test.ts:327–355`。类型和基本分判已做，不代表admin/custom/通知等安全闭环完成。 |
| E06 | R29 #7历史裁剪从零缺失 | `src/core/shared.ts:470–485`已有prune；`tests/core/shared.test.ts:378–392`。仅关闭“没有裁剪”，保元信息/purged仍D06。 |
| E07 | R30旧ack漏调用 | `src/core/mailbox.ts:878`已有transport.ack。只关闭“从未ack”的旧根因，确认时机与P2/P3差异仍I02。 |
| E08 | R30 shared租约多写者与启动探测冲突 | `src/pi/lock.ts:111–117`保持端点单写者；`src/index.ts:358` sameHost启动跳过单实例探测；`tests/pi/stream-port.test.ts:323–336`。真实竞争/恢复安全另见I04/V01。 |
| E09 | P01 lock_path从未落库 | `src/index.ts:470`→`src/core/registry.ts:426–429`，warm/evict接线在`src/pi/stream-port.ts:216,330`。不能再说该列无人写；数据库与活锁完整验收仍V06/I25。 |
| E10 | R29 #9/P01 perConversation恒取首端点 | `src/core/policies.ts:326–337`已实现精确key优先+hash兜底；`tests/core/selector.test.ts:33–95`。仅关闭旧桩，scope与语义冲突见C05。 |

## 不计入剩余数量的范围

- 跨机器网络Transport、安全传输、多租户强隔离、内容审核、库自用LLM、业务编排、人格/记忆等明确非目标，不因不存在就列功能缺口。
- 旧五能力demo页面和一键场景不自动恢复。现有demo功能是否继续扩展是新需求，不由本次审计代为决定。
- 风险登记中的成本估算、共享内容投毒、允许best-effort通知、架构取舍及没有触发条件的弃用流程，不等于待开发事项。
- 没有发布/tag证据不等于发布功能缺失；没有执行测试不等于全部测试缺失；静态找到检查函数不等于它已进入真实执行链。

## 后续使用约束与进度记录

本清单未授权任何实施。将来若用户要求推进，应先选定目标和C类合同，再从相应ID形成独立实施任务；保留本快照结论及新证据，不直接把本清单当成批量改代码指令。本次不预设这样的推进顺序或日期。

闭合记录至少写明：关联ID、裁决后的预期行为、实际改动范围、真实执行的验证、仍未验证的边界。静态发现被反证时保留撤回理由，不能删除不利证据，也不能将所有 `deferred/blocked` 自动转为 `todo`。

- 2026-10-09：完成三个目录全文静态核对、源码/测试对照、关键误报反证和用户口径确认；仅创建本审计清单。未实施修复，未运行测试，未修改历史plan/review/tech、根AGENTS.md、源码、配置或依赖，未提交或推送。
