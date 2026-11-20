import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const raw = (n, d) => new Decimal(n).mul(new Decimal(10).pow(d)).floor().toFixed(0);
const units = (n, d) => new Decimal(n).div(new Decimal(10).pow(d)).toNumber();
const safeError = message => Object.assign(new Error(message), { safe: true });
export class DemoAdapter {
  constructor({ getConfig, store }) {
    this.getConfig = getConfig; this.store = store;
    this.funds = store?.getMeta('demoFunds') || { bnb: { stableUsd: 30, nativeBalance: .025, token: 0 }, solana: { stableUsd: 20, nativeBalance: .3, token: 0 } };
    this.prices = { bnb: .0124, solana: .0131 };
    this.inventoryTokens = store?.getMeta('demoInventoryTokens') || {};
    if (getConfig().executionMode === 'inventory') {
      for (const chain of ['bnb','solana']) {
        const c = getConfig().chains[chain], key = this.inventoryKey(chain);
        if (!this.inventoryTokens[key]) this.inventoryTokens[key] = { decimals: c.tokenDecimals, raw: raw(1000,c.tokenDecimals) };
      }
      store?.setMeta('demoInventoryTokens',this.inventoryTokens);
    }
  }
  inventoryKey(chain) { const c = this.getConfig(), address = c.chains[chain].tokenAddress; return `${chain}:${address ? (chain === 'bnb' ? address.toLowerCase() : address) : c.inventory?.assetId || 'demo-token'}`; }
  refreshFunds() { this.funds = this.store?.getMeta('demoFunds') || this.funds; this.inventoryTokens = this.store?.getMeta('demoInventoryTokens') || this.inventoryTokens; }
  inventoryToken(chain) {
    const record = this.inventoryTokens[this.inventoryKey(chain)], decimals = this.getConfig().chains[chain].tokenDecimals;
    if (!record || record.decimals !== decimals || typeof record.raw !== 'string' || !/^\d+$/.test(record.raw)) throw safeError('模拟库存精度或记录不一致，请核对本机演示数据');
    return record;
  }
  async market(chain) {
    return { priceUsd: this.prices[chain], liquidityUsd: chain === 'bnb' ? 182400 : 143800, updatedAt: new Date().toISOString(), connected: true, rpc: '本地模拟器', source: 'demo', symbol: 'DEMO', error: null };
  }
  async balances(chain) { this.refreshFunds(); const c = this.getConfig().chains[chain]; const tokenRaw = this.getConfig().executionMode === 'inventory' ? this.inventoryToken(chain).raw : raw(this.funds[chain].token,c.tokenDecimals); return { ...this.funds[chain], tokenRaw, tokenBalance: units(tokenRaw,c.tokenDecimals), address: '模拟余额', updatedAt: new Date().toISOString() }; }
  async quoteSwap({ chain, fromToken, toToken, amountRaw }) {
    const c = this.getConfig(); const stable = fromToken.kind === 'stable' || fromToken.address === c.chains[chain].stableAddress;
    const amount = units(amountRaw, fromToken.decimals);
    const out = stable ? amount / this.prices[chain] * .997 : amount * this.prices[chain] * .997;
    return this.quote({ kind: 'swap', fromChain: chain, toChain: chain, fromToken, toToken, amountInRaw: amountRaw, amountOutRaw: raw(out, toToken.decimals), priceImpactBps: 8, ...this.fees(chain) });
  }
  async quoteTokenBridge({ fromChain, toChain, fromToken, toToken, amountRaw }) {
    const amount = units(amountRaw, fromToken.decimals);
    return this.quote({ kind: 'bridge', fromChain, toChain, fromToken, toToken, amountInRaw: amountRaw, amountOutRaw: raw(amount * .999, toToken.decimals), priceImpactBps: 0, ...this.fees(fromChain) });
  }
  fees(chain) {
    const native = chain === 'bnb' ? .000005 : .000014;
    return { feeUsd: native * this.getConfig().chains[chain].nativeUsd, estimatedRentUsd: 0, bnbGas: chain === 'bnb' ? native : 0, solFee: chain === 'solana' ? native : 0 };
  }
  quote(q) { const c = this.getConfig(); return { ...q, id: randomUUID(), minOutRaw: new Decimal(q.amountOutRaw).mul(1 - c.risk.maxSlippageBps / 10000).floor().toFixed(0), expiresAt: new Date(Date.now() + c.quoteTtlMs).toISOString(), raw: { source: 'LOCAL_SIMULATION', route: '模拟路线，无链上广播' } }; }
  async submit(quote, { onSubmitted } = {}) {
    const submission = { id: randomUUID(), hash: `demo-${randomUUID()}`, quote, submittedAt: new Date().toISOString(), demo: true };
    await onSubmitted?.(submission); await delay(200); return submission;
  }
  async confirm(submission) {
    await delay(300);
    const q = submission.quote;
    this.refreshFunds();
    const input = units(q.amountInRaw, q.fromToken.decimals);
    const received = units(q.amountOutRaw, q.toToken.decimals);
    const f = this.funds[q.fromChain]; const t = this.funds[q.toChain];
    if (q.fromToken.kind === 'stable') { if (f.stableUsd < input) throw safeError('模拟余额不足'); f.stableUsd -= input; }
    else if (this.getConfig().executionMode === 'inventory') { const token = this.inventoryToken(q.fromChain); if (BigInt(token.raw) < BigInt(q.amountInRaw)) throw safeError('模拟代币库存不足'); token.raw = (BigInt(token.raw)-BigInt(q.amountInRaw)).toString(); }
    else { if (f.token + 1e-8 < input) throw safeError('模拟代币不足'); f.token -= input; }
    if (q.toToken.kind === 'stable') t.stableUsd += received;
    else if (this.getConfig().executionMode === 'inventory') { const token = this.inventoryToken(q.toChain); token.raw = (BigInt(token.raw)+BigInt(q.amountOutRaw)).toString(); }
    else t.token += received;
    const feeNative = q.fromChain === 'bnb' ? q.bnbGas : q.solFee;
    f.nativeBalance -= feeNative;
    this.store?.setMeta('demoFunds', this.funds);
    if (this.getConfig().executionMode === 'inventory') this.store?.setMeta('demoInventoryTokens',this.inventoryTokens);
    return { confirmed: true, hash: submission.hash, receivedRaw: q.amountOutRaw, spentRaw: q.amountInRaw, feesNative: { [q.fromChain]: feeNative }, feeUsd: q.feeUsd, rentUsd: 0, receipt: { simulated: true, status: 'confirmed', hash: submission.hash, fromChain: q.fromChain, toChain: q.toChain }, confirmedAt: new Date().toISOString() };
  }
}
