import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// 所有配置/日志只进入新建的隔离目录，不使用用户 profile 或安装目录。
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zaoba-regression-'));
process.chdir(scratch);
const load = (name) => import(pathToFileURL(path.join(root, 'src', name)));
const { defaultConfig, loadConfig } = await load('config.js');
const { adapters } = await load('adapters/index.js');
const { saveSchedule, getSchedule, applySchedule } = await load('schedule.js');
const { readJSON, writeJSON, today } = await load('util.js');
const { isOnline, alreadyDoneToday, runAll, completionScope, businessDate } = await load('runner.js');
const { acquireTaskLock } = await load('task-lock.js');
const { withDeadline, abortableSleep, guardPage, TimeoutError, UnsafeTimeoutError } = await load('runtime.js');
const { classifyOutcome } = await load('dom.js');
const { interpretZhipuResponse } = await load('adapters/zhipu.js');
const { summarizeResults } = await load('notify.js');
const { installScheduler, schedulerEffective, buildWindowsTaskXml, parseLaunchdTimes } = await load('platform.js');
const { runClientApp } = await load('adapters/clientApp.js');
const { default: workbuddy } = await load('adapters/workbuddy.js');
const { buildState, reportPath, startServer } = await load('server.js');
const platform = (await load('platform.js')).default;
const logger = { info() {}, warn() {}, error() {}, step() {}, ok() {} };

test('智谱必须有有效业务码，HTTP 200 HTML/空对象/未知码均不是成功', () => {
  for (const json of [null, {}, [], 'ok', { status: 999 }]) {
    assert.equal(interpretZhipuResponse({ checkin: { http: 200, json } }, logger).status, 'uncertain');
  }
  assert.equal(interpretZhipuResponse({ checkin: { http: 200, json: { status: 10000 } } }, logger).status, 'success');
  assert.equal(interpretZhipuResponse({ checkin: { http: 200, json: { status: 10001 } } }, logger).status, 'already');
  assert.equal(interpretZhipuResponse({ checkin: { http: 503, json: { status: 10001 } } }, logger).status, 'failed');
});

test('泛化奖励、历史成功及错误冲突不能构成当次成功', () => {
  assert.equal(classifyOutcome('完成任务可获得100积分').success, false);
  assert.equal(classifyOutcome('积分已到账').success, false);
  assert.equal(classifyOutcome('昨天已签到').already, false);
  assert.deepEqual(classifyOutcome('签到成功；网络异常'), { success: false, already: false, fail: true });
  assert.equal(classifyOutcome('历史签到成功；新内容', { before: '历史签到成功' }).success, false);
  assert.equal(classifyOutcome('签到成功', { before: '立即签到' }).success, true);
  assert.equal(classifyOutcome('今日已签到', { before: '立即签到' }).already, true);
});

test('非协作任务和卡住的清理都有有限兜底', { timeout: 1000 }, async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), 5, 'mock', { cleanupGraceMs: 15 }), UnsafeTimeoutError);
  await assert.rejects(withDeadline(async (signal, onAbort) => {
    onAbort(() => new Promise(() => {}));
    await abortableSleep(100, signal);
  }, 5, 'mock', { cleanupGraceMs: 15 }), UnsafeTimeoutError);
});

test('异步返回的定位器也受取消保护', async () => {
  let clicks = 0;
  const c = new AbortController();
  const page = guardPage({ async locator() { return { click() { clicks++; } }; } }, c.signal);
  const loc = await page.locator();
  c.abort();
  assert.throws(() => loc.click());
  assert.equal(clicks, 0);
});

test('完成口径区分部分成功、演练和危险超时', () => {
  assert.equal(summarizeResults([{ status: 'success' }, { status: 'error' }]).code, 2);
  assert.equal(summarizeResults([{ status: 'dry_run' }], { dryRun: true }).code, 0);
  assert.equal(summarizeResults([{ status: 'timeout', fatal: true }]).code, 3);
});

