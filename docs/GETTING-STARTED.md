# 上手教程（从零到每天自动到账）

按这个顺序做，大约 10 分钟。全程只需要你本人做一件事：**在各平台扫码登录一次**。

---

## 0. 先看清：你到底要装什么

早八是「调度器」，它不替平台签到，而是**替你操作平台**。所以分两类：

| 平台 | 要装客户端吗 | 要登录吗 | 每日收益 |
| --- | --- | --- | --- |
| **WorkBuddy** | ✅ 要装腾讯客户端 | ✅ 客户端内扫码 | 100 Credits |
| **豆包工作** | ✅ 要装字节客户端 | ✅ 客户端内扫码 | +200 额度 |
| **智谱清言** | ❌ 不用客户端 | ✅ 项目里扫码一次 | 登录积分 |
| **MiniMax Code** | ❌ 网页版，不用客户端 | ✅ `npm run login:minimax` | 400 积分/天（第 4/7 天 1000） |
| Trae CN / Qoder CN | ✅ 要装各自客户端 | ✅ 客户端内登录 | 150 / 100（需手动启用） |
| Kimi / 文心 / 千问 / 元宝 | — | — | 没有可自动的签到，做不了 |

**最小可用**：只装 WorkBuddy 客户端 = 每天 100 Credits。
**满配**：WorkBuddy + 豆包工作 + 智谱登录 = 每天约 300 额度。

> 不需要装"所有 AI 的客户端"，只装你要覆盖的平台。

---

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| 系统 | macOS 12+（完整验证）或 Windows 10+（网页类可用，客户端类待验证） |
| 运行时 | Node.js ≥ 20（没有的话下面的脚本会告诉你三种装法） |
| 磁盘 | 约 200MB（有 Chrome/Edge 时复用系统浏览器）；没有则需要额外 570MB 内核 |
| 网络 | 能访问 GitHub 下载代码即可；**装完运行不需要外网**，只访问国内平台站点 |
| 系统会话 | 保持 macOS 已登录（定时任务属于用户会话） |

---

## 1.5 先选平台（可选）

```bash
npm run setup -- --check    # 看清单 + 每个平台还差什么
npm run setup               # 勾选要用的平台
```

只想不装任何客户端：`npm run setup -- --web-only`（MiniMax、智谱）。

## 2. 装早八

```bash
# 拿代码（国内直连 GitHub 不稳定时，用下面注释里的镜像）
git clone https://github.com/BorisSun0424-boop/zaoba.git
# git clone https://gh-proxy.com/https://github.com/BorisSun0424-boop/zaoba.git zaoba

cd zaoba

# 先自检：缺什么一目了然（有关键项缺失时退出码为 1）
bash scripts/bootstrap.sh --check

# 正式安装：装 Node（如缺）、npm 依赖、570MB 浏览器内核、生成配置
bash scripts/bootstrap.sh
```

不想碰命令行：把仓库里的 [`docs/AGENT-PROMPT.md`](AGENT-PROMPT.md) 整段复制给你的 AI Agent，让它帮你装。

---

> **Windows 用户**：命令里的 `bash scripts/xxx.sh` 换成
> `powershell -ExecutionPolicy Bypass -File scripts\xxx.ps1`；
> 第 5 步的定时任务同样用 `scripts\install-service.ps1` 安装。

## 3. 装客户端并登录（必须你本人扫码）

### 3.1 WorkBuddy

1. 打开 WorkBuddy 官网下载 Mac 客户端并安装
2. 打开客户端，**扫码登录**
3. 登录后建议勾选「保持登录 / 免登录」

> 早八直接复用客户端的登录态，不需要在早八里再填账号。

### 3.2 豆包工作

1. 下载豆包工作 Mac 客户端并安装
2. 打开客户端，**扫码登录**
3. 进「免费用豆包」面板确认能看到「每日签到 +200 额度」

> 早八会自己打开这个面板点「立即签到」，你只需要保证客户端是登录状态。

### 3.3 智谱清言（不需要客户端）

在项目目录执行：

```bash
npm run login            # 所有网页类平台
npm run login:minimax    # 只登录 MiniMax（登录成功后自动保存退出）
```

会弹出一个浏览器窗口，**扫码登录**，然后回终端按回车保存。登录态存在本项目的 `profile/` 目录里。

---

## 4. 验证（关键一步）

```bash
npm run dry-run
```

这一步**只检查、不签到**，用来确认每个平台都配好了。

看结果对照表：

