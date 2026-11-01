import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let retainLock = false;
export function retainTaskLock() { retainLock = true; }
export function isTaskLockRetained() { return retainLock; }

/** 所有签到、登录和探测入口共享。异常遗留锁不自动删除，避免误伤仍在运行的任务。 */
export function acquireTaskLock(root = process.cwd()) {
  const file = path.join(root, 'data', '.task.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Error(`已有签到/登录任务或遗留锁：${file}。请先确认原任务已结束；不会自动清除锁或重启客户端`);
  }
  const release = () => {
    if (retainLock) return;
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
    } catch { /* 锁已被外部改动时不处理 */ }
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}
