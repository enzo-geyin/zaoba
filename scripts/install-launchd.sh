#!/usr/bin/env bash
# macOS 安装脚本：系统定时任务 + WorkBuddy 调试端口持久化 + 常驻控制台
# 定时任务本身由 `node src/index.js install-service` 统一实现（mac=launchd / win=schtasks）
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UID_NUM="$(id -u)"
ENV_LABEL="com.local.ai-checkin-workbuddy-env"
WEB_LABEL="com.local.ai-checkin-web"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ 这个脚本仅用于 macOS。Windows 请用:  powershell -ExecutionPolicy Bypass -File scripts\\install-service.ps1"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 找不到 node。先安装 Node.js 20+（brew install node 或官方 pkg）。"
  exit 1
fi

cd "$PROJECT_DIR"

if [ ! -f config.json ]; then
  echo "→ 首次安装，生成默认配置..."
  node src/index.js list >/dev/null
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/data/log"
chmod +x "$PROJECT_DIR/scripts/set-workbuddy-debug.sh" "$PROJECT_DIR/scripts/run-daily.sh"

# ---------- 1) 每日定时任务（统一实现） ----------
node src/index.js install-service

# ---------- 2) WorkBuddy 始终带调试端口启动 ----------
LAUNCHD_ENV_SET=0
bash "$PROJECT_DIR/scripts/set-workbuddy-debug.sh" || LAUNCHD_ENV_SET=1
if [ "$LAUNCHD_ENV_SET" = "1" ]; then
  echo "! WorkBuddy 调试端口环境变量设置失败（不影响其它平台，可稍后手动执行 scripts/set-workbuddy-debug.sh）"
fi

ENV_PLIST="$HOME/Library/LaunchAgents/$ENV_LABEL.plist"
cat > "$ENV_PLIST" <<ENVEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ENV_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PROJECT_DIR}/scripts/set-workbuddy-debug.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${PROJECT_DIR}/data/log/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${PROJECT_DIR}/data/log/launchd.err.log</string>
</dict>
</plist>
ENVEOF
plutil -lint "$ENV_PLIST" >/dev/null
launchctl bootout "gui/$UID_NUM/$ENV_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$ENV_PLIST"
echo "✓ WorkBuddy 调试端口持久化已安装（${ENV_LABEL}）"

# ---------- 3) 常驻可视化控制台 ----------
NODE_BIN="$(command -v node)"
WEB_PLIST="$HOME/Library/LaunchAgents/$WEB_LABEL.plist"
cat > "$WEB_PLIST" <<WEBEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${WEB_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJECT_DIR}/src/index.js</string>
    <string>web</string>
    <string>--port=7788</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${PROJECT_DIR}/data/log/web.out.log</string>
  <key>StandardErrorPath</key><string>${PROJECT_DIR}/data/log/web.err.log</string>
</dict>
</plist>
WEBEOF
plutil -lint "$WEB_PLIST" >/dev/null
launchctl bootout "gui/$UID_NUM/$WEB_LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID_NUM" "$WEB_PLIST" 2>/dev/null || {
  sleep 2
  launchctl bootstrap "gui/$UID_NUM" "$WEB_PLIST" 2>/dev/null || launchctl kickstart -k "gui/$UID_NUM/$WEB_LABEL" 2>/dev/null || true
}
echo "✓ 可视化控制台已设为常驻: http://127.0.0.1:7788"

echo ""
echo "✓ 安装完成"
echo "  立即测试: node src/run-daily.js"
echo "  卸载:     bash scripts/uninstall-launchd.sh"
echo "  注意：先在项目目录跑一次 npm run login 完成平台登录，否则会提示 needs_login"
