import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults, Store } from '../src/store.js';
import { D } from '../src/math.js';
import { enhancementDefaults, validateEnhancements, initializeEnhancements, quotaConstraints, assertQuota,
  riskDay, syncRisk, riskStatus, resetRisk, RISK_RESET_CONFIRM } from '../src/policies.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
function stateAt(now = NOW) {
  const state = defaults();
  for (const exchange of ['binance', 'okx']) state.balances[exchange] = { valid: true, at: now,
    assets: { BTC: { free: '10', locked: '2', total: '12' }, USDT: { free: '1000', locked: '100', total: '1100' } } };
  initializeEnhancements(state, now);
  return state;
}
function configure(state, changes) { Object.assign(state.config, validateEnhancements({ ...state.config, ...changes })); }
const resolved = (id, net, at = NOW, symbol = 'BTC/USDT') => ({ id, pair: symbol, status: 'RESOLVED', legs: [], at: at - 86400000,
  realizedNet: net, resolution: { at, reference: '交易所账单核对', legs: [] } });
function tempDir(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-policy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('四项增强默认设置互相独立，旧配置迁移后保持原功能默认行为', () => {
  const a = enhancementDefaults(), b = enhancementDefaults(); a.capital.byExchange.binance.BTC = { reserve: '1' };
  assert.deepEqual(validateEnhancements({}), b);
  assert.equal(b.capital.enabled, false); assert.deepEqual(b.capital.byExchange.binance, {});
  const state = stateAt(); assert.deepEqual(quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW), { maxQty: null, maxBuyCost: null, details: { enabled: false } });
});

test('严格验证新设置，保留显式零与 null 的不同含义', () => {
  const config = validateEnhancements({ capital: { enabled: true, byExchange: { binance: { BTC: { maxOrder: 0, maxHolding: null } } } },
    filters: { maxBookSkewMs: 0, maxSpreadBps: '0' }, risk: { dailyLossByQuote: { USDT: '0' } } });
  assert.deepEqual(config.capital.byExchange.binance.BTC, { reserve: '0', maxOrder: '0', maxHolding: null });
  assert.equal(config.filters.maxBookSkewMs, 0); assert.equal(config.filters.maxSpreadBps, '0'); assert.equal(config.risk.dailyLossByQuote.USDT, '0');
  for (const invalid of [{ costs: null }, { costs: { mystery: true } }, { costs: { rebalanceByQuote: { usdt: '1' } } },
    { filters: { maxBookSkewMs: 60001 } }, { filters: { maxBookSkewMs: '10' } }, { filters: { maxSpreadBps: '-1' } },
    { capital: { enabled: 'false' } }, { capital: { byExchange: { unknown: {} } } }, { capital: { byExchange: { binance: { BTC: { maxOrder: 'NaN' } } } } },
    { capital: { byExchange: { binance: { BTC: { maxHolding: '-1' } } } } }, { risk: { dailyLossByQuote: { USDT: '-0.1' } } }]) assert.throws(() => validateEnhancements(invalid));
});

test('三种配置映射的 null 删除单项，规范化后不保留墓碑且不会跳过路径校验', () => {
  const normalized = validateEnhancements({ costs: { rebalanceByQuote: { USDT: null, USDC: '0.5' } },
    risk: { dailyLossByQuote: { USDT: null, USDC: '2' } },
    capital: { enabled: true, byExchange: { binance: { BTC: null, ETH: { maxOrder: null, maxHolding: null, reserve: '2' } }, okx: { BTC: { maxOrder: '0' } } } } });
  assert.deepEqual(normalized.costs.rebalanceByQuote, { USDC: '0.5' }); assert.deepEqual(normalized.risk.dailyLossByQuote, { USDC: '2' });
  assert.equal(Object.hasOwn(normalized.capital.byExchange.binance, 'BTC'), false);
  assert.deepEqual(normalized.capital.byExchange.binance.ETH, { reserve: '2', maxOrder: null, maxHolding: null });
  assert.equal(normalized.capital.byExchange.okx.BTC.maxOrder, '0');
  for (const invalid of [{ costs: { rebalanceByQuote: { usdt: null } } }, { risk: { dailyLossByQuote: { bad: null } } },
    { capital: { byExchange: { unknown: null } } }, { capital: { byExchange: { binance: { bad: null } } } }]) assert.throws(() => validateEnhancements(invalid));
});

