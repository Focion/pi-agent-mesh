---
title: Mesh 统一 LLM 与运行时配置计划
date: 2026-10-12
status: draft
owner: unassigned
tags: [plan, configuration, llm, pi-isolation, v0.1.0]
related:
  - 2026-10-09-v0-1-0-local-release-plan.md
  - 2026-10-09-implementation-gap-audit.md
  - ../tech/2026-09-07-pi-agent-mesh-spec.md
---

## 1. 目标与结论

目标是让普通使用者只提供 Mesh 配置即可创建、恢复和运行真实 LLM Agent，不需要安装、登录、初始化或维护 pi 的配置目录，也不受机器上已有 pi 配置影响。

完成标准：

1. 模型、Provider、凭据引用、思考级别、内建工具、重试/超时和上下文资源均由 Mesh 配置决定。
2. 默认不读取 `~/.pi/agent` 下的 `auth.json`、`models.json`、`models-store.json`、`settings.json`、skills、extensions、prompts、主题或全局上下文。
3. 默认不读取端点 cwd 祖先目录中的 `.pi/**`、`AGENTS.md` 或 `CLAUDE.md`；宿主需要时通过 Mesh 配置显式开启或注入。
4. 用户不需要显式安装 `@earendil-works/pi-coding-agent`，运行时依赖由 Mesh 包负责。
5. 现有自定义 `SessionFactory` 仍作为高级扩展点；`src/core/**` 保持零 pi 依赖和 M1 宿主无关约束。
6. demo、示例、错误消息和用户文档只说明 Mesh 配置，不再指导用户执行 pi 登录或修改 pi 文件。

本计划仅记录实施路线，不授权修改源码、依赖、规范或发布产物。所有工作项当前均为 `todo`。

## 2. 已发现的配置泄漏

当前 `createPiSessionFactory` 只显式注入少量参数，其余行为由 pi SDK 默认值决定，因此存在以下隐式依赖：

| 来源 | 当前影响 | 目标状态 |
| --- | --- | --- |
| `~/.pi/agent/auth.json` 与 Provider 环境变量 | 决定模型是否有凭据 | 只认 Mesh 显式凭据或显式 `apiKeyEnv` |
| `~/.pi/agent/models.json` / `models-store.json` | 注册自定义 Provider 和模型 | 由 Mesh Provider 配置注册，模型缓存使用 Mesh 私有存储或内存 |
| 全局/项目 `settings.json` | 改变模型、工具、steer/followUp、compaction、重试、超时、transport 等行为 | 使用 Mesh 创建的内存 settings，语义相关项由 Mesh 固定 |
| 全局 packages、extensions、skills、prompts | 注入额外工具和提示 | 默认全部关闭，仅允许 Mesh 显式资源 |
| cwd 祖先的 `AGENTS.md` / `CLAUDE.md` | 非预期进入端点系统提示 | 默认关闭上下文文件发现 |
| pi 默认 read/bash/edit/write 工具 | 未传工具时自动启用 | Mesh 默认禁用内建工具，mesh 自有工具保持可用 |
| `PI_CODING_AGENT_DIR` / `PI_OFFLINE` 等变量 | 全局改变运行时 | 隔离路径并避免把这些变量作为 Mesh 合同 |

另有两个需要优先修复的行为缺陷：

- demo 配置的 `tools: []` 当前没有传给 pi，实际会启用默认内建工具。
- pi 的 `tools` 是全工具白名单；若只传内建工具名，会连同 Mesh custom tools 一起过滤。

## 3. 目标配置边界

### 3.1 推荐公共面

普通路径使用 Mesh 命名的配置入口，内部转换为 pi SDK 对象。配置形态在技术设计阶段冻结，原则如下：

- `llm.providers`：Provider 地址、协议、模型目录和凭据引用。
- `llm.model`：默认 `provider/modelId`。
- `llm.thinkingLevel`：Mesh 支持的思考级别。
- `runtime.builtinTools`：显式内建工具白名单，默认空数组。
- `runtime.resources`：系统提示、skills、prompts、上下文文件等显式资源。
- `runtime.retry` / `runtime.timeout` / `runtime.compaction`：确需开放的运行策略。
- `profiles`：按 `Account.profileRef` 选择模型、提示和工具；首版可以只交付默认 profile，但接口不能把单模型写死成永久限制。

凭据默认不以明文写进可提交配置：优先使用 `apiKeyEnv` 指定由 Mesh 读取的环境变量名，也允许宿主直接注入运行时 secret。Mesh 不镜像 pi 的整套隐式环境变量表。

### 3.2 普通路径与高级路径

计划采用两层公共面，避免把 LLM 领域塞进 core：

