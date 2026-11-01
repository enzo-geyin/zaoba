import { createHash, randomBytes } from 'node:crypto';
import { defineAdapter } from './base.js';
import { pageText, gotoSettled } from '../dom.js';

/**
 * 智谱清言（chatglm.cn）—— 本工具里唯一"真正全自动"的平台。
 *
 * 调研结论（2026-10，实时探测确认）：
 *   - 签到不是按钮，而是页面加载时前端自动调用的接口，所以不需要找 DOM、不需要点击
 *   - POST /chatglm/member-api/member/daily_login_score  body {}
 *       返回 status=10001 表示今日已领（幂等，可以盲调）
 *   - 签名可在本地算：X-Sign = md5(`${ts}-${nonce}-<secret>`)  ← 这是关键，不需要抓包
 *   - 登录态是 cookie: chatglm_token（约 24h）+ chatglm_refresh_token（约 50 天）
 *     页面加载时前端会自动调 /chatglm/user-api/user/refresh 续期，所以我们每次
 *     先打开一次首页，token 就自动刷新了，不用自己实现续期逻辑
 *   - 设备 ID 在 localStorage['chatglm-deid']，必须与 token 里的 device_id 一致
 *
 * 实测（未登录）：400 {"status":40003,"message":"bad request(40003)"}
 */

const APP_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';
const API_CHECKIN = '/chatglm/member-api/member/daily_login_score';
const API_MEMBER = '/chatglm/member-api/member/member_info';

/** 生成智谱要求的签名头。时间戳倒数第二位的校验位由业务侧算，这里直接按官方实现传毫秒串 */
export function buildZhipuHeaders(deviceId, { appVersion = '2.0.7' } = {}) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const sign = createHash('md5').update(`${ts}-${nonce}-${APP_SECRET}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'App-Name': 'chatglm',
    'X-App-Platform': 'pc',
    'X-App-Version': appVersion,
    'X-Device-Id': deviceId,
    'X-Timestamp': ts,
    'X-Nonce': nonce,
    'X-Sign': sign,
  };
}

export default defineAdapter({
  id: 'zhipu',
  name: '智谱清言',
  homepage: 'https://chatglm.cn/',
  entryUrls: ['https://chatglm.cn/'],
  keywords: ['签到', '每日登录', '领取'],
  doneKeywords: ['今日登录积分已到账', '今日已领取'],
  enabledByDefault: true,
  notes:
    '唯一支持纯接口自动签到的平台，默认启用。单账号每日一次，幂等安全；token 24h 过期但打开首页会自动续期。',

  custom: async ({ page, logger }) => {
    // 1) 打开首页：让前端自己完成 token 续期，同时确保当前 origin 是 chatglm.cn（同源才带 cookie）
    await gotoSettled(page, 'https://chatglm.cn/', logger, { settle: 1500 });
    await pageText(page, 2000);

    // 2) 取设备 ID（必须与 token 内 device_id 一致，否则 40003）
    const deid = await page
      .evaluate(() => localStorage.getItem('chatglm-deid') || '')
      .catch(() => '');
    if (!deid) logger.warn('未读到 chatglm-deid，使用随机设备 ID（可能被判为陌生设备）');
    const deviceId = deid || crypto.randomUUID();
    const headers = buildZhipuHeaders(deviceId);

    // 3) 在页面上下文里发请求：cookie、origin、UA 全部天然正确，不需要手工拼 Cookie 头
    const res = await page.evaluate(
      async ({ headers, apiCheckin, apiMember }) => {
        const call = async (url, method = 'POST') => {
          try {
            const r = await fetch(url, {
              method,
              headers,
              body: method === 'POST' ? '{}' : undefined,
              credentials: 'include',
            });
            const text = await r.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* 非 JSON 响应 */
            }
            return { http: r.status, json, text: text.slice(0, 300) };
          } catch (e) {
            return { http: 0, error: String(e && e.message ? e.message : e) };
          }
        };
        return {
          checkin: await call(apiCheckin, 'POST'),
          member: await call(apiMember, 'GET'),
        };
      },
      { headers, apiCheckin: API_CHECKIN, apiMember: API_MEMBER },
    );

    return interpretZhipuResponse(res, logger);
  },
});

/** 只接受已知业务码；HTTP 200、HTML、空对象都不是签到成功证据。 */
export function interpretZhipuResponse(res, logger) {
    const ck = res?.checkin || {};
    const body = ck.json && typeof ck.json === 'object' && !Array.isArray(ck.json) ? ck.json : {};
    const code = String(body.status ?? body.code ?? '');
    logger.step(`签到接口 HTTP ${ck.http} code=${code || '-'} msg=${body.message || body.msg || ''}`);

    // 未登录 / token 失效
    if (ck.http === 401 || code === '40003' || code === '40102' || code === '401') {
      return { status: 'needs_login', detail: `签到接口返回未登录(${code || ck.http})，请点卡片上的「去登录」（或运行 npm run login）` };
    }

    // 今日已领（幂等，正常情况）
    if (ck.http === 200 && code === '10001') {
      const pts = readPoints(res.member);
      return { status: 'already', detail: `今日登录积分已领取${pts !== null ? `，当前积分 ${pts}` : ''}`, meta: { credits: pts } };
    }

    // 成功
    if (ck.http === 200 && (code === '10000' || code === '0')) {
      const pts = readPoints(res.member);
      const gained = body.result?.score ?? body.result?.left_score ?? null;
      const gainTxt = gained !== null && gained !== undefined ? `+${Number(gained) / (Number(gained) > 1000 ? 100 : 1)}` : '';
      return {
        status: 'success',
        detail: `签到成功${gainTxt ? ` ${gainTxt} 积分` : ''}${pts !== null ? `，当前积分 ${pts}` : ''}`,
        meta: { credits: pts, todayCredit: gained !== null ? Number(gained) : undefined },
      };
    }

    return {
      status: ck.http === 200 ? 'uncertain' : 'failed',
      detail: `无法确认签到：HTTP ${ck.http}，业务码 ${code || '缺失'}；${body.message || body.msg || ck.error || '响应不符合已知协议'}`,
    };
}

/** member_info 的 left_score 是 1/100 精度 */
function readPoints(member) {
  try {
    const v = member?.json?.result?.left_score ?? member?.json?.result?.data?.left_score;
    if (v === undefined || v === null) return null;
    const n = Number(v) / 100;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
