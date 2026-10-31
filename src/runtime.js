import { setTimeout as delay } from 'node:timers/promises';

export class TimeoutError extends Error {}

/** 超时先撤销后续动作并清理连接，再等待适配器退出，避免与下一平台重叠执行。 */
export async function withDeadline(work, ms, label) {
  const controller = new AbortController();
  const cleanups = new Set();
  let cleanup = Promise.resolve();
  const timer = setTimeout(() => {
    controller.abort(new TimeoutError(`${label}超时（${Math.round(ms / 1000)}s）`));
    cleanup = Promise.allSettled([...cleanups].map((fn) => Promise.resolve().then(fn)));
  }, ms);
  try {
    const value = await work(controller.signal, (fn) => {
      if (controller.signal.aborted) cleanup = Promise.allSettled([cleanup, Promise.resolve().then(fn)]);
      else cleanups.add(fn);
    });
    controller.signal.throwIfAborted();
    return value;
  } catch (e) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    await cleanup;
  }
}

export const abortableSleep = (ms, signal) => delay(ms, undefined, { signal });

/** CDP 页面属于用户，不能靠关闭主窗口取消；阻止取消后继续调用页面及定位器。 */
export function guardPage(page, signal) {
  const cache = new WeakMap();
  const wrap = (target) => {
    if (!target || typeof target !== 'object' || typeof target.then === 'function') return target;
    if (cache.has(target)) return cache.get(target);
    const proxy = new Proxy(target, {
      get(obj, key) {
        const value = Reflect.get(obj, key, obj);
        if (typeof value === 'function') return (...args) => {
          signal?.throwIfAborted();
          const result = Reflect.apply(value, obj, args);
          if (result && typeof result.then === 'function') return result;
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
