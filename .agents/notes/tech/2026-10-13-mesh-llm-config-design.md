---
title: Mesh 统一 LLM 与运行时配置设计（W00）
date: 2026-10-13
status: active
owner: unassigned
tags: [tech, llm-config, pi-isolation, w00, ld-decision, api]
related:
  - ./2026-09-07-pi-agent-mesh-spec.md
  - ../plan/2026-10-12-consolidated-open-work-plan.md
---

## 方案概述

让使用者只配置 Mesh：模型、Provider、凭据、内建工具与上下文资源全部由 `createMesh({ llm, runtime })` 决定。library 内部通过 pi 适配层装配 `SessionFactory`（LD1），并做**完全隔离**（LD2）：不读 `~/.pi/agent` 的 models/auth/settings，不继承 extension/skill/prompt/theme/context 文件，不启用 pi 默认内建工具。pi 升为**直接依赖**、锁定最新 1.1.0（LD3），惰性加载（`loadPiSdk`）不变。

本设计把整合计划第 5 节的 LD1–LD8 从「待决策」冻结为「已决策」，并给出配置 schema 与对规范 §12.1/§12.3 的差异清单（不静默改写定稿规范；实改由 W01/W16 记为版本差异）。

## 背景与约束

- 现状：`sessionFactory` 是唯一必填槽（§12.1/§12.3）；`MeshOptions` 无 LLM 字段，库对模型/凭据完全透明；pi 配置复刻逻辑全部在 `demo/src/config.ts`（models.json/auth.json/环境变量、`@earendil-works/pi-ai/providers/all` 的 `getBuiltinModel`）。
- 硬门槛（两条同时成立）：「普通用户无需手动安装 pi」+「core-only 用户不加载 pi」。前者由 direct dependency 满足，后者由 `loadPiSdk` 惰性加载满足（`src/core/` 零 pi 由 G1 门禁保证，`src/index.ts`/`src/core/index.ts` 不静态 import pi）。
- core 不得理解 LLM（M1/M2）：`llm`/`runtime` 字段只停留在包根（`src/index.ts`）与 `src/pi/`，不进 `src/core/types.ts` 的 `MeshOptions`；core 仍只认 `SessionFactory`。
- pi 已从 0.85.1 升 1.1.0（LD3 用户改写），**所有 1.1.0 隔离原语已确认存在**：`ModelRuntime`（`CreateModelRuntimeOptions`）、`CredentialStore`、`SettingsManager`（`SettingsManagerCreateOptions`）、`DefaultResourceLoader`（含 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`）。

## 已冻结决策（LD1–LD8 + C07）

| ID | 决策 |
| --- | --- |
| LD1 | `createMesh({ llm, runtime })` 内部装配 SessionFactory；保留 `policies.sessionFactory` 高级覆盖路径 |
| LD2 | 完全隔离；兼容开关只能显式打开并附风险说明 |
| LD3 | pi 走 `dependencies`，版本取最新 **1.1.0**（覆盖 C07 的 optional peer） |
| LD4 | 显式 `apiKey` 或显式 `apiKeyEnv`；不镜像 pi 隐式环境变量表 |
| LD5 | steer/followUp 由 Mesh 固定；retry/timeout/compaction 按白名单开放 |
| LD6 | 按 `Account.profileRef` 选 profile，无引用用 default |
| LD7 | 本轮只消除配置/安装上的 pi 感知；包名、`piSessionId` 另做破坏性评审 |
| LD8 | demo 只改读 Mesh 配置，不扩展 UI、不恢复旧五页 |
| C07 | `engines.node` → `>=22.19.0`；pi 版本矩阵 0.85.1 → 1.1.0 |

## 设计

### 整体结构（数据流）

```
使用者 ── llm/runtime 配置 ──▶ createMesh(CreateMeshOptions)  [src/index.ts，包根]
                                  │ 缺省装配：去 llm/runtime，转 pi 层配置
                                  ▼
                          src/pi/llm-config.ts   —— 解析/校验/fail-fast（L3）
                          src/pi/session-factory.ts —— 隔离装配 ModelRuntime 等，产出 SessionFactory（L4）
                                  │ policies.sessionFactory（core 契约，LLM 盲）
                                  ▼
                          core 装配（不变）：mailbox/router/port ……
