import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Exchanges } from '../src/exchanges.js';
import { Store, defaults } from '../src/store.js';
import { createApp } from '../src/server.js';
import { LIVE_CONFIRM, validateConfig } from '../src/engine.js';
import { CANDLE_MS, KLINE_LIMIT, analyzeSpotKlines, recordMarketWatch } from '../src/market-watch.js';
import { riskDay } from '../src/policies.js';
import { setup, scheduler, rule, readyEngine, book, sleep } from './helpers.js';

function klines(now = Date.now(), count = 13) {
  const end = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  return Array.from({ length: count }, (_, i) => {
    const open = end - (count - i) * CANDLE_MS;
    return [open, '10', '10.1', '9.9', '10', i === count - 1 ? '50' : '10', open + CANDLE_MS - 1,
      i === count - 1 ? '500' : '100', 10, '0', '0', '0'];
  });
}
function summary(now = Date.now()) {
  return { ...analyzeSpotKlines(klines(now), { now }), observedAt: now, clockOffsetMs: 0, exchange: 'binance', pair: 'BTC/USDT' };
}
function scanFixture(t) {
  const x = readyEngine(t), state = x.store.state;
  state.config.autoTrading = false; state.keys = []; state.accounts = {};
  state.config.marketWatch.enabled = true;
  return x;
}
function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('现货量价适配仅用低优先级公共时钟和2权重K线，缓存到期与本机回拨不会复用旧值', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const x = setup(t), queue = scheduler(t, x.store, { now: () => now }), calls = [], tasks = [];
  x.store.state.rules.binance = { 'BTC/USDT': rule() };
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = (task, run) => { tasks.push(task); return enqueue(task, run); };
  const adapter = new Exchanges(x.store, x.vault, queue, async request => {
    calls.push(request); const url = new URL(request.url);
    assert.equal(url.hostname, 'api.binance.com');
    return { status: 200, headers: {}, data: url.pathname === '/api/v3/time' ? { serverTime: now } : klines(now) };
  });
  const first = await adapter.marketContext('BTC/USDT', 4);
  assert.equal(first.volumeRatio5m, '5'); assert.equal(first.clockOffsetMs, 0);
  assert.equal(first.observedAt, now); assert.equal(first.exchange, 'binance');
  first.volumeRatio5m = '999';
  const second = await adapter.marketContext('BTC/USDT', 5);
  assert.equal(second.volumeRatio5m, '5'); assert.equal(calls.length, 2);
  assert.equal(x.store.state.keys.length, 0);
  for (const request of calls) {
    assert.equal(request.method, 'GET'); assert.equal(request.mutation, false);
    assert.deepEqual(request.headers, {}); assert.equal(request.body, '');
    assert.equal(new URL(request.url).searchParams.has('signature'), false);
  }
  const candleTask = tasks.find(task => task.route === '/api/v3/klines');
  assert.equal(candleTask.kind, 'public'); assert.equal(candleTask.weight, 2); assert.equal(candleTask.priority, 4);
  assert.deepEqual([...new URL(calls[1].url).searchParams], [['symbol', 'BTCUSDT'], ['interval', '5m'], ['limit', String(KLINE_LIMIT)]]);
  assert.equal(queue.rate('binance').metrics.private, 0); assert.equal(queue.rate('binance').metrics.orders, 0);
  now += 60000; await sleep(0);
  await adapter.marketContext('BTC/USDT', 5);
  assert.equal(calls.filter(request => new URL(request.url).pathname.endsWith('/klines')).length, 2);
  assert.equal(tasks.at(-1).priority, 5);
  now -= 120000; await sleep(0);
  await adapter.marketContext('BTC/USDT', 4);
  assert.equal(calls.filter(request => new URL(request.url).pathname.endsWith('/klines')).length, 3);
  assert.equal(x.store.state.exchangeMeta.binance.clock.at, now);
});

test('量价观察拒绝高优先级与错误市场，失败不重发也不把旧缓存当新数据', async t => {
  const x = setup(t), calls = [], adapter = new Exchanges(x.store, x.vault, null);
  const now = Date.now(); x.store.state.rules.binance = { 'BTC/USDT': rule() };
  x.store.state.exchangeMeta.binance = { clock: { at: now, offset: 0 } };
  adapter.request = async (exchange, task) => { calls.push(task); throw Error('PRIVATE-ERROR-MARKER'); };
  for (const priority of [0, 1, 2, 3, 6]) await assert.rejects(adapter.marketContext('BTC/USDT', priority), /低优先级/);
  await assert.rejects(adapter.marketContext('ETH/USDT', 4), /规则/);
  assert.equal(calls.length, 0);
  adapter.marketContexts.set('BTC/USDT', { at: now - 60000, summary: summary(now - 60000) });
  await assert.rejects(adapter.marketContext('BTC/USDT', 4), /PRIVATE-ERROR-MARKER/);
  assert.equal(calls.length, 1); assert.equal(adapter.marketContexts.has('BTC/USDT'), false);
  x.store.state.rules.binance['BTC/USDT'].symbol = 'OTHER';
  await assert.rejects(adapter.marketContext('BTC/USDT', 4), /匹配/); assert.equal(calls.length, 1);
});

