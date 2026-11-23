import test from 'node:test';
import assert from 'node:assert/strict';
import { selectReferencePool } from '../src/opportunities/pool-selection.mjs';

const now = Date.parse('2026-11-23T02:00:00Z');
const address = index => `0x${index.toString(16).padStart(40, '0')}`;
const pool = (index, priceUsd = 1, patch = {}) => ({ chain: 'bnb', tokenAddress: address(100), quoteAddress: address(101), poolAddress: address(index), priceUsd, priceMethod: 'provider-base-usd', liquidityUsd: 100000, volume24hUsd: 50000, volume1hUsd: 1000, trades1h: 10, observedAt: now, dexId: 'fixture', ...patch });
const choose = (pools, options = {}) => selectReferencePool(pools, { chain: 'bnb', now, ...options });

test('one active pool keeps its observed price with single-pool confidence, not a safety claim', () => {
  const original = pool(1, .0105), result = choose([original]);
  assert.equal(result.pool.priceUsd, .0105); assert.equal(result.confidence, 'single-pool'); assert.equal(result.quarantined, false);
  assert.equal(result.diagnostics.agreementPools, 1); assert.notEqual(result.pool, original);
  assert.equal(result.pool.approved, undefined); assert.equal(result.pool.safe, undefined);
});

test('two agreeing active pools beat a much larger-liquidity extreme outlier', () => {
  const result = choose([pool(1, .0105), pool(2, .0106, { liquidityUsd: 200000 }), pool(3, .00000006, { liquidityUsd: 3000000 })]);
  assert.equal(result.pool.poolAddress, address(2)); assert.equal(result.pool.priceUsd, .0106);
  assert.equal(result.confidence, 'pool-consensus'); assert.equal(result.quarantined, false);
  assert.equal(result.diagnostics.agreementPools, 2); assert.equal(result.diagnostics.rejectedOutliers, 1);
});

test('within one unambiguous consensus the most liquid actual pool is selected, not an average', () => {
  const result = choose([pool(1, 1), pool(2, 1.03, { liquidityUsd: 200000 }), pool(3, 1.04)]);
  assert.equal(result.pool.priceUsd, 1.03); assert.equal(result.diagnostics.agreementPools, 3);
});

test('two or more active pools with no agreeing pair are quarantined with a diagnostic price', () => {
  const result = choose([pool(1, 1), pool(2, .00000006, { liquidityUsd: 200000 })]);
  assert.equal(result.quarantined, true); assert.equal(result.confidence, 'conflicting-pools'); assert.equal(result.pool.poolAddress, address(2));
});

test('equally supported separated price clusters cannot be decided by liquidity', () => {
  const result = choose([pool(1, 1), pool(2, 1.01), pool(3, .00001, { liquidityUsd: 90000000 }), pool(4, .0000101, { liquidityUsd: 80000000 })]);
  assert.equal(result.quarantined, true); assert.equal(result.confidence, 'conflicting-pools'); assert.equal(result.diagnostics.agreementPools, 2);
});

test('overlapping maximum windows use their real shared center rather than falsely rejecting nearby prices', () => {
  const result = choose([pool(1, 1, { liquidityUsd: 9999999 }), pool(2, 1.1), pool(3, 1.21, { liquidityUsd: 8888888 })]);
  assert.equal(result.quarantined, false); assert.equal(result.pool.poolAddress, address(2)); assert.equal(result.pool.priceUsd, 1.1);
  assert.equal(result.diagnostics.agreementPools, 2); assert.equal(result.diagnostics.consensusCandidates, 3); assert.equal(result.diagnostics.rejectedOutliers, 0);
});

test('a ladder of adjacent prices cannot be merged transitively without a shared maximum-window center', () => {
  const result = choose([pool(1, 1), pool(2, 1.1), pool(3, 1.21), pool(4, 1.331)]);
  assert.equal(result.quarantined, true); assert.equal(result.confidence, 'conflicting-pools');
});

test('a pinned approved pool is preserved inside the consensus despite a more liquid alternative', () => {
  const result = choose([pool(1, 1), pool(2, 1.01, { liquidityUsd: 999999 })], { pinnedPoolAddress: address(1) });
  assert.equal(result.pool.poolAddress, address(1)); assert.equal(result.confidence, 'pool-consensus'); assert.equal(result.quarantined, false);
});

test('a pinned active outlier is retained as evidence and quarantined, never substituted', () => {
  const result = choose([pool(1, .00000006, { liquidityUsd: 9999999 }), pool(2, .0105), pool(3, .0106)], { pinnedPoolAddress: address(1) });
  assert.equal(result.pool.poolAddress, address(1)); assert.equal(result.pool.priceUsd, .00000006); assert.equal(result.quarantined, true);
});

test('a missing pinned pool does not select another pool', () => {
  const result = choose([pool(1), pool(2, 1.01)], { pinnedPoolAddress: address(3) });
  assert.equal(result.pool, null); assert.equal(result.confidence, 'none'); assert.equal(result.diagnostics.pinnedMissing, 1);
});

