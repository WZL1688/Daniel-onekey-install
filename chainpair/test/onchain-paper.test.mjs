import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OnchainPaperEngine } from '../src/onchain-research/paper.mjs';
import { ResearchStore } from '../src/onchain-research/store.mjs';
import { convertInventoryAmount } from '../src/policy.mjs';

const clone = value => structuredClone(value);
const raw = (value, decimals) => new Decimal(value).mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
const units = (value, decimals) => new Decimal(value).div(new Decimal(10).pow(decimals));
const safe = message => Object.assign(new Error(message), { safe: true });
const stableAddress = chain => chain === 'bnb' ? '0x3333333333333333333333333333333333333333' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const assetFixture = () => ({ id: 'manual:paper-fixture', revision: 1, symbol: 'FIX', enabled: true, mapping: { confirmed: true, evidence: 'Offline identity fixture only', warning: '' }, chains: {
  bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 6, poolAddress: '0x2222222222222222222222222222222222222222' },
  solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', decimals: 9, poolAddress: '11111111111111111111111111111111' },
} });
class MemoryResearchStore {
  constructor() { this.states = new Map(); this.events = []; this.failCommit = false; }
  getState(key, fallback) { return this.states.has(key) ? clone(this.states.get(key)) : clone(fallback); }
  setState(key, value) { this.states.set(key, clone(value)); return clone(value); }
  commitState(key, value, { kind, record }) {
    if (this.failCommit) { this.failCommit = false; throw Error('fixture persistence failure'); }
    if (this.events.some(row => row.kind === kind && row.record.id === record.id)) return this.getState(key, null);
    this.states.set(key, clone(value)); this.events.push({ kind, record: clone(record) }); return clone(value);
  }
}
function setup(options = {}) {
  let clock = Date.parse('2026-11-24T01:00:00Z'), sequence = 0;
  const asset = assetFixture(), store = options.store || new MemoryResearchStore(), calls = [], opts = options;
  const makeRow = (prices = { bnb: 1, solana: 1.2 }, generation = 'fixture-round') => ({ asset: clone(asset), generation, marketQualified: true, opportunityQualified: true, comparisonStatus: 'comparable', anomalous: false, universe: { eligible: true }, observedAt: clock,
    market: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { priceUsd: prices[chain], observedAt: clock, priceConfidence: 'pool-consensus', tokenAddress: asset.chains[chain].address, poolAddress: asset.chains[chain].poolAddress }])) });
  let row = makeRow();
  function plan(input = {}) {
    const selected = input.row || row, amountUsd = input.amountUsd || 5, buyChain = input.buyChain || 'bnb', sellChain = buyChain === 'bnb' ? 'solana' : 'bnb';
    const tokenDecimals = { bnb: 6, solana: 9 }, stableDecimals = { bnb: 6, solana: 6 };
    const buyMinOutRaw = raw(new Decimal(amountUsd).div(selected.market[buyChain].priceUsd), tokenDecimals[buyChain]);
    const buyAmountOutRaw = new Decimal(buyMinOutRaw).mul('1.001').ceil().toFixed(0);
    const sellAmountRaw = convertInventoryAmount(buyMinOutRaw, tokenDecimals[buyChain], tokenDecimals[sellChain], sellChain).amountRaw;
    const proceeds = units(sellAmountRaw, tokenDecimals[sellChain]).mul(selected.market[sellChain].priceUsd);
    const sellMinOutRaw = raw(proceeds, stableDecimals[sellChain]), sellAmountOutRaw = new Decimal(sellMinOutRaw).plus(1000).toFixed(0);
    const net = units(sellMinOutRaw, stableDecimals[sellChain]).minus(amountUsd).minus(.01).minus(.02).toNumber();
    return { id: `fixture-quote-${++sequence}`, mode: 'research', readOnly: true, executable: false, identityVerified: true, qualityPassed: true, verified: true,
      assetId: asset.id, assetRevision: asset.revision, generation: selected.generation, parentRevision: 0, parentPolicyFingerprint: 'a'.repeat(64), amountUsd, buyChain, sellChain, tokenDecimals, stableDecimals,
      buyAmountInRaw: raw(amountUsd, stableDecimals[buyChain]), buyMinOutRaw, buyAmountOutRaw, sellAmountRaw, sellMinOutRaw, sellAmountOutRaw, buyFeeUsd: .01, sellFeeUsd: .02,
      buyRentUsd: .002, sellRentUsd: .003, netProfitUsd: net, stressNetProfitUsd: units(sellMinOutRaw, stableDecimals[sellChain]).mul('.995').minus(amountUsd).minus('.0375').toNumber(),
      buyQuote: { quoteId: `fixture-buy-${sequence}`, chain: buyChain, amountInRaw: raw(amountUsd, stableDecimals[buyChain]), amountOutRaw: buyAmountOutRaw, minOutRaw: buyMinOutRaw, fromToken: { address: stableAddress(buyChain), decimals: stableDecimals[buyChain], kind: 'stable' }, toToken: { address: asset.chains[buyChain].address, decimals: tokenDecimals[buyChain], kind: 'token' } },
      sellQuote: { quoteId: `fixture-sell-${sequence}`, chain: sellChain, amountInRaw: sellAmountRaw, amountOutRaw: sellAmountOutRaw, minOutRaw: sellMinOutRaw, fromToken: { address: asset.chains[sellChain].address, decimals: tokenDecimals[sellChain], kind: 'token' }, toToken: { address: stableAddress(sellChain), decimals: stableDecimals[sellChain], kind: 'stable' } }, quotedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 20000).toISOString() };
  }
  const quoteClient = {
    async quote(input) { calls.push(['quote', clone(input)]); if (opts.planError) throw opts.planError; const result = plan(input); opts.changePlan?.(result); return result; },
    async quoteSell(input) {
      calls.push(['sell', clone(input)]);
      if (opts.sellPromise) return opts.sellPromise;
      if (opts.sellError) throw opts.sellError;
      const sellChain = input.sellChain, decimals = asset.chains[sellChain].decimals, price = input.row.market[sellChain].priceUsd;
      const proceeds = opts.sellProceedsUsd ?? units(input.amountRaw, decimals).mul(price).toNumber();
      const result = { id: `fixture-later-${++sequence}`, quoteId: `fixture-later-sell-${sequence}`, mode: 'research', readOnly: true, executable: false, verified: true, identityVerified: true,
        assetId: asset.id, assetRevision: asset.revision, generation: input.row.generation, parentRevision: 0, parentPolicyFingerprint: 'a'.repeat(64), chain: sellChain, amountInRaw: input.amountRaw,
        amountOutRaw: raw(new Decimal(proceeds).plus('.001'), 6), minOutRaw: raw(proceeds, 6), fromToken: { address: asset.chains[sellChain].address, decimals, kind: 'token' }, toToken: { address: stableAddress(sellChain), decimals: 6, kind: 'stable' }, feeUsd: .02, estimatedRentUsd: .003,
        quotedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 20000).toISOString() };
      opts.changeSell?.(result); return result;
    }
  };
  const paper = new OnchainPaperEngine({ store, quoteClient, now: () => clock, sleep: async milliseconds => { clock += milliseconds; opts.onSleep?.({ paper, store }); } });
  const start = () => paper.start({ asset: clone(asset), row: clone(row), risk: opts.risk || {} });
  return { paper, store, quoteClient, asset, calls, opts, plan, start, makeRow, get row() { return row; }, setRow: value => { row = value; }, advance: milliseconds => { clock += milliseconds; }, get now() { return clock; } };
}

