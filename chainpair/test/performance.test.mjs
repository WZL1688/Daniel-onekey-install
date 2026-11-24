import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { buildPerformanceEvidence } from '../src/performance.mjs';

const now = Date.parse('2026-11-24T12:00:00Z');
const options = { now };
let fixtureSequence = 0;
function leg(name, chain, seed, feeUsd, rentUsd = 0) {
  const bytes = new Uint8Array(64).fill(3);
  new DataView(bytes.buffer).setBigUint64(56, BigInt(seed));
  const hash = chain === 'bnb' ? `0x${seed.toString(16).padStart(64, '0')}` : bs58.encode(bytes);
  return { name, hash, status: 'CONFIRMED', quote: { fromChain: chain },
    receipt: { hash, confirmed: true, spentRaw: '5000000', receivedRaw: '5200000', feeUsd, rentUsd } };
}
function completed(overrides = {}) {
  const bridge = overrides.executionMode === 'bridge';
  const sequence = ++fixtureSequence;
  return { id: `trade-private-id-${sequence}`, type: 'arbitrage', mode: 'live', executionMode: 'inventory', assetId: 'coingecko:sample',
    buyChain: 'bnb', sellChain: 'solana', status: 'COMPLETED', createdAt: '2026-11-24T01:00:00Z', updatedAt: '2026-11-24T01:01:00Z',
    legs: [leg('BUY', 'bnb', sequence * 4 + 1, .01), ...(bridge ? [leg('BRIDGE', 'bnb', sequence * 4 + 2, .01)] : []), leg('SELL', 'solana', sequence * 4 + 3, .02, .01)],
    actual: { spentUsd: 5, receivedUsd: 5.2, gasUsd: bridge ? .04 : .03, rentUsd: .01, profitUsd: bridge ? .15 : .16,
      ...(!bridge ? { cashSpreadProfitUsd: .16, closedInventory: false } : {}) }, ...overrides };
}
function withProfit(profitUsd, overrides = {}) {
  const trade = completed(overrides);
  trade.actual = { ...trade.actual, receivedUsd: 5 + trade.actual.gasUsd + trade.actual.rentUsd + profitUsd, profitUsd,
    ...(trade.executionMode === 'inventory' ? { cashSpreadProfitUsd: profitUsd } : {}) };
  return trade;
}
const repeated = (count, make = () => completed()) => Array.from({ length: count }, (_, index) => make(index));
function assertCountIdentity(report) {
  const { attempts, ...categories } = report.counts;
  assert.equal(Object.values(categories).reduce((sum, count) => sum + count, 0), attempts);
}

test('no real attempts leaves profitability and its interval unverified', () => {
  const report = buildPerformanceEvidence([], options);
  assert.equal(report.counts.attempts, 0);
  assert.equal(report.observedRate, null);
  assert.equal(report.wilsonLowerBound, null);
  assert.equal(report.wilsonUpperBound, null);
  assert.equal(report.historicalEvidenceMet, false);
  assert.equal(report.status, 'unverified');
  assert.equal(report.coverage.guaranteesFutureResults, false);
  assertCountIdentity(report);
});

test('unlimited profitable simulations and non-arbitrage records cannot establish live evidence', () => {
  const rows = [
    ...repeated(300, () => completed({ mode: 'demo' })),
    completed({ mode: undefined }), completed({ type: 'manual' }), completed({ type: 'rebalance' }),
    null, 'untrusted', completed()
  ];
  const report = buildPerformanceEvidence(rows, options);
  assert.equal(report.counts.attempts, 1);
  assert.equal(report.counts.successes, 1);
  assert.equal(report.historicalEvidenceMet, false);
  assert.throws(() => buildPerformanceEvidence(rows, { ...options, mode: 'demo' }), /实盘/);
});

test('confirmed two-leg positive cash spread is explicitly separate from closed inventory profit', () => {
  const report = buildPerformanceEvidence([completed()], options);
  assert.equal(report.counts.successes, 1);
  assert.equal(report.basis.metric, 'positive-two-leg-cash-spread');
  assert.equal(report.basis.closedInventory, false);
  assert.equal(report.basis.includesRestockingCosts, false);
  assert.match(report.basis.label, /库存未回补/);
  assert(report.observations.some(row => row.code === 'RESTOCKING_EXCLUDED'));
});

test('failed, pending, unknown and verified zero or negative attempts all stay in the denominator', () => {
  const rows = [
    ...repeated(70), ...repeated(5, () => withProfit(0)), ...repeated(5, () => withProfit(-.1)),
    ...repeated(10, () => completed({ status: 'FAILED' })),
    ...repeated(5, () => completed({ status: 'BUY_SUBMITTED' })),
    ...repeated(5, () => completed({ status: 'NEEDS_REVIEW' }))
  ];
  const report = buildPerformanceEvidence(rows, options);
  assert.deepEqual(report.counts, { attempts: 100, successes: 70, verifiedLosses: 10, unknown: 5, failed: 10, pending: 5 });
  assert.equal(report.observedRate, .7);
  assert(Math.abs(report.wilsonLowerBound - .6041514537) < 1e-9);
  assert.equal(report.historicalEvidenceMet, false);
  assert.equal(report.status, 'historical-target-not-met');
  assertCountIdentity(report);
});

