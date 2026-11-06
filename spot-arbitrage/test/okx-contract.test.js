import test from 'node:test';
import assert from 'node:assert/strict';
import { Exchanges } from '../src/exchanges.js';
import { setup, scheduler, rule, book, readyEngine } from './helpers.js';

const ok = data => ({ status: 200, headers: {}, data: { code: '0', data } });
const account = overrides => ({ uid: '456', acctLv: '1', roleType: '0', spotRoleType: '0', ...overrides });
const instrument = (quote = 'USD', overrides) => ({ instId: `${quote === 'BTC' ? 'ETH' : 'BTC'}-${quote}`, instType: 'SPOT', baseCcy: quote === 'BTC' ? 'ETH' : 'BTC', quoteCcy: quote,
  state: 'live', lotSz: '0.01', tickSz: '0.01', minSz: '0.01', maxLmtSz: '100000', maxLmtAmt: '1000000', tradeQuoteCcyList: [quote], ...overrides });
function fixture(t, { quote = 'USD', config = account(), instruments, respond } = {}) {
  const x = setup(t), s = scheduler(t, x.store), calls = [], id = `${quote === 'BTC' ? 'ETH' : 'BTC'}/${quote}`;
  x.store.state.accounts.okx = '456';
  x.store.state.exchangeMeta.okx = { clock: { at: Date.now(), offset: 0 } };
  x.store.state.rules.okx = { [id]: { ...rule(), symbol: id.replace('/', '-'), maxUsdNotional: '1000000' } };
  const queryId = x.vault.add({ exchange: 'okx', role: 'query', apiKey: 'mock-query-key1234', secret: 'mock-query-secret1234', passphrase: 'mock-passphrase' });
  const query = x.store.state.keys.find(key => key.id === queryId);
  Object.assign(query, { accountUid: '456', status: 'VERIFIED' });
  x.vault.add({ exchange: 'okx', role: 'trade', apiKey: 'mock-trade-key1234', secret: 'mock-trade-secret1234', passphrase: 'mock-passphrase', accountUid: '456', sameAccountConfirmed: true });
  const e = new Exchanges(x.store, x.vault, s, async request => {
    calls.push(request); const route = new URL(request.url).pathname;
    if (respond) { const response = respond(request, route); if (response !== undefined) return response; }
    if (route === '/api/v5/account/config') return ok([config]);
    if (route === '/api/v5/account/instruments') return ok(instruments ?? [instrument(quote)]);
    if (route === '/api/v5/trade/order') return ok([{ sCode: '0', ordId: '12345678901234567890', clOrdId: JSON.parse(request.body).clOrdId }]);
    throw Error('Unexpected mock route');
  });
  return { ...x, e, s, calls, id, query };
}
const order = id => ({ pair: id, side: 'BUY', qty: '1', price: '100', clientId: 'contractOrder1', guard: () => {} });

