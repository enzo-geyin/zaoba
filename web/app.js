/* 早八 · 原生 JS，无构建步骤 */

const $ = (sel) => document.querySelector(sel);

// 会话令牌只存内存；来自其它网站的请求无法读取它。
const nativeFetch = window.fetch.bind(window);
let sessionToken;
window.fetch = async (input, init = {}) => {
  const target = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = (init.method || 'GET').toUpperCase();
  if (target.origin === location.origin && !['GET', 'HEAD'].includes(method)) {
    if (!sessionToken) {
      const response = await nativeFetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('无法取得本地会话令牌，请刷新控制台');
      sessionToken = (await response.json()).token;
    }
    const headers = new Headers(init.headers);
    headers.set('X-Zaoba-Token', sessionToken);
    headers.set('Content-Type', 'application/json');
    init = { ...init, headers };
  }
  return nativeFetch(input, init);
};

const STATUS = {
  success: { label: '已签到', cls: 'ok' },
  already: { label: '今日已签', cls: 'ok' },
  needs_login: { label: '需重新登录', cls: 'warn' },
  needs_manual: { label: '需手动处理', cls: 'warn' },
  not_found: { label: '未找到入口', cls: 'idle' },
  uncertain: { label: '结果待确认', cls: 'idle' },
  failed: { label: '签到失败', cls: 'bad' },
  error: { label: '运行出错', cls: 'bad' },
  timeout: { label: '超时', cls: 'bad' },
  not_installed: { label: '未安装', cls: 'idle' },
  offline: { label: '离线跳过', cls: 'idle' },
  dry_run: { label: '演练通过', cls: 'idle' },
  unsupported: { label: '暂不支持', cls: 'idle' },
  disabled: { label: '未启用', cls: 'none' },
  none: { label: '今日未运行', cls: 'none' },
};

const statusOf = (s) => STATUS[s] || STATUS.none;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let state = null;
let running = false;
let filter = 'all';

/* ---------------- 数据 ---------------- */

async function fetchState() {
  const r = await fetch('/api/state');
  if (!r.ok) throw new Error('读取状态失败');
  state = await r.json();
  render();
}

function nextRunText() {
  if (!state) return '';
  const { time, randomDelayMinutes } = state.schedule;
  return `每天 ${time} 自动 · 随机延迟 ≤${randomDelayMinutes} 分钟`;
}

/* ---------------- 渲染 ---------------- */

