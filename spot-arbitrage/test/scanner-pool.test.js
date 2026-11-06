import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults } from '../src/store.js';
import { Engine, validateConfig, LIVE_CONFIRM } from '../src/engine.js';
import { createApp } from '../src/server.js';
import { marketFixture } from '../scripts/fixtures.js';
import { readyEngine, book, rule } from './helpers.js';

function pool(t, ids = ['ADA/USDT', 'DOGE/USDT', 'XRP/USDT']) {
  const x = readyEngine(t), state = x.store.state;
  state.config.autoTrading = false; state.keys = []; state.accounts = {};
  for (const exchange of state.config.exchanges) {
    state.rules[exchange] = Object.fromEntries(ids.map(id => [id, { ...rule(), symbol: id.replace('/', exchange === 'okx' ? '-' : '') }]));
    state.books[exchange] = Object.fromEntries(ids.map(id => [id, book(id, exchange === 'binance' ? '99' : '102', exchange === 'binance' ? '100' : '103')]));
  }
  return x;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function blockBooks(x) {
  const entered = deferred(), release = deferred();
  x.exchange.book = async (exchange, id) => { entered.resolve(); await release.promise; return book(id, exchange === 'binance' ? '99' : '102', exchange === 'binance' ? '100' : '103'); };
  return { entered: entered.promise, release: release.resolve };
}

test('候选池列表严格校验类型、格式、重复及300项边界，默认排除三大币', () => {
  const previous = defaults().config;
  assert.deepEqual(previous.scanExcludeAssets, ['BTC', 'ETH', 'SOL']); assert.deepEqual(previous.scanPairs, []);
  const assets = Array.from({ length: 300 }, (_, i) => 'X' + String(i).padStart(3, '0'));
  assert.equal(validateConfig({ scanExcludeAssets: assets, scanPairs: assets.map(asset => asset + '/USDT') }, previous).scanPairs.length, 300);
  for (const patch of [
    { scanExcludeAssets: null }, { scanExcludeAssets: 'BTC' }, { scanExcludeAssets: ['BTC', 'BTC'] },
    { scanExcludeAssets: ['btc'] }, { scanExcludeAssets: [12] }, { scanExcludeAssets: ['A'] },
    { scanExcludeAssets: [...assets, 'OVER'] }, { scanPairs: null }, { scanPairs: ['BTCUSDT'] },
    { scanPairs: ['BTC/USDT', 'BTC/USDT'] }, { scanPairs: ['BTC/BTC'] }, { scanPairs: [1] },
    { scanPairs: [...assets.map(asset => asset + '/USDT'), 'OVER/USDT'] },
  ]) assert.throws(() => validateConfig(patch, previous), JSON.stringify(patch));
  assert.deepEqual(validateConfig({ scanExcludeAssets: [], scanPairs: [] }, previous).scanExcludeAssets, []);
});

test('候选过滤只保留共同enabled现货、报价资产与限定列表，默认大币被排除', t => {
  const x = pool(t, ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'ADA/USDT', 'DOGE/USDT', 'XRP/USDT', 'ADA/USDC', 'ONLY/USDT']);
  const s = x.store.state; s.config.scanExcludeAssets = ['BTC', 'ETH', 'SOL'];
  s.rules.okx['DOGE/USDT'].enabled = false; delete s.rules.okx['ONLY/USDT'];
  for (const exchange of s.config.exchanges) for (const id of ['BAD.P/USDT', 'USDT/USDT']) s.rules[exchange][id] = rule();
  assert.deepEqual(x.engine.scanCandidates(), ['ADA/USDT', 'XRP/USDT']);
  s.config.scanPairs = ['BTC/USDT', 'ADA/USDT', 'DOGE/USDT', 'ADA/USDC', 'ONLY/USDT'];
  assert.deepEqual(x.engine.scanCandidates(), ['ADA/USDT']);
});

test('手动完整轮从头开始并固定候选快照，不受legacy cursor和中途市场新增影响', async t => {
  const x = pool(t, ['ADA/USDT', 'DOGE/USDT']), s = x.store.state;
  s.engine.scanCursor = 99;
  const run = x.engine.requestScan();
  assert.equal(run.status, 'PREPARING'); assert.equal(s.engine.scanCursor, 0);
  await x.engine.scanOne();
  assert.equal(s.engine.scanRun.total, 2); assert.equal(s.engine.scanRun.completed, 1);
  assert.ok(s.scanResults['ADA/USDT']); assert.equal(s.scanResults['DOGE/USDT'], undefined);
  for (const exchange of s.config.exchanges) { s.rules[exchange]['NEW/USDT'] = rule(); s.books[exchange]['NEW/USDT'] = book('NEW/USDT'); }
  await x.engine.scanOne();
  assert.equal(s.engine.scanRun.status, 'COMPLETED'); assert.equal(s.engine.scanRun.completed, 2);
  assert.equal(s.engine.scanRun.total, 2); assert.equal(s.scanResults['NEW/USDT'], undefined);
  assert.equal(x.engine.scanRequested, false);
  assert.ok(x.calls.filter(call => call[0] === 'book').every(call => call[2] === 4));
  assert.equal(x.calls.filter(call => call[0] === 'order' || call[0] === 'balances').length, 0);
});

