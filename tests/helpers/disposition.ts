// G09 处置表：gap-ledger.ts 之外的 28 项「非实现单元」去向单一真源。
//
// 69 项 = gap-ledger 的 41 项（N01–N05 / I01–I35 / D03）＋ 本表的 28 项
// （V01–V08 / C01–C10 / D01,D02,D04–D07 / H01–H04）。D03 已并入 gap-ledger
// （提升为本版必做故列入实现单元），此处不重复。
//
// `evidence` 为「去向」指示：`G0x` 表示由某道门（verify:local / verify:package）
// 机器验证；其余为仓库根相对路径（脚本/测试/文档），`scripts/verify-package.mjs`
// G09 校验其存在。`status` 恒为 "done"（0.1.0 交付口径，由 G09 断言无缺漏）。
export interface DispositionEntry {
  id: string;
  summary: string;
  status: "done";
  evidence: string[];
}

export const DISPOSITION: DispositionEntry[] = [
  // ── V：专项验证缺口（8 项）────────────────────────────────────────
  { id: "V01", summary: "两个真实 OS 进程 + 真实 Pi 端口（warm/崩溃窗口/归属）", status: "done", evidence: ["G05"] },
  { id: "V02", summary: "真实 SDK + faux（nextTurn 负面/P2 最终上下文/hook/工具/磁盘恢复）", status: "done", evidence: ["G04"] },
  { id: "V03", summary: "可复现 seed、6 窄窗口故障注入、100 重启、幂等应用", status: "done", evidence: ["G05"] },
  { id: "V04", summary: "三大基准（200 双聊 / 500 群 / 1000 任务）+ 20% 回归设施", status: "done", evidence: ["G06"] },
  { id: "V05", summary: "规模用例：冷热切换/1000 订阅/100 并发/队列接管/CAS", status: "done", evidence: ["G06"] },
  { id: "V06", summary: "真实 Host 下 canJoin、群限额与 I8、lock_path 与 C10", status: "done", evidence: ["G03"] },
  { id: "V07", summary: "真实消费者：createMesh、迁移、pi 可选安装、ESM/CJS 类型", status: "done", evidence: ["G08"] },
  { id: "V08", summary: "coverage 阈值、API/DDL 快照、SDK 版本矩阵、产物门禁", status: "done", evidence: ["G01", "G07"] },

  // ── C：已确认合同（10 项）─────────────────────────────────────────
  { id: "C01", summary: "mute 保留 Inbox 不唤醒；urgent 不绕过；解除不补唤醒", status: "done", evidence: ["G03"] },
  { id: "C02", summary: "external 走宿主 SinkHandler，缺 handler 时 park；自定义 Transport 声明合同", status: "done", evidence: ["G03"] },
  { id: "C03", summary: "失败回退统一 4.1；Floor 只放行合法候选，不绕过 ACL", status: "done", evidence: ["G03"] },
  { id: "C04", summary: "显式 by/as 按该身份校验，取消隐式管理员", status: "done", evidence: ["G03"] },
  { id: "C05", summary: "perConversation 精确匹配 + pooled 稳定分片", status: "done", evidence: ["G03"] },
  { id: "C06", summary: "迟到 late / 重复 ack 幂等 / 过期 claim 拒绝", status: "done", evidence: ["G03"] },
  { id: "C07", summary: "Node>=22.19 / pi ^1.1.0 直接依赖 + 惰性加载矩阵", status: "done", evidence: ["G08", "package.json"] },
  { id: "C08", summary: "保留 core 公共出口 + 根类型 + API 快照逐项说明", status: "done", evidence: ["G01"] },
  { id: "C09", summary: "不自动裁剪账 / 不新增同账号跨流自投", status: "done", evidence: ["G03"] },
  { id: "C10", summary: "Observer 只报告；P2 按实际输入集合确认", status: "done", evidence: ["G03", "G07"] },

  // ── D：延期与保持简化（6 项，D03 已在 gap-ledger）────────────────
  { id: "D01", summary: "forkAt 继续 unsupported，补拒绝测试与文档", status: "done", evidence: ["G03", "tests/e2e/options.test.ts"] },
  { id: "D02", summary: "基础转写 replay，标「非历史精确重建」边界", status: "done", evidence: ["G03", "README.md"] },
  { id: "D04", summary: "topic 保持全 fanout，测 1000 订阅者边界", status: "done", evidence: ["G06"] },
  { id: "D05", summary: "Shared 保持 reject/null，不加 getRaw", status: "done", evidence: ["G03"] },
  { id: "D06", summary: "有界裁剪；purged 元信息模型延期（版本单调/CAS/墓碑仍修）", status: "done", evidence: ["G03"] },
  { id: "D07", summary: "定向历史隔离/更多 Floor/queue 优先级/跨拓扑迁移不进本版", status: "done", evidence: ["G03"] },

  // ── H：文档一致性（4 项，W16 统一处理）───────────────────────────
  { id: "H01", summary: "旧 plan/review 归档保留历史，关闭证据只在本计划追加", status: "done", evidence: [".agents/notes/archive/", ".agents/notes/plan/2026-10-12-consolidated-open-work-plan.md"] },
  { id: "H02", summary: "README 事实修正：多进程/测试数量/Tab 与群聊面板对齐", status: "done", evidence: ["README.md", "demo/public/app.js"] },
  { id: "H03", summary: "规范枚举/事件字段/命名统一（since_join/Presence/附录载荷）", status: "done", evidence: [".agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md"] },
  { id: "H04", summary: "文字承诺标真实边界（非 byte-fidelity/full replay/无强一致性承诺）", status: "done", evidence: ["README.md", ".agents/notes/tech/2026-09-07-pi-agent-mesh-spec.md"] },
];