test('paper creates explicit virtual 50/50 endowment using actual reference marks without inventing profit', () => {
  const ctx = setup(); assert.equal(ctx.paper.snapshot().stats.netEquityUsd, null);
  const state = ctx.start();
  assert.equal(state.contributedCapitalUsd, 200); assert.equal(state.stats.netEquityUsd, 200); assert.equal(state.stats.netEquityPnlUsd, 0);
  assert.equal(state.stats.successfulBothLegsRate, null); assert.equal(ctx.calls.length, 0);
  assert.equal(state.positions.bnb.cashUsd, '50'); assert.equal(state.positions.bnb.tokenRaw, '50000000');
  assert.equal(ctx.store.events[0].record.virtualCapitalContributedUsd, 200);
  assert.throws(() => ctx.start(), /不会重新注入/);
});

test('both modeled fills reference fresh later quotes, exact input and real quoted fees once including rent', async () => {
  const ctx = setup(); ctx.start(); const original = ctx.plan();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: original, delayMs: 1000 });
  assert.equal(trade.status, 'COMPLETED'); assert.equal(trade.chainTransaction, false); assert.equal(trade.buy.feeUsd, .01); assert.equal(trade.sell.feeUsd, .02);
  assert.notEqual(trade.buyQuoteId, original.id); assert.equal(ctx.calls[1][1].amountRaw, trade.sellAmountRaw);
  assert.equal(ctx.calls[1][1].amountRaw, '5000000000'); assert.equal(trade.realizedCashSpreadUsd, .97);
  const state = ctx.paper.snapshot(); assert.equal(state.stats.tradingFeesUsd, .03); assert.equal(state.stats.realizedCashSpreadUsd, .97);
  assert(Math.abs(state.stats.netEquityPnlUsd - -.03) < 1e-10, 'positive cash spread is offset by the changed chain inventory valuation; only fees reduce current marked equity');
  assert.equal(state.stats.successfulBothLegsRate, 1);
  assert.equal(state.reservations.tokenRaw.solana, '0'); assert.equal(state.reservations.cashUsd.bnb, '0');
  assert.equal(ctx.store.events.filter(event => event.kind === 'paper-trade').length, 1);
  assert(!('hash' in trade) && !('transactionHash' in trade));
});

