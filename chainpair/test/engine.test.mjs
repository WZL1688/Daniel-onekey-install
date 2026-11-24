import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Decimal from 'decimal.js';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));
const safe = message => Object.assign(new Error(message), { safe: true });
const stage = q => q.kind === 'bridge' ? 'BRIDGE' : q.fromToken.kind === 'stable' ? 'BUY' : 'SELL';
class TestAdapter extends DemoAdapter {
  constructor(args, options = {}) { super(args); this.options = options; this.calls = []; this.sent = []; this.receipts = []; }
  async market(chain) { if (this.options.marketDelay) await pause(this.options.marketDelay); return super.market(chain); }
  async quoteSwap(input) { this.calls.push({ method: 'swap', ...input }); if (this.options.quoteDelay) await pause(this.options.quoteDelay); const q = await super.quoteSwap(input); this.options.changeQuote?.(q, stage(q), this.sent.length); return q; }
  async quoteTokenBridge(input) { if (this.options.bridgeDelay) await pause(this.options.bridgeDelay); this.calls.push({ method: 'bridge', ...input }); const q = await super.quoteTokenBridge(input); if (this.options.rebuiltBridgeGas && this.sent.length) q.bnbGas = this.options.rebuiltBridgeGas; this.options.changeQuote?.(q, 'BRIDGE', this.sent.length); return q; }
  async balances(chain) { if (this.options.funds) return { tokenRaw: '99999999999999999999999999', ...this.options.funds[chain] }; return super.balances(chain); }
  async submit(quote, { onSubmitted } = {}) {
    const intent = this.store.getQuote(quote.id);
    assert.ok(intent?.tradeId, 'the submitted quote must already identify its durable trade');
    const trade = this.store.getTrade(intent.tradeId);
    assert.equal(trade.status, `${stage(quote)}_SUBMITTING`, 'intent must be durable before broadcast');
    const submission = { hash: `test-${this.sent.length}`, quote };
    this.sent.push(submission); await onSubmitted?.(submission); return submission;
  }
  async confirm(submission) {
    if (this.options.confirmDelay) await pause(this.options.confirmDelay);
    const q = submission.quote, name = stage(q);
    if (this.options.throwStage === name) throw safe(`模拟${name}单边失败`);
    const fraction = this.options.actualFraction || 1;
    const receipt = { hash: submission.hash, confirmed: this.options.unconfirmedStage !== name, receivedRaw: new Decimal(q.amountOutRaw).mul(fraction).floor().toFixed(0), spentRaw: q.amountInRaw, feeUsd: q.feeUsd, rentUsd: 0, feesNative: { [q.fromChain]: q.fromChain === 'bnb' ? q.bnbGas : q.solFee }, receipt: { simulated: true } };
    if (this.options.wrongHashStage === name) receipt.hash = 'wrong-hash';
    if (this.options.partialStage === name) receipt.spentRaw = new Decimal(q.amountInRaw).minus(1).toFixed(0);
    if (this.options.actualBnbGas && q.fromChain === 'bnb') receipt.feesNative.bnb = this.options.actualBnbGas;
    this.receipts.push(receipt); return receipt;
  }
}
async function setup(t, options = {}, mutate) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dualarb-engine-'));
  const store = new Store(dir); const config = structuredClone(DEFAULT_CONFIG);
  mutate?.(config); store.setConfig(config);
  const vault = { publicStatus: () => ({ bnb: { mode: 'none' }, solana: { mode: 'none' }, okxConfigured: false }), getOkxCredentials: () => { throw Error('should not read secrets'); } };
  let adapter;
  const engine = new Engine({ store, vault, verificationOnly: options.verificationOnly, adapterFactory: args => adapter = new TestAdapter(args, options) });
  await engine.init(); engine.stop();
  t.after(() => { engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, adapter };
}

