#!/usr/bin/env bash
# 给「早八」装一个一键入口（macOS）：
#   1) ~/Applications/早八.app       ← 双击打开控制台（服务没开会自动拉起）
#   2) ~/Desktop/早八-书签.html      ← 导入浏览器收藏夹
#
# 用法：bash scripts/install-shortcuts.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ZAOBA_PORT:-7788}"
URL="http://127.0.0.1:${PORT}"
APP_DIR="$HOME/Applications/早八.app"
BOOKMARKS="$HOME/Desktop/早八-书签.html"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ 这个脚本用于 macOS。Windows 请用: powershell -ExecutionPolicy Bypass -File scripts\\install-shortcuts.ps1"
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ 找不到 node，请先安装 Node.js 20+"
  exit 1
fi

# ---------- 1) 生成 .app（AppleScript 外壳） ----------
mkdir -p "$HOME/Applications"
rm -rf "$APP_DIR"
osacompile -o "$APP_DIR" -e "do shell script \"'$NODE_BIN' '$PROJECT_DIR/src/open-console.js'\"" 2>/dev/null
if [ -d "$APP_DIR" ]; then
  echo "✓ 已生成一键入口: $APP_DIR"
else
  echo "✗ 生成 .app 失败"
fi

# ---------- 2) 生成可导入的书签文件 ----------
python3 - "$BOOKMARKS" "$URL" <<'PY'
import sys, pathlib, datetime
out, url = sys.argv[1], sys.argv[2]
html = f"""<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="{url}" ADD_DATE="{int(datetime.datetime.now().timestamp())}">早八 · 签到控制台</A>
</DL><p>
"""
pathlib.Path(out).write_text(html, encoding="utf-8")
print(f"✓ 已生成书签文件: {out}")
PY

cat <<EOF

下一步（各挑一种就行）：

【方式一：放进程序坞】
  打开 ~/Applications，把「早八」拖到程序坞 → 以后点一下图标就打开控制台

【方式二：全局快捷键 ⌃⌥8（推荐）】
  1. 打开「快捷指令」App → 新建快捷指令
  2. 添加操作：搜索「打开 URL」→ 填入 $URL
  3. 命名为「早八」→ 在该快捷指令的信息面板里添加快捷键：⌃ + ⌥ + 8
  4. 以后任何时候按 ⌃⌥8 直接打开

【方式三：浏览器收藏夹】
  双击桌面上的「早八-书签.html」，或导入收藏夹：
    · Chrome/Edge：设置 → 书签管理器 → 导入书签 → 这个 html
    · Safari：文件 → 导入自 → 书签 HTML 文件
  建议把它固定在书签栏，点一下就开

【命令行】
  cd "$PROJECT_DIR" && npm run open
EOF
