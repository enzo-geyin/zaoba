import path from 'node:path';
import fs from 'node:fs';
import { ensureDir, jitter, norm, sleep } from './util.js';

/** 页面可见文本快照，用来判断"点了之后界面有没有变化" */
export async function pageText(page, limit = 20000) {
  try {
    const t = await page.evaluate(() => document.body?.innerText || '');
    return t.slice(0, limit);
  } catch {
    return '';
  }
}

const LOGIN_URL_RE = /(login|signin|sign-in|passport|sso|oauth|authorize|account\/login)/i;
const LOGIN_TEXT_RE =
  /(扫码登录|登录后|请先登录|手机号登录|验证码登录|账号登录|立即登录|登录\/注册|登录或注册|登录以同步|登录以使用|登录以查看|未登录)/;
/** 已登录的强信号：出现任意一个就说明"登录"字样只是普通链接 */
const LOGGED_IN_RE = /(退出登录|切换账号|个人中心|我的主页|账户设置|头像)/;
const LOGIN_BUTTON_TEXTS = ['登录', '立即登录', '登录/注册', '登录或注册', '扫码登录', '登录以同步历史会话', '登录以使用'];

/**
 * 判断是不是被踢回登录页了。
 *
 * 这是"每天自动跑"最容易失败的地方：登录态过期 → 脚本点不到签到 → 静默失败。
 * 所以三级判断：URL 跳到登录页 > 文本里有明确登录提示 > 页面上有登录入口按钮且无已登录标志。
 */
export function looksLikeLoginWall(url, text) {
  const t = norm(text);
  if (LOGIN_URL_RE.test(url)) return { needLogin: true, reason: `URL 跳转到登录页: ${url}` };
  if (LOGIN_TEXT_RE.test(t)) return { needLogin: true, reason: '页面出现登录/扫码提示' };
  return { needLogin: false, reason: '' };
}

/** 异步版：多一步 DOM 检查"页面上有没有『登录』入口按钮" */
export async function detectLogin(page, text) {
  const quick = looksLikeLoginWall(page.url(), text);
  if (quick.needLogin) return quick;

  const t = norm(text);
  if (LOGGED_IN_RE.test(t)) return { needLogin: false, reason: '' };

  const hit = await page
    .evaluate(
      ({ texts }) =>
        (() => {
          const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
          for (const el of document.querySelectorAll('*')) {
            const tt = norm(el.textContent);
            if (!texts.includes(tt)) continue;
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) continue;
            return tt;
          }
          return null;
        })(),
      { texts: LOGIN_BUTTON_TEXTS },
    )
    .catch(() => null);

  if (hit) return { needLogin: true, reason: `页面上只有「${hit}」入口，判定为未登录` };
  return { needLogin: false, reason: '' };
}

/**
 * 找出页面上"像签到按钮"的可点击元素。
 *
 * 为什么不用 Playwright 的 getByText：签到按钮文案千变万化（签到/立即签到/打卡/
 * 领取/领算力/每日签到…），而且同一段文字往往嵌了 3~4 层 div。这里直接在页面里
 * 枚举元素，按"文案命中 + 可见 + 尺寸合理 + 只取最深节点"筛，最后返回坐标，
 * 由外层用真实鼠标点击（比 el.click() 更容易被前端框架正确响应）。
 */
