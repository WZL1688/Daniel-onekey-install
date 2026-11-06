import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, validateConfig, LIVE_CONFIRM, RESOLVE_CONFIRM, RISK_RESET_CONFIRM } from '../src/engine.js';
import { Store, defaults } from '../src/store.js';
import { evaluate, normalizeBook } from '../src/math.js';
import { readyEngine } from './helpers.js';

function noFees(state) {
  Object.assign(state.config, { fees: { binance: '0', okx: '0' }, buffer: '0', minProfit: '0', minDepthProfit: '0' });
}
function quota(state, byExchange) {
  state.config.capital = { enabled: true, byExchange: { binance: {}, okx: {}, ...byExchange } };
}
function resolved(engine, batch, realizedNet) {
  engine.setLive(false);
  engine.resolve(batch.id, { confirm: RESOLVE_CONFIRM, reference: '已核对交易所两腿订单、费用及剩余库存', realizedNet,
    legs: batch.legs.map(leg => ({ outcome: 'FILLED', executedQty: leg.qty, openQty: '0' })) });
}
function clippedMarket(state) {
  noFees(state);
  state.config.amount = '100'; state.config.fallbackAmounts = [];
  state.books.binance['BTC/USDT'] = normalizeBook({ pair: 'BTC/USDT', at: Date.now(), bids: [['99', '100']], asks: [['100', '0.5'], ['130', '100']] }, 'BTC/USDT');
  state.books.okx['BTC/USDT'] = normalizeBook({ pair: 'BTC/USDT', at: Date.now(), bids: [['110', '100']], asks: [['111', '100']] }, 'BTC/USDT');
  quota(state, { binance: { USDT: { reserve: '0', maxOrder: '50', maxHolding: null } }, okx: { USDT: { reserve: '0', maxOrder: '44.4', maxHolding: null } } });
}

test('新增设置默认不启用限制，嵌套补丁保留其他场所和资产设置', () => {
  const original = defaults().config;
  assert.equal(original.capital.enabled, false);
  assert.deepEqual(original.risk.dailyLossByQuote, {});
  const first = validateConfig({ costs: { rebalanceByQuote: { USDT: '0.1', USDC: '0.2' } }, filters: { maxSpreadBps: '100' },
    capital: { enabled: true, byExchange: { binance: { USDT: { reserve: '10', maxOrder: '30', maxHolding: null } }, okx: { BTC: { reserve: '1', maxOrder: '2', maxHolding: '4' } } } },
    risk: { dailyLossByQuote: { USDT: '5', USDC: '4' } } }, original);
  const next = validateConfig({ costs: { rebalanceByQuote: { USDT: '0.3' } }, filters: { minNetBps: '1' },
    capital: { byExchange: { binance: { USDT: { reserve: '12' } } } }, risk: { dailyLossByQuote: { USDT: '6' } } }, first);
  assert.equal(next.costs.rebalanceByQuote.USDC, '0.2');
  assert.equal(next.filters.maxSpreadBps, '100');
  assert.equal(next.capital.byExchange.binance.USDT.maxOrder, '30');
  assert.equal(next.capital.byExchange.binance.USDT.reserve, '12');
  assert.equal(next.capital.byExchange.okx.BTC.maxHolding, '4');
  assert.equal(next.risk.dailyLossByQuote.USDC, '4');
  assert.equal(first.capital.byExchange.binance.USDT.reserve, '10');
  const deleted = validateConfig({ costs: { rebalanceByQuote: { USDT: null } },
    capital: { byExchange: { binance: { USDT: null } } }, risk: { dailyLossByQuote: { USDT: null } } }, next);
  assert.equal(deleted.costs.rebalanceByQuote.USDT, undefined);
  assert.equal(deleted.costs.rebalanceByQuote.USDC, '0.2');
  assert.equal(deleted.capital.byExchange.binance.USDT, undefined);
  assert.equal(deleted.capital.byExchange.okx.BTC.maxHolding, '4');
  assert.equal(deleted.risk.dailyLossByQuote.USDT, undefined);
  assert.equal(deleted.risk.dailyLossByQuote.USDC, '4');
});

