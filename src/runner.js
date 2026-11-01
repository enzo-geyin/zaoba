import path from 'node:path';
import { createHash } from 'node:crypto';
import { genericCheckin } from './adapters/index.js';
import { gotoSettled, pageText, detectLogin, dismissOverlays, findClickables, screenshot, dumpHTML, classifyOutcome } from './dom.js';
import { jitter, sleep, pruneOldDirs, today, nowISO } from './util.js';
import { TimeoutError, withDeadline, guardPage } from './runtime.js';
import { retainTaskLock } from './task-lock.js';
import { resolveAdapters } from './config.js';
import {
  writeReport,
  readResultsJSONL,
  appendResultJSONL,
  systemNotify,
  webhookNotify,
  oneLineSummary,
  detailLines,
  statusIcon,
} from './notify.js';

const SHOT_ROOT = path.resolve('data/shots');
const RESULT_FILE = path.resolve('data/results.jsonl');
const REPORT_DIR = path.resolve('data/reports');

/** 未提供明确账号/活动标签时不相信本地完成缓存，交由适配器只读查验。 */
export function completionScope(cfg, id) {
  const pc = cfg.platforms?.[id] || {};
  if (typeof pc.accountTag !== 'string' || !pc.accountTag.trim() || typeof pc.activityTag !== 'string' || !pc.activityTag.trim()) return null;
  return createHash('sha256').update(JSON.stringify([id, pc.accountTag, pc.activityTag, pc.businessDayHour ?? 0, cfg.timezone || 'Asia/Shanghai'])).digest('hex');
}

