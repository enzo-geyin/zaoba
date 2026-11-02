#!/usr/bin/env bash
# 让 WorkBuddy 每次启动都带 CDP 调试端口（仅监听 127.0.0.1）。
# 原因：WorkBuddy 只认环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT，
# 而 GUI 应用的环境变量来自 launchd 用户域，所以用 launchctl setenv 持久化。
#
# 注意：setenv 调用成功不代表 GUI 域已生效，必须回读确认，否则会出现
# “显示已设置、客户端却没开端口”的假成功。
set -uo pipefail
PORT="${WORKBUDDY_CDP_PORT:-9333}"
VAR=WORKBUDDY_REMOTE_DEBUGGING_PORT

if ! launchctl setenv "$VAR" "$PORT" 2>/dev/null; then
  echo "✗ launchctl setenv 被拒绝：当前进程无权修改 launchd 用户域" >&2
  echo "  请在 Terminal.app（不是编辑器内置终端）里手动执行：" >&2
  echo "    launchctl setenv $VAR $PORT" >&2
  exit 1
fi

ACTUAL="$(launchctl getenv "$VAR" 2>/dev/null || true)"
if [ "$ACTUAL" != "$PORT" ]; then
  echo "✗ 设置后回读不一致（读回：'${ACTUAL:-空}'）" >&2
  echo "  客户端不会拿到调试端口，请手动执行后重试：" >&2
  echo "    launchctl setenv $VAR $PORT && launchctl getenv $VAR" >&2
  exit 1
fi

echo "✓ 已设置并回读确认 ${VAR}=${PORT}（本次登录会话生效，重启后由 LaunchAgent 重新设置）"
