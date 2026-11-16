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
  }
  async market(chain) {
    return { priceUsd: this.prices[chain], liquidityUsd: chain === 'bnb' ? 182400 : 143800, updatedAt: new Date().toISOString(), connected: true, rpc: '本地模拟器', source: 'demo', symbol: 'DEMO', error: null };
  }
  async balances(chain) { const c = this.getConfig().chains[chain]; return { ...this.funds[chain], tokenRaw: raw(this.funds[chain].token, c.tokenDecimals), address: '模拟余额', updatedAt: new Date().toISOString() }; }
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
    return { feeUsd: native * this.getConfig().chains[chain].nativeUsd, bnbGas: chain === 'bnb' ? native : 0, solFee: chain === 'solana' ? native : 0 };
  }
  quote(q) { const c = this.getConfig(); return { ...q, id: randomUUID(), minOutRaw: new Decimal(q.amountOutRaw).mul(1 - c.risk.maxSlippageBps / 10000).floor().toFixed(0), expiresAt: new Date(Date.now() + c.quoteTtlMs).toISOString(), raw: { source: 'LOCAL_SIMULATION', route: '模拟路线，无链上广播' } }; }
  async submit(quote, { onSubmitted } = {}) {
    const submission = { id: randomUUID(), hash: `demo-${randomUUID()}`, quote, submittedAt: new Date().toISOString(), demo: true };
    await onSubmitted?.(submission); await delay(200); return submission;
  }
  async confirm(submission) {
    await delay(300);
    const q = submission.quote;
    const input = units(q.amountInRaw, q.fromToken.decimals);
    const received = units(q.amountOutRaw, q.toToken.decimals);
    const f = this.funds[q.fromChain]; const t = this.funds[q.toChain];
    if (q.fromToken.kind === 'stable') { if (f.stableUsd < input) throw safeError('模拟余额不足'); f.stableUsd -= input; }
    else { if (f.token + 1e-8 < input) throw safeError('模拟代币不足'); f.token -= input; }
    if (q.toToken.kind === 'stable') t.stableUsd += received; else t.token += received;
    const feeNative = q.fromChain === 'bnb' ? q.bnbGas : q.solFee;
    f.nativeBalance -= feeNative;
    this.store?.setMeta('demoFunds', this.funds);
    return { confirmed: true, hash: submission.hash, receivedRaw: q.amountOutRaw, spentRaw: q.amountInRaw, feesNative: { [q.fromChain]: feeNative }, feeUsd: q.feeUsd, rentUsd: 0, receipt: { simulated: true, status: 'confirmed', hash: submission.hash, fromChain: q.fromChain, toChain: q.toChain }, confirmedAt: new Date().toISOString() };
  }
}
