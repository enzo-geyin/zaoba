import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, saveConfig, resolveAdapters } from './config.js';
import { createLogger } from './logger.js';
import { today } from './util.js';
import { readResultsJSONL } from './notify.js';
import { scanApps } from './clients.js';
import platform from './platform.js';
import { getSchedule, applySchedule, readEffectiveSchedule } from './schedule.js';
import { completionScope, businessDate } from './runner.js';

const exec = promisify(execFile);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const RUN_STATUS = new Set(['success', 'already']);
const HISTORY_DAYS = 14;

export function reportPath(root, date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error('日期必须是有效的 YYYY-MM-DD'), { status: 400 });
  }
  const dir = path.resolve(root, 'data/reports');
  const file = path.resolve(dir, `${date}.md`);
  if (path.dirname(file) !== dir) throw Object.assign(new Error('禁止读取日报目录以外的文件'), { status: 403 });
  if (fs.existsSync(file) && path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) throw Object.assign(new Error('禁止跟随目录外符号链接'), { status: 403 });
  return file;
}

function lastDates(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d);
    t.setDate(d.getDate() - i);
    const p = (x) => String(x).padStart(2, '0');
    out.push(`${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`);
  }
  return out;
}

/** 积分有效期规则（与 docs/CREDITS.md 保持一致） */
function expiryOf(id, last) {
  const addDays = (dateStr, n) => {
    if (!dateStr) return null;
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const daysLeft = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(`${dateStr}T23:59:59`);
    return Math.ceil((d - Date.now()) / 86400000);
  };
  const claimed = last && ['success', 'already'].includes(last.status) ? last.date : null;

  switch (id) {
    case 'minimax': {
      const until = addDays(claimed, 30);
      return { text: '签到积分 30 天有效（仅限 Code 使用）', date: until, daysLeft: daysLeft(until) };
    }
    case 'workbuddy': {
      const end = last?.meta?.endTime ? String(last.meta.endTime).slice(0, 10) : null;
      return {
        text: end ? `签到活动截止 ${end}；付费积分每月底清零` : '付费积分每月底清零；签到活动有截止日',
        date: end,
        daysLeft: daysLeft(end),
      };
    }
    case 'zhipu':
      return { text: '登录积分未明示；体验卡类 7 天有效', date: null, daysLeft: null };
    case 'trae-cn':
      return { text: '官方称不同渠道有效期不同（未统一明示）', date: null, daysLeft: null };
    case 'doubaowork-client':
      return { text: '额度有效期未明示，按活动页', date: null, daysLeft: null };
    case 'qoder-cn':
      return { text: '当日有效：10:00 → 次日 10:00，错过不补', date: null, daysLeft: 1 };
    default:
      return null;
  }
}

/** 「去登录」按钮的状态（同一时间只允许一个登录窗口） */
const loginState = { id: null, proc: null, status: 'idle', startedAt: null, code: null };

