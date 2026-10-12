#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# mesh-demo 一键启动（放在 demo/ 下，从任意目录调用都可）。
#
# 它把散落的启动前置步骤打包成一条命令：
#   1. 依赖检查    node_modules 缺失 → 自动 npm install
#   2. 配置检查    demo.config.json 缺失 → 自动从 demo.config.example.json 复制
#   3. 构建检查    dist 缺失/过时或 --build → 自动 npm run build（demo 从 dist 导入）
#   4. 端口清理    目标端口被占用 → 先 SIGTERM 后 SIGKILL 关闭占用进程
#   5. 前台启动    exec node demo/src/server.ts（Ctrl+C / SIGTERM 直接终止）
#
# 用法：
#   bash demo/start.sh [--build] [--port <n>] [--no-kill]
#     --build     强制重建 dist（默认仅在缺失时构建）
#     --port <n>  指定端口（优先级高于 MESH_DEMO_PORT，默认 8787）
#     --no-kill   端口被占用时不自动杀进程，直接报错退出
#
# Node 需 ≥ 22.19（demo 用原生 TS type-stripping 直接跑 .ts）。
# 真正跑起来还需 LLM 凭据（见 src/config.ts：无密钥会 fail-fast 退出）。
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# 定位仓库根：本脚本在 demo/ 下 → ROOT = demo/..
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PORT="${MESH_DEMO_PORT:-8787}"
BUILD=0
NO_KILL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)   BUILD=1; shift ;;
    --no-kill) NO_KILL=1; shift ;;
    --port)
      if [[ $# -lt 2 ]]; then echo "[demo] 缺少 --port 端口值" >&2; exit 2; fi
      PORT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[demo] 未知参数：$1（支持 --build / --port <n> / --no-kill）" >&2; exit 2 ;;
  esac
done

# ── 0. Node 版本守卫（demo 直接跑 .ts，需 ≥ 22.19）──────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[demo] 未找到 node，请先安装 Node ≥ 22.19" >&2
  exit 1
fi
NODE_VER="$(node --version)"                     # 形如 v24.19.0
NODE_MAJOR="${NODE_VER#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 19) )); then
  echo "[demo] Node 版本要求 ≥ 22.19（当前 ${NODE_VER}）。请升级后重试。" >&2
  exit 1
fi

# 端口合法性
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "[demo] 非法端口：$PORT（须 1–65535）" >&2
  exit 2
fi

# ── 1. 依赖检查 ──────────────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  echo "[demo] 缺少 node_modules，安装依赖（npm install）…"
  npm install
fi

# ── 2. 配置文件检查（缺失则从 example 复制，并提示改成本机凭据）───────────────
if [[ ! -f demo/demo.config.json ]]; then
  if [[ -f demo/demo.config.example.json ]]; then
    cp demo/demo.config.example.json demo/demo.config.json
    echo "[demo] 已从 demo.config.example.json 生成 demo/demo.config.json"
    echo "[demo] ⚠️  请按需修改 provider / modelId，并确保已配置 LLM 凭据（env 或 ~/.pi/agent/auth.json）。"
  else
    echo "[demo] 缺少 demo/demo.config.json 且无 example 可复制。" >&2
    exit 1
  fi
fi

# ── 3. 构建检查（demo 从 ../../dist 导入，必须先有 dist）──────────────────────
if [[ "$BUILD" == 1 || ! -f dist/index.js || ! -f dist/core/index.js ]]; then
  echo "[demo] 构建 dist（npm run build）…"
  npm run build
else
  echo "[demo] dist 已存在，跳过构建（--build 可强制重建）"
fi

# ── 4. 端口冲突处理 ──────────────────────────────────────────────────────────
port_pids() { lsof -ti "tcp:${PORT}" 2>/dev/null || true; }

if command -v lsof >/dev/null 2>&1; then
  PIDS="$(port_pids)"
  if [[ -n "$PIDS" ]]; then
    if [[ "$NO_KILL" == 1 ]]; then
      echo "[demo] 端口 ${PORT} 已被占用（PID：$PIDS），--no-kill 已指定，退出。" >&2
      exit 1
    fi
    for pid in $PIDS; do
      echo "[demo] 端口 ${PORT} 被 PID ${pid} 占用：$(ps -p "$pid" -o command= 2>/dev/null || echo '?')"
      kill -TERM "$pid" 2>/dev/null || true
    done
    # 等最多 5s 优雅退出
    for _ in $(seq 1 20); do
      [[ -z "$(port_pids)" ]] && break
      sleep 0.25
    done
    # 仍未退 → SIGKILL
    for pid in $(port_pids); do
      echo "[demo] PID ${pid} 未退出，强制 kill -KILL"
      kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 0.5
    if [[ -n "$(port_pids)" ]]; then
      echo "[demo] 警告：端口 ${PORT} 仍被占用（PID：$(port_pids)），启动可能 EADDRINUSE" >&2
    else
      echo "[demo] 端口 ${PORT} 已释放"
    fi
  fi
else
  echo "[demo] 未找到 lsof，跳过端口检测；冲突时服务器会报 EADDRINUSE" >&2
fi

# ── 5. 前台启动（exec：Ctrl+C / SIGTERM 直接终止服务器进程）───────────────────
export MESH_DEMO_PORT="$PORT"
echo "[demo] 启动 → http://localhost:${PORT}"
exec node demo/src/server.ts