test('新增配置严格拒绝负数、假布尔值、未知字段和原型属性且不修改旧设置', () => {
  const config = defaults().config, snapshot = structuredClone(config);
  for (const patch of [
    { costs: { rebalanceByQuote: { USDT: '-1' } } },
    { filters: { maxBookSkewMs: 0.5 } },
    { filters: { minNetBps: '-1' } },
    { capital: { enabled: 'false' } },
    { capital: { byExchange: { binance: { USDT: { reserve: '-1' } } } } },
    { risk: { dailyLossByQuote: { USDT: '-1' } } },
    { risk: { latched: false } },
    { capital: { byExchange: { unknown: {} } } },
    { capital: { byExchange: { binance: { USDT: new Date() } } } },
    JSON.parse('{"capital":{"byExchange":{"binance":{"__proto__":{"enabled":true}}}}}'),
  ]) assert.throws(() => validateConfig(patch, config));
  assert.deepEqual(config, snapshot);
  assert.equal({}.enabled, undefined);
});

test('最终复核按每所资产配额缩量并重新穿透盘口，批次保存配额快照', async t => {
  const { engine, store, calls } = readyEngine(t), state = store.state;
  noFees(state);
  state.books.binance['BTC/USDT'] = normalizeBook({ pair: 'BTC/USDT', at: Date.now(), bids: [['99', '100']], asks: [['100', '0.3'], ['110', '100']] }, 'BTC/USDT');
  state.books.okx['BTC/USDT'] = normalizeBook({ pair: 'BTC/USDT', at: Date.now(), bids: [['120', '100']], asks: [['121', '100']] }, 'BTC/USDT');
  quota(state, { binance: { USDT: { reserve: '9945', maxOrder: '55', maxHolding: null }, BTC: { reserve: '0', maxOrder: null, maxHolding: '10.5' } },
    okx: { BTC: { reserve: '0', maxOrder: '0.75', maxHolding: null } } });
  const batch = await engine.submit('BTC/USDT', 'binance');
  assert.equal(batch.status, 'SUBMITTED');
  assert.equal(batch.opportunity.qty, '0.5');
  assert.equal(batch.opportunity.buyLimit, '110');
  assert.equal(batch.opportunity.buyCost, '52');
  assert.equal(batch.opportunity.buyWorstCost, '55');
  assert.equal(batch.opportunity.net, '8');
  assert.equal(batch.opportunity.conservative, '5');
  assert.ok(batch.capital);
  assert.equal(batch.capital.enabled, true);
  assert.deepEqual(calls.filter(x => x[0] === 'order').map(x => x[2].qty), ['0.5', '0.5']);
  state.config.capital.byExchange.binance.USDT.reserve = '9999';
  assert.notDeepEqual(batch.capital, state.config.capital);
});

test('轮询使用缓存配额发现缩量后才盈利的机会并自动提交相同最终数量', async t => {
  const { engine, store, calls } = readyEngine(t), state = store.state;
  clippedMarket(state);
  const raw = evaluate({ buy: state.books.binance['BTC/USDT'], sell: state.books.okx['BTC/USDT'], buyRule: state.rules.binance['BTC/USDT'], sellRule: state.rules.okx['BTC/USDT'], buyExchange: 'binance', sellExchange: 'okx', settings: state.config });
  assert.equal(raw.qty, '0.88');
  assert.equal(raw.eligible, false);
  assert.equal(raw.net, '-2.6');
  await engine.poll('BTC/USDT');
  const preview = state.opportunities['BTC/USDT'].directions.find(direction => direction.buyExchange === 'binance');
  assert.equal(preview.qty, '0.5');
  assert.equal(preview.net, '5');
  assert.equal(preview.conservative, '5');
  assert.equal(preview.eligible, true);
  assert.equal(preview.capital.checked, true);
  assert.equal(preview.capital.status, 'CACHED');
  const batch = state.batches[0];
  assert.equal(batch.status, 'SUBMITTED');
  assert.equal(batch.opportunity.qty, '0.5');
  assert.equal(batch.capital.status, 'PREFLIGHT');
  assert.deepEqual(calls.filter(call => call[0] === 'order').map(call => call[2].qty), ['0.5', '0.5']);
  // Preview uses only cached balances; exactly the final preflight refreshes both.
  assert.equal(calls.filter(call => call[0] === 'balances').length, 2);
});

