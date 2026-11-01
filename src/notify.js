import fs from 'node:fs';
import path from 'node:path';
import platform from './platform.js';

const ICON = {
  success: '✅',
  already: '✅',
  needs_login: '🔑',
  needs_manual: '🔧',
  not_installed: '⬜',
  offline: '📴',
  not_found: '❔',
  failed: '❌',
  uncertain: '⚠️',
  error: '❗',
  timeout: '⏱️',
  skipped: '➖',
  dry_run: '🧪',
};

export const statusIcon = (s) => ICON[s] || '•';

const esc = (s) => String(s).replace(/["\\\n\r]/g, (c) => ({ '"': '\\"', '\\': '\\\\', '\n': ' ', '\r': ' ' })[c]);

/** 系统通知：macOS 通知中心 / Windows 气泡通知（后台定时跑时也能弹） */
export async function systemNotify(title, message, { sound = true } = {}) {
  return platform.notify(title, message, { sound });
}

/** 兼容旧名字 */
export const macosNotify = systemNotify;

/** 可选的 webhook（飞书/钉钉/企业微信/Slack 之类），失败静默 */
export async function webhookNotify(url, payload) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 进程结束不等于全部成功；演练与真实领取使用不同的成功口径。 */
export function summarizeResults(results, { dryRun = false } = {}) {
  const completed = results.filter((r) => ['success', 'already', ...(dryRun ? ['dry_run'] : [])].includes(r.status)).length;
  const fatal = results.some((r) => r.fatal);
  return { total: results.length, completed, pending: results.length - completed, dryRun, fatal,
    code: fatal ? 3 : completed === results.length ? 0 : completed > 0 ? 2 : 1 };
}

/** 一行摘要，用于通知：✅通义 ✅Kimi 🔑豆包 */
export function oneLineSummary(results) {
  return results.map((r) => `${statusIcon(r.status)}${r.name}`).join(' ');
}

export function detailLines(results) {
  return results
    .filter((r) => r.status !== 'already' && r.status !== 'success')
    .map((r) => `${statusIcon(r.status)} ${r.name}: ${r.detail}${r.url ? ` (${r.url})` : ''}`)
    .join('\n');
}

/** 写 Markdown 日报，追加到 data/reports/YYYY-MM-DD.md */
export function writeReport(reportDir, date, results, meta = {}) {
  fs.mkdirSync(reportDir, { recursive: true });
  const file = path.join(reportDir, `${date}.md`);
  const okCount = results.filter((r) => r.status === 'success' || r.status === 'already').length;

  const rows = results
    .map((r) => `| ${r.name} | ${statusIcon(r.status)} ${r.status} | ${String(r.detail || '').replace(/\|/g, '/').replace(/\n/g, ' ')} | ${r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : '-'} |`)
    .join('\n');

  const block = [
    `## ${meta.time || ''} 运行结果`,
    '',
    `**成功 ${okCount}/${results.length}**${meta.dryRun ? '（演练模式，未真实点击）' : ''}`,
    '',
    '| 平台 | 状态 | 说明 | 耗时 |',
    '| --- | --- | --- | --- |',
    rows,
    '',
  ].join('\n');

  const header = fs.existsSync(file) ? '' : `# AI 每日签到日报 · ${date}\n`;
  fs.appendFileSync(file, `${header}\n${block}\n`, 'utf8');
  return file;
}

/** 结构化结果留档，report 命令和后续排障都靠它 */
export function appendResultJSONL(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

export function readResultsJSONL(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
