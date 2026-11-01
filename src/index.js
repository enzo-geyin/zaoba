#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveAdapters, saveConfig } from './config.js';
import { adapters } from './adapters/index.js';
import { createLogger } from './logger.js';
import { launchContext } from './browser.js';
import { runAll, RESULT_FILE, REPORT_DIR, alreadyDoneToday } from './runner.js';
import { loginCommand } from './login.js';
import { probeCommand } from './probe.js';
import { clientsCommand } from './clients.js';
import { getSchedule, applySchedule, readEffectiveSchedule, installSchedule, removeSchedule } from './schedule.js';
import { webCommand } from './server.js';
import { statusIcon, readResultsJSONL, summarizeResults } from './notify.js';
import { today } from './util.js';
import { acquireTaskLock, isTaskLockRetained } from './task-lock.js';

const HELP = `
早八 zaoba · 每天 8:30 替你领额度（详见 README.md / RESEARCH.md）

当前默认只启用「智谱清言」—— 六家里唯一确认能全自动签到的。
其余平台的调研结论见 RESEARCH.md；想加新平台看 README「加新平台」一节。

用法:
  npm run login                      打开浏览器，手动登录所有平台（只需偶尔做一次）
  npm run dry-run                    演练：检查登录态 + 能否找到签到按钮，不点击
  npm run checkin                    正式签到（会被 launchd 每天自动调用）
  npm run probe                      探测页面结构，输出可照抄的关键词/选择器建议
  npm run list                       列出平台及其启用状态
  npm run report                     查看今天的签到日报
  npm run clients                    扫描本机可接管的客户端（Electron/Chromium 壳）
  npm run clients -- --probe=豆包    实测某个客户端能否被接管
  npm run enable -- trae-cn          启用某个平台（disable 则停用）
  npm run schedule -- 08:30          修改每日运行时间（也可在网页控制台改）
  npm run service:install            安装定时任务（macOS=launchd / Windows=计划任务）
  npm run service:uninstall          移除定时任务
  npm run web                        打开本地可视化控制台（默认 http://127.0.0.1:7788）

可选参数（npm 传参需加 -- ，例如 npm run checkin -- --only=doubao）:
  --only=tongyi,kimi        只跑指定平台（逗号分隔）
  --headed                  显示浏览器窗口（排障时用，能看到实际点击）
  --date=2026-10-23         report 指定日期
  --quiet                   少打印日志
`;

function parseArgs(argv) {
  const out = { only: [], headed: false, date: null, quiet: false, dryRun: false, skipIfDone: false };
  for (const a of argv) {
    if (a.startsWith('--only=')) out.only = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--headed') out.headed = true;
    else if (a === '--headless') out.headed = false;
    else if (a.startsWith('--date=')) out.date = a.slice(7);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--allow-restart') out.allowRestart = true;
    else if (a === '--skip-if-done') out.skipIfDone = true;
    else if (a === '--force') out.skipIfDone = false;
    else if (a.startsWith('--probe=')) out.probe = a.slice(8);
  }
  return out;
}

function listCommand(cfg) {
  console.log('\n平台列表（config.json 里改 enabled 开关）:\n');
  // includeDisabled: 把 config 里的自定义平台 / 客户端平台也一起列出来
  for (const a of resolveAdapters(cfg, { includeDisabled: true })) {
    const pc = cfg.platforms[a.id] || {};
    const flag = pc.enabled ? '✓ 已启用' : '  已停用';
    console.log(`  ${flag}  ${a.id.padEnd(9)} ${a.name}${a.notes ? '  — ' + a.notes : ''}`);
  }
  console.log(`\n浏览器: headless=${cfg.headless}  profile=${path.resolve(cfg.userDataDir)}`);
  console.log(`定时: 每天 ${cfg.schedule.time} 起，随机延迟 0~${cfg.schedule.randomDelayMinutes} 分钟\n`);
}

