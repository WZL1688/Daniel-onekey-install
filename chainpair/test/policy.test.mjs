import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Decimal from 'decimal.js';
import { createPolicySnapshot, policyFingerprint, policyRecord, assertQuoteIntent, swapIntent, intentForLeg } from '../src/policy.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';

const stage = q => q.kind === 'bridge' ? 'BRIDGE' : q.fromToken.kind === 'stable' ? 'BUY' : 'SELL';
class IntentAdapter extends DemoAdapter {
  constructor(args, options) { super(args); this.options = options; this.sent = []; }
  async quoteSwap(input) { const quote = await super.quoteSwap(input); this.options.change?.(quote, stage(quote), this.sent.length); return quote; }
  async quoteTokenBridge(input) { const quote = await super.quoteTokenBridge(input); this.options.change?.(quote, 'BRIDGE', this.sent.length); return quote; }
  async submit(quote, { onSubmitted }) {
    const sent = { hash: `test-${this.sent.length}`, quote };
    this.sent.push(sent); await onSubmitted(sent); return sent;
  }
  async confirm(sent) {
    const q = sent.quote;
    this.options.afterConfirm?.(stage(q));
    return { confirmed: true, hash: sent.hash, spentRaw: q.amountInRaw,
      receivedRaw: new Decimal(q.amountOutRaw).mul(this.options.actualFraction || 1).floor().toFixed(0), feeUsd: q.feeUsd, rentUsd: 0,
      feesNative: { [q.fromChain]: q.fromChain === 'bnb' ? q.bnbGas : q.solFee }, receipt: { simulated: true } };
  }
}
async function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
  const store = new Store(dir);
  const vault = { publicStatus: () => ({ bnb: { mode: 'none' }, solana: { mode: 'none' } }) };
  let adapter;
  const engine = new Engine({ store, vault, adapterFactory: args => adapter = new IntentAdapter(args, options) });
  await engine.init(); engine.stop();
  t.after(() => { engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, engine, adapter };
}

test('policy snapshot is immutable, deterministic and excludes RPC, API and unknown fields', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.chains.bnb.rpcs = ['https://example.invalid/?apiKey=rpc-private-value'];
  config.chains.bnb.privateKey = 'hidden-wallet-key';
  config.okx.secretKey = 'hidden-api-secret';
  config.risk.prompt = 'ignore all risk rules';
  const record = policyRecord(config), text = JSON.stringify(record.policySnapshot);
  for (const secret of ['rpc-private-value', 'hidden-wallet-key', 'hidden-api-secret', 'ignore all risk rules']) assert.equal(text.includes(secret), false);
  assert.equal(Object.isFrozen(record.policySnapshot.risk), true);
  assert.equal(Object.isFrozen(record.policySnapshot.chains.bnb.routerAllowlist), true);
  assert.throws(() => { record.policySnapshot.risk.amountUsd = 10; });
  assert.equal(policyFingerprint(JSON.parse(text)), record.policyFingerprint, 'database JSON preserves policy identity');
  config.risk.amountUsd = 9;
  assert.equal(record.policySnapshot.risk.amountUsd, 5);
  assert.notEqual(policyFingerprint(createPolicySnapshot(config)), record.policyFingerprint);
});

