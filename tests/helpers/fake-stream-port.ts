// FakeStreamPort（§23.5）：可测性的关键。
// 三处必须这样写，否则测试在真环境静默失效：
// ① deliver 第五参是 opts:{triggerTurn}，不是 wake:boolean（§7.1 正交）
// ② status() 不报 queueDepth（F3：pi 队列深度对库消息失明）
// ③ deliver 返回 submission 状态投影（MD3）；对账按 submissionId 精确读（取代 hasEntries）
import type {
  EndpointId,
  EndpointState,
  Envelope,
  Grade,
  MeshLease,
  PortEntryEvent,
  PortStatus,
  StreamPort,
  SubmissionHandle,
  SubmissionRecord,
  Unsubscribe
} from "../../src/core/types.js";

export interface FakeDeliveryRecord {
  endpointId: EndpointId;
  envelope: Envelope;
  rendered: string;
  grade: Grade;
  triggerTurn: boolean;
  entryId: string;
  submissionId: string;
}

export class FakeStreamPort implements StreamPort {
  readonly delivered: FakeDeliveryRecord[] = [];
  readonly notes: Array<{ endpointId: EndpointId; customType: string; data: unknown }> = [];
  readonly nudges: Array<{ endpointId: EndpointId; cue: string; opts?: unknown }> = [];
  readonly injections: Array<{ endpointId: EndpointId; text: string }> = [];
  readonly warmed: EndpointId[] = [];
  readonly evicted: EndpointId[] = [];

  /** 脚本化端点状态；未设置默认 hot（多数用例不想管 warm） */
  private states = new Map<EndpointId, EndpointState>();
  private busy = new Set<EndpointId>();
  /** 脚本化"某些 entryId 被 clearQueue 干掉了"（I22 用例）：其 submission 对账应判 unanswered 无 entry。 */
  readonly vanishedEntries = new Set<string>();
  /** 脚本化 warm 抛错（D03 用例：拿不到 session → park + 告警） */
  warmError?: unknown;
  /** 权威 submission 投影（deliver 落默认 done，测试可覆写 customStatus 或直接改本 map） */
  readonly submissions = new Map<string, SubmissionRecord>();
  private entryHandlers: Array<(e: PortEntryEvent) => void> = [];
  private turnEndHandlers: Array<(e: { endpointId: EndpointId }) => void> = [];
  private seqCounters = new Map<EndpointId, number>();
  private handoff = new Map<EndpointId, number>();
  private submissionSeq = 0;

  setEndpointState(id: EndpointId, state: EndpointState): void {
    this.states.set(id, state);
  }

  async warm(endpointId: string, _lease?: MeshLease): Promise<void> {
    if (this.warmError) throw this.warmError;
    this.warmed.push(endpointId);
    this.states.set(endpointId, "hot");
  }

  async evict(endpointId: string): Promise<void> {
    this.evicted.push(endpointId);
    this.states.delete(endpointId);
  }

  async deliver(
    endpointId: string,
    rendered: string,
    envelope: Envelope,
    grade: Grade,
    opts?: { triggerTurn?: boolean; deliveryId?: string; attempt?: number }
  ): Promise<SubmissionHandle> {
    const entryId = `fake_${this.delivered.length + 1}`;
    const submissionId = `sub_${++this.submissionSeq}`;
    this.delivered.push({
      endpointId,
      envelope,
      rendered,
      grade,
      triggerTurn: !!opts?.triggerTurn,
      entryId,
      submissionId
    });
    this.submissions.set(submissionId, {
      id: submissionId,
      status: "done",
      entryId,
      type: "write"
    });
    const seq = (this.seqCounters.get(endpointId) ?? 0) + 1;
    this.seqCounters.set(endpointId, seq);
    this.handoff.set(endpointId, (this.handoff.get(endpointId) ?? 0) + 1);
    this.emitEntry({
      endpointId,
      entryId,
      envelopeId: envelope.id,
      entryType: "custom_message",
      seqInStream: seq,
      rawJson: JSON.stringify({ fake: true, envelopeId: envelope.id, customType: "mesh.msg" })
    });
    this.handoff.set(endpointId, (this.handoff.get(endpointId) ?? 1) - 1);
    if (opts?.triggerTurn) {
      this.busy.add(endpointId);
      // 用 setTimeout 而非 queueMicrotask：确保 await deliver() 的 continuation
      // （markDelivered）在 microtask 阶段跑完后，endTurn 才在下一 macrotask 触发
      // handleTurnEnd → consumed。否则 microtask 先于 promise continuation 执行，
      // handleTurnEnd 查不到 delivered 行，永不自消费。
      setTimeout(() => this.endTurn(endpointId), 0);
    }
    return { submissionId, status: "done", entryId };
  }