test('两向机会、平衡及筛选预览复用缓存配额，不额外查询余额', async t => {
  const { engine, store, calls } = readyEngine(t), state = store.state;
  clippedMarket(state); state.config.autoTrading = false;
  state.config.balance['BTC/USDT'] = { enabled: true, amount: '100', stopDifference: '0', maxLoss: '0' };
  state.balances.okx.assets.BTC.total = '12';
  await engine.poll('BTC/USDT');
  const directions = state.opportunities['BTC/USDT'].directions;
  assert.equal(directions.find(direction => direction.buyExchange === 'binance').qty, '0.5');
  assert.equal(directions.find(direction => direction.buyExchange === 'okx').qty, '0.4');
  assert.ok(directions.every(direction => direction.capital.checked && direction.capital.status === 'CACHED'));
  const beforeBalancePreview = calls.length, balance = engine.balanceDirection('BTC/USDT');
  assert.equal(balance.qty, '0.5');
  assert.equal(balance.eligible, true);
  assert.equal(balance.capital.checked, true);
  assert.equal(calls.length, beforeBalancePreview);
  await engine.scanOne();
  assert.equal(state.scanResults['BTC/USDT'].directions.find(direction => direction.buyExchange === 'binance').qty, '0.5');
  assert.equal(calls.filter(call => call[0] === 'balances').length, 0);
  assert.equal(calls.filter(call => call[0] === 'order').length, 0);
});

test('配额预览缺少有效余额时保留市场数据并明确标记资金未核对', async t => {
  const { engine, store, calls } = readyEngine(t), state = store.state;
  clippedMarket(state); state.config.autoTrading = false;
  state.balances.binance.at = Date.now() - state.config.maxBalanceAgeMs - 100;
  await engine.poll('BTC/USDT');
  let preview = state.opportunities['BTC/USDT'].directions.find(direction => direction.buyExchange === 'binance');
  assert.equal(preview.qty, '0.88');
  assert.equal(preview.capital.enabled, true);
  assert.equal(preview.capital.checked, false);
  assert.equal(preview.capital.status, 'UNCONFIRMED');
  assert.match(preview.capital.error, /binance.*余额过期/);
  delete state.balances.binance;
  preview = engine.previewDirection('BTC/USDT', 'binance', 'okx');
  assert.equal(preview.qty, '0.88');
  assert.equal(preview.capital.checked, false);
  assert.match(preview.capital.error, /资金配额无法复核/);
  assert.equal(calls.filter(call => call[0] === 'balances').length, 0);
  assert.equal(calls.filter(call => call[0] === 'order').length, 0);
});

test('缩量后利润不足则拒绝新单，不沿用缩量前收益', async t => {
  const { engine, store, calls } = readyEngine(t), state = store.state;
  noFees(state); state.config.minProfit = '0.5'; state.config.minDepthProfit = '0.5';
  quota(state, { binance: { USDT: { reserve: '0', maxOrder: '10', maxHolding: null } } });
  const batch = await engine.submit('BTC/USDT', 'binance');
  assert.equal(batch.status, 'REJECTED');
  assert.match(batch.error, /净利润.*门槛/);
  assert.equal(calls.filter(x => x[0] === 'order').length, 0);
});

for (const mode of ['arbitrage', 'balance']) test(`${mode} 提交都执行最终配额且排队期间变化会拒绝发送`, async t => {
  const { engine, store, exchange } = readyEngine(t), state = store.state;
  noFees(state);
  if (mode === 'balance') {
    state.config.balance['BTC/USDT'] = { enabled: true, amount: '100', stopDifference: '0', maxLoss: '0' };
    state.balances.okx.assets.BTC.total = '12';
  }
  quota(state, { binance: { USDT: { reserve: '0', maxOrder: '100', maxHolding: null } } });
  let attempts = 0, sent = 0;
  exchange.order = async (_ex, order) => {
    attempts++;
    state.config.capital.byExchange.binance.USDT.maxOrder = '0';
    try { order.guard(); } catch (error) { error.unknown = false; throw error; }
    sent++;
    return { orderId: '1', status: 'ACKNOWLEDGED' };
  };
  const batch = await engine.submit('BTC/USDT', 'binance', mode);
  assert.equal(batch.status, 'REJECTED');
  assert.match(batch.error, /配额|上限|额度/);
  assert.equal(attempts, 1);
  assert.equal(sent, 0);
});