function render() {
  if (!state) return;

  const { summary, platforms, today } = state;
  $('#subline').textContent = `${today} · ${summary.enabledCount} 个平台启用中 · ${nextRunText()}`;
  $('#nextRun').textContent = `⏰ ${nextRunText()}`;
  $('#builtAt').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;

  renderSummary();
  renderPlatforms();
  const shown = filter === 'all' ? state.platforms.length : state.summary.enabledCount;
  $('#platformHint').textContent = `${shown} 个 · 下方色块为近 ${state.dates.length} 天记录`;
  document.querySelectorAll('#filterSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
}

function renderSummary() {
  const box = $('#summary');
  box.replaceChildren();
  const { summary, platforms } = state;

  const stat = (label, value, unit, meta) => {
    const d = el('div', 'stat');
    d.append(el('div', 'label', label));
    const v = el('div', 'value', String(value));
    if (unit) v.append(el('small', '', unit));
    d.append(v);
    if (meta) d.append(el('div', 'meta', meta));
    return d;
  };

  const done = summary.doneToday;
  const total = summary.enabledCount;
  const wb = platforms.find((p) => p.id === 'workbuddy');

  box.append(
    stat('今日完成', `${done}/${total}`, '', total && done === total ? '全部完成 ✓' : total ? '还有平台待签' : '没有启用的平台'),
    stat('连续签到', summary.streak ?? '—', summary.streak ? '天' : '', wb?.last?.meta?.activity || 'WorkBuddy'),
    stat('累计 Credits', summary.credits ?? '—', '', summary.credits != null ? `今日 +${wb?.last?.meta?.todayCredit ?? '—'}` : '暂无数据'),
    stat('下次自动', state.schedule.time, '', `随机延迟 ≤${state.schedule.randomDelayMinutes} 分`),
  );
}

function renderPlatforms() {
  const grid = $('#platforms');
  grid.replaceChildren();

  const list = state.platforms.filter((p) => (filter === 'all' ? true : p.enabled));
  if (!list.length) {
    grid.append(el('div', 'empty', '没有启用的平台。把某个平台的开关打开即可。'));
    return;
  }

  for (const p of list) {
    const card = el('div', `card${p.enabled ? '' : ' off'}`);

    /* --- 顶部：名称 + 类型 + 状态 --- */
    const top = el('div', 'card-top');
    const title = el('div', 'card-title');
    title.append(el('h3', '', p.name));
    title.append(el('span', `badge ${p.kind}`, p.kind === 'client' ? '客户端' : '网页'));
    if (p.setupHint) {
      const warn = p.kind === 'client' && p.clientInstalled === false;
      const chip = el('span', `setup-chip${warn ? ' warn' : ''}`, p.setupHint);
      chip.title = warn
        ? '这个平台的签到在桌面客户端里，需要先安装客户端'
        : '还没登录过这个平台，按提示登录一次即可';
      title.append(chip);
    }
    top.append(title);

    const st = p.enabled ? statusOf(p.todayStatus || 'none') : statusOf('disabled');
    top.append(el('span', `status ${st.cls}`, st.label));
    card.append(top);

    /* --- 说明 --- */
    const detail = p.enabled
      ? p.todayDetail || p.last?.detail || p.notes || '还没有运行记录'
      : p.notes || '已停用';
    const d = el('div', 'detail', detail);
    d.title = detail;
    card.append(d);

    /* --- 指标 chips --- */
    const chips = el('div', 'chips');
    const m = p.last?.meta;
    if (m?.streak != null) chips.append(chip('连续', `${m.streak} 天`));
    if (m?.credits != null) chips.append(chip('累计', `${m.credits} credits`));
    if (m?.todayCredit != null && p.todayStatus && ['success', 'already'].includes(p.todayStatus)) {
      chips.append(chip('今日', `+${m.todayCredit}`));
    }
    if (p.last?.ts) chips.append(chip('上次', relTime(p.last.ts)));
    if (p.last?.durationMs) chips.append(chip('耗时', `${(p.last.durationMs / 1000).toFixed(1)}s`));
    if (chips.childElementCount) card.append(chips);

    /* --- 14 天状态条 --- */
    const strip = el('div', 'strip');
    for (const date of state.dates) {
      const s = p.matrix[date];
      const cls2 = s ? statusOf(s).cls : 'none';
      const dot = el('span', `day ${cls2}`);
      dot.title = `${date} · ${s ? statusOf(s).label : '无记录'}`;
      strip.append(dot);
    }
    card.append(strip);

    /* --- 需要用户操作时：先给一行说明，再给按钮 --- */
    const act = computeAction(p);
    if (act) {
      const note = el('div', `action-note${p.unsupported ? ' muted-note' : ''}`, act.note);
      card.append(note);
    }

    /* --- 底部：开关 + 操作 --- */
    const foot = el('div', 'card-foot');

    const sw = el('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = p.enabled;
    input.disabled = running;
    input.addEventListener('change', async () => {
      try {
        const r = await fetch('/api/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: p.id, enabled: input.checked }),
        });
        if (!r.ok) throw new Error((await r.json()).error || '切换失败');
        toast(`${p.name} 已${input.checked ? '启用' : '停用'}`);
        await fetchState();
      } catch (e) {
        toast(e.message, true);
        input.checked = !input.checked;
      }
    });
    sw.append(input, el('span', 'track'), el('span', '', p.enabled ? '启用' : '停用'));
    foot.append(sw);

    const btns = el('div', 'head-actions');
    if (act && act.label) {
      const actBtn = el('button', 'btn tiny primary', act.label);
      actBtn.title = act.note;
      actBtn.addEventListener('click', act.action);
      btns.append(actBtn);
    }
    const dry = el('button', 'btn tiny', '演练');
    dry.disabled = running || !p.enabled || p.unsupported;
    dry.hidden = !!p.unsupported;
    dry.addEventListener('click', () => startRun([p.id], true));
    const go = el('button', 'btn tiny', '签到');
    go.disabled = running || !p.enabled || p.unsupported;
    go.hidden = !!p.unsupported;
    go.addEventListener('click', () => startRun([p.id], false));
    btns.append(dry, go);
    foot.append(btns);

    card.append(foot);
    grid.append(card);
  }

  renderExpiry(list);
}

/** 积分到期面板 */
function renderExpiry(list) {
  const box = $('#expiry');
  if (!box) return;
  box.replaceChildren();
  const rows = list
    .filter((p) => p.enabled && p.expiry)
    .sort((a, b) => (a.expiry.daysLeft ?? 9999) - (b.expiry.daysLeft ?? 9999));

  if (!rows.length) {
    box.append(el('span', 'muted', '暂无可计算的到期时间'));
    return;
  }

  for (const p of rows) {
    const row = el('div', 'expiry-row');
    row.append(el('div', 'e-name', p.name));
    const right = el('div', 'e-right');
    if (p.expiry.daysLeft != null) {
      const cls = p.expiry.daysLeft <= 1 ? 'danger' : p.expiry.daysLeft <= 7 ? 'warn' : 'ok';
      const label = p.expiry.daysLeft <= 0 ? '已过期' : `${p.expiry.daysLeft} 天`;
      right.append(el('b', `e-days ${cls}`, label));
    }
    if (p.expiry.date) right.append(el('span', 'e-date', p.expiry.date));
    const text = el('div', 'e-text', p.expiry.text);
    row.append(text, right);
    box.append(row);
  }
}

function chip(k, v) {
  const c = el('span', 'chip');
  c.append(el('span', '', `${k} `), el('b', '', v));
  return c;
}

function relTime(ts) {
  const d = new Date(String(ts).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(ts);
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/* ---------------- 运行 ---------------- */

async function startRun(only, dryRun) {
  if (running) return toast('已有任务在运行中', true);
  running = true;
  updateRunUI(true);
  appendLog('──────── ' + (dryRun ? '演练开始' : '开始签到') + (only?.length ? ` · ${only.join(',')}` : ' · 全部') + ' ────────', 'step');

  try {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ only, dryRun }),
    });
    if (!r.ok) throw new Error((await r.json()).error || '启动失败');
  } catch (e) {
    running = false;
    updateRunUI(false);
    toast(e.message, true);
  }
}