```

核心边界：`llm`/`runtime` 与 `policies.sessionFactory` 二选一满足即可；两者都给时 `policies.sessionFactory` 优先（高级路径覆盖缺省装配）。两者都缺 → `createMesh` fail-fast，错误码语义同步进 W01 的错误码表（暂用 `mesh: createMesh requires either policies.sessionFactory or llm configuration`）。

### 关键设计点

1. **公共签名不落 core**。`src/core/types.ts` 的 `MeshOptions` 保持 `policies.sessionFactory` 必填且无 LLM 字段（core 自证 LLM 盲）。`src/index.ts` 新增并导出 `CreateMeshOptions = Omit<MeshOptions, "policies"> & { policies?: Partial<Policies>; llm?: LlmConfig; runtime?: RuntimeConfig }`，`createMesh` 用它；装配函数把 `llm/runtime` + 解析结果剥离成 core 的 `Policies`。
2. **隔离装配（pi 1.1.0）**——`agentDir` 用 `stateDir` 私有目录；凭据走内存 `CredentialStore` 并由 Mesh 注册 secret；`ModelRuntime` 置 `modelsPath: null`、Provider 由 Mesh 配置注册；`SettingsManager` 内存构造（不给配置路径）；`DefaultResourceLoader` 默认 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全 true。
3. **工具白名单修复**：`runtime.builtinTools`（默认 `[]`）＝显式内建白名单；Mesh 工具恒经 `customTools` 注入、不被过滤。`[]` 必须真正产生「无内建」的语义（修 demo 里 `tools:[]` 未生效的问题），语义在 L5 用真实 SDK 断言。
4. **凭据**：`apiKey`（测试）/`apiKeyEnv`（生产）二选一，fail-fast；secret 不进日志、事件、session、DB、配置指纹。
5. **profile**：`profiles` 键 + `Account.profileRef` 选择，无引用用 `default`；profile 间不串工具/模型；配置指纹对 `{llm,runtime,profile}` 做稳定哈希且剔除 secret。
6. **恢复期模型变更**：session restore（`open`）沿用落库时的模型身份；模型/Provider 变更不重写既有 `piSessionId`，由 L6 定义规则（默认：`open` 用当前 profile 解析，若解析失败按 `parked(NO_SESSION)` + 告警）。

### 接口 / 数据结构（配置 schema 草案，本设计冻结）

```ts
// 包根导出（src/index.ts），不进 core
export interface LlmConfig {
  providers: Record<string, ProviderConfig>;
  model: string;                 // 解析规则见下：优先 providers.<id>，缺省走内建 catalog
  thinkingLevel?: string;        // 缺省由 Mesh 固定（LD5）
  apiKeyEnv?: string;            // 显式环境变量名（LD4）
  apiKey?: string;               // 仅测试/传输链路，不落盘（LD4）
}
export interface ProviderConfig { baseUrl?: string; apiKeyEnv?: string; apiKey?: string; }