test('动态平衡同时遵守库存差额和资金配额，以相同数量提交两腿', async t => {
  const { engine, store } = readyEngine(t), state = store.state;
  noFees(state);
  state.config.balance['BTC/USDT'] = { enabled: true, amount: '100', stopDifference: '0.2', maxLoss: '0' };
  state.balances.okx.assets.BTC.total = '10.6'; // inventory cap 0.2 BTC
  quota(state, { binance: { USDT: { reserve: '0', maxOrder: '15', maxHolding: null } } });
  const batch = await engine.submit('BTC/USDT', 'binance', 'balance');
  assert.equal(batch.status, 'SUBMITTED');
  assert.equal(batch.opportunity.qty, '0.15');
  assert.deepEqual(batch.legs.map(leg => leg.qty), ['0.15', '0.15']);
});

test('第一腿受理后配额失效会保留未完成批次且不发送或重发第二腿', async t => {
  const { engine, store, exchange } = readyEngine(t), state = store.state;
  noFees(state); quota(state, { okx: { BTC: { reserve: '0', maxOrder: '2', maxHolding: null } } });
  let sent = 0;
  exchange.order = async (_ex, order) => {
    order.guard(); sent++;
    state.config.capital.byExchange.okx.BTC.maxOrder = '0';
    return { orderId: String(sent), status: 'ACKNOWLEDGED' };
  };
  const batch = await engine.submit('BTC/USDT', 'binance');
  assert.equal(batch.status, 'INCOMPLETE');
  assert.equal(batch.legs[0].status, 'ACKNOWLEDGED');
  assert.equal(sent, 1);
  assert.ok(state.blocks['BTC/USDT']);
  await assert.rejects(engine.submit('BTC/USDT', 'binance'));
  assert.equal(sent, 1);
});

test('成本与流动性设置在后台最新复核生效，浏览器机会不能绕过', async t => {
  const { engine, store, calls } = readyEngine(t), state = store.state;
  state.config.costs.rebalanceByQuote.USDT = '100';
  let batch = await engine.submit('BTC/USDT', 'binance');
  assert.equal(batch.status, 'REJECTED');
  assert.match(batch.error, /净利润.*门槛/);
  assert.equal(calls.filter(x => x[0] === 'order').length, 0);
  state.config.autoTrading = true; state.config.costs.rebalanceByQuote.USDT = '0';
  state.config.filters.minDepthNotional = '1000000000';
  batch = await engine.submit('BTC/USDT', 'binance');
  assert.equal(batch.status, 'REJECTED');
  assert.match(batch.error, /深度/);
  assert.equal(calls.filter(x => x[0] === 'order').length, 0);
});

test('人工核对亏损触发熔断，利润估计不算实际亏损且重启保留锁定', async t => {
  const { engine, store, exchange, dir } = readyEngine(t), state = store.state;
  state.config.risk.dailyLossByQuote.USDT = '1';
  const batch = await engine.submit('BTC/USDT', 'binance');
  assert.equal(engine.riskStatus().latched, false);
  resolved(engine, batch, '-1');
  assert.equal(engine.riskStatus().latched, true);
  assert.equal(engine.riskStatus().lossByQuote.USDT, '1');
  assert.equal(state.config.autoTrading, false);
  assert.throws(() => engine.setLive(true, LIVE_CONFIRM), /风险熔断/);
  await assert.rejects(engine.submit('BTC/USDT', 'binance'), /风险熔断/);
  engine.liveReasons(); engine.liveReasons();
  assert.equal(engine.riskStatus().ledgerCount, 1);
  engine.updateConfig({ risk: { dailyLossByQuote: { USDT: '100' } } });
  assert.equal(engine.riskStatus().latched, true);
  store.close();
  const reopened = new Store(dir);
  try {
    const fresh = new Engine(reopened, exchange, { docsVerified: { binance: true, okx: true } });
    assert.equal(fresh.riskStatus().latched, true);
    assert.equal(fresh.riskStatus().lossByQuote.USDT, '1');
    assert.equal(reopened.state.config.autoTrading, false);
  } finally { reopened.close(); }
});