test('confirmed sequential execution uses actual buy and bridge receipt quantities', async t => {
  const { engine, store, adapter } = await setup(t, { actualFraction: .998 });
  const trade = await engine.execute();
  assert.equal(trade.status, 'COMPLETED');
  assert.deepEqual(adapter.sent.map(s => stage(s.quote)), ['BUY', 'BRIDGE', 'SELL']);
  assert.equal(adapter.sent[1].quote.amountInRaw, adapter.receipts[0].receivedRaw);
  assert.equal(adapter.sent[2].quote.amountInRaw, adapter.receipts[1].receivedRaw);
  assert.equal(trade.actual.boughtRaw, adapter.receipts[0].receivedRaw);
  assert.equal(trade.actual.bridgedRaw, adapter.receipts[1].receivedRaw);
  assert.equal(store.stats().executions, 1);
  const statuses = trade.events.map(e => e.status);
  assert.ok(statuses.indexOf('BUY_CONFIRMED') < statuses.indexOf('BRIDGE_SUBMITTING'));
  assert.ok(statuses.indexOf('BRIDGE_CONFIRMED') < statuses.indexOf('SELL_SUBMITTING'));
});
for (const name of ['BUY', 'BRIDGE']) test(`${name} unconfirmed prevents all subsequent broadcasts and pauses`, async t => {
  const { engine, store, adapter } = await setup(t, { unconfirmedStage: name });
  await assert.rejects(engine.execute(), /尚未确认/);
  assert.deepEqual(adapter.sent.map(s => stage(s.quote)), name === 'BUY' ? ['BUY'] : ['BUY', 'BRIDGE']);
  assert.equal(engine.running, false); assert.match(engine.pausedReason, /核对/);
  const trade = store.allTrades()[0]; assert.equal(trade.status, 'NEEDS_REVIEW');
  assert.ok(trade.legs.at(-1).receipt, 'uncertain receipt remains archived');
  assert.equal(store.stats().executions, 1, 'failed attempt consumes execution budget');
});
test('single-side error blocks restart until manual review, without auto replay', async t => {
  const { engine, store, adapter } = await setup(t, { throwStage: 'BRIDGE' });
  await assert.rejects(engine.execute(), /单边失败/);
  assert.throws(() => engine.start(), /核对/);
  const trade = store.allTrades()[0];
  assert.equal(engine.snapshot().engine.activeTradeId, null);
  assert.equal(engine.snapshot().engine.reviewTradeId, trade.id);
  engine.acknowledge({ tradeId: trade.id, note: '已核对两链余额与哈希' });
  assert.equal(store.getTrade(trade.id).status, 'REVIEWED');
  assert.equal(engine.pausedReason, ''); assert.equal(adapter.sent.length, 2);
  assert.equal(engine.snapshot().engine.reviewTradeId, null);
});
for (const property of ['wrongHashStage', 'partialStage']) test(`inconsistent receipt (${property}) stops before bridge`, async t => {
  const { engine, store, adapter } = await setup(t, { [property]: 'BUY' });
  await assert.rejects(engine.execute(), /哈希不匹配|实际花费/);
  assert.equal(adapter.sent.length, 1);
  assert.equal(store.allTrades()[0].status, 'NEEDS_REVIEW');
  assert.ok(store.allTrades()[0].legs[0].receipt);
});
test('mutex is held while re-quoting; simultaneous execution cannot broadcast twice', async t => {
  const { engine, adapter } = await setup(t, { quoteDelay: 15, confirmDelay: 10 });
  const first = engine.execute();
  await assert.rejects(engine.execute(), /执行中/);
  await first; assert.equal(adapter.sent.length, 3);
});
test('successful automatic cycle does not recursively launch another cycle in finally', async t => {
  const { engine, adapter } = await setup(t);
  engine.running = true; await engine.execute(); await pause(15);
  assert.equal(adapter.sent.length, 3);
});
test('persistent execution count and cumulative amount limits block further attempts', async t => {
  const { engine, store, adapter } = await setup(t, {}, c => { c.risk.maxExecutions = 1; c.risk.maxCumulativeUsd = 5; });
  await engine.execute();
  await assert.rejects(engine.execute(), /次数上限|累计金额/);
  assert.equal(adapter.sent.length, 3); assert.equal(store.stats().cumulativeUsd, 5);
});
test('rebuilt leg plus previous actual fee must obey cumulative native cap', async t => {
  const { engine, adapter, store } = await setup(t, { actualBnbGas: .0006, rebuiltBridgeGas: .0006 });
  await assert.rejects(engine.execute(), /BNB Gas/);
  assert.equal(adapter.sent.length, 1, 'bridge not sent when total fee would exceed cap');
  assert.equal(store.allTrades()[0].status, 'NEEDS_REVIEW');
});
test('restart marks unfinished intent for review and never replays it', async t => {
  const { engine, store, adapter } = await setup(t);
  store.saveTrade({ id: 'uncertain', type: 'arbitrage', status: 'BUY_SUBMITTING', createdAt: new Date().toISOString(), legs: [] });
  await engine.init(); engine.stop();
  assert.equal(store.getTrade('uncertain').status, 'NEEDS_REVIEW');
  assert.match(engine.pausedReason, /核对/); assert.equal(adapter.sent.length, 0);
  assert.equal(engine.snapshot().engine.reviewTradeId, 'uncertain');
});
test('rebalance requires low side below 5U and targets 60/40; small totals and cooldown block', async t => {
  const { engine, store } = await setup(t, {}, c => { c.rebalance.enabled = true; });
  engine.balances = { bnb: { stableUsd: 5 }, solana: { stableUsd: 20 } };
  assert.equal(engine.rebalanceRequest(), null, 'equal to 5 is not low');
  engine.balances.bnb.stableUsd = 4;
  const request = engine.rebalanceRequest(); assert.equal(request.fromChain, 'solana'); assert.equal(request.toChain, 'bnb');
  assert.ok(Math.abs(request.amountUsd - (24 * .6 - 4)) < 1e-9);
  engine.balances.solana.stableUsd = 8; assert.equal(engine.rebalanceRequest(), null, '40% donor cannot fall below trigger');
  engine.balances.solana.stableUsd = 20; store.setMeta('lastRebalanceAt', new Date().toISOString());
  assert.equal(engine.rebalanceRequest(), null);
});
test('manual bridge ignores arbitrage amount/count/day caps, but retains wear and gas limits', async t => {
  const funds = { bnb: { stableUsd: 1000, nativeBalance: .5 }, solana: { stableUsd: 1000, nativeBalance: .5 } };
  const { engine, store, adapter } = await setup(t, { funds }, c => { c.risk.maxExecutions = 1; c.risk.maxCumulativeUsd = 5; c.rebalance.maxWearUsd = 20; c.rebalance.maxWearBps = 200; });
  store.saveTrade({ id: 'prior-arbitrage', type: 'arbitrage', mode: 'demo', status: 'COMPLETED' });
  store.reserveExecution('prior-arbitrage', 5);
  const quote = await engine.quoteBridge({ fromChain: 'bnb', toChain: 'solana', amountUsd: 100 });
  assert.equal(quote.executable, true, quote.reasons.join('；'));
  const trade = await engine.executeBridge({ quoteId: quote.id });
  assert.equal(trade.status, 'COMPLETED'); assert.equal(trade.amountUsd, 100); assert.equal(adapter.sent.length, 1);
  assert.equal(store.stats().executions, 1, 'manual bridge does not consume arbitrage count');
  await assert.rejects(engine.executeBridge({ quoteId: quote.id }), /不存在|过期/, 'quote is single use');
});
test('unknown native balances and excessive route wear block a bridge', async t => {
  const { engine } = await setup(t);
  engine.balances.bnb.nativeBalance = null;
  const quote = await engine.quoteBridge({ fromChain: 'bnb', toChain: 'solana', amountUsd: 5 });
  assert.equal(quote.executable, false); assert.ok(quote.reasons.some(r => /原生币余额/.test(r)));
  engine.balances.bnb.nativeBalance = .5;
  engine.config.rebalance.maxWearUsd = 0;
  const worn = await engine.quoteBridge({ fromChain: 'bnb', toChain: 'solana', amountUsd: 5 });
  assert.equal(worn.executable, false); assert.ok(worn.reasons.some(r => /美元磨损/.test(r)));
});
test('automatic rebalance delivers approximately 60/40 from actual received stablecoin amounts', async t => {
  const { engine, store } = await setup(t, {}, c => { c.rebalance.enabled = true; });
  store.setMeta('demoFunds', { bnb: { stableUsd: 4, nativeBalance: .1, token: 0 }, solana: { stableUsd: 20, nativeBalance: .3, token: 0 } });
  engine.adapter = new DemoAdapter({ getConfig: () => engine.config, store });
  await engine.refresh();
  const request = engine.rebalanceRequest(); assert.ok(request);
  const quote = await engine.quoteBridge(request); assert.equal(quote.executable, true, quote.reasons.join('；'));
  const trade = await engine.executeBridge({ quoteId: quote.id }); assert.equal(trade.status, 'COMPLETED');
  const b = engine.balances.bnb.stableUsd, s = engine.balances.solana.stableUsd;
  assert.ok(Math.abs(b / (b + s) - .6) < 1e-5, `actual share=${b / (b + s)}`);
  assert.ok(s >= 5); assert.equal(engine.rebalanceRequest(), null, 'successful rebalance cannot immediately reverse');
});
test('demo native fees and profit reconcile against actual balance changes', async t => {
  const { engine, store } = await setup(t);
  engine.adapter = new DemoAdapter({ getConfig: () => engine.config, store });
  await engine.refresh();
  const total = () => ['bnb', 'solana'].reduce((n, c) => n + engine.balances[c].stableUsd + engine.balances[c].nativeBalance * engine.config.chains[c].nativeUsd, 0);
  const before = total(); const trade = await engine.execute(); const after = total();
  assert.ok(Math.abs((after - before) - trade.actual.profitUsd) < 1e-9);
  for (const leg of trade.legs) {
    const nativeUsd = Object.entries(leg.receipt.feesNative).reduce((sum, [chain, amount]) => sum + amount * engine.config.chains[chain].nativeUsd, 0);
    assert.ok(Math.abs(nativeUsd - leg.receipt.feeUsd) < 1e-12);
  }
});
test('delayed refresh prevents a concurrent configuration change from mixing market identities', async t => {
  const { engine, adapter } = await setup(t);
  adapter.options.marketDelay = 25;
  const original = structuredClone(engine.config);
  const refreshing = engine.refresh();
  await assert.rejects(engine.saveConfig({ ...original, risk: { ...original.risk, amountUsd: 7 } }), /报价|配置更新/);
  assert.deepEqual(engine.config, original);
  await refreshing; assert.equal(adapter.sent.length, 0);
});
test('configuration update holds a guard during asynchronous adapter creation', async t => {
  const { engine, adapter } = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  engine.adapterFactory = async () => { await gate; return adapter; };
  const saving = engine.saveConfig(structuredClone(engine.config));
  assert.equal(engine.configuring, true);
  await assert.rejects(engine.execute(), /配置更新/);
  await assert.rejects(engine.quoteBridge({ fromChain: 'bnb', toChain: 'solana', amountUsd: 5 }), /配置更新/);
  await assert.rejects(engine.saveConfig(structuredClone(engine.config)), /配置更新/);
  assert.throws(() => engine.start(), /配置更新/);
  release(); const state = await saving;
  assert.equal(state.engine.configuring, false); assert.equal(adapter.sent.length, 0);
});
test('pending bridge quote prevents config replacement and old revisions cannot execute', async t => {
  const { engine, adapter } = await setup(t);
  adapter.options.bridgeDelay = 20;
  const pending = engine.quoteBridge({ fromChain: 'bnb', toChain: 'solana', amountUsd: 5 });
  assert.equal(engine.quoteBuilders, 1);
  await assert.rejects(engine.saveConfig(structuredClone(engine.config)), /报价|配置更新/);
  const quote = await pending; assert.equal(engine.quoteBuilders, 0);
  await engine.saveConfig(structuredClone(engine.config));
  assert.equal(engine.bridgeQuotes.has(quote.id), false);
  // Even a late stale cache insertion cannot bypass the revision check.
  engine.bridgeQuotes.set(quote.id, quote);
  await assert.rejects(engine.executeBridge({ quoteId: quote.id }), /配置已变化/);
  assert.equal(adapter.sent.length, 0);
});
test('execution guard also covers delayed market requests before any broadcast', async t => {
  const { engine, adapter } = await setup(t);
  adapter.options.marketDelay = 25;
  const execution = engine.execute();
  await assert.rejects(engine.saveConfig(structuredClone(engine.config)), /交易|报价/);
  await assert.rejects(engine.execute(), /执行中/);
  await execution; assert.equal(adapter.sent.length, 3);
});

