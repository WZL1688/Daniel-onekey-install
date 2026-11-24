import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchStore } from '../src/onchain-research/store.mjs';
import { OnchainPaperEngine } from '../src/onchain-research/paper.mjs';

const INITIAL = Date.parse('2026-11-24T00:00:00Z'), POLICY = 'a'.repeat(64), OTHER_POLICY = 'b'.repeat(64);
const addresses = { bnb: '0x1111111111111111111111111111111111111111', solana: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr' };
const pools = { bnb: '0x2222222222222222222222222222222222222222', solana: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' };
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onchain-history-')); let clock = INITIAL;
  const ctx = { dir, now: () => clock, advance: ms => { clock += ms; }, setTime: value => { clock = value; } };
  ctx.store = new ResearchStore({ dataDir: dir, now: ctx.now });
  ctx.restart = () => { ctx.store.close(); ctx.store = new ResearchStore({ dataDir: dir, now: ctx.now }); };
  t.after(() => { ctx.store.close(); rmSync(dir, { recursive: true, force: true }); }); return ctx;
}
function row(ctx, generation, patch = {}) {
  const at = ctx.now(), result = { asset: { id: 'coingecko:fixture', name: 'Fixture', symbol: 'SAME', revision: 1, enabled: true, mapping: { confirmed: true, warning: '' }, chains: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { address: addresses[chain], poolAddress: pools[chain] }])) },
    generation, observedAt: at, universe: { eligible: true }, marketQualified: true, opportunityQualified: true, comparisonStatus: 'comparable', anomalous: false, buyChain: 'bnb', sellChain: 'solana', spreadBps: 500,
    market: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { tokenAddress: addresses[chain], poolAddress: pools[chain], priceUsd: chain === 'bnb' ? .01 : .0105, liquidityUsd: 100000, observedAt: at, priceConfidence: 'pool-consensus', priceConflict: false }])) };
  return { ...result, ...patch };
}
function observe(ctx, value, policy = POLICY, interval = 60000) {
  return ctx.store.observeScan({ rows: Array.isArray(value) ? value : [value], completedAt: ctx.now(), policyFingerprint: policy, pollIntervalMs: interval });
}
function quote(ctx, id, generation, patch = {}) {
  return { id, readOnly: true, executable: false, assetId: 'coingecko:fixture', assetRevision: 1, parentPolicyFingerprint: POLICY, referenceGeneration: generation,
    amountUsd: 5, buyChain: 'bnb', sellChain: 'solana', identityVerified: true, qualityPassed: true, netProfitUsd: .15, stressNetProfitUsd: .1,
    gasUsd: .01, slippageUsd: .02, priceImpactBps: 10, estimatedRentUsd: 0, quotedAt: new Date(ctx.now()).toISOString(), expiresAt: new Date(ctx.now() + 20000).toISOString(), ...patch };
}

test('research storage is a private separate database with no invented observation coverage', t => {
  const ctx = fixture(t), coverage = ctx.store.coverage();
  assert.equal(existsSync(path.join(ctx.dir, 'archive.sqlite')), false);
  assert.equal(existsSync(path.join(ctx.dir, 'onchain-research.sqlite')), true);
  if (process.platform !== 'win32') assert.equal(statSync(ctx.store.file).mode & 0o777, 0o600);
  assert.equal(coverage.validated14Days, false); assert.equal(coverage.validDurationMs, 0); assert.equal(coverage.observations, 0); assert.equal(coverage.firstAt, null);
  assert.equal(ctx.store.rankings().length, 0); assert.throws(() => ctx.store.coverage({ requiredDays: 1 }), /至少需要14天/);
});