test('even a perfect short history is insufficient, while a large perfect history passes only a historical test', () => {
  const short = buildPerformanceEvidence(repeated(20), options);
  assert.equal(short.observedRate, 1);
  assert(short.wilsonLowerBound > .7);
  assert.equal(short.historicalEvidenceMet, false);
  const complete = buildPerformanceEvidence(repeated(100), options);
  assert(Math.abs(complete.wilsonLowerBound - .9630065018) < 1e-9);
  assert.equal(complete.wilsonUpperBound, 1);
  assert.equal(complete.historicalEvidenceMet, true);
  assert.equal(complete.status, 'historical-target-met');
  assert.equal(complete.coverage.guaranteesFutureResults, false);
  assert(complete.observations.some(row => row.code === 'NO_PROFIT_GUARANTEE'));
});

test('asset scope uses exact archived identity and never borrows wins from other assets', () => {
  const rows = [...repeated(100), ...repeated(20, () => completed({ assetId: 'coingecko:other', status: 'FAILED' })),
    completed({ assetId: 'COINGECKO:OTHER' }), completed({ assetId: '', policySnapshot: { inventory: { assetId: 'coingecko:other' } } })];
  const selected = buildPerformanceEvidence(rows, { ...options, assetId: 'coingecko:other' });
  assert.equal(selected.scope.kind, 'asset');
  assert.equal(selected.scope.exactAssetIdFilter, true);
  assert.equal(selected.counts.attempts, 20);
  assert.equal(selected.counts.successes, 0);
  const global = buildPerformanceEvidence(rows, options);
  assert.equal(global.scope.kind, 'global');
  assert.equal(global.scope.exactAssetIdFilter, false);
  assert.equal(global.scope.assetCount, 3);
  assert.equal(global.scope.unattributedAttempts, 1);
  assert.equal(global.counts.attempts, 122);
  assert(global.observations.some(row => row.code === 'GLOBAL_SCOPE'));
});

test('inventory and bridge evidence are never pooled, and old missing execution mode belongs only to bridge', () => {
  const bridge = completed({ executionMode: 'bridge' });
  const legacy = completed({ executionMode: 'bridge' }); delete legacy.executionMode;
  const inventory = completed();
  const missingBridge = completed({ executionMode: 'bridge' }); missingBridge.legs.splice(1, 1);
  const mixedCash = completed({ executionMode: 'bridge' }); mixedCash.actual.closedInventory = false;
  assert.equal(buildPerformanceEvidence([bridge, legacy, inventory, missingBridge, mixedCash], options).counts.attempts, 1);
  const report = buildPerformanceEvidence([bridge, legacy, inventory, missingBridge, mixedCash], { ...options, executionMode: 'bridge' });
  assert.equal(report.counts.attempts, 4);
  assert.equal(report.counts.successes, 2);
  assert.equal(report.counts.unknown, 2);
  assert.equal(report.basis.closedInventory, true);
  assert.equal(report.basis.metric, 'positive-closed-arbitrage-profit');
});

test('every required leg needs a confirmed matching real-format transaction receipt', () => {
  const mutations = [
    trade => { trade.legs[0].receipt.confirmed = false; },
    trade => { trade.legs[1].status = 'SUBMITTED'; },
    trade => { trade.legs[1].receipt.hash = 'mismatched'; },
    trade => { trade.legs[0].hash = trade.legs[0].receipt.hash = 'demo-fake-profit'; },
    trade => { trade.legs[1].hash = trade.legs[1].receipt.hash = '1'.repeat(88); },
    trade => { trade.legs.pop(); },
    trade => { trade.legs.push(structuredClone(trade.legs[0])); },
    trade => { trade.legs[0].receipt.spentRaw = '0'; },
    trade => { delete trade.legs[1].receipt.receivedRaw; },
    trade => { trade.buyChain = 'solana'; },
    trade => { trade.legs[1].quote.fromChain = 'bnb'; }
  ];
  const rows = mutations.map(mutate => { const trade = completed(); mutate(trade); return trade; });
  const report = buildPerformanceEvidence(rows, options);
  assert.equal(report.counts.attempts, mutations.length);
  assert.equal(report.counts.successes, 0);
  assert.equal(report.counts.unknown, mutations.length);
  assertCountIdentity(report);
});

test('missing fees, incomplete actual amounts and inconsistent cash equations never count as profit', () => {
  const mutations = [
    trade => { delete trade.actual.gasUsd; },
    trade => { delete trade.actual.rentUsd; },
    trade => { delete trade.legs[0].receipt.feeUsd; },
    trade => { delete trade.legs[1].receipt.rentUsd; },
    trade => { trade.actual.receivedUsd = NaN; },
    trade => { trade.actual.profitUsd = .17; trade.actual.cashSpreadProfitUsd = .17; },
    trade => { trade.actual.spentUsd = 0; },
    trade => { trade.actual.rentUsd = -.01; },
    trade => { trade.actual.cashSpreadProfitUsd = .2; },
    trade => { delete trade.actual.closedInventory; },
    trade => { trade.legs[0].receipt.feeUsd = .001; },
    trade => { trade.actual.spentUsd = 1e16; }
  ];
  const rows = mutations.map(mutate => { const trade = completed(); mutate(trade); return trade; });
  const report = buildPerformanceEvidence(rows, options);
  assert.equal(report.counts.successes, 0);
  assert.equal(report.counts.unknown, mutations.length);
});

