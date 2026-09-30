// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · SSE 枢纽（零依赖，node:http + Server-Sent Events）。
//
// publish(type, payload) → `event: <type>\ndata: <json>\n\n`；15s 心跳 `: ping`；
// EventSource（浏览器）自动重连、按命名空间订阅。payload JSON 序列化失败时降级
// 为 {error} 帧，绝不让一条坏事件把整个连接打崩。
// ═══════════════════════════════════════════════════════════════════════════

import type { ServerResponse } from "node:http";

const HEARTBEAT_MS = 15_000;

export class SseHub {
  private clients = new Set<ServerResponse>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 挂一个 SSE 连接；返回退订函数。 */
  subscribe(res: ServerResponse): () => void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1500\n\n");
    this.clients.add(res);
    this.ensureHeartbeat();

    const cleanup = () => this.clients.delete(res);
    res.on("close", cleanup);
    res.on("error", cleanup);
    return cleanup;
  }

  /** 广播一个命名事件。type 是 SSE event 名（前端 addEventListener 的 key）。 */
  publish(type: string, payload: unknown): void {
    let data: string;
    try {
      data = JSON.stringify(payload ?? null);
    } catch {
      data = JSON.stringify({ error: "unserializable payload" });
    }
    const frame = `event: ${type}\ndata: ${data}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        // 写失败：连接由 close/error 清理，这里吞掉避免拖垮广播
      }
    }
  }

  /** 只在有订阅者时维持心跳；全退订即停表。 */
  private ensureHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.clients.size === 0) return;
      for (const res of this.clients) {
        try {
          res.write(": ping\n\n");
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_MS);
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}