test('Windows XML 包含转义后的明确工作目录', () => {
  const xml = buildWindowsTaskXml({ time: '08:00', nodeBin: 'C:\\node.exe', scriptPath: 'C:\\a\\src\\run-daily.js', projectDir: 'C:\\a & b' });
  assert.ok(xml.includes('<WorkingDirectory>C:\\a &amp; b</WorkingDirectory>'));
});

test('launchd 生效信息只从运行中的 descriptor 读取', async () => {
  const print = 'descriptor = { "Hour" => 8; "Minute" => 0; } descriptor = { Minute = 30; Hour = 12; }';
  assert.deepEqual(parseLaunchdTimes(print), ['08:00', '12:30']);
  const calls = [];
  assert.deepEqual(await schedulerEffective({ osName: 'darwin', execFn: async (cmd, args) => {
    calls.push([cmd, ...args]); return { stdout: print };
  } }), ['08:00', '12:30']);
  assert.equal(calls[0][0], 'launchctl');
  assert.equal(calls[0][1], 'print');
});

test('Windows 关闭补跑删除旧任务，注册失败不先删原任务', async () => {
  const tasks = new Map([['ZaobaDailyCheckin2', '<old />']]);
  const calls = [];
  const execFn = async (cmd, args) => {
    calls.push(args);
    const name = args[args.indexOf('/TN') + 1];
    if (args[0] === '/Create') tasks.set(name, fs.readFileSync(args[args.indexOf('/XML') + 1], 'utf16le'));
    if (args[0] === '/Delete') tasks.delete(name);
    if (args[0] === '/Query' && !tasks.has(name)) throw new Error('cannot find the file specified');
    return { stdout: tasks.get(name) || '' };
  };
  await installScheduler({ osName: 'win32', projectDir: scratch, scriptPath: path.join(scratch, 'src/run-daily.js'), times: ['08:00'], execFn });
  assert.equal(tasks.has('ZaobaDailyCheckin2'), false);
  assert.equal(tasks.has('ZaobaDailyCheckin'), true);
  assert.equal(calls.some((a) => a[0] === '/Delete' && a.includes('ZaobaDailyCheckin')), false);
  let deleted = false;
  await assert.rejects(installScheduler({ osName: 'win32', projectDir: scratch, scriptPath: '/mock', times: ['08:00'], execFn: async (cmd, args) => {
    if (args[0] === '/Delete') deleted = true;
    throw new Error('access denied');
  } }), /access denied/);
  assert.equal(deleted, false);
});

test('Windows 更新中途失败仅恢复本次写入的任务', async () => {
  const original = '<old-primary />';
  const tasks = new Map([['ZaobaDailyCheckin', original], ['ZaobaDailyCheckin2', '<old-retry />']]);
  const execFn = async (cmd, args) => {
    const name = args[args.indexOf('/TN') + 1];
    if (args[0] === '/Query') {
      if (!tasks.has(name)) throw new Error('cannot find the file specified');
      return { stdout: tasks.get(name) };
    }
    if (args[0] === '/Delete') throw new Error('mock delete refused');
    if (args[0] === '/Create') tasks.set(name, fs.readFileSync(args[args.indexOf('/XML') + 1], 'utf16le').replace(/^\uFEFF/, ''));
    return { stdout: '' };
  };
  await assert.rejects(installScheduler({ osName: 'win32', projectDir: scratch, scriptPath: '/mock', times: ['08:00'], execFn }), /已恢复/);
  assert.equal(tasks.get('ZaobaDailyCheckin'), original);
});

test('macOS bootstrap失败恢复原定义，不触发kickstart领取', async () => {
  const file = path.join(scratch, 'mock-task.plist');
  fs.writeFileSync(file, '<old-definition />');
  const calls = [];
  let bootstraps = 0;
  await assert.rejects(installScheduler({ osName: 'darwin', plistFile: file, projectDir: scratch, scriptPath: '/mock', times: ['08:00'], execFn: async (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'bootstrap' && ++bootstraps === 1) throw new Error('mock refused');
    return { stdout: '' };
  } }), /未验证成功/);
  assert.equal(fs.readFileSync(file, 'utf8'), '<old-definition />');
  assert.equal(calls.includes('kickstart'), false);
});

