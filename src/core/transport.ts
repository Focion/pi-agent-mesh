// ═══════════════════════════════════════════════════════════════════════════
// Transport（§19.2）：把「Router 已受理的一条 delivery」送到目标 Endpoint 所在
// 的执行域。
// - InProcessTransport = 进程内直派（默认形态，§3.6）。
// - SameHostTransport = 同机多进程（§19.3）：publish 写 mesh_outbox ready，
//   轮询 CAS 认领后经 handler 投递，ack 推进 outbox done。
// Transport 只搬运：不校验、不定档。顺序由 seq 保证（§7.7）。
// ═══════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";
import type {
  DeliveryHandler,
  DeliveryState,
  EndpointId,
  PendingDelivery,
  Transport,
  Unsubscribe,
} from "./types.js";
import { isoNow } from "./util.js";

export class InProcessTransport implements Transport {
  readonly kind = "inProcess" as const;

  private handlers = new Map<EndpointId, DeliveryHandler>();
  private published = 0;
  private failures = 0;

  subscribe(endpointId: EndpointId, h: DeliveryHandler): Unsubscribe {
    this.handlers.set(endpointId, h);
    return () => {
      if (this.handlers.get(endpointId) === h) this.handlers.delete(endpointId);
    };
  }

  /** 单进程内直派：目标 handler 由 Mailbox 装配时注册 */
  async publish(d: PendingDelivery): Promise<void> {
    this.published++;
    const h = this.handlers.get(d.endpointId ?? "");
    if (!h) {
      // 没有订阅者（端点不在本进程）：单进程形态下不该发生；多进程形态走
      // SameHostTransport（§19.3）。记录后静默——状态由 mesh_deliveries 兜底。
      this.failures++;
      return;
    }
    await h(d);
  }

  /** 单进程内状态跃迁直写 DB（由 Mailbox 持有），Transport 无需中转 */
  async ack(_deliveryId: string, _state: DeliveryState): Promise<void> {
    /* no-op：InProcessTransport 的 ack 语义由 Mailbox 的直接 setState 承担 */
  }

  // ── 测试观测 ──
  stats(): { published: number; failures: number } {
    return { published: this.published, failures: this.failures };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SameHostTransport（§19.3）：同机多进程 outbox 运输。
//
// - publish：INSERT mesh_outbox(state='ready')，幂等（delivery_id PK）。
// - Poller：周期轮询 → CAS 认领(state ready→claimed) → 调 handler 投递 → ack done。
// - 回收：claimed 超 claimTtlMs → ready；attempts >= maxAttempts → failed。
// - subscribe：进程 warm 端点时注册 DeliveryHandler（Mailbox 管线：欢迎接端口 deliver）。
// ═══════════════════════════════════════════════════════════════════════════

export interface SameHostTransportOpts {
  /** 轮询间隔 (ms)，默认 1000 */
  pollIntervalMs?: number;
  /** 认领后超时 (ms)，默认 300000 (5 min) */
  claimTtlMs?: number;
  /** 最大尝试次数，默认 3 */
  maxAttempts?: number;
}

export class SameHostTransport implements Transport {
  readonly kind = "sameHost" as const;

  private readonly db: Database.Database;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly maxAttempts: number;
  private readonly writerId: string;

  private handlers = new Map<EndpointId, DeliveryHandler>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Database.Database,
    writerId: string,
    opts: SameHostTransportOpts = {},
  ) {
    this.db = db;
    this.writerId = writerId;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.claimTtlMs = opts.claimTtlMs ?? 300_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  // ── Transport 契约 ──────────────────────────────────────────────────────

  subscribe(endpointId: EndpointId, h: DeliveryHandler): Unsubscribe {
    this.handlers.set(endpointId, h);
    return () => {
      if (this.handlers.get(endpointId) === h) this.handlers.delete(endpointId);
    };
  }

  /** 落库 outbox ready（幂等：delivery_id 主键 + INSERT OR IGNORE） */
  async publish(d: PendingDelivery): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO mesh_outbox (delivery_id, target_endpoint, payload, state) VALUES (?,?,?,'ready')",
      )
      .run(d.deliveryId, d.endpointId ?? "", JSON.stringify(d));
  }

  /** 推进 outbox 状态：delivered → done，否则写回状态 */
  async ack(deliveryId: string, state: DeliveryState): Promise<void> {
    if (state === "delivered") {
      this.db
        .prepare(
          "UPDATE mesh_outbox SET state = 'done' WHERE delivery_id = ?",
        )
        .run(deliveryId);
    } else {
      // 失败或非终态：保留已认领行供回收
      this.db
        .prepare(
          "UPDATE mesh_outbox SET state = ? WHERE delivery_id = ?",
        )
        .run(state, deliveryId);
    }
  }

  // ── Poller ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.pollTimer) return;
    // 启动时先回收一轮（清理 crash 遗留的 stale claimed）
    this.runPollCycle();
    this.pollTimer = setInterval(() => this.runPollCycle(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 对外暴露供测试手工触发一轮 */
  async pollOnce(): Promise<{ claimed: number; reclaimed: number; failed: number }> {
    return this.runPollCycle();
  }

  private async runPollCycle(): Promise<{ claimed: number; reclaimed: number; failed: number }> {
    const now = isoNow();
    const claimCutoff = new Date(Date.now() - this.claimTtlMs).toISOString();

    // ① 回收：claimed 超时 → ready（attempts 由认领时的 UPDATE 已 +1）
    const reclam = this.db
      .prepare(
        "UPDATE mesh_outbox SET state = 'ready', claimed_by = NULL, claimed_at = NULL " +
          "WHERE state = 'claimed' AND claimed_at < ?",
      )
      .run(claimCutoff);

    // ② 死信：attempts 超限 → failed
    const failed = this.db
      .prepare(
        "UPDATE mesh_outbox SET state = 'failed' " +
          "WHERE state IN ('ready','claimed') AND attempts >= ?",
      )
      .run(this.maxAttempts);

    // ③ 认领并投递（只认领本进程有 handler 的端点条目，不对其他进程的条目做无用认领）
    const rows = this.db
      .prepare<
        [],
        {
          delivery_id: string;
          target_endpoint: string;
          payload: string;
          attempts: number;
        }
      >(
        "SELECT delivery_id, target_endpoint, payload, attempts FROM mesh_outbox " +
          "WHERE state = 'ready' ORDER BY delivery_id LIMIT 50",
      )
      .all();
    let claimed = 0;
    for (const row of rows) {
      // 预解析 payload 取其 endpointId；无 handler ⇒ 跳过（留给对端 poller）
      const pd = JSON.parse(row.payload) as PendingDelivery;
      const handler = this.handlers.get(pd.endpointId ?? "");
      if (!handler) continue;

      // CAS 认领
      const result = this.db
        .prepare(
          "UPDATE mesh_outbox SET state = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1 " +
            "WHERE delivery_id = ? AND state = 'ready'",
        )
        .run(this.writerId, now, row.delivery_id);
      if (result.changes === 0) continue;
      claimed++;

      try {
        await handler(pd);
      } catch {
        // handler 抛错 → 行回 ready 让后续回收处理（不在此自改状态避免竞态）
      }
    }
    return { claimed, reclaimed: reclam.changes, failed: failed.changes };
  }
}
