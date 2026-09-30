// ═══════════════════════════════════════════════════════════════════════════
// mesh 面板 · node:http 入口（零第三方依赖）。
//
// 启动顺序：loadAndValidateDemo()（无密钥 fail-fast）→ MeshController.init()
// （真实装配）→ listen。任何一步失败即向 stderr 打印确切原因并 exit(1)，绝不
// 退化成 faux/假端口。
//
// 路由：
//   POST /api/<command>  → rpc.dispatch（JSON 体 {…} → {ok, result?|error}）
//   GET  /api/events     → SSE（text/event-stream）
//   GET  /…             → demo/public/ 静态托管
//
// 运行：node demo/src/server.ts（Node ≥ 22.19 原生 TS type-stripping）。
// ═══════════════════════════════════════════════════════════════════════════

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateDemo, ConfigError, DEMO_VERSION } from "./config.ts";
import { MeshController, type ControllerHooks } from "./runtime.ts";
import { dispatch } from "./rpc.ts";
import { SseHub } from "./sse.ts";

// ── 配置 + 装配（无密钥在此抛 ConfigError）───────────────────────────────────

let resolved;
try {
  resolved = loadAndValidateDemo();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`\n${err.message}\n\n`);
    process.stderr.write(`[mesh-demo] 无密钥不跑：本面板 100% 真实，不提供 faux/假模型兜底。\n`);
    process.exit(1);
  }
  throw err;
}

const { config, model, credential } = resolved;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const sse = new SseHub();

const hooks: ControllerHooks = {
  meshEvent: (type, payload) => sse.publish("mesh", { type, payload }),
  scenario: (frame) => sse.publish("scenario", frame),
  delivery: (payload) => sse.publish("delivery", payload),
};

const controller = new MeshController(config, model, hooks);
await controller.init();

// ── 静态文件名 → Content-Type ────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

function serveStatic(reqPath: string, res: ServerResponse): void {
  const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404).end("404 not found");
    return;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    "Content-Length": body.length,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── HTTP 服务器 ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/api/events") {
      if (req.method !== "GET") return json(res, 405, { error: { name: "Method", message: "GET only" } });
      const unsubscribe = sse.subscribe(res);
      req.on("close", unsubscribe);
      sse.publish("hello", { demo: "mesh-panel", version: DEMO_VERSION, credential: credential.source });
      return;
    }

    // `/api/health` = 配置/凭据来源（首屏顶部）；`/api/state` 走下面 RPC 分发
    // 的 `state` 命令 → MeshController.snapshot()（实体投影 + counters + 验收）。
    if (path === "/api/health") {
      return json(res, 200, {
        ok: true,
        result: {
          demo: "mesh-panel",
          version: DEMO_VERSION,
          config: {
            provider: config.provider,
            modelId: config.modelId,
            thinkingLevel: config.thinkingLevel,
            tools: config.tools,
            dbPath: config.dbPath,
            stateDir: config.stateDir,
            agentDir: config.agentDir ?? "(pi default ~/.pi/agent)",
            port: config.port,
          },
          credentialSource: credential.source,
        },
      });
    }

    if (path.startsWith("/api/")) {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: { name: "Method", message: "POST only" } });
      const cmd = path.slice("/api/".length);
      const args = await readBody(req);
      const result = await dispatch(controller, cmd, args);
      return json(res, 200, result);
    }

    // 静态托管
    return serveStatic(path, res);
  } catch (err) {
    json(res, 500, { ok: false, error: { name: "InternalError", message: String(err) } });
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `\n[mesh-demo] 端口 ${config.port} 已被占用（换个端口：MESH_DEMO_PORT=… npm run demo）。\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, () => {
  process.stdout.write(
    `[mesh-demo] 面板已就绪 → http://localhost:${config.port}\n` +
      `            model  = ${config.provider}/${config.modelId} · thinking=${config.thinkingLevel}\n` +
      `            凭据    = ${credential.source}\n` +
      `            db     = ${config.dbPath}\n` +
      `            事件流  = /api/events（15 个 MeshEvent + delivery/scenario/tick 每秒）\n`,
  );
});

// ── 1s tick：counters + 顶端点投影 + 验收比值 ────────────────────────────────

const tickTimer = setInterval(() => {
  controller.tick()
    .then((snap) => sse.publish("tick", snap))
    .catch(() => {
      // tick 失败静默（下一次再试）
    });
}, 1000);
tickTimer.unref?.();

// ── 优雅关闭 ──────────────────────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\n[mesh-demo] ${signal} 收到，关闭中…\n`);
  clearInterval(tickTimer);
  sse.close();
  try {
    await controller.dispose();
  } catch (err) {
    process.stderr.write(`[mesh-demo] close 报错：${String(err)}\n`);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));