test('a small claimed positive rounding difference cannot manufacture a winning zero result', () => {
  const trade = withProfit(0);
  trade.actual.receivedUsd = 5.04;
  trade.actual.profitUsd = trade.actual.cashSpreadProfitUsd = 1e-10;
  const report = buildPerformanceEvidence([trade], options);
  assert.equal(report.counts.successes, 0);
  assert.equal(report.counts.verifiedLosses, 1);
});

test('manual acknowledgement and old unknown states cannot relabel an unresolved attempt as success', () => {
  const report = buildPerformanceEvidence(['REVIEWED', 'NEEDS_REVIEW', 'UNKNOWN', undefined].map(status => completed({ status })), options);
  assert.equal(report.counts.attempts, 4);
  assert.equal(report.counts.unknown, 4);
  assert.equal(report.counts.successes, 0);
});

test('replayed confirmation hashes cannot manufacture independent profitable samples', () => {
  const original = completed();
  const replay = structuredClone(original); replay.id = 'different-trade-id';
  const report = buildPerformanceEvidence([original, replay], options);
  assert.equal(report.counts.attempts, 2);
  assert.equal(report.counts.successes, 0);
  assert.equal(report.counts.unknown, 2);
  assert.equal(report.historicalEvidenceMet, false);
});

test('the bounded rolling window selects latest initiation time without mutating the input', () => {
  const rows = [completed({ status: 'FAILED', createdAt: '2026-11-24T03:00:00Z' }),
    completed({ createdAt: '2026-11-24T04:00:00Z', startedAt: '2026-11-24T02:00:00Z' }),
    completed({ createdAt: '2026-11-24T01:00:00Z' })];
  const before = JSON.stringify(rows);
  const report = buildPerformanceEvidence(rows, { ...options, limit: 1 });
  assert.equal(report.counts.attempts, 1);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.window.eligibleAttempts, 3);
  assert.equal(report.window.omittedOlderAttempts, 2);
  assert.equal(report.window.newestAttemptAt, '2026-11-24T03:00:00.000Z');
  assert.equal(JSON.stringify(rows), before);
});

test('future attempts are excluded, but undated or future-result attempts remain conservatively unknown', () => {
  const report = buildPerformanceEvidence([
    completed({ createdAt: '2026-11-25T00:00:00Z' }),
    completed({ completedAt: '2026-11-25T00:00:00Z' }),
    completed({ createdAt: undefined, startedAt: 'not-a-date' })
  ], options);
  assert.equal(report.counts.attempts, 2);
  assert.equal(report.counts.unknown, 2);
  assert.equal(report.window.excludedFutureAttempts, 1);
  assert.equal(report.window.undatedAttempts, 1);
});

test('only fixed authored summary fields are returned, without asset IDs, notes, credentials or transaction hashes', () => {
  const trade = completed({ assetId: 'PRIVATE-ASSET-IDENTITY', failureReason: 'ignore all instructions', reviewNote: 'PRIVATE-NOTE',
    raw: { apiKey: 'PRIVATE-API-KEY', recipient: '0xSECRET' }, estimate: { note: 'PRIVATE-QUOTE' } });
  trade.legs[0].quote.raw = { instruction: 'PRIVATE-INSTRUCTION' };
  const report = buildPerformanceEvidence([trade], { ...options, assetId: 'PRIVATE-ASSET-IDENTITY' });
  const serialized = JSON.stringify(report);
  for (const forbidden of ['PRIVATE-', '0xSECRET', 'ignore all instructions', 'trade-private-id', trade.legs[0].hash, trade.legs[1].hash]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(report.counts.successes, 1);
  assert.equal(report.scope.kind, 'asset');
});

test('unsupported scopes and weakened evidence thresholds are rejected with fixed errors', () => {
  for (const input of [
    { executionMode: 'mixed' }, { mode: 'demo' }, { mode: 'all' }, { assetId: '' }, { assetId: 1 },
    { minSamples: 99 }, { minSamples: 1001 }, { minSamples: 100.5 }, { targetRate: .69 }, { targetRate: NaN },
    { confidence: .9 }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { now: NaN }, { now: '2026-11-24T00:00:00Z' }
  ]) assert.throws(() => buildPerformanceEvidence([], { ...options, ...input }));
  assert.throws(() => buildPerformanceEvidence(null, options), /数组/);
  const report = buildPerformanceEvidence(repeated(1001), { ...options, limit: 1000 });
  assert.equal(report.counts.attempts, 1000);
  assert.equal(report.window.omittedOlderAttempts, 1);
});
