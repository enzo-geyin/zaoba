# 交给 AI Agent 的安装指令（早八）

把下面整段复制给你常用的 AI Agent（Claude Code / Cursor / DeepSeek Harness / WorkBuddy / Codex 等）即可，它会在你的 Mac 上完成安装、登录引导和验证。

> 适用：你不想碰终端，希望 Agent 帮你把环境装好。
> 前提：你愿意在过程中亲自完成各平台的扫码登录（Agent 无法代替你登录）。

---

## 复制以下内容给 Agent

```
你是一名 macOS 环境搭建助手。请在本机安装并配置「AI 签到工具」（一个每天自动完成各 AI 工具签到的本地程序）。

## 目标
让工具能每天自动运行，并提供本地控制台；不要求我现在就登录所有平台，但要把安装和登录引导做完。

## 硬性安全约束（必须遵守）
1. 绝不执行 rm -rf，尤其不要删除 /Applications、~/Documents、~/Desktop、~/Downloads 下的任何东西。
2. 需要替换文件时，先 mv 到 /tmp/backup-<名称>-<时间戳>，不要直接删。
3. 任何 sudo 命令，先打印完整命令并等我明确同意，不要自己加 -y 之类的自动确认。
4. 不要把任何 token、Cookie、profile 目录内容打印到终端或上传到网络。
5. 所有下载请用官方来源；下载后校验文件类型（file / hdiutil imageinfo），残缺就重下。
6. 不要修改我的电源设置、通知设置，只告诉我该怎么改。

## 请按以下步骤执行

### 步骤 1：环境检查
- 先判断操作系统：
  · macOS：执行 uname -s、uname -m、sw_vers
  · Windows：执行 `systeminfo | findstr /C:"OS Version"` 与 `$env:PROCESSOR_ARCHITECTURE`
- 后续命令按系统选择：macOS 用 `bash scripts/*.sh`，Windows 用
  `powershell -ExecutionPolicy Bypass -File scripts\*.ps1`
- 执行 node -v，判断是否 ≥20
- 检查磁盘剩余空间（需要约 1.5GB）

### 步骤 2：安装 Node.js ≥20（如果缺失或版本过低）
按以下优先级选一种，并在执行前告诉我你选了哪种：
  A) 若存在 brew：brew install node
  B) 若无 brew：从 https://nodejs.org 下载 .pkg（先查最新 LTS 版本号），然后用 sudo installer -pkg ... -target /（执行前必须征得我同意）
  C) 若我不想用 sudo：用 nvm（curl 安装脚本 → nvm install --lts）
装完执行 node -v 验证，并确认 ≥20。

### 步骤 3：获取代码
- 如果我已经把项目放在本地，问我路径后 cd 进去
- 否则执行：
    git clone https://github.com/BorisSun0424-boop/zaoba.git
    cd zaoba
    # 如果 clone 慢或失败（国内网络常见），改用镜像：
    # git clone https://ghfast.top/https://github.com/BorisSun0424-boop/zaoba.git zaoba
  （仓库是私有的，如果 clone 失败请告诉我需要授权，不要反复重试）

### 步骤 4：安装依赖与浏览器内核
- 先跑自检：bash scripts/bootstrap.sh --check
- 然后按提示执行：bash scripts/bootstrap.sh
  （它会装 npm 依赖、下载约 570MB 的 Playwright Chromium、生成 config.json）
- 如果这一步失败，把关键报错贴给我，不要自己反复重装

### 步骤 5：登录引导（需要我本人操作）
- WorkBuddy：告诉我「打开 WorkBuddy 客户端扫码登录」，我确认后再继续
- 智谱清言：替我执行 npm run login，并告诉我需要在弹出的浏览器里扫码；完成后按回车保存
- Trae CN / Qoder CN（如果我需要）：告诉我先去各自客户端登录
- 登录完执行 npm run dry-run，把结果贴给我

### 步骤 6：安装定时任务（可选，先问我）
问我要不要安装系统级定时任务（每天 08:00 + 12:30 自动签到 + 常驻本地控制台）。
如果我要，执行：bash scripts/install-launchd.sh
然后报告控制台地址（http://127.0.0.1:7788）。

### 步骤 7：电源与权限提示（只提示，不要改）
告诉我：
- 系统睡眠时定时任务不会执行（唤醒后补跑），如果希望准时，需要执行 sudo pmset repeat wakeorpoweron MTWRFSU 08:25:00（由我自己执行）
- 如果收不到通知，去 系统设置 → 通知 允许对应程序
- 定时任务需要我的 macOS 会话处于已登录状态

### 步骤 8：最终验收
执行并汇报结果：
  node src/index.js list
  node src/index.js run --dry-run
验收标准：
- list 能列出平台，且 WorkBuddy / 智谱清言 处于启用状态
- dry-run 输出中没有 error；needs_login / not_installed 属于正常（说明还没登录或没装客户端）
最后给我一份简短总结：装了什么、当前哪些平台可用、还差哪些需要我操作。

## 失败处理
- 任何一步失败，停止并汇报：执行的命令、错误输出、你的判断和两个备选方案
- 不要为了"绕过报错"去改系统配置或删除文件
```

---

## 安装完成后你会看到什么

Agent 完成后应该给出类似结论：

```
已安装：
  · Node v24.x（满足 ≥20）
  · 依赖 + Playwright Chromium（约 570MB）
  · 定时任务：每天 08:00 / 12:30（已签跳过）
  · 本地控制台：http://127.0.0.1:7788

当前可用：
  ✅ WorkBuddy   每日 100 credits
  ✅ 智谱清言    每日登录积分（需你扫码登录一次）

待你操作：
  🔑 智谱清言：npm run login 扫码
  ⬜ Trae CN / Qoder CN：需要先安装对应客户端并登录
```

---

## 常见追问

**Q：Agent 装 Node 会不会弄坏我现有的 Node？**
A：用 Homebrew 或 nvm 都是并行安装/版本管理，不会覆盖系统 Node。若用官方 pkg，会升级到该版本，建议先确认你现有版本。

**Q：为什么还要我扫码？**
A：登录必须真人完成验证码/扫码，任何脚本都无法代登录，也不应该代登录。扫码只需一次。

**Q：Agent 会不会把我账号信息传出去？**
A：本工具的代码没有任何上报逻辑，登录态只写本机 `profile/`。上面对 Agent 的指令也明确禁止上传凭据。你可以随时 `git grep -n "http" src/` 自查网络调用。

**Q：跑起来之后我还需要做什么？**
A：正常用电脑即可。每天会自动跑，结果在控制台和 macOS 通知里。偶尔登录态过期时重登一次（WorkBuddy 较久，智谱约几十天）。