test('OKX maxLmtAmt 保留为美元限额，不作为报价资产 maxNotional 筛选', async t => {
  const x = fixture(t, { quote: 'BTC', respond: (_request, route) => route === '/api/v5/public/instruments' ? ok([instrument('BTC', { baseCcy: 'ETH', instId: 'ETH-BTC', maxLmtAmt: '100' })]) : undefined });
  await x.e.rules('okx', 0, true);
  assert.equal(x.store.state.rules.okx['ETH/BTC'].maxNotional, null);
  assert.equal(x.store.state.rules.okx['ETH/BTC'].maxUsdNotional, '100');
});
test('OKX 重启后旧缓存美元上限不得继续作为报价币上限使用', async t => {
  const x = fixture(t, { respond: (_request, route) => route === '/api/v5/public/instruments' ? ok([instrument()]) : undefined });
  x.store.state.exchangeMeta.okx.rulesAt = Date.now();
  delete x.store.state.rules.okx[x.id].maxUsdNotional;
  x.store.state.rules.okx[x.id].maxNotional = '1000000';
  await x.e.rules('okx');
  assert.equal(x.calls.length, 1);
  assert.equal(x.store.state.rules.okx[x.id].maxNotional, null);
  assert.equal(x.store.state.rules.okx[x.id].maxUsdNotional, '1000000');
});
test('OKX 公共盘口不需要账户上下文或私人 Key', async t => {
  const x = fixture(t, { quote: 'USDT', respond: (_request, route) => route === '/api/v5/market/books' ? ok([{ ts: String(Date.now()), bids: [['99', '2']], asks: [['100', '2']] }]) : undefined });
  const result = await x.e.book('okx', x.id);
  assert.equal(result.pair, x.id); assert.equal(result.exchangeAt > 0, true);
  assert.deepEqual(x.calls[0].headers, {}); assert.equal(x.calls.length, 1);
});
test('OKX 缺失、畸形、过期及未来盘口时间均拒绝并保留最后有效盘口', async t => {
  for (const ts of [undefined, '', 'NaN', 'Infinity', '-1', '0', '1.5', '9007199254740992', String(Date.now() - 60000), String(Date.now() + 60000)]) {
    const x = fixture(t, { respond: () => ok([{ ts, bids: [['99', '2']], asks: [['100', '2']] }]) });
    const previous = book(x.id); x.store.state.books.okx = { [x.id]: previous };
    await assert.rejects(x.e.book('okx', x.id), /盘口时间/);
    assert.deepEqual(x.store.state.books.okx[x.id], previous);
  }
});
test('OKX 盘口时间使用已同步服务器时钟，不把允许的本地时差误判为未来盘口', async t => {
  const x = fixture(t, { respond: () => ok([{ ts: String(Date.now() + 5000), bids: [['99', '2']], asks: [['100', '2']] }]) });
  x.store.state.exchangeMeta.okx.clock.offset = 5000;
  await x.e.book('okx', x.id);
});
test('OKX cash 账户模式与普通角色在查询 Key 验证时核验', async t => {
  for (const acctLv of ['1', '2']) {
    const x = fixture(t, { config: account({ acctLv }) });
    assert.equal(await x.e.validateKey(x.query.id), '456');
    assert.equal(x.query.status, 'VERIFIED');
  }
});
test('OKX 多币种保证金、组合保证金、跟单及未知账户拒绝验证', async t => {
  for (const config of [account({ acctLv: '3' }), account({ acctLv: '4' }), account({ acctLv: undefined }), account({ roleType: '1' }), account({ spotRoleType: '2' }), account({ spotRoleType: undefined })]) {
    const x = fixture(t, { config });
    await assert.rejects(x.e.validateKey(x.query.id), /账户模式|账户角色/);
    assert.equal(x.query.status, 'FAILED');
    assert.equal(x.calls.every(request => request.method === 'GET'), true);
  }
});
test('OKX 最终复核重新查询账户模式，避免验证后切换保证金模式', async t => {
  const x = fixture(t, { config: account({ acctLv: '3' }) });
  await assert.rejects(x.e.priceContext('okx', x.id), /账户模式/);
  assert.equal(x.calls.length, 1);
  await assert.rejects(x.e.order('okx', order(x.id)), error => error.unknown === false);
  assert.equal(x.calls.length, 1);
});
test('OKX 区域报价资产来自账户交易对列表，只允许当前报价资产', async t => {
  const x = fixture(t, { instruments: [instrument('USD', { tradeQuoteCcyList: ['USD', 'USDC'] })] });
  const context = await x.e.priceContext('okx', x.id);
  assert.equal(context.tradeQuoteCcy, 'USD');
  assert.equal(context.accountUid, '456');
  assert.equal(x.calls.length, 2);
  assert.equal(new URL(x.calls[1].url).searchParams.get('instId'), 'BTC-USD');
  assert.equal(new URL(x.calls[1].url).searchParams.get('instType'), 'SPOT');
  assert.equal(x.store.state.keys.find(key => key.role === 'trade').requests, 0);
});
test('OKX 缺失报价支持、不同账户或错误交易对在最终复核拒绝', async t => {
  for (const options of [{ instruments: [instrument('USD', { tradeQuoteCcyList: [] })] }, { instruments: [instrument('USD', { tradeQuoteCcyList: ['USDC'] })] },
    { instruments: [instrument('USD', { tradeQuoteCcyList: undefined })] }, { instruments: [instrument('USD', { instId: 'ETH-USD' })] },
    { instruments: [instrument('USD', { state: 'suspend' })] }, { instruments: [] }, { config: account({ uid: '999' }) }]) {
    const x = fixture(t, options);
    await assert.rejects(x.e.priceContext('okx', x.id), /报价资产|账户交易对|账户 UID/);
    assert.equal(x.calls.every(request => request.method === 'GET'), true);
  }
});
test('OKX 美元限额不能按 USDT 或 BTC 报价金额复核，实际提交前停止', async t => {
  for (const quote of ['USDT', 'USDC', 'BTC']) {
    const x = fixture(t, { quote }), context = await x.e.priceContext('okx', x.id);
    assert.throws(() => x.e.assertPriceContext('okx', x.id, 'BUY', '1', '100', context), /美元换算/);
    await assert.rejects(x.e.order('okx', order(x.id)), error => error.unknown === false && /美元换算/.test(error.message));
    assert.equal(x.calls.length, 2);
  }
});
test('OKX 报价资产美元换算缺失在统一最终复核阻止两腿，不能先买 Binance', async t => {
  const x = readyEngine(t), adapted = fixture(t, { quote: 'USDT' });
  x.exchange.priceContext = exchange => exchange === 'okx' ? adapted.e.priceContext(exchange, 'BTC/USDT') : Promise.resolve(null);
  x.exchange.assertPriceContext = (exchange, ...args) => { if (exchange === 'okx') adapted.e.assertPriceContext(exchange, ...args); };
  const batch = await x.engine.submit('BTC/USDT', 'binance');
  assert.equal(batch.status, 'REJECTED'); assert.equal(batch.legs.length, 0);
  assert.match(batch.error, /美元换算/);
  assert.equal(x.calls.filter(call => call[0] === 'order').length, 0);
  assert.equal(adapted.calls.every(request => request.method === 'GET'), true);
});
test('OKX 美元报价同时检查公开和账户单笔美元上限，缺失上限不可绕过', async t => {
  const x = fixture(t), context = await x.e.priceContext('okx', x.id);
  assert.doesNotThrow(() => x.e.assertPriceContext('okx', x.id, 'BUY', '1', '100', context));
  for (const value of ['99', null, '', 'NaN', '0', '-1']) {
    assert.throws(() => x.e.assertPriceContext('okx', x.id, 'BUY', '1', '100', { ...context, maxUsdNotional: value }), /美元单笔限额/);
  }
  x.store.state.rules.okx[x.id].maxUsdNotional = '99';
  assert.throws(() => x.e.assertPriceContext('okx', x.id, 'BUY', '1', '100', context), /美元单笔限额/);
});
test('OKX 缺失、过期或身份不匹配上下文不允许发送订单', async t => {
  const x = fixture(t), context = await x.e.priceContext('okx', x.id);
  for (const invalid of [null, { ...context, at: Date.now() - 10001 }, { ...context, at: Date.now() + 10000 }, { ...context, at: NaN },
    { ...context, accountUid: '999' }, { ...context, pair: 'ETH/USD' }, { ...context, tradeQuoteCcy: 'USDC' }, { ...context, accountMode: '3' }]) {
    x.e.okxContexts.set(x.id, invalid);
    await assert.rejects(x.e.order('okx', order(x.id)), error => error.unknown === false && /复核上下文/.test(error.message));
  }
  assert.equal(x.calls.length, 2);
});
test('OKX 有效 IOC 提交使用原数量、显式报价资产并禁止自动改价，只标记受理', async t => {
  const x = fixture(t); await x.e.priceContext('okx', x.id);
  const ack = await x.e.order('okx', order(x.id));
  assert.equal(ack.status, 'ACKNOWLEDGED'); assert.equal(ack.clientId, 'contractOrder1');
  assert.deepEqual(JSON.parse(x.calls.at(-1).body), { instId: 'BTC-USD', tdMode: 'cash', side: 'buy', ordType: 'ioc', sz: '1', px: '100', clOrdId: 'contractOrder1', pxAmendType: '0', tradeQuoteCcy: 'USD' });
  assert.equal(x.calls.filter(request => request.mutation).length, 1);
  assert.equal(x.store.state.keys.find(key => key.role === 'trade').requests, 1);
});
test('OKX 排队期间复核上下文失效不发送，也不标记提交未知', async t => {
  const x = fixture(t), context = await x.e.priceContext('okx', x.id);
  await assert.rejects(x.e.order('okx', { ...order(x.id), guard: () => { context.at = Date.now() - 10001; } }), error => error.unknown === false && /复核上下文/.test(error.message));
  assert.equal(x.calls.length, 2);
});
test('OKX 收到其他或缺失客户端订单号及多项 ACK 均判定未知，绝不重发', async t => {
  for (const rows of [[{ sCode: '0', ordId: '123', clOrdId: 'anotherOrder' }], [{ sCode: '0', ordId: '123' }],
    [{ sCode: '0', ordId: '123', clOrdId: 'contractOrder1' }, { sCode: '0', ordId: '456', clOrdId: 'other' }]]) {
    const x = fixture(t, { respond: (_request, route) => route === '/api/v5/trade/order' ? ok(rows) : undefined });
    await x.e.priceContext('okx', x.id);
    await assert.rejects(x.e.order('okx', order(x.id)), error => error.unknown === true && /身份不匹配/.test(error.message));
    assert.equal(x.calls.filter(request => request.mutation).length, 1);
  }
});
test('OKX 已受理但订单身份异常停止批次，不发送后续腿', async t => {
  const x = readyEngine(t), adapted = fixture(t, { respond: (_request, route) => route === '/api/v5/trade/order' ? ok([{ sCode: '0', ordId: '123', clOrdId: 'another' }]) : undefined });
  x.store.state.books.okx['BTC/USDT'] = book('BTC/USDT', '99', '100');
  x.store.state.books.binance['BTC/USDT'] = book('BTC/USDT', '102', '103');
  await adapted.e.priceContext('okx', adapted.id);
  let secondLeg = 0;
  x.exchange.order = (exchange, intent) => exchange === 'okx' ? adapted.e.order(exchange, { ...intent, pair: adapted.id }) : (++secondLeg, Promise.reject(Error('后续腿不应提交')));
  const batch = await x.engine.submit('BTC/USDT', 'okx');
  assert.equal(batch.status, 'UNKNOWN'); assert.equal(batch.legs.length, 1);
  assert.equal(batch.legs[0].status, 'UNKNOWN'); assert.equal(secondLeg, 0);
  assert.equal(adapted.calls.filter(request => request.mutation).length, 1);
});
test('OKX 库存合计使用 cashBal，冻结余额重叠不得放大资金配额', async t => {
  const x = fixture(t, { respond: (_request, route) => route === '/api/v5/account/balance' ? ok([{ details: [{ ccy: 'BTC', cashBal: '10', availBal: '8', frozenBal: '5' }] }]) : undefined });
  const balance = await x.e.balances('okx');
  assert.deepEqual(balance.assets.BTC, { free: '8', locked: '5', total: '10' });
});
test('OKX 不完整、重复或可用余额超过现金库存时保留旧库存并暂停路径', async t => {
  for (const details of [[{ ccy: 'BTC', cashBal: undefined, availBal: '8', frozenBal: '1' }], [{ ccy: 'BTC', cashBal: '7', availBal: '8', frozenBal: '0' }],
    [{ ccy: 'BTC', cashBal: '10', availBal: undefined, frozenBal: '0' }], [{ ccy: 'BTC', cashBal: '10', availBal: '8', frozenBal: '0' }, { ccy: 'BTC', cashBal: '1', availBal: '1', frozenBal: '0' }]]) {
    const x = fixture(t, { respond: (_request, route) => route === '/api/v5/account/balance' ? ok([{ details }]) : undefined });
    x.store.state.balances.okx = { at: 1, valid: true, assets: { BTC: { free: '3', locked: '0', total: '3' } } };
    await assert.rejects(x.e.balances('okx'), /余额|资产/);
    assert.equal(x.store.state.balances.okx.valid, false);
    assert.equal(x.store.state.balances.okx.assets.BTC.total, '3');
  }
});
test('OKX 撤单 ACK 必须匹配订单号，否则标记未知且不重发', async t => {
  const x = fixture(t, { respond: (_request, route) => route === '/api/v5/trade/cancel-order' ? ok([{ sCode: '0', ordId: '999' }]) : undefined });
  await assert.rejects(x.e.cancel('okx', x.id, '123'), error => error.unknown === true && /身份不匹配/.test(error.message));
  assert.equal(x.calls.length, 1);
});