export function businessDate(cfg, id, date = new Date()) {
  const hour = cfg.platforms?.[id]?.businessDayHour ?? (id === 'qoder-cn' ? 10 : 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('businessDayHour 必须为 0~23 的整数');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const day = new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`);
  if (Number(values.hour) < hour) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/**
 * 今天是否已经全部签完。
 *
 * 为什么需要：launchd 在电脑休眠错过后会补跑，或者用户手动点了一次，
 * 没有这个判断就会对同一批平台重复点击。虽然大部分站点本身幂等，
 * 但重复请求只会增加风控暴露面，没必要。
 */
export function alreadyDoneToday(cfg, { only = [] } = {}) {
  const list = resolveAdapters(cfg, { only });
  const done = new Map();
  for (const r of readResultsJSONL(RESULT_FILE)) {
    const scope = completionScope(cfg, r.id);
    if (!scope || r.scope !== scope || r.date !== businessDate(cfg, r.id) || r.dryRun || !list.some((a) => a.id === r.id)) continue;
    if (r.status === 'success' || r.status === 'already') done.set(r.id, r);
  }
  const pending = list.filter((a) => !done.has(a.id));
  return { allDone: list.length > 0 && pending.length === 0, pending, doneCount: done.size, total: list.length };
}

/**
 * 离线预检：断网时不必逐个平台超时。
 * 早上机器刚唤醒时网络往往还没就绪，所以：多源探测 + 重试，避免误判离线。
 */
export async function isOnline({ attempts = 3, gapMs = 8000, fetchFn = fetch, wait = sleep } = {}) {
  const probes = ['https://www.baidu.com', 'https://www.aliyun.com', 'https://www.qq.com'];
  for (let i = 0; i < attempts; i++) {
    for (const url of probes) {
      try {
        const r = await fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
        if (r.status < 500) return true;
      } catch {
        /* 换下一个源 */
      }
    }
    if (i < attempts - 1) await wait(gapMs);
  }
  return false;
}

/** 演练：只检查登录态 + 能看到哪些候选按钮，不点击 */
async function dryRunOne(adapter, page, logger, cfg) {
  const url = (adapter.entryUrls && adapter.entryUrls[0]) || adapter.homepage;
  await gotoSettled(page, url, logger, { settle: cfg.settle || 1800 });
  const text = await pageText(page);
  const login = await detectLogin(page, text);
  const cands = await findClickables(page, adapter.keywords);
  const allButtons = await page
    .evaluate(() => {
      const out = [];
      const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();
      for (const el of document.querySelectorAll('button,[role="button"],a')) {
        const t = norm(el.textContent);
        if (t && t.length <= 20 && out.length < 40) out.push(t);
      }
      return [...new Set(out)];
    })
    .catch(() => []);

  if (login.needLogin) return { status: 'needs_login', detail: login.reason, url: page.url(), candidates: [] };
  if (cands.length) return { status: 'dry_run', detail: `可点击候选 ${cands.length} 个：${cands.map((c) => c.text).slice(0, 5).join(' / ')}`, url: page.url(), candidates: cands, buttons: allButtons };
  return { status: 'not_found', detail: `未发现关键词命中按钮；页面按钮：${allButtons.slice(0, 12).join(' / ') || '（无）'}`, url: page.url(), candidates: [], buttons: allButtons };
}

async function runOne(ctx, adapter, logger, cfg, opts) {
  const started = Date.now();
  const shotDir = path.join(SHOT_ROOT, today());
  const date = businessDate(cfg, adapter.id);
  let page;
  let result;

  try {
    if (adapter.unsupported) {
      // 直接标记跳过，但仍然走统一的记录/日志流程
      result = { status: 'unsupported', detail: '该平台暂无可自动化的签到入口' };
    } else if (adapter.standalone && typeof adapter.custom === 'function') {
      // standalone：不依赖网页，直接在适配器内部自己搞定（比如接管本机客户端）
      const timeout = adapter.timeout || cfg.platformTimeout || 180000;
      result = await withDeadline(
        (signal, onAbort) => adapter.custom({ page: null, ctx: null, logger, cfg, shotDir, shotName: adapter.id,
          dryRun: !!opts.dryRun, allowRestart: !!opts.allowRestart, signal, onAbort }),
        timeout, adapter.name, { cleanupGraceMs: cfg.cleanupGraceMs ?? 5000 },
      );
    } else {
      // 页面创建也纳入期限；创建太晚返回时立刻清理，不继续访问网站。
      const timeout = adapter.timeout || cfg.platformTimeout || 120000;
      result = await withDeadline(async (signal, onAbort) => {
        page = await ctx.newPage();
        onAbort(() => page.close());
        signal.throwIfAborted();
        const guarded = guardPage(page, signal);
        // 网页演练不调用领取型 custom；页面本身可能有自动登录积分等副作用。
        if (opts.dryRun) return dryRunOne(adapter, guarded, logger, cfg);
        return typeof adapter.custom === 'function'
          ? adapter.custom({ page: guarded, ctx: guardPage(ctx, signal), logger, cfg, shotDir, shotName: adapter.id, dryRun: false, signal, onAbort })
          : genericCheckin(adapter, guarded, guardPage(ctx, signal), logger, cfg);
      }, timeout, adapter.name, { cleanupGraceMs: cfg.cleanupGraceMs ?? 5000 });
    }
  } catch (e) {
    const msg = String(e.message || e).split('\n')[0];
    result = { status: e instanceof TimeoutError ? 'timeout' : 'error', detail: msg, fatal: e.fatal === true };
    if (result.fatal) retainTaskLock();
    logger.error(`${adapter.name} 异常: ${msg}`);
  }

  // 无论成败都留一张截图：这是排障的唯一一手现场
  let shot = null;
  if (!result.fatal && page && !page.isClosed()) {
    shot = await screenshot(page, shotDir, adapter.id);
    if (['not_found', 'error', 'timeout', 'uncertain'].includes(result.status)) {
      await dumpHTML(page, shotDir, adapter.id).catch(() => null);
    }
    await page.close().catch(() => null);
  }

  const record = {
    ts: nowISO(),
    date,
    id: adapter.id,
    scope: completionScope(cfg, adapter.id),
    name: adapter.name,
    status: result.status,
    detail: result.detail || '',
    url: result.url || '',
    meta: result.meta || undefined,
    candidates: result.candidates ? result.candidates.length : undefined,
    buttons: result.buttons,
    shot: shot ? path.relative(process.cwd(), shot) : null,
    durationMs: Date.now() - started,
    dryRun: !!opts.dryRun,
    fatal: result.fatal || undefined,
  };
  appendResultJSONL(RESULT_FILE, record);
  return record;
}

/**
 * 依次跑所有启用的平台。
 * 关键设计：平台之间串行 + 随机间隔，不要并发 —— 同一 IP 同时打多个站最容易吃风控。
 */
export async function runAll(ctx, cfg, opts = {}) {
  const { logger, only = [], dryRun = false } = opts;
  const list = opts.skipIfDone && !dryRun ? alreadyDoneToday(cfg, { only }).pending : resolveAdapters(cfg, { only });
  if (!list.length) {
    logger.info('没有待处理平台（未启用或今天已完成）');
    return [];
  }

  // 断网时所有平台都会失败（还会白等超时），先探一下
  if (!dryRun && !(await isOnline())) {
    // 通用探针失败并不能证明目标平台不可达，不阻断所有签到。
    logger.warn('通用联网探针失败，将逐平台尝试，不据此跳过全部平台');
  }

  logger.info(`共 ${list.length} 个平台待处理：${list.map((a) => a.name).join('、')}${dryRun ? '（演练模式）' : ''}`);
  const results = [];
  for (const [i, adapter] of list.entries()) {
    logger.info(`--- [${i + 1}/${list.length}] ${adapter.name} ---`);
    results.push(await runOne(ctx, adapter, logger, cfg, { dryRun, allowRestart: opts.allowRestart }));
    const r = results[results.length - 1];
    logger.info(`${statusIcon(r.status)} ${adapter.name}: ${r.status} ${r.detail ? '· ' + r.detail : ''}`);
    if (r.fatal) {
      logger.error('无法确认超时任务已安全退出，停止本轮剩余平台并保留任务锁；请人工确认');
      for (const remaining of list.slice(i + 1)) {
        const skipped = { ts: nowISO(), date: businessDate(cfg, remaining.id), id: remaining.id, name: remaining.name,
          scope: completionScope(cfg, remaining.id), status: 'skipped', detail: '前一平台超时清理未确认，本轮安全停止，未执行', dryRun };
        appendResultJSONL(RESULT_FILE, skipped);
        results.push(skipped);
      }
      break;
    }
    if (i < list.length - 1) {
      // 平台之间留 3~9 秒随机间隔
      await jitter(3000, 9000);
    }
  }

  if (!results.some((r) => r.fatal)) pruneOldDirs(SHOT_ROOT, cfg.screenshotKeepDays || 7);

  const date = today();
  const reportFile = writeReport(REPORT_DIR, date, results, { time: nowISO(), dryRun });
  logger.info(`日报: ${reportFile}`);

  if (results.some((r) => r.fatal)) return results;

  if (!dryRun && cfg.notify?.macos) {
    const ok = results.filter((r) => r.status === 'success' || r.status === 'already').length;
    const title = `AI 签到 ${ok}/${results.length} 成功`;
    const body = [oneLineSummary(results), detailLines(results)].filter(Boolean).join('\n');
    await systemNotify(title, body || '全部完成', { sound: cfg.notify.sound !== false });
  }

  if (!dryRun && cfg.notify?.webhookUrl) {
    await webhookNotify(cfg.notify.webhookUrl, {
      text: `【AI 每日签到】${nowISO()}\n${oneLineSummary(results)}\n\n${detailLines(results)}`,
      results,
    });
  }

  return results;
}

export { SHOT_ROOT, RESULT_FILE, REPORT_DIR };