test('price deterioration during latency cancels before any virtual buy and releases reservations', async () => {
  const ctx = setup({ changePlan: result => { result.sellMinOutRaw = raw(5, 6); result.sellAmountOutRaw = raw(5.001, 6); result.netProfitUsd = -.03; result.stressNetProfitUsd = -.06; result.qualityPassed = false; } });
  const before = ctx.start(); const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1000 });
  assert.equal(trade.status, 'REJECTED'); const after = ctx.paper.snapshot();
  assert.deepEqual(after.positions, before.positions); assert.equal(after.stats.tradingFeesUsd, 0); assert.equal(after.stats.successfulBothLegsRate, 0);
  assert.equal(ctx.calls.filter(call => call[0] === 'sell').length, 0); assert.equal(after.reservations.cashUsd.bnb, '0');
});

test('a sell network failure preserves bought quantity and frozen counterpart inventory then pauses', async () => {
  const ctx = setup({ sellError: Error('private unsafe provider content') }); const before = ctx.start();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1000 });
  assert.equal(trade.status, 'NEEDS_REVIEW'); const state = ctx.paper.snapshot();
  assert.equal(state.running, false); assert.equal(state.needsReview, true); assert.equal(state.positions.bnb.cashUsd, '44.99');
  assert.equal(state.positions.bnb.tokenRaw, '55000000'); assert.equal(state.positions.solana.tokenRaw, before.positions.solana.tokenRaw);
  assert.equal(state.reservations.tokenRaw.solana, '5000000000'); assert.equal(state.stats.tradingFeesUsd, .01); assert.equal(state.stats.realizedCashSpreadUsd, 0);
  assert(!JSON.stringify(state).includes('private unsafe provider content'));
  assert.throws(() => ctx.paper.resume({ asset: ctx.asset, row: ctx.row }), /单边虚拟敞口/);
});

