import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Exchanges, signBinance, signOkx, parseExchangeJson } from '../src/exchanges.js';
import { ApiError } from '../src/scheduler.js';
import { setup, scheduler, rule, book, sleep } from './helpers.js';
const ok = data => ({ status: 200, headers: {}, data });
test('大型订单号与账户 UID 解析不丢失精度', () => {
  const result = parseExchangeJson('{"orderId":123456789012345678901,"uid":98765432109876543210,"code":-1007,"serverTime":1790000000000}');
  assert.equal(result.orderId, '123456789012345678901'); assert.equal(result.uid, '98765432109876543210'); assert.equal(result.code, -1007); assert.equal(result.serverTime, 1790000000000);
});
test('重复字段或畸形 JSON 会拒绝而非覆盖', () => assert.throws(() => parseExchangeJson('{"code":0,"code":-1007}')));
function fixture(t, response) {
  const x = setup(t), s = scheduler(t, x.store), calls = [];
  const e = new Exchanges(x.store, x.vault, s, async request => { calls.push(request); return typeof response === 'function' ? response(request) : ok(response); });
  for (const ex of ['binance', 'okx']) x.store.state.exchangeMeta[ex] = { clock: { at: Date.now(), offset: 0 } };
  return { ...x, s, e, calls };
}
test('Binance 官方 HMAC 签名向量完全一致', () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const { signature } = signBinance(secret, { symbol: 'LTCBTC', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '1', price: '0.1', recvWindow: '5000', timestamp: '1499827319559' });
  assert.equal(signature, 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});