function reportCommand(cfg, args) {
  const date = args.date || today();
  const all = readResultsJSONL(RESULT_FILE).filter((r) => r.date === date);
  if (!all.length) {
    console.log(`\n${date} 还没有签到记录。\n`);
    return;
  }
  const file = path.join(REPORT_DIR, `${date}.md`);
  console.log(`\n${date} 共 ${all.length} 条记录${fs.existsSync(file) ? `\n日报: ${file}` : ''}\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad('时间', 9)}${pad('平台', 14)}${pad('状态', 12)}说明`);
  for (const r of all) {
    console.log(`  ${pad((r.ts || '').split(' ')[1] || '', 9)}${pad(r.name, 14)}${pad(statusIcon(r.status) + ' ' + r.status, 12)}${(r.detail || '').slice(0, 80)}`);
  }
  console.log('');
}

async function main() {
  const cmd = (process.argv[2] || 'run').toLowerCase();
  const args = parseArgs(process.argv.slice(3));
  // 进程退出统一释放；登录助手的 process.exit 也能释放同一把锁。
  if (['run', 'dry-run', 'login', 'probe'].includes(cmd) || (cmd === 'clients' && args.probe)) acquireTaskLock();
  const cfg = loadConfig();

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(HELP);
    return;
  }

  if (cmd === 'list') return listCommand(cfg);

  const logger = createLogger('checkin', { silent: args.quiet });

  if (cmd === 'login') return loginCommand(cfg, logger);

  if (cmd === 'report') return reportCommand(cfg, args);

  if (cmd === 'probe') {
    return probeCommand(cfg, logger, { only: args.only });
  }

  if (cmd === 'schedule') {
    const raw = process.argv.slice(3);
    const getFlag = (name) => {
      const hit = raw.find((a) => a.startsWith(`--${name}=`));
      return hit ? hit.slice(name.length + 3) : undefined;
    };
    const timeArg = raw.find((a) => !a.startsWith('--'));
    const wantsChange = Boolean(timeArg || getFlag('time') || getFlag('retry') || getFlag('delay') !== undefined || process.argv.includes('--no-retry'));

    if (!wantsChange) {
      const cur = getSchedule();
      const eff = await readEffectiveSchedule();
      console.log('\n当前定时设置\n');
      console.log(`  主跑时间:   ${cur.time}（随机延迟 0~${cur.randomDelayMinutes} 分钟）`);
      console.log(`  补跑时间:   ${cur.retryTime || '已关闭'}`);
      console.log(`  launchd 实际生效: ${eff.join(' / ') || '(未安装)'}`);
      console.log('\n修改示例：');
      console.log('  node src/index.js schedule 08:30                # 改成 8:30');
      console.log('  node src/index.js schedule 07:45 --delay=10     # 7:45，随机延迟 10 分钟');
      console.log('  node src/index.js schedule 08:00 --no-retry     # 关掉中午补跑');
      console.log('  npm run schedule -- 07:45                       # 用 npm 也行\n');
      return;
    }

    const patch = {};
    const t = timeArg || getFlag('time');
    if (t) patch.time = t;
    const r = getFlag('retry');
    if (r) patch.retryTime = r;
    if (process.argv.includes('--no-retry')) patch.retryTime = '';
    const d = getFlag('delay');
    if (d !== undefined) patch.randomDelayMinutes = d;

    try {
      const sched = await applySchedule(patch);
      const eff = await readEffectiveSchedule();
      console.log(`\n✓ 已更新并重新加载 launchd`);
      console.log(`  主跑: ${sched.time}（+0~${sched.randomDelayMinutes} 分钟随机）`);
      console.log(`  补跑: ${sched.retryTime || '已关闭'}`);
      console.log(`  实际生效: ${eff.join(' / ')}`);
      console.log(`\n  控制台: npm run web  → 也可以直接在网页上改\n`);
    } catch (e) {
      console.error(`\n✗ 设置失败：${e.message}\n`);
      process.exitCode = 2;
    }
    return;
  }

  if (cmd === 'install-service' || cmd === 'uninstall-service') {
    try {
      if (cmd === 'install-service') {
        const res = await installSchedule({ logger });
        const eff = await readEffectiveSchedule();
        console.log(`\n✓ 已安装定时任务（${res.method}）`);
        console.log(`  主跑: ${res.time}（+0~${res.randomDelayMinutes} 分钟随机）`);
        console.log(`  补跑: ${res.retryTime || '已关闭'}`);
        console.log(`  实际生效: ${eff.join(' / ') || '(读取失败)'}`);
        console.log(`\n  提示: 控制台请用 npm run web 启动（Windows 可做成开机启动快捷方式）\n`);
      } else {
        await removeSchedule({ logger });
        console.log('\n✓ 已移除定时任务（数据与登录态保留）\n');
      }
    } catch (e) {
      console.error(`\n✗ ${cmd} 失败：${e.message}\n`);
      process.exitCode = 2;
    }
    return;
  }

  if (cmd === 'enable' || cmd === 'disable') {
    const id = process.argv[3];
    if (!id) {
      console.log('用法: node src/index.js enable <平台id>   （npm run enable -- trae-cn）');
      return;
    }
    const known = resolveAdapters(cfg, { includeDisabled: true }).find((a) => a.id === id);
    if (!known) {
      console.log(`没有这个平台: ${id}。可用平台见 npm run list`);
      return;
    }
    cfg.platforms[id] = { ...(cfg.platforms[id] || {}), enabled: cmd === 'enable' };
    saveConfig(cfg);
    console.log(`${cmd === 'enable' ? '✓ 已启用' : '· 已停用'} ${known.name}（${id}）`);
    return;
  }

  if (cmd === 'web') {
    const portArg = process.argv.find((a) => a.startsWith('--port='));
    return webCommand({ port: portArg ? Number(portArg.slice(7)) : 7788 });
  }

  if (cmd === 'clients') {
    return clientsCommand(cfg, logger, { probeName: args.probe });
  }

  if (cmd === 'run' || cmd === 'dry-run') {
    const dryRun = args.dryRun || cmd === 'dry-run';
    // 幂等保护：今天已经全部签完就直接退出，不再重复请求站点
    if (!resolveAdapters(cfg, { only: args.only }).length) {
      const known = resolveAdapters(cfg, { only: args.only, includeDisabled: true });
      if (known.length) {
        console.log(`\n这些平台存在但未启用：${known.map((a) => `${a.id}(${a.name})`).join('、')}`);
        console.log(`启用命令：node src/index.js enable ${known[0].id}\n`);
        return;
      }
    }

    let pendingOnly = args.only;
    if (args.skipIfDone && !dryRun) {
      const st = alreadyDoneToday(cfg, { only: args.only });
      if (st.allDone) {
        logger.info(`今天（${today()}）${st.total} 个平台已全部完成，跳过本次运行`);
        return;
      }
      pendingOnly = st.pending.map((a) => a.id);
      if (st.doneCount > 0) logger.info(`今天已完成 ${st.doneCount}/${st.total}，继续处理剩下的 ${st.pending.map((a) => a.name).join('、')}`);
    }

    // 全部都是 standalone（如客户端类签到）时，没必要启动 Chromium
    const needBrowser = resolveAdapters(cfg, { only: pendingOnly }).some((a) => !a.standalone && !a.unsupported);
    let ctx = null;
    if (needBrowser) ctx = await launchContext(cfg, { headless: args.headed ? false : cfg.headless, logger });
    let results = [];
    try {
      results = await runAll(ctx, cfg, { logger, only: pendingOnly, dryRun, skipIfDone: args.skipIfDone, allowRestart: args.allowRestart });
    } finally {
      if (ctx && !isTaskLockRetained()) await ctx.close().catch(() => null);
    }

    console.log('');
    for (const r of results) {
      console.log(`  ${statusIcon(r.status)} ${r.name.padEnd(12)} ${r.status.padEnd(11)} ${(r.detail || '').slice(0, 60)}`);
    }
    const ok = results.filter((r) => r.status === 'success' || r.status === 'already').length;
    console.log(`\n结果: ${ok}/${results.length} 完成`);
    if (results.some((r) => r.status === 'needs_login')) {
      console.log('有平台登录态失效，运行 npm run login 重新登录一次即可。\n');
    }
    const summary = summarizeResults(results, { dryRun });
    process.exitCode = summary.code;
    if (process.send) await new Promise((resolve) => process.send({ type: 'run-result', summary }, () => resolve()));
    // 只结束本次 CLI 工作进程；不结束用户客户端，遗留锁保留给人工核对。
    if (summary.fatal) process.exit(summary.code);
    return;
  }

  console.log(`未知命令: ${cmd}`);
  console.log(HELP);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error('未捕获异常:', e?.stack || e);
  if (isTaskLockRetained()) process.exit(3);
  process.exitCode = 1;
});
