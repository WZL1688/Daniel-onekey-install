import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, validateConfig, LIVE_CONFIRM, LOSS_CONFIRM, RESOLVE_CONFIRM } from '../src/engine.js';
import { defaults, Store } from '../src/store.js';
import { ApiError } from '../src/scheduler.js';
import { readyEngine, setup, sleep } from './helpers.js';
test('实盘默认关闭，不能绕过开启确认', t => { const { store } = setup(t); const e = new Engine(store, {}); assert.equal(store.state.config.autoTrading, false); assert.throws(() => e.setLive(true, ''), /完整确认/); });
test('文档核对未完成时不能开启实盘', t => { const { engine, store } = readyEngine(t); engine.docsVerified.okx = false; store.state.config.autoTrading = false; assert.throws(() => engine.setLive(true, LIVE_CONFIRM), /官方 API 文档/); });
test('开启需真实费率确认与账户、余额', t => { const { engine, store } = readyEngine(t); store.state.config.feeConfirmed = false; assert.throws(() => engine.setLive(true, LIVE_CONFIRM), /费率/); });
test('实盘可显式停止', t => { const { engine, store } = readyEngine(t); engine.setLive(false); assert.equal(store.state.config.autoTrading, false); });
test('最终复核重新获取规则、余额、盘口，价格不可由前端指定', async t => {
  const { engine, calls } = readyEngine(t); const b = await engine.submit('BTC/USDT', 'binance');
  assert.equal(b.status, 'SUBMITTED'); assert.equal(calls.filter(x => x[0] === 'rules' && x[2] === 0 && x[3]).length, 2);
  assert.equal(calls.filter(x => x[0] === 'balances' && x[2] === 0).length, 2); assert.equal(calls.filter(x => x[0] === 'book' && x[2] === 0).length, 2);
  assert.ok(calls.findIndex(x => x[0] === 'order') > calls.findLastIndex(x => x[0] === 'book'));
  assert.equal(b.legs[0].qty, b.legs[1].qty); assert.equal(b.realizedNet, null); assert.equal(b.legs[0].status, 'ACKNOWLEDGED');
});
test('第一笔 API 返回之前不能发送第二腿', async t => {
  const x = readyEngine(t); let release, count = 0;
  x.exchange.order = async () => { count++; if (count === 1) await new Promise(r => { release = r; }); return { orderId: String(count), status: 'ACKNOWLEDGED' }; };
  const p = x.engine.submit('BTC/USDT', 'binance'); await sleep(10); assert.equal(count, 1); release(); const b = await p; assert.equal(count, 2); assert.equal(b.status, 'SUBMITTED');
});
for (const failure of ['ECONNRESET', 'timeout', 'MALFORMED_ACK']) test(`第一腿 ${failure} 未知结果不发送第二腿、不重发`, async t => {
  const { engine, exchange, store } = readyEngine(t); let count = 0;
  exchange.order = async () => { count++; throw new ApiError(failure, { unknown: true }); };
  const b = await engine.submit('BTC/USDT', 'binance'); assert.equal(count, 1); assert.equal(b.status, 'UNKNOWN'); assert.equal(store.state.config.autoTrading, false); assert.ok(store.state.blocks['BTC/USDT']);
  await assert.rejects(engine.submit('BTC/USDT', 'binance')); assert.equal(count, 1);
});
test('第二腿异常保留第一腿并阻塞，不重复买入', async t => {
  const { engine, exchange, store } = readyEngine(t); let count = 0;
  exchange.order = async () => { count++; if (count === 2) throw new ApiError('reset', { unknown: true }); return { orderId: '1', status: 'ACKNOWLEDGED' }; };
  const b = await engine.submit('BTC/USDT', 'binance'); assert.equal(count, 2); assert.equal(b.status, 'UNKNOWN'); assert.equal(b.legs[0].status, 'ACKNOWLEDGED'); assert.ok(store.state.blocks['BTC/USDT']);
});
test('明确拒绝的第一腿也不重试', async t => { const { engine, exchange, store } = readyEngine(t); let count = 0; exchange.order = async () => { count++; throw new ApiError('balance reject', { unknown: false }); }; const b = await engine.submit('BTC/USDT', 'binance'); assert.equal(b.status, 'REJECTED'); assert.equal(count, 1); assert.equal(store.state.config.autoTrading, false); });
test('最终余额不足则两腿都不发送', async t => { const { engine, store, calls } = readyEngine(t); store.state.balances.binance.assets.USDT.free = '1'; const b = await engine.submit('BTC/USDT', 'binance'); assert.equal(b.status, 'REJECTED'); assert.match(b.error, /余额/); assert.equal(calls.filter(x => x[0] === 'order').length, 0); });
test('卖侧库存需覆盖数量与潜在基础币费用', async t => { const { engine, store } = readyEngine(t); store.state.balances.okx.assets.BTC.free = '1'; const b = await engine.submit('BTC/USDT', 'binance'); assert.equal(b.status, 'REJECTED'); assert.match(b.error, /库存/); });
test('余额刷新失败时停止该路径', async t => { const { engine, exchange, calls } = readyEngine(t); exchange.balances = async () => { throw Error('余额更新失败，保留旧数据并暂停该路径'); }; const b = await engine.submit('BTC/USDT', 'binance'); assert.equal(b.status, 'REJECTED'); assert.equal(calls.filter(x => x[0] === 'order').length, 0); });
test('最新利润跌破门槛时不成交', async t => { const { engine, store } = readyEngine(t); store.state.config.minProfit = '100'; const b = await engine.submit('BTC/USDT', 'binance'); assert.equal(b.status, 'REJECTED'); assert.match(b.error, /门槛/); });
test('同一时刻只能执行一个批次', async t => { const { engine, exchange } = readyEngine(t); let release; exchange.order = async () => { await new Promise(r => { release = r; }); return { orderId: '1', status: 'ACKNOWLEDGED' }; }; const p = engine.submit('BTC/USDT', 'binance'); await sleep(10); await assert.rejects(engine.submit('BTC/USDT', 'binance'), /未处理订单/); engine.setLive(false); release(); await p; });
test('归档未知订单不清除安全阻塞', async t => { const { engine, exchange, store } = readyEngine(t); store.state.config.unknownAction = 'archive'; exchange.order = async () => { throw new ApiError('unknown', { unknown: true }); }; const b = await engine.submit('BTC/USDT', 'binance'); assert.equal(b.archived, true); assert.ok(store.state.blocks['BTC/USDT']); });
test('受理批次必须人工核对，不能当成已成交', async t => { const { engine, store } = readyEngine(t); const b = await engine.submit('BTC/USDT', 'binance'); assert.ok(store.state.blocks['BTC/USDT']); assert.equal(engine.unresolved().length, 1); assert.equal(b.realizedNet, null); });
test('人工核对必须有确认、依据、每腿数量和无开放订单', async t => {
  const { engine, store } = readyEngine(t); const b = await engine.submit('BTC/USDT', 'binance'); engine.setLive(false);
  assert.throws(() => engine.resolve(b.id, {}), /确认/);
  engine.resolve(b.id, { confirm: RESOLVE_CONFIRM, reference: '交易所订单记录已核对，残余库存已处理', realizedNet: '1.5', legs: b.legs.map(l => ({ outcome: 'FILLED', executedQty: l.qty, openQty: '0' })) });
  assert.equal(b.status, 'RESOLVED'); assert.equal(b.realizedNet, '1.5'); assert.equal(store.state.blocks['BTC/USDT'], undefined); assert.equal(store.state.balances.binance.valid, false);
});
test('正数最大亏损必须再次确认且不能超过金额', () => {
  const c = defaults().config, balance = { 'BTC/USDT': { enabled: true, amount: '10', stopDifference: '0.01', maxLoss: '1' } };
  assert.throws(() => validateConfig({ balance }, c), /再次确认/); assert.equal(validateConfig({ balance }, c, LOSS_CONFIRM).balance['BTC/USDT'].maxLoss, '1');
  balance['BTC/USDT'].maxLoss = '11'; assert.throws(() => validateConfig({ balance }, c, LOSS_CONFIRM), /不得超过/);
});
test('平衡高库存端卖，低库存端买，停止在配置差额内', t => {
  const { engine, store } = readyEngine(t); store.state.config.balance['BTC/USDT'] = { enabled: true, amount: '20', stopDifference: '1', maxLoss: '0' };
  store.state.balances.okx.assets.BTC.total = '12'; const d = engine.balanceDirection('BTC/USDT'); assert.equal(d.buyExchange, 'binance'); assert.equal(d.sellExchange, 'okx');
  store.state.balances.okx.assets.BTC.total = '10.5'; assert.match(engine.balanceDirection('BTC/USDT').reasons.join(), /停止差额/);
});
test('后台轮询公平轮转且页面读取不影响游标', async t => {
  const { engine, store } = readyEngine(t); store.state.config.autoTrading = false; store.state.config.pairs = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const ids = []; engine.poll = async id => { ids.push(id); }; engine.running = true;
  for (let i = 0; i < 4; i++) { store.state.engine.lastPollAt = 0; await engine.tick(); await sleep(2); }
  assert.deepEqual(ids, ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BTC/USDT']);
});
test('配置不能直接设置实盘开关或任意 API 地址', () => { const c = defaults().config; assert.throws(() => validateConfig({ autoTrading: true }, c), /未允许/); assert.throws(() => validateConfig({ apiUrl: 'http://evil' }, c), /未允许/); });