test('订单等待发送期间新增已核对亏损触发最终熔断保护且不自动重发', async t => {
  const { engine, store, exchange } = readyEngine(t), state = store.state;
  state.config.risk.dailyLossByQuote.USDT = '1';
  let attempts = 0, sent = 0;
  exchange.order = async (_exchange, order) => {
    attempts++;
    state.batches.push({ id: 'reconciled-while-queued', pair: 'BTC/USDT', status: 'RESOLVED', legs: [], realizedNet: '-1',
      resolution: { at: Date.now(), reference: '队列保护回归测试核对记录', legs: [] } });
    try { order.guard(); } catch (error) { error.unknown = false; throw error; }
    sent++;
    return { orderId: '1', status: 'ACKNOWLEDGED' };
  };
  const batch = await engine.submit('BTC/USDT', 'binance');
  assert.equal(batch.status, 'REJECTED');
  assert.match(batch.error, /风险熔断/);
  assert.equal(engine.riskStatus().latched, true);
  assert.equal(state.config.autoTrading, false);
  assert.equal(attempts, 1);
  assert.equal(sent, 0);
  await assert.rejects(engine.submit('BTC/USDT', 'binance'), /风险熔断/);
  assert.equal(attempts, 1);
});

test('超范围或精度错误的人工收益不得提前解除批次安全阻塞', async t => {
  const { engine, store } = readyEngine(t), batch = await engine.submit('BTC/USDT', 'binance');
  engine.setLive(false);
  const data = { confirm: RESOLVE_CONFIRM, reference: '已核对交易所两腿订单、费用及剩余库存',
    legs: batch.legs.map(leg => ({ outcome: 'FILLED', executedQty: leg.qty, openQty: '0' })) };
  for (const realizedNet of ['10000000000000000000000000000000', '-0.0000000000000000000000000000001']) {
    assert.throws(() => engine.resolve(batch.id, { ...data, realizedNet }), /范围|精度/);
    assert.equal(batch.status, 'SUBMITTED');
    assert.equal(batch.realizedNet, null);
    assert.equal(batch.resolution, undefined);
    assert.ok(store.state.blocks['BTC/USDT']);
    assert.equal(engine.riskStatus().ledgerCount, 0);
  }
});

test('风险复位需要确认及安全空闲状态，日内仍超限不得复位', async t => {
  const { engine, store } = readyEngine(t), state = store.state;
  state.config.risk.dailyLossByQuote.USDT = '1';
  const batch = await engine.submit('BTC/USDT', 'binance');
  resolved(engine, batch, '-1');
  assert.throws(() => engine.resetRisk(''), /确认/);
  assert.throws(() => engine.resetRisk(RISK_RESET_CONFIRM), /亏损|限额|限|复位/);
  engine.busy = true;
  assert.throws(() => engine.resetRisk(RISK_RESET_CONFIRM), /执行/);
  engine.busy = false;
  engine.updateConfig({ risk: { dailyLossByQuote: { USDT: '2' } } });
  state.config.autoTrading = true;
  assert.throws(() => engine.resetRisk(RISK_RESET_CONFIRM), /停止|关闭/);
  state.config.autoTrading = false;
  state.batches.unshift({ id: 'pending', pair: 'BTC/USDT', status: 'UNKNOWN', legs: [] });
  assert.throws(() => engine.resetRisk(RISK_RESET_CONFIRM), /未.*批次|未.*订单|核对/);
  state.batches.shift();
  const result = engine.resetRisk(RISK_RESET_CONFIRM);
  assert.equal(result.latched, false);
  assert.equal(result.lossByQuote.USDT, '1');
  assert.equal(result.ledgerCount, 1);
  assert.equal(state.config.autoTrading, false);
});