test('默认关闭量价观察时扫描不增加请求，不改变原双向深度试算', async t => {
  const x = readyEngine(t); x.store.state.config.autoTrading = false;
  assert.equal(x.store.state.config.marketWatch.enabled, false);
  x.exchange.marketContext = async () => { throw Error('默认关闭时不得调用'); };
  await x.engine.scanOne();
  assert.equal(x.store.state.scanResults['BTC/USDT'].directions.length, 2);
  assert.equal(Object.keys(x.store.state.marketWatch.samples).length, 0);
  assert.equal(x.calls.filter(call => call[0] === 'order' || call[0] === 'balances').length, 0);
});

test('量价观察先于最新盘口，失败仅显示未知且不阻止原有深度计算', async t => {
  for (const fail of [false, true]) {
    const x = scanFixture(t), sequence = [];
    const originalBook = x.exchange.book;
    x.exchange.marketContext = async (id, priority) => {
      sequence.push('context'); assert.equal(priority, 4);
      if (fail) { const error = Error('SECRET-RAW-ERROR'); error.code = 'BODY_TIMEOUT'; throw error; }
      return summary();
    };
    x.exchange.book = async (...args) => { sequence.push('book'); return originalBook(...args); };
    x.engine.requestScan(); await x.engine.scanOne();
    assert.equal(sequence[0], 'context'); assert.equal(sequence.filter(item => item === 'book').length, 2);
    assert.equal(x.store.state.scanResults['BTC/USDT'].directions.length, 2);
    assert.equal(x.store.state.engine.scanRun.failed, 0);
    const sample = x.store.state.marketWatch.samples['BTC/USDT'];
    if (fail) {
      assert.equal(sample.status, 'UNAVAILABLE'); assert.match(sample.error, /BODY_TIMEOUT/);
      assert.doesNotMatch(JSON.stringify(sample), /SECRET-RAW-ERROR/); assert.equal(x.store.state.marketWatch.alerts.length, 0);
    } else {
      assert.equal(sample.volumeRatio5m, '5'); assert.ok(x.store.state.marketWatch.alerts.some(alert => alert.code === 'VOLUME_EXPANSION'));
    }
    assert.equal(x.calls.filter(call => call[0] === 'order').length, 0);
  }
});

test('停止、换配置、新轮或开启实盘后，旧在途量价观察不能发提醒或继续读盘口', async t => {
  for (const action of ['stop', 'config', 'replace', 'live']) {
    const x = scanFixture(t), entered = deferred(), release = deferred();
    x.exchange.marketContext = async () => { entered.resolve(); await release.promise; return summary(); };
    x.engine.requestScan(); const pending = x.engine.scanOne(); await entered.promise;
    if (action === 'stop') x.engine.stopScan();
    if (action === 'config') x.engine.updateConfig({ marketWatch: { volumeRatio: '4' } });
    if (action === 'replace') x.engine.requestScan();
    if (action === 'live') { x.engine.liveReasons = () => []; x.engine.setLive(true, LIVE_CONFIRM); }
    release.resolve(); await pending;
    assert.deepEqual(x.store.state.marketWatch.samples, {}, action);
    assert.deepEqual(x.store.state.marketWatch.alerts, [], action);
    assert.equal(x.calls.filter(call => call[0] === 'book' || call[0] === 'order').length, 0, action);
  }
});

test('量价观察之后的盘口仍在途时停止，旧上下文也不能写入缓存或提醒', async t => {
  const x = scanFixture(t), entered = deferred(), release = deferred();
  x.exchange.marketContext = async () => summary();
  x.exchange.book = async (exchange, id) => { entered.resolve(); await release.promise; return book(id, exchange === 'binance' ? '99' : '102', exchange === 'binance' ? '100' : '103'); };
  x.engine.requestScan(); const pending = x.engine.scanOne(); await entered.promise;
  x.engine.stopScan(); release.resolve(); await pending;
  assert.deepEqual(x.store.state.marketWatch.samples, {}); assert.deepEqual(x.store.state.marketWatch.alerts, []);
  assert.deepEqual(x.store.state.scanResults, {});
});

