import test from 'node:test';
import assert from 'node:assert/strict';
import { CANDLE_MS, MAX_CONTEXT_AGE_MS, KLINE_LIMIT, marketWatchDefaults, validateMarketWatch,
  initializeMarketWatch, analyzeSpotKlines, marketWatchSignals, recordMarketWatch, marketWatchSnapshot } from '../src/market-watch.js';

const END = Date.parse('2026-11-19T00:00:00Z');
const config = extra => ({ ...marketWatchDefaults(), enabled: true, ...extra });
function candles(count, end = END) {
  return Array.from({ length: count }, (_, i) => {
    const open = end - (count - i) * CANDLE_MS;
    return [open, '10', '11', '9', '10', '10', open + CANDLE_MS - 1, '100', 10, '1', '10', '0'];
  });
}
function volumeSample(end = END) {
  const rows = candles(13, end); rows.at(-1)[7] = '600';
  return analyzeSpotKlines(rows, { now: end });
}
function state(extra = {}) {
  const value = { config: { marketWatch: config(extra), amount: '100' }, batches: [{ id: 'unknown', status: 'UNKNOWN' }],
    blocks: { 'BTC/USDT': 'unknown' }, riskState: { latches: { USDT: { loss: '2' } } } };
  initializeMarketWatch(value); return value;
}
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

test('观察设置默认关闭，阈值规范化并拒绝未知、危险或超界输入', () => {
  assert.deepEqual(validateMarketWatch(), marketWatchDefaults());
  assert.notEqual(marketWatchDefaults(), marketWatchDefaults());
  assert.deepEqual(validateMarketWatch({ enabled: true, volumeRatio: 3.5, priceMoveBps: '0500', cooldownMs: 60000 }), config({ volumeRatio: '3.5', cooldownMs: 60000 }));
  for (const input of [null, [], true, { enabled: 'true' }, { volumeRatio: '0' }, { volumeRatio: '-1' }, { volumeRatio: 'NaN' },
    { volumeRatio: '1000.1' }, { priceMoveBps: Infinity }, { priceMoveBps: '10001' }, { rejectionBps: '0' },
    { cooldownMs: '60000' }, { cooldownMs: 59999 }, { cooldownMs: 86400001 }, { unknown: true }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateMarketWatch(input));
  }
});

test('旧状态初始化只补观察字段，保留未知订单、熔断及历史观察', () => {
  const value = { config: { amount: '100' }, batches: [{ status: 'UNKNOWN' }], riskState: { latches: { USDT: { loss: '5' } } },
    marketWatch: { samples: { 'BTC/USDT': { status: 'STALE' } }, alerts: [{ id: 'history' }], cooldowns: { key: { until: END } } } };
  const previous = structuredClone(value);
  initializeMarketWatch(value);
  assert.deepEqual(value.config.marketWatch, marketWatchDefaults());
  assert.deepEqual(value.batches, previous.batches); assert.deepEqual(value.riskState, previous.riskState);
  assert.deepEqual(value.marketWatch, previous.marketWatch);
  assert.throws(() => initializeMarketWatch({ config: {}, marketWatch: [] }));
});

test('放量以之前十二根同周期报价成交额为基线，并排除未闭合柱', () => {
  const rows = candles(13); rows.at(-1)[7] = '600'; rows.at(-1)[4] = '11';
  const current = candles(1, END + CANDLE_MS)[0]; current[2] = '1000000'; current[7] = '1000000000'; rows.push(current);
  const result = analyzeSpotKlines(rows, { now: END + 60000 });
  assert.equal(result.barsUsed, 13); assert.equal(result.lastClosedAt, END - 1);
  assert.equal(result.volume5m, '600'); assert.equal(result.meanVolume5m, '100');
  assert.equal(result.volumeRatio5m, '6'); assert.equal(result.price1hBps, '1000');
  assert.equal(result.status, 'PARTIAL'); assert.ok(result.missing.includes('HISTORY_72H'));
  assert.deepEqual(marketWatchSignals(result, config(), END + 60000).map(x => x.code), ['VOLUME_EXPANSION', 'FAST_MOVE']);
});

test('零量基线保持未知，不产生无限放量；历史不足不补零', () => {
  const rows = candles(13);
  for (const row of rows.slice(0, 12)) { row[5] = '0'; row[7] = '0'; row[9] = '0'; row[10] = '0'; }
  const zero = analyzeSpotKlines(rows, { now: END });
  assert.equal(zero.meanVolume5m, '0'); assert.equal(zero.volumeRatio5m, null);
  assert.ok(zero.missing.includes('ZERO_VOLUME_BASELINE'));
  assert.equal(marketWatchSignals(zero, config(), END).length, 0);
  const short = analyzeSpotKlines(candles(1), { now: END });
  for (const key of ['meanVolume5m', 'volumeRatio5m', 'price1hBps', 'price24hBps', 'high72h', 'low72h', 'rejection15m']) assert.equal(short[key], null);
  assert.equal(short.volume5m, '100'); assert.equal(short.status, 'PARTIAL');
});

