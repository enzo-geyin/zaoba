import fs from 'node:fs';
import path from 'node:path';
import { adapters, adapterById } from './adapters/index.js';
import { runClientApp } from './adapters/clientApp.js';
import platform from './platform.js';

/** Windows 上优先用系统自带 Edge（0 下载），macOS 保持 Playwright 自带 Chromium */
function defaultChannel() {
  if (!platform.isWindows) return undefined;
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return edgePaths.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  })
    ? 'msedge'
    : undefined;
}
import { readJSON, writeJSON } from './util.js';

export const CONFIG_FILE = path.resolve('config.json');

/** 只有这几个字段允许被 config.json 覆盖，避免用户误写导致适配器坏掉 */
const OVERRIDABLE = ['homepage', 'loginUrl', 'entryUrls', 'keywords', 'doneKeywords', 'statusSelector', 'api', 'notes'];

const DEFAULT_KEYWORDS = ['签到', '每日签到', '立即签到', '打卡', '领取', '立即领取'];

/**
 * 内置的"客户端类"平台（签到在桌面客户端里）。
 * 这些不是网页，走 runClientApp：拉起客户端 → CDP 接管 → 操作 → 退出。
 * 默认全部关闭：客户端签到依赖具体活动/版本，需要你实测确认后再开。
 */
const CLIENT_PLATFORM_DEFAULTS = {
  // 注意 key 不能和内置网页适配器同名（doubao / yuanbao 等），否则会走网页路径
  'doubao-client': {
    enabled: false,
    type: 'client',
    name: '豆包',
    app: platform.knownAppPaths.doubao[0],
    appCandidates: platform.knownAppPaths.doubao,
    port: 9445,
    cdpMode: 'arg',
    pageUrlMatch: 'doubao-chat',
    keywords: ['签到', '每日签到', '领取', '立即领取'],
    doneKeywords: ['今日已签到', '已签到', '明天再来'],
    notes: '2026-10 实测：客户端可被 CDP 接管，但当前版本未发现稳定签到入口（活动弹窗为远程投放）',
  },
  'trae-cn': {
    enabled: false,
    type: 'client',
    name: 'Trae CN',
    app: platform.knownAppPaths.trae[0],
    appCandidates: platform.knownAppPaths.trae,
    port: 9223, // 9222 常被其它 Chromium 应用占用，默认换 9223
    cdpMode: 'arg',
    autoRestart: false,
    quitAppName: 'Trae CN',
    // 签到入口在"账户菜单"里，必须先点开账户按钮
    pageUrlMatch: 'vscode-app', // 主界面是 workbench，另有悬浮按钮等页面
    // 账户菜单是切换式的：这些文案出现说明菜单已打开，不要再点
    menuOpenTexts: ['每日领 100 积分', '邀请好友得积分', '已签到'],
    beforeClickSelectors: ['[class*="accountTrigger"]', 'button[class*="accountTrigger"]', '[class*="account-trigger"]'],
    keywords: ['签到', '立即签到'],
    doneKeywords: ['已签到', '今日已签到', '明日再来', '今日已领'],
    notes:
      '需先安装 Trae 国内版并登录（国际版 trae.ai 没有签到）。入口：左下角头像→签到。走 CDP 点真客户端，绕开设备绑定（网页 token 去签会返回 9074）',
  },
  'qoder-cn': {
    enabled: false,
    type: 'client',
    name: 'Qoder CN',
    app: platform.knownAppPaths.qoder[0],
    appCandidates: platform.knownAppPaths.qoder,
    port: 9224,
    cdpMode: 'arg',
    clickSelectors: ['[class*="gift"]', '[class*="Gift"]', '[class*="check-in"]', '[class*="checkin"]'],
    keywords: ['领取', '签到', '立即领取'],
    doneKeywords: ['已领取', '明天再来', '已签到'],
    notes:
      '需先安装 Qoder 国内版并登录。入口：左下角「用量面板→礼物图标」，每日 100 Credits（10:00→次日 10:00，错过不补）。旧 /daily-check-in 接口已 DISABLED，现走活动平台',
  },
  'doubaowork-client': {
    enabled: true,
    type: 'client',
    name: '豆包工作',
    app: platform.knownAppPaths.doubaowork[0],
    appCandidates: platform.knownAppPaths.doubaowork,
    port: 9444,
    cdpMode: 'arg',
    // 「免费用豆包」侧边面板就是任务中心，首项是每日签到（+200 额度）
    openUrl: 'https://www.doubao.com/pc/agent-explore',
    keywords: ['立即签到'],
    doneKeywords: ['已领取', '今日已签到', '明天再来'],
    autoRestart: false,
    quitAppName: 'DoubaoWork',
    keepRunning: true,
    notes: '每日签到 +200 额度（在「免费用豆包」面板里）；脚本会自动打开该面板并点「立即签到」',
  },
};
const DEFAULT_DONE = ['今日已签到', '已签到', '已领取', '明天再来', '今日已完成'];

export function defaultConfig() {
  const platforms = {};
  for (const a of adapters) {
    platforms[a.id] = {
      enabled: a.enabledByDefault,
      entryUrls: [...a.entryUrls],
      keywords: [...a.keywords],
      doneKeywords: [...a.doneKeywords],
    };
  }
  return {
    headless: true,
    channel: null,
    userDataDir: './profile',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    actionTimeout: 15000,
    navTimeout: 45000,
    platformTimeout: 120000,
    screenshotKeepDays: 7,
    schedule: { time: '08:00', retryTime: '12:30', randomDelayMinutes: 5 },
    notify: { macos: true, sound: true, webhookUrl: '' },
    security: { allowJsEval: false },
    platforms: { ...CLIENT_PLATFORM_DEFAULTS, ...platforms },
  };
}

