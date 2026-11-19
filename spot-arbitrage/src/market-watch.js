import { D, decimal, pair as validatePair } from './math.js';

export const CANDLE_MS = 300000;
export const MAX_CONTEXT_AGE_MS = 360000;
export const KLINE_LIMIT = 872;
const HOUR_BARS = 12, DAY_BARS = 288, THREE_DAY_BARS = 864;
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const validNow = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
const dataError = () => Error('现货量价 K 线数据无效或时间不连续');

export const marketWatchDefaults = () => ({ enabled: false, volumeRatio: '3', priceMoveBps: '500', rejectionBps: '500', cooldownMs: 1800000 });

export function validateMarketWatch(value) {
  if (value === undefined) return marketWatchDefaults();
  const defaults = marketWatchDefaults();
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(defaults, key))) throw Error('量价观察设置包含无效字段');
  const config = { ...defaults, ...value };
  if (typeof config.enabled !== 'boolean' || !Number.isInteger(config.cooldownMs) || config.cooldownMs < 60000 || config.cooldownMs > 86400000) throw Error('量价观察开关或冷却时间无效');
  try {
    for (const key of ['volumeRatio', 'priceMoveBps', 'rejectionBps']) {
      const number = decimal(config[key]);
      if (number.gt(key === 'volumeRatio' ? 1000 : 10000)) throw Error();
      config[key] = number.toString();
    }
  } catch { throw Error('量价观察阈值必须为范围内的正有限数'); }
  return config;
}

export function initializeMarketWatch(state) {
  if (!plain(state) || !plain(state.config)) throw Error('量价观察存储格式无效');
  state.config.marketWatch = validateMarketWatch(state.config.marketWatch);
  if (state.marketWatch === undefined) state.marketWatch = { samples: {}, alerts: [], cooldowns: {} };
  const watch = state.marketWatch;
  if (!plain(watch)) throw Error('量价观察存储格式无效');
  watch.samples ??= {}; watch.alerts ??= []; watch.cooldowns ??= {};
  if (!plain(watch.samples) || !Array.isArray(watch.alerts) || !plain(watch.cooldowns)) throw Error('量价观察存储格式无效');
  return watch;
}

const highOf = rows => rows.reduce((high, row) => row.high.gt(high) ? row.high : high, rows[0].high);
const lowOf = rows => rows.reduce((low, row) => row.low.lt(low) ? row.low : low, rows[0].low);
const changeBps = (close, previous) => close.minus(previous).div(previous).mul(10000).toString();

export function analyzeSpotKlines(rows, { now = Date.now() } = {}) {
  if (!validNow(now) || !Array.isArray(rows) || rows.length < 1 || rows.length > KLINE_LIMIT) throw dataError();
  const parsed = [];
  try {
    for (const raw of rows) {
      if (!Array.isArray(raw) || raw.length !== 12) throw Error();
      const [openAt, open, high, low, close, volume, closeAt, quoteVolume, trades, takerVolume, takerQuote] = raw;
      if (!Number.isSafeInteger(openAt) || openAt < 0 || openAt % CANDLE_MS !== 0 || openAt > now ||
          !Number.isSafeInteger(closeAt) || !Number.isSafeInteger(openAt + CANDLE_MS) || closeAt !== openAt + CANDLE_MS - 1 ||
          (parsed.length && openAt !== parsed.at(-1).openAt + CANDLE_MS) || !Number.isSafeInteger(trades) || trades < 0) throw Error();
      const candle = { openAt, closeAt, open: decimal(open), high: decimal(high), low: decimal(low), close: decimal(close),
        volume: decimal(volume, '成交量', { zero: true }), quoteVolume: decimal(quoteVolume, '成交额', { zero: true }) };
      const takerBase = decimal(takerVolume, '主动买入成交量', { zero: true });
      const takerNotional = decimal(takerQuote, '主动买入成交额', { zero: true });
      if (candle.high.lt(candle.open) || candle.high.lt(candle.close) || candle.low.gt(candle.open) || candle.low.gt(candle.close) || candle.low.gt(candle.high) ||
          takerBase.gt(candle.volume) || takerNotional.gt(candle.quoteVolume)) throw Error();
      parsed.push(candle);
    }
  } catch { throw dataError(); }
  const closed = parsed.filter(candle => candle.closeAt <= now);
  if (!closed.length) throw Error('现货量价观察尚无已收盘 K 线');
  const last = closed.at(-1), missing = [];
  const summary = { status: 'READY', observedAt: now, lastClosedAt: last.closeAt, barsUsed: closed.length,
    volume5m: last.quoteVolume.toString(), meanVolume5m: null, volumeRatio5m: null, baselineBars: HOUR_BARS,
    price1hBps: null, price24hBps: null, high72h: null, low72h: null, fromLow72hBps: null, toHigh72hBps: null,
    rejection15m: null, missing };
  if (closed.length >= HOUR_BARS + 1) {
    const previous = closed.slice(-HOUR_BARS - 1, -1);
    const mean = previous.reduce((sum, candle) => sum.plus(candle.quoteVolume), D(0)).div(HOUR_BARS);
    summary.meanVolume5m = mean.toString();
    if (mean.gt(0)) summary.volumeRatio5m = last.quoteVolume.div(mean).toString();
    else missing.push('ZERO_VOLUME_BASELINE');
    summary.price1hBps = changeBps(last.close, closed.at(-HOUR_BARS - 1).close);
  } else missing.push('HISTORY_1H');
  if (closed.length >= DAY_BARS + 1) summary.price24hBps = changeBps(last.close, closed.at(-DAY_BARS - 1).close);
  else missing.push('HISTORY_24H');
  if (closed.length >= THREE_DAY_BARS) {
    const history = closed.slice(-THREE_DAY_BARS), high = highOf(history), low = lowOf(history);
    summary.high72h = high.toString(); summary.low72h = low.toString();
    summary.fromLow72hBps = changeBps(last.close, low);
    summary.toHigh72hBps = high.minus(last.close).div(high).mul(10000).toString();
  } else missing.push('HISTORY_72H');
  const end = Math.floor((last.closeAt + 1) / (3 * CANDLE_MS)) * (3 * CANDLE_MS);
  const eventIndex = closed.findIndex(candle => candle.openAt === end - 3 * CANDLE_MS);
  if (eventIndex >= THREE_DAY_BARS && closed[eventIndex + 2]?.closeAt === end - 1) {
    const event = closed.slice(eventIndex, eventIndex + 3), high = highOf(event), close = event.at(-1).close;
    summary.rejection15m = { at: end - 1, high: high.toString(), close: close.toString(),
      drawdownBps: high.minus(close).div(high).mul(10000).toString(),
      new72hHigh: high.gt(highOf(closed.slice(eventIndex - THREE_DAY_BARS, eventIndex))) };
  } else missing.push('REJECTION_HISTORY_72H');
  summary.status = now - last.closeAt > MAX_CONTEXT_AGE_MS ? 'STALE' : missing.length ? 'PARTIAL' : 'READY';
  return summary;
}

