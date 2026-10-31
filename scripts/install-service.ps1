# 早八 zaoba · Windows 安装脚本
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
#
# 说明：定时任务由 node src/index.js install-service 统一创建（计划任务 schtasks）。
#       如果提示权限不足，请用「以管理员身份运行」的 PowerShell 重试一次。

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

Write-Host "早八 zaoba · 安装 Windows 定时任务" -ForegroundColor Cyan
Write-Host "项目目录: $ProjectDir"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "✗ 找不到 node。请先安装 Node.js 20+：https://nodejs.org/" -ForegroundColor Red
  exit 1
}

$nodeVersion = (node -v) -replace 'v', ''
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 20) {
  Write-Host "✗ Node 版本过低（$nodeVersion），需要 >= 18" -ForegroundColor Red
  exit 1
}
Write-Host "✓ Node $nodeVersion" -ForegroundColor Green

if (-not (Test-Path 'config.json')) {
  Write-Host "→ 首次安装，生成默认配置..."
  node src/index.js list | Out-Null
}

Write-Host "→ 创建计划任务（每天按 config.json 里的时间运行）"
node src/index.js install-service
if ($LASTEXITCODE -ne 0) {
  Write-Host "✗ 创建计划任务失败。请尝试以管理员身份重新运行本脚本。" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "✓ 安装完成" -ForegroundColor Green
Write-Host "  立即测试: node src/run-daily.js"
Write-Host "  可视化控制台: npm run web   （打开 http://127.0.0.1:7788）"
Write-Host "  卸载:     powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1"
Write-Host ""
Write-Host "提示：Windows 下客户端需要你手动安装并登录（WorkBuddy / 豆包工作）。"
Write-Host "      控制台想开机自启，可以把它做成「启动」文件夹里的快捷方式。"