1. **普通路径**：包根提供中性命名的 Mesh LLM 装配入口，调用者只传 Mesh 配置。
2. **高级路径**：保留 `policies.sessionFactory`，供自定义 SDK、测试或无 LLM 的宿主使用。

技术设计需要在以下两种普通路径中定案：

- `createMesh({ dbPath, llm, runtime })`：使用最简单，但会修改 §12.1 “SessionFactory 唯一必填”合同，需要将适配层类型与 core 类型清晰分开。
- `createLlmSessionFactory({ llm, runtime })` 后传入 `createMesh`：最符合现有规范和 M1，但普通用户仍需理解 SessionFactory 装配。

**推荐目标是第一种用户体验，同时保留第二种底层能力；若无法在不污染 core 的前提下实现，则首版交付第二种并提供包根便捷包装函数。**

## 4. 隔离策略

默认运行时必须是完全隔离模式：

- 以 Mesh `stateDir` 下的私有目录作为 SDK `agentDir`，不回退到用户 HOME。
- 使用内存 CredentialStore，并由 Mesh 把显式 secret 注册到 ModelRuntime。
- 禁止 ModelRuntime 默认读取 pi 的 models 文件；自定义 Provider 由 Mesh 配置注册。
- 使用内存 SettingsManager；固定 steer/followUp 等与 Mesh 投递语义有关的设置。
- 使用显式 ResourceLoader，默认关闭 extensions、skills、prompts、themes 和 context files。
- 工具白名单由“显式内建工具 + 当前端点的全部 Mesh 工具名”组成，防止 Mesh 工具被误过滤。
- session 文件仍存入 Mesh stateDir；恢复时继续使用当前 Mesh 配置，并校验已保存模型与当前 profile 的差异。

不建议提供模糊的自动继承。若确有迁移需求，只允许一个带风险说明的显式兼容开关，并且不得成为默认路径或测试基线。

## 5. 需要先冻结的决策

| ID | 决策 | 推荐值 | 未决定的影响 |
| --- | --- | --- | --- |
| D1 | 普通公共入口 | Mesh 配置直接创建 host，内部装配 SessionFactory | 影响 §12.1、根导出和类型设计 |
| D2 | 默认隔离级别 | 完全隔离，不继承 pi 文件/资源 | 决定安全基线和测试矩阵 |
| D3 | pi SDK 依赖归属 | Mesh 直接运行时依赖并锁定已验证版本 | 否则用户仍需知道并安装 pi |
| D4 | 凭据来源 | 显式 secret 或显式 `apiKeyEnv` | 决定是否仍存在隐式环境依赖 |
| D5 | 语义设置 | steer/followUp 由 Mesh 固定；重试/超时/compaction 按白名单开放 | 影响投递确认和恢复一致性 |
| D6 | 多 profile | 首版支持 `profileRef` 选择；无引用用 default | 避免后续破坏单模型配置 |
| D7 | pi 命名清理范围 | 本计划先消除配置与安装感知；包名和 `piSessionId` 另做破坏性变更评审 | 防止范围失控 |
| D8 | 与 v0.1.0 的关系 | 作为现有本地发布计划 W01 之前的前置合同 | 避免在发布门禁后重做公共面 |

## 6. 实施步骤

| # | 事项 | 主要产物 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 冻结 D1–D8，并形成技术设计和公共配置 schema | `notes/tech` 设计文档、规范差异清单 | - | todo |
| 2 | 用契约测试固定“不得读取用户 pi 配置”的失败基线 | HOME/agentDir 污染测试、资源泄漏测试 | 1 | todo |
| 3 | 实现 Mesh Provider/模型/凭据解析与 fail-fast 校验 | 独立配置模块、稳定错误码 | 1 | todo |
| 4 | 实现隔离的 ModelRuntime、CredentialStore、SettingsManager 和 ResourceLoader 装配 | pi 适配层运行时工厂 | 2, 3 | todo |
| 5 | 修复工具白名单，明确空数组与 Mesh custom tools 的行为 | session-factory 及契约测试 | 4 | todo |
| 6 | 实现默认 profile 与 `Account.profileRef` 解析，定义恢复时模型变更规则 | profile resolver、配置指纹 | 3, 4 | todo |
| 7 | 提供 Mesh 命名的普通公共入口，同时保留高级 SessionFactory 路径 | 根导出、类型测试、API 快照 | 4, 6 | todo |
| 8 | 调整 pi SDK 的依赖归属和版本矩阵，验证 ESM/CJS 与 optional core 使用路径 | package 配置、消费者冒烟 | 7 | todo |
| 9 | demo 改用 Mesh 配置，删除对 pi models/auth/settings 的镜像解析 | demo 配置层、示例配置 | 7 | todo |
| 10 | 更新 quickstart、README、错误消息和迁移说明 | 用户文档、changelog | 8, 9 | todo |
| 11 | 执行安全、恢复、打包和真实 UI/LLM 验收 | 验收记录、差异复核 | 2–10 | todo |
| 12 | 将结果并入 v0.1.0 本地发布计划并复核全部门禁 | 更新发布计划状态 | 11 | todo |

