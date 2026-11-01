import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

export function summary() {
  return {
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    supported: isWindows || isMacOS,
    scheduler: isWindows ? 'schtasks' : isMacOS ? 'launchd' : 'none',
  };
}

/* ------------------------------------------------------------------ *
 * 已知客户端的默认安装路径（按系统）
 * ------------------------------------------------------------------ */

const WIN_LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const WIN_PF = process.env.ProgramFiles || 'C:\\Program Files';
const WIN_PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

export const knownAppPaths = {
  workbuddy: isMacOS
    ? ['/Applications/WorkBuddy.app']
    : [
        path.join(WIN_LOCAL, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
        path.join(WIN_PF, 'WorkBuddy', 'WorkBuddy.exe'),
        path.join(WIN_PF86, 'WorkBuddy', 'WorkBuddy.exe'),
        path.join(WIN_LOCAL, 'WorkBuddy', 'WorkBuddy.exe'),
      ],
  doubaowork: isMacOS
    ? ['/Applications/DoubaoWork.app']
    : [
        path.join(WIN_LOCAL, 'Programs', 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_PF, 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_PF86, 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_LOCAL, 'DoubaoWork', 'DoubaoWork.exe'),
      ],
  doubao: isMacOS
    ? ['/Applications/Doubao.app']
    : [path.join(WIN_LOCAL, 'Programs', 'Doubao', 'Doubao.exe'), path.join(WIN_PF, 'Doubao', 'Doubao.exe')],
  trae: isMacOS ? ['/Applications/Trae CN.app'] : [path.join(WIN_LOCAL, 'Programs', 'Trae CN', 'Trae CN.exe')],
  qoder: isMacOS ? ['/Applications/Qoder.app'] : [path.join(WIN_LOCAL, 'Programs', 'Qoder', 'Qoder.exe')],
};

/** 各客户端平台的官方下载页（用于「去下载」按钮） */
export const downloadUrls = {
  workbuddy: 'https://copilot.tencent.com/',
  doubaowork: 'https://www.doubao.com/download/',
  'doubaowork-client': 'https://www.doubao.com/download/',
  trae: 'https://www.trae.cn/',
  'trae-cn': 'https://www.trae.cn/',
  qoder: 'https://qoder.com/',
  'qoder-cn': 'https://qoder.com/',
  doubao: 'https://www.doubao.com/download/',
  'doubao-client': 'https://www.doubao.com/download/',
};

/* ------------------------------------------------------------------ *
 * 可执行文件解析
 * ------------------------------------------------------------------ */

/** macOS: 传 .app 目录时解析出里面的可执行文件；Windows/Linux: 直接用路径 */
export function resolveExecutable(appOrBin) {
  if (!appOrBin) throw new Error('缺少 app/bin 配置');
  if (isMacOS && appOrBin.endsWith('.app')) {
    const macosDir = path.join(appOrBin, 'Contents', 'MacOS');
    const exe = fs.readdirSync(macosDir).find((f) => !f.startsWith('.'));
    if (!exe) throw new Error(`${appOrBin} 里找不到可执行文件`);
    return path.join(macosDir, exe);
  }
  return appOrBin;
}

/** 从候选路径里挑第一个存在的（用于跨平台默认路径） */
export function pickAppPath(candidates = []) {
  for (const c of candidates) {
    if (!c) continue;
    if (fs.existsSync(c)) return c;
  }
  return candidates[0] || null;
}

/* ------------------------------------------------------------------ *
 * 进程检测与退出
 * ------------------------------------------------------------------ */

export async function isProcessRunning(execPath) {
  if (!execPath) return false;
  if (isWindows) {
    const name = path.basename(execPath).replace(/\.exe$/i, '');
    try {
      const { stdout } = await exec('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/NH', '/FO', 'CSV'], { timeout: 8000 });
      return stdout.toLowerCase().includes(`${name.toLowerCase()}.exe`);
    } catch {
      return false;
    }
  }
  try {
    const { stdout } = await exec('pgrep', ['-f', execPath], { timeout: 8000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 请求正常退出；用户取消或客户端繁忙时停止，绝不升级为强制结束。 */
export async function gracefulQuit({ appName, execPath, logger, waitMs = 8000 } = {}) {
  const running = () => isProcessRunning(execPath);
  if (!(await running())) return true;
  if (isMacOS) {
    const target = appName || (execPath || '').match(/([^/]+)\.app\//)?.[1] || '';
    if (!target) return false;
    const escaped = target.replace(/["\\]/g, '\\$&');
    await exec('osascript', ['-e', `quit app "${escaped}"`], { timeout: waitMs }).catch(() => null);
  } else if (isWindows) {
    const name = path.basename(execPath || '').replace(/\.exe$/i, '').replace(/'/g, "''");
    await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }`,
    ], { timeout: waitMs }).catch(() => null);
  } else {
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await running())) return true;
    await sleep(250);
  }
  logger?.warn('客户端未正常退出，已停止重启；不会强制结束，请先保存工作后手动退出');
  return false;
}

/** 只清理本次 spawn 的进程句柄，不使用应用名或路径批量杀进程。 */
export async function quitOwnedProcess(child, logger) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${Number(child.pid)} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`,
    ], { timeout: 5000 }).catch(() => null);
  } else {
    child.kill('SIGTERM');
  }
  logger?.step(`已请求关闭本次启动的客户端 PID ${child.pid}（不强制结束）`);
}

/* ------------------------------------------------------------------ *
 * 通知
 * ------------------------------------------------------------------ */

function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

export async function notify(title, message, { sound = true } = {}) {
  if (isMacOS) {
    const esc = (s) => String(s).replace(/["\\\n\r]/g, (c) => ({ '"': '\\"', '\\': '\\\\', '\n': ' ', '\r': ' ' })[c]);
    const script = `display notification "${esc(message)}" with title "${esc(title)}"${sound ? ' sound name "Glass"' : ''}`;
    try {
      await exec('osascript', ['-e', script], { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  if (isWindows) {
    // 用 WinForms 气泡通知，不依赖第三方模块
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.BalloonTipTitle = \'' + psQuote(title) + '\'',
      '$n.BalloonTipText = \'' + psQuote(message) + '\'',
      '$n.Visible = $true',
      '$n.ShowBalloonTip(8000)',
      'Start-Sleep -Seconds 7',
      '$n.Dispose()',
    ].join('; ');
    try {
      await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * 定时任务：macOS = launchd，Windows = 计划任务（schtasks）
 * ------------------------------------------------------------------ */

function macPlistXml({ label, projectDir, scriptPath, times }) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = times
    .map((t) => {
      const [h, m] = t.split(':').map(Number);
      return `    <dict>\n      <key>Hour</key>\n      <integer>${h}</integer>\n      <key>Minute</key>\n      <integer>${m}</integer>\n    </dict>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(projectDir)}</string>
  <key>StartCalendarInterval</key>
  <array>
${blocks}
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${esc(os.homedir())}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(projectDir)}/data/log/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${esc(projectDir)}/data/log/launchd.err.log</string>
</dict>
</plist>
`;
}

/** Windows 计划任务 XML：错过（睡眠）后补跑 + 唤醒计算机执行 */
export function buildWindowsTaskXml({ time, nodeBin, scriptPath, projectDir = path.dirname(path.dirname(scriptPath)) }) {
  const [h, m] = String(time).split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const start = `2026-01-01T${pad(h)}:${pad(m)}:00`;
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>早八 zaoba 每日自动签到</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${start}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(nodeBin)}</Command>
      <Arguments>"${esc(scriptPath)}"</Arguments>
      <WorkingDirectory>${esc(projectDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function schedulerLabel(base = 'com.local.ai-daily-checkin') {
  return base;
}

export function schedulerPath(base = 'com.local.ai-daily-checkin') {
  if (isWindows) return null;
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${base}.plist`);
}

/** 只有 launchctl 的"暂时拒绝"（EIO）才值得等待重试；参数或权限错误要立即失败。 */
function isTransientBootstrapError(error) {
  return /input\/output|EIO|error 5/i.test(`${error?.stderr || ''} ${error?.message || ''}`);
}

/**
 * 注册单个 launchd 任务，返回是否成功（不抛异常）。
 * 注意：标签已被注册时 launchctl 会以 EIO 失败，所以调用前必须先 bootout。
 */
async function bootstrapLaunchd({ execFn, domain, plist }) {
  try {
    await execFn('launchctl', ['bootstrap', domain, plist], { timeout: 8000 });
    return true;
  } catch (e) {
    if (!isTransientBootstrapError(e)) throw e;
    return false;
  }
}

/**
 * 卸载并重新注册，直到 launchd 的真实状态与请求一致。
 * bootout 是异步的，紧跟着 bootstrap 常以 EIO 失败，因此每次重试前都静置更久。
 */
async function reinstallLaunchd({ execFn, label, uid, plist, expected, waitFn }) {
  const settle = [800, 5000, 15000];
  let effective = [];
  let lastError = null;
  for (let i = 0; i < settle.length; i += 1) {
    await execFn('launchctl', ['bootout', `gui/${uid}/${label}`], { timeout: 8000 }).catch(() => null);
    await waitFn(settle[i]);
    try {
      if (await bootstrapLaunchd({ execFn, domain: `gui/${uid}`, plist })) {
        effective = await schedulerEffective({ label, osName: 'darwin', execFn });
        if (effective.join(',') === expected.join(',')) return effective;
      }
    } catch (e) { lastError = e; }
  }
  if (lastError) throw lastError;
  throw new Error(`launchd 已写入 ${plist}，但系统回读为 [${effective.join(',') || '空'}]，与请求 [${expected.join(',')}] 不一致。请手动执行：launchctl bootstrap gui/${uid} ${plist}`);
}

/** 安装定时任务：times 为 ['08:00','12:30'] */
export async function installScheduler({ label = 'com.local.ai-daily-checkin', projectDir, scriptPath, times, logger, osName = process.platform, execFn = exec, plistFile, uid = process.getuid?.() ?? 0, waitFn = sleep }) {
  const valid = [...new Set(times.filter(Boolean))];
  if (!valid.length || valid.length > 3 || valid.some((t) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error('需要 1~3 个有效的 HH:MM 时间点');

  if (osName === 'darwin') {
    const plist = plistFile || schedulerPath(label);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const previous = fs.existsSync(plist) ? fs.readFileSync(plist) : null;
    const next = macPlistXml({ label, projectDir, scriptPath, times: valid });
    fs.mkdirSync(path.join(projectDir, 'data/log'), { recursive: true });
    try {
      fs.writeFileSync(plist, next, 'utf8');
      await reinstallLaunchd({ execFn, label, uid, plist, expected: [...valid].sort(), waitFn });
    } catch (error) {
      // 仅恢复本次替换的定义，不通过 kickstart 立即运行签到。
      let recovery = `已写入 ${plist}，下次登录会自动加载，或手动执行：launchctl bootstrap gui/${uid} ${plist}`;
      try {
        if (!fs.existsSync(plist) || fs.readFileSync(plist, 'utf8') !== next) throw new Error('任务定义已被并发修改，未覆盖');
        if (previous) {
          await execFn('launchctl', ['bootout', `gui/${uid}/${label}`], { timeout: 8000 }).catch(() => null);
          fs.writeFileSync(plist, previous);
          await bootstrapLaunchd({ execFn, domain: `gui/${uid}`, plist });
          recovery = '已恢复原任务定义';
        }
      } catch (e) { recovery = `恢复失败：${e.message}`; }
      throw new Error(`定时设置未确认生效：${error.message}；${recovery}`);
    }
    return { method: 'launchd', plist, times: valid };
  }

  if (osName === 'win32') {
    const names = ['ZaobaDailyCheckin', 'ZaobaDailyCheckin2', 'ZaobaDailyCheckin3'];
    const originals = new Map();
    const changes = new Map();
    const query = async (name) => {
      try { return (await execFn('schtasks', ['/Query', '/TN', name, '/XML'], { timeout: 15000 })).stdout; }
      catch (e) {
        if (/cannot find|does not exist|找不到|不存在/i.test(`${e.stderr || ''} ${e.message}`)) return null;
        throw e;
      }
    };
    for (const name of names) originals.set(name, await query(name));
    const created = [];
    try {
    for (const [i, t] of valid.entries()) {
      const taskName = i === 0 ? 'ZaobaDailyCheckin' : `ZaobaDailyCheckin${i + 1}`;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaoba-task-'));
      const xmlPath = path.join(tempDir, 'task.xml');
      const xmlText = buildWindowsTaskXml({ time: t, nodeBin: process.execPath, scriptPath, projectDir });
      try {
        fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xmlText, 'utf16le')]));
        // 不先删旧任务；注册失败时保留原任务，不静默降级为缺少唤醒/工作目录的版本。
        await execFn('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'], { timeout: 25000 });
        const stdout = await query(taskName);
        changes.set(taskName, stdout);
        const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        if (!stdout?.includes(`<StartBoundary>2026-01-01T${t}:00</StartBoundary>`) || !stdout.includes(`<WorkingDirectory>${esc(projectDir)}</WorkingDirectory>`) || !stdout.includes(`<Command>${esc(process.execPath)}</Command>`)) {
          throw new Error(`计划任务 ${taskName} 回读不匹配；可能已部分更新，请检查系统任务`);
        }
      } finally {
        if (fs.existsSync(xmlPath)) fs.unlinkSync(xmlPath);
        fs.rmdirSync(tempDir);
      }
      created.push(taskName);
    }
    // 关闭补跑必须删除旧的额外任务，而不仅是不再创建它。
    for (const taskName of names.slice(valid.length)) {
      if (await query(taskName) === null) continue;
      await execFn('schtasks', ['/Delete', '/TN', taskName, '/F'], { timeout: 15000 });
      changes.set(taskName, null);
      if (await query(taskName) !== null) throw new Error(`旧补跑任务 ${taskName} 未移除`);
    }
    } catch (error) {
      const recovery = [];
      for (const [name, written] of [...changes].reverse()) {
        try {
          if (await query(name) !== written) { recovery.push(`${name} 已有并发改动，未覆盖`); continue; }
          const previous = originals.get(name);
          if (previous === null) {
            if (written !== null) await execFn('schtasks', ['/Delete', '/TN', name, '/F'], { timeout: 15000 });
          } else {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaoba-restore-'));
            const file = path.join(dir, 'task.xml');
            try {
              fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(previous.replace(/^\uFEFF/, ''), 'utf16le')]));
              await execFn('schtasks', ['/Create', '/TN', name, '/XML', file, '/F'], { timeout: 25000 });
            } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(dir); }
          }
          if (await query(name) !== previous) throw new Error('恢复回读不匹配');
          recovery.push(`${name} 已恢复`);
        } catch (e) { recovery.push(`${name} 恢复未确认：${e.message}`); }
      }
      throw new Error(`Windows 定时更新失败：${error.message}；${recovery.join('；') || '未确认任何成功写入，请检查系统任务'}`);
    }
    logger?.info(`已创建 Windows 计划任务: ${created.join(', ')}（含"错过则唤醒补跑"）`);
    return { method: 'schtasks', tasks: created, times: valid };
  }

  throw new Error(`当前系统（${process.platform}）暂不支持安装定时任务`);
}

export async function removeScheduler({ label = 'com.local.ai-daily-checkin', logger } = {}) {
  if (isMacOS) {
    const plist = schedulerPath(label);
    const uid = process.getuid();
    await exec('launchctl', ['bootout', `gui/${uid}/${label}`]).catch(() => null);
    if (fs.existsSync(plist)) fs.rmSync(plist, { force: true });
    return true;
  }
  if (isWindows) {
    for (const name of ['ZaobaDailyCheckin', 'ZaobaDailyCheckin2', 'ZaobaDailyCheckin3']) {
      await exec('schtasks', ['/Delete', '/TN', name, '/F'], { timeout: 15000 }).catch(() => null);
    }
    logger?.info('已删除 Windows 计划任务');
    return true;
  }
  return false;
}

/** 解析 launchctl print 的运行中日历触发器；未知格式宁可未确认，不回退到磁盘 plist。 */
export function parseLaunchdTimes(output) {
  const times = [];
  for (const match of String(output).matchAll(/descriptor\s*=\s*\{([^{}]*)\}/g)) {
    const h = match[1].match(/"?Hour"?\s*(?:=>|=)\s*(\d+)/);
    const m = match[1].match(/"?Minute"?\s*(?:=>|=)\s*(\d+)/);
    if (h && m && Number(h[1]) < 24 && Number(m[1]) < 60) times.push(`${h[1].padStart(2, '0')}:${m[1].padStart(2, '0')}`);
  }
  return times.sort();
}

/** 只读运行中系统任务，不把已保存的文件当成生效证据。 */
export async function schedulerEffective({ label = 'com.local.ai-daily-checkin', osName = process.platform, execFn = exec } = {}) {
  if (osName === 'darwin') {
    try {
      const { stdout } = await execFn('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`], { timeout: 8000 });
      return parseLaunchdTimes(stdout);
    } catch (e) {
      if (/could not find service|找不到|不存在/i.test(`${e.stderr || ''} ${e.message}`)) return [];
      throw new Error(`无法读取 launchd 实际状态：${e.message}`);
    }
  }

  if (osName === 'win32') {
    const out = [];
    for (const name of ['ZaobaDailyCheckin', 'ZaobaDailyCheckin2', 'ZaobaDailyCheckin3']) {
      try {
        const { stdout } = await execFn('schtasks', ['/Query', '/TN', name, '/XML'], { timeout: 15000 });
        const m = stdout.match(/<StartBoundary>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        if (m && !/<Enabled>\s*false\s*<\/Enabled>/i.test(stdout)) out.push(m[1].slice(11, 16));
      } catch (e) {
        if (!/cannot find|does not exist|找不到|不存在/i.test(`${e.stderr || ''} ${e.message}`)) throw e;
      }
    }
    return out;
  }
  return [];
}

/** 删除所有平台数据/配置前需要用户确认的提示语 */
export function platformNotes() {
  if (isWindows) {
    return [
      'Windows 下客户端需手动安装并登录；早八通过调试端口接管。',
      '首次创建计划任务时如果提示权限不足，请用「以管理员身份运行」的 PowerShell 重试一次。',
    ];
  }
  return [];
}

export default {
  isWindows,
  isMacOS,
  isLinux,
  summary,
  resolveExecutable,
  pickAppPath,
  isProcessRunning,
  gracefulQuit,
  quitOwnedProcess,
  notify,
  installScheduler,
  removeScheduler,
  schedulerEffective,
  schedulerLabel,
  schedulerPath,
  platformNotes,
  knownAppPaths,
  downloadUrls,
  buildWindowsTaskXml,
};