test('严格拒绝断档、重复、乱序、未来开始、畸形价格和伪成交数据，错误不回显输入', () => {
  const changes = [rows => rows.splice(4, 1), rows => { rows[4] = structuredClone(rows[3]); }, rows => rows.reverse(),
    rows => rows[1][0]++, rows => rows[1][6]++, rows => { rows[1][2] = '9'; }, rows => { rows[1][3] = '11'; },
    rows => { rows[1][4] = '<secret-marker>'; }, rows => { rows[1][5] = '-1'; }, rows => { rows[1][7] = 'NaN'; },
    rows => { rows[1][8] = '10'; }, rows => { rows[1][9] = '11'; }, rows => { rows[1][10] = '101'; }, rows => { rows[1].pop(); }];
  for (const change of changes) {
    const rows = candles(13); change(rows);
    assert.throws(() => analyzeSpotKlines(rows, { now: END }), error => {
      assert.equal(error.message, '现货量价 K 线数据无效或时间不连续'); assert.doesNotMatch(error.message, /secret-marker/); return true;
    });
  }
  assert.throws(() => analyzeSpotKlines(candles(1, END + 2 * CANDLE_MS), { now: END + 60000 }));
  assert.throws(() => analyzeSpotKlines(candles(KLINE_LIMIT + 1), { now: END }));
  assert.throws(() => analyzeSpotKlines([], { now: END }));
  assert.throws(() => analyzeSpotKlines(candles(1, END + CANDLE_MS), { now: END + 60000 }), /尚无已收盘/);
});

test('24小时涨跌与72小时高低覆盖按实际完整窗口计算', () => {
  const short = candles(289); short.at(-1)[2] = '13'; short.at(-1)[4] = '12';
  const first = analyzeSpotKlines(short, { now: END });
  assert.equal(first.price24hBps, '2000'); assert.equal(first.high72h, null);
  const full = candles(864); full[0][2] = '20'; full[0][3] = '5'; full.at(-1)[4] = '11';
  const result = analyzeSpotKlines(full, { now: END });
  assert.equal(result.high72h, '20'); assert.equal(result.low72h, '5');
  assert.equal(result.fromLow72hBps, '12000'); assert.equal(result.toHigh72hBps, '4500');
});

test('十五分钟冲高回落按UTC完整组三柱，基线不含事件且不看下一组', () => {
  const rows = candles(KLINE_LIMIT, END + CANDLE_MS);
  const start = rows.findIndex(row => row[0] === END - 3 * CANDLE_MS);
  rows[0][2] = '1000'; // Outside the exact prior 72-hour event window.
  for (const row of rows.slice(start, start + 3)) { row[2] = '25'; row[4] = '18'; }
  rows.at(-1)[2] = '1000'; rows.at(-1)[4] = '900'; // Next 15-minute group: never in the event.
  const result = analyzeSpotKlines(rows, { now: END + CANDLE_MS + 60000 });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.rejection15m, { at: END - 1, high: '25', close: '18', drawdownBps: '2800', new72hHigh: true });
  assert.ok(marketWatchSignals(result, config(), END + CANDLE_MS + 60000).some(x => x.code === 'HIGH_REJECTION' && x.at === END - 1));
  rows[start - 10][2] = '30';
  const olderHigh = analyzeSpotKlines(rows, { now: END + CANDLE_MS + 60000 });
  assert.equal(olderHigh.rejection15m.new72hHigh, false);
  assert.ok(!marketWatchSignals(olderHigh, config(), END + CANDLE_MS + 60000).some(x => x.code === 'HIGH_REJECTION'));
});

test('过期、未来及不可用观察不产生当前信号，跌幅同样可作快速波动提醒', () => {
  const summary = volumeSample(); summary.price1hBps = '-600';
  assert.ok(marketWatchSignals(summary, config(), END).some(x => x.code === 'FAST_MOVE' && x.value === '-600'));
  assert.ok(marketWatchSignals(summary, config(), END - 1 + MAX_CONTEXT_AGE_MS).length > 0);
  assert.deepEqual(marketWatchSignals(summary, config(), END + MAX_CONTEXT_AGE_MS), []);
  for (const value of [{ ...summary, status: 'UNAVAILABLE' }, { ...summary, status: 'STALE' }, { ...summary, lastClosedAt: END + 1 }]) {
    assert.deepEqual(marketWatchSignals(value, config(), END), []);
  }
  assert.deepEqual(marketWatchSignals(summary, config({ enabled: false }), END), []);
});

