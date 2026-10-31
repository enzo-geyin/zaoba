import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// 所有配置/日志只进入新建的隔离目录，不使用用户 profile 或安装目录。
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zaoba-regression-'));
process.chdir(scratch);
const load = (name) => import(pathToFileURL(path.join(root, 'src', name)));
const { defaultConfig, loadConfig } = await load('config.js');
const { adapters } = await load('adapters/index.js');
const { saveSchedule, getSchedule } = await load('schedule.js');
const { readJSON, writeJSON, today } = await load('util.js');
const { isOnline, alreadyDoneToday, runAll } = await load('runner.js');
const { acquireTaskLock } = await load('task-lock.js');
const { withDeadline, abortableSleep, guardPage, TimeoutError } = await load('runtime.js');
const { runClientApp } = await load('adapters/clientApp.js');
const { default: workbuddy } = await load('adapters/workbuddy.js');
const { buildState, reportPath, startServer } = await load('server.js');
const platform = (await load('platform.js')).default;
const logger = { info() {}, warn() {}, error() {}, step() {}, ok() {} };

test('关闭补跑后保持关闭，其它配置不变', () => {
  writeJSON(path.join(scratch, 'config.json'), { channel: 'chrome', schedule: { retryTime: '12:30' } });
  saveSchedule({ retryTime: '' });
  assert.equal(getSchedule().retryTime, '');
  assert.equal(readJSON(path.join(scratch, 'config.json')).channel, 'chrome');
});

test('损坏配置必须报错，不能被调度保存覆盖', () => {
  const file = path.join(scratch, 'config.json');
  fs.writeFileSync(file, '{broken-json');
  assert.throws(() => saveSchedule({ time: '09:00' }), /无法读取 JSON/);
  assert.throws(() => loadConfig(), /无法读取 JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken-json');
  writeJSON(file, defaultConfig());
});

test('离线探测完成有限重试，不出现 sleep 未定义错误', async () => {
  let requests = 0;
  let waits = 0;
  assert.equal(await isOnline({ attempts: 2, fetchFn: async () => { requests++; throw new Error('offline'); }, wait: async () => { waits++; } }), false);
  assert.equal(requests, 6);
  assert.equal(waits, 1);
});

test('共享任务锁拒绝第二入口，释放后可重新获取', () => {
  const release = acquireTaskLock(scratch);
  assert.throws(() => acquireTaskLock(scratch), /已有签到/);
  release();
  acquireTaskLock(scratch)();
});

test('超时中止后续动作并等待清理完成', async () => {
  let clicked = false;
  let cleaned = false;
  await assert.rejects(withDeadline(async (signal, onAbort) => {
    onAbort(async () => { cleaned = true; });
    await abortableSleep(200, signal);
    signal.throwIfAborted();
    clicked = true;
  }, 5, 'mock'), TimeoutError);
  assert.equal(clicked, false);
  assert.equal(cleaned, true);
});

test('取消后不能再调用页面、鼠标或定位器', () => {
  const controller = new AbortController();
  let calls = 0;
  const page = guardPage({ mouse: { click() { calls++; } }, locator() { return { click() { calls++; } }; } }, controller.signal);
  const locator = page.locator('button');
  controller.abort();
  assert.throws(() => page.mouse.click(0, 0));
  assert.throws(() => locator.click());
  assert.equal(calls, 0);
});

test('演练不启动或重启客户端，即使旧配置 autoRestart=true', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no CDP'); });
  t.mock.method(platform, 'isProcessRunning', async () => true);
  const quit = t.mock.method(platform, 'gracefulQuit', async () => { throw new Error('must not quit'); });
  const result = await runClientApp({ app: process.execPath, autoRestart: true }, { logger, dryRun: true });
  assert.equal(result.status, 'needs_manual');
  assert.equal(quit.mock.callCount(), 0);
});

test('正式重启需本次允许，正常退出失败则停止，不强杀', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no CDP'); });
  t.mock.method(platform, 'isProcessRunning', async () => true);
  const quit = t.mock.method(platform, 'gracefulQuit', async () => false);
  const pc = { app: process.execPath, autoRestart: true };
  assert.equal((await runClientApp(pc, { logger })).status, 'needs_manual');
  assert.equal(quit.mock.callCount(), 0);
  assert.equal((await runClientApp(pc, { logger, allowRestart: true })).status, 'needs_manual');
  assert.equal(quit.mock.callCount(), 1);
});

test('未经显式许可不执行 jsEval', async () => {
  const r = await runClientApp({ jsEval: 'throw new Error("must not run")' }, { logger, cfg: {} });
  assert.equal(r.status, 'needs_manual');
});