test('wallet identity change discards a delayed balance response and refreshes the new account', async t => {
  const { engine, adapter } = await setup(t);
  const original = adapter.balances.bind(adapter);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  adapter.balances = async chain => {
    const balance = await original(chain);
    if (chain === 'bnb' && first) { first = false; started(); await gate; return { ...balance, address: 'old-account' }; }
    return { ...balance, address: 'new-account' };
  };
  const refresh = engine.refresh({ autoExecute: false });
  await entered;
  engine.walletChanged('bnb');
  assert.equal(engine.running, false);
  assert.equal(engine.plan, null);
  assert.equal(engine.balances.bnb, undefined);
  release(); await refresh;
  assert.notEqual(engine.balances.bnb?.address, 'old-account');
  for (let i = 0; i < 30 && engine.balances.bnb?.address !== 'new-account'; i++) await pause(2);
  assert.equal(engine.balances.bnb.address, 'new-account');
  while (engine.refreshing) await pause(2);
});

test('changing a wallet invalidates a pending cross-chain quote without blocking the account switch', async t => {
  const { engine, adapter } = await setup(t);
  adapter.options.bridgeDelay = 20;
  const pending = engine.quoteBridge({ fromChain: 'bnb', toChain: 'solana', amountUsd: 5 });
  const revision = engine.configRevision;
  engine.walletChanged('solana');
  assert.equal(engine.configRevision, revision + 1);
  await assert.rejects(pending, /配置已变化/);
  assert.equal(engine.bridgeQuotes.size, 0);
  assert.equal(adapter.sent.length, 0);
});