test('闭合及信号时效使用已验证的服务器偏差，本机慢十秒不会误判为未来', () => {
  const rows = candles(13); rows.at(-1)[7] = '600';
  const serverNow = END + 5000, localNow = serverNow - 10000;
  const sample = { ...analyzeSpotKlines(rows, { now: serverNow }), observedAt: localNow, clockOffsetMs: 10000 };
  assert.ok(marketWatchSignals(sample, config(), localNow).length > 0);
  assert.equal(marketWatchSignals({ ...sample, clockOffsetMs: 0 }, config(), localNow).length, 0);
  const value = state(); recordMarketWatch(value, 'BTC/USDT', sample, localNow);
  assert.equal(marketWatchSnapshot(value, localNow).samples['BTC/USDT'].status, 'PARTIAL');
  for (const offset of [NaN, Infinity, 30001, -30001, '10000']) {
    const bad = { ...sample, clockOffsetMs: offset };
    assert.equal(marketWatchSignals(bad, config(), localNow).length, 0);
    value.marketWatch.samples['BTC/USDT'] = bad;
    assert.equal(marketWatchSnapshot(value, localNow).samples['BTC/USDT'].status, 'UNAVAILABLE');
  }
});

test('同一闭合事件跨冷却到期及重启仍不重复提醒，新闭合事件才可更新', () => {
  const value = state({ cooldownMs: 60000 }), sample = volumeSample();
  recordMarketWatch(value, 'BTC/USDT', sample, END);
  assert.equal(value.marketWatch.alerts.length, 1);
  const restored = JSON.parse(JSON.stringify(value)); initializeMarketWatch(restored);
  recordMarketWatch(restored, 'BTC/USDT', sample, END + 120000);
  assert.equal(restored.marketWatch.alerts.length, 1, 'Same immutable candle is not repeated after cooldown expiry');
  recordMarketWatch(restored, 'BTC/USDT', volumeSample(END + CANDLE_MS), END + CANDLE_MS);
  assert.equal(restored.marketWatch.alerts.length, 2);
  assert.equal(restored.marketWatch.alerts[0].source, 'binance');
  assert.equal(restored.marketWatch.alerts[0].at, END + CANDLE_MS - 1);
  assert.deepEqual(restored.batches, value.batches); assert.deepEqual(restored.riskState, value.riskState);
});

test('冷却对不同闭合事件持续有效，失败或禁用记录不发提醒', () => {
  const value = state(), sample = volumeSample();
  recordMarketWatch(value, 'BTC/USDT', sample, END);
  recordMarketWatch(value, 'BTC/USDT', volumeSample(END + CANDLE_MS), END + CANDLE_MS);
  assert.equal(value.marketWatch.alerts.length, 1);
  recordMarketWatch(value, 'BTC/USDT', { status: 'UNAVAILABLE', observedAt: END + CANDLE_MS, error: '公共请求失败' }, END + CANDLE_MS);
  assert.equal(value.marketWatch.alerts.length, 1); assert.equal(value.marketWatch.samples['BTC/USDT'].signals.length, 0);
  value.config.marketWatch.enabled = false;
  recordMarketWatch(value, 'ETH/USDT', volumeSample(END + CANDLE_MS), END + CANDLE_MS);
  assert.equal(value.marketWatch.alerts.length, 1);
});

test('观察存储有容量上限，快照深冻结状态也可重复读取且不把旧信号当当前', () => {
  const value = state(), sample = volumeSample();
  value.marketWatch.samples = Object.fromEntries(Array.from({ length: 301 }, (_, i) => ['OLD' + i + '/USDT', { ...sample, observedAt: 1 }]));
  value.marketWatch.alerts = Array.from({ length: 201 }, (_, i) => ({ id: String(i) }));
  value.marketWatch.cooldowns = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => ['OLD' + i, { observedAt: 1, until: 2, candleAt: 1 }]));
  recordMarketWatch(value, 'BTC/USDT', sample, END);
  assert.equal(Object.keys(value.marketWatch.samples).length, 300);
  assert.equal(value.marketWatch.alerts.length, 200); assert.equal(Object.keys(value.marketWatch.cooldowns).length, 1000);
  freeze(value);
  const snapshot = marketWatchSnapshot(value, END + MAX_CONTEXT_AGE_MS);
  assert.equal(snapshot.samples['BTC/USDT'].status, 'STALE'); assert.equal(snapshot.samples['BTC/USDT'].signals.length, 0);
  assert.equal(value.marketWatch.samples['BTC/USDT'].status, 'PARTIAL');
  snapshot.alerts.length = 0; assert.equal(value.marketWatch.alerts.length, 200);
  const disabled = JSON.parse(JSON.stringify(value)); disabled.config.marketWatch.enabled = false;
  const hidden = marketWatchSnapshot(disabled, END);
  assert.equal(hidden.enabled, false); assert.equal(hidden.samples['BTC/USDT'].status, 'DISABLED'); assert.deepEqual(hidden.samples['BTC/USDT'].signals, []);
});