test('WorkBuddy 无需领取弹窗：读状态→领取→回读，且不关闭用户窗口', async (t) => {
  let calls = 0;
  let disconnected = false;
  const page = {
    url: () => 'file:///mock/renderer/index.html',
    waitForFunction: async () => {},
    evaluate: async (fn) => {
      calls++;
      if (String(fn).includes('claimDailyCheckin')) return { ok: true, result: { code: 0 } };
      return { active: true, today_checked_in: calls > 1, total_credits: calls > 1 ? 200 : 100, streak_days: 2, today_credit: 100 };
    },
  };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ Browser: 'mock' }) }));
  t.mock.method(chromium, 'connectOverCDP', async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => { disconnected = true; } }));
  const quit = t.mock.method(platform, 'quitOwnedProcess', async () => { throw new Error('not owned'); });
  const cfg = { platforms: { workbuddy: { app: process.execPath } } };
  const result = await workbuddy.custom({ logger, cfg });
  assert.equal(result.status, 'success');
  assert.equal(calls, 3);
  assert.equal(disconnected, true);
  assert.equal(quit.mock.callCount(), 0);
});

test('WorkBuddy 状态不完整时不尝试领取或重启', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  t.mock.method(chromium, 'connectOverCDP', async () => ({ contexts: () => [{ pages: () => [{ url: () => 'renderer/index.html', waitForFunction: async () => {}, evaluate: async () => { calls++; return {}; } }] }], close: async () => {} }));
  const result = await workbuddy.custom({ logger, cfg: { platforms: { workbuddy: { app: process.execPath } } } });
  assert.equal(result.status, 'needs_manual');
  assert.equal(calls, 1);
});

test('已完成的平台全部跳过，不启动浏览器或探测网络', async (t) => {
  const cfg = defaultConfig();
  for (const p of Object.values(cfg.platforms)) p.enabled = false;
  cfg.platforms.workbuddy.enabled = true;
  fs.mkdirSync(path.join(scratch, 'data'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'data/results.jsonl'), JSON.stringify({ date: today(), id: 'workbuddy', status: 'success' }) + '\n');
  assert.equal(alreadyDoneToday(cfg).pending.length, 0);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not connect'); });
  assert.deepEqual(await runAll(null, cfg, { logger, skipIfDone: true }), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test('部分完成时只运行 pending 平台', async (t) => {
  const cfg = defaultConfig();
  for (const p of Object.values(cfg.platforms)) p.enabled = false;
  cfg.platforms.workbuddy.enabled = true;
  cfg.platforms['mock-pending'] = { enabled: true };
  let calls = 0;
  adapters.push({ id: 'mock-pending', name: 'mock', standalone: true, custom: async () => { calls++; return { status: 'success' }; } });
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200 }));
  cfg.notify = {};
  try {
    const results = await runAll(null, cfg, { logger, skipIfDone: true });
    assert.deepEqual(results.map((r) => r.id), ['mock-pending']);
    assert.equal(calls, 1);
  } finally { adapters.pop(); }
});

test('后续失败不抹掉当日完成；汇总只取 WorkBuddy，不混用智谱积分', () => {
  const cfg = defaultConfig();
  for (const p of Object.values(cfg.platforms)) p.enabled = false;
  cfg.platforms.workbuddy.enabled = cfg.platforms.zhipu.enabled = true;
  const records = [
    { id: 'workbuddy', date: today(), ts: '08:00', status: 'success', meta: { credits: 1700, streak: 16 } },
    { id: 'zhipu', date: today(), ts: '08:01', status: 'success', meta: { credits: 200 } },
  ];
  assert.equal(buildState({ cfg, records }).summary.credits, 1700);
  records.push({ id: 'workbuddy', date: today(), ts: '12:30', status: 'error' });
  const state = buildState({ cfg, records });
  assert.equal(state.summary.doneToday, 2);
  assert.equal(state.platforms.find((p) => p.id === 'workbuddy').last.status, 'error');
});

test('日报日期不能路径穿越或指向无效日期', () => {
  for (const date of ['../../README', '2026-02-30', 'no-date']) assert.throws(() => reportPath(scratch, date));
  assert.equal(reportPath(scratch, '2026-10-31'), path.join(scratch, 'data/reports/2026-10-31.md'));
});

test('本地服务拒绝跨站、伪造 Host、无令牌写入和损坏 JSON', async () => {
  const app = await startServer({ port: 0, logger });
  try {
    assert.equal((await fetch(`${app.url}/api/session`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${app.url}/api/state`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      request.on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(`${app.url}/api/toggle`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(`${app.url}/api/report?date=../../README`)).status, 400);
    const { token } = await (await fetch(`${app.url}/api/session`)).json();
    assert.equal((await fetch(`${app.url}/api/toggle`, { method: 'POST', headers: { 'X-Zaoba-Token': token, 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
    assert.equal((await fetch(`${app.url}/api/state`)).status, 200);
  } finally { await app.close(); }
});