test('state commits and events are atomic, idempotent and redact secret or raw transaction data', t => {
  const ctx = fixture(t), store = ctx.store;
  const state = { balance: '12.3', apiSecret: 'do-not-store', nested: { signedTransactionBase64: 'signed-bytes', headers: { Authorization: 'secret' }, privateKey: 'hidden' }, message: 'apiKey=canary https://secret.example/path?key=canary' };
  store.commitState('paper.current.v1', state, { kind: 'paper-event', record: { id: 'event-1', mode: 'paper', status: 'OPEN', tx: { data: 'raw-signed' }, amountRaw: '1000000000000000000' } });
  const saved = store.getState('paper.current.v1'), event = store.list('paper-event').items[0];
  assert.equal(saved.balance, '12.3'); assert.equal(saved.apiSecret, undefined); assert.deepEqual(saved.nested, {}); assert(!JSON.stringify(saved).includes('canary'));
  assert.equal(event.tx, undefined); assert.equal(event.amountRaw, '1000000000000000000');
  store.commitState('paper.current.v1', { balance: '999' }, { kind: 'paper-event', record: { id: 'event-1', status: 'REPLAY' } });
  assert.equal(store.getState('paper.current.v1').balance, '12.3'); assert.equal(store.list('paper-event').total, 1);
  assert.throws(() => store.commitState('paper.current.v1', { balance: '666' }, { kind: 'private-order', record: { id: 'x' } }), /类型无效/);
  assert.equal(store.getState('paper.current.v1').balance, '12.3');
  assert.deepEqual(store.getState('missing', { value: 1 }), { value: 1 });
  assert.throws(() => store.append('trades', { id: 'x' }), /类型无效/);
  assert.throws(() => store.list('paper-event', { page: 0 }), /分页/);
});

test('new generations count sampled durations and recurrence while duplicate snapshots never extend them', t => {
  const ctx = fixture(t);
  assert.equal(observe(ctx, row(ctx, 'g1')).accepted, 1);
  assert.equal(observe(ctx, row(ctx, 'g1')).duplicates, 1);
  ctx.advance(60000); observe(ctx, row(ctx, 'g2'));
  ctx.advance(60000); observe(ctx, row(ctx, 'g3', { opportunityQualified: false }));
  ctx.advance(60000); observe(ctx, row(ctx, 'g4'));
  ctx.advance(60000); observe(ctx, row(ctx, 'g5', { buyChain: 'solana', sellChain: 'bnb' }));
  const ranked = ctx.store.rankings()[0], coverage = ctx.store.coverage();
  assert.equal(ranked.observations, 5); assert.equal(ranked.refPositiveSamples, 4); assert.equal(ranked.episodes, 3);
  assert.equal(ranked.referenceDurationMs, 60000); assert.equal(ranked.dualDirections, true);
  assert.equal(coverage.validDurationMs, 240000); assert.equal(coverage.currentContinuousMs, 240000);
  ctx.advance(10000); assert.equal(ctx.store.coverage().currentContinuousMs, 240000, 'GET time cannot manufacture extra observations');
});

test('outage and restart preserve history but never fill missing time or retain a stale green quote', t => {
  const ctx = fixture(t); observe(ctx, row(ctx, 'a')); ctx.advance(60000); observe(ctx, row(ctx, 'b'));
  ctx.store.recordQuote(quote(ctx, 'quote-1', 'b')); assert.equal(ctx.store.rankings()[0].currentQuotePassed, true);
  ctx.advance(180000); ctx.restart();
  let coverage = ctx.store.coverage(); assert.equal(coverage.currentContinuousMs, 0); assert.equal(coverage.validDurationMs, 60000); assert.equal(coverage.gapCount, 1);
  assert.equal(ctx.store.rankings()[0].currentQuotePassed, false);
  observe(ctx, row(ctx, 'c')); coverage = ctx.store.coverage();
  assert.equal(coverage.currentContinuousMs, 0); assert.equal(coverage.validDurationMs, 60000); assert.equal(coverage.gapCount, 1); assert.equal(coverage.observations, 3);
});

test('even a short restart breaks continuity and reference duration without deleting historical evidence', t => {
  const ctx = fixture(t); observe(ctx, row(ctx, 'before-1')); ctx.advance(60000); observe(ctx, row(ctx, 'before-2'));
  ctx.store.recordQuote(quote(ctx, 'before-restart-quote', 'before-2'));
  ctx.advance(10000); ctx.restart();
  let coverage = ctx.store.coverage();
  assert.equal(coverage.currentContinuousMs, 0); assert.equal(coverage.validDurationMs, 60000); assert.equal(coverage.longestContinuousMs, 60000); assert.equal(coverage.gapCount, 1);
  assert.equal(ctx.store.list('quote').total, 1); assert.equal(ctx.store.rankings()[0].referenceDurationMs, 60000);
  ctx.advance(10000); observe(ctx, row(ctx, 'after-1'));
  coverage = ctx.store.coverage();
  assert.equal(coverage.observations, 3); assert.equal(coverage.validDurationMs, 60000); assert.equal(coverage.currentContinuousMs, 0);
  assert.equal(ctx.store.rankings()[0].referenceDurationMs, 60000);
  ctx.advance(60000); observe(ctx, row(ctx, 'after-2'));
  assert.equal(ctx.store.coverage().validDurationMs, 120000); assert.equal(ctx.store.coverage().currentContinuousMs, 60000);
  assert.equal(ctx.store.rankings()[0].referenceDurationMs, 120000);
});

