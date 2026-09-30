# AGENTS.md

本文件是 `.agents/` 的引导入口。**开始任何任务前先读它**，它说明本项目的上下文放在哪、新产出应该写到哪。

## 项目上下文

- 项目简介：`@pi/agent-mesh` —— 构建在 pi SDK 之上的多持久 Agent 消息传递与共享状态层（v0.1.0，规范面 v1.0.0 已定稿）。
- 技术栈：TypeScript（ESM + CJS 双产物，tsup 构建）、Node ≥ 20、better-sqlite3 存储、vitest 测试；pi SDK（`@earendil-works/pi-coding-agent` ≥ 0.84.4）为 optional peer。
- 入口与关键模块：
  - `src/index.ts` —— 包根装配入口（`createMesh` / `MeshHost`），唯一构造函数，可同时 import core 与 pi。
  - `src/core/**` —— mesh-core：类型契约、存储、路由、投递、工具面、策略、渲染、观测。**零 pi 依赖**（CI 门禁 G1）。
  - `src/pi/**` —— mesh-pi：pi SDK 适配（StreamPort、session 工厂、实例锁），只允许 import core 的 `types` / `util` / `contracts`（门禁 G2）。
  - `migrations/000_init.sql` —— 全量 17 表 + fts5 DDL。
  - `demo/` —— 本地演示宿主（SSE + 静态页），非发布产物。
  - `tests/{core,pi,e2e,helpers}` —— 单测 / pi 契约测试 / 验收测试。
- 本地运行 / 测试命令：

  ```bash
  npm run build        # tsup 双产物
  npm test             # vitest run
  npm run typecheck    # tsc --noEmit
  npm run check:imports# 分层门禁 G1–G4（core 零 pi、禁用 API、词表）
  npm run demo:start   # 起本地 demo（默认 8787）
  ```

- 硬约束（改代码前必须知道）：mesh-core 不得 import pi 包；源码不得出现 `sendUserMessage` / `clearQueue` / `forkFrom` / `.prompt(`；不得出现宿主业务词汇（见 `scripts/check-imports.mjs` 词表）。规范里的编号（`M*` 约束、`I*` 不变量、`F*` 已证伪机制、`Q*` 决策）是全项目共用引用体系，写文档时沿用。

## 目录地图

```
.agents/
├── AGENTS.md          # 本文件
├── notes/             # 项目相关文档
│   ├── research/      # 研究：调研、技术选型、可行性分析、竞品分析
│   ├── product/       # 产品设计：PRD、需求说明、交互与流程
│   ├── tech/          # 技术设计：架构、实现方案、接口与数据模型
│   ├── review/        # CR：代码评审记录、问题清单与结论
│   ├── changelog/     # 变更：版本发布、迁移步骤、破坏性变更
│   ├── plan/          # 计划：路线图、迭代计划、任务拆解
│   └── archive/       # 归档：已作废或被替代的文档
└── skills/            # 项目技能，一个子目录一个 skill（见 skills/README.md）
```

每个 notes 子目录下的 `README.md` 写明了该类文档的收录标准和模板，写入前先读对应的那一份。

## 现有文档索引

| 文档 | 说明 |
| --- | --- |
| [`notes/tech/2026-09-07-pi-agent-mesh-spec.md`](notes/tech/2026-09-07-pi-agent-mesh-spec.md) | **权威规范 v1.0.0**：平台基线、架构、投递语义、存储 schema、API、不变量、决策记录与风险登记。代码里的 `§x.y` 引用都指向它。 |
| [`notes/plan/2026-09-07-p0-p1-rollout.md`](notes/plan/2026-09-07-p0-p1-rollout.md) | 落地实施计划：本轮交付 P0 全量 + P1 核心，含阶段泳道、文件清单与验收项；P2–P5 的延后范围见 §1。 |

规范体量很大（8000+ 行），按需读章节而不是整篇：查投递行为看 §7，查表结构看 §11，查对外 API 看 §12，查不变量看 §22.1。

## 该往哪写

| 我要记录的东西 | 目标目录 |
| --- | --- |
| 「我查了 A/B/C 三个方案，对比结论是……」 | `notes/research/` |
| 「这个功能给用户看到的样子和规则是……」 | `notes/product/` |
| 「代码上准备怎么做、拆哪些模块、接口长什么样」 | `notes/tech/` |
| 「这次 CR 发现了哪些问题、怎么处理」 | `notes/review/` |
| 「这次改动对外的影响、升级方式」 | `notes/changelog/` |
| 「接下来分几步做、什么时候做」 | `notes/plan/` |
| 「这份文档已经不作数了」 | `notes/archive/` |
| 「这套操作流程要能被复用执行」 | `skills/` |

判断不了归哪类时，按**文档的主要用途**而不是它提到的内容归类；确实跨类就放主用途所在目录，用 `related` 链接另一篇。

## 命名与格式

- 文件名：`YYYY-MM-DD-<kebab-slug>.md`，例如 `2026-09-14-cache-layer-design.md`。日期用创建日期，之后不改。
- 每篇文档以 frontmatter 开头：

  ```markdown
  ---
  title: 缓存层设计
  date: 2026-09-14
  status: draft        # draft | active | done | archived
  owner: <负责人>
  tags: [cache, performance]
  related:
    - notes/research/2026-09-10-cache-options.md
  ---
  ```

- 正文用 `##` 起始的层级标题；结论写在最前面，推理过程放后面。
- 附件（截图、数据文件）放在同级 `assets/` 目录，正文用相对路径引用。
- 不要把代码库里已有的信息（目录结构、实现细节）抄进文档；写代码里读不出来的东西：为什么这么做、否决了什么、约束是什么。

## 文档生命周期

`plan` → `tech`/`product` → 实现 → `review` → `changelog`，研究性输入随时进 `research`。

文档失效时**移动到 `notes/archive/`**，不要删除，并更新 frontmatter：

```markdown
status: archived
archived_date: 2026-09-14
archived_from: notes/tech/2026-08-01-old-design.md
archived_reason: 被 notes/tech/2026-09-14-new-design.md 取代
```

引用了它的文档要顺手更新 `related` 指向新版本。

## 给 Agent 的操作约定

1. 动手前先扫一遍 `notes/plan/` 和相关子目录，避免与既有决策冲突；发现冲突先提出来，不要自行推翻。
2. 产出文档时复用上面的命名与 frontmatter，不要另创目录层级。
3. 只在任务确实产生了值得留存的结论时写文档；一次性的中间过程不必落盘。
4. 修改已有文档时保留原有结论，用新章节或新文档记录变化，必要时归档旧版本。
5. 规范（`notes/tech/2026-09-07-pi-agent-mesh-spec.md`）是定稿文档：偏离它的实现要么改规范要么记进 `notes/review/`，不要让代码与规范静默漂移。
6. 本目录纳入版本管理，是人与 Agent 的共享上下文；不要把它写进 `.gitignore`，也不要在 `notes/` 里放代码或大体积二进制文件。
