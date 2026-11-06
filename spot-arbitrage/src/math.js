import Decimal from 'decimal.js';
Decimal.set({ precision: 48, rounding: Decimal.ROUND_DOWN, toExpNeg: -60, toExpPos: 60 });
export const D = x => new Decimal(x);
export function decimal(x, name = '数值', { zero = false } = {}) {
  if ((typeof x !== 'string' && typeof x !== 'number' && !Decimal.isDecimal(x)) || String(x).length > 80) throw Error(`${name}格式错误`);
  let d;
  try { d = D(x); } catch { throw Error(`${name}格式错误`); }
  if (!d.isFinite() || d.lt(0) || (!zero && d.isZero())) throw Error(`${name}必须为${zero ? '非负' : '正'}有限数`);
  if (d.gt('1e30') || d.decimalPlaces() > 30) throw Error(`${name}超出支持的数值或精度范围`);
  return d;
}
export const floorStep = (x, step) => D(x).div(decimal(step)).floor().mul(step);
export const ceilStep = (x, step) => D(x).div(decimal(step)).ceil().mul(step);
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
export function commonStep(a, b) {
  const places = Math.max(D(a).decimalPlaces(), D(b).decimalPlaces());
  const scale = D(10).pow(places);
  const x = BigInt(D(a).mul(scale).toFixed(0)), y = BigInt(D(b).mul(scale).toFixed(0));
  if (x <= 0n || y <= 0n) throw Error('数量步长无效');
  return D((x / gcd(x, y) * y).toString()).div(scale);
}
export function pair(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/.test(value)) throw Error('交易对格式应为 BTC/USDT');
  const [base, quote] = value.split('/');
  if (base === quote) throw Error('交易对两种资产不能相同');
  return { base, quote };
}
export function normalizeBook(raw, expectedPair, now = Date.now()) {
  pair(expectedPair);
  if (!raw || raw.pair !== expectedPair) throw Error('盘口交易对不匹配');
  if (!Number.isFinite(raw.at) || raw.at > now + 1000 || raw.at < 0) throw Error('盘口采样时间错误');
  const normalize = (levels, desc) => {
    if (!Array.isArray(levels) || levels.length === 0 || levels.length > 5000) throw Error('盘口为空或档位数错误');
    const sums = new Map();
    for (const item of levels) {
      if (!Array.isArray(item) || item.length < 2) throw Error('畸形盘口档位');
      const price = decimal(item[0], '盘口价格'), qty = decimal(item[1], '盘口数量');
      sums.set(price.toString(), (sums.get(price.toString()) || D(0)).plus(qty));
    }
    return [...sums].map(([p, q]) => [p, q.toString()]).sort((a, b) => D(a[0]).cmp(b[0]) * (desc ? -1 : 1));
  };
  const bids = normalize(raw.bids, true), asks = normalize(raw.asks, false);
  if (D(bids[0][0]).gte(asks[0][0])) throw Error('交叉或锁定盘口');
  return { pair: expectedPair, bids, asks, at: raw.at, exchangeAt: raw.exchangeAt || null,
    bidLevels: bids.length, askLevels: asks.length, receivedBidLevels: raw.bids.length,
    receivedAskLevels: raw.asks.length, depthLimit: raw.depthLimit || 100 };
}
export function walk(levels, qty) {
  let remaining = decimal(qty), total = D(0), worst = null;
  for (const [p, q] of levels) {
    const take = Decimal.min(q, remaining);
    total = total.plus(take.mul(p)); remaining = remaining.minus(take); worst = D(p);
    if (remaining.isZero()) break;
  }
  if (remaining.gt(0)) throw Error(`盘口深度不足，缺少数量 ${remaining}`);
  return { total, avg: total.div(qty), worst };
}
function quantityForAmount(asks, amount, allowPartial = false) {
  let money = D(amount), qty = D(0);
  for (const [p, q] of asks) {
    const take = Decimal.min(q, money.div(p));
    qty = qty.plus(take); money = money.minus(take.mul(p));
    if (money.lte('0.000000000000000001')) break;
  }
  if (!allowPartial && money.gt('0.00000001')) throw Error('默认或备用金额超过买侧盘口深度');
  return qty;
}
function spreadBps(book) {
  const bid = D(book.bids[0][0]), ask = D(book.asks[0][0]);
  return ask.minus(bid).div(ask.plus(bid).div(2)).mul(10000);
}
function executableNotional(levels, limit, buying) {
  return levels.reduce((sum, [price, quantity]) =>
    (buying ? D(price).lte(limit) : D(price).gte(limit)) ? sum.plus(D(price).mul(quantity)) : sum, D(0));
}
function affordableQuantity(asks, upper, step, tick, rate, maxCost) {
  const cap = decimal(maxCost, '买侧资金配额', { zero: true });
  const cost = qty => qty.mul(ceilStep(walk(asks, qty).worst, tick)).mul(D(1).plus(rate));
  if (upper.lte(0) || cost(upper).lte(cap)) return upper;
  let low = 0n, high = BigInt(upper.div(step).floor().toFixed(0));
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const quantity = D(middle.toString()).mul(step);
    if (cost(quantity).lte(cap)) low = middle;
    else high = middle - 1n;
  }
  return D(low.toString()).mul(step);
}
export function validateOrder(rule, qty, price) {
  if (!rule || !rule.enabled || !rule.step || !rule.tick) throw Error('精度规则缺失或交易对不可交易');
  if (!floorStep(qty, rule.step).eq(qty) || !floorStep(price, rule.tick).eq(price)) throw Error('订单精度不满足规则');
  const q = D(qty), p = D(price), n = q.mul(p);
  for (const [value, min, max, label] of [[q, rule.minQty, rule.maxQty, '数量'], [p, rule.minPrice, rule.maxPrice, '价格'], [n, rule.minNotional, rule.maxNotional, '金额']]) {
    if (min && value.lt(min)) throw Error(`${label} ${value} / 最小值 ${min}`);
    if (max && D(max).gt(0) && value.gt(max)) throw Error(`${label} ${value} / 最大值 ${max}`);
  }
}
export function evaluate({ buy, sell, buyRule, sellRule, buyExchange, sellExchange, settings, mode = 'arbitrage', balanceConfig, maxQty, limits, now = Date.now() }) {
  const attempts = [];
  const amounts = mode === 'balance' ? [balanceConfig.amount] : [settings.amount, ...settings.fallbackAmounts];
  for (const amount of amounts) {
    try {
      if (now - buy.at > settings.maxBookAgeMs || now - sell.at > settings.maxBookAgeMs) throw Error('盘口已过期，需要交易前重新采样');
      const b = normalizeBook(buy, buy.pair, now), s = normalizeBook(sell, buy.pair, now);
      const filters = settings.filters || {}, bookSkewMs = Math.abs(b.at - s.at);
      if (filters.maxBookSkewMs != null && (!Number.isInteger(filters.maxBookSkewMs) || filters.maxBookSkewMs < 0)) throw Error('盘口接收时差上限格式错误');
      if (filters.maxBookSkewMs != null && bookSkewMs > filters.maxBookSkewMs) throw Error(`两所盘口本地接收时差 ${bookSkewMs} ms / 上限 ${filters.maxBookSkewMs} ms`);
      const buySpread = spreadBps(b), sellSpread = spreadBps(s);
      if (filters.maxSpreadBps != null) {
        const maximum = decimal(filters.maxSpreadBps, '所内价差上限', { zero: true });
        if (buySpread.gt(maximum) || sellSpread.gt(maximum)) throw Error(`所内买卖价差 买侧 ${buySpread} / 卖侧 ${sellSpread} bps / 上限 ${maximum} bps`);
      }
      const step = commonStep(buyRule.step, sellRule.step);
      const br = decimal(settings.fees[buyExchange], '买侧费率', { zero: true });
      const sr = decimal(settings.fees[sellExchange], '卖侧费率', { zero: true });
      const capped = limits?.maxQty != null || limits?.maxBuyCost != null;
      let q = quantityForAmount(b.asks, decimal(amount), capped);
      if (maxQty != null) q = Decimal.min(q, maxQty);
      if (limits?.maxQty != null) q = Decimal.min(q, decimal(limits.maxQty, '数量配额', { zero: true }));
      q = floorStep(q, step);
      if (limits?.maxBuyCost != null) q = affordableQuantity(b.asks, q, step, buyRule.tick, br, limits.maxBuyCost);
      if (capped && q.lte(0)) throw Error('资金配额或可用余额不足，步长取整后数量为零');
      if (q.lte(0)) throw Error('步长取整后数量为零');
      const bd = walk(b.asks, q), sd = walk(s.bids, q);
      const buyLimit = ceilStep(bd.worst, buyRule.tick), sellLimit = floorStep(sd.worst, sellRule.tick);
      validateOrder(buyRule, q, buyLimit); validateOrder(sellRule, q, sellLimit);
      const buyFee = bd.total.mul(br), sellFee = sd.total.mul(sr);
      const buffer = decimal(settings.buffer, '固定缓冲', { zero: true });
      const rebalanceCost = mode === 'arbitrage' ? decimal(settings.costs?.rebalanceByQuote?.[pair(b.pair).quote] ?? '0', '库存再平衡预估成本', { zero: true }) : D(0);
      const grossProfit = sd.total.minus(bd.total);
      const executionNet = grossProfit.minus(buyFee).minus(sellFee).minus(buffer);
      const net = executionNet.minus(rebalanceCost);
      const bc = q.mul(buyLimit), sc = q.mul(sellLimit);
      const buyWorstCost = bc.mul(D(1).plus(br));
      const conservative = sc.mul(D(1).minus(sr)).minus(buyWorstCost).minus(buffer).minus(rebalanceCost);
      const netBps = conservative.div(buyWorstCost).mul(10000);
      const buyDepth = executableNotional(b.asks, buyLimit, true), sellDepth = executableNotional(s.bids, sellLimit, false);
      const threshold = mode === 'balance' ? D(balanceConfig.maxLoss).neg() : D(settings.minProfit);
      const depthThreshold = mode === 'balance' ? threshold : D(settings.minDepthProfit);
      const reasons = [];
      if (net.lt(depthThreshold)) reasons.push(`深度净利润 ${net} / 门槛 ${depthThreshold}`);
      if (conservative.lt(threshold)) reasons.push(`限价保守净利润 ${conservative} / 门槛 ${threshold}`);
      if (mode === 'arbitrage') {
        const minimumBps = decimal(filters.minNetBps ?? '0', '净收益率门槛', { zero: true });
        if (minimumBps.gt(0) && netBps.lt(minimumBps)) reasons.push(`保守净收益率 ${netBps} bps / 门槛 ${minimumBps} bps`);
      }
      const minimumDepth = decimal(filters.minDepthNotional ?? '0', '限价内深度下限', { zero: true });
      if (buyDepth.lt(minimumDepth) || sellDepth.lt(minimumDepth)) reasons.push(`限价内有效深度 买侧 ${buyDepth} / 卖侧 ${sellDepth} / 下限 ${minimumDepth}`);
      const result = { pair: b.pair, buyExchange, sellExchange, amount: String(amount), qty: q.toString(),
        buyBest: b.asks[0][0], sellBest: s.bids[0][0], buyAvg: bd.avg.toString(), sellAvg: sd.avg.toString(),
        buyLimit: buyLimit.toString(), sellLimit: sellLimit.toString(), buyCost: bd.total.toString(), sellProceeds: sd.total.toString(),
        buyFee: buyFee.toString(), sellFee: sellFee.toString(), net: net.toString(), conservative: conservative.toString(),
        grossProfit: grossProfit.toString(), executionNet: executionNet.toString(), rebalanceCost: rebalanceCost.toString(),
        totalCosts: buyFee.plus(sellFee).plus(buffer).plus(rebalanceCost).toString(), netBps: netBps.toString(),
        buySpreadBps: buySpread.toString(), sellSpreadBps: sellSpread.toString(), bookSkewMs,
        buyDepthNotional: buyDepth.toString(), sellDepthNotional: sellDepth.toString(),
        buyWorstCost: buyWorstCost.toString(), sellBaseRequired: q.mul(D(1).plus(sr)).toString(),
        at: now, sampleAt: Math.min(b.at, s.at), eligible: reasons.length === 0, reasons, mode };
      attempts.push(result);
      if (result.eligible) return { ...result, attempts };
    } catch (e) { attempts.push({ amount: String(amount), eligible: false, reasons: [e.message] }); }
  }
  return { ...(attempts.find(x => x.qty) || attempts.at(-1)), pair: buy?.pair, buyExchange, sellExchange, eligible: false, attempts,
    reasons: attempts.flatMap(x => x.reasons), at: now, mode };
}