test('量价观察不解除已有未知批次、冷却或亏损熔断', async t => {
  const x = scanFixture(t), now = Date.now(), s = x.store.state;
  s.batches.push({ id: 'unknown', pair: 'BTC/USDT', status: 'UNKNOWN', legs: [] });
  s.blocks['BTC/USDT'] = '必须人工核对'; s.cooldowns['BTC/USDT'] = now + 60000;
  s.riskState.latches.USDT = { day: riskDay(now), at: now, loss: '5', limit: '5' };
  const before = JSON.stringify([s.batches, s.blocks, s.cooldowns, s.riskState]);
  x.exchange.marketContext = async () => summary();
  x.engine.requestScan(); await x.engine.scanOne();
  assert.equal(JSON.stringify([s.batches, s.blocks, s.cooldowns, s.riskState]), before);
  assert.equal(s.config.autoTrading, false); assert.equal(x.calls.filter(call => call[0] === 'order').length, 0);
});

test('量价快照GET纯读，时效可变化但不触发请求或修改历史记录', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-market-watch-http-')); let requests = 0;
  const app = createApp({ dataDir: dir, startEngine: false, transport: async () => { requests++; throw Error('GET不得访问交易所'); } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  app.store.state.config.marketWatch.enabled = true;
  recordMarketWatch(app.store.state, 'BTC/USDT', summary()); app.store.save();
  const before = JSON.stringify(app.store.state.marketWatch);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  for (let i = 0; i < 3; i++) {
    const response = await fetch(base + '/api/state'); assert.equal(response.status, 200);
    const state = await response.json(); assert.equal(state.marketWatch.enabled, true);
    assert.equal(state.marketWatch.samples['BTC/USDT'].volumeRatio5m, '5');
    assert.ok(state.marketWatch.alerts.length > 0); assert.equal(state.config.autoTrading, false);
  }
  assert.equal(requests, 0); assert.equal(JSON.stringify(app.store.state.marketWatch), before);
});

test('旧状态迁移与重启保留量价提醒冷却、未知订单及熔断，不因同一闭合柱重复提醒', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-market-watch-restart-'));
  try {
    const raw = defaults(); delete raw.config.marketWatch; delete raw.marketWatch;
    const now = Date.now();
    raw.batches.push({ id: 'unknown', pair: 'BTC/USDT', status: 'UNKNOWN', legs: [] });
    raw.cooldowns['BTC/USDT'] = now + 60000;
    raw.riskState = { version: 1, ledger: {}, latches: { USDT: { day: riskDay(now), at: now, loss: '5', limit: '5' } }, resetHistory: [] };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(raw));
    let store = new Store(dir);
    assert.equal(store.state.config.marketWatch.enabled, false); assert.deepEqual(store.state.marketWatch.alerts, []);
    store.state.config.marketWatch.enabled = true; recordMarketWatch(store.state, 'BTC/USDT', summary(now), now);
    const before = structuredClone(store.state.marketWatch), cooldown = store.state.cooldowns['BTC/USDT'];
    assert.ok(before.alerts.length > 0); store.save(); store.close();
    store = new Store(dir);
    try {
      recordMarketWatch(store.state, 'BTC/USDT', summary(now), now + 1000);
      assert.deepEqual(store.state.marketWatch.alerts, before.alerts);
      assert.deepEqual(store.state.marketWatch.cooldowns, before.cooldowns);
      assert.equal(store.state.batches[0].status, 'UNKNOWN'); assert.ok(store.state.blocks['BTC/USDT']);
      assert.equal(store.state.cooldowns['BTC/USDT'], cooldown); assert.ok(store.state.riskState.latches.USDT);
      assert.equal(store.state.config.autoTrading, false);
    } finally { store.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('量价设置沿用配置补丁严格校验，不放松原有利润门槛或支持未知字段', () => {
  const previous = defaults().config;
  const next = validateConfig({ marketWatch: { enabled: true, volumeRatio: '4' } }, previous);
  assert.equal(next.marketWatch.enabled, true); assert.equal(next.marketWatch.volumeRatio, '4');
  assert.equal(next.minProfit, previous.minProfit); assert.equal(next.minDepthProfit, previous.minDepthProfit);
  assert.equal(next.marketWatch.priceMoveBps, '500');
  for (const marketWatch of [null, [], { buyNow: true }, { enabled: 'true' }, { volumeRatio: '0' }, { cooldownMs: 1 }]) {
    assert.throws(() => validateConfig({ marketWatch }, previous));
  }
});
