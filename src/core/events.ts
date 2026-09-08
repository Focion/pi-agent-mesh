// ═══════════════════════════════════════════════════════════════════════════
// EventBus（§12.5）：十五个事件；事件是通知不是钩子。
// ① 处理器抛错不影响投递（捕获、计数、继续）；② 不接受 Promise；
// ③ 事件在投递事务提交之后派发。
// ═══════════════════════════════════════════════════════════════════════════

import type { EventBus } from "./contracts.js";
import type { MeshEvents } from "./types.js";
import type { Unsubscribe } from "./types.js";

export class MeshEventBus implements EventBus {
  private handlers = new Map<keyof MeshEvents, Array<(p: never) => void>>();
  private count = 0;
  private errors = 0;

  on<K extends keyof MeshEvents>(
    event: K,
    handler: (p: MeshEvents[K]) => void,
  ): Unsubscribe {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (p: never) => void);
    this.handlers.set(event, list);
    return () => {
      const cur = this.handlers.get(event);
      if (!cur) return;
      this.handlers.set(
        event,
        cur.filter((h) => h !== (handler as (p: never) => void)),
      );
    };
  }

  emit<K extends keyof MeshEvents>(event: K, payload: MeshEvents[K]): void {
    this.count++;
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return;
    for (const h of [...list]) {
      try {
        (h as (p: MeshEvents[K]) => void)(payload);
      } catch {
        // ① 处理器异常不影响投递（§12.5 硬规定一）
        this.errors++;
      }
    }
  }

  emittedCount(): number {
    return this.count;
  }

  /** 测试用：处理器抛错次数 */
  handlerErrorCount(): number {
    return this.errors;
  }
}