test('live mode accepts connected browser signers and blocks stale browser or readonly accounts', async t => {
  const { engine } = await setup(t);
  engine.config.mode = 'live';
  engine.config.chains.bnb.tokenAddress = '0x1111111111111111111111111111111111111111';
  engine.config.chains.solana.tokenAddress = '11111111111111111111111111111111';
  let online = true;
  engine.vault.publicStatus = () => ({ bnb: { mode: 'browser', unlocked: online, canSign: online }, solana: { mode: 'browser', unlocked: true, canSign: true }, okxConfigured: true, locked: false });
  assert.equal(engine.baseReasons().length, 0);
  online = false;
  assert(engine.baseReasons().some(reason => /插件钱包未连接/.test(reason)));
  engine.vault.publicStatus = () => ({ bnb: { mode: 'readonly', unlocked: false, canSign: false }, solana: { mode: 'browser', unlocked: true, canSign: true }, okxConfigured: true, locked: false });
  assert(engine.baseReasons().some(reason => /只读/.test(reason)));
});

function useMockLiveWallets(engine, adapter, mode = 'private') {
  const addresses = { bnb: '0x1111111111111111111111111111111111111111', solana: '11111111111111111111111111111111' };
  engine.config.mode = 'live';
  engine.config.chains.bnb.tokenAddress = '0x2222222222222222222222222222222222222222';
  engine.config.chains.solana.tokenAddress = 'So11111111111111111111111111111111111111112';
  engine.vault.publicStatus = () => ({ ...Object.fromEntries(Object.entries(addresses).map(([chain, address]) => [chain, { address, mode, unlocked: mode !== 'readonly', canSign: mode !== 'readonly' }])), okxConfigured: true, locked: false });
  for (const method of ['quoteSwap', 'quoteTokenBridge']) {
    const original = adapter[method].bind(adapter);
    adapter[method] = async input => { const quote = await original(input); return { ...quote, sender: addresses[quote.fromChain], recipient: addresses[quote.toChain] }; };
  }
}