function updateRunUI(on) {
  $('#btnRunAll').disabled = on;
  $('#btnRunAll').classList.toggle('running', on);
  $('#btnDry').disabled = on;
  $('#liveBadge').hidden = !on;
  document.querySelectorAll('.card .btn.tiny').forEach((b) => {
    if (!on) {
      // 恢复：只按平台启用态决定
      const card = b.closest('.card');
      b.disabled = card?.classList.contains('off') ?? false;
    } else {
      b.disabled = true;
    }
  });
}

/* ---------------- 日志 ---------------- */

const logEl = () => $('#log');

function appendLog(line, forcedLevel) {
  const box = logEl();
  if (box.firstElementChild?.classList.contains('muted')) box.replaceChildren();
  let level = forcedLevel;
  if (!level) {
    if (/\bERROR\b/.test(line)) level = 'error';
    else if (/\bWARN\b/.test(line)) level = 'warn';
    else if (/\bSTEP\b/.test(line)) level = 'step';
    else if (/\bOK\b/.test(line)) level = 'ok';
    else level = 'info';
  }
  const span = el('span', `l-${level}`, line + '\n');
  box.append(span);

  while (box.childElementCount > 800) box.firstElementChild.remove();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

/* ---------------- SSE ---------------- */

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.type === 'log') {
      appendLog(ev.line, ev.level === 'error' ? 'error' : undefined);
    } else if (ev.type === 'run-start') {
      running = true;
      updateRunUI(true);
    } else if (ev.type === 'run-end') {
      running = false;
      updateRunUI(false);
      appendLog(`──────── 运行结束（退出码 ${ev.code}）────────`, ev.code === 0 ? 'ok' : 'warn');
      toast(ev.code === 0 ? '签到完成' : `运行结束，退出码 ${ev.code}`, ev.code !== 0);
      setTimeout(fetchState, 400);
    } else if (ev.type === 'state') {
      fetchState();
    }
  };
  es.onerror = () => {
    // 服务重启后自动重连由 EventSource 负责；这里只提示一次
    appendLog('· 与服务的实时连接断开，正在重连…', 'warn');
  };
}

/* ---------------- 每个平台需要用户做什么 ---------------- */

/**
 * 返回当前平台该提示什么、该给什么按钮。
 * 文案原则：说清"为什么不行 + 点了会发生什么"，不只放一个按钮。
 */