test('配额包含买入计价资产预留、卖出基础资产手续费和已有冻结持仓', () => {
  const state = stateAt();
  configure(state, { capital: { enabled: true, byExchange: {
    binance: { USDT: { reserve: '200', maxOrder: '500' }, BTC: { maxHolding: '13.5' } },
    okx: { BTC: { reserve: '8', maxOrder: '1' } },
  } } });
  const limit = quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW);
  assert.equal(limit.maxBuyCost, '500'); assert.equal(limit.maxQty, D(1).div('1.001').toDecimalPlaces(30, 1).toString());
  assert.equal(limit.details.buyerBase.total, '12'); assert.equal(limit.details.buyerBase.maxQty, '1.5');
  assert.equal(limit.details.sellerBase.available, '2');
  assert.ok(D(limit.maxQty).mul('1.001').lte('1'));
});

test('启用配额后未单独配置资产仍受实际可用余额限制', () => {
  const state = stateAt(); configure(state, { capital: { enabled: true } });
  state.balances.okx.assets.BTC.free = '0.5'; state.balances.okx.assets.BTC.total = '2.5';
  const limit = quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW);
  assert.equal(limit.maxBuyCost, '1000'); assert.equal(limit.maxQty, D('0.5').div('1.001').toDecimalPlaces(30, 1).toString());
});

test('OKX 冻结余额重叠不重复计入库存，支出仍按可用余额并限制买入总库存', () => {
  const state = stateAt();
  state.balances.okx.assets.BTC = { free: '8', locked: '5', total: '10' };
  configure(state, { capital: { enabled: true, byExchange: { okx: { BTC: { maxHolding: '10.5' } } } } });
  const sellSide = quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW);
  assert.equal(sellSide.maxQty, D('8').div('1.001').toDecimalPlaces(30, 1).toString());
  const buySide = quotaConstraints(state, 'BTC/USDT', 'okx', 'binance', NOW);
  assert.equal(buySide.maxQty, '0.5');
  assert.equal(buySide.details.buyerBase.total, '10');
  state.balances.okx.assets.BTC.total = '7';
  assert.throws(() => quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW), /总余额小于/);
});

test('显式零支出上限、超出预留库存和已满持仓都禁止新增数量', () => {
  for (const [exchange, asset, limits, expected] of [
    ['binance', 'USDT', { maxOrder: '0' }, 'cost'], ['okx', 'BTC', { maxOrder: '0' }, 'qty'],
    ['okx', 'BTC', { reserve: '11' }, 'qty'], ['binance', 'BTC', { maxHolding: '12' }, 'qty'],
    ['binance', 'BTC', { maxHolding: '0' }, 'qty'],
  ]) {
    const state = stateAt(); configure(state, { capital: { enabled: true, byExchange: { [exchange]: { [asset]: limits } } } });
    const limit = quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW);
    assert.equal(expected === 'qty' ? limit.maxQty : limit.maxBuyCost, '0');
  }
});

test('配额按实际交易方向和币种计算，不跨所挪用余额', () => {
  const state = stateAt(); configure(state, { capital: { enabled: true, byExchange: { okx: { USDT: { maxOrder: '20' } }, binance: { BTC: { reserve: '9' } } } } });
  const forward = quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW), reverse = quotaConstraints(state, 'BTC/USDT', 'okx', 'binance', NOW);
  assert.equal(forward.maxBuyCost, '1000'); assert.equal(reverse.maxBuyCost, '20');
  assert.ok(D(forward.maxQty).gt(reverse.maxQty));
  assert.equal(quotaConstraints(state, 'ETH/USDT', 'binance', 'okx', NOW).maxQty, '0');
});

test('最终配额复核重新计算最坏支出，不接受低报费用的机会对象', () => {
  const state = stateAt(); configure(state, { capital: { enabled: true, byExchange: { binance: { USDT: { maxOrder: '100' } } } } });
  const opportunity = { pair: 'BTC/USDT', buyExchange: 'binance', sellExchange: 'okx', qty: '1', buyLimit: '100', buyWorstCost: '1' };
  assert.throws(() => assertQuota(state, opportunity, NOW), /买侧支出 100.1 \/ 上限 100/);
  opportunity.qty = '0.99'; assert.equal(assertQuota(state, opportunity, NOW).enabled, true);
  state.config.capital.byExchange.binance.BTC = { maxHolding: '12', reserve: '0', maxOrder: null };
  assert.throws(() => assertQuota(state, opportunity, NOW), /数量/);
});

test('资金配额拒绝过期、失败或自相矛盾的余额，保留冻结资产', () => {
  const state = stateAt(); configure(state, { capital: { enabled: true } });
  state.balances.binance.valid = false; assert.throws(() => quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW), /余额过期或更新失败/);
  state.balances.binance.valid = true; state.balances.binance.at = NOW - state.config.maxBalanceAgeMs - 1;
  assert.throws(() => quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW), /余额过期/);
  state.balances.binance.at = NOW; state.balances.binance.assets.BTC.total = '10';
  assert.throws(() => quotaConstraints(state, 'BTC/USDT', 'binance', 'okx', NOW), /总余额小于/);
});

