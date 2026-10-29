import test from 'node:test';
import assert from 'node:assert/strict';
import { D, decimal, normalizeBook, walk, evaluate, commonStep, floorStep, ceilStep, pair, validateOrder } from '../src/math.js';
import { defaults } from '../src/store.js';
import { book, rule } from './helpers.js';
const input = () => ({ buy: book(), sell: book('BTC/USDT', '102', '103'), buyRule: rule(), sellRule: rule(), buyExchange: 'binance', sellExchange: 'okx', settings: defaults().config });
for (const value of ['NaN', 'Infinity', '-1', '', null, {}, '0']) test(`拒绝错误正数 ${JSON.stringify(value)}`, () => assert.throws(() => decimal(value)));
test('允许显式非负零值', () => assert.equal(decimal('0', 'x', { zero: true }).toString(), '0'));
for (const value of ['BTCUSDT', 'BTC/BTC', '../USDT', 'btc/USDT']) test(`拒绝交易对 ${value}`, () => assert.throws(() => pair(value)));
test('盘口正确排序并合并同价档', () => {
  const b = normalizeBook({ pair: 'BTC/USDT', at: Date.now(), bids: [['98', '2'], ['99', '3'], ['99.0', '4']], asks: [['102', '1'], ['101', '2']] }, 'BTC/USDT');
  assert.deepEqual(b.bids, [['99', '7'], ['98', '2']]); assert.deepEqual(b.asks[0], ['101', '2']); assert.equal(b.receivedBidLevels, 3); assert.equal(b.bidLevels, 2);
});
for (const patch of [{ bids: [] }, { asks: [] }, { pair: 'ETH/USDT' }, { bids: [['101', '1']] }, { bids: [['100', '1']] }, { bids: [['99', '0']] }, { asks: [['100', '-1']] }, { asks: [['NaN', '1']] }, { bids: [null] }, { at: Date.now() + 100000 }]) test('拒绝畸形、错误或交叉盘口 ' + JSON.stringify(patch), () => assert.throws(() => normalizeBook({ ...book(), ...patch }, 'BTC/USDT')));
test('深度计算穿透多个档位', () => { const r = walk([['100', '1'], ['102', '2']], '2'); assert.equal(r.total.toString(), '202'); assert.equal(r.avg.toString(), '101'); assert.equal(r.worst.toString(), '102'); });
test('深度不足会拒绝而非假设滑点', () => assert.throws(() => walk([['100', '1']], '2'), /深度不足/));
test('共同步长为两个步长最小公倍数', () => assert.equal(commonStep('0.02', '0.03').toString(), '0.06'));
test('数量向下、买限价向上、卖限价向下取整', () => { assert.equal(floorStep('1.234', '0.01').toString(), '1.23'); assert.equal(ceilStep('100.001', '0.01').toString(), '100.01'); });
test('取整数量后重算两侧手续费及利润', () => {
  const i = input(); i.settings.amount = '123.99'; const r = evaluate(i);
  assert.equal(r.qty, '1.23'); assert.equal(r.buyCost, '123'); assert.equal(r.sellProceeds, '125.46'); assert.equal(r.net, '2.16154'); assert.equal(r.buyFee, '0.123'); assert.equal(r.sellFee, '0.12546');
});
test('默认金额不足利润时依次尝试备用金额', () => {
  const i = input(); i.buy.asks = [['100', '0.5'], ['105', '10']]; i.settings.amount = '100'; i.settings.fallbackAmounts = ['20'];
  const r = evaluate(i); assert.equal(r.eligible, true); assert.equal(r.amount, '20'); assert.equal(r.attempts.length, 2);
});
test('默认金额深度不足时尝试备用金额', () => { const i = input(); i.buy.asks = [['100', '0.5']]; i.settings.amount = '100'; i.settings.fallbackAmounts = ['20']; assert.equal(evaluate(i).amount, '20'); });
test('深度利润通过但保守利润不通过时拒绝', () => {
  const i = input(); i.buy.asks = [['100', '0.9'], ['102', '1']]; i.sell.bids = [['103', '0.9'], ['102.1', '10']]; i.sell.asks = [['104', '10']]; i.settings.fallbackAmounts = [];
  const r = evaluate(i); assert.ok(D(r.net).gt('0.2')); assert.equal(r.eligible, false); assert.match(r.reasons.join(), /限价保守/);
});
test('盘口时效超限会拒绝', () => { const i = input(); i.buy.at -= 10000; assert.equal(evaluate(i).eligible, false); });
test('最小订单金额会阻塞', () => { const i = input(); i.buyRule.minNotional = '1000'; assert.equal(evaluate(i).eligible, false); });
test('两边数量严格满足共同步长', () => { const i = input(); i.buyRule.step = '0.02'; i.sellRule.step = '0.03'; const r = evaluate(i); assert.equal(r.qty, '0.96'); });
test('动态平衡亏损限额不改变普通套利门槛', () => {
  const i = input(); i.sell.bids = [['99.9', '100']]; i.sell.asks = [['101', '100']];
  const r = evaluate({ ...i, mode: 'balance', balanceConfig: { amount: '100', maxLoss: '1' } }); assert.equal(r.eligible, true);
  assert.equal(evaluate(i).eligible, false);
});
test('动态平衡数量不超过停止差额的一半', () => { const r = evaluate({ ...input(), mode: 'balance', maxQty: '0.125', balanceConfig: { amount: '100', maxLoss: '0' } }); assert.equal(r.qty, '0.12'); });
test('价格精度不符不能提交', () => assert.throws(() => validateOrder(rule(), '1', '100.001'), /精度/));
test('十进制不会出现二进制浮点残差', () => assert.equal(D('0.1').plus('0.2').toString(), '0.3'));