/** 汇总前端需要的全部状态 */
export function buildState({ cfg = loadConfig({ createIfMissing: false }), records = readResultsJSONL(path.resolve('data/results.jsonl')) } = {}) {
  const adapters = resolveAdapters(cfg, { includeDisabled: true });
  records = records.filter((r) => !r.dryRun);
  const dates = lastDates(HISTORY_DAYS);

  // 每平台最新一条 + 最近 N 天矩阵
  const byPlatform = new Map();
  for (const r of records) {
    if (!byPlatform.has(r.id)) byPlatform.set(r.id, []);
    byPlatform.get(r.id).push(r);
  }

  // 已确认没有可自动化签到入口的平台（不要给用户"去登录"的误导提示）
  const UNSUPPORTED = new Set(['kimi', 'wenxin', 'yuanbao', 'wanxiang', 'doubao', 'doubao-client']);

  // 客户端可执行文件候选路径（用于判断「客户端是否已安装」）
  const KNOWN_APPS = {
    workbuddy: platform.knownAppPaths.workbuddy,
    'doubaowork-client': platform.knownAppPaths.doubaowork,
    doubaowork: platform.knownAppPaths.doubaowork,
    'trae-cn': platform.knownAppPaths.trae,
    trae: platform.knownAppPaths.trae,
    'qoder-cn': platform.knownAppPaths.qoder,
    qoder: platform.knownAppPaths.qoder,
    'doubao-client': platform.knownAppPaths.doubao,
    doubao: platform.knownAppPaths.doubao,
  };

  const platforms = adapters.map((a) => {
    const scope = completionScope(cfg, a.id);
    const list = (byPlatform.get(a.id) || []).filter((r) => !scope || r.scope === scope).sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
    const last = list[list.length - 1] || null;
    const lastWithMeta = list.findLast((r) => r.meta && RUN_STATUS.has(r.status));
    const matrix = {};
    for (const d of dates) {
      const dayRecords = list.filter((r) => r.date === d);
      const completed = dayRecords.findLast((r) => RUN_STATUS.has(r.status));
      matrix[d] = (completed || dayRecords.at(-1))?.status || null;
    }
    const todayRecords = list.filter((r) => r.date === businessDate(cfg, a.id));
    const todayRec = todayRecords.findLast((r) => RUN_STATUS.has(r.status)) || todayRecords.at(-1) || null;
    const pc = cfg.platforms[a.id] || {};
    // 判定方式：config 里显式 type 优先；否则看是否是客户端接管类适配器
    const mode =
      pc.type === 'client'
        ? 'client'
        : pc.type === 'web'
          ? 'web'
          : a.clientApp || pc.app || a.id === 'workbuddy'
            ? 'client'
            : 'web';
    const cands = pc.appCandidates || (pc.app ? [pc.app] : KNOWN_APPS[a.id] || []);
    const clientInstalled = mode === 'client' ? cands.some((x) => x && fs.existsSync(x)) : null;
    const loginStatuses = [todayRec?.status, last?.status].filter(Boolean);
    const unsupported = UNSUPPORTED.has(a.id);
    const needsLogin = !unsupported && loginStatuses.includes('needs_login');
    const setupHint = unsupported
      ? '该平台暂无可自动化的签到入口'
      : mode === 'client' && clientInstalled === false
        ? '需先安装客户端'
        : needsLogin
          ? mode === 'client'
            ? '需在客户端里登录一次'
            : '需登录一次：点底部「去登录」'
          : !last
            ? mode === 'client'
              ? '尚未运行（确认客户端已登录）'
              : '尚未运行（先 npm run login 登录）'
            : '';
    return {
      id: a.id,
      name: a.name,
      kind: mode,
      clientInstalled,
      needsLogin,
      unsupported,
      downloadUrl: mode === 'client' ? platform.downloadUrls[a.id] || '' : '',
      appPath: mode === 'client' ? cands[0] || '' : '',
      setupHint,
      expiry: expiryOf(a.id, last),
      enabled: !!pc.enabled,
      notes: a.notes || '',
      last: last
        ? { date: last.date, ts: last.ts, status: last.status, detail: last.detail, meta: last.meta || null, durationMs: last.durationMs }
        : null,
      lastVerifiedMeta: lastWithMeta?.meta || null,
      lastVerifiedAt: lastWithMeta?.ts || null,
      todayStatus: todayRec ? todayRec.status : null,
      todayDetail: todayRec ? todayRec.detail : null,
      matrix,
      streakInfo: last?.meta || null,
    };
  });

  const enabled = platforms.filter((p) => p.enabled);
  const doneToday = enabled.filter((p) => RUN_STATUS.has(p.todayStatus));

  // 汇总：credits 取最近一次带 meta 的记录（WorkBuddy 累计）
  let totalCredits = null;
  let streak = null;
  const wb = platforms.find((p) => p.id === 'workbuddy');
  totalCredits = wb?.lastVerifiedMeta?.credits ?? null;
  streak = wb?.lastVerifiedMeta?.streak ?? null;

  return {
    now: new Date().toISOString(),
    today: today(),
    schedule: { time: cfg.schedule?.time || '08:30', randomDelayMinutes: cfg.schedule?.randomDelayMinutes ?? 25 },
    headless: cfg.headless,
    summary: {
      enabledCount: enabled.length,
      doneToday: doneToday.length,
      totalPlatforms: platforms.length,
      credits: totalCredits,
      streak,
    },
    dates,
    platforms,
  };
}

