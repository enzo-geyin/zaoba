import { defineAdapter } from './base.js';
import { pageText, screenshot, dumpHTML } from '../dom.js';
import { sleep } from '../util.js';

/**
 * MiniMax Code（agent.minimax.cn）每日签到。
 *
 * 调研结论（2026-10，官方文档 + 前端 bundle 双向确认）：
 *   - 签到在网页版：agent.minimax.cn，需要登录（手机号/扫码）
 *   - 每日 400 积分；连续第 4、7 天单日 1000；一周约 4000
 *   - 入口层级：「每日签到」菜单项 → 弹出签到面板 → 点「签到 / 签到得 N 积分」
 *   - 已签状态文案：「今日已签到」；成功文案：「签到成功 +N 积分」
 *   - 积分自到账 30 天内有效
 *
 * 因为签到入口藏在账户菜单里，流程是：
 *   打开首页 → 判断登录 → 点开头像/账户 → 找「每日签到」→ 点签到按钮 → 用文案判断结果
 */

const HOME = 'https://agent.minimax.cn/';

const ACCOUNT_TRIGGERS = [
  '[class*="avatar"]',
  '[class*="Avatar"]',
  '[class*="user-info"]',
  '[class*="userInfo"]',
  '[class*="account"]',
  '[class*="profile"]',
  'button[class*="user"]',
];

const SIGNIN_ENTRY_TEXTS = ['每日签到', '签到'];
const CLAIM_BUTTON_PATTERN = /^(签到|立即签到|签到得)/;
const DONE_TEXTS = ['今日已签到', '已签到', '明天再来'];
const SUCCESS_TEXTS = ['签到成功', '领取成功'];

async function clickFirstVisibleText(page, texts, { logger, maxLen = 20 } = {}) {
  for (const t of texts) {
    try {
      const loc = page.locator(`text=${t}`).filter({ visible: true }).first();
      const n = await page.locator(`text=${t}`).count();
      if (!n) continue;
      const el = page.locator(`text=${t}`).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click({ timeout: 4000 });
        logger?.step(`点击文本「${t}」`);
        return true;
      }
    } catch {
      /* 换下一个 */
    }
  }
  return false;
}