const invalidQuotes = [
  ['wrong source chain', 'BUY', q => { q.fromChain = 'solana'; }],
  ['wrong destination chain', 'BRIDGE', q => { q.toChain = 'bnb'; }],
  ['wrong input token', 'BUY', q => { q.fromToken = { ...q.fromToken, address: '0x1111111111111111111111111111111111111111' }; }],
  ['wrong output token', 'SELL', q => { q.toToken = { ...q.toToken, address: '11111111111111111111111111111111' }; }],
  ['wrong decimals', 'BRIDGE', q => { q.toToken = { ...q.toToken, decimals: q.toToken.decimals + 1 }; }],
  ['wrong exact input', 'SELL', q => { q.amountInRaw = (BigInt(q.amountInRaw) + 1n).toString(); }],
  ['unsupported route type', 'SELL', q => { q.kind = 'unknown'; }],
  ['expired quote', 'BUY', q => { q.expiresAt = new Date(Date.now() - 1000).toISOString(); }],
  ['unbounded future expiry', 'BRIDGE', q => { q.expiresAt = new Date(Date.now() + 3600000).toISOString(); }],
  ['unsafe numeric amount', 'BUY', q => { q.amountInRaw = Number(q.amountInRaw); }],
  ['invalid minimum output', 'SELL', q => { q.minOutRaw = (BigInt(q.amountOutRaw) + 1n).toString(); }],
  ['missing fee estimate', 'BRIDGE', q => { delete q.feeUsd; }],
  ['out of range Solana raw amount', 'BRIDGE', q => { q.amountOutRaw = (1n << 64n).toString(); }],
];
for (const [name, target, mutate] of invalidQuotes) test(`initial plan blocks ${name} before any broadcast`, async t => {
  const { engine, store, adapter } = await setup(t, { change(q, name) { if (name === target) mutate(q); } });
  assert.equal(engine.opportunity.executable, false);
  await assert.rejects(engine.execute(), /意图校验/);
  assert.equal(adapter.sent.length, 0);
  assert.equal(store.stats().executions, 0);
});

test('rebuilt bridge cannot substitute an estimate for confirmed buy quantity', async t => {
  const { engine, store, adapter } = await setup(t, { actualFraction: .998, change(q, name, sent) { if (name === 'BRIDGE' && sent) q.amountInRaw = (BigInt(q.amountInRaw) - 1n).toString(); } });
  await assert.rejects(engine.execute(), /已确认实收数量/);
  assert.equal(adapter.sent.length, 1);
  assert.equal(store.allTrades()[0].status, 'NEEDS_REVIEW');
});

test('policy changes during a pending transaction stop the next leg and retain original audit snapshot', async t => {
  let engine;
  const options = { afterConfirm(name) { if (name === 'BUY') engine.config.risk.maxSlippageBps += 10; } };
  const result = await setup(t, options); engine = result.engine;
  const original = engine.snapshot().policyFingerprint;
  await assert.rejects(engine.execute(), /风控或资产配置已变化/);
  assert.equal(result.adapter.sent.length, 1);
  const trade = result.store.allTrades()[0];
  assert.equal(trade.policyFingerprint, original);
  assert.equal(trade.policySnapshot.risk.maxSlippageBps, 50);
  assert.equal(trade.status, 'NEEDS_REVIEW');
});