test('调度验证失败恢复原配置，不覆盖并发变更', async () => {
  const file = path.join(scratch, 'config.json');
  writeJSON(file, { schedule: { time: '08:00' }, preserved: true });
  await assert.rejects(applySchedule({ time: '09:00' }, { install: async () => { throw new Error('mock refused'); } }), /未确认生效/);
  assert.equal(readJSON(file).schedule.time, '08:00');
  await assert.rejects(applySchedule({ time: '09:00' }, { install: async () => {
    writeJSON(file, { concurrent: true }); throw new Error('mock refused');
  } }), /未确认生效/);
  assert.equal(readJSON(file).concurrent, true);
  writeJSON(file, defaultConfig());
});

test('账号/活动切换及平台业务日不复用错误缓存', () => {
  const cfg = defaultConfig();
  for (const p of Object.values(cfg.platforms)) p.enabled = false;
  cfg.platforms.workbuddy = { enabled: true, accountTag: 'a', activityTag: 'season1' };
  const file = path.join(scratch, 'data/results.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: 'workbuddy', date: businessDate(cfg, 'workbuddy'), scope: completionScope(cfg, 'workbuddy'), status: 'success' }) + '\n');
  assert.equal(alreadyDoneToday(cfg).allDone, true);
  cfg.platforms.workbuddy.accountTag = 'b';
  assert.equal(alreadyDoneToday(cfg).allDone, false);
  delete cfg.platforms.workbuddy.accountTag;
  assert.equal(alreadyDoneToday(cfg).allDone, false);
  assert.equal(businessDate(cfg, 'qoder-cn', new Date('2026-11-01T09:59:00+08:00')), '2026-10-31');
  assert.equal(businessDate(cfg, 'qoder-cn', new Date('2026-11-01T10:00:00+08:00')), '2026-11-01');
});

test('刷新和 SSE 重连取得运行快照，不把退出码0当成成功证据', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const app = await startServer({ port: 0, logger, spawnRun: () => child });
  try {
    const { token } = await (await fetch(`${app.url}/api/session`)).json();
    const r = await fetch(`${app.url}/api/run`, { method: 'POST', headers: { 'X-Zaoba-Token': token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 202);
    assert.equal((await (await fetch(`${app.url}/api/state`)).json()).task.busy, true);
    const events = await fetch(`${app.url}/api/events`);
    const reader = events.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /"type":"snapshot"/);
    await reader.cancel();
    child.emit('message', { type: 'run-result', summary: { total: 2, completed: 1, pending: 1, code: 2 } });
    child.emit('close', 2);
    const task = (await (await fetch(`${app.url}/api/state`)).json()).task;
    assert.equal(task.busy, false);
    assert.equal(task.code, 2);
    assert.equal(task.summary.pending, 1);
    const release = acquireTaskLock(scratch);
    try {
      const external = (await (await fetch(`${app.url}/api/state`)).json()).task;
      assert.equal(external.externalOrStale, true);
      assert.equal((await fetch(`${app.url}/api/run`, { method: 'POST', headers: { 'X-Zaoba-Token': token, 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
    } finally { release(); }
  } finally { await app.close(); }
});

test('危险超时停止后续平台且保留跨进程锁', { timeout: 10000 }, async () => {
  const moduleUrl = pathToFileURL(path.join(root, 'src/runner.js')).href;
  const adaptersUrl = pathToFileURL(path.join(root, 'src/adapters/index.js')).href;
  const lockUrl = pathToFileURL(path.join(root, 'src/task-lock.js')).href;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaoba-fatal-'));
  const code = `import { runAll } from ${JSON.stringify(moduleUrl)};
    import { adapters } from ${JSON.stringify(adaptersUrl)};
    import { acquireTaskLock } from ${JSON.stringify(lockUrl)};
    acquireTaskLock(); globalThis.fetch = async () => ({status:200});
    const logger = { info(){},warn(){},error(){} };
    adapters.push({id:'mock-a',name:'mock-a',standalone:true,timeout:5,custom:()=>new Promise(()=>{})},
      {id:'mock-b',name:'mock-b',standalone:true,custom:async()=>{throw new Error('must not run')}});
    const results = await runAll(null,{platforms:{'mock-a':{enabled:true},'mock-b':{enabled:true}},cleanupGraceMs:15,notify:{}},{logger});
    console.log(JSON.stringify(results.map(r=>({id:r.id,fatal:r.fatal}))));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, timeout: 8000 });
  assert.deepEqual(JSON.parse(stdout), [{ id: 'mock-a', fatal: true }, { id: 'mock-b' }]);
  assert.equal(fs.existsSync(path.join(dir, 'data/.task.lock')), true);
});

test('CLI 危险超时即使有存活句柄也退出3，且不释放任务锁', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaoba-cli-timeout-'));
  const index = path.join(root, 'src/index.js');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ cleanupGraceMs: 15, notify: { macos: false }, platforms: {
    workbuddy: { enabled: false }, zhipu: { enabled: false }, 'doubaowork-client': { enabled: false }, 'mock-hang': { enabled: true },
  } }));
  const code = `import { adapters } from ${JSON.stringify(pathToFileURL(path.join(root, 'src/adapters/index.js')).href)};
    adapters.push({id:'mock-hang',name:'mock',standalone:true,entryUrls:[],keywords:[],doneKeywords:[],timeout:5,custom:()=>{setInterval(()=>{},1000);return new Promise(()=>{});}});
    globalThis.fetch=async()=>({status:200});process.argv=[process.execPath,${JSON.stringify(index)},'run'];
    await import(${JSON.stringify(pathToFileURL(index).href)});`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, timeout: 8000 }), (e) => e.code === 3 && !e.killed);
  assert.equal(fs.existsSync(path.join(dir, 'data/.task.lock')), true);
});

test('日跑从外部目录启动仍使用脚本项目目录，首次缺data也能执行', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaoba-daily-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(root, 'src/run-daily.js'), path.join(dir, 'src/run-daily.js'));
  fs.copyFileSync(path.join(root, 'src/util.js'), path.join(dir, 'src/util.js'));
  fs.writeFileSync(path.join(dir, 'src/platform.js'), 'export const isWindows = false;');
  fs.writeFileSync(path.join(dir, 'src/index.js'), 'console.log("mock-cwd=" + process.cwd());');
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(dir, 'src/run-daily.js')], { cwd: scratch, timeout: 8000 });
  assert.ok(stdout.includes(`mock-cwd=${fs.realpathSync(dir)}`) || stdout.includes(`mock-cwd=${dir}`));
  assert.equal(fs.existsSync(path.join(dir, 'data/.run.lock')), false);
});

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

test('WorkBuddy 回读字符串 false 不能误报成功', async (t) => {
  let calls = 0;
  const page = { url: () => 'renderer/index.html', waitForFunction: async () => {}, evaluate: async (fn) => {
    if (String(fn).includes('claimDailyCheckin')) return { ok: true, result: { code: 0 } };
    return { active: true, today_checked_in: ++calls === 1 ? false : 'false' };
  } };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  t.mock.method(chromium, 'connectOverCDP', async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }));
  assert.equal((await workbuddy.custom({ logger, cfg: { platforms: { workbuddy: { app: process.execPath } } } })).status, 'uncertain');
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
  Object.assign(cfg.platforms.workbuddy, { accountTag: 'test-account', activityTag: 'test-activity' });
  fs.mkdirSync(path.join(scratch, 'data'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'data/results.jsonl'), JSON.stringify({ date: businessDate(cfg, 'workbuddy'), id: 'workbuddy', scope: completionScope(cfg, 'workbuddy'), status: 'success' }) + '\n');
  assert.equal(alreadyDoneToday(cfg).pending.length, 0);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not connect'); });
  assert.deepEqual(await runAll(null, cfg, { logger, skipIfDone: true }), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test('部分完成时只运行 pending 平台', async (t) => {
  const cfg = defaultConfig();
  for (const p of Object.values(cfg.platforms)) p.enabled = false;
  cfg.platforms.workbuddy.enabled = true;
  Object.assign(cfg.platforms.workbuddy, { accountTag: 'test-account', activityTag: 'test-activity' });
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
