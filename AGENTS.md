# AGENTS.md

本文件是 `pi-agent-mesh` 仓库的 Agent 协作入口，适用于整个项目。文档组织与生命周期约定见 [`.agents/AGENTS.md`](.agents/AGENTS.md)；修改子目录时同时遵守其中已有的局部约定。

## 开始任务前

- 先读 [`.agents/AGENTS.md`](.agents/AGENTS.md)，再按任务查看相关计划、评审与源码，不必通读所有历史文档。
- 项目使用方式见 [`README.md`](README.md) 与 [`examples/quickstart.ts`](examples/quickstart.ts)；架构导航见 [架构总览](.agents/pi-agent-mesh-overview.html)。
- 设计依据是 [pi-agent-mesh 规范](.agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md)。按需定位章节：投递语义 §7、存储 §11、API §12、不变量 §22.1；沿用既有 `M*`、`I*`、`F*`、`Q*` 编号。
- 判断当前实现、脚本与功能状态时核对源码、配置和测试，不直接沿用 README 或旧计划中的完成度、测试数量。发现实现与规范冲突时明确说明，不静默改变契约；历史计划不代表本次任务要求。
- 先检查工作区改动，保留用户已有修改；只做当前任务必要的变更，不顺带重构、移动文档或更改依赖与配置。

## 项目与目录

`@pi/agent-mesh` 是基于 pi SDK 的多持久 Agent 消息传递与共享状态层。使用 TypeScript、better-sqlite3、Vitest 与 tsup；发布 ESM、CJS 和类型声明；pi SDK（`@earendil-works/pi-coding-agent` `^1.1.0`）为直接依赖、惰性加载（core-only 使用者不加载 pi）。

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | `createMesh` / `MeshHost` 装配入口，连接 core 与 pi |
| `src/core/types.ts`、`src/core/contracts.ts` | 公共类型与组件契约；改变 API 前先核对 |
| `src/core/` | 存储、路由、邮箱、策略、共享状态、工具、观测与传输；不依赖 pi |
| `src/pi/` | pi SDK 适配、session 工厂、StreamPort 与单写者锁 |
| `migrations/` | SQLite schema 与迁移；作为包产物发布 |
| `tests/core/`、`tests/pi/`、`tests/e2e/` | 核心单测、SDK/适配器契约测试与端到端测试；公共辅助代码在 `tests/helpers/` |
| `demo/`、`examples/` | 本地演示宿主与使用示例；demo 不属于发布产物 |
| `scripts/` | 分层门禁、打包冒烟与 demo 启动脚本 |

## 环境与常用命令

使用 npm 与现有 `package-lock.json`。包声明 Node.js ≥22.19.0（engines），完整开发、测试和 demo 环境按此准备。better-sqlite3 含原生模块，依赖安装失败时先检查 Node 版本及本机编译环境。

在仓库根目录执行：

```bash
npm run check:imports    # G1–G4 依赖、分层、禁用 API 与业务词门禁
npm run typecheck        # tsc --noEmit（src/tests/scripts/examples）
npm run typecheck:demo   # demo 类型门禁（依赖 build 产物 dist/），先 build 再跑
npm test                 # vitest run，全量测试
npm run build            # ESM / CJS / 类型声明，输出到 dist/
npm test -- tests/core/store.test.ts  # 单文件验证示例
npm run demo:smoke       # demo 5-Tab 冒烟（假定 8787 已就绪，不自行启动服务）
```

- `npm run pack`：执行门禁、类型检查、测试、构建和消费者冒烟，生成本地 tarball；不等于发布。
- demo 依赖构建产物；修改库源码后先运行 `npm run build`，再按 demo 配置运行 `npm run demo`。
- `npm run demo:start` 会终止占用目标端口的进程（默认 8787），不要未经确认启动。它仅在产物缺失或传入 `--build` 时重建，不会自动识别源码是否过时。
- demo 前端（`demo/public/`）是 vanilla JS，不在类型门禁内；修改 demo 后**必须**先启动服务（`npm run demo:start`，需确认端口），再运行 `npm run demo:smoke` 复核受影响的 Tab 接口；冒烟不覆盖 GUI 交互，前端改动仍需浏览器目视确认。
- 当前没有 lint 脚本，不要将不存在的命令作为验证结果。