test('失败币保留旧结果并标注失败，进度继续推进到下一币，完成不代表通过', async t => {
  const x = pool(t, ['ADA/USDT', 'DOGE/USDT']), s = x.store.state;
  const old = { at: Date.now(), directions: [{ eligible: true, conservative: '1', reasons: [] }] };
  s.scanResults['ADA/USDT'] = old;
  const original = x.exchange.book;
  x.exchange.book = async (exchange, id, ...args) => { if (id === 'ADA/USDT') throw Error('公开盘口超时'); return original(exchange, id, ...args); };
  x.engine.requestScan();
  await assert.rejects(x.engine.scanOne(), /公开盘口超时/);
  assert.equal(s.scanResults['ADA/USDT'], old); assert.equal(old.directions[0].conservative, '1');
  assert.match(old.error, /binance：公开盘口超时；okx：公开盘口超时/); assert.ok(old.failedAt >= old.at);
  assert.equal(s.engine.scanRun.completed, 1); assert.equal(s.engine.scanRun.failed, 1);
  await x.engine.scanOne();
  assert.equal(s.engine.scanRun.status, 'COMPLETED'); assert.equal(s.engine.scanRun.completed, 2); assert.equal(s.engine.scanRun.failed, 1);
  assert.ok(s.scanResults['DOGE/USDT'].directions.length);
});

test('手动停止关闭自动扫描并丢弃在途结果，下一tick不会重新启动', async t => {
  const x = pool(t), s = x.store.state; s.config.scannerAuto = true;
  const gate = blockBooks(x); const pending = x.engine.scanOne(); await gate.entered;
  const runId = s.engine.scanRun.id;
  x.engine.stopScan(); assert.equal(s.config.scannerAuto, false); assert.equal(s.engine.scanRun.status, 'STOPPED');
  gate.release(); await pending;
  assert.equal(s.engine.scanRun.id, runId); assert.equal(s.engine.scanRun.completed, 0); assert.deepEqual(s.scanResults, {});
  const before = x.calls.length;
  x.engine.running = true; s.engine.lastPollAt = Date.now(); s.engine.lastBalanceAt = Date.now(); x.engine.lastScanAt = 0;
  await x.engine.tick(); x.engine.running = false;
  assert.equal(x.calls.length, before); assert.equal(s.engine.scanRun.status, 'STOPPED');
});

test('新手动轮替换旧轮后，旧在途返回不能污染新进度或结果', async t => {
  const x = pool(t), s = x.store.state, gate = blockBooks(x);
  x.engine.requestScan(); const oldId = s.engine.scanRun.id;
  const pending = x.engine.scanOne(); await gate.entered;
  const next = x.engine.requestScan(); assert.notEqual(next.id, oldId);
  gate.release(); await pending;
  assert.equal(s.engine.scanRun.id, next.id); assert.equal(s.engine.scanRun.status, 'PREPARING');
  assert.equal(s.engine.scanRun.completed, 0); assert.deepEqual(s.scanResults, {});
  await x.engine.scanOne(); assert.equal(s.scanResults['ADA/USDT'].runId, next.id);
});

test('任意利润配置变化使旧预览失效，并阻止旧在途结果覆盖', async t => {
  const x = pool(t), s = x.store.state, gate = blockBooks(x);
  s.scanResults['XRP/USDT'] = { at: Date.now(), directions: [{ eligible: true, conservative: '1', reasons: [] }] };
  x.engine.requestScan(); const pending = x.engine.scanOne(); await gate.entered;
  x.engine.updateConfig({ minProfit: '2' });
  assert.equal(s.engine.scanRun.status, 'STOPPED'); assert.equal(s.scanResults['XRP/USDT'].invalidated, true);
  gate.release(); await pending; assert.equal(s.scanResults['ADA/USDT'], undefined);
});

test('开启实盘停止筛选但不改自动筛选偏好，不允许实盘状态请求新轮', t => {
  const x = pool(t), s = x.store.state;
  s.config.scannerAuto = true; x.engine.requestScan(); x.engine.liveReasons = () => [];
  x.engine.setLive(true, LIVE_CONFIRM);
  assert.equal(s.engine.scanRun.status, 'STOPPED'); assert.equal(s.config.scannerAuto, true);
  assert.throws(() => x.engine.requestScan(), /先停止实盘/); assert.equal(x.calls.filter(call => call[0] === 'order').length, 0);
});