test('loss-making post-buy restoration does not automatically sell or rebalance', async () => {
  const ctx = setup({ sellProceedsUsd: 4 }); ctx.start();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 10 });
  assert.equal(trade.status, 'NEEDS_REVIEW'); assert.match(trade.failureReason, /不进行亏损平衡/);
  assert.equal(ctx.paper.snapshot().totals.inventoryRebalanceLossUsd, 0); assert.equal(ctx.paper.snapshot().positions.bnb.tokenRaw, '55000000');
});

test('mismatched, expired or incomplete sell evidence cannot manufacture a profitable completed trade', async t => {
  for (const changeSell of [result => { result.amountInRaw = '1'; }, result => { result.feeUsd = undefined; }, result => { result.expiresAt = '2020-01-01'; }, result => { result.identityVerified = false; }, result => { result.assetRevision++; }]) {
    const ctx = setup({ changeSell }); ctx.start();
    const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 });
    assert.equal(trade.status, 'NEEDS_REVIEW'); assert.equal(ctx.paper.snapshot().stats.completedTrades, 0);
  }
});

test('unknown identity, stale marks and same symbol with different addresses cannot seed paper', () => {
  const ctx = setup(); const wrong = clone(ctx.asset); wrong.mapping.confirmed = false;
  assert.throws(() => ctx.paper.start({ asset: wrong, row: ctx.row }), /核验两链1:1/);
  const different = clone(ctx.row); different.asset.chains.bnb.address = '0x9999999999999999999999999999999999999999';
  assert.throws(() => ctx.paper.start({ asset: ctx.asset, row: different }), /身份不一致/);
  ctx.advance(120001); assert.throws(() => ctx.start(), /已过期/);
  assert.equal(ctx.paper.snapshot().sessionId, null);
});

test('virtual inventory and cash exhaustion are checked before any quote requests', async () => {
  for (const position of ['cash', 'token']) {
    const ctx = setup(); ctx.start();
    if (position === 'cash') ctx.paper.state.positions.bnb.cashUsd = '0'; else ctx.paper.state.positions.solana.tokenRaw = '1';
    await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan() }), position === 'cash' ? /虚拟现金不足/ : /库存耗尽/);
    assert.equal(ctx.calls.length, 0); assert.equal(ctx.paper.snapshot().stats.attemptedTrades, 0);
  }
});

test('duplicate order IDs cannot replay virtual fills and neither pause nor resume reinjects capital', async () => {
  const ctx = setup(); ctx.start(); const quote = ctx.plan();
  await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote, delayMs: 1 });
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote, delayMs: 1 }), /禁止重复订单/);
  const before = ctx.paper.snapshot().positions;
  ctx.paper.pause(); ctx.paper.resume({ asset: ctx.asset, row: ctx.row });
  assert.deepEqual(ctx.paper.snapshot().positions, before); assert.equal(ctx.paper.snapshot().contributedCapitalUsd, 200);
});

test('restarting a virtual buy awaiting a sell retains durable exposure and never replays quotes', async () => {
  const ctx = setup({ sellPromise: new Promise(() => {}) }); ctx.start();
  void ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.store.getState('paper.current.v1', null).currentTrade.status, 'BUY_FILLED');
  const restarted = new OnchainPaperEngine({ store: ctx.store, quoteClient: ctx.quoteClient, now: () => ctx.now, sleep: async () => {} });
  const state = restarted.snapshot(); assert.equal(state.running, false); assert.equal(state.needsReview, true); assert.equal(state.currentTrade.status, 'NEEDS_REVIEW');
  assert.equal(state.currentTrade.buy.receivedRaw, '5000000'); assert.equal(state.positions.bnb.tokenRaw, '55000000');
  assert.equal(state.stats.attemptedTrades, 1); assert.equal(state.stats.successfulBothLegsRate, 0); assert.equal(state.stats.unknownTrades, 1);
  assert.throws(() => restarted.resume({ asset: ctx.asset, row: ctx.row }), /单边虚拟敞口/);
});