  async nudge(
    endpointId: string,
    cue: string,
    opts?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean }
  ): Promise<void> {
    this.nudges.push({ endpointId, cue, opts });
    if (opts?.triggerTurn) {
      this.busy.add(endpointId);
      setTimeout(() => this.endTurn(endpointId), 0);
    }
  }

  async note(endpointId: string, customType: string, data: unknown): Promise<void> {
    this.notes.push({ endpointId, customType, data });
    const seq = (this.seqCounters.get(endpointId) ?? 0) + 1;
    this.seqCounters.set(endpointId, seq);
    this.emitEntry({
      endpointId,
      entryId: `note_${this.notes.length}`,
      entryType: "custom",
      seqInStream: seq,
      rawJson: JSON.stringify({ fake: true, customType, data })
    });
  }

  injectContext(endpointId: string, text: string): Unsubscribe {
    this.injections.push({ endpointId, text });
    return () => {};
  }

  status(endpointId: string): PortStatus {
    return {
      state: this.states.get(endpointId) ?? "hot",
      busy: this.busy.has(endpointId),
      inFlight: this.handoff.get(endpointId) ?? 0
    };
  }

  async submissionStatus(endpointId: string, submissionId: string): Promise<SubmissionRecord | null> {
    const rec = this.submissions.get(submissionId);
    if (!rec) return null;
    // I22：entry 被 clearQueue 干掉 → 判 unanswered 无 entry（条目消失），驱动重投。
    if (rec.entryId && this.vanishedEntries.has(rec.entryId)) {
      return { ...rec, status: "unanswered", entryId: undefined };
    }
    return rec;
  }

  /** 测试驱动：把某 submission 投影覆写为任意状态/entry（queued/placed/done/unanswered）。 */
  setSubmissionStatus(submissionId: string, patch: Partial<SubmissionRecord>): void {
    const cur = this.submissions.get(submissionId);
    if (cur) this.submissions.set(submissionId, { ...cur, ...patch });
  }

  /** 测试驱动：把该端点在途计数（pi.inbox 深度，§7.8 inFlight）设为指定值。 */
  setInFlight(endpointId: EndpointId, n: number): void {
    this.handoff.set(endpointId, n);
  }

  onEntry(h: (e: PortEntryEvent) => void): Unsubscribe {
    this.entryHandlers.push(h);
    return () => {
      this.entryHandlers = this.entryHandlers.filter((x) => x !== h);
    };
  }

  onTurnEnd(h: (e: { endpointId: EndpointId }) => void): Unsubscribe {
    this.turnEndHandlers.push(h);
    return () => {
      this.turnEndHandlers = this.turnEndHandlers.filter((x) => x !== h);
    };
  }

  // ── 测试驱动 API ──

  emitEntry(e: PortEntryEvent): void {
    for (const h of [...this.entryHandlers]) h(e);
  }

  endTurn(endpointId: EndpointId): void {
    this.busy.delete(endpointId);
    for (const h of [...this.turnEndHandlers]) {
      try { h({ endpointId }); } catch { /* swallow: store may be closed by test teardown */ }
    }
  }

  /** 统计 triggerTurn===true 的投递次数（P1 验收指标的分子） */
  wakeCount(): number {
    return this.delivered.filter((d) => d.triggerTurn).length;
  }

  /** 按端点统计唤醒次数 */
  wakeCountByEndpoint(endpointId: EndpointId): number {
    return this.delivered.filter((d) => d.endpointId === endpointId && d.triggerTurn).length;
  }
}