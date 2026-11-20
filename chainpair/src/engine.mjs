import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { DemoAdapter } from './adapters/demo.mjs';
import { validateConfig } from './config.mjs';
import { policyRecord, createPolicySnapshot, policyFingerprint, assertPolicyUnchanged, assertQuoteIntent, intentForLeg, swapIntent, bridgeIntent, positiveRaw, convertInventoryAmount } from './policy.mjs';

const now = () => new Date().toISOString();
const value = (n, d) => new Decimal(n || 0).div(new Decimal(10).pow(d)).toNumber();
const raw = (n, d) => new Decimal(n).mul(new Decimal(10).pow(d)).floor().toFixed(0);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const terminal = new Set(['COMPLETED', 'REVIEWED']);
const safeError = message => Object.assign(new Error(message), { safe: true });
const errText = e => e?.safe ? String(e.message).replace(/https?:\/\/[^\s]+/g, '[远程服务]').slice(0, 500) : '操作失败，请检查配置及链上回执；程序已保留状态';
const quoteFresh = q => q && Number.isFinite(Date.parse(q.expiresAt)) && Date.parse(q.expiresAt) > Date.now();
export class Engine {
  constructor({ store, vault, browserWallets, adapterFactory, phaseDelayMs = 0 }) {
    this.store = store; this.vault = vault; this.config = store.config;
    this.adapterFactory = adapterFactory; this.phaseDelayMs = phaseDelayMs; this.browserWallets = browserWallets;
    this.market = {}; this.balances = {}; this.opportunity = null; this.plan = null;
    this.running = false; this.busy = false; this.refreshing = false; this.activeTradeId = null;
    this.configuring = false; this.configRevision = 0; this.quoteBuilders = 0;
    this.pausedReason = ''; this.bridgeQuotes = new Map(); this.timer = null; this.lastError = '';
    this.inventoryCoordinator = null; this.executionGuard = null;
  }
  errorText(error) { const text = errText(error); return this.vault.redact ? this.vault.redact(text) : text; }
  async init() {
    await this.makeAdapter();
    const unfinished = this.store.allTrades().filter(t => !terminal.has(t.status));
    for (const trade of unfinished) {
      const reason = '上次运行存在未完成或不确定的交易；请核对源链、目标链余额与哈希后手动确认。程序不会重播。';
      this.event(trade, 'NEEDS_REVIEW', { failureReason: trade.failureReason || reason });
    }
    if (unfinished.length) this.pausedReason = '存在待人工核对的交易';
    await this.refresh();
    this.schedule(); return this;
  }
  async makeAdapter() {
    const args = { getConfig: () => this.config, store: this.store, vault: this.vault, browserWallets: this.browserWallets };
    if (this.adapterFactory) this.adapter = await this.adapterFactory(args);
    else if (this.config.mode === 'demo') this.adapter = new DemoAdapter(args);
    else { const { LiveAdapter } = await import('./adapters/live.mjs'); this.adapter = new LiveAdapter(args); }
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => { try { await this.refresh(); } catch (e) { this.lastError = this.errorText(e); } this.schedule(); }, this.config.pollIntervalMs);
    this.timer.unref?.();
  }
  stop() { clearTimeout(this.timer); this.running = false; }
  snapshot() {
    const wallets = this.vault.publicStatus();
    const reviewTradeId = this.store.allTrades().find(trade => trade.status === 'NEEDS_REVIEW')?.id || null;
    return { config: this.config, policyFingerprint: policyFingerprint(createPolicySnapshot(this.config)), market: this.market, balances: this.balances, opportunity: this.opportunity,
      engine: { running: this.running, busy: this.busy, configuring: this.configuring, pausedReason: this.pausedReason, activeTradeId: this.activeTradeId, reviewTradeId, lastError: this.lastError, mode: this.config.mode, executionMode: this.config.executionMode || 'bridge' },
      wallets, stats: this.store.stats(), okxConfigured: Boolean(wallets.okxConfigured),
      rebalance: { lastAt: this.store.getMeta('lastRebalanceAt') || null, triggerUsd: 5, targetShare: .6 }, serverTime: now() };
  }
  async saveConfig(input) {
    if (this.busy || this.refreshing || this.quoteBuilders || this.configuring) throw safeError('交易、报价或配置更新进行中，请稍候再保存配置');
    const config = validateConfig(input);
    if (this.config.inventory?.mappingConfirmed) {
      const identityChanged = this.config.inventory.assetId !== config.inventory.assetId || ['bnb','solana'].some(chain => ['tokenAddress','tokenDecimals','poolAddress'].some(key => {
        const previous = this.config.chains[chain][key], next = config.chains[chain][key];
        return chain === 'bnb' && typeof previous === 'string' && typeof next === 'string' ? previous.toLowerCase() !== next.toLowerCase() : previous !== next;
      }));
      if (identityChanged) { config.inventory.mappingConfirmed = false; config.inventory.mappingEvidence = ''; }
    }
    this.configuring = true; this.running = false;
    try {
      this.store.setConfig(config); this.config = config; this.configRevision++;
      this.plan = null; this.bridgeQuotes.clear();
      this.market = {}; this.balances = {}; this.opportunity = null;
      await this.makeAdapter(); await this.refresh({ allowConfiguring: true }); this.schedule();
    } finally { this.configuring = false; }
    return this.snapshot();
  }
  token(chain, kind = 'token') {
    const c = this.config.chains[chain];
    return { address: c[kind === 'stable' ? 'stableAddress' : 'tokenAddress'] || `demo-${chain}-${kind}`, decimals: c[kind === 'stable' ? 'stableDecimals' : 'tokenDecimals'], kind };
  }
  validateIntent(quote, expected, policy = createPolicySnapshot(this.config)) {
    return assertQuoteIntent(quote, expected, { policy, wallets: this.vault.publicStatus() });
  }
  walletChanged(chain) {
    this.running = false; this.configRevision++; this.plan = null; this.bridgeQuotes.clear();
    if (chain) delete this.balances[chain]; else this.balances = {};
    this.opportunity = { executable: false, amountUsd: this.config.risk.amountUsd, reasons: ['钱包状态已变化，等待余额与报价刷新'], quotedAt: now() };
  }
  async refresh({ autoExecute = true, allowConfiguring = false } = {}) {
    if (this.refreshing || this.busy || (this.configuring && !allowConfiguring)) return this.snapshot();
    const revision = this.configRevision;
    this.refreshing = true;
    try {
      await this.loadMarketBalances(revision);
      if (revision !== this.configRevision) return this.snapshot();
      await this.buildOpportunity();
    } finally {
      this.refreshing = false;
      if (revision !== this.configRevision) setImmediate(() => this.refresh({ autoExecute: false }).catch(error => { this.lastError = this.errorText(error); }));
    }
    if (revision !== this.configRevision) return this.snapshot();
    if (autoExecute && this.running && !this.busy && !this.pausedReason) {
      if (this.config.executionMode === 'inventory' && this.inventoryCoordinator?.active()) { await this.inventoryCoordinator.tick(); return this.snapshot(); }
      if (this.config.executionMode !== 'inventory' && this.config.rebalance.enabled) {
        const request = this.rebalanceRequest();
        if (request) { try { const q = await this.quoteBridge(request); if (q.executable) { void this.executeBridge({ quoteId: q.id }).catch(e => { this.lastError = this.errorText(e); }); return this.snapshot(); } } catch (e) { this.lastError = this.errorText(e); } }
      }
      if (this.opportunity?.executable) void this.execute().catch(e => { this.lastError = this.errorText(e); });
    }
    return this.snapshot();
  }
  async loadMarketBalances(revision = this.configRevision) {
    const results = await Promise.allSettled(['bnb', 'solana'].map(async chain => {
      const r = await Promise.allSettled([this.adapter.market(chain), this.adapter.balances(chain)]);
      if (revision !== this.configRevision) return;
      this.market[chain] = r[0].status === 'fulfilled' ? r[0].value : { ...this.market[chain], connected: false, error: this.errorText(r[0].reason) };
      this.balances[chain] = r[1].status === 'fulfilled' ? r[1].value : { error: this.errorText(r[1].reason), stableUsd: null, nativeBalance: null };
    }));
    for (const result of results) if (result.status === 'rejected') this.lastError = this.errorText(result.reason);
  }
  baseReasons({ ignoreBusy = false, bridge = false } = {}) {
    const c = this.config; const reasons = [];
    if (this.pausedReason) reasons.push(this.pausedReason);
    if (this.busy && !ignoreBusy) reasons.push('已有交易执行中');
    if (!bridge) {
      const stats = this.store.stats();
      if (stats.executions >= c.risk.maxExecutions) reasons.push('已达套利执行次数上限');
      if (stats.cumulativeUsd + c.risk.amountUsd > c.risk.maxCumulativeUsd + 1e-9) reasons.push('已达套利累计金额上限');
    }
    if (c.mode === 'live') {
      if (!bridge && c.executionMode === 'inventory' && (!c.inventory?.mappingConfirmed || !c.inventory?.assetId || !c.inventory?.mappingEvidence?.trim())) reasons.push('库存模式须确认1:1同币地址映射并填写核验依据');
      const wallets = this.vault.publicStatus();
      for (const chain of ['bnb', 'solana']) {
        const wallet = wallets[chain];
        if (!['private', 'browser'].includes(wallet?.mode) || !wallet?.unlocked || wallet.canSign === false) reasons.push(wallet?.mode === 'browser' ? `${chain} 插件钱包未连接，请保持页面打开并重新连接` : `${chain} 钱包未解锁或为只读`);
        if (!c.chains[chain].tokenAddress && !bridge) reasons.push(`${chain} 尚未配置代币地址`);
      }
      const state = this.vault.publicStatus();
      if (!state.okxConfigured || state.locked) reasons.push('OKX API 凭据未配置或保险库未解锁');
    }
    return reasons;
  }
  checkFees(quotes, { trade } = {}) {
    const c = this.config; const reasons = [];
    let bnb = 0, sol = 0;
    for (const leg of trade?.legs || []) {
      bnb += leg.receipt?.feesNative?.bnb || 0;
      sol += leg.receipt?.feesNative?.solana || 0;
    }
    let pendingBnb = 0, pendingSol = 0;
    for (const q of quotes) {
      if (!finite(q.feeUsd) || q.feeUsd < 0 || !finite(q.bnbGas) || q.bnbGas < 0 || !finite(q.solFee) || q.solFee < 0) { reasons.push('报价缺少可核验的费用估算'); continue; }
      bnb += q.bnbGas; sol += q.solFee; pendingBnb += q.bnbGas; pendingSol += q.solFee;
      if (!finite(q.priceImpactBps)) reasons.push('报价缺少价格冲击数据');
      else if (q.priceImpactBps < 0 || q.priceImpactBps > c.risk.maxPriceImpactBps) reasons.push('价格冲击超过限制');
      if (!quoteFresh(q)) reasons.push('报价已过期');
      const validMin = /^\d+$/.test(String(q.minOutRaw)) && new Decimal(q.minOutRaw).gt(0);
      const validOut = /^\d+$/.test(String(q.amountOutRaw)) && new Decimal(q.amountOutRaw).gt(0);
      if (!validMin) reasons.push('最小到账数量无效');
      if (!validOut || (validMin && new Decimal(q.amountOutRaw).lt(q.minOutRaw))) reasons.push('报价到账数量无效');
      if (validMin && validOut && new Decimal(q.minOutRaw).lt(new Decimal(q.amountOutRaw).mul(1 - c.risk.maxSlippageBps / 10000).floor())) reasons.push('报价滑点超过限制');
    }
    if (bnb > c.risk.maxBnbGas) reasons.push('BNB Gas 超过限制');
    if (sol > c.risk.maxSolFee) reasons.push('SOL 网络费超过限制');
    for (const chain of ['bnb', 'solana']) {
      const b = this.balances[chain]; const fees = chain === 'bnb' ? pendingBnb : pendingSol; const reserve = chain === 'bnb' ? c.risk.reserveBnb : c.risk.reserveSol;
      if (!finite(b?.nativeBalance)) reasons.push(`${chain} 原生币余额不可用`);
      else if (b.nativeBalance < fees + reserve) reasons.push(`${chain} 余额不足以支付费用并保留 Gas`);
    }
    return reasons;
  }
  availableInventory(chain, excludeTradeId) {
    const balance = this.balances[chain]?.tokenRaw;
    if (typeof balance !== 'string' || !/^\d+$/.test(balance) || balance.length > 78) throw safeError(`${chain} 代币库存余额不可核验`);
    const reserved = this.store.getReservedInventory({ mode: this.config.mode, chain, address: this.token(chain).address, excludeTradeId });
    if (typeof reserved !== 'string' || !/^\d+$/.test(reserved)) throw safeError('库存预占记录不可核验');
    return BigInt(balance) > BigInt(reserved) ? (BigInt(balance) - BigInt(reserved)).toString() : '0';
  }
  reserveInventory(trade, amountRaw) {
    positiveRaw(amountRaw, trade.sellChain, '预占库存数量');
    const availableRaw = this.balances[trade.sellChain]?.tokenRaw;
    if (typeof availableRaw !== 'string' || !/^\d+$/.test(availableRaw)) throw safeError('高价链代币库存余额不可核验');
    this.store.reserveInventory({ tradeId: trade.id, mode: trade.mode, chain: trade.sellChain, address: this.token(trade.sellChain).address, amountRaw, availableRaw });
    trade.inventoryReservation = { chain: trade.sellChain, address: this.token(trade.sellChain).address, amountRaw, checkedAt: now() };
    this.store.saveTrade(trade);
  }
  async buildOpportunity({ ignoreBusy = false } = {}) {
    this.plan = null; const c = this.config; const revision = this.configRevision;
    const prices = ['bnb', 'solana'].map(ch => this.market[ch]?.priceUsd);
    const reasons = this.baseReasons({ ignoreBusy });
    for (const chain of ['bnb', 'solana']) {
      const m = this.market[chain];
      if (!m?.connected || !finite(m.priceUsd) || m.priceUsd <= 0) reasons.push(`${chain} 行情不可用`);
      const timestamp = Date.parse(m?.updatedAt);
      if (!Number.isFinite(timestamp) || Date.now() - timestamp > c.risk.maxQuoteAgeMs || timestamp > Date.now() + 5000) reasons.push(`${chain} 行情已过期`);
    }
    if (reasons.some(r => /行情/.test(r))) { this.opportunity = { executable: false, amountUsd: c.risk.amountUsd, reasons, quotedAt: now() }; return; }
    const buyChain = prices[0] <= prices[1] ? 'bnb' : 'solana'; const sellChain = buyChain === 'bnb' ? 'solana' : 'bnb';
    const base = { buyChain, sellChain, amountUsd: c.risk.amountUsd, spreadBps: (this.market[sellChain].priceUsd / this.market[buyChain].priceUsd - 1) * 10000, quotedAt: now() };
    if (!finite(this.balances[buyChain]?.stableUsd) || this.balances[buyChain].stableUsd < c.risk.amountUsd) reasons.push('低价链可用稳定币不足');
    try {
      const buyIntent = swapIntent(buyChain, this.token(buyChain, 'stable'), this.token(buyChain), raw(c.risk.amountUsd, this.token(buyChain, 'stable').decimals));
      const buy = await this.adapter.quoteSwap({ chain: buyChain, fromToken: buyIntent.fromToken, toToken: buyIntent.toToken, amountRaw: buyIntent.amountInRaw });
      this.validateIntent(buy, buyIntent);
      let bridge, inventoryReserveRaw, sellAmountRaw;
      if (c.executionMode === 'inventory') {
        const expected = convertInventoryAmount(buy.amountOutRaw, this.token(buyChain).decimals, this.token(sellChain).decimals, sellChain);
        inventoryReserveRaw = expected.amountRaw;
        sellAmountRaw = convertInventoryAmount(buy.minOutRaw, this.token(buyChain).decimals, this.token(sellChain).decimals, sellChain).amountRaw;
        if (BigInt(this.availableInventory(sellChain)) < BigInt(inventoryReserveRaw)) reasons.push('高价链可用代币库存不足，禁止买入；两边只有稳定币不能执行库存套利');
      } else {
        const nextBridgeIntent = bridgeIntent(buyChain, sellChain, this.token(buyChain), this.token(sellChain), buy.minOutRaw);
        bridge = await this.adapter.quoteTokenBridge({ fromChain: buyChain, toChain: sellChain, fromToken: nextBridgeIntent.fromToken, toToken: nextBridgeIntent.toToken, amountRaw: nextBridgeIntent.amountInRaw });
        this.validateIntent(bridge, nextBridgeIntent);
        sellAmountRaw = bridge.minOutRaw;
      }
      const sellIntent = swapIntent(sellChain, this.token(sellChain), this.token(sellChain, 'stable'), sellAmountRaw);
      const sell = await this.adapter.quoteSwap({ chain: sellChain, fromToken: sellIntent.fromToken, toToken: sellIntent.toToken, amountRaw: sellIntent.amountInRaw });
      this.validateIntent(sell, sellIntent);
      if (revision !== this.configRevision) return;
      const quotes = bridge ? [buy, bridge, sell] : [buy, sell];
      const gasUsd = quotes.reduce((s, q) => s + q.feeUsd, 0);
      const conservativeProceeds = value(sell.minOutRaw, this.token(sellChain, 'stable').decimals);
      const expectedProceeds = value(sell.amountOutRaw, this.token(sellChain, 'stable').decimals);
      const netProfitUsd = conservativeProceeds - c.risk.amountUsd - gasUsd;
      reasons.push(...this.checkFees(quotes));
      if (!finite(netProfitUsd) || netProfitUsd < c.risk.minProfitUsd) reasons.push('预计净收益未达到利润门槛');
      const bridgeFeeUsd = bridge ? Math.max(0, value(bridge.amountInRaw, bridge.fromToken.decimals) * this.market[buyChain].priceUsd - value(bridge.amountOutRaw, bridge.toToken.decimals) * this.market[buyChain].priceUsd) : 0;
      if (c.executionMode === 'inventory' && c.mode === 'live' && quotes.some(q=>!finite(q.estimatedRentUsd)||q.estimatedRentUsd<0)) reasons.push('库存报价缺少可核验租金估算');
      this.opportunity = { ...base, executionMode: c.executionMode || 'bridge', assetId: c.inventory?.assetId || '', ...(inventoryReserveRaw ? { inventoryReserveRaw, inventoryAvailableRaw: this.availableInventory(sellChain), closedInventory: false } : {}), tokenAmount: value(buy.amountOutRaw, buy.toToken.decimals), grossProfitUsd: c.risk.amountUsd * base.spreadBps / 10000, netProfitUsd,
        slippageUsd: Math.max(0, expectedProceeds - conservativeProceeds), gasUsd, bridgeFeeUsd, priceImpactBps: Math.max(...quotes.map(q => q.priceImpactBps)),
        estimatedRentUsd: quotes.reduce((sum,q)=>sum+(q.estimatedRentUsd || 0),0), estimatedRentIncludedInFees: true,
        expiresAt: new Date(Math.min(...quotes.map(q => Date.parse(q.expiresAt)))).toISOString(), reasons: [...new Set(reasons)], executable: reasons.length === 0,
        valuation: 'USDT/USDC 按 1 美元面值估算；原生币费用按配置参考价折算' };
      this.plan = { buy, bridge, sell, inventoryReserveRaw, estimate: structuredClone(this.opportunity) };
    } catch (e) { if (revision === this.configRevision) this.opportunity = { ...base, reasons: [...new Set([...reasons, this.errorText(e)])], executable: false }; }
  }
  start() {
    if (this.configuring) throw safeError('配置更新进行中，请稍候');
    if (this.pausedReason) throw safeError('请先核对待处理交易并确认');
    this.running = true; void this.refresh().catch(e => { this.lastError = this.errorText(e); }); return this.snapshot();
  }
  pause(reason = '已手动暂停新交易；在途交易将继续完成并归档') { this.running = false; this.lastError = reason; return this.snapshot(); }
  event(trade, status, extra = {}) {
    Object.assign(trade, extra, { status, updatedAt: now() });
    this.store.saveTrade(trade); this.store.appendEvent(trade.id, { state: status, status, at: now(), ...(trade.policyFingerprint ? { policyFingerprint: trade.policyFingerprint } : {}), ...extra });
  }
  newTrade(type, data) {
    const trade = { id: randomUUID(), type, mode: this.config.mode, status: 'QUOTED', createdAt: now(), updatedAt: now(), legs: [], valuation: { bnbUsd: this.config.chains.bnb.nativeUsd, solUsd: this.config.chains.solana.nativeUsd, stableUsd: 1 }, ...data, ...policyRecord(this.config) };
    this.store.saveTrade(trade); this.event(trade, 'QUOTED', { estimate: data.estimate }); return trade;
  }
  async runLeg(trade, name, quote) {
    this.executionGuard?.();
    assertPolicyUnchanged(trade, this.config);
    const expected = intentForLeg(trade, name);
    this.validateIntent(quote, expected, trade.policySnapshot);
    for (const chain of ['bnb', 'solana']) this.balances[chain] = await this.adapter.balances(chain);
    const feeReasons = this.checkFees([quote], { trade }); if (feeReasons.length) throw safeError(feeReasons.join('；'));
    // Recheck after asynchronous balance reads, before any durable broadcast intent.
    assertPolicyUnchanged(trade, this.config);
    this.validateIntent(quote, expected, trade.policySnapshot);
    this.executionGuard?.();
    if (trade.executionMode === 'inventory' && ['BUY','SELL'].includes(name)) this.reserveInventory(trade, name === 'BUY' ? trade.estimate.inventoryReserveRaw : quote.amountInRaw);
    this.store.saveQuote({ ...quote, tradeId: trade.id, leg: name, capturedAt: now(), policyFingerprint: trade.policyFingerprint });
    // Durable intent is committed before any provider broadcast. Never automatically replay it.
    this.event(trade, `${name}_SUBMITTING`, { pendingQuoteId: quote.id });
    let submission;
    submission = await this.adapter.submit(quote, { onSubmitted: async sent => {
      const logged = { name, quoteId: quote.id, hash: sent.hash, submission: sent, status: 'SUBMITTED' };
      trade.legs.push(logged); this.event(trade, `${name}_SUBMITTED`, { legs: trade.legs });
    } });
    if (!trade.legs.some(l => l.hash === submission.hash)) { trade.legs.push({ name, quoteId: quote.id, hash: submission.hash, submission, status: 'SUBMITTED' }); this.event(trade, `${name}_SUBMITTED`, { legs: trade.legs }); }
    const receipt = await this.adapter.confirm(submission);
    const logged = trade.legs.find(l => l.hash === submission.hash);
    Object.assign(logged, { receipt, quote, status: 'RECEIPT_RECEIVED' });
    // Save even a reverted, partial, or inconsistent receipt before validating it.
    this.event(trade, `${name}_RECEIPT`, { legs: trade.legs });
    if (receipt.confirmed !== true || !/^\d+$/.test(String(receipt.receivedRaw)) || new Decimal(receipt.receivedRaw).lte(0)) throw safeError(`${name}尚未确认或实际到账数量不可核验`);
    if (receipt.hash !== submission.hash) throw safeError(`${name}回执交易哈希不匹配`);
    positiveRaw(receipt.receivedRaw, quote.toChain, '实际到账数量');
    positiveRaw(receipt.spentRaw, quote.fromChain, '实际花费数量');
    if (!/^\d+$/.test(String(receipt.spentRaw)) || !new Decimal(receipt.spentRaw).eq(quote.amountInRaw)) throw safeError(`${name}实际花费与报价数量不一致，请人工核对退款或部分成交`);
    if (!finite(receipt.feeUsd) || receipt.feeUsd < 0 || !finite(receipt.rentUsd) || receipt.rentUsd < 0 || !receipt.feesNative || typeof receipt.feesNative !== 'object' || Array.isArray(receipt.feesNative) || !finite(receipt.feesNative[quote.fromChain]) || Object.entries(receipt.feesNative).some(([chain, amount]) => !['bnb', 'solana'].includes(chain) || !finite(amount) || amount < 0)) throw safeError(`${name}回执费用或租金不可核验`);
    if (new Decimal(receipt.receivedRaw).lt(quote.minOutRaw)) throw safeError(`${name}实际到账低于最小到账数量，请人工核对`);
    Object.assign(logged, { status: 'CONFIRMED' });
    this.event(trade, `${name}_CONFIRMED`, { legs: trade.legs });
    assertPolicyUnchanged(trade, this.config);
    this.balances[quote.fromChain] = await this.adapter.balances(quote.fromChain);
    if (quote.toChain !== quote.fromChain) this.balances[quote.toChain] = await this.adapter.balances(quote.toChain);
    const actualFeeReasons = this.checkFees([], { trade });
    if (actualFeeReasons.length) throw safeError(actualFeeReasons.join('；'));
    return receipt;
  }
  async execute() {
    if (this.busy || this.refreshing || this.configuring) throw safeError('已有任务或配置更新执行中，请稍候');
    this.busy = true;
    let trade;
    try {
      this.executionGuard?.();
      // Claim the process-wide mutex before quote requests. Existing plan is not reused.
      await this.loadMarketBalances();
      await this.buildOpportunity({ ignoreBusy: true });
      if (!this.opportunity?.executable || !this.plan) throw safeError((this.opportunity?.reasons || ['暂无可执行报价']).join('；'));
      const plan = this.plan; const estimate = structuredClone(this.opportunity);
      trade = this.newTrade('arbitrage', { amountUsd: estimate.amountUsd, buyChain: estimate.buyChain, sellChain: estimate.sellChain, executionMode: this.config.executionMode || 'bridge', assetId: this.config.inventory?.assetId || '', estimate });
      this.activeTradeId = trade.id;
      const stats = this.store.stats();
      if (stats.executions >= this.config.risk.maxExecutions || stats.cumulativeUsd + estimate.amountUsd > this.config.risk.maxCumulativeUsd + 1e-9) throw safeError('套利执行额度不足');
      this.store.reserveExecution(trade.id, estimate.amountUsd);
      if (trade.executionMode === 'inventory') this.reserveInventory(trade, plan.inventoryReserveRaw);
      const bought = await this.runLeg(trade, 'BUY', plan.buy);
      // The next leg is constructed only from confirmed, attributed receipt amounts.
      let bridged, converted;
      if (trade.executionMode === 'inventory') converted = convertInventoryAmount(bought.receivedRaw, this.token(trade.buyChain).decimals, this.token(trade.sellChain).decimals, trade.sellChain);
      else {
        const bridge = await this.adapter.quoteTokenBridge({ fromChain: trade.buyChain, toChain: trade.sellChain, fromToken: this.token(trade.buyChain), toToken: this.token(trade.sellChain), amountRaw: bought.receivedRaw });
        bridged = await this.runLeg(trade, 'BRIDGE', bridge);
      }
      const sell = await this.adapter.quoteSwap({ chain: trade.sellChain, fromToken: this.token(trade.sellChain), toToken: this.token(trade.sellChain, 'stable'), amountRaw: converted?.amountRaw || bridged.receivedRaw });
      if (trade.executionMode === 'inventory') {
        const alreadySpent = value(bought.spentRaw,this.token(trade.buyChain,'stable').decimals);
        const settledFees = trade.legs.reduce((sum,leg)=>sum+leg.receipt.feeUsd+leg.receipt.rentUsd,0);
        const currentNet = value(sell.minOutRaw,this.token(trade.sellChain,'stable').decimals)-alreadySpent-settledFees-sell.feeUsd;
        this.store.saveQuote({ ...sell, tradeId: trade.id, leg: 'SELL_RECHECK', capturedAt: now(), policyFingerprint: trade.policyFingerprint });
        this.event(trade,'SELL_QUOTED',{ currentSellEstimatedProfitUsd: currentNet });
        if (!finite(currentNet) || currentNet < this.config.risk.minProfitUsd) throw safeError('买入已确认，但当前卖出报价未达到净利润门槛，已暂停等待人工核对库存');
      }
      // Changed quotes must still obey price impact and minimum output; a failure pauses exposure.
      const sold = await this.runLeg(trade, 'SELL', sell);
      this.event(trade, 'RECONCILING');
      const spentUsd = value(bought.spentRaw, this.token(trade.buyChain, 'stable').decimals);
      const receivedUsd = value(sold.receivedRaw, this.token(trade.sellChain, 'stable').decimals);
      const receipts = trade.legs.map(l => l.receipt);
      if (receipts.some(r => !finite(r.feeUsd) || !finite(r.rentUsd))) throw safeError('回执费用或租金不完整，无法完成利润复核');
      const gasUsd = receipts.reduce((s, r) => s + r.feeUsd, 0); const rentUsd = receipts.reduce((s, r) => s + r.rentUsd, 0);
      const profitUsd = receivedUsd - spentUsd - gasUsd - rentUsd;
      const actual = { spentUsd, receivedUsd, gasUsd, rentUsd, profitUsd, estimatedProfitUsd: estimate.netProfitUsd, differenceUsd: profitUsd - estimate.netProfitUsd,
        boughtRaw: bought.receivedRaw, ...(bridged ? { bridgedRaw: bridged.receivedRaw } : {}), soldRaw: sold.spentRaw,
        ...(converted ? { cashSpreadProfitUsd: profitUsd, closedInventory: false, inventoryDelta: { [trade.buyChain]: { address: this.token(trade.buyChain).address, decimals: this.token(trade.buyChain).decimals, tokenRaw: bought.receivedRaw }, [trade.sellChain]: { address: this.token(trade.sellChain).address, decimals: this.token(trade.sellChain).decimals, tokenRaw: `-${sold.spentRaw}` } }, dustBuyRaw: converted.dustBuyRaw, inventoryNotice: '两腿现金流价差；两链库存位置改变，未包含后续补库存成本' } : {}),
        slippageBps: trade.legs.map(l => ({ leg: l.name, bps: new Decimal(l.quote.amountOutRaw).minus(l.receipt.receivedRaw).div(l.quote.amountOutRaw).mul(10000).toNumber() })),
        feesNative: receipts.reduce((acc, r) => { for (const [chain, n] of Object.entries(r.feesNative || {})) acc[chain] = (acc[chain] || 0) + n; return acc; }, {}), valuation: '稳定币面值与报价时原生币参考汇率；原始链上费用保存在回执' };
      this.event(trade, 'COMPLETED', { actual });
      if (trade.executionMode === 'inventory') this.store.releaseInventory(trade.id);
      return this.store.getTrade(trade.id);
    } catch (e) {
      if (trade) this.fail(trade, e);
      throw e;
    } finally { this.busy = false; this.activeTradeId = null; this.plan = null; await this.refresh({ autoExecute: false }); }
  }
  fail(trade, e) {
    this.running = false; this.pausedReason = '单边失败或结果不确定，须人工核对';
    const evidence = {};
    // Only deliberately safe adapter errors may attach vetted chain evidence.
    // SDK exception objects can contain secrets and are never serialized.
    if (e?.safe) {
      for (const key of ['receipt', 'sourceReceipt', 'destinationReceipt']) if (e[key] && typeof e[key] === 'object') evidence[key] = e[key];
      for (const key of ['hash', 'sourceHash', 'destinationHash']) if (typeof e[key] === 'string' && /^[A-Za-z0-9-]{1,160}$/.test(e[key])) evidence[key] = e[key];
    }
    this.event(trade, 'NEEDS_REVIEW', { failureReason: this.errorText(e), ...(Object.keys(evidence).length ? { failureEvidence: evidence } : {}) });
  }
  acknowledge({ tradeId, note }) {
    if (this.busy) throw safeError('请等待在途任务结束');
    const trade = this.store.getTrade(tradeId);
    if (!trade || trade.status !== 'NEEDS_REVIEW') throw safeError('交易不处于待核对状态');
    if (typeof note !== 'string' || note.trim().length < 4) throw safeError('请填写核对说明（至少4个字符）');
    this.event(trade, 'REVIEWED', { reviewNote: note.trim(), reviewedAt: now() });
    if (trade.executionMode === 'inventory') this.store.releaseInventory(trade.id);
    this.pausedReason = this.store.allTrades().some(t => !terminal.has(t.status)) ? '仍有待核对交易' : '';
    return this.snapshot();
  }
  rebalanceRequest() {
    if (this.config.executionMode === 'inventory' || !this.config.rebalance.enabled || this.busy || this.pausedReason) return null;
    const b = this.balances.bnb?.stableUsd, s = this.balances.solana?.stableUsd;
    if (!finite(b) || !finite(s)) return null;
    if (b >= 5 && s >= 5) { this.store.setMeta('rebalanceArmed', true); return null; }
    if (this.store.getMeta('rebalanceArmed') === false) return null;
    const last = Date.parse(this.store.getMeta('lastRebalanceAt') || '1970-01-01');
    if (Date.now() - last < this.config.rebalance.cooldownMs) return null;
    const total = b + s; if (total < 12.5) return null; // A 40% donor must remain above the $5 trigger.
    const toChain = b < s ? 'bnb' : 'solana'; const fromChain = toChain === 'bnb' ? 'solana' : 'bnb';
    const low = Math.min(b, s); return { fromChain, toChain, amountUsd: total * .6 - low, purpose: 'rebalance' };
  }
  async quoteBridge({ fromChain, toChain, amountUsd, purpose = 'manual' }) {
    if (this.configuring) throw safeError('配置更新进行中，请稍候重新获取跨链报价');
    const revision = this.configRevision;
    this.quoteBuilders++;
    try {
    if (!['bnb', 'solana'].includes(fromChain) || !['bnb', 'solana'].includes(toChain) || fromChain === toChain) throw safeError('跨链方向无效');
    if (!['manual', 'rebalance'].includes(purpose)) throw safeError('跨链用途无效');
    if (!finite(Number(amountUsd)) || Number(amountUsd) <= 0) throw safeError('跨链金额必须大于0');
    amountUsd = Number(amountUsd);
    const reasons = this.baseReasons({ bridge: true });
    const fromToken = this.token(fromChain, 'stable'), toToken = this.token(toChain, 'stable');
    let quote = await this.adapter.quoteTokenBridge({ fromChain, toChain, fromToken, toToken, amountRaw: raw(amountUsd, fromToken.decimals) });
    this.validateIntent(quote, bridgeIntent(fromChain, toChain, fromToken, toToken, raw(amountUsd, fromToken.decimals)));
    let receivedUsd = value(quote.minOutRaw, toToken.decimals), wearUsd = Math.max(0, amountUsd - receivedUsd) + quote.feeUsd;
    if (purpose === 'rebalance') {
      const valid = this.rebalanceRequest();
      if (!valid || valid.fromChain !== fromChain) reasons.push('当前未满足自动再平衡条件');
      else {
        // Solve x = .6*total - low + .4*stableRouteLoss. Native fees do not
        // change stablecoin balances; conservative minOut still governs wear caps.
        for (let i = 0; i < 3; i++) {
          const total = this.balances.bnb.stableUsd + this.balances.solana.stableUsd;
          const expectedRouteLoss = amountUsd - value(quote.amountOutRaw, toToken.decimals);
          const targetAmount = total * .6 - this.balances[toChain].stableUsd + .4 * expectedRouteLoss;
          if (Math.abs(targetAmount - amountUsd) < .00001) break;
          amountUsd = targetAmount;
          quote = await this.adapter.quoteTokenBridge({ fromChain, toChain, fromToken, toToken, amountRaw: raw(amountUsd, fromToken.decimals) });
          this.validateIntent(quote, bridgeIntent(fromChain, toChain, fromToken, toToken, raw(amountUsd, fromToken.decimals)));
          receivedUsd = value(quote.minOutRaw, toToken.decimals); wearUsd = Math.max(0, amountUsd - receivedUsd) + quote.feeUsd;
        }
        if (this.balances[fromChain].stableUsd - amountUsd < 5) reasons.push('再平衡后资金来源侧将低于5U，已阻止反复跨链');
      }
    }
    const wearBps = wearUsd / amountUsd * 10000;
    reasons.push(...this.checkFees([quote]));
    if (!finite(this.balances[fromChain]?.stableUsd) || this.balances[fromChain].stableUsd < amountUsd) reasons.push('来源链可用稳定币不足');
    if (!finite(wearUsd) || wearUsd > this.config.rebalance.maxWearUsd) reasons.push('美元磨损超过限制');
    if (!finite(wearBps) || wearBps > this.config.rebalance.maxWearBps) reasons.push('磨损率超过限制');
    if (revision !== this.configRevision || this.configuring) throw safeError('配置已变化，请重新获取跨链报价');
    const netProfitUsd = new Decimal(receivedUsd).minus(amountUsd).minus(quote.feeUsd).toNumber();
    const result = { id: randomUUID(), configRevision: revision, policyFingerprint: policyFingerprint(createPolicySnapshot(this.config)), fromChain, toChain, amountUsd, purpose, receivedUsd, wearUsd, wearBps, netProfitUsd, gasUsd: quote.feeUsd, expiresAt: quote.expiresAt, reasons: [...new Set(reasons)], executable: reasons.length === 0, quote };
    this.bridgeQuotes.set(result.id, result); this.store.saveQuote({ ...result, kind: 'bridge-preview', capturedAt: now() });
    while (this.bridgeQuotes.size > 100) this.bridgeQuotes.delete(this.bridgeQuotes.keys().next().value);
    return result;
    } finally { this.quoteBuilders--; }
  }
  async executeBridge({ quoteId }) {
    if (this.busy || this.configuring) throw safeError('已有交易或配置更新执行中');
    const preview = this.bridgeQuotes.get(quoteId);
    if (!preview || !quoteFresh(preview)) throw safeError('跨链报价不存在或已过期，请重新报价');
    if (preview.configRevision !== this.configRevision) throw safeError('配置已变化，请重新获取跨链报价');
    if (preview.policyFingerprint !== policyFingerprint(createPolicySnapshot(this.config))) throw safeError('风控或资产配置已变化，请重新获取跨链报价');
    if (!preview.executable) throw safeError(preview.reasons.join('；'));
    const reasons = this.baseReasons({ bridge: true }); if (reasons.length) throw safeError(reasons.join('；'));
    if (preview.purpose === 'rebalance' && !this.rebalanceRequest()) throw safeError('再平衡条件已变化');
    this.busy = true; this.bridgeQuotes.delete(quoteId); let trade;
    try {
      this.balances[preview.fromChain] = await this.adapter.balances(preview.fromChain);
      const feeReasons = this.checkFees([preview.quote]);
      if (this.balances[preview.fromChain].stableUsd < preview.amountUsd) feeReasons.push('来源链稳定币余额不足');
      if (feeReasons.length) throw safeError(feeReasons.join('；'));
      trade = this.newTrade(preview.purpose, { amountUsd: preview.amountUsd, buyChain: preview.fromChain, sellChain: preview.toChain, estimate: preview });
      this.activeTradeId = trade.id;
      const received = await this.runLeg(trade, 'BRIDGE', preview.quote);
      if (!finite(received.feeUsd) || !finite(received.rentUsd)) throw safeError('跨链回执缺少费用或租金复核数据');
      const receivedUsd = value(received.receivedRaw, this.token(preview.toChain, 'stable').decimals);
      const spentUsd = value(received.spentRaw, this.token(preview.fromChain, 'stable').decimals);
      const actualWear = Math.max(0, spentUsd - receivedUsd) + received.feeUsd + received.rentUsd;
      const profitUsd = receivedUsd - spentUsd - received.feeUsd - received.rentUsd;
      const actual = { receivedUsd, spentUsd, gasUsd: received.feeUsd, rentUsd: received.rentUsd, wearUsd: actualWear, wearBps: actualWear / spentUsd * 10000,
        differenceUsd: new Decimal(profitUsd).minus(preview.netProfitUsd).toNumber(), wearDifferenceUsd: actualWear - preview.wearUsd, feesNative: received.feesNative, profitUsd };
      if (actualWear > this.config.rebalance.maxWearUsd || actual.wearBps > this.config.rebalance.maxWearBps) throw safeError('实际磨损超过限制，资金已到账，请核对交易');
      this.event(trade, 'COMPLETED', { actual });
      if (preview.purpose === 'rebalance') { this.store.setMeta('lastRebalanceAt', now()); this.store.setMeta('rebalanceArmed', false); }
      return this.store.getTrade(trade.id);
    } catch (e) { if (trade) this.fail(trade, e); throw e; }
    finally { this.busy = false; this.activeTradeId = null; await this.refresh({ autoExecute: false }); }
  }
}