## 7. 测试与验收矩阵

### 7.1 隔离验收

在临时 HOME 中预置互相冲突的 pi 配置：错误模型、有效凭据、默认工具、extension、skill、prompt、SYSTEM.md 和祖先 AGENTS.md。仅用 Mesh 配置启动后验证：

- 实际模型、Provider 地址和凭据均来自 Mesh。
- pi 的扩展、资源、工具和上下文均未加载。
- steer/followUp、重试、超时和 compaction 行为与 Mesh 设置一致。
- 删除或改变临时 HOME 内容不改变相同 Mesh 配置的运行结果。

### 7.2 工具验收

- `builtinTools: []` 时 read/bash/edit/write 均不可用。
- Mesh 工具仍完整注册、可见并可调用。
- 显式开启一个内建工具时，只增加该工具，不丢失 Mesh 工具。
- profile 切换后的工具集合不串到其他端点。

### 7.3 模型与凭据验收

- 内建 Provider、自定义 OpenAI-compatible Provider、错误模型、缺少凭据、错误 base URL 均有确定结果。
- 错误提示只引用 Mesh 配置项和显式环境变量，不要求 pi 登录。
- secret 不进入日志、事件、session 文件、数据库或配置指纹。
- 同一配置的指纹稳定；恢复时配置变化有明确拒绝、迁移或新 session 行为。

### 7.4 包与用户路径验收

从空目录安装 Mesh 包后：

- 用户不额外安装 pi 包即可运行普通 LLM 路径。
- 仅使用 core/自定义 StreamPort 的消费者不需要准备 pi 配置。
- ESM、CJS、类型声明和本地 tarball 消费者冒烟通过。
- demo 只需复制 Mesh 示例配置并提供 secret 即可启动。

### 7.5 项目门禁

实现完成后至少执行：

```bash
npm run check:imports
npm run typecheck
npm test
npm run build
npm run pack
```

修改 demo 后还必须启动服务并在浏览器验证正常配置、缺凭据、错误模型、空工具集和恢复路径；不得只以核心测试代替 UI 验收。

## 8. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 修改 §12.1 导致 core 开始理解 LLM | 违反 M1 与分层门禁 | 把 LLM 配置和便捷装配限制在包根/pi 适配层，core 仍只认 SessionFactory |
| pi SDK 默认值在升级后重新读取全局配置 | 隔离失效 | 对每个可注入组件做污染测试，并锁定已验证 SDK 版本 |
| 直接依赖 pi 增大安装体积或影响 core-only 用户 | 发布体验退化 | 在 W8 比较直接 dependency、optionalDependency 和拆分适配包；“普通用户无需手装”是硬门槛 |
| 多 profile 与旧 session 模型冲突 | 恢复行为不确定 | 配置指纹不含 secret，模型/profile 变化采用显式合同并补恢复测试 |
| compaction 与 Mesh mailbox 折叠混淆 | 历史语义漂移 | 分开定义 LLM 上下文压缩与 Mesh 权威消息历史，禁止互相代替 |
| 配置文件内联 secret | 泄露凭据 | 示例只使用 `apiKeyEnv`；日志和错误统一脱敏 |
| 过早清理 pi 命名扩大破坏面 | 延误 v0.1.0 | 本计划不自动改包名和持久字段，另做兼容性评审 |

## 9. 与现有计划和规范的关系

- 本计划补充 `2026-10-09-v0-1-0-local-release-plan.md`，不取代其中 C01–C10、W01–W16 和门禁定义。
- 若采用 `createMesh({ llm })`，必须先更新权威规范 §12.1/§12.3 中“SessionFactory 唯一必填”的表述；不得让代码静默偏离规范。
- M1 保持不变：core 不解释模型、提示或业务 profile；包根适配层只负责把宿主给出的配置转换为 SessionFactory。
- 包名、`Endpoint.piSessionId` 等 pi 命名不属于“配置去依赖”的必要条件，除非 D7 另行扩大范围。

## 10. 里程碑

- M1：D1–D8 与配置 schema 冻结，隔离失败测试就绪。
- M2：隔离运行时和工具修复完成，pi 全局配置污染测试通过。
- M3：公共入口、profiles、恢复合同和包依赖完成。
- M4：demo/示例迁移完成，用户只配置 Mesh 即可运行。
- M5：全量门禁、消费者冒烟和浏览器验收通过，并入 v0.1.0 本地发布候选。

## 11. 进度记录

- 2026-10-12：完成现状静态分析并创建本计划；尚未冻结 D1–D8，未修改源码、依赖、规范或测试。
