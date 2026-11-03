import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Exchanges, signBinance, signOkx, parseExchangeJson } from '../src/exchanges.js';
import { ApiError } from '../src/scheduler.js';
import { setup, scheduler, rule, book, sleep, readyEngine } from './helpers.js';
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
function openOrderFixture(t, rows, maxPosition = true) {
  const x = fixture(t, rows);
  const id = x.vault.add({ exchange: 'binance', role: 'query', apiKey: 'query-api-key1234', secret: 'query-secret1234' });
  Object.assign(x.store.state.keys.find(k => k.id === id), { status: 'VERIFIED', accountUid: '123' });
  x.store.state.accounts.binance = '123';
  x.store.state.rules.binance = {
    'BTC/USDT': { ...rule(), filters: maxPosition ? [{ filterType: 'MAX_POSITION', maxPosition: '10' }] : [] },
    'BTC/USDC': { ...rule(), symbol: 'BTCUSDC' },
    'ETH/USDT': { ...rule(), symbol: 'ETHUSDT' },
  };
  return x;
}
test('MAX_POSITION 复核账户开放买单，不能遗漏同基础币的其他报价交易对', async t => {
  const x = openOrderFixture(t, [{ symbol: 'BTCUSDC', side: 'BUY', origQty: '4', executedQty: '1' }]);
  await assert.rejects(x.e.assertNoOpenOrders('binance', 'BTC/USDT'), /BTC.*其他交易对.*开放买单/);
  assert.equal(x.calls.length, 1);
  assert.equal(new URL(x.calls[0].url).searchParams.has('symbol'), false);
  assert.equal(x.s.rate('binance').windows.configured.used, 80);
});
test('同基础币另一交易对开放买单在最终复核拒绝批次，两腿均不发送', async t => {
  const x = readyEngine(t), requests = [];
  x.store.state.rules.binance['BTC/USDT'].filters = [{ filterType: 'MAX_POSITION', maxPosition: '100' }];
  x.store.state.rules.binance['BTC/USDC'] = { ...rule(), symbol: 'BTCUSDC' };
  const s = scheduler(t, x.store);
  const adapter = new Exchanges(x.store, x.vault, s, async request => {
    requests.push(request);
    return ok([{ symbol: 'BTCUSDC', side: 'BUY', origQty: '2', executedQty: '1' }]);
  });
  x.exchange.assertNoOpenOrders = (exchange, id) => exchange === 'binance' ? adapter.assertNoOpenOrders(exchange, id) : Promise.resolve();
  const batch = await x.engine.submit('BTC/USDT', 'binance');
  assert.equal(batch.status, 'REJECTED');
  assert.match(batch.error, /其他交易对.*开放买单/);
  assert.equal(requests.length, 1);
  assert.equal(x.calls.filter(call => call[0] === 'order').length, 0);
  assert.equal(batch.legs.length, 0);
});
test('MAX_POSITION 账户查询不会将其他基础币买单或同基础币卖单误算为开放买单', async t => {
  const x = openOrderFixture(t, [{ symbol: 'ETHUSDT', side: 'BUY', origQty: '2', executedQty: '1' }, { symbol: 'BTCUSDC', side: 'SELL', origQty: '3', executedQty: '0' }]);
  await x.e.assertNoOpenOrders('binance', 'BTC/USDT');
  assert.equal(x.calls.length, 1);
});
test('MAX_POSITION 账户查询仍拒绝当前交易对任意方向的开放订单', async t => {
  const x = openOrderFixture(t, [{ symbol: 'BTCUSDT', side: 'SELL', origQty: '1', executedQty: '0' }]);
  await assert.rejects(x.e.assertNoOpenOrders('binance', 'BTC/USDT'), /有开放订单/);
});
test('MAX_POSITION 遇到未知买单交易对或畸形账户订单时拒绝放行', async t => {
  for (const rows of [[{ symbol: 'UNKNOWNUSDT', side: 'BUY', origQty: '1', executedQty: '0' }], [{ symbol: 'BTCUSDC' }], [null]]) {
    const x = openOrderFixture(t, rows);
    await assert.rejects(x.e.assertNoOpenOrders('binance', 'BTC/USDT'), /无法复核最大持仓/);
  }
});
test('MAX_POSITION 拒绝畸形开放订单数量，已成交数量不能超过原数量', async t => {
  for (const qty of [{ origQty: '2', executedQty: '3' }, { origQty: '0', executedQty: '0' }, { origQty: '1', executedQty: '-1' }, { origQty: 'bad', executedQty: '0' }, {}]) {
    const x = openOrderFixture(t, [{ symbol: 'ETHUSDT', side: 'BUY', ...qty }]);
    await assert.rejects(x.e.assertNoOpenOrders('binance', 'BTC/USDT'), /开放订单数量错误/);
  }
});
test('没有 MAX_POSITION 的交易对保留单交易对查询及正确权重', async t => {
  const x = openOrderFixture(t, [], false);
  await x.e.assertNoOpenOrders('binance', 'BTC/USDT');
  assert.equal(new URL(x.calls[0].url).searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(x.s.rate('binance').windows.configured.used, 6);
});
const myFilters = assetFilters => ({ exchangeFilters: [], symbolFilters: [], assetFilters, rateLimits: [] });
function assetFilterFixture(t, assetFilters = []) { return openOrderFixture(t, myFilters(assetFilters), false); }
test('每次最终复核用查询 Key 签名查询 myFilters，没有百分比过滤器也取得新鲜账户上下文', async t => {
  const x = assetFilterFixture(t);
  const context = await x.e.priceContext('binance', 'BTC/USDT');
  assert.equal(x.calls.length, 1);
  const request = x.calls[0], url = new URL(request.url);
  assert.equal(url.pathname, '/api/v3/myFilters');
  assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
  assert.ok(url.searchParams.get('signature'));
  assert.equal(request.method, 'GET');
  assert.ok(request.headers['X-MBX-APIKEY']);
  assert.equal(request.mutation, false);
  assert.equal(x.s.rate('binance').windows.configured.used, 40);
  assert.equal(context.pair, 'BTC/USDT');
  assert.equal(context.accountUid, '123');
  assert.deepEqual(context.assetFilters, []);
  assert.doesNotThrow(() => x.e.assertPriceContext('binance', 'BTC/USDT', 'BUY', '1', '100', context));
  assert.doesNotThrow(() => x.e.assertPriceContext('binance', 'BTC/USDT', 'SELL', '1', '100', context));
});
test('MAX_ASSET 基础币数量上限同时限制买卖两侧，等于上限可以通过', async t => {
  const x = assetFilterFixture(t, [{ filterType: 'MAX_ASSET', asset: 'BTC', limit: '1' }]);
  const context = await x.e.priceContext('binance', 'BTC/USDT');
  for (const side of ['BUY', 'SELL']) {
    assert.doesNotThrow(() => x.e.assertPriceContext('binance', 'BTC/USDT', side, '1', '100', context));
    assert.throws(() => x.e.assertPriceContext('binance', 'BTC/USDT', side, '1.01', '100', context), /BTC MAX_ASSET/);
  }
});
test('MAX_ASSET 报价币按数量乘最终限价检查，买卖两侧不能超过账户单笔限额', async t => {
  const x = assetFilterFixture(t, [{ filterType: 'MAX_ASSET', asset: 'USDT', limit: '100' }]);
  const context = await x.e.priceContext('binance', 'BTC/USDT');
  for (const side of ['BUY', 'SELL']) {
    assert.doesNotThrow(() => x.e.assertPriceContext('binance', 'BTC/USDT', side, '1', '100', context));
    assert.throws(() => x.e.assertPriceContext('binance', 'BTC/USDT', side, '1', '100.01', context), /USDT MAX_ASSET/);
  }
});
test('myFilters 畸形响应、未知过滤器和重复资产限额拒绝放行', async t => {
  const malformed = [null, {}, { ...myFilters([]), exchangeFilters: null }, { ...myFilters([]), rateLimits: {} },
    myFilters(null), myFilters([null]), myFilters([{ filterType: 'FUTURE_FILTER', asset: 'BTC', limit: '1' }]),
    myFilters([{ filterType: 'MAX_ASSET', asset: 'ETH', limit: '1' }]),
    myFilters([{ filterType: 'MAX_ASSET', asset: 'BTC', limit: '-1' }]),
    myFilters([{ filterType: 'MAX_ASSET', asset: 'BTC' }]),
    myFilters([{ filterType: 'MAX_ASSET', asset: 'BTC', limit: '1' }, { filterType: 'MAX_ASSET', asset: 'BTC', limit: '2' }])];
  for (const response of malformed) {
    const x = openOrderFixture(t, response, false);
    await assert.rejects(x.e.priceContext('binance', 'BTC/USDT'));
  }
});
test('账户过滤器上下文缺失、过期、未来或绑定错误时禁止任何 Binance 订单', async t => {
  const x = assetFilterFixture(t);
  const context = await x.e.priceContext('binance', 'BTC/USDT');
  for (const invalid of [null, { ...context, assetFiltersAt: Date.now() - 10001 }, { ...context, assetFiltersAt: Date.now() + 2000 },
    { ...context, pair: 'ETH/USDT' }, { ...context, accountUid: '456' }, { ...context, assetFilters: null }]) {
    assert.throws(() => x.e.assertPriceContext('binance', 'BTC/USDT', 'BUY', '1', '100', invalid));
  }
});
test('myFilters 只选查询 Key，只有交易 Key 时不发送私有查询', async t => {
  const x = fixture(t, myFilters([]));
  x.store.state.rules.binance = { 'BTC/USDT': rule() }; x.store.state.accounts.binance = '123';
  x.vault.add({ exchange: 'binance', role: 'trade', apiKey: 'trade-api-key1234', secret: 'trade-secret1234', accountUid: '123', sameAccountConfirmed: true });
  await assert.rejects(x.e.priceContext('binance', 'BTC/USDT'), /没有已验证同账户的查询 Key/);
  assert.equal(x.calls.length, 0);
});
test('百分比价格复核保留 myFilters 的原始取得时间，不把较晚价格刷新当成账户规则刷新', async t => {
  const x = assetFilterFixture(t, [{ filterType: 'MAX_ASSET', asset: 'BTC', limit: '2' }]);
  x.store.state.rules.binance['BTC/USDT'].filters = [{ filterType: 'PERCENT_PRICE', multiplierUp: '1.1', multiplierDown: '0.9', avgPriceMins: 5 }];
  let release;
  x.e.transport = async request => {
    x.calls.push(request);
    if (new URL(request.url).pathname === '/api/v3/myFilters') return ok(myFilters([{ filterType: 'MAX_ASSET', asset: 'BTC', limit: '2' }]));
    await new Promise(resolve => { release = resolve; });
    return ok({ referencePrice: '100' });
  };
  const promise = x.e.priceContext('binance', 'BTC/USDT');
  while (!release) await sleep(2);
  await sleep(5); release();
  const context = await promise;
  assert.ok(context.at > context.assetFiltersAt);
  assert.equal(x.calls.length, 2);
  assert.doesNotThrow(() => x.e.assertPriceContext('binance', 'BTC/USDT', 'BUY', '1', '105', context));
  assert.throws(() => x.e.assertPriceContext('binance', 'BTC/USDT', 'BUY', '1', '111', context), /百分比/);
});