test('profitable reverse trades reduce inventory deviation before worsening directions', async () => {
  const ctx = setup(); ctx.start(); await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 });
  ctx.advance(10); const reverseRow = ctx.makeRow({ bnb: 1.2, solana: 1 }, 'reverse-round'); ctx.setRow(reverseRow); ctx.paper.mark({ asset: ctx.asset, row: reverseRow });
  const reverse = ctx.plan({ row: reverseRow, buyChain: 'solana' }), threshold = ctx.paper.threshold(reverse);
  assert.equal(threshold.restoresInventory, true); assert.equal(threshold.adjustmentReserveUsd, 0);
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: reverseRow, quote: reverse, delayMs: 1 });
  assert.equal(trade.status, 'COMPLETED'); assert.equal(trade.threshold.restoresInventory, true); assert.equal(ctx.paper.snapshot().stats.completedTrades, 2);
});

test('daily loss, token exposure and inventory losses block additional paper risk', async () => {
  const ctx = setup(); ctx.start();
  ctx.paper.state.daily.realizedCashSpreadUsd = -5;
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan() }), /最大单日亏损/);
  ctx.paper.state.daily.realizedCashSpreadUsd = 0; ctx.paper.setSettings({ maxExposureUsd: 2 });
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan() }), /单边敞口/);
  ctx.paper.setSettings({ maxExposureUsd: 50, maxTokenExposureUsd: 1 });
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan() }), /单币虚拟库存/);
});

test('fresh real mark losses update drawdown; missing current prices remain unknown rather than zero', () => {
  const ctx = setup(); ctx.start(); ctx.advance(1000);
  const lower = ctx.makeRow({ bnb: .5, solana: .6 }, 'lower-mark'); ctx.paper.mark({ asset: ctx.asset, row: lower });
  const marked = ctx.paper.snapshot(); assert.equal(marked.running, false); assert.match(marked.pausedReason, /持币浮亏|标记净值损失/);
  assert(marked.stats.maxDrawdownPct > 20); assert(marked.stats.unrealizedPnlUsd < -40);
  ctx.advance(120001); const stale = ctx.paper.snapshot();
  assert.equal(stale.stats.netEquityUsd, null); assert.equal(stale.stats.unrealizedPnlUsd, null); assert(stale.stats.maxDrawdownPct > 20);
});

test('failed durable reservation leaves no invented trade and no stuck process mutex', async () => {
  const ctx = setup(); const before = ctx.start(); ctx.store.failCommit = true;
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan() }), /未能持久化/);
  const after = ctx.paper.snapshot(); assert.equal(after.busy, false); assert.deepEqual(after.positions, before.positions);
  assert.equal(after.currentTrade, null); assert.equal(after.stats.attemptedTrades, 0);
});

test('an explicit stop during latency cancels the pending buy and never turns on a live engine', async () => {
  let once = false;
  const ctx = setup({ onSleep: ({ paper }) => { if (!once) { once = true; paper.pause('global-stop'); } } }); ctx.start();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 });
  assert.equal(trade.status, 'REJECTED'); assert.equal(ctx.calls.length, 0); assert.equal(ctx.paper.snapshot().running, false);
  assert(!('engine' in ctx.paper)); assert(!('signer' in ctx.paper));
});

test('an explicit binding guard can invalidate scanner or configuration changes across asynchronous calls', async () => {
  const ctx = setup(); ctx.start();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1, assertCurrent: () => { throw safe('配置改变'); } });
  assert.equal(trade.status, 'REJECTED'); assert.equal(ctx.calls.length, 0); assert.match(trade.failureReason, /配置改变/);
});