test('verification-only engine accepts public addresses for quality checks but every execution entry rejects', async t => {
  const { engine, adapter, store } = await setup(t, { verificationOnly: true });
  useMockLiveWallets(engine, adapter, 'readonly');
  await engine.loadMarketBalances(); await engine.buildOpportunity();
  assert.equal(engine.opportunity.qualityPassed, true, engine.opportunity.reasons.join('；'));
  assert.equal(engine.opportunity.executable, false);
  await assert.rejects(engine.execute(), /只读复核禁止/);
  await assert.rejects(engine.runLeg({}, 'BUY', {}), /只读复核禁止/);
  await assert.rejects(engine.executeBridge({ quoteId: 'unused' }), /只读复核禁止/);
  assert.equal(adapter.sent.length, 0); assert.equal(store.allTrades().length, 0);
  engine.vault.publicStatus = () => ({ bnb: { address: 'public-only' }, solana: {}, okxConfigured: false, locked: true });
  assert(engine.baseReasons().some(reason => /solana 未导入/.test(reason)));
  assert(engine.baseReasons().some(reason => /OKX API/.test(reason)));
});

test('live TTL below the fixed three-second minimum safely blocks instead of relaxing risk settings', async t => {
  const { engine, adapter, store } = await setup(t);
  useMockLiveWallets(engine, adapter); engine.config.quoteTtlMs = 2000;
  await assert.rejects(engine.execute(), /剩余有效期不足 3 秒/);
  assert.equal(engine.config.quoteTtlMs, 2000); assert.equal(adapter.sent.length, 0);
  assert.equal(store.stats().executions, 0);
});

