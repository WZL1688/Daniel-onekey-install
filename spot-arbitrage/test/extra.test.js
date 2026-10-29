import test from 'node:test';
import assert from 'node:assert/strict';
import { Exchanges } from '../src/exchanges.js';
import { readyEngine, setup, scheduler, rule, sleep } from './helpers.js';
test('API 排队后、实际发送前再次执行保护，停止实盘可阻止发送', async t => {
  const { store, vault } = setup(t), s = scheduler(t, store); let sent = 0, allowed = true;
  store.state.accounts.binance = '123'; store.state.rules.binance = { 'BTC/USDT': rule() }; store.state.exchangeMeta.binance = { clock: { at: Date.now(), offset: 0 } };
  vault.add({ exchange: 'binance', role: 'trade', apiKey: 'test-api-key1234', secret: 'test-secret1234', accountUid: '123', sameAccountConfirmed: true });
  const ex = new Exchanges(store, vault, s, async () => { sent++; return { status: 200, headers: {}, data: { orderId: 1 } }; });
  s.rate('binance').backoffUntil = Date.now() + 30;
  const promise = ex.order('binance', { pair: 'BTC/USDT', side: 'BUY', qty: '1', price: '100', clientId: 'guardtest', guard: () => { if (!allowed) throw Error('实盘已停止'); } });
  allowed = false; await assert.rejects(promise, e => e.unknown === false && /已停止/.test(e.message)); assert.equal(sent, 0);
});
test('缺少最终复核保护时适配器拒绝直接下单', async t => {
  const { store, vault } = setup(t), s = scheduler(t, store), ex = new Exchanges(store, vault, s);
  await assert.rejects(ex.order('binance', { pair: 'BTC/USDT', side: 'BUY', qty: '1', price: '100', clientId: 'bypass' }), /最终复核/);
});
test('最终复核发现交易所开放订单时禁止两腿提交', async t => {
  const { engine, exchange, calls } = readyEngine(t); exchange.assertNoOpenOrders = async () => { throw Error('有 1 笔开放订单'); };
  const batch = await engine.submit('BTC/USDT', 'binance'); assert.equal(batch.status, 'REJECTED'); assert.match(batch.error, /开放订单/); assert.equal(calls.filter(x => x[0] === 'order').length, 0);
});
test('价格过滤不满足时禁止两腿提交', async t => {
  const { engine, exchange, calls } = readyEngine(t); exchange.assertPriceContext = () => { throw Error('限价不满足交易所百分比价格过滤器'); };
  const batch = await engine.submit('BTC/USDT', 'binance'); assert.equal(batch.status, 'REJECTED'); assert.equal(calls.filter(x => x[0] === 'order').length, 0);
});
test('百分比价格过滤上下界均校验', t => {
  const { store, vault } = setup(t), s = scheduler(t, store), ex = new Exchanges(store, vault, s);
  store.state.rules.binance = { 'BTC/USDT': { ...rule(), filters: [{ filterType: 'PERCENT_PRICE_BY_SIDE', bidMultiplierUp: '1.1', bidMultiplierDown: '0.9', askMultiplierUp: '1.2', askMultiplierDown: '0.8' }] } };
  const context = { reference: '100', at: Date.now() };
  assert.doesNotThrow(() => ex.assertPriceContext('binance', 'BTC/USDT', 'BUY', '1', '105', context));
  assert.throws(() => ex.assertPriceContext('binance', 'BTC/USDT', 'BUY', '1', '111', context), /百分比/);
  assert.throws(() => ex.assertPriceContext('binance', 'BTC/USDT', 'SELL', '1', '79', context), /百分比/);
});
test('滚动窗口防止固定窗口边界出现双倍突发', async t => {
  const { store } = setup(t); let now = 59990; const s = scheduler(t, store, { now: () => now });
  store.state.config.budgets.binance = 100;
  await s.enqueue({ exchange: 'binance', route: '/test', kind: 'public', weight: 100, priority: 0 }, async () => true); await sleep(2);
  now = 60001;
  const a = s.available({ exchange: 'binance', route: '/test', kind: 'public', weight: 100, priority: 0 });
  assert.ok(a.wait > 50000); assert.match(a.reason, /滚动窗口/);
});
test('OKX 订单项超时码保留为未知，不能视为拒绝', async t => {
  const { store, vault } = setup(t), s = scheduler(t, store);
  store.state.accounts.okx = '123'; store.state.rules.okx = { 'BTC/USDT': rule() }; store.state.exchangeMeta.okx = { clock: { at: Date.now(), offset: 0 } };
  vault.add({ exchange: 'okx', role: 'trade', apiKey: 'test-api-key1234', secret: 'test-secret1234', passphrase: 'test-passphrase', accountUid: '123', sameAccountConfirmed: true });
  const ex = new Exchanges(store, vault, s, async () => ({ status: 200, headers: {}, data: { code: '0', data: [{ sCode: '50004', sMsg: 'timeout' }] } }));
  await assert.rejects(ex.order('okx', { pair: 'BTC/USDT', qty: '1', price: '100', side: 'BUY', clientId: 'sampleclient1', guard: () => {} }), e => e.unknown);
});