## 实现约束

- **维持分层**：`src/core/` 不得依赖 pi SDK；`src/pi/` 只能引用 core 的 `types`、`util`、`contracts`，不要跨层导入具体实现。跨层装配放在 `src/index.ts`。
- **遵守源码门禁**：`scripts/check-imports.mjs` 扫描 `src/`，禁止 `sendUserMessage(...)`、`.clearQueue(...)`、`forkFrom(...)`、`.prompt(...)` 调用形态及指定业务词；文本扫描也会匹配注释。具体词表以脚本为准，不靠放宽门禁绕过限制。契约测试对禁用 API 的探测不应误当成库内实现示范。
- **保持宿主无关**：模型、工具与业务语义由宿主提供；`sessionFactory` 是必填策略。业务扩展通过 `ext` 透传，不把业务概念塞进 core。
- **保持类型与包边界**：使用严格 TypeScript、NodeNext 和 `.js` 相对导入，类型使用 `import type`。修改公共 API 时同步检查类型、导出入口、测试、示例与规范；保留惰性加载的隔离，不让 core 使用者被迫加载 pi SDK。
- **保持事务原子性**：消息序号分配、消息/FTS/delivery 写入及相关状态更新须保持既有事务边界；`Store.tx` 不支持嵌套。恢复逻辑可以重算派生缓存，不可重算权威字段 `cursor_seq`、`folded_to_seq`。schema 变更同时考虑迁移、恢复和兼容性。
- **保持投递语义**：P1 流投递中，`deliver` 返回不代表已投递；`delivered` 依据条目镜像确认，`consumed` 按 turn_end 归因。P2 注入、P3 note 与 sink 路径遵循各自的确认规则，不要混用。不要把 SDK 队列深度当作背压依据，也不要跳过幂等与重试测试。
- **保持单写者与身份边界**：端点始终遵守单写者锁，`shared` 租约不表示允许并发写者。工具身份由闭包绑定，幂等 token 使用 tool-call ID；不要信任调用参数自报身份。消息渲染保留包裹与转义。

## 验证与交付

- 行为变更先补充或调整对应测试，再运行相关测试；代码变更完成后运行门禁、类型检查、全量测试与构建。若受环境限制未执行，明确列出原因和未验证范围。
- pi 测试使用真实 SDK 配合 faux provider，不依赖真实 LLM。保留 `vitest.config.ts` 的 `forks` 隔离及 `TERMUX_VERSION=1` 设置；不要为了通过测试引入真实模型调用或凭据。
- `typecheck` 覆盖 `src`、`tests`、`scripts`、`examples`；demo 由独立门禁 `typecheck:demo`（`demo/tsconfig.demo.json`，依赖 `build` 产物）覆盖类型，但 `check:imports` 仍仅扫描 `src/`。demo 前端（`demo/public/`）是 vanilla JS，不在类型门禁内；修改 demo 后应启动服务并运行 `npm run demo:smoke` 复核受影响 Tab 的后端接口，不能只凭类型门禁声称 demo 验证通过。
- 仅文档变更时，核对路径、链接、命令与事实，并检查差异；不必为此启动 demo、访问模型或执行全量测试。
- 结束前检查变更范围与空白错误，简述修改内容、实际验证结果和未解决的问题。未经要求不提交、不推送、不发布。

## 文档维护

持久化项目文档写入 `.agents/notes/` 的对应分类；写前读取该分类的 `README.md`。使用 `YYYY-MM-DD-<kebab-slug>.md` 命名及 `title`、`date`、`status`、`owner`、`tags`、`related` frontmatter；本文件作为根入口保留固定名称。

只记录值得长期保留的决策、约束与结论，优先链接现有规范，不复制大段实现细节。文档失效时依照 `.agents/AGENTS.md` 的约定归档而非直接删除；不要把 `.agents/` 加入 `.gitignore`，不要把凭据、运行时数据库或大体积二进制文件写进文档目录。
