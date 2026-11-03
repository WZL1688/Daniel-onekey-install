import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFailures, summarizeSoak } from '../scripts/soak-metrics.js';

function state() {
  return {
    config: { exchanges: ['binance', 'okx'], pairs: ['BTC/USDT', 'ETH/USDT'], autoTrading: false },
    engine: { polls: 10, slotMs: 3000, estimatedCycleMs: 6000, cycleMs: 6000, lastCycleAt: 90000 },
    batches: [{ id: 'historical' }], opportunities: { 'BTC/USDT': { at: 90000 }, 'ETH/USDT': { at: 91000 } },
    rates: Object.fromEntries(['binance', 'okx'].map(exchange => [exchange, {
      queue: [], reason: '', metrics: { public: 10, private: 0, orders: 0, failures: 3, limited: 2, delayed: 4, waitMs: 20, latencyMs: 100, httpStatuses: { NETWORK: 1, '429': 2 } },
    }])),
  };
}

function observation() {
  const before = state(), after = structuredClone(before);
  after.engine = { ...after.engine, polls: 32, cycleMs: 6100, lastCycleAt: 161000 };
  after.opportunities['BTC/USDT'].at = 160000;
  after.opportunities['ETH/USDT'].at = 163000;
  for (const rate of Object.values(after.rates)) {
    rate.metrics.public += 22; rate.metrics.latencyMs += 220;
  }
  return { fixture: true, start: 100000, end: 165000, before, after,
    samples: [{ httpMs: 10, cycleMs: 6000, lastCycleAt: 99000 }, { httpMs: 20, cycleMs: 6100, lastCycleAt: 161000 }], port: 8888 };
}

test('连续观测所有计数均使用窗口差，历史失败与历史订单不会算作本次活动', () => {
  const input = observation();
  input.after.rates.binance.metrics.failures++;
  input.after.rates.binance.metrics.httpStatuses.NETWORK++;
  const report = summarizeSoak(input);
  assert.equal(report.counters.binance.public, 22);
  assert.equal(report.counters.binance.failures, 1);
  assert.equal(report.counters.binance.limited, 0);
  assert.deepEqual(report.counters.binance.httpStatuses, { NETWORK: 1 });
  assert.equal(report.batchesCreated, 0);
  assert.equal(report.observedCycleMs, 6100);
  assert.equal(report.servicePort, 8888);
  assert.deepEqual(report.successfulSampledPairs, ['BTC/USDT', 'ETH/USDT']);
  assert.ok(fixtureFailures(report).some(message => message.includes('请求失败')));
});

test('观测前缓存的有效盘口或轮询周期不能用于通过本次夹具验收', () => {
  const input = observation();
  input.after.opportunities = structuredClone(input.before.opportunities);
  input.after.engine.lastCycleAt = input.before.engine.lastCycleAt;
  input.samples = [{ httpMs: 10, cycleMs: 6000, lastCycleAt: 99000 }];
  const report = summarizeSoak(input);
  assert.deepEqual(report.successfulSampledPairs, []);
  assert.equal(report.observedCycleMs, null);
  assert.ok(fixtureFailures(report).some(message => message.includes('本次观测')));
});

test('夹具按实际关注交易对验收而不是写死三个交易对', () => {
  const report = summarizeSoak(observation());
  assert.deepEqual(fixtureFailures(report), []);
  report.pollRounds = 1;
  assert.ok(fixtureFailures(report).some(message => message.includes('轮转')));
});

test('连续观测发现计数重置或变更关注目标会明确失败', () => {
  const reset = observation(); reset.after.rates.okx.metrics.public = 0;
  assert.throws(() => summarizeSoak(reset), /计数器重置/);
  const changed = observation(); changed.after.config.pairs.push('SOL/USDT');
  assert.throws(() => summarizeSoak(changed), /关注交易所或交易对发生变化/);
});

test('真实网络尝试与本地夹具报告保持明确区分且无新盘口不会被冒称为成功', () => {
  const input = observation(); input.fixture = false;
  input.after.opportunities = structuredClone(input.before.opportunities);
  input.after.opportunities['BTC/USDT'].error = '连接被拒绝';
  const report = summarizeSoak(input);
  assert.equal(report.type, 'CURRENT_ENVIRONMENT_REAL_NETWORK_ATTEMPTS');
  assert.deepEqual(report.successfulSampledPairs, []);
  assert.deepEqual(report.limitations, ['连接被拒绝']);
});