test('BUY rechecks the entire live plan after balance reads, including a sell quote nearing expiry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { engine, adapter, store } = await setup(t);
  useMockLiveWallets(engine, adapter);
  adapter.options.changeQuote = (q, name) => { if (name === 'SELL') q.expiresAt = new Date(Date.now() + 3500).toISOString(); };
  const original = adapter.balances.bind(adapter); let reads = 0;
  adapter.balances = async chain => { const balance = await original(chain); if (++reads === 3) t.mock.timers.tick(600); return balance; };
  await assert.rejects(engine.execute(), /剩余有效期不足 3 秒/);
  assert.equal(adapter.sent.length, 0, 'a fresh BUY alone cannot justify submitting an aging whole plan');
  assert.equal(store.allTrades()[0].status, 'NEEDS_REVIEW');
});

test('BUY rechecks whole-plan net profit after asynchronous balance reads', async t => {
  const { engine, adapter } = await setup(t);
  const original = adapter.balances.bind(adapter); let reads = 0;
  adapter.balances = async chain => { const balance = await original(chain); if (++reads === 3) engine.plan.sell.feeUsd = 10; return balance; };
  await assert.rejects(engine.execute(), /完整交易计划保守净收益/);
  assert.equal(adapter.sent.length, 0);
});

for (const afterConfirmedLegs of [1, 2]) test(`bridge path stops when the sell price drops after ${afterConfirmedLegs} confirmed leg(s)`, async t => {
  const { engine, adapter, store } = await setup(t);
  adapter.options.changeQuote = (q, name, sent) => {
    if (name === 'SELL' && sent >= afterConfirmedLegs) { q.amountOutRaw = new Decimal(q.amountOutRaw).div(2).floor().toFixed(0); q.minOutRaw = new Decimal(q.amountOutRaw).mul('.995').floor().toFixed(0); }
  };
  await assert.rejects(engine.execute(), /净收益未达到利润门槛/);
  assert.deepEqual(adapter.sent.map(sent => stage(sent.quote)), afterConfirmedLegs === 1 ? ['BUY'] : ['BUY', 'BRIDGE']);
  assert.equal(store.allTrades()[0].status, 'NEEDS_REVIEW');
  assert.match(engine.pausedReason, /核对/);
});

test('pre-bridge profit recheck includes rent actually paid by the confirmed buy', async t => {
  const { engine, adapter, store } = await setup(t);
  const original = adapter.confirm.bind(adapter);
  adapter.confirm = async sent => { const receipt = await original(sent); if (stage(sent.quote) === 'BUY') receipt.rentUsd = .3; return receipt; };
  await assert.rejects(engine.execute(), /完整交易计划保守净收益/);
  assert.deepEqual(adapter.sent.map(sent => stage(sent.quote)), ['BUY']);
  const trade = store.allTrades()[0];
  assert.equal(trade.legs[0].receipt.rentUsd, .3); assert.equal(trade.status, 'NEEDS_REVIEW');
});

test('live execution rejects nominally profitable plans that fail the shared pressure scenario', async t => {
  const { engine, adapter, store } = await setup(t); useMockLiveWallets(engine, adapter);
  await engine.loadMarketBalances(); await engine.buildOpportunity();
  const { netProfitUsd, stressNetProfitUsd } = engine.opportunity;
  assert(stressNetProfitUsd < netProfitUsd);
  engine.config.risk.minProfitUsd = (netProfitUsd + stressNetProfitUsd) / 2;
  await assert.rejects(engine.execute(), /压力场景/);
  assert(engine.opportunity.netProfitUsd >= engine.config.risk.minProfitUsd);
  assert(engine.opportunity.stressNetProfitUsd < engine.config.risk.minProfitUsd);
  assert.equal(engine.opportunity.qualityPassed, false); assert.equal(engine.opportunity.executable, false);
  assert.equal(adapter.sent.length, 0); assert.equal(store.stats().executions, 0);
});

