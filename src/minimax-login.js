#!/usr/bin/env node
/**
 * MiniMax Code 专用登录：弹出浏览器窗口，你扫码/手机号登录，
 * 程序自己检测到登录成功就保存并退出（不需要在终端按回车）。
 *
 * 用法：node src/minimax-login.js
 */
import { launchContext } from './browser.js';
import { loadConfig } from './config.js';
import { acquireTaskLock } from './task-lock.js';
acquireTaskLock();
import { pageText } from './dom.js';
import { createLogger } from './logger.js';

const logger = createLogger('minimax-login');
import { sleep } from './util.js';

const HOME = 'https://agent.minimax.cn/';
const MAX_MINUTES = 20;

async function checkLoggedIn(page) {
  // 登录成功的判据：页面出现签到面板/签到文案，或左下角出现用户名（MiniMaxxxxxxx / 用户xxxx）
  try {
    const r = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const hasLoginForm = /微信扫码登录|获取验证码|请输入您的手机号/.test(t);
      const hasUser = /MiniMax\d+/.test(t) || /每日签到/.test(t) || /签到得/.test(t);
      return { ok: !hasLoginForm && hasUser, status: hasLoginForm ? 401 : 200 };
    });
    return r;
  } catch {
    return { ok: false, status: -1 };
  }
}

async function main() {
  const cfg = loadConfig();
  const ctx = await launchContext(cfg, { headless: false, logger });
  const page = await ctx.newPage();
  logger.info(`已打开 ${HOME} —— 请在窗口里完成登录（扫码 / 手机号都行）`);
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2500);

  // 把窗口提到最前，并自动点开「登录」弹窗，省得你自己找
  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }
  for (const sel of ['button:has-text("登录")', 'button:has-text("登录 / 注册")', 'text=登录']) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click({ timeout: 4000 });
        logger.info('已自动点开「登录」弹窗，请扫码或输手机号');
        await page.waitForTimeout(1500);
        break;
      }
    } catch {
      /* 换下一个 */
    }
  }

  // 每 15 秒截一张图，方便排查窗口里到底是什么状态
  const shotTimer = setInterval(() => {
    page.screenshot({ path: '/tmp/minimax-login-shot.png' }).catch(() => null);
  }, 15000);
  page.screenshot({ path: '/tmp/minimax-login-shot.png' }).catch(() => null);

  const deadline = Date.now() + MAX_MINUTES * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(3000);
    const info = await checkLoggedIn(page);
    const text = await pageText(page).catch(() => '');
    const state = `login=${info.ok} status=${info.status}`;
    if (state !== last || Date.now() % 30000 < 3000) {
      logger.info(`检测中: ${state}（等待你扫码…）`);
      last = state;
    }
    // 每 60 秒把窗口提到最前，防止被其它窗口盖住
    if (Date.now() % 60000 < 3000) await page.bringToFront().catch(() => null);
    if (info.ok) {
      // 再等 2 秒让 cookie 落盘
      await sleep(2000);
      logger.info(`✅ 登录成功（user_id=${info.id}），登录态已保存`);
      await ctx.close();
      process.exit(0);
    }
    // 说明：页面上的「新建任务」在未登录时也显示，不能用它判断，只认接口
  }

  clearInterval(shotTimer);
  logger.warn(`超过 ${MAX_MINUTES} 分钟仍未检测到登录，已退出`);
  await ctx.close().catch(() => null);
  process.exit(2);
}

main().catch(async (e) => {
  console.error(e.message);
  process.exit(1);
});
