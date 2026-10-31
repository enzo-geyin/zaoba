import fs from 'node:fs';
import { chromium } from 'playwright';
import path from 'node:path';
import { ensureDir } from './util.js';
import platform from './platform.js';

/**
 * 持久化上下文（persistent context）。
 *
 * 这是整个工具"只登录一次，之后长期自动跑"的关键：
 * Cookie / localStorage / IndexedDB 全部落在 profile 目录里，
 * 下次 launch 直接复用，所以定时任务不需要再登录。
 */
export async function launchContext(cfg, { headless, logger } = {}) {
  const userDataDir = ensureDir(path.resolve(cfg.userDataDir));
  const wantHeadless = headless ?? cfg.headless;

  const opts = {
    headless: wantHeadless,
    locale: cfg.locale || 'zh-CN',
    timezoneId: cfg.timezone || 'Asia/Shanghai',
    viewport: cfg.viewport || { width: 1440, height: 900 },
    // 降低被判定为自动化的概率（只是减少明显特征，不保证绕过风控）
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  // channel: 'chrome' 时用本机真实 Chrome，指纹更干净（前提是已安装 Chrome）
  // headless 时用 Chromium 的"新 headless"模式（channel: 'chromium'）：
  // 旧 headless shell 的 UA/指纹特征明显，更容易被判定为爬虫。
  // Windows 首次运行（还没有 profile）时，优先用系统 Edge，省掉 570MB 内核下载
  let channel = cfg.channel;
  if (!channel && platform.isWindows && !fs.existsSync(userDataDir)) {
    const edge = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (edge) channel = 'msedge';
  }

  if (channel) opts.channel = channel;
  else if (wantHeadless) opts.channel = 'chromium';

  if (logger) logger.info(`启动浏览器 headless=${wantHeadless} channel=${opts.channel || 'chromium-headless-shell'} profile=${userDataDir}`);

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, opts);
  } catch (e) {
    // 新 headless 通道不可用时退回默认（需要 chromium-headless-shell）
    if (opts.channel === 'chromium' && !cfg.channel) {
      if (logger) logger.warn(`新 headless 模式启动失败，回退默认模式: ${String(e.message).split('\n')[0]}`);
      delete opts.channel;
      ctx = await chromium.launchPersistentContext(userDataDir, opts);
    } else {
      throw e;
    }
  }

  // 抹掉 navigator.webdriver（很多站点用它做第一层判断）
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {
      /* ignore */
    }
  });

  // 统一超时，避免卡在某个慢接口上导致整个定时任务挂住
  ctx.setDefaultTimeout(cfg.actionTimeout || 15000);
  ctx.setDefaultNavigationTimeout(cfg.navTimeout || 45000);

  if (logger) {
    ctx.on('close', () => logger.warn('浏览器上下文已关闭'));
  }
  return ctx;
}