test('prepared quote amounts, metadata and accounting inconsistencies cannot bypass risk checks', async () => {
  for (const change of [quote => { quote.sellAmountRaw = '1'; }, quote => { quote.netProfitUsd = 100000; }, quote => { quote.tokenDecimals.bnb = 18; }, quote => { quote.buyFeeUsd = null; }, quote => { quote.qualityPassed = false; }]) {
    const ctx = setup(); ctx.start(); const quote = ctx.plan(); change(quote);
    await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote }), /paper/); assert.equal(ctx.calls.length, 0);
  }
});

test('paper never fabricates fourteen days or emits live receipts when its source quotes fail', async () => {
  const ctx = setup({ planError: safe('apiKey=do-not-echo https://rpc.example/private-token') }); ctx.start();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 10 });
  assert.equal(trade.status, 'REJECTED'); assert(!JSON.stringify(trade).includes('do-not-echo')); assert(!JSON.stringify(trade).includes('private-token'));
  assert.equal(ctx.paper.snapshot().stats.realizedCashSpreadUsd, 0); assert.equal(ctx.paper.snapshot().createdAt, '2026-11-24T01:00:00.000Z');
  assert(!('validated14Days' in ctx.paper.snapshot()));
});

test('positive cash spread cannot bypass the daily marked-equity loss budget', async () => {
  const ctx = setup({ risk: { maxDailyLossUsd: .01 } }); ctx.start();
  const quote = ctx.plan(); assert(quote.netProfitUsd > .9);
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote }), /标记净值损失.*最大单日亏损/);
  assert.equal(ctx.calls.length, 0); assert.equal(ctx.paper.snapshot().stats.attemptedTrades, 0);
});

test('post-buy policy drift cannot supply an unrelated sell result to complete the ledger', async () => {
  const ctx = setup({ changeSell: result => { result.parentRevision++; } }); ctx.start();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 });
  assert.equal(trade.status, 'NEEDS_REVIEW'); assert.equal(ctx.paper.snapshot().stats.completedTrades, 0);
});

test('real independent SQLite persistence retains balances, modeled fills and a restart-safe session', async t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'paper-sqlite-'));
  let store = new ResearchStore({ dataDir });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const ctx = setup({ store }); ctx.start(); const quote = ctx.plan();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote, delayMs: 1 });
  assert.equal(trade.status, 'COMPLETED'); const snapshot = ctx.paper.snapshot();
  assert.equal(store.list('paper-trade').items.length, 1); assert(store.list('paper-event').total >= 3);
  store.close(); store = new ResearchStore({ dataDir });
  const restarted = new OnchainPaperEngine({ store, quoteClient: ctx.quoteClient, now: () => ctx.now, sleep: async () => {} });
  assert.deepEqual(restarted.snapshot().positions, snapshot.positions);
  assert.equal(restarted.snapshot().stats.completedTrades, 1); assert.equal(restarted.snapshot().stats.realizedCashSpreadUsd, .97);
  await assert.rejects(restarted.execute({ asset: ctx.asset, row: ctx.row, quote, delayMs: 1 }), /禁止重复订单/);
});

test('a different stable-token recipient asset cannot be counted as dollar proceeds after buy', async () => {
  const ctx = setup({ changeSell: result => { result.toToken.address = '0x9999999999999999999999999999999999999999'; } }); ctx.start();
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 });
  assert.equal(trade.status, 'NEEDS_REVIEW'); assert.equal(ctx.paper.snapshot().stats.realizedCashSpreadUsd, 0);
});

test('exact virtual input and nested quote evidence must agree before modeling any fill', async () => {
  const ctx = setup(); ctx.start(); const quote = ctx.plan(); quote.buyAmountInRaw = '1';
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote }), /准确输入/);
  assert.equal(ctx.calls.length, 0);
  const fees = ctx.paper.snapshot().stats;
  assert.equal(fees.quotedNetworkFeesUsd, 0); assert.equal(fees.explicitDexTradingFeesUsd, null);
});