export async function findClickables(page, keywords, { maxTextLen = 14 } = {}) {
  const kw = keywords.map(norm).filter(Boolean);
  if (!kw.length) return [];

  return page.evaluate(
    ({ kw, maxTextLen }) => {
      const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
      const hits = [];

      const isVisible = (el) => {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
        if (parseFloat(st.opacity || '1') < 0.15) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 8 && r.height >= 8;
      };

      const nodes = document.querySelectorAll('button,a,[role="button"],[role="link"],div,span,li,label,p,strong,em,b,section,article,img,svg');
      for (const el of nodes) {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;

        let text = norm(el.textContent);
        if (!text && el.getAttribute) {
          text = norm(el.getAttribute('aria-label') || el.getAttribute('title') || '');
        }
        if (!text || text.length > maxTextLen) continue;
        if (!kw.some((k) => text.includes(k))) continue;
        if (!isVisible(el)) continue;

        hits.push({ el, text, tag, cls: typeof el.className === 'string' ? el.className : '' });
      }

      // 只保留最深的节点：如果某个命中元素的祖先也命中，丢掉祖先
      const set = new Set(hits.map((h) => h.el));
      const deepest = hits.filter((h) => {
        let p = h.el.parentElement;
        while (p) {
          if (set.has(p)) return false;
          p = p.parentElement;
        }
        return true;
      });

      // 计算点击坐标（先滚动到视口中间，避免被固定头部/底部遮挡）
      const out = [];
      for (const h of deepest.slice(0, 12)) {
        try {
          h.el.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {
          /* ignore */
        }
        const r = h.el.getBoundingClientRect();
        out.push({
          text: h.text,
          tag: h.tag,
          cls: h.cls.slice(0, 120),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
      return out;
    },
    { kw, maxTextLen },
  );
}

/** 成功证据必须明确；点击后的判断只接受相对点击前新增的信号，冲突时失败优先。 */
export function classifyOutcome(text, { before } = {}) {
  const t = norm(text);
  const previous = before === undefined ? null : norm(before);
  const fresh = (pattern) => {
    const hits = t.match(pattern) || [];
    const old = previous === null ? [] : previous.match(pattern) || [];
    return hits.some((hit) => hits.filter((x) => x === hit).length > old.filter((x) => x === hit).length);
  };
  const fail = /(签到失败|领取失败|操作失败|系统繁忙|请稍后|网络异常|重复签到|已经领过)/.test(t);
  const already = !fail && fresh(/今日已签到|今日已签|今天已领|今日已领|明天再来|明日再来|今日签到已完成/g);
  const success = !fail && fresh(/签到成功|领取成功|签到完成|领取完成/g);
  return { already, success, fail };
}

/** 截当前页面全图存盘，返回相对路径 */
export async function screenshot(page, dir, name) {
  ensureDir(dir);
  const file = path.join(dir, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

/** 保存 HTML 快照，选择器对不上时用它离线分析 */
export async function dumpHTML(page, dir, name) {
  ensureDir(dir);
  const file = path.join(dir, `${name}.html`);
  try {
    const html = await page.content();
    fs.writeFileSync(file, html, 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * 核心动作：按关键词找按钮 → 鼠标点击 → 判断结果。
 * 返回 { clicked, text, outcome, tried }
 */
export async function clickByKeywords(page, keywords, logger, { label = '' } = {}) {
  const candidates = await findClickables(page, keywords);
  if (logger) {
    logger.step(`${label} 候选元素 ${candidates.length} 个${candidates.length ? '：' + candidates.map((c) => c.text).slice(0, 6).join(' / ') : ''}`);
  }

  const tried = [];
  for (const c of candidates.slice(0, 4)) {
    const before = await pageText(page, 4000);
    tried.push(c.text);
    try {
      await page.mouse.click(c.x, c.y);
    } catch {
      // 坐标点击失败（元素被移除/遮挡），退化为 DOM click
      try {
        await page.evaluate(
          ({ text }) => {
            const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
            const nodes = document.querySelectorAll('button,a,[role="button"],div,span');
            for (const el of nodes) {
              if (norm(el.textContent) === text) {
                el.click();
                return true;
              }
            }
            return false;
          },
          { text: c.text },
        );
      } catch {
        /* ignore */
      }
    }

    await sleep(1200 + Math.random() * 800);
    const after = await pageText(page, 4000);
    const outcome = classifyOutcome(after, { before });
    const changed = after !== before;

    // 已经尝试提交但没有明确证据时交给上层报告待确认，不盲点第二个候选重复提交。
    return { clicked: true, text: c.text, outcome, changed };
  }

  // 主框架没找到时，尝试 iframe 内的文本
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    for (const k of keywords) {
      try {
        const loc = frame.getByText(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).first();
        if (await loc.isVisible({ timeout: 800 })) {
          const before = await pageText(page, 4000);
          await loc.click({ timeout: 3000 });
          await sleep(1200);
          const after = await pageText(page, 4000);
          return { clicked: true, text: `[iframe] ${k}`, outcome: classifyOutcome(after, { before }), changed: after !== before };
        }
      } catch {
        /* 继续找 */
      }
    }
  }

  return { clicked: false, text: null, outcome: { already: false, success: false, fail: false }, changed: false, tried };
}

/** 打开页面并等到基本可交互（domcontentloaded + 少量 settle） */
export async function gotoSettled(page, url, logger, { settle = 1500 } = {}) {
  if (logger) logger.info(`打开 ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(settle + Math.random() * 800);
  // domcontentloaded 之后 SPA 还要拉数据，尽力等 networkidle，但不等死
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch {
    /* 有长轮询站点永远不 idle，忽略 */
  }
  await jitter(600, 1400);
  return page;
}

/**
 * 关掉挡路的弹窗/遮罩。
 *
 * 实战里最常见的两类"假故障"：
 *   1. 隐私协议/活动公告弹窗盖住页面 → 找不到签到按钮
 *   2. 全屏遮罩让鼠标点击落在遮罩上 → 点了没反应
 * 智谱的"双节返还积分到账"就是这么把签到按钮挡住的。
 */
const OVERLAY_TEXTS = ['我知道了', '知道了', '我已知晓', '同意并继续', '我同意', '同意', '接受', '关闭', '稍后再说', '暂不', '跳过', '取消'];

export async function dismissOverlays(page, logger, { maxClicks = 2 } = {}) {
  let clicked = 0;
  for (let i = 0; i < maxClicks; i++) {
    const cands = await findClickables(page, OVERLAY_TEXTS, { maxTextLen: 8 });
    if (!cands.length) break;
    const c = cands[0];
    // "取消/暂不"排在最后，避免误点掉真正的操作
    try {
      await page.mouse.click(c.x, c.y);
      clicked++;
      if (logger) logger.step(`关闭弹窗: 「${c.text}」`);
      await sleep(800);
    } catch {
      break;
    }
  }
  return clicked;
}
