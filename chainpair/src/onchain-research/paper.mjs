import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { validId, validAddress, sameAddress } from '../opportunities/registry.mjs';
import { convertInventoryAmount } from '../policy.mjs';

const Money = Decimal.clone({ precision: 64 });
const KEY = 'paper.current.v1', CHAINS = ['bnb', 'solana'], AMOUNTS = [1, 2, 5, 10, 20, 50], FRESH_MS = 120000;
const DEFAULT_RISK = Object.freeze({ minProfitUsd: .03, maxDailyLossUsd: 5, maxInventoryLossUsd: 10, maxExposureUsd: 50, maxTokenExposureUsd: 150, inventoryPenaltyBps: 25 });
const clone = value => structuredClone(value);
const fail = message => Object.assign(new Error(message), { safe: true });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const qty = value => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const units = (value, decimals) => new Money(value).div(new Money(10).pow(decimals));
const raw = (value, decimals) => new Money(value).mul(new Money(10).pow(decimals)).floor().toFixed(0);
const iso = now => new Date(now).toISOString();
const day = now => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const mapping = asset => (asset?.mapping?.confirmed === true || asset?.mappingConfirmed === true || asset?.confirmed === true) && !asset?.mapping?.warning && Boolean((asset?.mappingEvidence || asset?.mapping?.evidence || asset?.evidence || '').trim());
const sleepDefault = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const safeReason = error => error?.safe && typeof error.message === 'string' ? error.message.replace(/https?:\/\/[^\s]+/g, '[远程服务]').replace(/\b(private[_ -]?key|secret[_ -]?key|secret|password|passphrase|api[_ -]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[已隐藏]').replace(/0x[0-9a-f]{64}\b/gi, '[已隐藏]').slice(0, 300) : 'paper真实报价未完成，请核对来源；不会补造模拟成交';
const fingerprint = asset => JSON.stringify([asset.id, asset.revision, ...CHAINS.flatMap(chain => {
  const value = asset.chains[chain]; return [chain === 'bnb' ? value.address.toLowerCase() : value.address, value.decimals, value.poolAddress || ''];
})]);

function riskSettings(input = {}, previous = DEFAULT_RISK) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('paper 风控配置无效');
  const out = {};
  for (const key of Object.keys(DEFAULT_RISK)) {
    const value = input[key] ?? previous[key];
    const max = key === 'inventoryPenaltyBps' ? 5000 : 1000000000;
    if (!finite(value) || value < (key === 'minProfitUsd' || key === 'inventoryPenaltyBps' ? 0 : .00000001) || value > max) throw fail(`paper 风控字段无效：${key}`);
    out[key] = value;
  }
  return out;
}

/** A separate virtual ledger. It has no signer, submission, bridge or live engine. */
export class OnchainPaperEngine {
  constructor({ store, quoteClient, now = Date.now, sleep = sleepDefault } = {}) {
    if (!store || !quoteClient || typeof quoteClient.quote !== 'function') throw new Error('Paper requires an independent research store and quote client');
    this.store = store; this.quoteClient = quoteClient; this.now = now; this.sleep = sleep;
    this.state = store.getState(KEY, null); this.lastDurableState = clone(this.state); this.storageFailure = null; this.busy = false; this.pending = null;
    if (this.state?.asset) { this.state.assetId = this.state.asset.id; this.state.assetRevision = this.state.asset.revision; }
    if (this.state?.currentTrade && !['COMPLETED', 'REJECTED', 'NEEDS_REVIEW'].includes(this.state.currentTrade.status)) {
      this.state.running = false; this.state.needsReview = true; this.state.pausedReason = '上次paper存在未完成阶段，已保留虚拟余额和预占，禁止自动重放';
      this.state.currentTrade.status = 'NEEDS_REVIEW';
      this.commit('RESTART_REVIEW', { tradeId: this.state.currentTrade.id });
    }
  }
  event(status, extra = {}) {
    return { id: randomUUID(), mode: 'paper', source: 'real-aggregator-quotes', sessionId: this.state?.sessionId || null, assetId: this.state?.asset?.id || null, status, at: iso(this.now()), chainTransaction: false, ...extra };
  }
  commit(status, extra = {}, kind = 'paper-event') {
    const draft = clone(this.state); draft.updatedAt = iso(this.now());
    try {
      const committed = this.store.commitState(KEY, draft, { kind, record: this.event(status, extra) });
      this.state = committed; this.lastDurableState = clone(committed); this.storageFailure = null;
      return this.state;
    } catch {
      // The SQLite transaction may have rolled back after its state UPDATE but
      // before the event INSERT. Never keep the corresponding mutated balances.
      let restored, restoredFrom = 'persistent-state';
      try { restored = this.store.getState(KEY, clone(this.lastDurableState)); }
      catch { restored = clone(this.lastDurableState); restoredFrom = 'last-durable-snapshot'; }
      this.state = clone(restored); this.lastDurableState = clone(restored);
      this.storageFailure = { status, at: iso(this.now()), restoredFrom };
      throw Object.assign(fail('paper阶段未能持久化，已恢复最后保存的余额和记录，禁止把未保存成交计为收益'), {
        paperPersistenceFailure: true, paperFailedStatus: status, paperRollbackStatus: this.state?.currentTrade?.status || 'no-active-trade',
      });
    }
  }
  assertAsset(asset, row, { requireMapping = true } = {}) {
    validId(asset?.id);
    if (!Number.isSafeInteger(asset.revision) || asset.revision < 1 || asset.enabled === false) throw fail('paper资产版本无效或已停用');
    if (requireMapping && !mapping(asset)) throw fail('paper须先核验两链1:1同币关系，候选名称不能作为身份依据');
    if (!row || row.asset?.id !== asset.id || row.asset?.revision !== asset.revision || row.marketQualified !== true || row.comparisonStatus !== 'comparable' || row.anomalous === true || row.universe?.eligible !== true || typeof row.generation !== 'string' || !row.generation || row.generation.length > 160) throw fail('paper缺少正常的同轮双链真实行情');
    const at = this.now();
    for (const chain of CHAINS) {
      validAddress(chain, asset.chains?.[chain]?.address);
      if (!sameAddress(chain, asset.chains[chain].address, row.asset?.chains?.[chain]?.address)) throw fail('paper同币地址与当前扫描身份不一致');
      const market = row.market?.[chain], observed = time(market?.observedAt);
      if (!finite(market?.priceUsd) || market.priceUsd <= 0 || !Number.isSafeInteger(observed) || observed > at + 1000 || at - observed > FRESH_MS || market.priceConflict === true || market.priceConfidence === 'conflicting-pools') throw fail('paper真实标记价格缺失、冲突或已过期');
    }
    return true;
  }
  resolveDecimals(asset, quote) {
    const result = {};
    for (const chain of CHAINS) {
      const configured = asset.chains[chain].decimals, supplied = quote?.tokenDecimals?.[chain];
      const value = Number.isInteger(configured) ? configured : supplied;
      if (!Number.isInteger(value) || value < 0 || value > (chain === 'solana' ? 9 : 36) || Number.isInteger(configured) && Number.isInteger(supplied) && configured !== supplied) throw fail('paper代币精度未完成链上核验，不能猜测数量');
      result[chain] = value;
    }
    return result;
  }
  start({ asset, row, quote, capitalPerChainUsd = 100, risk = {} } = {}) {
    if (this.busy || this.state?.currentTrade && this.state.currentTrade.status === 'NEEDS_REVIEW') throw fail('paper存在在途或待核对虚拟敞口，不能重置余额');
    if (this.state) throw fail('已有paper会话；请使用恢复，不会重新注入虚拟资金覆盖历史');
    this.assertAsset(asset, row);
    if (!finite(capitalPerChainUsd) || capitalPerChainUsd < 2 || capitalPerChainUsd > 1000000) throw fail('paper每链虚拟初始资金须为2–1000000U');
    if (quote && (quote.assetId !== asset.id || quote.assetRevision !== asset.revision || quote.identityVerified !== true || quote.readOnly !== true || quote.executable !== false || !Number.isFinite(time(quote.expiresAt)) || time(quote.expiresAt) <= this.now())) throw fail('paper初始精度报价与身份或有效期不一致');
    const decimals = this.resolveDecimals(asset, quote), riskValue = riskSettings(risk);
    const positions = {};
    for (const chain of CHAINS) {
      const price = row.market[chain].priceUsd, tokenRaw = raw(new Money(capitalPerChainUsd).div(2).div(price), decimals[chain]);
      const tokenCost = units(tokenRaw, decimals[chain]).mul(price);
      positions[chain] = { cashUsd: new Money(capitalPerChainUsd).minus(tokenCost).toFixed(), tokenRaw, tokenDecimals: decimals[chain], tokenCostUsd: tokenCost.toFixed(), feesUsd: '0' };
    }
    const normalizedAsset = clone(asset); for (const chain of CHAINS) normalizedAsset.chains[chain].decimals = decimals[chain];
    this.state = { schemaVersion: 1, mode: 'paper', source: 'real-aggregator-quotes', sessionId: randomUUID(), assetId: normalizedAsset.id, assetRevision: normalizedAsset.revision, asset: normalizedAsset, identity: fingerprint(normalizedAsset), running: true, needsReview: false, pausedReason: '', createdAt: iso(this.now()), updatedAt: iso(this.now()),
      capitalPerChainUsd, contributedCapitalUsd: new Money(capitalPerChainUsd).mul(2).toNumber(), risk: riskValue, positions,
      reservations: { cashUsd: { bnb: '0', solana: '0' }, tokenRaw: { bnb: '0', solana: '0' } },
      marks: Object.fromEntries(CHAINS.map(chain => [chain, { priceUsd: row.market[chain].priceUsd, observedAt: time(row.market[chain].observedAt) }])), markGeneration: row.generation,
      totals: { attemptedTrades: 0, completedTrades: 0, failedTrades: 0, grossSpreadUsd: 0, realizedCashSpreadUsd: 0, tradingFeesUsd: 0, executionSlippageUsd: 0, inventoryRebalanceLossUsd: 0, tokenCostRealizedPnlUsd: 0 },
      daily: { day: day(this.now()), realizedCashSpreadUsd: 0, openingEquityUsd: capitalPerChainUsd * 2, openingAt: iso(this.now()) }, equity: { peakUsd: capitalPerChainUsd * 2, maximumDrawdownUsd: 0, maxDrawdownPct: 0 },
      currentTrade: null, latestTrade: null, consumedQuoteIds: [],
      feePaymentModel: '费用按真实报价USD等值扣虚拟现金；不代表链上原生币已准备或实际成交', includesFutureRestockingCosts: false };
    this.commit('SESSION_STARTED', { virtualCapitalContributedUsd: this.state.contributedCapitalUsd, allocation: 'each-chain-50-percent-cash-50-percent-token', referenceGeneration: row.generation });
    return this.snapshot();
  }
  assertSession(asset, row) {
    if (!this.state) throw fail('尚未创建paper虚拟会话');
    this.assertAsset(asset, row);
    const normalized = clone(asset);
    for (const chain of CHAINS) normalized.chains[chain].decimals ??= this.state.asset.chains[chain].decimals;
    if (fingerprint(normalized) !== this.state.identity) throw fail('paper同币地址、精度或版本已变化，须停止并核对原虚拟库存');
  }
  pause(reason = '已手动暂停paper；不影响真实钱包') {
    if (!this.state) return this.snapshot();
    this.state.running = false; this.state.pausedReason = typeof reason === 'string' ? reason.slice(0, 240) : '已暂停paper';
    this.commit('PAUSED', { reason: this.state.pausedReason }); return this.snapshot();
  }
  resume({ asset, row } = {}) {
    if (this.busy) throw fail('paper仍有任务进行中');
    this.assertSession(asset, row);
    if (this.state.needsReview || this.state.currentTrade?.status === 'NEEDS_REVIEW') throw fail('paper仍有单边虚拟敞口待核对，不能自动补卖或重放');
    if (this.storageFailure || this.state.currentTrade && !['COMPLETED', 'REJECTED'].includes(this.state.currentTrade.status)) throw fail('paper仍有未完成阶段或存储故障，须先核对最后保存状态，禁止覆盖旧任务');
    this.state.running = true; this.state.pausedReason = ''; this.commit('RESUMED'); this.mark({ asset, row }); return this.snapshot();
  }
  setSettings(input) {
    if (!this.state) throw fail('请先创建paper会话');
    if (this.busy) throw fail('paper执行中暂不能更改风险参数');
    this.state.risk = riskSettings(input, this.state.risk); this.commit('RISK_UPDATED'); return this.snapshot();
  }
  valuation() {
    if (!this.state) return { fresh: false, equityUsd: null, tokenValueUsd: null, unrealizedPnlUsd: null };
    let equity = new Money(0), tokens = new Money(0), cost = new Money(0);
    const at = this.now();
    for (const chain of CHAINS) {
      const position = this.state.positions[chain], mark = this.state.marks[chain];
      if (!finite(mark?.priceUsd) || mark.priceUsd <= 0 || !Number.isFinite(mark.observedAt) || mark.observedAt > at + 1000 || at - mark.observedAt > FRESH_MS) return { fresh: false, equityUsd: null, tokenValueUsd: null, unrealizedPnlUsd: null };
      const value = units(position.tokenRaw, position.tokenDecimals).mul(mark.priceUsd);
      tokens = tokens.plus(value); cost = cost.plus(position.tokenCostUsd); equity = equity.plus(position.cashUsd).plus(value);
    }
    return { fresh: true, equityUsd: equity.toNumber(), tokenValueUsd: tokens.toNumber(), unrealizedPnlUsd: tokens.minus(cost).toNumber() };
  }
  updateEquity() {
    const value = this.valuation();
    if (!value.fresh) return value;
    const equity = this.state.equity;
    equity.peakUsd = Math.max(equity.peakUsd, value.equityUsd);
    const drawdown = Math.max(0, equity.peakUsd - value.equityUsd);
    equity.maximumDrawdownUsd = Math.max(equity.maximumDrawdownUsd, drawdown);
    equity.maxDrawdownPct = Math.max(equity.maxDrawdownPct, equity.peakUsd > 0 ? drawdown / equity.peakUsd * 100 : 0);
    equity.lastUsd = value.equityUsd; equity.lastAt = iso(this.now()); return value;
  }
  mark({ asset, row } = {}) {
    if (!this.state) return this.snapshot();
    this.assertSession(asset, row);
    if (row.generation === this.state.markGeneration) return this.snapshot();
    this.state.marks = Object.fromEntries(CHAINS.map(chain => [chain, { priceUsd: row.market[chain].priceUsd, observedAt: time(row.market[chain].observedAt) }]));
    this.state.markGeneration = row.generation;
    const value = this.updateEquity();
    if (this.state.daily.day !== day(this.now()) && value.fresh) this.state.daily = { day: day(this.now()), realizedCashSpreadUsd: 0, openingEquityUsd: value.equityUsd, openingAt: iso(this.now()) };
    if (value.fresh && value.unrealizedPnlUsd < -this.state.risk.maxInventoryLossUsd) { this.state.running = false; this.state.pausedReason = '虚拟持币浮亏超过paper上限，已暂停；不会进行亏损自动平衡'; }
    if (value.fresh && value.equityUsd < this.state.daily.openingEquityUsd - this.state.risk.maxDailyLossUsd) { this.state.running = false; this.state.pausedReason = 'paper本日标记净值损失超过上限，已暂停；正现金价差不抵消账户风险检查'; }
    this.commit('EQUITY_MARKED', { generation: row.generation, netEquityUsd: value.equityUsd, unrealizedPnlUsd: value.unrealizedPnlUsd }, 'equity');
    return this.snapshot();
  }
  snapshot() {
    if (!this.state) return { mode: 'paper', source: 'real-aggregator-quotes', sessionId: null, running: false, busy: this.busy, needsReview: false, pausedReason: this.storageFailure ? 'paper会话未能保存，请检查存储后重新明确启动' : '', persistenceFailure: this.storageFailure ? clone(this.storageFailure) : null, positions: null, reservations: null, stats: { contributedCapitalUsd: null, realizedCashSpreadUsd: null, netEquityUsd: null, unrealizedPnlUsd: null, maxDrawdownPct: null, successfulBothLegsRate: null } };
    const out = clone(this.state), value = this.valuation(), current = this.state.currentTrade;
    let exposure = 0, oneSideLoss = null;
    if (current?.buy && !current.sell) {
      if (value.fresh) {
        exposure = units(current.buy.receivedRaw, this.state.positions[current.buyChain].tokenDecimals).mul(this.state.marks[current.buyChain].priceUsd).toNumber();
        oneSideLoss = Math.max(0, current.amountUsd + current.buy.feeUsd - exposure);
      } else exposure = null;
    }
    const totals = this.state.totals, attempts = totals.attemptedTrades ?? totals.completedTrades + totals.failedTrades;
    out.busy = this.busy;
    out.persistenceFailure = this.storageFailure ? clone(this.storageFailure) : null;
    if (this.storageFailure) { out.running = false; out.needsReview = out.needsReview || Boolean(current); out.pausedReason = 'paper存储失败，显示最后已保存的余额；请核对记录，禁止继续模拟成交'; }
    out.stats = { ...clone(totals), contributedCapitalUsd: this.state.contributedCapitalUsd, singleSidedLossUsd: oneSideLoss, unhedgedExposureUsd: exposure,
      unrealizedPnlUsd: value.unrealizedPnlUsd, netEquityUsd: value.equityUsd, netEquityPnlUsd: value.fresh ? value.equityUsd - this.state.contributedCapitalUsd : null,
      maxDrawdownPct: this.state.equity.maxDrawdownPct, maximumDrawdownUsd: this.state.equity.maximumDrawdownUsd,
      lastKnownEquityUsd: this.state.equity.lastUsd ?? this.state.contributedCapitalUsd, currentMarksFresh: value.fresh,
      dailyRealizedCashSpreadUsd: this.state.daily.realizedCashSpreadUsd, successfulBothLegsRate: attempts ? totals.completedTrades / attempts : null,
      dailyMarkedLossUsd: value.fresh && finite(this.state.daily.openingEquityUsd) ? Math.max(0, this.state.daily.openingEquityUsd - value.equityUsd) : null,
      pendingTrades: current && !['COMPLETED', 'REJECTED', 'NEEDS_REVIEW'].includes(current.status) ? 1 : 0, unknownTrades: current?.status === 'NEEDS_REVIEW' || this.storageFailure && current ? 1 : 0,
      quotedNetworkFeesUsd: totals.tradingFeesUsd, explicitDexTradingFeesUsd: null,
      feeCoverage: '累计报价费用为Gas与租金；DEX费用已嵌入兑换输出，尚未独立拆分核验，不视为零',
      includesFutureRestockingCosts: false, resultsAreVirtual: true };
    return out;
  }
  validatePlan(quote, { asset, row, amountUsd, buyChain, requirePositive = true } = {}) {
    const at = this.now(), sellChain = buyChain === 'bnb' ? 'solana' : 'bnb';
    if (!quote || quote.readOnly !== true || quote.executable !== false || quote.identityVerified !== true || quote.assetId !== asset.id || quote.assetRevision !== asset.revision || quote.generation !== row.generation || quote.buyChain !== buyChain || quote.sellChain !== sellChain || quote.amountUsd !== amountUsd || !AMOUNTS.includes(amountUsd)) throw fail('paper真实报价身份、方向、金额或扫描批次不一致');
    if (!Number.isSafeInteger(quote.parentRevision) || quote.parentRevision < 0 || typeof quote.parentPolicyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(quote.parentPolicyFingerprint)) throw fail('paper真实报价缺少配置和风控版本证据');
    const observed = time(quote.quotedAt), expiry = time(quote.expiresAt);
    if (!Number.isFinite(observed) || observed > at + 1000 || at - observed > FRESH_MS || !Number.isFinite(expiry) || expiry <= at) throw fail('paper报价已过期或缺少真实采样时间');
    if (!finite(quote.buyFeeUsd) || quote.buyFeeUsd < 0 || !finite(quote.sellFeeUsd) || quote.sellFeeUsd < 0 || !qty(quote.buyMinOutRaw) || BigInt(quote.buyMinOutRaw) <= 0n || !qty(quote.buyAmountOutRaw) || BigInt(quote.buyAmountOutRaw) < BigInt(quote.buyMinOutRaw) || !qty(quote.sellAmountRaw) || !qty(quote.sellMinOutRaw) || BigInt(quote.sellMinOutRaw) <= 0n || !qty(quote.sellAmountOutRaw) || BigInt(quote.sellAmountOutRaw) < BigInt(quote.sellMinOutRaw)) throw fail('paper缺少完整真实数量、费用或最低到账证据');
    for (const chain of CHAINS) if (quote.tokenDecimals?.[chain] !== this.state.positions[chain].tokenDecimals || !Number.isInteger(quote.stableDecimals?.[chain]) || quote.stableDecimals[chain] < 0 || quote.stableDecimals[chain] > 36) throw fail('paper真实报价精度与会话不一致');
    const buyQuote = quote.buyQuote, sellQuote = quote.sellQuote;
    if (!qty(quote.buyAmountInRaw) || quote.buyAmountInRaw !== raw(amountUsd, quote.stableDecimals[buyChain]) || buyQuote?.chain !== buyChain || buyQuote.amountInRaw !== quote.buyAmountInRaw || buyQuote.minOutRaw !== quote.buyMinOutRaw || buyQuote.amountOutRaw !== quote.buyAmountOutRaw || buyQuote.fromToken?.kind !== 'stable' || buyQuote.fromToken.decimals !== quote.stableDecimals[buyChain] || buyQuote.toToken?.decimals !== quote.tokenDecimals[buyChain] || !sameAddress(buyChain, buyQuote.toToken?.address, asset.chains[buyChain].address) || sellQuote?.chain !== sellChain || sellQuote.amountInRaw !== quote.sellAmountRaw || sellQuote.minOutRaw !== quote.sellMinOutRaw || sellQuote.amountOutRaw !== quote.sellAmountOutRaw || sellQuote.fromToken?.decimals !== quote.tokenDecimals[sellChain] || !sameAddress(sellChain, sellQuote.fromToken?.address, asset.chains[sellChain].address) || sellQuote.toToken?.kind !== 'stable' || sellQuote.toToken.decimals !== quote.stableDecimals[sellChain]) throw fail('paper双腿证据与准确输入、目标币或稳定币到账不一致');
    validAddress(buyChain, buyQuote.fromToken.address); validAddress(sellChain, sellQuote.toToken.address);
    if (!finite(quote.buyRentUsd) || quote.buyRentUsd < 0 || quote.buyRentUsd > quote.buyFeeUsd || !finite(quote.sellRentUsd) || quote.sellRentUsd < 0 || quote.sellRentUsd > quote.sellFeeUsd) throw fail('paper报价缺少已包含在费用内的租金证据');
    const converted = convertInventoryAmount(quote.buyMinOutRaw, quote.tokenDecimals[buyChain], quote.tokenDecimals[sellChain], sellChain).amountRaw;
    if (quote.sellAmountRaw !== converted) throw fail('paper卖出数量未按买入最低到账准确换算');
    const adjustmentReserve = quote.inventoryAdjustmentCostUsd ?? 0;
    if (!finite(adjustmentReserve) || adjustmentReserve < 0) throw fail('paper库存调整成本预留无效');
    const net = units(quote.sellMinOutRaw, quote.stableDecimals[sellChain]).minus(amountUsd).minus(quote.buyFeeUsd).minus(quote.sellFeeUsd).minus(adjustmentReserve).toNumber();
    if (!finite(quote.netProfitUsd) || Math.abs(net - quote.netProfitUsd) > 1e-8) throw fail('paper报价净收益与最低到账及费用不一致');
    if (requirePositive && (quote.qualityPassed !== true || net < this.state.risk.minProfitUsd || !finite(quote.stressNetProfitUsd) || quote.stressNetProfitUsd < this.state.risk.minProfitUsd)) throw fail('paper真实保守利润或压力值未达门槛，不执行亏损平衡');
    return { netProfitUsd: net, sellChain, converted };
  }
  threshold(quote) {
    const state = this.state, amount = new Money(quote.amountUsd), buy = state.positions[quote.buyChain], sell = state.positions[quote.sellChain];
    const ratio = (position, price, cashDelta = 0, tokenDelta = 0) => {
      const cash = new Money(position.cashUsd).plus(cashDelta), tokenValue = units(position.tokenRaw, position.tokenDecimals).plus(tokenDelta).mul(price), total = cash.plus(tokenValue);
      return total.gt(0) ? cash.div(total).minus(.5).abs() : new Money(1);
    };
    const buyPrice = state.marks[quote.buyChain].priceUsd, sellPrice = state.marks[quote.sellChain].priceUsd;
    const buyQty = units(quote.buyMinOutRaw, buy.tokenDecimals), sellQty = units(quote.sellAmountRaw, sell.tokenDecimals), proceeds = units(quote.sellMinOutRaw, quote.stableDecimals[quote.sellChain]);
    const before = ratio(buy, buyPrice).plus(ratio(sell, sellPrice));
    const after = ratio(buy, buyPrice, amount.neg().minus(quote.buyFeeUsd), buyQty).plus(ratio(sell, sellPrice, proceeds.minus(quote.sellFeeUsd), sellQty.neg()));
    const worsens = Money.max(0, after.minus(before));
    const adjustmentReserveUsd = amount.mul(worsens).mul(state.risk.inventoryPenaltyBps).div(10000).toNumber();
    return { minProfitUsd: state.risk.minProfitUsd + adjustmentReserveUsd, adjustmentReserveUsd, restoresInventory: after.lt(before), deviationBefore: before.toNumber(), deviationAfter: after.toNumber() };
  }
  available(quote) {
    const state = this.state, buy = state.positions[quote.buyChain], sell = state.positions[quote.sellChain];
    if (new Money(buy.cashUsd).lt(new Money(quote.amountUsd).plus(quote.buyFeeUsd))) throw fail('paper低价链虚拟现金不足以支付本金与费用');
    const reserveRaw = convertInventoryAmount(quote.buyAmountOutRaw, buy.tokenDecimals, sell.tokenDecimals, quote.sellChain).amountRaw;
    if (BigInt(sell.tokenRaw) < BigInt(reserveRaw)) throw fail('paper高价链虚拟代币库存耗尽，禁止先买入');
    if (quote.amountUsd > state.risk.maxExposureUsd) throw fail('paper本笔单边敞口超过上限');
    const current = this.valuation();
    if (!current.fresh) throw fail('paper参考标记过期，无法核验风险敞口');
    if (current.unrealizedPnlUsd < -state.risk.maxInventoryLossUsd) throw fail('paper持币浮亏已超过上限');
    const projected = new Money(current.tokenValueUsd).plus(units(quote.buyMinOutRaw, buy.tokenDecimals).mul(state.marks[quote.buyChain].priceUsd)).minus(units(quote.sellAmountRaw, sell.tokenDecimals).mul(state.marks[quote.sellChain].priceUsd));
    if (projected.gt(state.risk.maxTokenExposureUsd)) throw fail('paper单币虚拟库存敞口超过上限');
    if (state.daily.day !== day(this.now())) state.daily = { day: day(this.now()), realizedCashSpreadUsd: 0, openingEquityUsd: current.equityUsd, openingAt: iso(this.now()) };
    if (state.daily.realizedCashSpreadUsd <= -state.risk.maxDailyLossUsd) throw fail('paper已达到最大单日亏损上限');
    const proceeds = units(quote.sellMinOutRaw, quote.stableDecimals[quote.sellChain]);
    const projectedEquity = new Money(current.equityUsd).plus(projected.minus(current.tokenValueUsd)).plus(proceeds).minus(quote.amountUsd).minus(quote.buyFeeUsd).minus(quote.sellFeeUsd);
    if (projectedEquity.lt(new Money(state.daily.openingEquityUsd).minus(state.risk.maxDailyLossUsd))) throw fail('paper本笔预计标记净值损失会超过最大单日亏损，正现金价差不能绕过');
    return { reserveRaw, reserveCashUsd: new Money(quote.amountUsd).plus(quote.buyFeeUsd).toFixed() };
  }
  async execute({ asset, row, quote, delayMs = 1500, assertCurrent = () => {} } = {}) {
    if (this.busy) throw fail('paper已有任务进行中');
    if (this.storageFailure) throw fail('paper存储故障尚未核对，禁止继续模拟成交');
    this.assertSession(asset, row);
    if (!this.state.running || this.state.needsReview) throw fail('paper已暂停或存在单边敞口，禁止自动补单');
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) throw fail('paper模拟延迟须为0–60000毫秒');
    const amountUsd = quote?.amountUsd, buyChain = quote?.buyChain;
    if (!CHAINS.includes(buyChain)) throw fail('paper报价方向无效');
    this.validatePlan(quote, { asset, row, amountUsd, buyChain });
    if (typeof quote.id !== 'string' || !quote.id || this.state.consumedQuoteIds.includes(quote.id)) throw fail('paper报价已使用或标识无效，禁止重复订单');
    const threshold = this.threshold(quote);
    if (quote.netProfitUsd < threshold.minProfitUsd || quote.stressNetProfitUsd < threshold.minProfitUsd) throw fail('paper库存偏离调整后的利润门槛未通过，不进行亏损平衡');
    const reserved = this.available(quote), sellChain = buyChain === 'bnb' ? 'solana' : 'bnb';
    const trade = { id: randomUUID(), mode: 'paper', source: 'real-aggregator-quotes', sessionId: this.state.sessionId, assetId: asset.id, assetRevision: asset.revision,
      generation: row.generation, status: 'QUEUED', createdAt: iso(this.now()), amountUsd, buyChain, sellChain, initialQuoteId: quote.id, delayMs, modeled: true, chainTransaction: false, threshold };
    this.state.currentTrade = trade; this.state.totals.attemptedTrades = (this.state.totals.attemptedTrades || 0) + 1; this.state.consumedQuoteIds.push(quote.id); this.state.consumedQuoteIds = this.state.consumedQuoteIds.slice(-5000);
    this.state.reservations.cashUsd[buyChain] = reserved.reserveCashUsd; this.state.reservations.tokenRaw[sellChain] = reserved.reserveRaw;
    this.busy = true;
    try { this.commit('QUEUED', { tradeId: trade.id, quoteId: quote.id }); }
    catch { this.busy = false; throw fail('paper预占记录未能持久化，未生成虚拟成交'); }
    const guard = () => { assertCurrent(); this.assertSession(asset, row); if (!this.state.running) throw fail('paper已暂停，禁止继续虚拟成交'); };
    const run = async () => {
      try {
        await this.sleep(delayMs); guard();
        const current = await this.quoteClient.quote({ asset: clone(asset), row: clone(row), amountUsd, buyChain }); guard();
        this.validatePlan(current, { asset, row, amountUsd, buyChain });
        if (current.parentRevision !== quote.parentRevision || current.parentPolicyFingerprint !== quote.parentPolicyFingerprint) throw fail('paper延迟期间配置或风控版本已变化，取消买入');
        if (current.id === quote.id || typeof current.id !== 'string' || !current.id || time(current.quotedAt) < time(trade.createdAt)) throw fail('paper延迟后未取得新的真实买入报价');
        const currentThreshold = this.threshold(current);
        if (current.netProfitUsd < currentThreshold.minProfitUsd || current.stressNetProfitUsd < currentThreshold.minProfitUsd) throw fail('延迟后的真实报价已不满足库存与利润门槛，取消虚拟买入');
        const funds = this.available(current);
        this.state.reservations.cashUsd[buyChain] = funds.reserveCashUsd; this.state.reservations.tokenRaw[sellChain] = funds.reserveRaw;
        trade.status = 'BUY_READY'; trade.buyQuoteId = current.id; this.state.currentTrade = clone(trade); this.commit('BUY_READY', { tradeId: trade.id, quoteId: current.id });
        guard();
        const buy = this.state.positions[buyChain];
        buy.cashUsd = new Money(buy.cashUsd).minus(amountUsd).minus(current.buyFeeUsd).toFixed();
        buy.tokenRaw = (BigInt(buy.tokenRaw) + BigInt(current.buyMinOutRaw)).toString(); buy.tokenCostUsd = new Money(buy.tokenCostUsd).plus(amountUsd).toFixed(); buy.feesUsd = new Money(buy.feesUsd).plus(current.buyFeeUsd).toFixed();
        this.state.totals.tradingFeesUsd += current.buyFeeUsd;
        const buySlippage = units(new Money(current.buyAmountOutRaw).minus(current.buyMinOutRaw), buy.tokenDecimals).mul(new Money(amountUsd).div(units(current.buyAmountOutRaw, buy.tokenDecimals))).toNumber();
        this.state.totals.executionSlippageUsd += buySlippage;
        const sellRaw = convertInventoryAmount(current.buyMinOutRaw, buy.tokenDecimals, this.state.positions[sellChain].tokenDecimals, sellChain).amountRaw;
        trade.buy = { quoteId: current.buyQuote?.quoteId || current.buyQuote?.id || current.id, receivedRaw: current.buyMinOutRaw, spentUsd: amountUsd, feeUsd: current.buyFeeUsd, slippageUsd: buySlippage, simulatedAt: iso(this.now()) };
        trade.sellAmountRaw = sellRaw; trade.status = 'BUY_FILLED'; this.state.currentTrade = clone(trade); this.state.reservations.cashUsd[buyChain] = '0'; this.state.reservations.tokenRaw[sellChain] = sellRaw;
        this.updateEquity(); this.commit('BUY_FILLED', { tradeId: trade.id, quoteId: trade.buy.quoteId, actualVirtualReceivedRaw: current.buyMinOutRaw });
        await this.sleep(delayMs); guard();
        if (typeof this.quoteClient.quoteSell !== 'function') throw fail('缺少实际虚拟买入数量的准确卖出报价，保留单边敞口');
        const sold = await this.quoteClient.quoteSell({ asset: clone(asset), row: clone(row), sellChain, amountRaw: sellRaw }); guard();
        const at = this.now(), expiry = time(sold?.expiresAt), observed = time(sold?.quotedAt), sell = this.state.positions[sellChain];
        if (!sold || sold.readOnly !== true || sold.executable !== false || sold.verified !== true || sold.identityVerified !== true || sold.assetId !== asset.id || sold.assetRevision !== asset.revision || sold.generation !== row.generation || sold.parentRevision !== current.parentRevision || sold.parentPolicyFingerprint !== current.parentPolicyFingerprint || sold.chain !== sellChain || sold.amountInRaw !== sellRaw || !qty(sold.minOutRaw) || BigInt(sold.minOutRaw) <= 0n || !qty(sold.amountOutRaw) || BigInt(sold.amountOutRaw) < BigInt(sold.minOutRaw) || !Number.isFinite(observed) || observed < time(trade.buy.simulatedAt) || observed > at + 1000 || !Number.isFinite(expiry) || expiry <= at || !finite(sold.feeUsd) || sold.feeUsd < 0 || !finite(sold.estimatedRentUsd) || sold.estimatedRentUsd < 0 || sold.estimatedRentUsd > sold.feeUsd || sold.fromToken?.decimals !== sell.tokenDecimals || !sameAddress(sellChain, sold.fromToken?.address, asset.chains[sellChain].address) || !Number.isInteger(sold.toToken?.decimals) || sold.toToken.decimals !== current.stableDecimals[sellChain] || sold.toToken.kind !== 'stable' || !sameAddress(sellChain, sold.toToken.address, current.sellQuote.toToken.address)) throw fail('延迟后的准确卖出报价缺少身份、数量、费用或新鲜度证据');
        const proceeds = units(sold.minOutRaw, sold.toToken.decimals), net = proceeds.minus(amountUsd).minus(current.buyFeeUsd).minus(sold.feeUsd);
        if (net.minus(current.inventoryAdjustmentCostUsd || 0).lt(currentThreshold.minProfitUsd)) throw fail('买入后卖出净价差已不足门槛，默认暂停等待核对，不进行亏损平衡');
        const stressed = proceeds.mul('.995').minus(amountUsd).minus(current.buyFeeUsd).minus(new Money(sold.feeUsd).mul('1.25')).minus(current.inventoryAdjustmentCostUsd || 0);
        if (stressed.lt(currentThreshold.minProfitUsd)) throw fail('买入后真实卖出压力净值已不足门槛，暂停核对');
        if (BigInt(sell.tokenRaw) < BigInt(sellRaw) || new Money(sell.cashUsd).plus(proceeds).lt(sold.feeUsd)) throw fail('paper卖出库存或费用资金不足，保留单边敞口');
        const costDisposed = new Money(sell.tokenCostUsd).mul(sellRaw).div(sell.tokenRaw);
        sell.tokenRaw = (BigInt(sell.tokenRaw) - BigInt(sellRaw)).toString(); sell.tokenCostUsd = new Money(sell.tokenCostUsd).minus(costDisposed).toFixed(); sell.cashUsd = new Money(sell.cashUsd).plus(proceeds).minus(sold.feeUsd).toFixed(); sell.feesUsd = new Money(sell.feesUsd).plus(sold.feeUsd).toFixed();
        const sellSlippage = units(new Money(sold.amountOutRaw).minus(sold.minOutRaw), sold.toToken.decimals).toNumber();
        this.state.totals.tradingFeesUsd += sold.feeUsd; this.state.totals.executionSlippageUsd += sellSlippage;
        this.state.totals.grossSpreadUsd += proceeds.minus(amountUsd).toNumber(); this.state.totals.realizedCashSpreadUsd += net.toNumber(); this.state.totals.tokenCostRealizedPnlUsd += proceeds.minus(costDisposed).minus(sold.feeUsd).toNumber(); this.state.totals.completedTrades++;
        if (this.state.daily.day !== day(at)) this.state.daily = { day: day(at), realizedCashSpreadUsd: 0, openingEquityUsd: this.valuation().equityUsd, openingAt: iso(at) };
        this.state.daily.realizedCashSpreadUsd += net.toNumber();
        trade.sell = { quoteId: sold.quoteId || sold.id, spentRaw: sellRaw, receivedUsd: proceeds.toNumber(), feeUsd: sold.feeUsd, slippageUsd: sellSlippage, simulatedAt: iso(at) };
        trade.status = 'COMPLETED'; trade.completedAt = iso(at); trade.realizedCashSpreadUsd = net.toNumber(); trade.grossSpreadUsd = proceeds.minus(amountUsd).toNumber(); trade.tradingFeesUsd = current.buyFeeUsd + sold.feeUsd; trade.executionSlippageUsd = buySlippage + sellSlippage; trade.estimatedInventoryAdjustmentReserveUsd = currentThreshold.adjustmentReserveUsd + (current.inventoryAdjustmentCostUsd || 0); trade.closedInventory = false; trade.includesFutureRestockingCosts = false;
        this.state.reservations = { cashUsd: { bnb: '0', solana: '0' }, tokenRaw: { bnb: '0', solana: '0' } };
        this.state.latestTrade = clone(trade); this.state.currentTrade = null; this.updateEquity();
        this.commit('COMPLETED', { ...clone(trade), id: trade.id }, 'paper-trade');
        return clone(trade);
      } catch (error) {
        const reason = safeReason(error);
        // Trust only the last committed trade stage. A failed BUY_FILLED write
        // does not create a buy; a failed COMPLETED write does not create a sell.
        const durableTrade = this.state?.currentTrade?.id === trade.id ? clone(this.state.currentTrade) : null;
        const recovery = durableTrade || { id: trade.id, mode: trade.mode, source: trade.source, sessionId: trade.sessionId, assetId: trade.assetId, assetRevision: trade.assetRevision,
          generation: trade.generation, createdAt: trade.createdAt, amountUsd: trade.amountUsd, buyChain: trade.buyChain, sellChain: trade.sellChain, initialQuoteId: trade.initialQuoteId, delayMs: trade.delayMs, modeled: true, chainTransaction: false, threshold: trade.threshold };
        this.state.totals.failedTrades++;
        recovery.status = recovery.buy ? 'NEEDS_REVIEW' : 'REJECTED'; recovery.failureReason = reason; recovery.finishedAt = iso(this.now());
        if (error?.paperPersistenceFailure === true) {
          recovery.failureEvidence = { persistenceStage: error.paperFailedStatus, rollbackStage: error.paperRollbackStatus, discardedUncommittedStage: true,
            attemptedQuoteIds: { ...(trade.buy?.quoteId ? { buy: trade.buy.quoteId } : {}), ...(trade.sell?.quoteId ? { sell: trade.sell.quoteId } : {}) } };
          this.state.running = false; this.state.pausedReason = 'paper持久化失败，已回滚最后保存的余额；请核对存储后明确恢复';
        }
        if (recovery.buy) { this.state.running = false; this.state.needsReview = true; this.state.pausedReason = 'paper买入后未完成卖出，保留单边虚拟敞口；须人工核对，不自动重放'; this.state.currentTrade = recovery; }
        else { this.state.reservations = { cashUsd: { bnb: '0', solana: '0' }, tokenRaw: { bnb: '0', solana: '0' } }; this.state.currentTrade = null; }
        this.state.latestTrade = clone(recovery); this.updateEquity(); this.commit(recovery.status, { ...clone(recovery), id: recovery.id }, 'paper-trade');
        return clone(recovery);
      } finally { this.busy = false; this.pending = null; }
    };
    this.pending = run(); return this.pending;
  }
}