function sqliteFaultFixture(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'paper-atomic-fault-'));
  const resource = { store: new ResearchStore({ dataDir }) };
  t.after(() => { resource.store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const ctx = setup({ store: resource.store });
  return { ctx, resource, reopen() {
    resource.store.close(); resource.store = new ResearchStore({ dataDir });
    return new OnchainPaperEngine({ store: resource.store, quoteClient: ctx.quoteClient, now: () => ctx.now, sleep: async () => {} });
  } };
}

test('SQLite rollback at BUY_FILLED discards an uncommitted buy and all associated balances and fees', async t => {
  const { ctx, resource, reopen } = sqliteFaultFixture(t), initial = ctx.start();
  // The predicate can only match after commitState has executed its state UPDATE.
  // Aborting the later record INSERT tests the actual SQLite transaction rollback.
  resource.store.db.exec(`CREATE TRIGGER paper_fail_buy BEFORE INSERT ON research_records
    WHEN json_extract(NEW.document,'$.status')='BUY_FILLED'
      AND (SELECT json_extract(document,'$.currentTrade.status') FROM research_state WHERE key='paper.current.v1')='BUY_FILLED'
    BEGIN SELECT RAISE(ABORT,'offline injected buy event failure'); END;`);
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 });
  const state = ctx.paper.snapshot(), durable = resource.store.getState('paper.current.v1');
  assert.equal(trade.status, 'REJECTED'); assert.equal(trade.buy, undefined); assert.equal(trade.sell, undefined);
  assert.equal(trade.failureEvidence.persistenceStage, 'BUY_FILLED'); assert.equal(trade.failureEvidence.rollbackStage, 'BUY_READY');
  assert.deepEqual(state.positions, initial.positions); assert.deepEqual(state.positions, durable.positions);
  assert.equal(state.stats.completedTrades, 0); assert.equal(state.stats.tradingFeesUsd, 0); assert.equal(state.stats.realizedCashSpreadUsd, 0);
  assert.equal(state.running, false); assert.equal(state.currentTrade, null); assert.equal(state.reservations.tokenRaw.solana, '0');
  assert.equal(ctx.calls.filter(call => call[0] === 'sell').length, 0);
  assert(!resource.store.list('paper-event', { pageSize: 100 }).items.some(event => event.status === 'BUY_FILLED'));
  assert.equal(resource.store.list('paper-trade').items[0].status, 'REJECTED');
  const count = ctx.calls.length, restarted = reopen();
  assert.deepEqual(restarted.snapshot().positions, initial.positions); assert.equal(restarted.snapshot().stats.completedTrades, 0);
  assert.equal(restarted.snapshot().running, false); assert.equal(ctx.calls.length, count);
});

