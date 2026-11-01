#!/usr/bin/env node
/**
 * 每日执行入口（跨平台）。
 *
 * macOS: 由 launchd 调用（src/schedule.js 安装 plist 指向本文件）
 * Windows: 由计划任务（schtasks）调用
 *
 * 职责：单实例锁 → 随机延迟 → 执行签到 → 写日志 → 返回退出码
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isWindows } from './platform.js';
import { fileURLToPath } from 'node:url';
import { readJSON } from './util.js';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
process.chdir(PROJECT_DIR);
const LOG_DIR = path.join(PROJECT_DIR, 'data', 'log');
const LOG_FILE = path.join(LOG_DIR, 'launchd.log');
const LOCK_DIR = path.join(PROJECT_DIR, 'data', '.run.lock');

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function log(msg) {
  const line = `${stamp()} [run-daily] ${msg}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
  console.log(line);
}

function readConfig() {
  return readJSON(path.join(PROJECT_DIR, 'config.json'), {});
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: false });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

function releaseLock() {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!acquireLock()) {
    log(`已有日跑实例或遗留锁，本次停止；请确认原任务结束后处理 ${LOCK_DIR}`);
    return 1;
  }

  try {
    const cfg = readConfig();
    const delayMin = process.env.CHECKIN_NO_DELAY === '1' ? 0 : Number(cfg?.schedule?.randomDelayMinutes ?? 0);
    if (delayMin > 0) {
      const waitMs = Math.floor(Math.random() * delayMin * 60 * 1000);
      log(`随机等待 ${Math.round(waitMs / 1000)}s 后开始（上限 ${delayMin} 分钟）`);
      await sleep(waitMs);
    }

    log(`开始执行签到（${isWindows ? 'Windows' : 'macOS'}）`);
    const code = await new Promise((resolve) => {
      const args = [path.join(PROJECT_DIR, 'src', 'index.js'), 'run', '--skip-if-done', '--quiet'];
      if (process.env.CHECKIN_DRY_RUN === '1' || process.argv.includes('--dry-run')) args.push('--dry-run');
      if (process.env.CHECKIN_ONLY) args.push(`--only=${process.env.CHECKIN_ONLY}`);
      const child = spawn(process.execPath, args, {
        cwd: PROJECT_DIR,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (b) => process.stdout.write(b));
      child.stderr.on('data', (b) => process.stderr.write(b));
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', (e) => {
        log(`启动失败: ${e.message}`);
        resolve(1);
      });
    });
    log(`结束，退出码 ${code}`);
    return code;
  } finally {
    releaseLock();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`未捕获异常: ${e?.message || e}`);
    process.exit(1);
  });
