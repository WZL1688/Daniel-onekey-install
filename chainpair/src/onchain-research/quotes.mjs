import { randomUUID } from 'node:crypto';
import { Interface } from 'ethers';
import Decimal from 'decimal.js';
import { LiveAdapter } from '../adapters/live.mjs';
import { validateConfig } from '../config.mjs';
import { assertQuoteIntent, convertInventoryAmount, createPolicySnapshot, policyFingerprint, positiveRaw, swapIntent } from '../policy.mjs';
import { publicText, sameAddress, validAddress, validId } from '../opportunities/registry.mjs';
import { sharedOkxReadGate } from '../provider-budget.mjs';

export const RESEARCH_AMOUNTS = Object.freeze([1, 2, 5, 10, 20, 50]);
const CHAINS = ['bnb', 'solana'], CLASSIC_SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ERC20 = new Interface(['function decimals() view returns(uint8)']);
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_estimateGas', 'eth_gasPrice', 'eth_getCode', 'eth_getBlockByNumber', 'getGenesisHash', 'getSlot', 'getBalance', 'getAccountInfo', 'getTokenAccountsByOwner', 'getFeeForMessage', 'getMinimumBalanceForRentExemption']);
const FRESH_MS = 120000, MIN_REMAINING_MS = 3000;
const clone = value => structuredClone(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
const fail = message => Object.assign(new Error(message), { safe: true });
const refuse = () => { throw fail('链上研究只读，禁止签名、授权、广播或写入交易'); };
const units = (amount, decimals) => new Decimal(amount).div(new Decimal(10).pow(decimals));
const raw = (amount, decimals) => new Decimal(amount).mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
const confirmed = asset => {
  const evidence = asset?.mappingEvidence || asset?.mapping?.evidence || asset?.evidence;
  return (asset?.mapping?.confirmed === true || asset?.confirmed === true || asset?.mappingConfirmed === true) && typeof evidence === 'string' && Boolean(evidence.trim()) && !asset.mapping?.warning && !asset.mappingWarning;
};

/** Exact-amount AMM route quotations. No quote is an execution authorization. */
export class OnchainQuoteClient {
  constructor({ engine, adapterFactory, now = Date.now, fetchImpl = globalThis.fetch, rateGate = sharedOkxReadGate } = {}) {
    if (!engine) throw new Error('Onchain quote client requires an engine');
    this.engine = engine; this.adapterFactory = adapterFactory; this.now = now; this.fetchImpl = fetchImpl; this.rateGate = rateGate;
  }
  text(error) {
    if (!error?.safe || typeof error.message !== 'string') return '真实链上报价未完成，请核对行情、RPC、公开地址、API权限及路线';
    let message = error.message;
    try { if (this.engine.vault.redact) message = this.engine.vault.redact(message); } catch { return '真实链上报价未完成，请核对本机配置'; }
    return String(message).replace(/https?:\/\/[^\s]+/gi, '[远程服务]')
      .replace(/\b(private[_ -]?key|secret[_ -]?key|passphrase|password|api[_ -]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[已隐藏]')
      .replace(/0x[0-9a-f]{64}\b/gi, '[已隐藏]').replace(/[1-9A-HJ-NP-Za-km-z]{64,}/g, '[已隐藏]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
  }
  abort(signal) { if (signal?.aborted) throw fail('研究报价已取消，未发送交易'); }
  fingerprint() { return policyFingerprint(createPolicySnapshot(this.engine.config)); }
  wallets() {
    const status = this.engine.vault.publicStatus();
    return { locked: status?.locked !== false, okxConfigured: status?.okxConfigured === true,
      ...Object.fromEntries(CHAINS.map(chain => [chain, { address: validAddress(chain, status?.[chain]?.address) }])) };
  }
  binding() { return { parentRevision: this.engine.configRevision, parentPolicyFingerprint: this.fingerprint(), wallets: JSON.stringify(this.wallets()) }; }
  guard(binding, signal) {
    this.abort(signal);
    if (binding.parentRevision !== this.engine.configRevision || binding.parentPolicyFingerprint !== this.fingerprint() || binding.wallets !== JSON.stringify(this.wallets())) throw fail('钱包或风控参数已变化，请重新取得研究报价');
    if (this.engine.pausedReason) throw fail('存在待人工核对状态，研究报价暂停');
  }
  reference(asset, row) {
    validId(asset?.id);
    if (!Number.isSafeInteger(asset.revision) || asset.revision < 1 || asset.enabled === false || !row || row.asset?.id !== asset.id || row.asset?.revision !== asset.revision || row.asset?.enabled === false) throw fail('研究资产或版本与当前扫描条目不一致');
    if (row.marketQualified !== true || row.universe?.eligible !== true || row.comparisonStatus !== 'comparable' || row.anomalous === true || typeof row.generation !== 'string' || !row.generation || row.generation.length > 80 || asset.mapping?.warning || asset.mappingWarning) throw fail('两链参考行情或资产身份存在异常，须先重新扫描核对');
    const now = this.now(), observed = stamp(row.observedAt), times = [];
    if (!Number.isSafeInteger(observed) || observed < now - FRESH_MS || observed > now + 1000) throw fail('参考扫描已过期，请重新扫描');
    for (const chain of CHAINS) {
      const market = row.market?.[chain], at = stamp(market?.observedAt);
      validAddress(chain, asset.chains?.[chain]?.address);
      if (!sameAddress(chain, asset.chains?.[chain]?.address, row.asset.chains?.[chain]?.address) || !finite(market?.priceUsd) || market.priceUsd <= 0 || !Number.isSafeInteger(at) || at < now - FRESH_MS || at > now + 1000 || market.priceConflict === true || !['single-pool', 'pool-consensus'].includes(market.priceConfidence)) throw fail('参考池与准确代币不匹配、陈旧或价格冲突');
      validAddress(chain, market.poolAddress);
      if (market.tokenAddress !== undefined && !sameAddress(chain, market.tokenAddress, asset.chains[chain].address)) throw fail('参考池代币地址与研究资产不一致');
      if (confirmed(asset) && !sameAddress(chain, market.poolAddress, asset.chains[chain].poolAddress)) throw fail('已核验固定池与本轮扫描池不一致');
      times.push(at);
    }
    if (Math.abs(times[0] - times[1]) > 30000) throw fail('双侧参考行情采样相差超过30秒');
  }
  fetch(config, signal) {
    const rpcUrls = new Set(CHAINS.flatMap(chain => config.chains[chain].rpcs));
    return async (input, options = {}) => {
      this.abort(signal);
      if (typeof input !== 'string') throw fail('研究报价不接受任意网络请求');
      let url; try { url = new URL(input); } catch { throw fail('研究报价网络目标无效'); }
      if (url.username || url.password || url.hash) throw fail('研究报价网络地址不得包含登录资料或片段');
      const method = String(options.method || 'GET').toUpperCase(), okx = url.protocol === 'https:' && url.hostname === 'web3.okx.com' && (!url.port || url.port === '443');
      if (okx) {
        if (method !== 'GET' || !['/api/v6/dex/aggregator/swap', '/api/v6/dex/aggregator/approve-transaction'].includes(url.pathname)) throw fail('研究报价禁止授权发送、划转或私有交易接口');
        await this.rateGate.acquire({ signal });
      } else {
        let body; try { body = typeof options.body === 'string' ? JSON.parse(options.body) : null; } catch {}
        if (!rpcUrls.has(input) || method !== 'POST' || !body || Array.isArray(body) || !READ_METHODS.has(body.method)) throw fail('研究RPC只允许已配置端点的只读请求');
      }
      const requestSignal = signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal || options.signal;
      const response = await this.fetchImpl(input, { ...options, signal: requestSignal, redirect: 'error' });
      if (okx) this.rateGate.observe(response);
      return response;
    };
  }
  async metadata(adapter, chain, address, proposed, signal) {
    this.abort(signal); let decimals = proposed, source = 'configured-chain-validated';
    if (decimals === null || decimals === undefined || decimals === '') {
      source = 'chain-metadata';
      if (!adapter.rpc?.[chain]?.call) throw fail(`${chain} 缺少链上精度读取能力`);
      if (chain === 'bnb') {
        const encoded = await adapter.rpc.bnb.call('eth_call', [{ to: address, data: ERC20.encodeFunctionData('decimals') }, 'latest']);
        try { decimals = Number(ERC20.decodeFunctionResult('decimals', encoded)[0]); } catch { throw fail('BNB 链上代币精度响应无效'); }
      } else {
        const account = (await adapter.rpc.solana.call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]))?.value;
        if (!account || account.owner !== CLASSIC_SPL || !Array.isArray(account.data) || account.data[1] !== 'base64' || typeof account.data[0] !== 'string') throw fail('Solana mint 元数据缺失或不是经典 SPL Token');
        const bytes = Buffer.from(account.data[0], 'base64');
        if (bytes.length !== 82 || bytes.toString('base64') !== account.data[0] || bytes[45] !== 1) throw fail('Solana mint 长度或初始化状态无效');
        decimals = bytes[44];
      }
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > (chain === 'solana' ? 9 : 36)) throw fail(`${chain} 代币精度超出当前支持范围`);
    if (typeof adapter.validateToken !== 'function') throw fail('研究适配器缺少真实代币精度验证');
    await adapter.validateToken(chain, { address, decimals }); this.abort(signal);
    return { decimals, source };
  }
  async context(asset, row, signal) {
    this.reference(asset, row); const binding = this.binding(), status = this.wallets();
    if (!status.okxConfigured || status.locked) throw fail('研究真实报价需要在本机配置并解锁 OKX API 凭据');
    const config = validateConfig(clone(this.engine.config)); config.mode = 'live'; config.executionMode = 'inventory';
    config.inventory = { assetId: asset.id, mappingConfirmed: confirmed(asset), mappingEvidence: publicText(asset.mappingEvidence || asset.mapping?.evidence || asset.evidence, 1000), scanApprovedAssets: false };
    for (const chain of CHAINS) {
      config.chains[chain].tokenAddress = validAddress(chain, asset.chains[chain].address);
      config.chains[chain].poolAddress = validAddress(chain, confirmed(asset) ? asset.chains[chain].poolAddress : row.market[chain].poolAddress);
    }
    const vault = Object.freeze({ publicStatus: () => clone(this.engine.vault.publicStatus()), getOkxCredentials: () => this.engine.vault.getOkxCredentials(), redact: text => this.text(Object.assign(new Error(text), { safe: true })), signer: refuse, getPrivateKey: refuse });
    const store = Object.freeze({ get config() { return clone(config); }, stats: () => clone(this.engine.store.stats('live')), allTrades: () => clone(this.engine.store.allTrades()), getReservedInventory: input => this.engine.store.getReservedInventory(input), saveTrade: refuse, saveQuote: refuse, appendEvent: refuse, setMeta: refuse, setConfig: refuse, reserveExecution: refuse, reserveInventory: refuse });
    const args = { getConfig: () => config, vault, store, browserWallets: Object.freeze({ request: refuse }), fetchImpl: this.fetch(config, signal), marketFetchImpl: this.engine.marketFetchImpl };
    const instance = await (this.adapterFactory ? this.adapterFactory(args) : new LiveAdapter(args));
    const metadata = {};
    const results = await Promise.allSettled(CHAINS.map(async chain => {
      metadata[chain] = await this.metadata(instance, chain, config.chains[chain].tokenAddress, asset.chains[chain].decimals, signal);
      config.chains[chain].tokenDecimals = metadata[chain].decimals;
      await this.metadata(instance, chain, config.chains[chain].stableAddress, config.chains[chain].stableDecimals, signal);
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    this.guard(binding, signal); this.reference(asset, row);
    return { config, binding, adapter: Object.freeze({ quoteSwap: input => instance.quoteSwap({ ...input, allowUnapproved: true }), submit: refuse, confirm: refuse }), metadata, policy: createPolicySnapshot(config), wallets: this.engine.vault.publicStatus() };
  }
  token(config, chain, kind) { const c = config.chains[chain]; return { address: c[kind === 'stable' ? 'stableAddress' : 'tokenAddress'], decimals: c[kind === 'stable' ? 'stableDecimals' : 'tokenDecimals'], kind }; }
  validate(quote, expected, context) {
    assertQuoteIntent(quote, expected, { policy: context.policy, wallets: context.wallets, nowMs: this.now() });
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(quote.id)) throw fail('研究报价标识格式无效');
    const start = stamp(quote.requestedAt), now = this.now();
    if (!Number.isFinite(start) || start > now + 1000 || start < now - context.config.quoteTtlMs || stamp(quote.expiresAt) > start + context.config.quoteTtlMs + 1) throw fail('报价缺少真实请求起算时间或有效期异常');
    if (!finite(quote.estimatedRentUsd) || quote.estimatedRentUsd < 0) throw fail('研究报价缺少完整租金费用估算');
    const minAllowed = new Decimal(quote.amountOutRaw).mul(1 - context.config.risk.maxSlippageBps / 10000).floor();
    if (new Decimal(quote.minOutRaw).lt(minAllowed)) throw fail('研究报价最低到账滑点超过现有风控');
    if (quote.priceImpactBps > context.config.risk.maxPriceImpactBps) throw fail('研究报价价格冲击超过现有风控');
    const fee = new Decimal(quote.bnbGas).mul(context.config.chains.bnb.nativeUsd).add(new Decimal(quote.solFee).mul(context.config.chains.solana.nativeUsd));
    if (fee.minus(quote.feeUsd).abs().gt(Decimal.max('0.00000001', fee.abs().mul('0.000001'))) || quote.estimatedRentUsd > quote.feeUsd + 1e-8) throw fail('研究报价费用与原生币参考估值不一致');
  }
  publicQuote(quote) {
    return { readOnly: true, executable: false, verified: true, chain: quote.fromChain, quoteId: quote.id, amountInRaw: quote.amountInRaw, inputRaw: quote.amountInRaw,
      amountOutRaw: quote.amountOutRaw, minOutRaw: quote.minOutRaw, fromToken: { address: quote.fromToken.address, decimals: quote.fromToken.decimals, kind: quote.fromToken.kind }, toToken: { address: quote.toToken.address, decimals: quote.toToken.decimals, kind: quote.toToken.kind },
      fromDecimals: quote.fromToken.decimals, toDecimals: quote.toToken.decimals, feeUsd: quote.feeUsd, gasUsd: quote.feeUsd, estimatedRentUsd: quote.estimatedRentUsd, rentUsd: quote.estimatedRentUsd,
      estimatedRentIncludedInFees: true, bnbGas: quote.bnbGas, solFee: quote.solFee, priceImpactBps: quote.priceImpactBps, quotedAt: quote.requestedAt, expiresAt: quote.expiresAt };
  }
  base(asset, row, amountUsd, buyChain, kind = 'plan') {
    return { id: randomUUID(), kind, mode: 'research', executionMode: 'inventory', readOnly: true, executable: false, executionReady: false, simulationVerified: false, closedInventory: false, includesActualRestockingCosts: false,
      assetId: typeof asset?.id === 'string' ? publicText(asset.id, 160) : '', assetRevision: Number.isSafeInteger(asset?.revision) ? asset.revision : null, generation: publicText(row?.generation, 80),
      symbol: publicText(asset?.symbol, 32), name: publicText(asset?.name, 100), amountUsd: RESEARCH_AMOUNTS.includes(amountUsd) ? amountUsd : null,
      buyChain: CHAINS.includes(buyChain) ? buyChain : null, sellChain: CHAINS.includes(buyChain) ? (buyChain === 'bnb' ? 'solana' : 'bnb') : null,
      identityVerified: confirmed(asset), qualityPassed: false, verified: false, parentRevision: this.engine.configRevision, parentPolicyFingerprint: this.fingerprint(),
      quotedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now()).toISOString(), reasons: [],
      valuation: '稳定币按1美元面值、原生币费用按配置参考价估值；不是已验证的实时美元利润',
      limitations: ['只读聚合报价，未执行成交模拟、签名或广播；报价通过不保证成交或盈利', '库存未来补库成本未知，未包含实际后续补库损失', '来源缺少风险字段时保持未知，不认证代币安全'] };
  }
  async quote({ asset, row, amountUsd, buyChain, signal, inventoryAdjustmentCostUsd = 0 } = {}) {
    const report = this.base(asset, row, amountUsd, buyChain);
    try {
      if (!RESEARCH_AMOUNTS.includes(amountUsd) || !CHAINS.includes(buyChain)) throw fail('研究金额仅支持1／2／5／10／20／50U，方向须为BNB或Solana买入');
      if (!finite(inventoryAdjustmentCostUsd) || inventoryAdjustmentCostUsd < 0 || inventoryAdjustmentCostUsd > 10000) throw fail('库存调整成本预留无效');
      const context = await this.context(asset, row, signal), { config, adapter } = context, sellChain = buyChain === 'bnb' ? 'solana' : 'bnb';
      const buyIntent = swapIntent(buyChain, this.token(config, buyChain, 'stable'), this.token(config, buyChain, 'token'), raw(amountUsd, config.chains[buyChain].stableDecimals));
      const buy = await adapter.quoteSwap({ chain: buyChain, fromToken: buyIntent.fromToken, toToken: buyIntent.toToken, amountRaw: buyIntent.amountInRaw });
      this.validate(buy, buyIntent, context); this.guard(context.binding, signal);
      const converted = convertInventoryAmount(buy.minOutRaw, buy.toToken.decimals, config.chains[sellChain].tokenDecimals, sellChain);
      const sellIntent = swapIntent(sellChain, this.token(config, sellChain, 'token'), this.token(config, sellChain, 'stable'), converted.amountRaw);
      const sell = await adapter.quoteSwap({ chain: sellChain, fromToken: sellIntent.fromToken, toToken: sellIntent.toToken, amountRaw: sellIntent.amountInRaw });
      this.validate(sell, sellIntent, context); this.guard(context.binding, signal); this.reference(asset, row);
      const expiresAt = Math.min(stamp(buy.expiresAt), stamp(sell.expiresAt));
      const fees = new Decimal(buy.feeUsd).add(sell.feeUsd), proceeds = units(sell.minOutRaw, sell.toToken.decimals), expected = units(sell.amountOutRaw, sell.toToken.decimals);
      const net = proceeds.minus(amountUsd).minus(fees).minus(inventoryAdjustmentCostUsd), stress = proceeds.mul('.995').minus(amountUsd).minus(fees.mul('1.25')).minus(inventoryAdjustmentCostUsd);
      const bnbGas = buy.bnbGas + sell.bnbGas, solFee = buy.solFee + sell.solFee, reasons = [];
      if (!confirmed(asset)) reasons.push('同币1:1身份映射尚未核验；真实报价仅作候选观察，不视为可执行利润');
      if (expiresAt - this.now() < MIN_REMAINING_MS) reasons.push('整套研究报价剩余有效期不足3秒');
      if (bnbGas > config.risk.maxBnbGas) reasons.push('BNB累计费用超过现有风控');
      if (solFee > config.risk.maxSolFee) reasons.push('SOL累计费用超过现有风控');
      if (net.lt(config.risk.minProfitUsd)) reasons.push('保守报价净值未达到利润门槛');
      if (stress.lt(config.risk.minProfitUsd)) reasons.push('额外卖出回落0.5%和费用上涨25%的压力净值未达门槛');
      const buyUnits = units(buy.amountOutRaw, buy.toToken.decimals), buyMinUnits = units(buy.minOutRaw, buy.toToken.decimals), soldUnits = units(sell.amountInRaw, sell.fromToken.decimals);
      const sellVwap = expected.div(soldUnits), slippage = expected.minus(proceeds).add(buyUnits.minus(buyMinUnits).mul(sellVwap));
      Object.assign(report, context.binding, { verified: true, identityVerified: confirmed(asset), qualityPassed: reasons.length === 0,
        addresses: Object.fromEntries(CHAINS.map(chain => [chain, config.chains[chain].tokenAddress])), pools: Object.fromEntries(CHAINS.map(chain => [chain, config.chains[chain].poolAddress])),
        tokenDecimals: Object.fromEntries(CHAINS.map(chain => [chain, config.chains[chain].tokenDecimals])), stableDecimals: Object.fromEntries(CHAINS.map(chain => [chain, config.chains[chain].stableDecimals])), metadataSources: context.metadata,
        buyQuote: this.publicQuote(buy), sellQuote: this.publicQuote(sell), buyQuoteId: buy.id, sellQuoteId: sell.id,
        buyAmountInRaw: buy.amountInRaw, buyAmountOutRaw: buy.amountOutRaw, buyMinOutRaw: buy.minOutRaw, tokenAmountRaw: buy.minOutRaw,
        sellAmountRaw: sell.amountInRaw, sellAmountOutRaw: sell.amountOutRaw, sellMinOutRaw: sell.minOutRaw, dustBuyRaw: converted.dustBuyRaw,
        buyFeeUsd: buy.feeUsd, sellFeeUsd: sell.feeUsd, buyRentUsd: buy.estimatedRentUsd, sellRentUsd: sell.estimatedRentUsd,
        grossProfitUsd: proceeds.minus(amountUsd).toNumber(), netProfitUsd: net.toNumber(), stressNetProfitUsd: stress.toNumber(), gasUsd: fees.toNumber(), feeUsd: fees.toNumber(), bnbGas, solFee,
        estimatedRentUsd: buy.estimatedRentUsd + sell.estimatedRentUsd, estimatedRentIncludedInFees: true,
        slippageUsd: Decimal.max(0, slippage).toNumber(), slippageBasis: 'quoted-expected-versus-minimum-reserve', priceImpactBps: Math.max(buy.priceImpactBps, sell.priceImpactBps),
        buyAveragePriceUsd: new Decimal(amountUsd).div(buyUnits).toNumber(), conservativeBuyAveragePriceUsd: new Decimal(amountUsd).div(buyMinUnits).toNumber(), sellAveragePriceUsd: sellVwap.toNumber(), conservativeSellAveragePriceUsd: proceeds.div(soldUnits).toNumber(),
        inventoryAdjustmentCostUsd, inventoryAdjustmentCostSource: 'configured-observation-reserve', quotedAt: buy.requestedAt, expiresAt: new Date(expiresAt).toISOString(), reasons });
      delete report.wallets;
    } catch (error) { report.reasons = [this.text(error)]; report.qualityPassed = false; report.verified = false; }
    return report;
  }
  async quoteSell({ asset, row, sellChain, amountRaw, signal } = {}) {
    const report = this.base(asset, row, null, CHAINS.includes(sellChain) ? (sellChain === 'bnb' ? 'solana' : 'bnb') : null, 'sell');
    try {
      if (!CHAINS.includes(sellChain)) throw fail('卖出研究链无效');
      positiveRaw(amountRaw, sellChain, '研究准确卖出数量');
      const context = await this.context(asset, row, signal), { config, adapter } = context;
      const intent = swapIntent(sellChain, this.token(config, sellChain, 'token'), this.token(config, sellChain, 'stable'), amountRaw);
      const quote = await adapter.quoteSwap({ chain: sellChain, fromToken: intent.fromToken, toToken: intent.toToken, amountRaw });
      this.validate(quote, intent, context); this.guard(context.binding, signal); this.reference(asset, row);
      const reasons = [];
      if (!confirmed(asset)) reasons.push('同币身份未核验，此卖出报价不能授权交易或充当纸面盈利证据');
      if (stamp(quote.expiresAt) - this.now() < MIN_REMAINING_MS) reasons.push('卖出报价剩余有效期不足3秒');
      if (quote.bnbGas > config.risk.maxBnbGas || quote.solFee > config.risk.maxSolFee) reasons.push('卖出费用超过现有风控');
      Object.assign(report, context.binding, this.publicQuote(quote), { verified: true, qualityPassed: reasons.length === 0, identityVerified: confirmed(asset), reasons, metadataSources: context.metadata,
        assetId: asset.id, assetRevision: asset.revision, generation: row.generation, sellChain, quotedAt: quote.requestedAt });
      delete report.wallets;
    } catch (error) { report.reasons = [this.text(error)]; report.qualityPassed = false; report.verified = false; }
    return report;
  }
}
