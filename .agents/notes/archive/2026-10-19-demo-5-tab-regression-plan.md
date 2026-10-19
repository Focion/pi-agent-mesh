---
title: demo 5-Tab 能力面板：追认与回归口径（D6）
date: 2026-10-19
status: archived
owner: unassigned
tags: [plan, demo, regression, decision]
archived_date: 2026-10-19
archived_from: notes/plan/2026-10-19-demo-5-tab-regression-plan.md
archived_reason: 步骤 2–4 已落地（scripts/demo-smoke.mjs + npm run demo:smoke + AGENTS.md 补充），D6 追认完成
related:
  - ../archive/2026-10-19-post-0.1.0-open-items-plan.md
  - ../tech/2026-09-07-pi-agent-mesh-spec.md
---

## 目标

`615c1f0` 把 demo 扩成 5-Tab 能力面板，发生在整合计划 `status: done` 之后、没有对应决策记录（D6）。本计划做两件事：

1. **追认**这次扩展（D6 方案①，而非收回 LD8 的范围）；
2. 给 demo 定一条**可执行的回归口径**，堵住「前端 vanilla JS 不在任何门禁内、改坏只能靠手工发现」的缺口。

完成标准：demo 的 5-Tab 形态有一条记录在案的决策；有一条等价的、可对照执行的冒烟清单（即便无法全自动，也要能一行命令复核）。

## 现状（2026-10-19 实测）

- **形态**：node:http + SSE 单页面板，默认端口 8787。`demo/src/rpc.ts` 的 `dispatch` 表 53 条命令，`postToGroup` / `registerAgent` 等业务演示命令在 `runtime.ts` 落地。
- **5 个 Tab**：`chat`（群聊）、`topology`（拓扑与在场）、`lab`（消息实验室）、`shared`（共享空间）、`observer`（观测）。
- **HTTP 面**：
  - `GET /api/health` → `{ok:true, result:{demo, version, config{provider, modelId, thinkingLevel, tools, dbPath, stateDir, port, fingerprint}, credentialSource}}`。
  - `POST /api/<command>` → 统一 `{ok, result?|error}`，命令失败也返回 HTTP 200（错误在 body 里）。
  - `GET /api/events` → SSE，`hello` / `tick`(每秒) / 15 个 `MeshEvent` + delivery/meshmsg 帧。
- **凭据与启动**：启动即 `resolveLlmConfig` fail-fast，**必须有真实 LLM 凭据**，不离线可用。`demo/demo.config.json`（含内联 `apiKey`）与 `demo/.data/`（运行时 DB/锁）都已 `.gitignore`，只提交 `demo.config.example.json`。
- **门禁现状**：只有 `typecheck:demo`（`demo/tsconfig.demo.json`，依赖 `build` 产物）盖住 `demo/src` 的类型；`demo/public/**` 是 vanilla JS，**不在任何门禁内**。

## 回归口径（D6 方案① 的落地）

启动后按此清单复核。冒烟的前提是服务已在 8787 就绪（见风险表：`start-demo.sh` 会杀端口占用进程，未经确认不跑）。

| # | 面 | 命令 / 请求 | 期望 |
| --- | --- | --- | --- |
| 1 | 启动 | `GET /api/health` | `ok:true`，`result.config.port` 对，`credentialSource` 非空 |
| 2 | chat | `POST /api/listAgents` | 至少 3 个 agent（Alice/Bob/Carol）；`/` 页 `#rosterList` 3 个 `<li>` |
| 3 | topology | `POST /api/state` | `accounts`/`endpoints` 投影非空；页 `#accBody`/`#epBody` 有行 |
| 4 | lab | `POST /api/conversationsOf`、`POST /api/messages` | 项目字段符合 envelope 形状；页 `#labConvSel` 有 `<option>` |
| 5 | shared | `POST /api/sharedList` | 数组（可空）；页 `#shAs` 有 `<option>` |
| 6 | observer | `POST /api/checkInvariants` | `ok:true` 且无 violation；页 `#obsCounters` 23 个 `.ct-cell` |
| 7 | 事件流 | `GET /api/events` | 首帧 `event: hello`，随后 `tick` 连续到达 |

「等价」判据：因为命令失败也回 HTTP 200，冒烟不能只看状态码，要断言 `{ok:true}` 与关键字段；浏览器侧看 DOM 选择器，后端侧看 RPC 结果。

## 步骤

| # | 事项 | 依赖 | 状态 |
| --- | --- | --- | --- |
| 1 | 追认 5-Tab 扩展，形成决策记录（本计划） | - | done |
| 2 | 写 `scripts/demo-smoke.mjs`：假定 8787 已就绪，逐条跑上表的 1–7（HTTP 断言 `ok:true` + 字段，SSE 首帧） | 1 | done |
| 3 | 给 demo 补一条**离线冒烟 seam**（临时）——`createAssembledSessionFactory` 换成 stub + faux provider，让 1 + 3 + 6 能脱离真实凭据跑 | 2 | deferred |
| 4 | 把冒烟挂进一个 `npm run demo:smoke` 入口，并把「改 demo 必须 GUI 复核受影响的 Tab」写进 AGENTS.md/README | 2 | done |

1 已按用户指示追认；2–4 是「把静态清单变成一条命令」的后续，不属于本计划必须当轮闭环项——在 3（离线 seam）落地前，改 demo 仍需手工启动 + 浏览器复核受影响的 Tab。

## 风险与阻塞

| 项 | 影响 | 应对 |
| --- | --- | --- |
| 真实凭据才能起 | 冒烟无法在 CI/离线跑 | 落地步骤 3 的 faux seam；之前保持手工复核 |
| `scripts/start-demo.sh` 会 `lsof` 后杀占用 8787 的进程 | 误杀他人进程 | 未经确认不跑 `npm run demo:start`；冒烟只连 `localhost:8787` 不自己起服务 |
| `demo/public/**` vanilla JS 无门禁 | 前端悄悄坏 | 冒烟覆盖 DOM 选择器；或逐步给 frontend 加最小 eslint（另议，不并入本计划） |
| `demo/demo.config.json` 含内联真实 `apiKey` | 凭据泄漏 | 已 `.gitignore` 且只提交 example；继续不提交、勿复制进文档 |

## 进度记录

- 2026-10-19：追认 5-Tab 扩展（D6 方案①）；登记现状与 7 条冒烟清单。本计划与主计划的关系：主计划归档后，本计划是「demo 回归」唯一仍在 active 的计划。
- 2026-10-19：步骤 2 落地（`scripts/demo-smoke.mjs`）；步骤 4 落地（`npm run demo:smoke` + AGENTS.md 补充）；步骤 3（离线 seam）延迟（依赖真实凭据才能起，当前保持手工复核）。计划归档。