test('SQLite rollback at COMPLETED retains only the durable buy and never counts the uncommitted sell or profit', async t => {
  const { ctx, resource, reopen } = sqliteFaultFixture(t), initial = ctx.start();
  resource.store.db.exec(`CREATE TRIGGER paper_fail_completed BEFORE INSERT ON research_records
    WHEN json_extract(NEW.document,'$.status')='COMPLETED'
      AND (SELECT json_extract(document,'$.totals.completedTrades') FROM research_state WHERE key='paper.current.v1')=1
      AND (SELECT json_extract(document,'$.latestTrade.status') FROM research_state WHERE key='paper.current.v1')='COMPLETED'
    BEGIN SELECT RAISE(ABORT,'offline injected completed event failure'); END;`);
  const trade = await ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 });
  const state = ctx.paper.snapshot(), durable = resource.store.getState('paper.current.v1');
  assert.equal(trade.status, 'NEEDS_REVIEW'); assert(trade.buy); assert.equal(trade.sell, undefined);
  assert.equal(trade.realizedCashSpreadUsd, undefined); assert.equal(trade.failureEvidence.persistenceStage, 'COMPLETED');
  assert.equal(trade.failureEvidence.rollbackStage, 'BUY_FILLED');
  assert.equal(state.positions.bnb.cashUsd, '44.99'); assert.equal(state.positions.bnb.tokenRaw, '55000000');
  assert.deepEqual(state.positions.solana, initial.positions.solana);
  assert.deepEqual(state.positions, durable.positions);
  assert.equal(state.stats.tradingFeesUsd, .01); assert.equal(state.stats.completedTrades, 0); assert.equal(state.stats.realizedCashSpreadUsd, 0);
  assert.equal(state.currentTrade.status, 'NEEDS_REVIEW'); assert.equal(state.reservations.tokenRaw.solana, '5000000000');
  assert.equal(state.running, false); assert.equal(state.needsReview, true);
  assert(!resource.store.list('paper-trade').items.some(record => record.status === 'COMPLETED'));
  const calls = ctx.calls.length, restarted = reopen();
  assert.deepEqual(restarted.snapshot().positions, state.positions);
  assert.equal(restarted.snapshot().stats.completedTrades, 0); assert.equal(restarted.snapshot().stats.tradingFeesUsd, .01);
  assert.equal(restarted.snapshot().currentTrade.status, 'NEEDS_REVIEW'); assert.equal(ctx.calls.length, calls);
  assert.throws(() => restarted.resume({ asset: ctx.asset, row: ctx.row }), /未完成阶段|单边虚拟敞口/);
});

test('persistent SQLite failures expose only the last durable balances and block any replay', async t => {
  const { ctx, resource, reopen } = sqliteFaultFixture(t), initial = ctx.start();
  // BUY stages are durable; completion and all subsequent recovery writes fail.
  resource.store.db.exec(`CREATE TRIGGER paper_fail_persistently BEFORE INSERT ON research_records
    WHEN json_extract(NEW.document,'$.status') NOT IN ('QUEUED','BUY_READY','BUY_FILLED')
    BEGIN SELECT RAISE(ABORT,'offline persistent event failure'); END;`);
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 }), /阶段未能持久化/);
  const state = ctx.paper.snapshot(), durable = resource.store.getState('paper.current.v1');
  assert.equal(state.persistenceFailure.status, 'NEEDS_REVIEW'); assert.equal(state.persistenceFailure.restoredFrom, 'persistent-state');
  assert.equal(state.running, false); assert.equal(state.needsReview, true); assert.match(state.pausedReason, /存储失败/);
  assert.equal(state.busy, false); assert.equal(state.currentTrade.status, 'BUY_FILLED'); assert.equal(state.currentTrade.sell, undefined);
  assert.deepEqual(state.positions, durable.positions); assert.deepEqual(state.positions.solana, initial.positions.solana);
  assert.equal(state.stats.completedTrades, 0); assert.equal(state.stats.realizedCashSpreadUsd, 0); assert.equal(state.stats.tradingFeesUsd, .01);
  assert.equal(state.stats.unknownTrades, 1); assert.equal(resource.store.list('paper-trade').total, 0);
  const calls = ctx.calls.length;
  await assert.rejects(ctx.paper.execute({ asset: ctx.asset, row: ctx.row, quote: ctx.plan(), delayMs: 1 }), /存储故障/);
  assert.throws(() => ctx.paper.resume({ asset: ctx.asset, row: ctx.row }), /未完成阶段|存储故障/);
  assert.equal(ctx.calls.length, calls);
  resource.store.db.exec('DROP TRIGGER paper_fail_persistently');
  const restarted = reopen();
  assert.equal(restarted.snapshot().currentTrade.status, 'NEEDS_REVIEW');
  assert.equal(restarted.snapshot().running, false); assert.deepEqual(restarted.snapshot().positions, durable.positions);
  assert.equal(restarted.snapshot().stats.completedTrades, 0); assert.equal(ctx.calls.length, calls);
});