export function loadConfig({ createIfMissing = true } = {}) {
  const def = defaultConfig();
  const exists = fs.existsSync(CONFIG_FILE);
  const existing = readJSON(CONFIG_FILE, {});
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('config.json 必须是 JSON 对象');
  if (!exists && createIfMissing) {
    writeJSON(CONFIG_FILE, def);
    console.log(`已生成默认配置: ${CONFIG_FILE}`);
  }

  // 老配置里可能还没有新加的内置客户端平台：补进去并落盘，否则用户在 config.json 里看不到也改不了
  if (exists && createIfMissing) {
    const raw = readJSON(CONFIG_FILE, {});
    const missing = Object.keys(CLIENT_PLATFORM_DEFAULTS).filter((k) => !raw.platforms?.[k]);
    if (missing.length) {
      raw.platforms = { ...CLIENT_PLATFORM_DEFAULTS, ...(raw.platforms || {}) };
      writeJSON(CONFIG_FILE, { ...def, ...raw, notify: { ...def.notify, ...(raw.notify || {}) }, schedule: { ...def.schedule, ...(raw.schedule || {}) } });
      console.log(`已向 config.json 补充客户端平台: ${missing.join(', ')}`);
    }
  }

  const user = readJSON(CONFIG_FILE, {});

  const cfg = { ...def, ...user };
  cfg.notify = { ...def.notify, ...(user.notify || {}) };
  cfg.schedule = { ...def.schedule, ...(user.schedule || {}) };

  // 内置客户端平台：默认值 + 用户覆盖（逐字段合并，避免老配置吞掉新增字段）
  const userPlatforms = user.platforms || {};
  const mergedPlatforms = {};
  for (const [id, def] of Object.entries(CLIENT_PLATFORM_DEFAULTS)) {
    mergedPlatforms[id] = { ...def, ...(userPlatforms[id] || {}) };
  }
  for (const [id, u] of Object.entries(userPlatforms)) {
    mergedPlatforms[id] = { ...(mergedPlatforms[id] || {}), ...u };
  }
  cfg.platforms = mergedPlatforms;
  for (const a of adapters) {
    cfg.platforms[a.id] = { ...def.platforms[a.id], ...(user.platforms?.[a.id] || {}) };
  }
  return cfg;
}

export function saveConfig(cfg) {
  writeJSON(CONFIG_FILE, cfg);
}

/**
 * 把 config.json 里的覆盖项合并进适配器对象。
 *
 * 除了内置适配器，还支持在 config.json 里直接"注册"任意新平台（无需改代码）：
 *
 *   "platforms": {
 *     "trae": { "enabled": true, "name": "Trae", "url": "https://www.trae.com.cn/",
 *               "keywords": ["签到","领取"], "doneKeywords": ["今日已签到"] }
 *   }
 *
 * 这类平台走通用浏览器流程（打开 → 找关键词按钮 → 点击 → 判结果）。
 */
export function resolveAdapters(cfg, { only = [], includeDisabled = false } = {}) {
  const out = [];

  for (const a of adapters) {
    const pc = cfg.platforms[a.id] || {};
    if (!includeDisabled && !pc.enabled) continue;
    if (only.length && !only.includes(a.id)) continue;
    const merged = { ...a };
    for (const k of OVERRIDABLE) {
      if (pc[k] !== undefined && pc[k] !== null) merged[k] = pc[k];
    }
    out.push(merged);
  }

  // 自定义平台（config 里出现、但没有内置适配器的 key）
  for (const [id, pc] of Object.entries(cfg.platforms)) {
    if (adapterById.has(id)) continue;
    if (!includeDisabled && !pc.enabled) continue;
    if (only.length && !only.includes(id)) continue;
    // 客户端类：签到在桌面客户端里，走 CDP 接管
    if (pc.type === 'client' || pc.app) {
      if (!pc.app) continue;
      out.push({
        id,
        name: pc.name || id,
        standalone: true,
        timeout: Number(pc.timeout || 180000),
        homepage: '',
        entryUrls: [],
        keywords: pc.keywords || DEFAULT_KEYWORDS,
        doneKeywords: pc.doneKeywords || DEFAULT_DONE,
        notes: pc.notes || '自定义客户端（config.json 配置）',
        enabledByDefault: true,
        clientApp: true,
        custom: (args) => runClientApp({ ...pc, name: pc.name || id }, args),
      });
      continue;
    }

    const url = pc.url || pc.homepage || pc.entryUrls?.[0];
    if (!url) continue;
    out.push({
      id,
      name: pc.name || id,
      homepage: url,
      loginUrl: pc.loginUrl || url,
      entryUrls: Array.isArray(pc.entryUrls) && pc.entryUrls.length ? pc.entryUrls : [url],
      keywords: Array.isArray(pc.keywords) && pc.keywords.length ? pc.keywords : DEFAULT_KEYWORDS,
      doneKeywords: Array.isArray(pc.doneKeywords) && pc.doneKeywords.length ? pc.doneKeywords : DEFAULT_DONE,
      statusSelector: pc.statusSelector,
      api: null,
      custom: null,
      notes: pc.notes || '自定义平台（config.json 里配置）',
      enabledByDefault: true,
      customPlatform: true,
    });
  }

  return out;
}