function computeAction(p) {
  if (!p.enabled || running) return null;
  if (p.unsupported) {
    return { note: '这个平台没有可自动领取的入口，启用也不会执行', label: '' };
  }
  if (p.kind === 'client' && p.clientInstalled === false) {
    return {
      note: '还没安装这个客户端，签到只能在里面做',
      label: '下载客户端',
      action: () => window.open(p.downloadUrl, '_blank'),
    };
  }
  if (p.needsLogin) {
    if (p.kind === 'client') {
      return {
        note: '客户端已安装，但还没登录：打开后扫码登录，再回来点「签到」',
        label: '打开客户端',
        action: () => openClient(p),
      };
    }
    return {
      note: '网页登录态已失效：点右侧按钮扫码，成功后自动保存',
      label: '去登录',
      action: () => beginLogin(p),
    };
  }
  const failed = ['not_found', 'error', 'timeout', 'needs_manual', 'uncertain'].includes(p.todayStatus);
  if (failed) {
    return {
      note: `上次失败：${p.todayDetail || '未知原因'}——可以先重试一次`,
      label: '重试',
      action: () => startRun([p.id], false),
    };
  }
  return null;
}

/* ---------------- 打开客户端 ---------------- */

async function openClient(p) {
  try {
    const r = await fetch(`/api/open-app/${encodeURIComponent(p.id)}`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '打开失败');
    toast(`已打开 ${p.name}，在里面扫码登录后回来点「签到」`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- 去登录 ---------------- */

let loginPoll = null;

async function beginLogin(p) {
  if (p.kind !== 'web') {
    toast(`${p.name} 的登录在客户端里完成：打开客户端扫码登录后，回来点「签到」`);
    return;
  }
  try {
    const r = await fetch(`/api/login/${encodeURIComponent(p.id)}`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '启动登录失败');
    toast('登录窗口已弹出，扫码完成后会自动保存');
    pollLogin(p);
  } catch (e) {
    toast(e.message, true);
  }
}

function pollLogin(p) {
  clearInterval(loginPoll);
  let ticks = 0;
  loginPoll = setInterval(async () => {
    ticks += 1;
    try {
      const r = await fetch('/api/login/status');
      const s = await r.json();
      if (s.status === 'running') {
        if (ticks > 240) clearInterval(loginPoll);
        return;
      }
      clearInterval(loginPoll);
      if (s.status === 'ok') {
        toast(`${p.name} 登录成功`);
        await fetchState();
      } else if (s.status === 'timeout') {
        toast('登录超时，可以再点一次「去登录」', true);
      } else if (s.status === 'client') {
        toast('这个平台需要在客户端里登录', true);
      } else if (s.status === 'error') {
        toast('登录失败，看下方运行日志', true);
      }
    } catch {
      clearInterval(loginPoll);
    }
  }, 2500);
}

/* ---------------- 客户端扫描 ---------------- */

async function loadClients(force) {
  const box = $('#clients');
  box.replaceChildren(el('span', 'muted', '扫描中…'));
  try {
    const r = await fetch('/api/clients');
    const data = await r.json();
    box.replaceChildren();
    if (!data.clients?.length) {
      box.append(el('span', 'muted', '没有发现可接管的客户端'));
      return;
    }
    for (const c of data.clients) {
      const row = el('div', 'client');
      const left = el('div');
      const name = el('div', 'cname', c.name);
      name.append(el('span', 'tag', c.kind === 'electron' ? 'Electron' : 'Chromium'));
      if (c.configured) name.append(el('span', 'tag cfg', '已配置'));
      if (c.running) name.append(el('span', 'tag run', '运行中'));
      left.append(name);
      left.append(el('div', 'cmeta', `v${c.version || '?'} · ${c.id || ''}`));
      row.append(left);
      box.append(row);
    }
  } catch {
    box.replaceChildren(el('span', 'muted', '扫描失败'));
  }
}

/* ---------------- 迷你 markdown 渲染（日报用） ---------------- */

function renderMarkdown(md) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  const lines = String(md).split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^#{1,3} /.test(ln)) {
      const lvl = Math.min(ln.match(/^#+/)[0].length + 1, 3);
      html += `<h${lvl}>${inline(ln.replace(/^#+ /, ''))}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^\|/.test(ln)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      if (rows.length) {
        html += '<table><thead><tr>' + cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        for (const r of rows.slice(2)) html += '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        html += '</tbody></table>';
      }
      continue;
    }
    if (/^[-*] /.test(ln)) {
      html += '<ul>';
      while (i < lines.length && /^[-*] /.test(lines[i])) html += `<li>${inline(lines[i++].slice(2))}</li>`;
      html += '</ul>';
      continue;
    }
    if (!ln.trim()) {
      i++;
      continue;
    }
    html += `<p>${inline(ln)}</p>`;
    i++;
  }
  return html;
}

/* ---------------- 定时设置 ---------------- */

let sched = { time: '08:00', retryTime: '12:30', randomDelayMinutes: 5 };

async function loadSchedule() {
  try {
    const r = await fetch('/api/schedule');
    const data = await r.json();
    sched = data.config || sched;
    $('#schedLabel').textContent = sched.time;
    $('#schedEffective').textContent = data.effective?.length ? `launchd 实际生效：${data.effective.join(' / ')}` : 'launchd 未安装';
  } catch {
    /* 忽略，保持默认显示 */
  }
}

function openSchedule() {
  $('#inpTime').value = sched.time;
  $('#inpRetry').value = sched.retryTime || '';
  $('#inpDelay').value = sched.randomDelayMinutes ?? 5;
  $('#scheduleModal').classList.add('show');
}

async function saveSchedule() {
  const btn = $('#btnSaveSchedule');
  btn.disabled = true;
  try {
    const r = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        time: $('#inpTime').value,
        retryTime: $('#inpRetry').value,          // 空字符串 = 关闭补跑
        randomDelayMinutes: Number($('#inpDelay').value || 0),
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '保存失败');
    sched = data.config;
    $('#schedLabel').textContent = sched.time;
    $('#schedEffective').textContent = `launchd 实际生效：${(data.effective || []).join(' / ')}`;
    toast(`已改为每天 ${sched.time}${sched.retryTime ? `（补跑 ${sched.retryTime}）` : ''}`);
    $('#scheduleModal').classList.remove('show');
    fetchState().catch(() => {});
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- toast ---------------- */

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

/* ---------------- 启动 ---------------- */

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await fetchState();
  } catch (e) {
    toast('读取状态失败：' + e.message, true);
  }
  connectEvents();
  // 客户端扫描只在展开「高级」面板时才跑，避免无意义的开机扫描
  const adv = document.querySelector('details.advanced');
  if (adv) adv.addEventListener('toggle', () => { if (adv.open) loadClients(); });
  loadSchedule();
  fetch('/api/login/status').then((r) => r.json()).then((s) => {
    if (s.status === 'running') toast('登录窗口还开着，完成扫码后会自动保存');
  }).catch(() => {});

  document.querySelectorAll('#filterSeg .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      render();
    }),
  );

  $('#btnSchedule').addEventListener('click', openSchedule);
  $('#btnCloseSchedule').addEventListener('click', () => $('#scheduleModal').classList.remove('show'));
  $('#btnSaveSchedule').addEventListener('click', saveSchedule);
  $('#scheduleModal').addEventListener('click', (e) => {
    if (e.target.id === 'scheduleModal') $('#scheduleModal').classList.remove('show');
  });

  $('#btnReport').addEventListener('click', async () => {
    const date = state?.today || new Date().toISOString().slice(0, 10);
    try {
      const r = await fetch(`/api/report?date=${date}`);
      const data = await r.json();
      $('#modalTitle').textContent = `日报 · ${date}`;
      $('#modalBody').innerHTML = r.ok
        ? renderMarkdown(data.markdown)
        : '<p class="muted">今天还没有运行记录。点「全部签到」跑一次。</p>';
      $('#modal').classList.add('show');
    } catch {
      toast('读取日报失败', true);
    }
  });
  $('#btnCloseModal').addEventListener('click', () => $('#modal').classList.remove('show'));
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') $('#modal').classList.remove('show');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#modal').classList.remove('show');
      $('#scheduleModal').classList.remove('show');
    }
  });

  $('#btnRunAll').addEventListener('click', () => startRun([], false));
  $('#btnDry').addEventListener('click', () => startRun([], true));
  $('#btnClearLog').addEventListener('click', () => logEl().replaceChildren());
  $('#btnScanClients').addEventListener('click', () => loadClients(true));

  // 每 60 秒刷新一次状态（定时任务跑完后页面不会立即知道）
  setInterval(() => fetchState().catch(() => {}), 60000);
});
