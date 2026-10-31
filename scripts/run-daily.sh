#!/usr/bin/env bash
# 兼容入口：真正的执行逻辑在 src/run-daily.js（macOS / Windows 共用）
# 手动测试： CHECKIN_NO_DELAY=1 bash scripts/run-daily.sh
set -uo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

if [ "${CHECKIN_NO_DELAY:-0}" = "1" ]; then
  export CHECKIN_NO_DELAY=1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node，请安装 Node.js 20+"
  exit 1
fi

exec "$NODE_BIN" "$PROJECT_DIR/src/run-daily.js"