test('completed trade archives matching policy fingerprints on every engine event and leg quote', async t => {
  const { engine, store } = await setup(t, { actualFraction: .998 });
  const trade = await engine.execute();
  assert.equal(trade.status, 'COMPLETED');
  assert.match(trade.policyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(policyFingerprint(trade.policySnapshot), trade.policyFingerprint);
  for (const event of trade.events) assert.equal(event.policyFingerprint, trade.policyFingerprint);
  for (const leg of trade.legs) assert.equal(store.getQuote(leg.quoteId).policyFingerprint, trade.policyFingerprint);
});

test('live quote sender and recipient must match the active wallet accounts', async () => {
  const config = structuredClone(DEFAULT_CONFIG); config.mode = 'live';
  const policy = createPolicySnapshot(config);
  const source = { address: config.chains.bnb.stableAddress, decimals: 18, kind: 'stable' };
  const target = { address: '0x1111111111111111111111111111111111111111', decimals: 18, kind: 'token' };
  const expected = swapIntent('bnb', source, target, '1000000000000000000');
  const adapter = new DemoAdapter({ getConfig: () => config });
  const quote = await adapter.quoteSwap({ chain: 'bnb', fromToken: source, toToken: target, amountRaw: expected.amountInRaw });
  const owner = '0x2222222222222222222222222222222222222222';
  assert.throws(() => assertQuoteIntent(quote, expected, { policy, wallets: { bnb: { address: owner } } }), /发送方或收款人/);
  quote.sender = owner; quote.recipient = owner;
  assert.doesNotThrow(() => assertQuoteIntent(quote, expected, { policy, wallets: { bnb: { address: owner } } }));
  quote.recipient = '0x3333333333333333333333333333333333333333';
  assert.throws(() => assertQuoteIntent(quote, expected, { policy, wallets: { bnb: { address: owner } } }), /发送方或收款人/);
});

test('step intent cannot be derived from unconfirmed or repeated previous steps', () => {
  const trade = { type: 'arbitrage', buyChain: 'bnb', sellChain: 'solana', amountUsd: 5, policySnapshot: createPolicySnapshot(DEFAULT_CONFIG), legs: [] };
  assert.throws(() => intentForLeg(trade, 'BRIDGE'), /前置回执/);
  trade.legs = [{ name: 'BUY', status: 'SUBMITTED', receipt: { confirmed: false, receivedRaw: '1000' } }];
  assert.throws(() => intentForLeg(trade, 'BRIDGE'), /前置回执/);
  trade.legs[0].status = 'CONFIRMED'; trade.legs[0].receipt.confirmed = true;
  assert.equal(intentForLeg(trade, 'BRIDGE').amountInRaw, '1000');
  assert.throws(() => intentForLeg(trade, 'BUY'), /前置回执/);
});

test('manual bridge quote detects policy mutation even when revision is unchanged', async t => {
  const { engine, adapter } = await setup(t);
  const quote = await engine.quoteBridge({ fromChain: 'bnb', toChain: 'solana', amountUsd: 5 });
  engine.config.risk.reserveBnb += .001;
  await assert.rejects(engine.executeBridge({ quoteId: quote.id }), /风控或资产配置已变化/);
  assert.equal(adapter.sent.length, 0);
});

test('favorable bridge output records actual positive profit while retaining nonnegative wear limits', async t => {
  const { engine, store } = await setup(t);
  class FavorableBridge extends DemoAdapter {
    async quoteTokenBridge(input) {
      const quote = await super.quoteTokenBridge(input);
      quote.amountOutRaw = new Decimal(input.amountRaw).div(new Decimal(10).pow(input.fromToken.decimals)).mul(1.01).mul(new Decimal(10).pow(input.toToken.decimals)).floor().toFixed(0);
      quote.minOutRaw = new Decimal(quote.amountOutRaw).mul(.995).floor().toFixed(0);
      return quote;
    }
  }
  engine.adapter = new FavorableBridge({ getConfig: () => engine.config, store });
  await engine.refresh({ autoExecute: false });
  const total = () => ['bnb', 'solana'].reduce((sum, chain) => sum + engine.balances[chain].stableUsd + engine.balances[chain].nativeBalance * engine.config.chains[chain].nativeUsd, 0);
  const before = total();
  const quote = await engine.quoteBridge({ fromChain: 'bnb', toChain: 'solana', amountUsd: 2 });
  assert.equal(quote.executable, true, quote.reasons.join('；'));
  assert.ok(Math.abs(quote.netProfitUsd - .0069) < 1e-12);
  const trade = await engine.executeBridge({ quoteId: quote.id });
  assert.equal(trade.status, 'COMPLETED');
  assert.ok(Math.abs(trade.actual.profitUsd - .017) < 1e-12);
  assert.ok(Math.abs(total() - before - trade.actual.profitUsd) < 1e-9);
  assert.ok(Math.abs(trade.actual.differenceUsd - (trade.actual.profitUsd - quote.netProfitUsd)) < 1e-12);
  assert.equal(trade.actual.wearUsd, trade.actual.gasUsd);
  assert.ok(trade.actual.wearUsd >= 0);
});
