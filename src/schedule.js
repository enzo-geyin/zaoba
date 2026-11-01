import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import platform from './platform.js';
import { readJSON, writeJSON } from './util.js';

const PROJECT_DIR = process.cwd();

export const LABEL = 'com.local.ai-daily-checkin';

/** 校验并规范化 HH:MM（允许 8:5 这种写法，统一补零） */
export function normalizeTime(input) {
  const m = String(input || '').trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** 读取原始 config.json（不合并默认值，避免把大量默认项写回去） */
export function readRawConfig() {
  const file = path.join(PROJECT_DIR, 'config.json');
  const raw = readJSON(file, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json 必须是 JSON 对象');
  return raw;
}

export function getSchedule() {
  const raw = readRawConfig();
  const s = raw.schedule || {};
  return {
    time: normalizeTime(s.time) || '08:00',
    retryTime: s.retryTime === '' || s.retryTime === null ? '' : normalizeTime(s.retryTime) || '12:30',
    randomDelayMinutes: Number.isFinite(Number(s.randomDelayMinutes)) ? Number(s.randomDelayMinutes) : 5,
  };
}

/** 保存时间设置到 config.json（其它字段原样保留） */
export function saveSchedule(patch) {
  const raw = readRawConfig();
  const next = { ...(raw.schedule || {}) };

  if (patch.time !== undefined) {
    const t = normalizeTime(patch.time);
    if (!t) throw new Error(`主跑时间格式不对：${patch.time}（应为 HH:MM，例如 08:30）`);
    next.time = t;
  }
  if (patch.retryTime !== undefined) {
    if (patch.retryTime === null || patch.retryTime === '') {
      next.retryTime = '';
    } else {
      const t = normalizeTime(patch.retryTime);
      if (!t) throw new Error(`补跑时间格式不对：${patch.retryTime}（应为 HH:MM）`);
      next.retryTime = t;
    }
  }
  if (patch.randomDelayMinutes !== undefined) {
    const d = Number(patch.randomDelayMinutes);
    if (!Number.isFinite(d) || d < 0 || d > 120) throw new Error('随机延迟需在 0~120 分钟之间');
    next.randomDelayMinutes = Math.round(d);
  }

  raw.schedule = next;
  writeJSON(path.join(PROJECT_DIR, 'config.json'), raw);
  return getSchedule();
}

/** 每日执行脚本（跨平台，Node 实现） */
export function dailyScriptPath() {
  return path.join(PROJECT_DIR, 'src', 'run-daily.js');
}

/**
 * 安装/更新系统定时任务。
 * macOS → launchd plist；Windows → schtasks 计划任务。
 */
export async function installSchedule({ logger } = {}) {
  const sched = getSchedule();
  const times = [...new Set([sched.time, sched.retryTime].filter(Boolean))];
  const res = await platform.installScheduler({
    label: LABEL,
    projectDir: PROJECT_DIR,
    scriptPath: dailyScriptPath(),
    times,
    logger,
  });
  return { ...sched, ...res };
}

/** 移除定时任务 */
export async function removeSchedule({ logger } = {}) {
  return platform.removeScheduler({ label: LABEL, logger });
}

/** 读取 launchd / 计划任务里实际生效的时间（用于校验，不读配置文件） */
export async function readEffectiveSchedule() {
  return platform.schedulerEffective({ label: LABEL });
}

/** 一站式：保存配置 + 安装定时任务 */
export async function applySchedule(patch, { logger, install = installSchedule, readEffective = readEffectiveSchedule } = {}) {
  const previous = readRawConfig();
  let written;
  try {
    if (patch) saveSchedule(patch);
    written = fs.readFileSync(path.join(PROJECT_DIR, 'config.json'), 'utf8');
    const res = await install({ logger });
    const effective = await readEffective();
    const expected = [...new Set([res.time, res.retryTime].filter(Boolean))].sort();
    if (JSON.stringify([...effective].sort()) !== JSON.stringify(expected)) throw new Error('系统任务回读与请求不一致，未确认生效');
    return { time: res.time, retryTime: res.retryTime, randomDelayMinutes: res.randomDelayMinutes, method: res.method };
  } catch (e) {
    // 不覆盖等待系统调用期间其它进程对配置的修改。
    if (written && fs.readFileSync(path.join(PROJECT_DIR, 'config.json'), 'utf8') === written) writeJSON(path.join(PROJECT_DIR, 'config.json'), previous);
    throw new Error(`定时设置未确认生效：${e.message}。请核对系统任务；未覆盖并发配置修改`, { cause: e });
  }
}

export { PROJECT_DIR };
