import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import platform from '../platform.js';
import { defineAdapter } from './base.js';
import { abortableSleep, guardPage } from '../runtime.js';

/**
 * 腾讯 WorkBuddy（桌面客户端）—— 签到在客户端里，网页没有。
 *
 * ## 调研过程（2026-10 实测）
 * 1. 客户端是 Electron（/Applications/WorkBuddy.app，5.8.3，Electron 37）
 * 2. 静态检索发现签到不在网页 bundle 里，而在客户端内部：
 *    - IPC 通道 `auth:getCheckinStatus` / `auth:claimDailyCheckin`
 *    - 后端接口 POST /billing/meter/checkin-status、/billing/meter/daily-checkin
 *    - 鉴权在 Electron 主进程里，token 落盘还是加密的（$wbEncrypted），所以不要试图解 token
 * 3. 因此正确做法：让客户端自己发请求 —— 用官方支持的 CDP 调试端口接管渲染进程，
 *    在页面上下文里调它自己的 window.wb.invoke(channel)
 *
 * ## 两个关键的坑（都踩过了）
 * - 客户端只认环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT`，命令行传 --remote-debugging-port 会被拒
 * - 启动时必须剥掉 `ELECTRON_RUN_AS_NODE`：否则 Electron 以纯 Node 模式运行，1 秒后 exit(0)
 *   （在 Electron 系终端/IDE 里跑脚本很容易中招）
 */

const DEFAULT_PORT = 9333;

/** 解析客户端可执行文件（macOS: .app 内部；Windows: exe 路径候选） */
function workbuddyBin(cfg) {
  const explicit = cfg?.platforms?.workbuddy?.app;
  const candidates = explicit ? [explicit] : platform.knownAppPaths.workbuddy;
  const picked = platform.pickAppPath(candidates);
  return picked ? platform.resolveExecutable(picked) : null;
}

async function cdpVersion(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function isAppRunning(execPath) {
  return platform.isProcessRunning(execPath);
}

/** 带调试端口启动客户端（剥掉会致命的环境变量） */
async function launchWithDebug(port, logger, execPath) {
  if (!execPath) throw new Error('找不到 WorkBuddy 客户端，请在 config.json 的 platforms.workbuddy.app 里填写安装路径');
  if (platform.isMacOS && !fs.existsSync(execPath)) throw new Error(`找不到 WorkBuddy 客户端: ${execPath}`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // ← 不删这个，客户端起不来
  delete env.NODE_OPTIONS;
  env.WORKBUDDY_REMOTE_DEBUGGING_PORT = String(port);

  logger.info(`启动 WorkBuddy 客户端（CDP 端口 ${port}）`);
  const child = spawn(execPath, [], { detached: true, stdio: 'ignore', env });
  child.unref();
  child.on('error', (e) => logger.warn(`WorkBuddy 启动失败: ${e.message}`));
  return child;
}

async function waitForCdp(port, logger, timeoutMs = 90000, signal) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    signal?.throwIfAborted();
    const v = await cdpVersion(port);
    if (v) {
      logger.info(`CDP 就绪: ${v.Browser}`);
      return true;
    }
    await abortableSleep(1500, signal);
  }
  return false;
}

/** 优雅退出客户端（只在我们自己拉起来的时候做） */
async function quitApp(pid, logger, execPath) {
  try {
    await platform.quitOwnedProcess(pid, logger);
    logger.step('已关闭 WorkBuddy 客户端');
  } catch (e) {
    logger.warn(`关闭客户端失败（忽略）: ${String(e.message).split('\n')[0]}`);
  }
}

const pickStatus = (raw) => (raw && (raw.data || raw)) || {};