export interface RuntimeConfig {
  builtinTools?: string[];       // 默认 []：全禁内建，Mesh 工具仍可用（L5）
  retry?: unknown;               // 白名单开放（LD5）
  timeout?: unknown;
  compaction?: unknown;          // 语义与 mailbox 折叠解耦（§风险）
  resources?: { extensions?: false; skills?: false; prompts?: false; themes?: false; contextFiles?: false };
}
export interface Profile { llm?: LlmConfig; runtime?: RuntimeConfig }
// profiles: Record<string, Profile>；注册/接收端的 profileRef 解析在账层面（LD6）
```

模型解析规则：`llm.model` 形如 `providerId:modelId`；Provider 未在 `llm.providers` 定义时按内建 catalog（`@earendil-works/pi-ai` 随 pi 传递带出）解析，仍不读 `models.json`。

## 改动清单

| 位置 | 改动内容 |
| --- | --- |
| `src/pi/llm-config.ts`（新增） | Provider/模型/凭据解析、fail-fast、稳定错误码（L3） |
| `src/pi/session-factory.ts` | 隔离装配重写；`agentDir` 私有目录；内存 CredentialStore/SettingsManager；`modelsPath:null`；ResourceLoader 全 no；工具白名单（L4/L5） |
| `src/pi/pi-sdk.ts` | 保持唯一载入点；错误信息改「直接依赖仍惰性加载」措辞（L8） |
| `src/index.ts` | `createMesh({ llm, runtime })` 装配 + `CreateMeshOptions` 导出（L7） |
| `src/core/types.ts` | 不动 `MeshOptions`（保持 LLM 盲）；如需补根类型快照由 W01/C08 处理 |
| `demo/src/config.ts` / `demo/src/runtime.ts` | 改读 Mesh 配置，删 models/auth/settings 镜像（L9） |
| `examples/quickstart.ts` / `README.md` | 更新导入与说明（L10） |
| `package.json` | 已改（第 0 步）：direct dependency `^1.1.0`、engines `>=22.19.0` |
| 规范 §12.1/§12.3 | **差异清单**，实改由 W01/W16 记版本差异（见下） |

## 备选方案与取舍

- **`createLlmSessionFactory` + 包根便捷包装**（LD1 备选）：不动「唯一必填」表述、改动面小，但普通用户调用更繁琐、且让「一个构造函数」的入口叙事变碎。否决，采纳 `createMesh({ llm, runtime })`。
- **保留 optional peer（沿用 C07）**：core-only 最干净，但「空目录安装后无需手动装 pi」验收直接不成立。否决。
- **拆分 `@pi/agent-mesh-pi` 适配包**：隔离最强，但新增一个包的构建/发布/exports 结构与三包版本矩阵，工作量最大。否决于本轮（LD7 已限定命名清理范围）。

## 规范差异清单（§12.1 / §12.3；待 W01/W16 记为版本差异）

1. §12.1 `MeshOptions.policies` 从 `Partial<Policies> & Pick<Policies, "sessionFactory">`（必填）改为**可选**；新增 `llm?`、`runtime?`。§12.1 表 `policies.sessionFactory` 的「**是**」改为「**否**（给出 `llm`/`runtime` 时由库装配）」，并重写「为什么只有 SessionFactory 必填」为「为什么 sessionFactory 从必填变成可选、且仍是高级路径」。
2. §12.1 第 2646 行「★ 唯一必填的策略槽」与第 2675 行 `// ★ 唯一必填（§8.6）`、§12.3 第 2896 行「会话工厂（唯一必填）」、槽总表 `sessionFactory | 是 | 无`——四处「唯一必填/必填=是」同步改为「缺省装配，高级路径覆盖」。
3. §12.3 `sessionFactory` 槽**默认**从「没有」改为「mesh-pi 按 `llm`/`runtime` 装配」；降级方向 `parked(NO_SESSION)` + 告警不变；耗时仍不受 `policyTimeoutMs` 约束。

## 风险与回滚

- **core 理解 LLM**：`llm`/`runtime` 一旦进 core 即违反 M1；以 `CreateMeshOptions` 只存在于包根 + G1 门禁（core 零 pi + 零领域词）兜底。
- **pi 1.1.0 全局配置回读**：逐个组件做污染测试（L2 失败基线）并锁定版本；`loadPiSdk` 惰性加载不动。
- **compaction 与 mailbox 折叠混淆**：`runtime.compaction` 语义与库自身折叠解耦，文档明确二者独立。
- **SDK 升级成本失控**：若 1.1.0 改动过大适配成本不可接受，回退「直接依赖 + 锁 0.85.1」需用户重新确认，不静默变更。
- **回滚**：本次为新增面 + `session-factory.ts` 重写；回退即还原 `src/pi/session-factory.ts` 与 `src/index.ts` 的装配，core 无改动、可独立回退。

## 测试策略

- **L2 失败基线**：临时 HOME 预置冲突 pi 配置（模型/凭据/工具/extension/skill/prompt/SYSTEM.md/祖先 AGENTS.md），断言运行结果不受影响。
- **L4/L5/L6**：真实 SDK + faux；`builtinTools:[]` 内建不可用、Mesh 工具完整；单内建只多其一；profile 不串工具；指纹不含 secret。
- **L7/L8**：`createMesh({ llm, runtime })` 与高级 `policies.sessionFactory` 双路径；ESM/CJS + core-only（`pack.mjs` 离线冒烟）。
- **L9/L10 + demo**：`npm run demo:start` 浏览器回归正常、缺凭据、错误模型、空工具集、恢复五条路径。