test('known invalid or conflicting observations break continuity instead of silently bridging them', t => {
  const ctx = fixture(t); observe(ctx, row(ctx, 'a')); ctx.advance(60000); observe(ctx, row(ctx, 'b'));
  const duplicateConflict = row(ctx, 'b'); duplicateConflict.market.bnb.priceUsd = 99;
  assert.equal(observe(ctx, duplicateConflict).rejected, 1); assert.equal(ctx.store.coverage().currentContinuousMs, 0);
  ctx.advance(60000); observe(ctx, row(ctx, 'c')); assert.equal(ctx.store.coverage().currentContinuousMs, 0);
  ctx.advance(60000); const bad = row(ctx, 'd', { anomalous: true, comparisonStatus: 'quarantined', marketQualified: false });
  assert.equal(observe(ctx, bad).rejected, 1);
  ctx.advance(60000); observe(ctx, row(ctx, 'e')); assert.equal(ctx.store.coverage().validDurationMs, 60000);
  const stale = row(ctx, 'stale'); stale.market.bnb.observedAt = ctx.now() - 120001;
  assert.equal(observe(ctx, stale).rejected, 1);
});

test('clock rollback, future samples, malformed identity and stale source data cannot produce coverage', t => {
  const ctx = fixture(t); observe(ctx, row(ctx, 'a')); ctx.advance(60000); observe(ctx, row(ctx, 'b'));
  ctx.advance(-30000); assert.equal(observe(ctx, row(ctx, 'clock-back')).rejected, 1); assert.equal(ctx.store.coverage().currentContinuousMs, 0);
  assert.throws(() => ctx.store.observeScan({ rows: [], completedAt: ctx.now() + 2000, policyFingerprint: POLICY }), /参数无效/);
  const wrong = row(ctx, 'wrong'); wrong.market.bnb.tokenAddress = '0x9999999999999999999999999999999999999999'; assert.equal(observe(ctx, wrong).rejected, 1);
  const future = row(ctx, 'future'); future.market.solana.observedAt += 2000; assert.equal(observe(ctx, future).rejected, 1);
});

test('same ticker, identity changes and policy changes remain separate current scopes', t => {
  const ctx = fixture(t), first = row(ctx, 'a'), second = row(ctx, 'a'); second.asset.id = 'coingecko:other'; second.asset.chains.bnb.address = '0x9999999999999999999999999999999999999999'; second.market.bnb.tokenAddress = second.asset.chains.bnb.address;
  observe(ctx, [first, second]); assert.equal(ctx.store.rankings().length, 2);
  ctx.advance(60000); observe(ctx, row(ctx, 'b'));
  const old = ctx.store.rankings().find(value => value.assetId === first.asset.id).scopeId;
  ctx.advance(60000); const changed = row(ctx, 'c'); changed.asset.revision = 2; observe(ctx, changed);
  let current = ctx.store.rankings().find(value => value.assetId === first.asset.id); assert.notEqual(current.scopeId, old); assert.equal(current.observations, 1);
  ctx.advance(60000); observe(ctx, row(ctx, 'policy'), OTHER_POLICY); current = ctx.store.rankings().find(value => value.assetId === first.asset.id);
  assert.equal(current.policyFingerprint, OTHER_POLICY); assert.equal(current.observations, 1);
  ctx.advance(60000); observe(ctx, row(ctx, 'return-policy')); assert.equal(ctx.store.coverage({ assetId: first.asset.id }).currentContinuousMs, 0, 'returning to an old scope cannot bridge identity/policy changes');
});

