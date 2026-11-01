import { setTimeout as delay } from 'node:timers/promises';

export class TimeoutError extends Error {}
export class UnsafeTimeoutError extends TimeoutError {
  fatal = true;
}

/** 取消后只给有限清理时间；无法确认退出时必须停止整轮，不能继续下一平台。 */
export async function withDeadline(work, ms, label, { cleanupGraceMs = 5000 } = {}) {
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(cleanupGraceMs) || cleanupGraceMs <= 0) throw new Error('超时和清理宽限必须为正数');
  const controller = new AbortController();
  const cleanups = new Set();
  const pending = new Set();
  let cleanupFailed = false;
  const startCleanup = (fn) => {
    const p = Promise.resolve().then(fn).catch(() => { cleanupFailed = true; });
    pending.add(p);
    p.finally(() => pending.delete(p));
  };
  let expire;
  const expired = new Promise((resolve) => { expire = resolve; });
  const timer = setTimeout(() => {
    controller.abort(new TimeoutError(`${label}超时（${Math.round(ms / 1000)}s）`));
    for (const fn of cleanups) startCleanup(fn);
    expire();
  }, ms);
  // 把拒绝转成结果，非协作任务迟到的拒绝也不会成为未处理异常。
  const task = Promise.resolve().then(() => work(controller.signal, (fn) => {
    if (controller.signal.aborted) startCleanup(fn);
    else cleanups.add(fn);
  })).then((value) => ({ value }), (error) => ({ error }));
  let graceTimer;
  try {
    const outcome = await Promise.race([task, expired]);
    if (!controller.signal.aborted) {
      if (outcome.error) throw outcome.error;
      return outcome.value;
    }
    const drained = task.then(async () => {
      while (pending.size) await Promise.all([...pending]);
      return true;
    });
    const safe = await Promise.race([drained, new Promise((resolve) => {
      graceTimer = setTimeout(() => resolve(false), cleanupGraceMs);
    })]);
    if (!safe || cleanupFailed) throw new UnsafeTimeoutError(`${label}超时后未能确认安全退出；已停止整轮，请人工确认任务及遗留锁`);
    throw controller.signal.reason;
  } finally {
    clearTimeout(timer);
    clearTimeout(graceTimer);
  }
}

export const abortableSleep = (ms, signal) => delay(ms, undefined, { signal });

/** CDP 页面属于用户，不能靠关闭主窗口取消；阻止取消后继续调用页面及定位器。 */
export function guardPage(page, signal) {
  const cache = new WeakMap();
  const wrap = (target) => {
    if (!target || typeof target !== 'object' || typeof target.then === 'function') return target;
    if (Array.isArray(target)) return target.map(wrap);
    const prototype = Object.getPrototypeOf(target);
    // evaluate 的 JSON 结果不代理，避免把业务数据误当作可操作的 Playwright 对象。
    if ((prototype === Object.prototype || prototype === null) && !Object.values(target).some((v) => typeof v === 'function')) return target;
    if (cache.has(target)) return cache.get(target);
    const proxy = new Proxy(target, {
      get(obj, key) {
        const value = Reflect.get(obj, key, obj);
        if (typeof value === 'function') return (...args) => {
          signal?.throwIfAborted();
          const result = Reflect.apply(value, obj, args);
          if (result && typeof result.then === 'function') return result.then(wrap);
          if (Array.isArray(result)) return result.map(wrap);
          return wrap(result);
        };
        return value && typeof value === 'object' ? wrap(value) : value;
      },
    });
    cache.set(target, proxy);
    return proxy;
  };
  return wrap(page);
}
