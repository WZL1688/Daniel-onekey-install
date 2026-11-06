import { D, decimal, pair } from './math.js';

export const RISK_RESET_CONFIRM = '确认复位风险熔断';
const EXCHANGES = ['binance', 'okx'];
const ASSET = /^[A-Z0-9]{2,15}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error(`${label}格式错误`);
  return value;
};
function fields(value, allowed, label) {
  record(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error(`${label}包含未允许的字段`);
  return value;
}
const nonnegative = (value, label) => decimal(value, label, { zero: true }).toString();
const nullable = (value, label) => value === null ? null : nonnegative(value, label);
function assetMap(value, label, validate) {
  record(value, label);
  if (Object.keys(value).length > 200) throw Error(`${label}最多配置 200 种资产`);
  return Object.fromEntries(Object.entries(value).flatMap(([asset, cfg]) => {
    if (!ASSET.test(asset)) throw Error(`${label}资产名称必须为 2–15 位大写字母或数字`);
    // Null map entries explicitly remove one setting after the engine merges a patch.
    // Validate the path before dropping it; a tombstone cannot hide an invalid key.
    return cfg === null ? [] : [[asset, validate(cfg, `${label} ${asset}`)]];
  }));
}

export const enhancementDefaults = () => ({
  costs: { rebalanceByQuote: {} },
  filters: { minNetBps: '0', maxSpreadBps: null, minDepthNotional: '0', maxBookSkewMs: null },
  capital: { enabled: false, byExchange: { binance: {}, okx: {} } },
  risk: { dailyLossByQuote: {} },
});

// Missing sections migrate older configurations; explicit malformed values never disable a guard.
export function validateEnhancements(config) {
  const fallback = enhancementDefaults();
  const costs = fields(config.costs === undefined ? fallback.costs : config.costs, ['rebalanceByQuote'], '成本设置');
  const filters = fields(config.filters === undefined ? fallback.filters : config.filters, ['minNetBps', 'maxSpreadBps', 'minDepthNotional', 'maxBookSkewMs'], '流动性筛选');
  const capital = fields(config.capital === undefined ? fallback.capital : config.capital, ['enabled', 'byExchange'], '资金配额');
  const risk = fields(config.risk === undefined ? fallback.risk : config.risk, ['dailyLossByQuote'], '风险设置');
  if (capital.enabled !== undefined && typeof capital.enabled !== 'boolean') throw Error('资金配额开关格式错误');
  const byExchange = fields(capital.byExchange === undefined ? fallback.capital.byExchange : capital.byExchange, EXCHANGES, '交易所资金配额');
  const skew = filters.maxBookSkewMs === undefined ? null : filters.maxBookSkewMs;
  if (skew !== null && (!Number.isInteger(skew) || skew < 0 || skew > 60000)) throw Error('盘口接收时差应为 0–60000 毫秒或 null');
  return {
    costs: { rebalanceByQuote: assetMap(costs.rebalanceByQuote === undefined ? {} : costs.rebalanceByQuote, '再平衡成本', nonnegative) },
    filters: {
      minNetBps: nonnegative(filters.minNetBps === undefined ? '0' : filters.minNetBps, '最低净收益率'),
      maxSpreadBps: nullable(filters.maxSpreadBps === undefined ? null : filters.maxSpreadBps, '最大所内价差'),
      minDepthNotional: nonnegative(filters.minDepthNotional === undefined ? '0' : filters.minDepthNotional, '最小有效深度金额'),
      maxBookSkewMs: skew,
    },
    capital: { enabled: capital.enabled ?? false, byExchange: Object.fromEntries(EXCHANGES.map(ex => [ex,
      assetMap(byExchange[ex] === undefined ? {} : byExchange[ex], `${ex} 资金配额`, (cfg, label) => {
        fields(cfg, ['reserve', 'maxOrder', 'maxHolding'], label);
        return { reserve: nonnegative(cfg.reserve === undefined ? '0' : cfg.reserve, `${label} 预留库存`),
          maxOrder: nullable(cfg.maxOrder === undefined ? null : cfg.maxOrder, `${label} 单笔支出上限`),
          maxHolding: nullable(cfg.maxHolding === undefined ? null : cfg.maxHolding, `${label} 持仓上限`) };
      })])) },
    risk: { dailyLossByQuote: assetMap(risk.dailyLossByQuote === undefined ? {} : risk.dailyLossByQuote, '每日已核对累计亏损限额', nonnegative) },
  };
}

function minimum(...values) { return values.filter(value => value !== null).reduce((a, b) => a === null || D(b).lt(a) ? D(b) : a, null); }
const positiveRemainder = (a, b) => D(a).minus(b).gt(0) ? D(a).minus(b) : D(0);
const limitString = value => value === null ? null : value.toDecimalPlaces(30, 1).toString();
function balanceAsset(state, exchange, asset, now) {
  const balance = state.balances?.[exchange];
  if (!balance?.valid || !Number.isFinite(balance.at) || now - balance.at > state.config.maxBalanceAgeMs || balance.at > now + 1000) throw Error(`${exchange} 余额过期或更新失败，资金配额无法复核`);
  const data = balance.assets?.[asset] || { free: '0', locked: '0', total: '0' };
  const free = decimal(data.free, `${exchange} ${asset} 可用余额`, { zero: true });
  const locked = decimal(data.locked ?? '0', `${exchange} ${asset} 冻结余额`, { zero: true });
  const total = decimal(data.total ?? free.plus(locked), `${exchange} ${asset} 总余额`, { zero: true });
  // Binance free/locked partition the inventory. OKX frozenBal can overlap
  // strategy/position balances; cashBal is the inventory, not free + frozen.
  if (total.lt(free) || (exchange === 'binance' && total.lt(free.plus(locked)))) throw Error(`${exchange} ${asset} 总余额小于可用及冻结余额，资金配额无法复核`);
  return { free, total };
}

export function quotaConstraints(state, id, buyExchange, sellExchange, now = Date.now()) {
  if (!state.config.capital?.enabled) return { maxQty: null, maxBuyCost: null, details: { enabled: false } };
  const { base, quote } = pair(id);
  if (!EXCHANGES.includes(buyExchange) || !EXCHANGES.includes(sellExchange) || buyExchange === sellExchange) throw Error('资金配额交易所方向无效');
  const cfg = (exchange, asset) => ({ reserve: '0', maxOrder: null, maxHolding: null, ...state.config.capital.byExchange?.[exchange]?.[asset] });
  const buyerQuote = balanceAsset(state, buyExchange, quote, now), sellerBase = balanceAsset(state, sellExchange, base, now), buyerBase = balanceAsset(state, buyExchange, base, now);
  const bq = cfg(buyExchange, quote), sb = cfg(sellExchange, base), bb = cfg(buyExchange, base);
  const quoteAvailable = positiveRemainder(buyerQuote.free, bq.reserve), baseAvailable = positiveRemainder(sellerBase.free, sb.reserve);
  const maxBuyCost = minimum(quoteAvailable, bq.maxOrder);
  const outgoingBase = minimum(baseAvailable, sb.maxOrder), sellFee = decimal(state.config.fees[sellExchange], '卖侧费率', { zero: true });
  const sellerMax = outgoingBase.div(D(1).plus(sellFee));
  const holdingMax = bb.maxHolding === null ? null : positiveRemainder(bb.maxHolding, buyerBase.total);
  const maxQty = minimum(sellerMax, holdingMax);
  const details = { enabled: true, pair: id, buyExchange, sellExchange, base, quote,
    buyerQuote: { ...bq, free: buyerQuote.free.toString(), total: buyerQuote.total.toString(), available: quoteAvailable.toString(), maxBuyCost: limitString(maxBuyCost) },
    sellerBase: { ...sb, free: sellerBase.free.toString(), total: sellerBase.total.toString(), available: baseAvailable.toString(), feeRate: sellFee.toString(), maxQty: limitString(sellerMax) },
    buyerBase: { ...bb, total: buyerBase.total.toString(), maxQty: limitString(holdingMax) } };
  return { maxQty: limitString(maxQty), maxBuyCost: limitString(maxBuyCost), details };
}

export function assertQuota(state, opportunity, now = Date.now()) {
  const constraints = quotaConstraints(state, opportunity.pair, opportunity.buyExchange, opportunity.sellExchange, now);
  if (!constraints.details.enabled) return constraints.details;
  const qty = decimal(opportunity.qty, '最终数量');
  const cost = qty.mul(decimal(opportunity.buyLimit, '买入限价')).mul(D(1).plus(decimal(state.config.fees[opportunity.buyExchange], '买侧费率', { zero: true })));
  if (qty.gt(constraints.maxQty)) throw Error(`资金配额数量 ${qty} / 上限 ${constraints.maxQty}（含卖侧手续费及买侧持仓上限）`);
  if (cost.gt(constraints.maxBuyCost)) throw Error(`资金配额买侧支出 ${cost} / 上限 ${constraints.maxBuyCost}（含手续费及预留库存）`);
  return constraints.details;
}

export const riskDay = now => {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - 28800000) throw Error('风险核对时间格式错误');
  return new Date(now + 28800000).toISOString().slice(0, 10);
};
const freshRisk = () => ({ version: 1, ledger: {}, latches: {}, resetHistory: [] });
function signedNet(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length > 80 || !/^-?\d+(\.\d+)?$/.test(String(value))) throw Error('已核对实际净收益格式错误');
  const net = D(value);
  decimal(net.abs(), '已核对实际净收益', { zero: true });
  return net;
}
function ledgerEntry(batch) {
  if (typeof batch.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(batch.id) || ['__proto__', 'constructor', 'prototype'].includes(batch.id)) throw Error('已核对批次标识错误，拒绝忽略风险记录');
  const { quote } = pair(batch.pair), at = batch.resolution?.at;
  const day = riskDay(at), net = signedNet(batch.realizedNet);
  return { id: batch.id, quote, at, day, realizedNet: net.toString(), loss: net.lt(0) ? net.abs().toString() : '0' };
}
function validateRiskState(value) {
  fields(value, ['version', 'ledger', 'latches', 'resetHistory'], '风险持久化状态');
  if (value.version !== 1 || !Array.isArray(value.resetHistory)) throw Error('风险持久化版本或复位历史错误');
  record(value.ledger, '风险亏损账本'); record(value.latches, '风险熔断状态');
  for (const [id, entry] of Object.entries(value.ledger)) {
    fields(entry, ['id', 'quote', 'at', 'day', 'realizedNet', 'loss'], '风险亏损记录');
    if (!ASSET.test(entry.quote)) throw Error('风险亏损币种错误');
    const base = entry.quote === 'AA' ? 'BB' : 'AA';
    const rebuilt = ledgerEntry({ id: entry.id, pair: `${base}/${entry.quote}`, realizedNet: entry.realizedNet, resolution: { at: entry.at } });
    if (id !== entry.id || entry.day !== rebuilt.day || entry.loss !== rebuilt.loss) throw Error('风险亏损账本不一致，拒绝启动');
  }
  for (const [quote, latch] of Object.entries(value.latches)) {
    if (!ASSET.test(quote)) throw Error('风险熔断币种格式错误');
    record(latch, '风险熔断记录');
    if (latch.day !== riskDay(latch.at)) throw Error('风险熔断时间错误');
    if (!decimal(latch.loss, '风险熔断累计亏损').gt(0)) throw Error('风险熔断累计亏损错误');
    decimal(latch.limit, '风险熔断限额', { zero: true });
  }
}
function currentLoss(state, day) {
  const sums = {};
  for (const entry of Object.values(state.riskState?.ledger || {})) if (entry.day === day) sums[entry.quote] = (sums[entry.quote] || D(0)).plus(entry.loss);
  return Object.fromEntries(Object.entries(sums).map(([quote, value]) => [quote, value.toString()]));
}
function atLimit(loss, limit) { return D(loss).gt(0) && D(loss).gte(limit); }

