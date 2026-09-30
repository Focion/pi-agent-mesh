#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# mesh-demo 一键启动：dist 缺失/过时先构建，端口被占用先关闭占用进程，再前台启动。
#
# 用法：
#   bash scripts/start-demo.sh [--build] [--port <n>]
#
# 端口解析优先级：--port 参数 > MESH_DEMO_PORT 环境变量 > 默认 8787。
# 占端口进程：先用 SIGTERM 请它退出，超时未退再 SIGKILL（打印被杀的 PID 与命令）。
#
# 等价于：npm run demo:start
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${MESH_DEMO_PORT:-8787}"
BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD=1; shift ;;
    --port)
      if [[ $# -lt 2 ]]; then echo "缺少 --port 端口值" >&2; exit 2; fi
      PORT="$2"; shift 2 ;;
    *) echo "未知参数：$1（支持 --build / --port <n>）" >&2; exit 2 ;;
  esac
done

# 端口合法性
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "[demo] 非法端口：$PORT（须 1–65535）" >&2
  exit 2
fi

# ── 1. 构建（dist 缺失或 --build）────────────────────────────────────────────
if [[ "$BUILD" == 1 || ! -f dist/index.js || ! -f dist/core/index.js ]]; then
  echo "[demo] 构建 dist（npm run build）…"
  npm run build
else
  echo "[demo] dist 已存在，跳过构建（--build 可强制重建）"
fi

# ── 2. 端口冲突先关闭 ────────────────────────────────────────────────────────
kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0

  for pid in $pids; do
    local cmd
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || echo "?")"
    echo "[demo] 端口 ${port} 被 PID ${pid} 占用：${cmd}"
    kill -TERM "$pid" 2>/dev/null || true
  done

  # 等最多 5s 退出
  for _ in $(seq 1 20); do
    pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    [[ -z "$pids" ]] && break
    sleep 0.25
  done

  # 仍未退出 → SIGKILL
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  for pid in ${pids:-}; do
    echo "[demo] PID ${pid} 未退出，强制 kill -KILL"
    kill -KILL "$pid" 2>/dev/null || true
  done

  # 最后确认
  sleep 0.5
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "[demo] 警告：端口 ${port} 仍被占用（PID：$pids），启动可能 EADDRINUSE" >&2
  else
    echo "[demo] 端口 ${port} 已释放"
  fi
}

if command -v lsof >/dev/null 2>&1; then
  kill_port "$PORT"
elif command -v fuser >/dev/null 2>&1; then
  # Linux fallback（无 lsof）
  if fuser "${PORT}/tcp" >/dev/null 2>&1; then
    echo "[demo] 端口 ${PORT} 被占用，fuser -k 关闭…"
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
    sleep 0.5
  fi
else
  echo "[demo] 未找到 lsof/fuser，跳过端口检测；冲突时服务器会报 EADDRINUSE" >&2
fi

# ── 3. 前台启动（exec：Ctrl+C / SIGTERM 直接终止）────────────────────────────
export MESH_DEMO_PORT="$PORT"
echo "[demo] 启动 → http://localhost:${PORT}"
exec npm run demo