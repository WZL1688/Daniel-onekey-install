import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { Exchanges } from '../src/exchanges.js';
import { readyEngine, setup, scheduler, rule } from './helpers.js';

test('无 Key 的公共轮询先经调度同步 OKX 时钟，缓存复用且不增加 Binance 时间请求', async t => {
  const x = setup(t), state = x.store.state, calls = [], queue = scheduler(t, x.store);
  const id = 'BTC/USDT', offset = 10000;
  for (const exchange of state.config.exchanges) {
    state.rules[exchange] = { [id]: { ...rule(), symbol: exchange === 'okx' ? 'BTC-USDT' : 'BTCUSDT', maxUsdNotional: null } };
    state.exchangeMeta[exchange] = { rulesAt: Date.now() };
  }
  const adapter = new Exchanges(x.store, x.vault, queue, async request => {
    calls.push(request);
    const url = new URL(request.url);
    let data;
    if (url.pathname === '/api/v5/public/time') data = { code: '0', data: [{ ts: String(Date.now() + offset) }] };
    else if (url.pathname === '/api/v5/market/books') {
      assert.ok(state.exchangeMeta.okx.clock, '必须在读取 OKX 盘口前保存公共时间校准');
      data = { code: '0', data: [{ bids: [['102', '100']], asks: [['103', '100']], ts: String(Date.now() + offset) }] };
    } else if (url.pathname === '/api/v3/depth') data = { lastUpdateId: 1, bids: [['99', '100']], asks: [['100', '100']] };
    else throw Error('不允许额外规则、私人或下单接口：' + url.pathname);
    return { status: 200, headers: {}, data };
  });
  const engine = new Engine(x.store, adapter);
  await engine.poll(id);
  assert.equal(state.keys.length, 0);
  assert.equal(state.opportunities[id].error, undefined);
  assert.equal(state.opportunities[id].directions.length, 2);
  assert.ok(Math.abs(state.exchangeMeta.okx.clock.offset - offset) < 100);
  await engine.poll(id);
  assert.equal(calls.filter(request => new URL(request.url).pathname === '/api/v5/public/time').length, 1);
  assert.ok(calls.every(request => request.method === 'GET' && !request.body && Object.keys(request.headers).length === 0));
  assert.equal(queue.rate('okx').metrics.public, 3);
  assert.equal(queue.rate('binance').metrics.public, 2);
  assert.equal(queue.rate('okx').metrics.private, 0);
  assert.equal(queue.rate('binance').metrics.private, 0);
  assert.equal(state.batches.length, 0);
});

test('公共校时失败阻止读取未校准 OKX 盘口，保留上次有效机会与盘口并标记失败', async t => {
  const { engine, exchange, store, calls } = readyEngine(t), state = store.state, id = 'BTC/USDT';
  state.config.autoTrading = false; state.keys = []; state.accounts = {};
  const old = { pair: id, at: Date.now() - 1000, directions: [{ eligible: true, net: '1' }] };
  state.opportunities[id] = old;
  const previousBook = structuredClone(state.books.okx[id]), before = Date.now();
  exchange.syncClock = async () => { throw Error('时间同步往返延迟超过 2 秒'); };
  await engine.poll(id);
  assert.equal(state.opportunities[id], old);
  assert.deepEqual(old.directions, [{ eligible: true, net: '1' }]);
  assert.match(old.error, /^okx：时间同步往返延迟/);
  assert.ok(old.failedAt >= before);
  assert.deepEqual(state.books.okx[id], previousBook);
  assert.equal(calls.filter(call => call[0] === 'book' && call[1] === 'okx').length, 0);
  assert.equal(calls.filter(call => call[0] === 'order').length, 0);
});

test('两所并行公共请求失败明确标注各交易所，不覆盖之前有效数据', async t => {
  const { engine, exchange, store } = readyEngine(t), state = store.state, id = 'BTC/USDT';
  state.config.autoTrading = false;
  const old = { pair: id, at: 123, directions: [{ net: '2' }] };
  state.opportunities[id] = old;
  exchange.rules = async exchange => { if (exchange === 'binance') throw Error('HTTP 451 当前地区受限'); };
  exchange.syncClock = async () => { throw Error('公共服务器时间请求超时'); };
  await engine.poll(id);
  assert.equal(old.error, 'binance：HTTP 451 当前地区受限；okx：公共服务器时间请求超时');
  assert.equal(old.at, 123);
  assert.deepEqual(old.directions, [{ net: '2' }]);
  assert.equal(state.batches.length, 0);
});

test('全市场筛选按原优先级校准 OKX 时钟，动态平衡预览复用已校准盘口', async t => {
  const { engine, store, calls } = readyEngine(t), state = store.state, id = 'BTC/USDT';
  state.config.autoTrading = false; engine.scanRequested = true;
  await engine.scanOne();
  assert.deepEqual(calls.filter(call => call[0] === 'syncClock'), [['syncClock', 'okx', 4]]);
  assert.ok(calls.findIndex(call => call[0] === 'syncClock') < calls.findIndex(call => call[0] === 'book' && call[1] === 'okx'));
  assert.equal(state.scanResults[id].directions.length, 2);
  state.config.balance[id] = { enabled: true, amount: '20', stopDifference: '1', maxLoss: '0' };
  state.balances.okx.assets.BTC.total = '12';
  const before = calls.length;
  engine.balanceDirection(id);
  assert.equal(calls.length, before);
});

test('筛选校时失败保留上次筛选结果且不读取 OKX 盘口', async t => {
  const { engine, exchange, store, calls } = readyEngine(t), state = store.state, id = 'BTC/USDT';
  state.config.autoTrading = false;
  const old = { at: 123, directions: [{ net: '2' }] };
  state.scanResults[id] = old;
  exchange.syncClock = async () => { throw Error('公共服务器时间无效'); };
  await assert.rejects(engine.scanOne(), /公共服务器时间无效/);
  assert.equal(state.scanResults[id], old);
  assert.equal(calls.filter(call => call[0] === 'book' && call[1] === 'okx').length, 0);
  assert.equal(calls.filter(call => call[0] === 'order').length, 0);
});
