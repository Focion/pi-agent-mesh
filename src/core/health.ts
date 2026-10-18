// ═══════════════════════════════════════════════════════════════════════════
// StorageHealthGuard（I34）：把「存储故障」收敛成一条可观察的执行链——
//   检测 → 告警（onFault 回调，宿主接成 invariant_violated 事件+计数器）
//        → 停发（isStopSend，宿主 send 入口据此拒绝）
//        → 恢复（recover，复检自愈 / 成功写 / devMode 显式 clear）。
//
// 故障种类用 code 区分，只复用既有 invariant_violated 告警通道（§12.5 末 /
// §23.3），不新增计数器名、不新增事件成员——尊重 W01 冻结面与附录 E。
//
// 两个来源严格分开：
//   - stopSend：真实检测（写失败 / 时钟回退 / WAL 超阈值 / 完整性损坏）报告，
//     由真实恢复条件（成功 tx / 复检通过）清除。
//   - injected：devMode 故障注入缝（测试观察停发/告警/恢复边界），生产 no-op，
//     只由 clear() 清除，不会被检测自愈误清。
// ═══════════════════════════════════════════════════════════════════════════

export type StorageFaultCode =
  | "not_writable"
  | "clock_rollback"
  | "wal_over_threshold"
  | "integrity_failed";

/** 宿主侧告警回调：把故障接成事件/计数器（幂等：同一 code 只在进入时告警一次）。 */
export interface StorageHealthSink {
  onFault(code: StorageFaultCode, detail?: unknown): void;
}

interface PendingFault {
  code: StorageFaultCode;
  detail?: unknown;
}

export class StorageHealthGuard {
  /** 真实检测出的故障（触发停发）。 */
  private readonly stopSend = new Set<StorageFaultCode>();
  /** devMode 注入的故障（触发停发，只由 clear 清除）。 */
  private readonly injected = new Set<StorageFaultCode>();
  private sink: StorageHealthSink | null = null;
  /** 打开/构造期检测早于 sink 装配，先缓冲、装配后重放。 */
  private pending: PendingFault[] = [];
  private readonly devMode: boolean;

  constructor(devMode: boolean) {
    this.devMode = devMode;
  }

  setSink(sink: StorageHealthSink): void {
    this.sink = sink;
    for (const p of this.pending) sink.onFault(p.code, p.detail);
    this.pending = [];
  }

  /** 检测侧：进入故障态（幂等）。 */
  report(code: StorageFaultCode, detail?: unknown): void {
    if (this.stopSend.has(code)) return;
    this.stopSend.add(code);
    if (this.sink) this.sink.onFault(code, detail);
    else this.pending.push({ code, detail });
  }

  /** 检测侧：真实故障恢复（幂等）。不清 injected。 */
  recover(code: StorageFaultCode): void {
    this.stopSend.delete(code);
    this.pending = this.pending.filter((p) => p.code !== code);
  }

  /** devMode 故障注入缝（生产 no-op）。 */
  inject(code: StorageFaultCode, detail?: unknown): void {
    if (!this.devMode) return;
    if (this.injected.has(code)) return;
    this.injected.add(code);
    if (this.sink) this.sink.onFault(code, detail ?? { injected: true });
  }

  /** devMode 清除注入的故障（生产 no-op）。 */
  clear(code: StorageFaultCode): void {
    if (!this.devMode) return;
    this.injected.delete(code);
  }

  /** 任一故障（真实或注入）激活即停发。 */
  isStopSend(): boolean {
    return this.stopSend.size > 0 || this.injected.size > 0;
  }

  /** 当前激活的故障码（真实 + 注入，去重保持稳定顺序）。 */
  activeFaults(): StorageFaultCode[] {
    const seen = new Set<StorageFaultCode>();
    const out: StorageFaultCode[] = [];
    for (const c of [...this.stopSend, ...this.injected]) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    return out;
  }
}