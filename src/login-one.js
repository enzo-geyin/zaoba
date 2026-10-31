#!/usr/bin/env node
/**
 * 单个平台登录助手（给网页控制台的「去登录」按钮调用）。
 *
 * 用法：node src/login-one.js <platformId>
 * 行为：弹出可见浏览器 → 你扫码/输手机号 → 检测到登录成功 → 自动保存登录态并退出
 *
 * 退出码：0 成功 / 2 超时 / 3 该平台需要客户端登录（不能走网页） / 1 出错
 */
import { launchContext } from './browser.js';
import { loadConfig, resolveAdapters } from './config.js';
import { pageText } from './dom.js';
import { createLogger } from './logger.js';
import { sleep } from './util.js';
import { acquireTaskLock } from './task-lock.js';
acquireTaskLock();

const MAX_MINUTES = 10;
const logger = createLogger('login');

/** 各平台"登录成功"的判定方式 */
const DETECT = {
  minimax: async (page) => {
    const text = await pageText(page).catch(() => '');
    const loginForm = /微信扫码登录|获取验证码|请输入您的手机号/.test(text);
    const logged = /每日签到|签到得|MiniMax\d+/.test(text);
    return { ok: !loginForm && logged, why: loginForm ? 'login-form' : logged ? 'user-ui' : 'unknown' };
  },
  zhipu: async (page, ctx) => {
    const cookies = await ctx.cookies('https://chatglm.cn').catch(() => []);
    const token = cookies.find((c) => c.name === 'chatglm_token' && c.value);
    return { ok: Boolean(token), why: token ? 'cookie' : 'no-cookie' };
  },
};

async function detectDefault(page) {
  const text = await pageText(page).catch(() => '');
  const stillLogin = /扫码登录|短信验证码|验证码登录|请输入手机号|请先登录/.test(text);
  return { ok: !stillLogin, why: stillLogin ? 'login-form' : 'no-login-text' };
}

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('用法: node src/login-one.js <platformId>');
    process.exit(1);
  }

  const cfg = loadConfig();
  const list = resolveAdapters(cfg, { includeDisabled: true, only: [id] });
  const adapter = list[0];
  if (!adapter) {
    console.error(`找不到平台: ${id}`);
    process.exit(1);
  }

  // 显式 type 优先：MiniMax 虽然是 standalone（自己开浏览器），但它属于网页类
  const pc = cfg.platforms[id] || {};
  const explicitType = pc.type;
  const isClient =
    explicitType === 'client' ||
    (explicitType !== 'web' && (adapter.clientApp || pc.app || id === 'workbuddy'));
  if (isClient) {
    console.log(`CLIENT:${adapter.name}`);
    process.exit(3);
  }

  const url = adapter.loginUrl || adapter.homepage;
  if (!url) {
    console.error('该平台没有配置登录地址');
    process.exit(1);
  }

  const ctx = await launchContext(cfg, { headless: false, logger });
  const page = await ctx.newPage();
  logger.info(`打开 ${adapter.name} 登录页: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.bringToFront().catch(() => null);

    // 尽量自动点开登录弹窗
    for (const sel of ['button:has-text("登录")', 'button:has-text("登录 / 注册")', 'text=登录']) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 1500 })) {
          await loc.click({ timeout: 4000 });
          logger.info('已尝试打开登录弹窗，请扫码或输入手机号');
          break;
        }
      } catch {
        /* 换下一个 */
      }
    }

    const detector = DETECT[id] || detectDefault;
    const deadline = Date.now() + MAX_MINUTES * 60 * 1000;
    let lastWhy = '';
    while (Date.now() < deadline) {
      await sleep(2500);
      const r = await detector(page, ctx).catch(() => ({ ok: false, why: 'err' }));
      if (r.ok) {
        await sleep(1500); // 让 cookie 落盘
        logger.info(`✅ ${adapter.name} 登录成功，登录态已保存`);
        await ctx.close();
        process.exit(0);
      }
      if (r.why !== lastWhy) {
        logger.info(`等待登录中（${r.why}）…`);
        lastWhy = r.why;
      }
    }

    logger.warn(`${MAX_MINUTES} 分钟内未检测到登录成功`);
    await ctx.close().catch(() => null);
    process.exit(2);
  } catch (e) {
    logger.error(`登录过程出错: ${e.message}`);
    await ctx.close().catch(() => null);
    process.exit(1);
  }
}

main();
