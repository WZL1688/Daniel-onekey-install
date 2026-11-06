import test from 'node:test';
import assert from 'node:assert/strict';
import { D, evaluate } from '../src/math.js';

const settings = () => ({ amount: '100', fallbackAmounts: [], fees: { binance: '0.001', okx: '0.001' }, buffer: '0.05', minProfit: '0.2', minDepthProfit: '0.2', maxBookAgeMs: 5000 });
const rule = () => ({ enabled: true, step: '0.01', tick: '0.01', minQty: '0.01', minNotional: '5' });
function input() {
  return { buy: { pair: 'BTC/USDT', at: 1000000, bids: [['99', '100']], asks: [['100', '100']] },
    sell: { pair: 'BTC/USDT', at: 1000000, bids: [['102', '100']], asks: [['103', '100']] },
    buyRule: rule(), sellRule: rule(), buyExchange: 'binance', sellExchange: 'okx', settings: settings(), now: 1000000 };
}
test('新增默认成本及过滤配置与旧配置产生相同计算结果', () => {
  const old = input(), current = input();
  current.settings.costs = { rebalanceByQuote: {} };
  current.settings.filters = { minNetBps: '0', maxSpreadBps: null, minDepthNotional: '0', maxBookSkewMs: null };
  assert.deepEqual(evaluate(current), evaluate(old));
  assert.equal(evaluate(old).net, '1.748');
});
test('再平衡预估只扣一次，费用合计与净利润可核对', () => {
  const x = input(); x.settings.costs = { rebalanceByQuote: { USDT: '0.10' } };
  const result = evaluate(x);
  assert.equal(result.grossProfit, '2'); assert.equal(result.executionNet, '1.748');
  assert.equal(result.rebalanceCost, '0.1'); assert.equal(result.totalCosts, '0.352');
  assert.equal(result.net, '1.648'); assert.equal(result.conservative, '1.648');
  assert.equal(D(result.grossProfit).minus(result.totalCosts).toString(), result.net);
});
test('再平衡成本按报价币隔离，不将USDT预估计入USDC交易对', () => {
  const x = input(); x.buy.pair = x.sell.pair = 'BTC/USDC';
  x.settings.costs = { rebalanceByQuote: { USDT: '50' } };
  assert.equal(evaluate(x).rebalanceCost, '0'); assert.equal(evaluate(x).net, '1.748');
});
test('再平衡成本导致双利润门槛失败，不能沿用未扣估计的利润授权', () => {
  const x = input(); x.settings.costs = { rebalanceByQuote: { USDT: '1.60' } };
  const result = evaluate(x);
  assert.equal(result.eligible, false); assert.equal(result.executionNet, '1.748');
  assert.match(result.reasons.join('；'), /深度净利润.*门槛/);
  assert.match(result.reasons.join('；'), /限价保守净利润.*门槛/);
});
test('净收益率按买侧保守含费成本计算，阈值相等通过、超出拒绝', () => {
  const x = input(); x.settings.fees = { binance: '0', okx: '0' }; x.settings.buffer = '0';
  const baseline = evaluate(x);
  assert.equal(baseline.netBps, D(baseline.conservative).div(baseline.buyWorstCost).mul(10000).toString());
  x.settings.filters = { minNetBps: baseline.netBps };
  assert.equal(evaluate(x).eligible, true);
  x.settings.filters.minNetBps = D(baseline.netBps).plus('0.001').toString();
  assert.match(evaluate(x).reasons.join('；'), /净收益率.*门槛/);
});
test('所内价差过滤不限制跨所套利价差，阈值边界正确', () => {
  const x = input(); x.buy.asks = [['101', '100']];
  const baseline = evaluate(x);
  const limit = D(baseline.buySpreadBps).gt(baseline.sellSpreadBps) ? baseline.buySpreadBps : baseline.sellSpreadBps;
  x.settings.filters = { maxSpreadBps: limit };
  assert.equal(evaluate(x).eligible, true);
  x.settings.filters.maxSpreadBps = D(limit).minus('0.001').toString();
  assert.match(evaluate(x).reasons.join('；'), /所内买卖价差/);
});
test('两所盘口接收时差与原有过期保护分别生效', () => {
  const x = input(); x.sell.at -= 200;
  x.settings.filters = { maxBookSkewMs: 200 };
  assert.equal(evaluate(x).eligible, true); assert.equal(evaluate(x).bookSkewMs, 200);
  x.settings.filters.maxBookSkewMs = 199;
  assert.match(evaluate(x).reasons.join('；'), /本地接收时差/);
  x.settings.filters.maxBookSkewMs = null; x.sell.at -= 5000;
  assert.match(evaluate(x).reasons.join('；'), /盘口已过期/);
});
test('显式零时差仅允许相同接收时刻，空值不限制', () => {
  const x = input(); x.settings.filters = { maxBookSkewMs: 0 };
  assert.equal(evaluate(x).eligible, true);
  x.sell.at--; assert.equal(evaluate(x).eligible, false);
  x.settings.filters.maxBookSkewMs = null; assert.equal(evaluate(x).eligible, true);
});
test('限价外的巨大挂单不计入有效深度，深度阈值相等通过', () => {
  const x = input();
  x.buy.asks = [['100', '1'], ['200', '1000']];
  x.sell.bids = [['102', '1'], ['50', '1000']];
  x.settings.filters = { minDepthNotional: '100' };
  const good = evaluate(x);
  assert.equal(good.eligible, true); assert.equal(good.buyDepthNotional, '100'); assert.equal(good.sellDepthNotional, '102');
  x.settings.filters.minDepthNotional = '101';
  assert.match(evaluate(x).reasons.join('；'), /限价内有效深度/);
});
test('动态平衡保留最大亏损语义，不扣普通套利再平衡估计或套用正收益率门槛', () => {
  const x = input(); x.sell.bids = [['99', '100']]; x.sell.asks = [['100', '100']];
  x.settings.costs = { rebalanceByQuote: { USDT: '100' } }; x.settings.filters = { minNetBps: '9999' };
  x.mode = 'balance'; x.balanceConfig = { amount: '100', maxLoss: '2' };
  const result = evaluate(x);
  assert.equal(result.eligible, true); assert.equal(result.rebalanceCost, '0'); assert.equal(result.net, '-1.249');
  x.settings.filters.maxBookSkewMs = 0; x.sell.at--;
  assert.equal(evaluate(x).eligible, false);
});
test('资金上限包括手续费，按共同步长缩量后重新计算双边深度及收益', () => {
  const x = input(); x.limits = { maxQty: null, maxBuyCost: '50.05' };
  const result = evaluate(x);
  assert.equal(result.eligible, true); assert.equal(result.qty, '0.5'); assert.equal(result.buyWorstCost, '50.05');
  assert.equal(result.buyCost, '50'); assert.equal(result.buyFee, '0.05'); assert.equal(result.sellFee, '0.051');
  assert.equal(result.net, '0.849'); assert.notEqual(result.net, evaluate(input()).net);
  x.limits.maxBuyCost = '50.049'; assert.equal(evaluate(x).qty, '0.49');
});
test('资金缩量采用最差限价而非均价，多档价格跳跃时不会超配', () => {
  const x = input(); x.buy.asks = [['100', '0.5'], ['120', '0.5']];
  x.sell.bids = [['140', '100']]; x.sell.asks = [['141', '100']];
  x.limits = { maxBuyCost: '95' };
  const result = evaluate(x);
  assert.equal(result.eligible, true); assert.equal(result.qty, '0.79'); assert.equal(result.buyLimit, '120');
  assert.equal(result.buyCost, '84.8'); assert.equal(result.buyWorstCost, '94.8948');
  assert.ok(D('0.80').mul(120).mul('1.001').gt(95));
});
test('先应用资金配额，默认金额超过返回深度也能计算足够深度的小单', () => {
  const x = input(); x.buy.asks = [['100', '0.8']];
  assert.equal(evaluate(x).eligible, false);
  x.limits = { maxBuyCost: '50.05' };
  assert.equal(evaluate(x).eligible, true); assert.equal(evaluate(x).qty, '0.5');
});
test('数量配额与库存平衡原有数量上限取较小值', () => {
  const x = input(); x.mode = 'balance'; x.balanceConfig = { amount: '100', maxLoss: '0' };
  x.maxQty = '0.4'; x.limits = { maxQty: '0.5', maxBuyCost: '100.1' };
  assert.equal(evaluate(x).qty, '0.4');
});
test('零配额、非法配额及缩量后不足最小订单时明确拒绝', () => {
  for (const limits of [{ maxQty: '0' }, { maxBuyCost: '0' }, { maxQty: '-1' }, { maxBuyCost: 'NaN' }, { maxBuyCost: '4.004' }]) {
    const x = input(); x.limits = limits;
    const result = evaluate(x);
    assert.equal(result.eligible, false); assert.ok(result.reasons.length > 0);
  }
});