| 状态 | 含义 | 怎么修 |
| --- | --- | --- |
| ✅ `success` / `already` | 正常 | 无需处理 |
| 🔑 `needs_login` | 该平台还没登录 / 登录过期 | WorkBuddy/豆包 → 客户端重登；智谱 → `npm run login` |
| ⬜ `not_installed` | 客户端没装或路径不对 | 装客户端，或改 `config.json` 里对应平台的 `app` 路径 |
| 🔧 `needs_manual` | 客户端开着但没开调试端口 | 跑一次 `bash scripts/install-launchd.sh`，再重试 |
| ❔ `not_found` | 页面改版，找不到签到入口 | `npm run probe -- --only=平台id` 看实际按钮文案 |
| 📴 `offline` | 断网/刚唤醒网络未就绪 | 联网后重跑；已内置多源重试 |
| ⏱️ `timeout` | 站点或客户端太慢 | 调大 `config.json` 的 `platformTimeout` |

**三个平台都是 ✅ 才算配好。**

---

## 5. 装成每天自动跑

```bash
bash scripts/install-launchd.sh
```

装完会有：

- 每天 **08:00** 主跑（+0~5 分钟随机延迟）
- 每天 **12:30** 补跑（已签自动跳过，用来兜底睡眠/断网）
- 常驻本地控制台：<http://127.0.0.1:7788>

也可以用 `bash scripts/bootstrap.sh --with-service` 一步装完。

改时间三种方式（都不用重装）：

```bash
npm run schedule                    # 看当前设置
npm run schedule -- 07:45           # 改成 7:45
npm run schedule -- 07:45 --delay=10 --retry=14:00
```

或者打开控制台，点右上角 `⏰ 8:00` 直接改。

---

## 6. 日常怎么看结果

> **打开控制台最快的方式**：跑一次 `bash scripts/install-shortcuts.sh`（Windows 用 `scripts\install-shortcuts.ps1`），
> 会得到「早八.app / 桌面快捷方式（Ctrl+Alt+8）/ 可导入书签」。
> 也可以直接用命令 `npm run open`（服务没起会自动拉起）。

- **macOS 通知**：每天跑完弹一条，`✅ WorkBuddy ✅ 豆包工作 🔑 智谱`
- **控制台** <http://127.0.0.1:7788>：连续签到天数、今日完成/未完成、累计领取、近 14 天记录
- **日报**：控制台点「日报」，或看 `data/reports/YYYY-MM-DD.md`

---

## 7. 两个容易踩的坑

1. **WorkBuddy 必须先跑过安装脚本**
   否则客户端开着的时候接管不了（调试端口环境变量没设置）。表现为 `🔧 needs_manual`。

2. **智谱登录态存在项目目录的 `profile/` 里**
   删掉就要重新扫码；它大约几十天会过期一次，过期后 `dry-run` 会提示 `needs_login`。

---

## 8. 常见问题

**Q：需要一直开着客户端吗？**
不用。到点时早八会自己启动客户端，签完再关掉；如果它本来就开着，会直接接管，签完保留运行。

**Q：锁屏会跑吗？睡眠会跑吗？**
- **锁屏 / 屏幕熄灭：会跑。** 锁屏不影响用户会话，定时任务和客户端都正常工作
- **系统睡眠：不会跑。** 整个系统暂停，定时器不触发；唤醒后靠 12:30 补跑兜底
- 所以只需要保证电脑别睡：`sudo pmset repeat wakeorpoweron MTWRFSU 07:55:00`（Windows 的计划任务已带「唤醒运行 + 错过补跑」）

**Q：需要翻墙吗？**
只有「从 GitHub 下载代码」这一步可能需要代理或镜像。**装完之后运行不需要外网**，只访问国内平台站点。

**Q：会消耗我的账号额度吗？**
签到和积分都是平台赠送的，不消耗你已有的付费额度。

**Q：多账号可以吗？**
一台 Mac 一套登录态，默认单账号。多账号需要多份 profile，不推荐。

**Q：会不会被平台判定异常？**
每天一次、本机运行、带随机延迟，已尽量贴近真人。但多数平台协议禁止自动化，风险自负，别高频跑、别批量。

---

## 附：常用命令速查

```bash
npm run web                  # 打开可视化控制台
npm run list                 # 平台状态
npm run checkin              # 手动跑一次（已签会跳过）
npm run dry-run              # 演练：只检查不签到
npm run report               # 今天的日报
npm run schedule -- 08:30    # 改运行时间
npm run clients              # 扫描本机可接管的客户端
npm run enable -- trae-cn    # 启用某平台
bash scripts/uninstall-launchd.sh   # 停掉定时任务（保留数据）
```