export function riskStatus(state, now = Date.now()) {
  const day = riskDay(now), limits = state.config.risk?.dailyLossByQuote || {};
  const lossByQuote = { ...Object.fromEntries(Object.keys(limits).map(quote => [quote, '0'])), ...currentLoss(state, day) };
  return { latched: Object.keys(state.riskState?.latches || {}).length > 0, day, timeZone: 'Asia/Shanghai', lossByQuote,
    limits: structuredClone(limits), latches: structuredClone(state.riskState?.latches || {}), ledgerCount: Object.keys(state.riskState?.ledger || {}).length,
    resetHistory: structuredClone(state.riskState?.resetHistory || []) };
}

export function syncRisk(state, now = Date.now()) {
  if (state.riskState === undefined) state.riskState = freshRisk();
  for (const batch of state.batches) if (batch.status === 'RESOLVED') {
    const entry = ledgerEntry(batch), previous = own(state.riskState.ledger, batch.id) ? state.riskState.ledger[batch.id] : undefined;
    if (previous && Object.keys(entry).some(key => previous[key] !== entry[key])) throw Error('已核对批次与风险账本不一致，拒绝忽略或重复计入');
    if (!previous) state.riskState.ledger[batch.id] = entry;
  }
  const status = riskStatus(state, now);
  for (const [quote, limit] of Object.entries(status.limits)) {
    const loss = status.lossByQuote[quote] || '0';
    if (!own(state.riskState.latches, quote) && atLimit(loss, limit)) state.riskState.latches[quote] = { day: status.day, loss, limit, at: now };
  }
  if (Object.keys(state.riskState.latches).length) state.config.autoTrading = false;
  return riskStatus(state, now);
}

export function resetRisk(state, confirm, now = Date.now()) {
  if (confirm !== RISK_RESET_CONFIRM) throw Error('风险熔断复位必须输入完整确认文字');
  if (state.config.autoTrading || state.batches.some(batch => !['RESOLVED', 'REJECTED'].includes(batch.status))) throw Error('风险熔断复位前必须停止实盘并核对所有批次');
  const status = syncRisk(state, now);
  for (const [quote, limit] of Object.entries(status.limits)) if (atLimit(status.lossByQuote[quote] || '0', limit)) throw Error(`${quote} 当日累计已核对亏损 ${status.lossByQuote[quote]} / 限额 ${limit}，当前仍达到限额，不能复位`);
  if (status.latched) {
    state.riskState.resetHistory.push({ at: now, day: status.day, latches: structuredClone(state.riskState.latches) });
    state.riskState.latches = {};
  }
  return riskStatus(state, now);
}

export function initializeEnhancements(state, now = Date.now()) {
  Object.assign(state.config, validateEnhancements(state.config));
  if (state.riskState === undefined) state.riskState = freshRisk();
  validateRiskState(state.riskState);
  syncRisk(state, now);
  return state;
}
