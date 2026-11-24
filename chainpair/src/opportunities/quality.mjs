import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { Engine } from '../engine.mjs';
import { LiveAdapter } from '../adapters/live.mjs';
import { validateConfig } from '../config.mjs';
import { createPolicySnapshot, policyFingerprint } from '../policy.mjs';
import { publicText, sameAddress, validAddress, validId } from './registry.mjs';

const META = 'opportunities.readonly-quality.v1';
const GAP_MS = 60000, FRESH_MS = 120000, MIN_REMAINING_MS = 3000;
const BUFFER = Object.freeze({ sellHaircutBps: 50, feeIncreaseBps: 2500 });
const clone = value => structuredClone(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const safe = message => Object.assign(new Error(message), { safe: true });
const refuse = () => { throw safe('只读报价复核禁止签名、提交、确认或修改交易记录'); };
const stamp = value => typeof value === 'number' ? value : Date.parse(value);

/** Real route quotations, kept apart from execution and all authorization caches. */
export class OpportunityQualityService {
  constructor({ engine, scanner, adapterFactory, now = Date.now } = {}) {
    if (!engine || !scanner) throw new Error('Readonly quality service requires engine and scanner');
    this.engine = engine; this.scanner = scanner; this.adapterFactory = adapterFactory; this.now = now;
    const state = engine.store.getMeta(META);
    this.enabled = state?.enabled === true;
    this.lastAttemptAt = Number.isSafeInteger(state?.lastAttemptAt) && state.lastAttemptAt >= 0 ? state.lastAttemptAt : null;
    this.reports = new Map(); this.walletBindings = new Map(); this.attempts = new Map(); this.busy = false; this.lastError = '';
    this.timer = null; this.started = false; this.pending = null;
  }
  persist() { this.engine.store.setMeta(META, { enabled: this.enabled, lastAttemptAt: this.lastAttemptAt }); }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw safe('真实只读报价自动复核开关无效');
    this.enabled = enabled; this.persist(); return this.snapshot();
  }
  start() {
    if (this.started) return this;
    this.started = true;
    const schedule = () => {
      if (!this.started) return;
      this.timer = setTimeout(async () => {
        try { await this.tick(); } catch { this.lastError = '自动只读报价复核未完成；请检查数据源、钱包公开地址及 API 配置'; }
        schedule();
      }, 5000);
      this.timer.unref?.();
    };
    schedule();
    return this;
  }
  stop() { this.started = false; clearTimeout(this.timer); this.timer = null; }
  parentFingerprint() { return policyFingerprint(createPolicySnapshot(this.engine.config)); }
  nextAttemptAt() { return this.lastAttemptAt === null ? this.now() : this.lastAttemptAt + GAP_MS; }
  available() {
    const e = this.engine;
    if (this.busy || e.busy || e.refreshing || e.configuring || e.quoteBuilders || this.scanner.busy || this.scanner.networkChanging || this.scanner.networkTesting) throw safe('已有交易、扫描、报价或配置任务进行中，请稍候');
    if (e.pausedReason || e.store.allTrades().some(trade => trade.status === 'NEEDS_REVIEW')) throw safe('存在待人工核对交易，请先核对交易档案');
    if (this.lastAttemptAt !== null && this.now() < this.nextAttemptAt()) throw safe(this.now() < this.lastAttemptAt ? '系统时钟回退，真实只读报价复核暂停' : '真实只读报价复核每60秒最多一次，失败也计入请求间隔');
  }
  candidateContext(id) {
    validId(id);
    if (this.scanner.busy || this.scanner.networkChanging || this.scanner.networkTesting || this.scanner.lastScanFailed) throw safe('真实行情扫描尚未完成或最新扫描失败，请等待成功扫描后复核');
    const asset = this.scanner.getApprovedAsset(id);
    this.scanner.assertComparisonUsable?.(id);
    const rows = this.scanner.snapshot().rows;
    const matching = Array.isArray(rows) ? rows.filter(row => row?.asset?.id === id) : [];
    const row = matching.length === 1 ? matching[0] : null;
    const at = this.now();
    if (!row || row.asset?.revision !== asset.revision || row.asset?.enabled === false || row.stage !== 'candidate' || row.marketQualified !== true || row.opportunityQualified !== true || row.universe?.eligible !== true || row.comparisonStatus !== 'comparable' || row.anomalous === true || typeof row.generation !== 'string' || !row.generation || row.generation.length > 80) throw safe('该条目尚无通过筛选的同轮双链行情，请先完成真实行情扫描与映射核验');
    const observed = stamp(row.observedAt);
    if (!Number.isSafeInteger(observed) || observed < at - FRESH_MS || observed > at + 1000) throw safe('参考行情已过期，请重新扫描后复核');
    for (const chain of ['bnb', 'solana']) {
      const market = row.market?.[chain], observedAt = stamp(market?.observedAt);
      if (!finite(market?.priceUsd) || market.priceUsd <= 0 || !Number.isSafeInteger(observedAt) || observedAt < at - FRESH_MS || observedAt > at + 1000 || market.priceConflict === true || ['none', 'conflicting-pools'].includes(market.priceConfidence) || !sameAddress(chain, market.poolAddress, asset.chains[chain].poolAddress)) throw safe('双链行情缺失、过期、池价格冲突或不符合已核验池，请重新扫描后复核');
    }
    const skew = Math.abs(stamp(row.market.bnb.observedAt) - stamp(row.market.solana.observedAt));
    const maxSkew = this.scanner.settings?.maxSideSkewMs ?? 30000;
    if (!finite(maxSkew) || skew > maxSkew) throw safe('双链行情采集时间相差过大，请重新扫描后复核');
    const referenceMarkets = Object.fromEntries(['bnb', 'solana'].map(chain => [chain, {
      poolAddress: validAddress(chain, row.market[chain].poolAddress), observedAt: stamp(row.market[chain].observedAt), priceUsd: row.market[chain].priceUsd,
    }]));
    return { asset, referenceGeneration: publicText(row.generation, 80), referenceObservedAt: observed, referenceMarkets };
  }
  candidate(id) { return this.candidateContext(id).asset; }
  referenceIdentity(value) { return JSON.stringify([value.referenceGeneration, value.referenceObservedAt, value.referenceMarkets]); }
  walletFingerprint() {
    const state = this.engine.vault.publicStatus();
    const addresses = ['bnb', 'solana'].map(chain => { const address = validAddress(chain, state?.[chain]?.address); return chain === 'bnb' ? address.toLowerCase() : address; });
    return createHash('sha256').update(JSON.stringify(addresses)).digest('hex');
  }
  prerequisites() {
    const wallets = this.engine.vault.publicStatus(), reasons = [];
    for (const chain of ['bnb', 'solana']) {
      try { validAddress(chain, wallets?.[chain]?.address); }
      catch { reasons.push(`${chain} 须配置钱包公开地址；只读复核不需要私钥`); }
    }
    if (!wallets?.okxConfigured || wallets.locked) reasons.push('真实只读报价须配置并解锁 OKX API 凭据');
    return reasons;
  }
  context(asset) {
    const config = clone(this.engine.config);
    config.mode = 'live'; config.executionMode = 'inventory';
    config.inventory = { assetId: asset.id, mappingConfirmed: true, mappingEvidence: asset.mappingEvidence, scanApprovedAssets: false };
    for (const chain of ['bnb', 'solana']) config.chains[chain] = { ...config.chains[chain], tokenAddress: asset.chains[chain].address, tokenDecimals: asset.chains[chain].decimals, poolAddress: asset.chains[chain].poolAddress };
    return validateConfig(config);
  }
  text(value) {
    let out = typeof value === 'string' ? value : '';
    try { if (this.engine.vault.redact) out = this.engine.vault.redact(out); } catch { return '报价复核未完成，请检查本机配置'; }
    return String(out).replace(/https?:\/\/[^\s]+/gi, '[远程服务]').replace(/\b(private[_ -]?key|secret[_ -]?key|passphrase|password|api[_ -]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[已隐藏]').replace(/0x[0-9a-f]{64}\b/gi, '[已隐藏]').replace(/[1-9A-HJ-NP-Za-km-z]{64,}/g, '[已隐藏]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
  }
  storeFacade() {
    const store = this.engine.store;
    return Object.freeze({
      get config() { return clone(store.config); },
      stats: () => clone(store.stats('live')), allTrades: () => clone(store.allTrades()),
      getReservedInventory: input => store.getReservedInventory(input),
      // A worker must have no way to turn a quote into a persisted intent.
      saveTrade: refuse, updateTrade: refuse, appendEvent: refuse, saveQuote: refuse,
      reserveExecution: refuse, reserveInventory: refuse, setMeta: refuse, setConfig: refuse,
    });
  }
  vaultFacade() {
    const vault = this.engine.vault;
    return Object.freeze({ publicStatus: () => clone(vault.publicStatus()), getOkxCredentials: () => vault.getOkxCredentials(), redact: text => this.text(text), signer: refuse, getPrivateKey: refuse });
  }
  adapter(args) {
    const adapter = this.adapterFactory ? this.adapterFactory(args) : new LiveAdapter(args);
    return Promise.resolve(adapter).then(instance => Object.freeze({
      market: (...input) => instance.market(...input), balances: (...input) => instance.balances(...input), quoteSwap: (...input) => instance.quoteSwap(...input),
      quoteTokenBridge: refuse, submit: refuse, confirm: refuse,
    }));
  }
  remember(report, walletBinding = null) {
    this.reports.delete(report.assetId); this.reports.set(report.assetId, clone(report));
    this.walletBindings.set(report.assetId, walletBinding);
    if (this.reports.size > 100) { const first = this.reports.keys().next().value; this.reports.delete(first); this.walletBindings.delete(first); }
    return clone(report);
  }
  invalidate() {
    const fingerprint = this.parentFingerprint(), at = this.now();
    for (const [id, report] of this.reports) {
      if (report.status === 'stale') continue;
      let stale = report.parentRevision !== this.engine.configRevision || report.parentPolicyFingerprint !== fingerprint || !Number.isFinite(stamp(report.expiresAt)) || stamp(report.expiresAt) <= at;
      try {
        const current = this.candidateContext(id);
        stale ||= current.asset.revision !== report.assetRevision || this.referenceIdentity(current) !== this.referenceIdentity(report) || this.prerequisites().length > 0 || this.walletFingerprint() !== this.walletBindings.get(id);
      } catch { stale = true; }
      if (stale) this.reports.set(id, { ...report, qualityPassed: false, status: 'stale', reasons: [...new Set([...report.reasons, '该复核已过期，或参数、映射、参考行情已变化；须重新复核'])] });
    }
  }
  snapshot() {
    this.invalidate();
    return { enabled: this.enabled, busy: this.busy, lastError: this.lastError, lastAttemptAt: this.lastAttemptAt, nextAttemptAt: this.nextAttemptAt(), budgetIntervalMs: GAP_MS, buffer: clone(BUFFER),
      reports: [...this.reports.values()].reverse().map(clone), readOnly: true, executable: false, simulationVerified: false,
      notice: '真实只读报价复核不签名、不下单，未执行成交模拟；通过压力检查不代表未来成功概率。USDT/USDC 按1美元、原生币费用按配置参考价估值，库存尚未计入未来补库成本。' };
  }
  async verify(id) {
    this.available();
    const observation = this.candidateContext(id), asset = observation.asset, parent = this.engine;
    const config = this.context(asset), revision = parent.configRevision, fingerprint = this.parentFingerprint();
    const identity = JSON.stringify(asset), referenceIdentity = this.referenceIdentity(observation), parentMode = parent.config.mode;
    let walletBinding = null;
    try { if (!this.prerequisites().length) walletBinding = this.walletFingerprint(); } catch { /* Prerequisite failures become blocked reports below. */ }
    const at = this.now();
    this.lastAttemptAt = at; this.attempts.set(id, at); this.persist();
    this.busy = true; parent.busy = true; this.lastError = '';
    const guard = () => {
      const current = this.candidateContext(id);
      if (parent.configRevision !== revision || this.parentFingerprint() !== fingerprint || parent.pausedReason || parent.store.allTrades().some(trade => trade.status === 'NEEDS_REVIEW') || JSON.stringify(current.asset) !== identity || this.referenceIdentity(current) !== referenceIdentity || this.prerequisites().length > 0 || this.walletFingerprint() !== walletBinding) throw safe('钱包、参数、映射、交易待核对状态或参考行情已变化，真实只读报价复核已失效');
    };
    const base = { assetId: id, assetRevision: asset.revision, symbol: publicText(this.text(asset.symbol), 32), name: publicText(this.text(asset.name), 100), parentRevision: revision, parentPolicyFingerprint: fingerprint, parentMode, mode: 'live', executionMode: 'inventory',
      referenceGeneration: observation.referenceGeneration, referenceObservedAt: observation.referenceObservedAt, referenceMarkets: clone(observation.referenceMarkets),
      readOnly: true, executable: false, simulationVerified: false, closedInventory: false, includesRestockingCosts: false,
      qualityPassed: false, status: 'blocked', quotedAt: new Date(at).toISOString(), expiresAt: new Date(at).toISOString(), amountUsd: config.risk.amountUsd,
      buffer: clone(BUFFER), valuation: '稳定币按1美元面值；原生币费用按配置参考价折算，不含未来补库成本' };
    const run = async () => {
      let worker;
      try {
        const missing = this.prerequisites();
        if (missing.length) return this.remember({ ...base, reasons: missing }, walletBinding);
        guard();
        worker = new Engine({ store: this.storeFacade(), vault: this.vaultFacade(), verificationOnly: true, browserWallets: Object.freeze({ request: refuse }), adapterFactory: args => this.adapter(args), marketFetchImpl: parent.marketFetchImpl });
        worker.config = config; worker.executionGuard = guard;
        await worker.makeAdapter(); await worker.loadMarketBalances(); guard(); await worker.buildOpportunity(); guard();
        const quote = worker.opportunity || {}, reasons = Array.isArray(quote.reasons) ? quote.reasons.map(reason => this.text(reason)).filter(Boolean) : ['未取得完整双腿报价'];
        const fields = {};
        for (const key of ['amountUsd', 'netProfitUsd', 'gasUsd', 'slippageUsd', 'priceImpactBps', 'estimatedRentUsd', 'spreadBps']) if (finite(quote[key])) fields[key] = quote[key];
        for (const key of ['buyChain', 'sellChain']) if (['bnb', 'solana'].includes(quote[key])) fields[key] = quote[key];
        const expiresAt = stamp(quote.expiresAt);
        let stressNetProfitUsd = null;
        if (finite(quote.netProfitUsd) && finite(quote.gasUsd) && quote.gasUsd >= 0 && finite(quote.amountUsd)) {
          const proceeds = new Decimal(quote.netProfitUsd).add(quote.amountUsd).add(quote.gasUsd);
          stressNetProfitUsd = proceeds.mul(1 - BUFFER.sellHaircutBps / 10000).minus(quote.amountUsd).minus(new Decimal(quote.gasUsd).mul(1 + BUFFER.feeIncreaseBps / 10000)).toNumber();
          if (!finite(stressNetProfitUsd) || stressNetProfitUsd < config.risk.minProfitUsd) reasons.push('压力复核未达利润门槛：额外卖出回落0.5%并计入费用上涨25%');
        } else reasons.push('缺少完整净收益或费用数据，不能完成压力复核');
        if (!Number.isFinite(expiresAt) || expiresAt - this.now() < MIN_REMAINING_MS) reasons.push('双腿报价剩余有效期不足3秒，须重新取得报价');
        if (quote.qualityPassed !== true) reasons.push('双边真实报价、库存或风控检查尚未全部通过');
        const unique = [...new Set(reasons)];
        return this.remember({ ...base, ...fields, stressNetProfitUsd: finite(stressNetProfitUsd) ? stressNetProfitUsd : null,
          quotedAt: typeof quote.quotedAt === 'string' && Number.isFinite(stamp(quote.quotedAt)) ? quote.quotedAt : base.quotedAt,
          expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : base.expiresAt,
          qualityPassed: unique.length === 0, status: unique.length === 0 ? 'passed' : 'blocked', reasons: unique }, walletBinding);
      } catch {
        // Raw adapter errors may contain user RPC URLs or API credentials.
        this.lastError = '真实只读报价复核未完成；请检查行情连接、公开地址、余额与 OKX API 配置';
        return this.remember({ ...base, reasons: [this.lastError] }, walletBinding);
      } finally {
        worker?.stop(); this.busy = false; parent.busy = false;
      }
    };
    const pending = run(); this.pending = pending;
    try { return await pending; } finally { if (this.pending === pending) this.pending = null; }
  }
  async tick() {
    if (!this.enabled || this.now() < this.nextAttemptAt()) return this.snapshot();
    try { this.available(); } catch { return this.snapshot(); }
    if (!this.scanner.enabled) return this.snapshot();
    const candidates = this.scanner.executionCandidates().filter(row => row?.stage === 'candidate').sort((a, b) => (this.attempts.get(a.asset.id) ?? -1) - (this.attempts.get(b.asset.id) ?? -1));
    if (!candidates.length) return this.snapshot();
    try { await this.verify(candidates[0].asset.id); } catch { /* A changing candidate is checked again on the next scheduler tick. */ }
    return this.snapshot();
  }
}