test('仅人工已核对负收益计入亏损，正收益不抵扣且按计价币种隔离', () => {
  const state = stateAt(); configure(state, { risk: { dailyLossByQuote: { USDT: '3', USDC: '9' } } });
  state.config.autoTrading = true;
  state.batches = [resolved('loss1', '-2'), resolved('profit', '100'), resolved('loss2', '-1'), resolved('usdc', '-4', NOW, 'BTC/USDC'),
    { ...resolved('unknown', '-100'), status: 'UNKNOWN' }, { ...resolved('rejected', '-100'), status: 'REJECTED' }];
  const status = syncRisk(state, NOW);
  assert.deepEqual(status.lossByQuote, { USDT: '3', USDC: '4' }); assert.equal(status.ledgerCount, 4); assert.equal(status.latched, true);
  assert.equal(state.config.autoTrading, false); assert.deepEqual(Object.keys(status.latches), ['USDT']);
});

test('零亏损限额不会在无亏损或纯盈利时误触发，有亏损即熔断', () => {
  const state = stateAt(); configure(state, { risk: { dailyLossByQuote: { USDT: '0' } } });
  assert.equal(syncRisk(state, NOW).latched, false);
  state.batches.push(resolved('win', '100'), resolved('flat', '0')); assert.equal(syncRisk(state, NOW).latched, false);
  state.batches.push(resolved('tiny-loss', '-0.000000001')); assert.equal(syncRisk(state, NOW).latched, true);
});

test('风险账本以批次标识去重，并拒绝已入账批次被改写', () => {
  const state = stateAt(); state.batches = [resolved('same', '-2'), resolved('same', '-2')];
  assert.equal(syncRisk(state, NOW).lossByQuote.USDT, '2'); assert.equal(syncRisk(state, NOW).ledgerCount, 1);
  assert.equal(syncRisk(state, NOW).lossByQuote.USDT, '2');
  state.batches[0].realizedNet = '-1'; assert.throws(() => syncRisk(state, NOW), /账本不一致/);
});

test('使用上海时区和人工核对时间归属日期，而非提交时间', () => {
  const before = Date.parse('2026-11-05T15:59:59.999Z'), after = before + 1;
  assert.equal(riskDay(before), '2026-11-05'); assert.equal(riskDay(after), '2026-11-06');
  const state = stateAt(after); state.batches = [resolved('yesterday', '-3', before), resolved('today', '-2', after)];
  assert.equal(syncRisk(state, after).lossByQuote.USDT, '2');
  assert.equal(state.riskState.ledger.today.day, '2026-11-06');
});

test('跨日和提高或删除限额不会隐式解除已有熔断', () => {
  const state = stateAt(); configure(state, { risk: { dailyLossByQuote: { USDT: '1' } } }); state.batches = [resolved('loss', '-1')];
  assert.equal(syncRisk(state, NOW).latched, true);
  configure(state, { risk: { dailyLossByQuote: { USDT: '100' } } }); assert.equal(syncRisk(state, NOW).latched, true);
  configure(state, { risk: { dailyLossByQuote: {} } }); assert.equal(syncRisk(state, NOW + 86400000).latched, true);
});

test('风险限额墓碑仅删除目标限额，熔断及其他币种限额继续保留', () => {
  const state = stateAt(); configure(state, { risk: { dailyLossByQuote: { USDT: '1', USDC: '9' } } }); state.batches = [resolved('loss', '-1')];
  syncRisk(state, NOW);
  configure(state, { risk: { dailyLossByQuote: { ...state.config.risk.dailyLossByQuote, USDT: null } } });
  const status = syncRisk(state, NOW);
  assert.deepEqual(status.limits, { USDC: '9' }); assert.equal(status.latched, true); assert.equal(status.latches.USDT.limit, '1');
  assert.equal(resetRisk(state, RISK_RESET_CONFIRM, NOW).latched, false); assert.equal(state.riskState.ledger.loss.loss, '1');
});

test('复位需要明确确认、停止实盘及无未核对批次，不得绕过当日限额', () => {
  const state = stateAt(); configure(state, { risk: { dailyLossByQuote: { USDT: '1' } } }); state.batches = [resolved('loss', '-1')]; syncRisk(state, NOW);
  assert.throws(() => resetRisk(state, 'yes', NOW), /完整确认/);
  state.config.autoTrading = true; assert.throws(() => resetRisk(state, RISK_RESET_CONFIRM, NOW), /停止实盘/); state.config.autoTrading = false;
  state.batches.push({ id: 'unknown', status: 'UNKNOWN' }); assert.throws(() => resetRisk(state, RISK_RESET_CONFIRM, NOW), /核对所有批次/); state.batches.pop();
  assert.throws(() => resetRisk(state, RISK_RESET_CONFIRM, NOW), /当前仍达到限额/);
  assert.equal(riskStatus(state, NOW).latched, true);
  const status = resetRisk(state, RISK_RESET_CONFIRM, NOW + 86400000);
  assert.equal(status.latched, false); assert.equal(status.ledgerCount, 1); assert.equal(status.resetHistory.length, 1);
  assert.equal(state.config.autoTrading, false); assert.equal(syncRisk(state, NOW + 86400000).latched, false);
});

