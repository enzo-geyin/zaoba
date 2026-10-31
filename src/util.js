import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 随机抖动：同一时刻并发请求容易触发风控，每次动作之间加随机间隔 */
export const jitter = (min = 800, max = 2600) => sleep(min + Math.random() * (max - min));

export const norm = (s) => (s || '').replace(/[\s\u3000]+/g, '').trim();

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 本地日期字符串 YYYY-MM-DD（用本机时区，避免 UTC 跨天算错） */
export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nowISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${today(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function safeName(s) {
  return String(s).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_');
}

/** 读取 JSON，文件不存在返回 fallback */
export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`无法读取 JSON 配置 ${file}: ${e.message}`, { cause: e });
  }
}

export function writeJSON(file, obj) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/** 只保留最近 n 天的子目录（data/shots/2026-10-01/...） */
export function pruneOldDirs(root, keepDays = 7) {
  if (!fs.existsSync(root)) return;
  const cutoff = Date.now() - keepDays * 86400_000;
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    try {
      if (fs.statSync(full).isDirectory() && fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      /* 删除失败不影响主流程 */
    }
  }
}