export default defineAdapter({
  id: 'workbuddy',
  name: 'WorkBuddy',
  // 不走网页，走本机客户端；runner 会跳过浏览器启动
  standalone: true,
  homepage: 'https://www.workbuddy.cn/',
  entryUrls: [],
  keywords: [],
  doneKeywords: [],
  enabledByDefault: true,
  // 客户端冷启动可能很慢（尤其早上刚唤醒的机器），总超时给足
  timeout: 240000,
  notes: '签到在桌面客户端内（每日 100 Credits）；脚本会自动启动客户端 → 调内部接口 → 退出。',

  custom: async ({ logger, cfg, dryRun = false, signal, onAbort = () => {} }) => {
    const sleep = (ms) => abortableSleep(ms, signal);
    signal?.throwIfAborted();
    const pc = cfg.platforms?.workbuddy || {};
    const execPath = workbuddyBin(cfg);
    const port = Number(pc.cdpPort || DEFAULT_PORT);
    const quitAfter = pc.quitAfterLaunch !== false;
    const meta = {};
    const done = (st, detail) => ({ status: st, detail, meta });

    // 1) 已在跑？直接连。没跑？用调试端口拉起来。
    let launchedPid = null;
    let version = await cdpVersion(port);

    if (!version) {
      if (dryRun) return { status: 'needs_manual', detail: `演练不会启动或重启 WorkBuddy；请先手动开启调试端口 ${port}` };
      if (execPath && (await isAppRunning(execPath))) {
        // 客户端在跑但没开调试端口：不能强杀用户正在用的窗口
        return {
          status: 'needs_manual',
          detail:
            `WorkBuddy 正在运行但没有开启调试端口（${port}）。` +
            '环境变量只在启动时生效，应用内“重启/更新”会继承旧进程环境，无效。' +
            '正确做法：⌘Q 完全退出（确认无残留进程）后，从访达/启动台重新打开。' +
            `若重启后仍无效，先在 Terminal 执行 scripts/set-workbuddy-debug.sh 确认变量已设置；` +
            `也可手动执行：env -u ELECTRON_RUN_AS_NODE WORKBUDDY_REMOTE_DEBUGGING_PORT=${port} "${execPath || '<WorkBuddy 可执行文件>'}"`,
        };
      }
      launchedPid = await launchWithDebug(port, logger, execPath);
      onAbort(() => quitAfter ? quitApp(launchedPid, logger, execPath) : undefined);
      if (!(await waitForCdp(port, logger, 90000, signal))) {
        await quitApp(launchedPid, logger, execPath);
        return { status: 'error', detail: '客户端已启动但 CDP 端口没起来（90s 超时）' };
      }
      version = await cdpVersion(port);
    } else {
      logger.step('检测到客户端已在运行且调试端口可用，直接接管');
    }

    // 2) 接管渲染进程
    signal?.throwIfAborted();
    let browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
    } catch (e) {
      if (launchedPid) await quitApp(launchedPid, logger, execPath);
      return { status: 'error', detail: `连接 CDP 失败: ${String(e.message).split('\n')[0]}` };
    }

    onAbort(() => browser.close().catch(() => null));
    try {
      signal?.throwIfAborted();
      const pages = browser.contexts().flatMap((c) => c.pages());
      logger.step(`发现 ${pages.length} 个页面`);
      const target = pages.find((p) => p.url().includes('renderer/index.html'));
      if (!target) return { status: 'error', detail: '没找到 WorkBuddy 主窗口，已停止，避免操作其它窗口' };
      const page = guardPage(target, signal);

      // 等 bridge 就绪（首次启动窗口渲染需要几秒）
      await page.waitForFunction(() => window.wb && typeof window.wb.invoke === 'function', null, { timeout: 45000 });

      // 3) 读状态（幂等保护：今天签过就不再请求）
      const rawBefore = await page.evaluate(() => window.wb.invoke('auth:getCheckinStatus'));
      const before = pickStatus(rawBefore);
      if (typeof before.active !== 'boolean' || typeof before.today_checked_in !== 'boolean') {
        return { status: 'needs_manual', detail: '签到状态缺少有效字段；请检查登录或客户端版本，未尝试领取或重启' };
      }
      Object.assign(meta, {
        streak: before.streak_days,
        credits: before.total_credits,
        todayCredit: before.today_credit,
        season: before.season,
        activity: before.theme_name,
        endTime: before.end_time,
      });
      logger.info(
        `签到状态: active=${before.active} today_checked_in=${before.today_checked_in} ` +
          `连续${before.streak_days}天 今日奖励=${before.today_credit} 累计=${before.total_credits}`,
      );

      if (before.active === false) {
        return { status: 'not_found', detail: '当前账号/版本未开放签到活动（接口返回 active=false）' };
      }

      // 演练模式：只读状态，绝不调用 claim
      if (dryRun) {
        return done(
          'dry_run',
          before.today_checked_in
            ? `演练：登录态有效，今日已签到（连续 ${before.streak_days} 天，累计 ${before.total_credits} credits），未重复提交`
            : `演练：登录态有效，今日未签到；正式运行会领取 ${before.today_credit} credits（连续 ${before.streak_days} 天）`,
        );
      }
      if (before.today_checked_in) {
        return done('already', `今天已签到（连续 ${before.streak_days} 天，累计 ${before.total_credits} credits），无需重复`);
      }

      // 4) 执行签到
      const claim = await page.evaluate(async () => {
        try {
          const r = await window.wb.invoke('auth:claimDailyCheckin');
          return { ok: true, result: r };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      });
      logger.step(`claim 返回: ${JSON.stringify(claim).slice(0, 300)}`);

      if (!claim.ok) return { status: 'failed', detail: `签到调用失败: ${claim.error}` };

      // 服务端约定的返回码：10001 = 今天已签到（幂等），0 = 成功
      const cr = claim.result || {};
      if (cr.code === 10001) {
        return done('already', `服务端返回「${cr.msg || '今天已签到'}」`);
      }
      if (cr.code !== undefined && cr.code !== 0) {
        return { status: 'failed', detail: `签到被拒绝 code=${cr.code} msg=${cr.msg || ''}` };
      }

      // 回读确认（不轻信返回值）
      await sleep(2000);
      const after = pickStatus(await page.evaluate(() => window.wb.invoke('auth:getCheckinStatus')));
      if (after.active === true && after.today_checked_in === true) {
        Object.assign(meta, { streak: after.streak_days, credits: after.total_credits, todayCredit: after.today_credit });
        const gained = after.total_credits !== undefined && before.total_credits !== undefined ? after.total_credits - before.total_credits : null;
        return done(
          'success',
          `签到成功${gained !== null && gained > 0 ? ` +${gained} credits` : ''}，` +
            `连续 ${after.streak_days} 天，累计 ${after.total_credits} credits`,
        );
      }
      return { status: 'uncertain', detail: `已调用签到接口但回读仍显示未签到：${JSON.stringify(claim.result).slice(0, 200)}` };
    } finally {
      // 只断开 CDP 连接，不杀掉用户可能正在用的客户端
      try {
        await browser.close?.();
      } catch {
        /* ignore */
      }
      if (launchedPid && quitAfter) await quitApp(launchedPid, logger, execPath);
    }
  },
});