test('OKX 签名包含精确 GET 路径和 JSON 请求体', () => {
  const ts = '2026-10-29T01:02:03.456Z', body = '{"instId":"BTC-USDT"}';
  const expected = crypto.createHmac('sha256', 'test-secret').update(ts + 'POST/api/v5/trade/order' + body).digest('base64');
  assert.equal(signOkx('test-secret', ts, 'POST', '/api/v5/trade/order', body), expected);
  assert.notEqual(signOkx('test-secret', ts, 'GET', '/api/v5/account/balance?ccy=BTC'), signOkx('test-secret', ts, 'GET', '/api/v5/account/balance'));
});
test('公共盘口绝不携带私人 Key', async t => {
  const { e, store, vault, calls } = fixture(t, { lastUpdateId: 1, bids: [['99', '2']], asks: [['100', '2']] });
  vault.add({ exchange: 'binance', role: 'query', apiKey: 'test-api-key123', secret: 'test-secret123' });
  store.state.rules.binance = { 'BTC/USDT': rule() }; await e.book('binance', 'BTC/USDT');
  assert.deepEqual(calls[0].headers, {}); assert.ok(!calls[0].url.includes('signature'));
});
test('交易 Key 不能发起任何查询', t => {
  const { e, vault, store, calls } = fixture(t, {});
  vault.add({ exchange: 'binance', role: 'trade', apiKey: 'test-api-key123', secret: 'test-secret123', accountUid: '1', sameAccountConfirmed: true });
  assert.throws(() => e.request('binance', { path: '/api/v3/account', key: store.state.keys[0] }), /禁止查询/); assert.equal(calls.length, 0);
});
test('查询 Key 不能提交交易', t => { const { e, vault, store } = fixture(t, {}); vault.add({ exchange: 'binance', role: 'query', apiKey: 'test-api-key123', secret: 'test-secret123' }); assert.throws(() => e.request('binance', { path: '/api/v3/order', method: 'POST', mutation: true, key: store.state.keys[0] }), /禁止下单/); });
test('同账户查询 Key 公平轮换', t => {
  const { e, vault, store } = fixture(t, {});
  for (let i = 0; i < 2; i++) { vault.add({ exchange: 'binance', role: 'query', apiKey: 'test-api-key123' + i, secret: 'test-secret123' }); store.state.keys.at(-1).status = 'VERIFIED'; }
  const a = e.chooseQuery('binance').id, b = e.chooseQuery('binance').id; assert.notEqual(a, b); assert.equal(e.chooseQuery('binance').id, a);
});
test('不同账户 UID 的查询 Key 验证失败且不会轮换使用', async t => {
  const { e, vault, store } = fixture(t, request => ok(new URL(request.url).pathname.endsWith('/time') ? { serverTime: Date.now() } : { uid: 2 }));
  store.state.accounts.binance = '1'; const id = vault.add({ exchange: 'binance', role: 'query', apiKey: 'test-api-key123', secret: 'test-secret123' });
  await assert.rejects(e.validateKey(id), /不同账户/); assert.equal(store.state.keys[0].status, 'FAILED'); assert.throws(() => e.chooseQuery('binance'));
});
test('错误响应不会覆写最后有效盘口', async t => {
  const { e, store } = fixture(t, { lastUpdateId: 1, bids: [], asks: [] });
  store.state.rules.binance = { 'BTC/USDT': rule() }; const previous = book(); store.state.books.binance = { 'BTC/USDT': previous };
  await assert.rejects(e.book('binance', 'BTC/USDT'), /为空/); assert.deepEqual(store.state.books.binance['BTC/USDT'], previous);
});
test('未知订单返回不重发、不切换 Key', async t => {
  const { e, vault, store, calls } = fixture(t, () => { throw new ApiError('ECONNRESET', { unknown: true }); });
  store.state.accounts.binance = '1'; store.state.rules.binance = { 'BTC/USDT': rule() };
  for (let i = 0; i < 2; i++) vault.add({ exchange: 'binance', role: 'trade', apiKey: 'test-api-key123' + i, secret: 'test-secret123', accountUid: '1', sameAccountConfirmed: true });
  await assert.rejects(e.order('binance', { pair: 'BTC/USDT', side: 'BUY', qty: '1', price: '100', clientId: 'testorder1', guard: () => {} }), e => e.unknown === true);
  assert.equal(calls.length, 1); assert.equal(store.state.keys[0].requests, 1); assert.equal(store.state.keys[1].requests, 0);
});
test('Binance -1007 即使 HTTP 200 也标记执行未知', async t => {
  const { e, vault, store } = fixture(t, { code: -1007, msg: 'timeout' }); store.state.accounts.binance = '1'; store.state.rules.binance = { 'BTC/USDT': rule() };
  vault.add({ exchange: 'binance', role: 'trade', apiKey: 'test-api-key123', secret: 'test-secret123', accountUid: '1', sameAccountConfirmed: true });
  await assert.rejects(e.order('binance', { pair: 'BTC/USDT', side: 'BUY', qty: '1', price: '100', clientId: 'testorder1', guard: () => {} }), x => x.unknown);
});
test('下单响应无订单号判为未知', async t => {
  const { e, vault, store } = fixture(t, {}); store.state.accounts.binance = '1'; store.state.rules.binance = { 'BTC/USDT': rule() };
  vault.add({ exchange: 'binance', role: 'trade', apiKey: 'test-api-key123', secret: 'test-secret123', accountUid: '1', sameAccountConfirmed: true });
  await assert.rejects(e.order('binance', { pair: 'BTC/USDT', side: 'BUY', qty: '1', price: '100', clientId: 'testorder1', guard: () => {} }), x => x.unknown);
});
test('服务器时间过期时禁止签名请求', async t => {
  const { e, vault, store, calls } = fixture(t, {}); const id = vault.add({ exchange: 'binance', role: 'query', apiKey: 'test-api-key123', secret: 'test-secret123' });
  store.state.exchangeMeta.binance.clock.at = 0;
  await assert.rejects(e.request('binance', { path: '/api/v3/account', key: store.state.keys.find(k => k.id === id) }), /时间未同步/); assert.equal(calls.length, 0);
});
test('余额失败保留旧余额并设为不可用', async t => {
  const { e, store } = fixture(t, {}); store.state.balances.binance = { at: 100, valid: true, assets: { USDT: { free: '100' } } };
  await assert.rejects(e.balances('binance')); assert.equal(store.state.balances.binance.assets.USDT.free, '100'); assert.equal(store.state.balances.binance.valid, false); assert.match(store.state.balances.binance.error, /保留旧数据/);
});