test('提高限额后仍需手动复位，保留原亏损账本和复位依据', () => {
  const state = stateAt(); configure(state, { risk: { dailyLossByQuote: { USDT: '1' } } }); state.batches = [resolved('loss', '-1')]; syncRisk(state, NOW);
  configure(state, { risk: { dailyLossByQuote: { USDT: '2' } } });
  assert.equal(resetRisk(state, RISK_RESET_CONFIRM, NOW).latched, false); assert.equal(state.riskState.ledger.loss.loss, '1');
  assert.equal(state.riskState.resetHistory[0].latches.USDT.limit, '1');
});

test('只读风险状态不会修改状态或自行发起交易', () => {
  const state = stateAt(), original = JSON.stringify(state);
  const summary = riskStatus(state, NOW); summary.limits.USDT = '0'; summary.latches.USDT = {};
  assert.equal(JSON.stringify(state), original);
});

test('旧版本状态迁移保留原设置、密钥、限流、冷却、安全阻塞并补齐四项默认', t => {
  const dir = tempDir(t), old = defaults();
  for (const key of ['costs', 'filters', 'capital', 'risk']) delete old.config[key];
  old.config.amount = '333'; old.config.autoTrading = true; old.keys = [{ id: 'encrypted-only', sealed: { ciphertext: 'ciphertext' } }];
  old.blocks = { 'ETH/USDT': '旧安全阻塞' }; old.cooldowns = { 'BTC/USDT': 987 }; old.rates = { binance: { backoffUntil: 123456 } };
  old.batches = [{ id: 'pending', pair: 'BTC/USDT', status: 'SUBMITTED', legs: [] }, resolved('old-loss', '-1', Date.now())];
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(old));
  const store = new Store(dir); t.after(() => store.close());
  assert.equal(store.state.config.amount, '333'); assert.equal(store.state.config.autoTrading, false);
  assert.deepEqual(store.state.keys, old.keys); assert.deepEqual(store.state.rates, old.rates); assert.deepEqual(store.state.cooldowns, old.cooldowns);
  assert.equal(store.state.blocks['ETH/USDT'], '旧安全阻塞'); assert.ok(store.state.blocks['BTC/USDT']);
  for (const [section, expected] of Object.entries(enhancementDefaults())) assert.deepEqual(store.state.config[section], expected);
  assert.equal(store.state.riskState.ledger['old-loss'].loss, '1');
});

test('未知订单、风险熔断、账本和复位历史经重启仍保留', t => {
  const dir = tempDir(t); let store = new Store(dir);
  configure(store.state, { risk: { dailyLossByQuote: { USDT: '1' } } });
  store.state.batches = [resolved('loss', '-1', Date.now()), { id: 'unknown', pair: 'BTC/USDT', status: 'SUBMITTING', legs: [{ status: 'SENDING' }] }];
  syncRisk(store.state); store.save(); store.close();
  store = new Store(dir); t.after(() => store.close());
  assert.equal(riskStatus(store.state).latched, true); assert.equal(riskStatus(store.state).ledgerCount, 1);
  assert.equal(store.state.batches[1].status, 'UNKNOWN'); assert.ok(store.state.blocks['BTC/USDT']);
  store.state.batches[1].status = 'REJECTED'; configure(store.state, { risk: { dailyLossByQuote: {} } }); resetRisk(store.state, RISK_RESET_CONFIRM); store.save(); store.close();
  store = new Store(dir); assert.equal(riskStatus(store.state).latched, false); assert.equal(riskStatus(store.state).resetHistory.length, 1);
});

test('损坏的已核对收益或风险账本拒绝迁移，不会静默抹去亏损', t => {
  for (const mutate of [state => { state.batches = [resolved('broken', 'NaN')]; },
    state => { state.batches = [{ ...resolved('missing-time', '-1'), resolution: {} }]; },
    state => { state.batches = [resolved('loss', '-1')]; syncRisk(state, NOW); state.riskState.ledger.loss.loss = '0'; },
    state => { state.riskState = null; }]) {
    const dir = tempDir(t), state = stateAt(); mutate(state); fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    assert.throws(() => new Store(dir)); assert.equal(fs.existsSync(path.join(dir, 'process.lock')), false);
  }
});