function effectiveNow(summary, now) {
  const offset = summary?.clockOffsetMs === undefined ? 0 : summary.clockOffsetMs;
  return validNow(now) && typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) <= 30000 ? now + offset : null;
}
function freshSummary(summary, now) {
  const clock = effectiveNow(summary, now);
  return clock !== null && Number.isSafeInteger(summary?.lastClosedAt) && summary.lastClosedAt > 0 &&
    clock >= summary.lastClosedAt && clock - summary.lastClosedAt <= MAX_CONTEXT_AGE_MS;
}
function metric(value) {
  try { if (!['string', 'number'].includes(typeof value)) return null; const number = D(value); return number.isFinite() ? number : null; }
  catch { return null; }
}

export function marketWatchSignals(summary, value, now = Date.now()) {
  const config = validateMarketWatch(value);
  if (!config.enabled || !['READY', 'PARTIAL'].includes(summary?.status) || !freshSummary(summary, now)) return [];
  const signals = [], volume = metric(summary.volumeRatio5m), move = metric(summary.price1hBps);
  if (volume?.gte(config.volumeRatio)) signals.push({ code: 'VOLUME_EXPANSION', at: summary.lastClosedAt, value: volume.toString() });
  if (move?.abs().gte(config.priceMoveBps)) signals.push({ code: 'FAST_MOVE', at: summary.lastClosedAt, value: move.toString() });
  const event = summary.rejection15m, drawdown = metric(event?.drawdownBps);
  if (event?.new72hHigh === true && Number.isSafeInteger(event.at) && event.at > 0 && event.at <= summary.lastClosedAt &&
      effectiveNow(summary, now) - event.at <= 3 * CANDLE_MS + MAX_CONTEXT_AGE_MS && drawdown?.gte(config.rejectionBps)) {
    signals.push({ code: 'HIGH_REJECTION', at: event.at, value: drawdown.toString() });
  }
  return signals;
}

export function recordMarketWatch(state, symbol, summary, now = Date.now()) {
  validatePair(symbol);
  if (!plain(summary) || !validNow(now)) throw Error('量价观察记录无效');
  const watch = initializeMarketWatch(state), config = state.config.marketWatch;
  const signals = marketWatchSignals(summary, config, now);
  const sample = { ...structuredClone(summary), observedAt: now, pair: symbol, exchange: 'binance', signals };
  watch.samples[symbol] = sample;
  for (const signal of signals) {
    const key = symbol + ':' + signal.code, previous = watch.cooldowns[key];
    if (previous && ((Number.isSafeInteger(previous.candleAt) && previous.candleAt >= signal.at) || (Number.isFinite(previous.until) && now < previous.until))) continue;
    const alert = { id: key + ':' + signal.at, pair: symbol, code: signal.code, at: signal.at, observedAt: now, value: signal.value, source: 'binance' };
    watch.alerts.unshift(alert);
    watch.cooldowns[key] = { until: now + config.cooldownMs, candleAt: signal.at, observedAt: now };
  }
  watch.samples = Object.fromEntries(Object.entries(watch.samples).sort(([, a], [, b]) => Number(b.observedAt || 0) - Number(a.observedAt || 0)).slice(0, 300));
  watch.alerts = watch.alerts.slice(0, 200);
  watch.cooldowns = Object.fromEntries(Object.entries(watch.cooldowns).sort(([, a], [, b]) => Number(b.observedAt || 0) - Number(a.observedAt || 0)).slice(0, 1000));
  return sample;
}

export function marketWatchSnapshot(state, now = Date.now()) {
  const config = validateMarketWatch(state.config?.marketWatch), watch = state.marketWatch || {};
  const samples = Object.fromEntries(Object.entries(watch.samples || {}).map(([symbol, original]) => {
    const sample = structuredClone(original);
    if (!config.enabled) sample.status = 'DISABLED';
    else if (effectiveNow(sample, now) === null) { sample.status = 'UNAVAILABLE'; sample.error = '量价观察时钟校准无效'; }
    else if (['READY', 'PARTIAL', 'STALE'].includes(sample.status) && !freshSummary(sample, now)) sample.status = 'STALE';
    sample.signals = marketWatchSignals(sample, config, now);
    return [symbol, sample];
  }));
  return { enabled: config.enabled, samples, alerts: structuredClone(watch.alerts || []) };
}
