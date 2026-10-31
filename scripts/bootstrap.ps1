# 早八 zaoba · Windows 一键自检 / 安装
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1            # 完整安装
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1 -Check     # 只自检
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1 -WithService
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1 -SkipBrowser

param(
  [switch]$Check,
  [switch]$WithService,
  [switch]$SkipBrowser,
  [switch]$ForceBrowser
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir
$Failed = 0

function Ok($m)   { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  ✗ $m" -ForegroundColor Red; $script:Failed++ }
function Step($n, $m) { Write-Host ""; Write-Host "[$n/7] $m" -ForegroundColor Cyan }

Write-Host "早八 zaoba · 安装检查（Windows）" -ForegroundColor Cyan
Write-Host "项目目录: $ProjectDir"
if ($Check) { Write-Host "模式: 仅检查" } else { Write-Host "模式: 完整安装" }

Step 1 "系统环境"
Ok "$([System.Environment]::OSVersion.VersionString) / $env:PROCESSOR_ARCHITECTURE"

Step 2 "Node.js >= 20"
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = (node -v) -replace 'v',''
  $major = [int]($v.Split('.')[0])
  if ($major -ge 20) { Ok "node v$v" } else { Warn "node v$v 版本过低" ; Fail "需要 Node >= 20：https://nodejs.org/" }
} else {
  Fail "未安装 Node.js。请从 https://nodejs.org/ 下载 LTS（安装时勾选 Add to PATH），然后重开 PowerShell"
}

if ($Failed -gt 0 -and $Check) { Write-Host ""; Write-Host "检查完成：有 $Failed 项待处理（退出码 1）" -ForegroundColor Yellow; exit 1 }
if ($Failed -gt 0) { Write-Host ""; Write-Host "✗ 请先解决上面的问题再安装" -ForegroundColor Red; exit 1 }

Step 3 "项目依赖（playwright）"
if (Test-Path 'node_modules\playwright') { Ok "依赖已安装" }
elseif ($Check) { Fail "缺少 node_modules，需要执行 npm install" }
else { npm install --no-audit --no-fund; Ok "依赖安装完成" }

Step 4 "浏览器内核（首次约 570MB，可复用系统浏览器省掉）"
$cache = Join-Path $env:LOCALAPPDATA 'ms-playwright'

# 全新安装时优先复用系统 Edge / Chrome（Windows 自带 Edge）
$systemChannel = ''
$freshInstall = -not (Test-Path 'profile')
if ($freshInstall -and -not $ForceBrowser) {
  $edgePaths = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  )
  $chromePaths = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
  )
  if ($edgePaths | Where-Object { $_ -and (Test-Path $_) }) { $systemChannel = 'msedge' }
  elseif ($chromePaths | Where-Object { $_ -and (Test-Path $_) }) { $systemChannel = 'chrome' }
}

if ($systemChannel) {
  if ($Check) {
    Ok "检测到系统浏览器，可复用它（channel: $systemChannel），无需下载 570MB"
  } else {
    if (-not (Test-Path 'config.json')) { node src/index.js list | Out-Null }
    $cfg = Get-Content 'config.json' -Raw | ConvertFrom-Json
    $cfg | Add-Member -NotePropertyName channel -NotePropertyValue $systemChannel -Force
    $cfg | ConvertTo-Json -Depth 20 | Set-Content 'config.json' -Encoding UTF8
    Ok "已设为复用系统浏览器（channel: $systemChannel），跳过 570MB 下载"
    Warn "注意：切换浏览器内核会让已有登录态失效（首次安装没有这问题）"
  }
} elseif ((Test-Path $cache) -and ((Get-ChildItem $cache -Force | Measure-Object).Count -gt 0)) {
  Ok "浏览器内核已存在"
} elseif ($SkipBrowser) {
  Warn "已跳过下载（网页类平台不可用；客户端类平台不受影响）"
} elseif ($Check) {
  Fail "缺少浏览器内核，需要执行 npx playwright install chromium"
} else {
  Write-Host "  → 下载中，约 570MB"
  npx playwright install chromium
  Ok "浏览器内核安装完成"
}

Step 5 "配置文件"
if (-not (Test-Path 'config.json')) {
  if ($Check) { Warn "缺少 config.json（运行时会自动生成）" }
  else { Copy-Item 'config.example.json' 'config.json'; Ok "已从模板生成 config.json" }
} else { Ok "config.json 已存在" }

Step 6 "定时任务"
if ($WithService) {
  if ($Check) { Ok "（仅检查）会创建 Windows 计划任务" }
  else { node src/index.js install-service; Ok "已创建计划任务（可在「任务计划程序」里看到 ZaobaDailyCheckin）" }
} else {
  Warn "未安装定时任务（需要时加 -WithService）"
}

Step 7 "功能自检"
if ($Check) {
  if ($Failed -gt 0) { Write-Host "检查完成：有 $Failed 项待处理（退出码 1）" -ForegroundColor Yellow; exit 1 }
  Write-Host "检查完成：环境已就绪" -ForegroundColor Green
  exit 0
}

Write-Host "  → 平台列表"
node src/index.js list

Write-Host ""
Write-Host "安装完成。接下来：" -ForegroundColor Green
Write-Host "  1) 装 WorkBuddy / 豆包工作 客户端并扫码登录（智谱不需要客户端，跑 npm run login）"
Write-Host "  2) npm run dry-run 验证"
Write-Host "  3) npm run web 打开控制台"