test('real quote metrics require fresh complete evidence and verified identity, and do not merge multiple tiers into recurrence', t => {
  const ctx = fixture(t); observe(ctx, row(ctx, 'g1'));
  ctx.store.recordQuote(quote(ctx, 'unverified', 'g1', { identityVerified: false }));
  ctx.store.recordQuote(quote(ctx, 'incomplete', 'g1', { gasUsd: undefined }));
  assert.equal(ctx.store.rankings()[0].positiveRealQuoteSamples, 0);
  ctx.store.recordQuote(quote(ctx, 'q1', 'g1')); ctx.store.recordQuote(quote(ctx, 'q1', 'g1', { netProfitUsd: 999 }));
  ctx.store.recordQuote(quote(ctx, 'q2', 'g1', { amountUsd: 10 }));
  let ranked = ctx.store.rankings()[0]; assert.equal(ranked.positiveRealQuoteSamples, 2); assert.equal(ranked.directionStats.find(value => value.direction === 'bnb->solana').positiveQuoteGenerations, 1);
  ctx.store.recordQuote(quote(ctx, 'reverse1', 'g1', { buyChain: 'solana', sellChain: 'bnb' }));
  assert.equal(ctx.store.rankings()[0].repeatedBidirectionalQuotes, false);
  ctx.advance(30000); observe(ctx, row(ctx, 'g2'));
  ctx.store.recordQuote(quote(ctx, 'forward2', 'g2')); ctx.store.recordQuote(quote(ctx, 'reverse2', 'g2', { buyChain: 'solana', sellChain: 'bnb' }));
  ranked = ctx.store.rankings()[0]; assert.equal(ranked.repeatedBidirectionalQuotes, true); assert.equal(ranked.currentQuotePassed, true);
  ctx.advance(21000); assert.equal(ctx.store.rankings()[0].currentQuotePassed, false);
  assert.equal(ctx.store.list('quote', { page: 1, pageSize: 2 }).total, 7);
  assert.throws(() => ctx.store.recordQuote({ ...quote(ctx, 'bad', 'g2'), executable: true }), /只读/);
});

test('two observations separated by fourteen days do not constitute fourteen-day verification', t => {
  const ctx = fixture(t); observe(ctx, row(ctx, 'start')); ctx.advance(14 * 86400000); observe(ctx, row(ctx, 'end'));
  const coverage = ctx.store.coverage(); assert.equal(coverage.elapsedMs, 14 * 86400000); assert.equal(coverage.validDurationMs, 0); assert.equal(coverage.validated14Days, false);
});

test('a new scan generation invalidates the current quote even before its expiry while preserving historical evidence', t => {
  const ctx = fixture(t); observe(ctx, row(ctx, 'first'));
  ctx.store.recordQuote(quote(ctx, 'initial-report', 'first')); assert.equal(ctx.store.rankings()[0].currentQuotePassed, true);
  ctx.advance(5000); observe(ctx, row(ctx, 'second'));
  const ranked = ctx.store.rankings()[0];
  assert.equal(ranked.latestQuote.fresh, true); assert.equal(ranked.latestQuote.stale, true); assert.equal(ranked.currentQuotePassed, false);
  assert.equal(ranked.positiveRealQuoteSamples, 1); assert.equal(ctx.store.list('quote').items[0].qualityPassed, true, 'historical data is not rewritten as a current failure');
  ctx.store.recordQuote(quote(ctx, 'fresh-report', 'second')); assert.equal(ctx.store.rankings()[0].currentQuotePassed, true);
});

test('quote archives retain exact public quantities, fee components and evidence limits without raw transactions', t => {
  const ctx = fixture(t); observe(ctx, row(ctx, 'evidence'));
  const input = quote(ctx, 'public-evidence', 'evidence', { symbol: 'FIX', buyMinOutRaw: '4500000000000000000', sellMinOutRaw: '5100000', buyFeeUsd: .004, sellFeeUsd: .006, tokenDecimals: { bnb: 18, solana: 6 }, limitations: ['Current simulation is not a future fill guarantee'],
    buyQuote: { id: 'buy-id', fromChain: 'bnb', amountInRaw: '5000000000000000000', minOutRaw: '4500000000000000000', fromToken: { address: addresses.bnb, decimals: 18, kind: 'token' }, tx: { data: 'raw-secret' }, headers: { 'OK-ACCESS-KEY': 'private-api' } } });
  ctx.store.recordQuote(input); const saved = ctx.store.list('quote').items[0];
  assert.equal(saved.symbol, 'FIX'); assert.equal(saved.buyMinOutRaw, input.buyMinOutRaw); assert.equal(saved.sellMinOutRaw, input.sellMinOutRaw);
  assert.equal(saved.buyFeeUsd + saved.sellFeeUsd, .01); assert.deepEqual(saved.tokenDecimals, { bnb: 18, solana: 6 });
  assert.equal(saved.buyQuote.id, 'buy-id'); assert.equal(saved.buyQuote.tx, undefined); assert.equal(saved.buyQuote.headers, undefined);
  assert(!JSON.stringify(saved).includes('private-api')); assert.deepEqual(saved.limitations, input.limitations);
});