test('shared live pressure formula leaves already-paid fees and rent at their actual values', async t => {
  const { engine, adapter } = await setup(t); useMockLiveWallets(engine, adapter);
  const sell = structuredClone(engine.plan.sell);
  sell.amountOutRaw = '5220000'; sell.minOutRaw = '5200000'; sell.feeUsd = .04;
  const trade = { legs: [{ receipt: { feeUsd: .08, rentUsd: .02, feesNative: { bnb: 0 } } }] };
  const quality = engine.planQualityReasons([sell], { trade, spentUsd: 5 });
  assert(Math.abs(quality.netProfitUsd - .06) < 1e-12);
  assert(Math.abs(quality.stressNetProfitUsd - .024) < 1e-12, '5.2 * .995 - 5 - .1 - .04 * 1.25');
  assert(quality.reasons.some(reason => /压力场景/.test(reason)));
  assert.equal(quality.reasons.some(reason => /当前完整交易计划保守净收益/.test(reason)), false);
});

test('demo execution keeps its existing profit threshold without live pressure filtering', async t => {
  const { engine, adapter } = await setup(t);
  const quotes = [engine.plan.buy, engine.plan.bridge, engine.plan.sell], sell = engine.plan.sell;
  const proceeds = new Decimal(sell.minOutRaw).div(new Decimal(10).pow(sell.toToken.decimals)).toNumber();
  const stress = proceeds * .995 - engine.config.risk.amountUsd - quotes.reduce((sum, quote) => sum + quote.feeUsd, 0) * 1.25;
  engine.config.risk.minProfitUsd = (engine.opportunity.netProfitUsd + stress) / 2;
  assert.equal(engine.planQualityReasons(quotes).stressNetProfitUsd, null);
  const trade = await engine.execute();
  assert.equal(trade.status, 'COMPLETED'); assert.equal(adapter.sent.length, 3);
  assert.equal('stressNetProfitUsd' in trade.estimate, false);
});

test('BUY balance-read recheck enforces pressure headroom even when ordinary net profit still passes', async t => {
  const { engine, adapter } = await setup(t); useMockLiveWallets(engine, adapter);
  await engine.loadMarketBalances(); await engine.buildOpportunity();
  engine.config.risk.minProfitUsd = engine.opportunity.stressNetProfitUsd - .01;
  const original = adapter.balances.bind(adapter); let reads = 0;
  adapter.balances = async chain => { const balance = await original(chain); if (++reads === 3) engine.plan.sell.feeUsd += .02; return balance; };
  await assert.rejects(engine.execute(), /压力场景/);
  assert.equal(adapter.sent.length, 0);
});

for (const afterConfirmedLegs of [1, 2]) test(`bridge continuation rechecks live pressure after ${afterConfirmedLegs} confirmed leg(s)`, async t => {
  const { engine, adapter, store } = await setup(t); useMockLiveWallets(engine, adapter);
  let sellQuote, bridgeQuote;
  adapter.options.changeQuote = (quote, name, sent) => {
    if (name === 'BRIDGE' && sent) bridgeQuote = quote;
    if (name === 'SELL' && sent >= afterConfirmedLegs) { quote.amountOutRaw = '5070000'; quote.minOutRaw = '5050000'; sellQuote = quote; }
  };
  await assert.rejects(engine.execute(), /压力场景/);
  const paid = adapter.receipts.reduce((sum, receipt) => sum + receipt.feeUsd + receipt.rentUsd, 0);
  const pending = sellQuote.feeUsd + (afterConfirmedLegs === 1 ? bridgeQuote.feeUsd : 0);
  assert(5.05 - 5 - paid - pending >= engine.config.risk.minProfitUsd, 'ordinary net profit alone would still pass');
  assert.deepEqual(adapter.sent.map(sent => stage(sent.quote)), afterConfirmedLegs === 1 ? ['BUY'] : ['BUY', 'BRIDGE']);
  assert.equal(store.allTrades()[0].status, 'NEEDS_REVIEW');
});
