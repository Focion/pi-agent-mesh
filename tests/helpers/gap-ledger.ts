// G03 台账：gap ID → 测试 → 断言 → 结果 的单一真源。
//
// 41 项 = N01–N05 / I01–I35 / D03（计划 §6.1/6.2/6.4 + D03 提升为必做）。每一行
// `files` 是覆盖该 gap 闭合条件的合同测试文件（仓库根相对路径），`assertions` 是
// 可读断言（闭合条件翻译）。`scripts/gen-gap-ledger.mjs --check` 据此核文件存在、断言
// 非空，并对映射并集跑 vitest 回填 result 到 `reports/gap-ledger.json`。
//
// `lock-before-migrate` 属 I05 的「锁先于迁移」无 host/DB 分支，不走 16 断言。
export interface GapEntry {
  id: string;
  summary: string;
  files: string[];
  assertions: string[];
}

export const GAP_LEDGER: GapEntry[] = [
  // ── N：子能力未接通 ─────────────────────────────────────────────
  { id: "N01", summary: "运行期 mailbox 周期清扫（不手调即收敛；关闭停调度）", files: ["tests/e2e/sweep-timer.test.ts", "tests/core/mailbox.test.ts"], assertions: ["sweep converges without manual trigger", "close() stops the sweep timer"] },
  { id: "N02", summary: "canInitiateDirect 在首聊执行链上（拒绝不留空会话）", files: ["tests/core/n02-first-msg-rejected.test.ts"], assertions: ["first message to a direct candidate respects canInitiateDirect", "rejection leaves no empty conversation"] },
  { id: "N03", summary: "maxHistoryOnJoin 决定历史注入（零时不注入，非零限制范围）", files: ["tests/e2e/join-history.test.ts", "tests/pi/catchup.test.ts"], assertions: ["join injects history only within maxHistoryOnJoin", "0 disables history injection"] },
  { id: "N04", summary: "FTS 可关闭（禁用时搜索返回「功能关闭」）", files: ["tests/core/fts-matrix.test.ts"], assertions: ["fts enabled by default", "disabled fts returns an explicit 'feature off' result"] },
  { id: "N05", summary: "LogicalClock 接入生产调用链（compare/format 可观察且不夺 seq 权威）", files: ["tests/core/clock.test.ts"], assertions: ["logical clock drives compare/format", "seq authority stays on per-conversation seq"] },

  // ── I：部分实现 / 契约未闭合 ────────────────────────────────────
  { id: "I01", summary: "writerId 归属一致 + 自动 warm 注册 transport handler", files: ["tests/pi/stream-port.test.ts", "tests/e2e/samehost-writerid.test.ts"], assertions: ["explicit and auto warm agree on ownership", "local vs remote senders both receive"] },
  { id: "I02", summary: "outbox 按 P1/P2/P3 分派；确认前不提前 done", files: ["tests/core/transport.test.ts", "tests/e2e/acceptance.test.ts"], assertions: ["P1/P2/P3 use distinct confirm rules", "delivery not done before confirmation"] },
  { id: "I03", summary: "消息提交后才 publish；两层状态一致且端点不饥饿", files: ["tests/core/recovery.test.ts"], assertions: ["crash window rebuilds delivery intent", "delivery and message rows stay consistent"] },
  { id: "I04", summary: "锁不存在/损坏/不可读 → unknown 拒接管；只处理本进程端点", files: ["tests/core/lock-states.test.ts", "tests/pi/stream-port.test.ts"], assertions: ["dead/live/corrupt/reused pid all classified", "unreadable lock refuses takeover as unknown"] },
  { id: "I05", summary: "BEGIN 失败可重试；迁移先于实例锁", files: ["tests/core/store-tx.test.ts", "tests/core/store-migrate.test.ts", "tests/e2e/lock-before-migrate.test.ts"], assertions: ["BEGIN failure retries", "instance lock precedes migration (no DB created)"] },
  { id: "I06", summary: "ext/data/attachments 首投/重试/跨进程/投影四处一致", files: ["tests/core/envelope.test.ts"], assertions: ["envelope ext/data/attachments preserved across paths"] },
  { id: "I07", summary: "seal 启用入口 + 消费前验签（篡改即拒并告警）", files: ["tests/core/seal.test.ts"], assertions: ["seal can be enabled", "tampered message rejected before consume"] },
  { id: "I08", summary: "原文字节预算/LRU/读史记账在真实链路生效", files: ["tests/core/mailbox.test.ts"], assertions: ["per-conversation byte budget enforced", "LRU eviction and read-history accounting effective"] },
  { id: "I09", summary: "P2 按最终输入确认；双端点不互认；P3 不进正文", files: ["tests/pi/p2-confirmation.test.ts", "tests/pi/probe-p2-input.test.ts"], assertions: ["P2 confirmed against final input set", "sibling endpoints don't confirm each other"] },
  { id: "I10", summary: "CATCHUP 摘要先持久化再推进消费", files: ["tests/pi/catchup.test.ts"], assertions: ["summary persisted and fed to next turn before consumption"] },
  { id: "I11", summary: "请求端点绑定/exclusive/回程定向/abandoned 恰好一次终态", files: ["tests/core/request-answer.test.ts", "tests/e2e/request-answer.test.ts", "tests/e2e/request-cross-process.test.ts"], assertions: ["requester gets exactly one correct terminal state", "cross-process and archive acks have one terminal state"] },
  { id: "I12", summary: "claim 校验/信封不可变/turn_end 不消费任务/重派/死信", files: ["tests/core/queue-claim.test.ts", "tests/core/mailbox.test.ts"], assertions: ["only the legal current claimant advances", "envelope immutable; redelivery and dead-letter traced"] },
  { id: "I13", summary: "订阅幂等 + canSubscribe + full 不越过起点 + mentions 可见", files: ["tests/core/subscribe-admin.test.ts", "tests/e2e/join-history.test.ts"], assertions: ["subscribe idempotent", "read boundary and mentions honored"] },
  { id: "I14", summary: "档位与唤醒解耦（busy/steer/应答可核验）", files: ["tests/core/mailbox.test.ts"], assertions: ["grade and wake decoupled", "busy/steer/reply wake behavior verifiable"] },
  { id: "I15", summary: "selector 校验账号/端点关系；pooled 恢复 size/affinity", files: ["tests/core/selector.test.ts", "tests/core/topology-persist.test.ts"], assertions: ["selector validates account↔endpoint", "restart preserves topology"] },
  { id: "I16", summary: "热流升 exclusive；到期降级同步锁；关闭无残留写者", files: ["tests/pi/stream-port-lease.test.ts"], assertions: ["lease upgrades to exclusive and downgrades on expiry", "close leaves no residual writer"] },
  { id: "I17", summary: "history/members 查 read；未订阅者拿不到 topic 名单", files: ["tests/core/subscribe-admin.test.ts", "tests/core/policies.test.ts"], assertions: ["no read = no access", "unsubscribed can't list topics"] },
  { id: "I18", summary: "最后 setCaps 成员保留管理能力；失败无半成品群", files: ["tests/core/group-admin-invariant.test.ts"], assertions: ["admin capability can't vanish", "failed group mutation leaves no partial structure"] },
  { id: "I19", summary: "Shared ACL 按旧对象写判定；custom 无 resolver 即拒绝", files: ["tests/core/shared-contract.test.ts"], assertions: ["put checks write on the old ACL", "custom access denied when no resolver"] },
  { id: "I20", summary: "CAS 跨 await 无窗口；delete 推进版本号", files: ["tests/core/shared-contract.test.ts", "tests/core/shared.test.ts"], assertions: ["CAS revalidates after await", "delete + recreate keeps versions monotonic"] },
  { id: "I21", summary: "shared append 不静默覆盖；list 分页参数生效或明确拒绝", files: ["tests/core/shared-contract.test.ts", "tests/core/tools.test.ts"], assertions: ["append actually appends", "list paging params honored"] },
  { id: "I22", summary: "Inbox 工具接真实投影（待答/可领取任务/自己的 claim）", files: ["tests/e2e/tool-inbox.test.ts"], assertions: ["inbox tool shows pending-reply/claimable tasks"] },
  { id: "I23", summary: "Shared 通知按 read 过滤且 silent；归档禁写有合同", files: ["tests/core/shared-contract.test.ts"], assertions: ["notify reads filtered and silent", "archived objects reject writes"] },
  { id: "I24", summary: "Presence 到期回落可观察；显式 offline 不被覆盖", files: ["tests/core/presence-derive.test.ts"], assertions: ["expiry falls back visibly", "explicit offline not overwritten by hot endpoint"] },
  { id: "I25", summary: "Observer 走 query_only 只读连接；C10 按活 owner 判定", files: ["tests/core/observer.test.ts"], assertions: ["observer uses a readonly connection", "C10 judges live owner (pid)"] },
  { id: "I26", summary: "事件统一端点元信息；每跃迁事件数量+载荷有合同测试", files: ["tests/core/event-contract.test.ts"], assertions: ["every legal delivery transition emits contract events"] },
  { id: "I27", summary: "三计数器升；fold/busy 计数单位一致", files: ["tests/core/observer.test.ts", "tests/core/mailbox.test.ts"], assertions: ["blind_write/claim_timeout/queue_cleared_detected bump from real actions", "fold_events 1:1 with inbox_overflowed; busy stays 0"] },
  { id: "I28", summary: "trace 解释降档/不唤醒/重投决策链", files: ["tests/core/observer.test.ts"], assertions: ["trace exposes note/redeliverReason"] },
  { id: "I29", summary: "truncated 准；兜底截断产出合法 JSON；上限生效", files: ["tests/core/tools.test.ts"], assertions: ["any size returns well-formed structure", "toolResultMaxBytes effective"] },
  { id: "I30", summary: "同一份配置贯穿写/读/执行；fold 受全局上限；claimTtlMs 收紧", files: ["tests/core/config-clamp.test.ts", "tests/core/mailbox.test.ts"], assertions: ["clamped config traverses write/read/exec", "fold respects global cap; claimTtlMs clamped"] },
  { id: "I31", summary: "sink 档位透传 + 指数退避（有上限）", files: ["tests/core/transport.test.ts"], assertions: ["sink grade passed through", "capped exponential backoff"] },
  { id: "I32", summary: "终态扣缓存；游标清理；UTF-8 字节口径一致", files: ["tests/core/mailbox-cache.test.ts"], assertions: ["cache equals recomputed after each transition", "byte (UTF-8) accounting consistent"] },
  { id: "I33", summary: "每槽有限结果 + 正确原因码（不误改 NO_SESSION）", files: ["tests/core/no-session-park.test.ts", "tests/core/policy-slot-matrix.test.ts"], assertions: ["each slot returns a bounded result with correct reason code"] },
  { id: "I34", summary: "时钟回退/不可写/WAL/完整性故障注入形成执行链", files: ["tests/core/health.test.ts"], assertions: ["fault injection stops delivery, alerts, and recovers"] },
  { id: "I35", summary: "devMode 护栏 + 包裹检查不可越壳", files: ["tests/core/renderer-shell.test.ts"], assertions: ["boundary corpus can't escape the shell", "diagnostics trigger for real"] },

  // ── D：延期中提升为必做 ───────────────────────────────────────
  { id: "D03", summary: "权威恢复：真实 session 与 DB 双向核对 + 幂等应用", files: ["tests/core/recovery.test.ts", "tests/e2e/recovery.test.ts"], assertions: ["reapply is idempotent; repeated recovery same result", "unresolvable handoff parks and alerts"] },
];