test('重启保留配置并将未完手动轮标为中断，不会悄悄继续', async t => {
  const x = pool(t), s = x.store.state;
  s.config.scanExcludeAssets = ['BTC']; s.config.scanPairs = ['ADA/USDT', 'DOGE/USDT'];
  x.engine.requestScan(); await x.engine.scanOne(); const runId = s.engine.scanRun.id;
  x.store.save(); x.store.close();
  const reopened = new Store(x.dir);
  try {
    assert.deepEqual(reopened.state.config.scanExcludeAssets, ['BTC']); assert.deepEqual(reopened.state.config.scanPairs, ['ADA/USDT', 'DOGE/USDT']);
    assert.equal(reopened.state.engine.scanRun.id, runId); assert.equal(reopened.state.engine.scanRun.status, 'INTERRUPTED');
    assert.equal(reopened.state.engine.scanRun.completed, 1); assert.equal(reopened.state.engine.scanRun.currentPair, null);
    const restarted = new Engine(reopened, x.exchange);
    assert.equal(restarted.scanRequested, false); assert.equal(restarted.scanActive(), false);
  } finally { reopened.close(); }
});

test('旧状态缺省候选配置与scanRun可迁移，已有安全记录不删除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-old-pool-'));
  try {
    const s = defaults(); delete s.config.scanExcludeAssets; delete s.config.scanPairs; delete s.engine.scanRun;
    s.cooldowns['ADA/USDT'] = Date.now() + 10000; s.blocks['ADA/USDT'] = '人工核对阻塞';
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    const store = new Store(dir);
    try {
      assert.deepEqual(store.state.config.scanExcludeAssets, ['BTC', 'ETH', 'SOL']); assert.deepEqual(store.state.config.scanPairs, []);
      assert.equal(store.state.engine.scanRun, null); assert.equal(store.state.blocks['ADA/USDT'], '人工核对阻塞');
      assert.equal(store.state.cooldowns['ADA/USDT'], s.cooldowns['ADA/USDT']);
    } finally { store.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('真实公共适配筛选无需Key或订单，GET快照不请求交易所且不输出内部候选列表', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-http-pool-')); const requests = [];
  const app = createApp({ dataDir: dir, startEngine: false, transport: request => { requests.push(request); return marketFixture(request); } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = app.store.state; s.config.scanExcludeAssets = []; s.config.scanPairs = ['ETH/USDT'];
  app.engine.requestScan(); await app.engine.scanOne();
  assert.equal(s.keys.length, 0); assert.equal(s.batches.length, 0); assert.equal(requests.length, 5);
  assert.ok(requests.every(request => request.method === 'GET' && request.mutation === false && !request.body && Object.keys(request.headers).length === 0));
  s.scanResults['BTC/USDT'] = { at: Date.now(), directions: [{ eligible: true, sampleAt: Date.now(), conservative: '2', reasons: [] }], failedAt: Date.now() + 1, error: '旧利润对应的刷新失败' };
  s.scanResults['SOL/USDT'] = { at: Date.now(), directions: [{ eligible: true, sampleAt: Date.now(), conservative: '1', reasons: [] }], invalidated: true };
  const previous = JSON.stringify(s.scanResults), count = requests.length;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  for (let i = 0; i < 3; i++) {
    const response = await fetch(base + '/api/state'); assert.equal(response.status, 200); const state = await response.json();
    assert.equal(state.engine.scanRun.ids, undefined); assert.equal(state.engine.scanRun.configKey, undefined);
    assert.equal(state.engine.scanRun.status, 'COMPLETED'); assert.equal(state.scanResults['BTC/USDT'].failed, true);
    assert.equal(state.scanResults['BTC/USDT'].stale, true); assert.equal(state.scanResults['SOL/USDT'].stale, true);
  }
  assert.equal(requests.length, count); assert.equal(JSON.stringify(s.scanResults), previous);
  const session = await fetch(base + '/api/session'), { csrf } = await session.json();
  const headers = { 'Content-Type': 'application/json', Cookie: session.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': csrf };
  s.config.scannerAuto = true; s.engine.scanCursor = 99;
  const started = await fetch(base + '/api/scan', { method: 'POST', headers, body: '{}' });
  assert.equal(started.status, 202); assert.equal((await started.json()).scanRun.status, 'PREPARING'); assert.equal(s.engine.scanCursor, 0);
  const stopped = await fetch(base + '/api/scan/stop', { method: 'POST', headers, body: '{}' });
  assert.equal(stopped.status, 200); assert.equal((await stopped.json()).scannerAuto, false);
  assert.equal(s.engine.scanRun.status, 'STOPPED'); assert.equal(requests.length, count);
});
