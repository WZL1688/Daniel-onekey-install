import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, ApiError, retryDelay } from '../src/scheduler.js';
import { Store } from '../src/store.js';
import { setup, scheduler, sleep } from './helpers.js';
const task = (patch = {}) => ({ exchange: 'binance', route: '/depth', kind: 'public', priority: 1, weight: 5, ...patch });
test('所有发出的请求先持久化扣减限额', async t => {
  const { store, dir } = setup(t), s = scheduler(t, store);
  await s.enqueue(task(), async () => { assert.equal(store.state.rates.binance.windows.configured.used, 5); return 42; });
  assert.equal(store.state.rates.binance.metrics.public, 1);
});
test('合并相同在途盘口请求', async t => {
  const { store } = setup(t), s = scheduler(t, store); let requests = 0;
  const fn = async () => { requests++; await sleep(5); return 'book'; };
  const [a, b] = await Promise.all([s.enqueue(task({ dedupe: 'book' }), fn), s.enqueue(task({ dedupe: 'book', priority: 0 }), fn)]);
  assert.equal(a, b); assert.equal(requests, 1); assert.equal(s.rate('binance').metrics.merged, 1);
});
test('交易前复核排在等待中的后台查询之前', async t => {
  const { store } = setup(t), s = scheduler(t, store), order = [];
  const first = s.enqueue(task(), async () => { await sleep(10); order.push('running'); });
  const low = s.enqueue(task({ priority: 5 }), async () => order.push('scanner'));
  const high = s.enqueue(task({ priority: 0 }), async () => order.push('preflight'));
  await Promise.all([first, low, high]); assert.deepEqual(order, ['running', 'preflight', 'scanner']);
});
test('低优先级不能使用预留最终复核额度', t => {
  const { store } = setup(t), s = scheduler(t, store); store.state.config.budgets.binance = 100;
  s.available(task()); s.rate('binance').windows.configured.used = 50;
  assert.ok(s.available(task()).wait > 0); assert.equal(s.available(task({ priority: 0 })).wait, 0);
});
test('用户限额不会超过硬上限', t => { const { store } = setup(t), s = scheduler(t, store); store.state.config.budgets.binance = 999999; assert.equal(s.limits(task()).find(x => x.id === 'configured').cap, 1200); });
test('同时遵守官方多个权重、订单与原始请求窗口', t => {
  const { store } = setup(t), s = scheduler(t, store); const limits = s.limits(task({ kind: 'order' }));
  assert.ok(limits.some(x => x.id === 'ORDERS:10:SECOND')); assert.ok(limits.some(x => x.id === 'ORDERS:1:DAY')); assert.ok(limits.some(x => x.id === 'RAW_REQUESTS:5:MINUTE'));
});
test('响应头反映其他程序消耗的 IP 额度', t => {
  const { store } = setup(t), s = scheduler(t, store); s.observeHeaders('binance', { 'x-mbx-used-weight-1m': '1200' }); assert.ok(s.available(task({ priority: 0 })).wait > 0);
});
for (const status of [403, 418, 429]) test(`HTTP ${status} 尊重 Retry-After 并不重试`, async t => {
  const { store } = setup(t), s = scheduler(t, store); let attempts = 0;
  await assert.rejects(s.enqueue(task(), async () => { attempts++; throw new ApiError('拒绝', { status, retryAfter: '120' }); }));
  await sleep(5); assert.equal(attempts, 1); assert.ok(s.rate('binance').backoffUntil >= Date.now() + 119000); assert.equal(s.rate('binance').metrics.limited, 1);
});
test('网络错误短暂退避，订单任务绝不重发', async t => {
  const { store } = setup(t), s = scheduler(t, store); let attempts = 0;
  await assert.rejects(s.enqueue(task({ kind: 'order', priority: 0 }), async () => { attempts++; throw new ApiError('ECONNRESET', { unknown: true }); }));
  await sleep(5); assert.equal(attempts, 1); assert.ok(s.rate('binance').backoffUntil > Date.now()); assert.equal(s.rate('binance').metrics.orders, 1);
});
test('Retry-After 支持秒数与 HTTP 日期', () => { assert.equal(retryDelay('2', 100), 2000); assert.equal(retryDelay('Thu, 01 Jan 1970 00:00:10 GMT', 1000), 9000); assert.equal(retryDelay('bad'), 0); });
test('冷却与已扣减窗口在重启后保留', async t => {
  const { store, dir } = setup(t), s = scheduler(t, store);
  await s.enqueue(task(), async () => true); await sleep(5);
  const until = Date.now() + 30000; s.rate('binance').backoffUntil = until; store.save(); s.close(); store.close();
  const fresh = new Store(dir); t.after(() => fresh.close()); const next = new Scheduler(fresh); t.after(() => next.close());
  assert.equal(next.rate('binance').backoffUntil, until); assert.equal(next.rate('binance').windows.configured.used, 5);
});
test('两个交易所的限速互不共享', async t => { const { store } = setup(t), s = scheduler(t, store); s.rate('binance').backoffUntil = Date.now() + 60000; const result = await s.enqueue(task({ exchange: 'okx' }), async () => 'ok'); assert.equal(result, 'ok'); });
test('官方窗口用完之前停止发送请求', t => {
  const { store } = setup(t); let now = 100000; const s = scheduler(t, store, { now: () => now });
  store.state.exchangeMeta.binance = { rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'SECOND', intervalNum: 10, limit: 10 }] };
  s.available(task({ priority: 0 })); s.rate('binance').windows['REQUEST_WEIGHT:10:SECOND'].used = 10;
  assert.equal(s.available(task({ priority: 0 })).wait, 10000); now += 10000; assert.equal(s.available(task({ priority: 0 })).wait, 0);
});