test('inactive pinned pools remain pinned and fail activity rather than silently switching', () => {
  const result = choose([pool(1, 1, { trades1h: 0 }), pool(2, 1.01), pool(3, 1.02)], { pinnedPoolAddress: address(1) });
  assert.equal(result.pool.poolAddress, address(1)); assert.equal(result.confidence, 'none'); assert.equal(result.quarantined, false);
});

test('no active pools retain only an actual diagnostic pool and never claim agreement', () => {
  const result = choose([pool(1, 1, { volume1hUsd: 0 }), pool(2, 1.01, { trades1h: 0, liquidityUsd: 200000 })]);
  assert.equal(result.pool.poolAddress, address(2)); assert.equal(result.confidence, 'none'); assert.equal(result.diagnostics.eligiblePools, 0);
});

test('missing positive-threshold metrics cannot pass, while explicit zero disables only activity filters', () => {
  const item = pool(1, 1, { volume24hUsd: null, volume1hUsd: null, trades1h: null });
  assert.equal(choose([item]).confidence, 'none');
  assert.equal(choose([item], { settings: { minVolume24hUsd: 0, minVolume1hUsd: 0, minTrades1h: 0 } }).confidence, 'single-pool');
  assert.equal(choose([pool(1, 1, { liquidityUsd: null })], { settings: { minLiquidityUsd: 0, minVolume24hUsd: 0, minVolume1hUsd: 0, minTrades1h: 0 } }).confidence, 'none');
});

test('old, future or malformed observations cannot count as active evidence', () => {
  for (const observedAt of [now - 120001, now + 1001, NaN, null, now + .5]) assert.equal(choose([pool(1, 1, { observedAt })]).confidence, 'none');
  assert.equal(choose([pool(1, 1, { observedAt: now - 120000 })]).confidence, 'single-pool');
});

test('exact duplicate pools and EVM casing do not manufacture a consensus vote', () => {
  const original = pool(10), result = choose([original, structuredClone(original), { ...original, poolAddress: original.poolAddress.toUpperCase().replace('0X', '0x') }]);
  assert.equal(result.confidence, 'single-pool'); assert.equal(result.diagnostics.uniquePools, 1); assert.equal(result.diagnostics.eligiblePools, 1);
});

test('conflicting duplicates cause quarantine even if other pools would agree', () => {
  const result = choose([pool(1), pool(1, 1.01), pool(2), pool(3, 1.02)]);
  assert.equal(result.quarantined, true); assert.equal(result.confidence, 'conflicting-pools'); assert.equal(result.diagnostics.conflictingDuplicates, 1); assert(result.pool);
});

test('bad records, wrong chains and unknown extra fields do not contaminate a selected pool', () => {
  const result = choose([pool(1, 1, { secretKey: 'not-a-real-key', raw: { unsafe: true } }), null, {}, pool(2, -1), pool(3, 1, { chain: 'solana' })]);
  assert.equal(result.confidence, 'single-pool'); assert.equal(result.pool.secretKey, undefined); assert.equal(result.pool.raw, undefined);
});

test('Solana pool identities remain case-sensitive and chain inference stays local', () => {
  const sol = (poolAddress, priceUsd) => ({ ...pool(1, priceUsd), chain: 'solana', poolAddress });
  const result = selectReferencePool([sol('11111111111111111111111111111112', 1), sol('11111111111111111111111111111113', 1.01)], { now });
  assert.equal(result.confidence, 'pool-consensus'); assert.equal(result.diagnostics.eligiblePools, 2);
});

test('zero deviation requires identical prices; decimal boundary and extreme ratios are handled without overflow', () => {
  assert.equal(choose([pool(1, 1), pool(2, 1.01)], { settings: { maxPoolDeviationBps: 0 } }).quarantined, true);
  assert.equal(choose([pool(1, 1), pool(2, 1)], { settings: { maxPoolDeviationBps: 0 } }).confidence, 'pool-consensus');
  assert.equal(choose([pool(1, .01), pool(2, .0115)]).confidence, 'pool-consensus');
  assert.equal(choose([pool(1, 1e-300), pool(2, 1e300)]).quarantined, true);
});

test('empty data is unavailable, malformed or excessive data fails closed without consuming unbounded input', () => {
  assert.equal(choose([]).pool, null); assert.equal(choose([]).quarantined, false);
  assert.equal(choose(null).quarantined, true);
  assert.equal(choose(Array(3001).fill(pool(1))).quarantined, true);
});

test('selection is deterministic for input order and cannot mutate normalized observations', () => {
  const input = [pool(3, 2), pool(1, 1), pool(2, 1.01)]; const saved = structuredClone(input);
  const left = choose(input), right = choose(input.slice().reverse());
  assert.equal(left.pool.poolAddress, right.pool.poolAddress); assert.equal(left.confidence, right.confidence); assert.deepEqual(input, saved);
  left.pool.priceUsd = 999; assert.deepEqual(input, saved);
});