test('stored real-quote report roundtrips binding and precision for direct paper plan validation', t => {
  const ctx = fixture(t), marketRow = row(ctx, 'roundtrip');
  marketRow.asset.mapping.evidence = 'Synthetic official-mapping fixture only';
  marketRow.asset.chains.bnb.decimals = 18; marketRow.asset.chains.solana.decimals = 6;
  observe(ctx, marketRow);
  const input = quote(ctx, 'roundtrip-quote', 'roundtrip', { parentRevision: 4, verified: true, parentPolicyFingerprint: POLICY,
    tokenDecimals: { bnb: 18, solana: 6 }, stableDecimals: { bnb: 18, solana: 6 }, addresses, pools,
    buyAmountInRaw: '5000000000000000000', buyAmountOutRaw: '501000000000000000000', buyMinOutRaw: '500000000000000000000', tokenAmountRaw: '500000000000000000000', sellAmountRaw: '500000000', sellMinOutRaw: '5160000', sellAmountOutRaw: '5170000', dustBuyRaw: '0',
    buyFeeUsd: .01, sellFeeUsd: .01, buyRentUsd: 0, sellRentUsd: 0, feeUsd: .02, gasUsd: .02, netProfitUsd: .14,
    arbitraryPayload: { transaction: 'must-not-retain' }, raw: { secretKey: 'must-not-retain' }, headers: { Authorization: 'must-not-retain' } });
  input.buyQuote = { quoteId: 'roundtrip-buy', chain: 'bnb', amountInRaw: input.buyAmountInRaw, amountOutRaw: input.buyAmountOutRaw, minOutRaw: input.buyMinOutRaw,
    fromToken: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, kind: 'stable' }, toToken: { address: addresses.bnb, decimals: 18, kind: 'token' }, feeUsd: .01, estimatedRentUsd: 0, headers: { Authorization: 'must-not-retain' } };
  input.sellQuote = { quoteId: 'roundtrip-sell', chain: 'solana', amountInRaw: input.sellAmountRaw, amountOutRaw: input.sellAmountOutRaw, minOutRaw: input.sellMinOutRaw,
    fromToken: { address: addresses.solana, decimals: 6, kind: 'token' }, toToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, kind: 'stable' }, feeUsd: .01, estimatedRentUsd: 0, tx: { data: 'must-not-retain' } };
  ctx.store.recordQuote(input); const report = ctx.store.list('quote').items[0];
  const paper = new OnchainPaperEngine({ store: ctx.store, quoteClient: { quote: async () => { throw Error('No external quotes in this roundtrip test'); } }, now: ctx.now });
  paper.start({ asset: marketRow.asset, row: marketRow, quote: report });
  assert.doesNotThrow(() => paper.validatePlan(report, { asset: marketRow.asset, row: marketRow, amountUsd: 5, buyChain: 'bnb' }));
  assert.equal(report.parentRevision, 4); assert.equal(report.parentPolicyFingerprint, POLICY); assert.equal(report.generation, marketRow.generation);
  assert.equal(report.mode, 'research'); assert.equal(report.evidenceType, 'readonly-quote');
  assert.deepEqual(report.addresses, addresses); assert.deepEqual(report.pools, pools); assert.equal(report.executionReady, false); assert.equal(report.simulationVerified, false);
  assert(!JSON.stringify(report).includes('must-not-retain'));
});

test('fourteen-day coverage requires every adjacent synthetic test observation in one immutable scope', t => {
  const ctx = fixture(t), steps = 14 * 86400000 / 120000;
  observe(ctx, row(ctx, 'sample-0'), POLICY, 120000);
  for (let i = 1; i <= steps; i++) { ctx.advance(120000); observe(ctx, row(ctx, `sample-${i}`), POLICY, 120000); }
  const coverage = ctx.store.coverage(); assert.equal(coverage.observations, steps + 1); assert.equal(coverage.currentContinuousMs, 14 * 86400000); assert.equal(coverage.validated14Days, true);
  ctx.advance(120001); assert.equal(ctx.store.coverage().validated14Days, false, 'a current outage cannot inherit the historical continuous qualification');
});
