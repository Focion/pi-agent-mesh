// ═══════════════════════════════════════════════════════════════════════════
// Transport（§19.2）：把「Router 已受理的一条 delivery」送到目标 Endpoint 所在
// 的执行域。InProcessTransport = 进程内直派（默认形态，§3.6）。
// Transport 只搬运：不校验、不定档、不持久化。顺序由 seq 保证（§7.7）。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  DeliveryHandler,
  DeliveryState,
  EndpointId,
  PendingDelivery,
  Transport,
  Unsubscribe
} from "./types.js";

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
      // SqliteOutboxTransport（P5）。记录后静默——状态由 mesh_deliveries 兜底。
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