async function scanClientsCached(cfg) {
  const apps = await scanApps();
  // 内置适配器（如 WorkBuddy）的客户端路径不在 config 里，单独带上
  const KNOWN_CHECKIN_APPS = platform.knownAppPaths.workbuddy || [];
  const configuredApps = new Set([
    ...KNOWN_CHECKIN_APPS.map((x) => path.resolve(x)),
    ...Object.values(cfg?.platforms || {})
      .map((p) => p?.app)
      .filter(Boolean)
      .map((x) => path.resolve(x)),
  ]);
  const out = [];
  for (const a of apps) {
    const running = await platform.isProcessRunning(a.execPath);
    out.push({
      name: a.name,
      version: a.version,
      kind: a.kind,
      id: a.id,
      running,
      path: a.path,
      configured: configuredApps.has(path.resolve(a.path)),
    });
  }
  // 已接入的排前面，其余按名字
  out.sort((x, y) => Number(y.configured) - Number(x.configured) || x.name.localeCompare(y.name));
  return out;
}

/**
 * 本地控制台服务：静态页 + JSON API + SSE 实时日志。
 * 只监听 127.0.0.1，不对外网暴露。
 */
export async function startServer({ port = 7788, logger, spawnRun = spawn } = {}) {
  const root = process.cwd();
  const webDir = path.join(root, 'web');
  const hub = new Set();
  const sessionToken = randomBytes(32).toString('hex');
  let running = null; // 正在跑的 child process
  let runState = { status: 'idle', startedAt: null, endedAt: null, only: [], dryRun: false, code: null, summary: null };
  const taskSnapshot = () => {
    const locked = fs.existsSync(path.join(root, 'data/.task.lock'));
    return { ...runState, busy: !!running || !!loginState.proc || locked, locked,
      externalOrStale: locked && !running && !loginState.proc, login: { id: loginState.id, status: loginState.status } };
  };
  let clientsCache = { at: 0, data: null };

  const logger2 = logger || createLogger('web', { silent: true });

  const broadcast = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of hub) {
      try {
        res.write(payload);
      } catch {
        hub.delete(res);
      }
    }
  };

  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('需要 application/json'), { status: 415 }));
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (Buffer.byteLength(data) > 65536) {
          reject(Object.assign(new Error('请求体过大'), { status: 413 }));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const body = data ? JSON.parse(data) : {};
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('需要 JSON 对象');
          resolve(body);
        } catch {
          reject(Object.assign(new Error('无效的 JSON 对象'), { status: 400 }));
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const localPort = server.address()?.port || port;
    const url = new URL(req.url, `http://127.0.0.1:${localPort}`);
    const p = url.pathname;

    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const origins = [`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`];
      if (!origins.some((o) => new URL(o).host === req.headers.host) ||
          (req.headers.origin && !origins.includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
        return json(res, 403, { error: '禁止跨站或非本地请求' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        const supplied = Buffer.from(String(req.headers['x-zaoba-token'] || ''));
        const expected = Buffer.from(sessionToken);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 403, { error: '缺少有效的本地会话令牌' });
      }
      if (p === '/api/session' && req.method === 'GET') return json(res, 200, { token: sessionToken });
      // ---------- API ----------
      if (p === '/api/state' && req.method === 'GET') {
        return json(res, 200, { ...buildState(), task: taskSnapshot() });
      }

      if (p === '/api/report' && req.method === 'GET') {
        const date = url.searchParams.get('date') || today();
        const file = reportPath(root, date);
        if (!fs.existsSync(file)) return json(res, 404, { error: '没有这一天的报告' });
        return json(res, 200, { date, markdown: fs.readFileSync(file, 'utf8') });
      }

      if (p.startsWith('/api/login/') && req.method === 'POST') {
        const id = decodeURIComponent(p.slice('/api/login/'.length));
        if (!resolveAdapters(loadConfig({ createIfMissing: false }), { includeDisabled: true, only: [id] }).length) return json(res, 400, { error: '未知平台' });
        if (taskSnapshot().busy) {
          return json(res, 409, { error: '已有签到或登录任务在运行，请先完成它' });
        }
        const child = spawn(process.execPath, [path.join('src', 'login-one.js'), id], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        loginState.id = id;
        loginState.proc = child;
        loginState.status = 'running';
        loginState.startedAt = Date.now();
        loginState.code = null;
        const relay = (buf) => {
          for (const line of String(buf).split('\n')) {
            const t = line.trim();
            if (t) broadcast({ type: 'log', level: 'info', line: t });
          }
        };
        child.stdout.on('data', relay);
        child.stderr.on('data', relay);
        child.on('error', (e) => { loginState.proc = null; loginState.status = 'error'; logger2.error(e.message); });
        child.on('close', (code) => {
          loginState.proc = null;
          loginState.code = code;
          loginState.status = code === 0 ? 'ok' : code === 2 ? 'timeout' : code === 3 ? 'client' : 'error';
          broadcast({ type: 'state' });
        });
        return json(res, 202, { ok: true, id });
      }

      if (p.startsWith('/api/open-app/') && req.method === 'POST') {
        const id = decodeURIComponent(p.slice('/api/open-app/'.length));
        const cfg = loadConfig();
        const pc = cfg.platforms[id] || {};
        const cands = pc.appCandidates || (pc.app ? [pc.app] : []);
        const target = cands.find((x) => x && fs.existsSync(x));
        if (!target) return json(res, 404, { error: '没找到这个平台的客户端，先点「去下载」安装' });
        try {
          if (platform.isMacOS) {
            await exec('open', [target], { timeout: 8000 });
          } else if (platform.isWindows) {
            const child = spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: false });
            child.unref();
          } else {
            return json(res, 400, { error: '当前系统暂不支持在此打开客户端' });
          }
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 500, { error: String(e.message).split('\n')[0] });
        }
      }

      if (p === '/api/login/status' && req.method === 'GET') {
        return json(res, 200, {
          id: loginState.id,
          status: loginState.status,
          startedAt: loginState.startedAt,
          code: loginState.code,
        });
      }

      if (p === '/api/schedule' && req.method === 'GET') {
        return json(res, 200, { config: getSchedule(), effective: await readEffectiveSchedule() });
      }

      if (p === '/api/schedule' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const sched = await applySchedule({
            time: body.time,
            retryTime: body.retryTime,
            randomDelayMinutes: body.randomDelayMinutes,
          });
          const effective = await readEffectiveSchedule();
          logger2.info(`定时已更新: 主跑 ${sched.time}, 补跑 ${sched.retryTime || '关闭'}, 延迟 ${sched.randomDelayMinutes} 分钟`);
          broadcast({ type: 'state' });
          return json(res, 200, { ok: true, config: sched, effective });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      if (p === '/api/clients' && req.method === 'GET') {
        if (!clientsCache.data || Date.now() - clientsCache.at > 60000) {
          clientsCache = { at: Date.now(), data: await scanClientsCached(loadConfig()) };
        }
        return json(res, 200, { clients: clientsCache.data, scannedAt: new Date(clientsCache.at).toISOString() });
      }

      if (p === '/api/toggle' && req.method === 'POST') {
        const body = await readBody(req);
        const cfg = loadConfig();
        if (!body.id || !cfg.platforms[body.id]) return json(res, 400, { error: '未知平台' });
        if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled 必须为布尔值' });
        cfg.platforms[body.id] = { ...cfg.platforms[body.id], enabled: body.enabled };
        saveConfig(cfg);
        logger2.info(`平台 ${body.id} ${body.enabled ? '已启用' : '已停用'}`);
        broadcast({ type: 'state' });
        return json(res, 200, { ok: true });
      }

      if (p === '/api/run' && req.method === 'POST') {
        if (taskSnapshot().busy) return json(res, 409, { error: '已有签到或登录任务在运行，请等它结束' });
        const body = await readBody(req);
        if (body.only !== undefined && (!Array.isArray(body.only) || body.only.some((id) => typeof id !== 'string' || !/^[a-z0-9_-]+$/i.test(id)))) return json(res, 400, { error: 'only 必须是平台 ID 数组' });
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return json(res, 400, { error: 'dryRun 必须为布尔值' });
        const only = Array.isArray(body.only) && body.only.length ? body.only : [];
        const dryRun = !!body.dryRun;
        // readBody 是异步的，必须在 await 后再检查一次，避免两个并发请求同时通过。
        if (taskSnapshot().busy) return json(res, 409, { error: '已有签到或登录任务在运行' });

        const args = ['src/index.js', 'run', '--skip-if-done'];
        if (only.length) args.push(`--only=${only.join(',')}`);
        if (dryRun) args.push('--dry-run');

        logger2.info(`开始运行: node ${args.join(' ')}`);
        const child = spawnRun(process.execPath, args, { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        running = child;
        runState = { status: 'running', startedAt: new Date().toISOString(), endedAt: null, only, dryRun, code: null, summary: null };
        broadcast({ type: 'run-start', task: taskSnapshot() });
        child.on('message', (message) => {
          if (message?.type === 'run-result') runState.summary = message.summary;
        });

        const pipe = (stream, level) => {
          let buf = '';
          stream.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (line.trim()) broadcast({ type: 'log', level, line: line.replace(/\s+$/, '') });
            }
          });
        };
        pipe(child.stdout, 'info');
        pipe(child.stderr, 'error');

        let ended = false;
        const finish = (code) => {
          if (ended) return;
          ended = true;
          running = null;
          runState = { ...runState, status: 'finished', code: code ?? 1, endedAt: new Date().toISOString() };
          broadcast({ type: 'run-end', code: runState.code, task: taskSnapshot(), summary: runState.summary });
          broadcast({ type: 'state' });
          logger2.info(`运行结束，退出码 ${runState.code}`);
        };
        child.on('error', (e) => { finish(1); logger2.error(e.message); });
        child.on('close', finish);

        return json(res, 202, { ok: true, started: args.join(' ') });
      }

      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', task: taskSnapshot() })}\n\n`);
        hub.add(res);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* ignore */
          }
        }, 15000);
        req.on('close', () => {
          clearInterval(ping);
          hub.delete(res);
        });
        return;
      }

      // ---------- 静态资源 ----------
      let file = p === '/' ? path.join(webDir, 'index.html') : path.join(webDir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(webDir)) return json(res, 403, { error: 'forbidden' });

      if (!fs.existsSync(file)) {
        // 单页应用：未知路径回 index
        file = path.join(webDir, 'index.html');
        if (!fs.existsSync(file)) return json(res, 404, { error: '前端文件缺失' });
      }
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      logger2.error(`请求出错 ${req.method} ${p}: ${e.message}`);
      if (!res.headersSent) json(res, e.status || 500, { error: String(e.message || e) });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    url,
    port: addr.port,
    close: () =>
      new Promise((resolve) => {
        for (const r of hub) {
          try {
            r.end();
          } catch {
            /* ignore */
          }
        }
        hub.clear();
        server.close(() => resolve());
      }),
  };
}

/** CLI 入口 */
export async function webCommand({ port = 7788 } = {}) {
  const logger = createLogger('web', { silent: false });
  const s = await startServer({ port, logger });
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log(`  │  早八 zaoba  →  ${s.url.padEnd(29)}│`);
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log('  · 只监听 127.0.0.1，不对外网开放');
  console.log('  · Ctrl+C 停止');
  console.log('');
  process.on('SIGINT', async () => {
    console.log('\n正在关闭...');
    await s.close();
    process.exit(0);
  });
  return s;
}
