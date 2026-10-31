# 给「早八」装一键入口（Windows）
#   1) 桌面快捷方式「早八控制台」，带全局快捷键 Ctrl+Alt+8
#   2) 开机自动拉起控制台服务（放进「启动」文件夹）
#   3) 桌面生成可导入的书签 HTML
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Url = 'http://127.0.0.1:7788'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "✗ 找不到 node，请先安装 Node.js 20+" -ForegroundColor Red
  exit 1
}
$nodeBin = (Get-Command node).Source
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$ws = New-Object -ComObject WScript.Shell

# ---------- 1) 桌面快捷方式（带快捷键） ----------
$lnkPath = Join-Path $desktop '早八控制台.lnk'
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = $env:ComSpec
$sc.Arguments = "/c start `"`" `"$Url`""
$sc.WorkingDirectory = $ProjectDir
$sc.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,13"
$sc.Description = '早八 · 打开签到控制台'
$sc.Hotkey = 'Ctrl+Alt+8'
$sc.Save()
Write-Host "✓ 桌面快捷方式已创建（快捷键 Ctrl+Alt+8）: $lnkPath" -ForegroundColor Green

# ---------- 2) 登录时自动拉起控制台服务 ----------
$startupLnk = Join-Path $startup '早八控制台服务.lnk'
$sv = $ws.CreateShortcut($startupLnk)
$sv.TargetPath = $nodeBin
$sv.Arguments = "`"$ProjectDir\src\open-console.js`" --no-browser"
$sv.WorkingDirectory = $ProjectDir
$sv.WindowStyle = 7   # 最小化，不打扰
$sv.Description = '早八 · 登录后自动启动控制台服务'
$sv.Save()
Write-Host "✓ 开机自启已设置: $startupLnk" -ForegroundColor Green

# ---------- 3) 书签文件 ----------
$bookmark = Join-Path $desktop '早八-书签.html'
@"
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="$Url">早八 · 签到控制台</A>
</DL><p>
"@ | Set-Content -Encoding UTF8 $bookmark
Write-Host "✓ 书签文件已生成: $bookmark" -ForegroundColor Green

Write-Host ""
Write-Host "怎么用：" -ForegroundColor Cyan
Write-Host "  1. 双击桌面「早八控制台」，或直接按 Ctrl+Alt+8"
Write-Host "  2. 把它固定到任务栏：右键快捷方式 → 固定到任务栏"
Write-Host "  3. 浏览器书签：Chrome/Edge → 书签管理器 → 导入 → 选 $bookmark"
Write-Host "  4. 快捷键想改：右键快捷方式 → 属性 → 快捷键 里改（任意 Ctrl+Alt+字母）"