async function clickAccountEntry(page, logger) {
  for (const sel of ACCOUNT_TRIGGERS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 800 })) {
        await loc.click({ timeout: 4000 });
        logger?.step(`点开账户入口: ${sel}`);
        await sleep(1200);
        return true;
      }
    } catch {
      /* 换下一个 */
    }
  }
  // 兜底：找页面上含用户名的按钮
  try {
    const btn = page.locator('button:has-text("积分")').first();
    if (await btn.isVisible({ timeout: 800 })) {
      await btn.click({ timeout: 4000 });
      logger?.step('点开账户入口（积分按钮兜底）');
      await sleep(1200);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function openAccountMenu(page, logger) {
  try {
    const pos = await page.evaluate(() => {
      const h = window.innerHeight;
      for (const el of document.querySelectorAll('div,button,[role="button"]')) {
        const t = (el.textContent || '').trim();
        if (!/^(MiniMax\d{3,}|用户\d{3,}|MiniMax|用户)$/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 18) continue;
        if (r.y < h * 0.8) continue; // 只认左下角
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t };
      }
      return null;
    });
    if (!pos) return false;
    await page.mouse.click(pos.x, pos.y);
    logger?.step(`点开账户菜单（${pos.text}）`);
    await sleep(1500);
    return true;
  } catch {
    return false;
  }
}

async function runMinimax({ page, logger, cfg, shotDir, shotName, dryRun }) {
  if (!page) throw new Error('MiniMax 适配器需要 runner 提供的页面');
  try {
    logger?.step(`打开 ${HOME}`);
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null);
    await sleep(3000);

    // 登录判断：只看登录弹窗/表单特征（页面其它地方可能本来就有"登录"字样）
    let text = await pageText(page);
    const loginWall = /微信扫码登录|获取验证码|请输入您的手机号/.test(text);
    if (loginWall) {
      await screenshot(page, shotDir, `${shotName}-login`).catch(() => null);
      return { status: 'needs_login', detail: 'MiniMax Code 未登录，运行 npm run login:minimax 扫码登录一次' };
    }

    // 签到面板只在"今天还没签"时出现在首页左下角；签过之后就没有了。
    // 所以三步走：①等面板；②没有面板就点账户菜单→每日签到，看弹窗状态；③两者都没有才判 not_found
    let hasPanel = false;
    for (let i = 0; i < 8; i++) {
      text = await pageText(page);
      if (text.includes('签到得')) {
        hasPanel = true;
        break;
      }
      if (DONE_TEXTS.some((k) => text.includes(k))) break;
      await sleep(1500);
    }

    if (!hasPanel) {
      // 从账户菜单进「每日签到」弹窗，确认是否已签
      logger?.step('首页没有签到面板，改从账户菜单进入');
      const openedMenu = await openAccountMenu(page, logger);
      if (openedMenu) {
        await clickFirstVisibleText(page, ['每日签到'], { logger });
        await sleep(2500);
      }
      text = await pageText(page);

      const doneInDialog = DONE_TEXTS.find((k) => text.includes(k));
      if (doneInDialog) {
        await screenshot(page, shotDir, shotName).catch(() => null);
        return { status: 'already', detail: `签到弹窗显示「${doneInDialog}」，今天已完成` };
      }
      if (!text.includes('签到得')) {
        await dumpHTML(page, shotDir, `${shotName}-nofound`).catch(() => null);
        await screenshot(page, shotDir, `${shotName}-nofound`).catch(() => null);
        return { status: 'not_found', detail: '没找到「每日签到」入口（界面可能改版，用 npm run probe -- --only=minimax 看实际文案）' };
      }
    }

    if (dryRun) {
      await screenshot(page, shotDir, `${shotName}-dryrun`).catch(() => null);
      return { status: 'dry_run', detail: '演练模式：已找到「每日签到」入口，未点击' };
    }

    // 点签到按钮（按钮文案形如「签到得 400」）
    const beforeClaim = text;
    let claimed = false;
    try {
      const btn = page.getByRole('button', { name: CLAIM_BUTTON_PATTERN }).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click({ timeout: 6000 });
        claimed = true;
        logger?.step('已点击「签到得 N」按钮');
      }
    } catch {
      /* 退回文本匹配 */
    }
    if (!claimed) {
      claimed = await clickFirstVisibleText(page, ['签到得'], { logger });
    }

    await sleep(2500);
    text = await pageText(page);
    await screenshot(page, shotDir, shotName).catch(() => null);

    const failed = /签到失败|领取失败|网络异常|系统繁忙/.test(text);
    const success = !failed && SUCCESS_TEXTS.find((k) => text.includes(k) && !beforeClaim.includes(k));
    const doneAfter = !failed && DONE_TEXTS.find((k) => text.includes(k) && !beforeClaim.includes(k));
    const points = (() => {
      const m = text.match(/\+(\d{2,5})\s*积分/);
      return m ? Number(m[1]) : null;
    })();

    if (success || doneAfter) {
      // 区分「本次点击成功」与「本来就已经签过」
      const ok = Boolean(success) || claimed;
      return {
        status: ok ? 'success' : 'already',
        detail: points ? `签到成功，+${points} 积分` : ok ? '签到成功（页面已显示今日已签到）' : `页面显示「${doneAfter}」`,
        meta: points ? { todayPoints: points } : undefined,
      };
    }

    if (!claimed) {
      return { status: 'not_found', detail: '找到了签到入口但没找到可点的签到按钮' };
    }
    return { status: 'uncertain', detail: '点了签到，但页面上没看到明确的成功/已签文案' };
  } finally {
    // 不要关闭 runner 的浏览器上下文，只关自己这个标签页
    await page.close().catch(() => null);
  }
}

export default defineAdapter({
  id: 'minimax',
  name: 'MiniMax Code',
  standalone: false, // 复用 runner 的浏览器（同一个 profile 不能被两个实例占用）
  enabledByDefault: false,
  homepage: HOME,
  loginUrl: HOME,
  timeout: 180000,
  keywords: ['每日签到', '签到'],
  doneKeywords: DONE_TEXTS,
  notes: '网页版每日签到（+400 积分，第 4/7 天 1000）；入口在账户菜单的「每日签到」，需要先 npm run login 登录一次',
  custom: runMinimax,
});
