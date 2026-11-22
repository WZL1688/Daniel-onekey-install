// Deterministic local fixtures only. No external requests, wallets or signing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { Store } from '../src/store.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';

const START = Date.parse('2026-11-22T08:00:00Z');
const bnbAddress = index => `0x${(index + 8000).toString(16).padStart(40, '0')}`;
const solAddress = index => {
  const bytes = new Uint8Array(32); bytes[0] = 23; bytes[28] = 71;
  bytes[30] = Math.floor(index / 256); bytes[31] = index % 256;
  return new PublicKey(bytes).toBase58();
};
const CHAINS = {
  bnb: { address: bnbAddress(1), decimals: 18, poolAddress: bnbAddress(11) },
  solana: { address: solAddress(1), decimals: 9, poolAddress: solAddress(11) },
};
const QUOTES = { bnb: bnbAddress(90), solana: solAddress(90) };

function setup(t, overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'altcoin-pipeline-'));
  const store = new Store(dir), calls = [];
  let clock = START;
  const now = () => clock;
  const pool = (chain, tokenAddress, patch = {}) => ({
    chain, tokenAddress, poolAddress: CHAINS[chain].poolAddress, quoteAddress: QUOTES[chain],
    priceUsd: chain === 'bnb' ? 1 : 1.02,
    liquidityUsd: 100000, volume24hUsd: 300000, volume1hUsd: 3000, trades1h: 60,
    observedAt: clock, sourceUpdatedAt: null, dexId: 'local-fixture-only', ...patch,
  });
  const client = {
    discover: async () => { calls.push({ kind: 'directory' }); return []; },
    pools: async ({ chain, addresses }) => {
      calls.push({ kind: 'pools', chain, addresses: [...addresses] });
      return addresses.map(tokenAddress => pool(chain, tokenAddress));
    },
    ...overrides,
  };
  const service = new OpportunityService({ store, client, now, sleep: async ms => { clock += ms; } });
  t.after(() => { service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, client, calls, pool, now, advance: ms => { clock += ms; } };
}
function alt(ctx, patch = {}) {
  const result = ctx.service.saveAsset({ name: 'Fixture Altcoin', symbol: 'FIXALT', chains: CHAINS, ...patch });
  return result.assets.find(asset => asset.name === (patch.name || 'Fixture Altcoin'));
}
function stable(ctx) {
  const result = ctx.service.saveAsset({ name: 'USD Coin', symbol: 'USDC', chains: {
    bnb: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    solana: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  } });
  return result.assets.find(asset => asset.symbol === 'USDC');
}
function major(ctx) {
  const result = ctx.service.saveAsset({ name: 'Wrapped native fixtures', symbol: 'WBNB', chains: {
    bnb: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    solana: { address: 'So11111111111111111111111111111111111111112', decimals: 9 },
  } });
  return result.assets.find(asset => asset.symbol === 'WBNB');
}
const rowFor = (ctx, id) => ctx.service.snapshot().rows.find(row => row.asset.id === id);
function approve(ctx, asset) {
  const current = ctx.service.snapshot().assets.find(item => item.id === asset.id);
  ctx.service.approveAsset({ id: current.id, revision: current.revision, confirmed: true,
    evidence: 'Local fixture verifies the mapping gate only; no real token claim', chains: current.chains });
}

test('stable-only watchlists remain inspectable and consume no pool requests under default altcoin scope', async t => {
  const ctx = setup(t), asset = stable(ctx), config = JSON.stringify(ctx.store.config);
  await ctx.service.scan();
  const snapshot = ctx.service.snapshot(), row = rowFor(ctx, asset.id);
  assert.equal(snapshot.assets.length, 1);
  assert.equal(row.universe.category, 'stablecoin'); assert.equal(row.universe.eligible, false);
  assert.equal(row.opportunityQualified, false); assert.equal(row.executable, false);
  assert.equal(snapshot.counts.excluded, 1); assert.equal(snapshot.counts.eligible, 0);
  assert.equal(snapshot.usage.total, 0); assert.deepEqual(ctx.calls, []);
  assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.allTrades().length, 0);
});

test('stable and native assets are filtered before batching rather than occupying altcoin request slots', async t => {
  const ctx = setup(t), asset = alt(ctx); stable(ctx); major(ctx);
  await ctx.service.scan();
  const reads = ctx.calls.filter(call => call.kind === 'pools');
  assert.equal(reads.length, 2);
  for (const read of reads) assert.deepEqual(read.addresses, [asset.chains[read.chain].address]);
  const snapshot = ctx.service.snapshot(), row = rowFor(ctx, asset.id);
  assert.equal(snapshot.counts.total, 3); assert.equal(snapshot.counts.eligible, 1); assert.equal(snapshot.counts.excluded, 2);
  assert.equal(snapshot.counts.dualActive, 1); assert.equal(row.marketQualified, true);
  assert.equal(row.opportunityQualified, true); assert.equal(snapshot.usage.total, 2);
  assert.equal(row.asset.mapping.confirmed, false); assert.equal(row.executable, false);
});

test('a smaller active pool wins over a larger pool with no recent indexed activity', async t => {
  const ctx = setup(t), asset = alt(ctx);
  ctx.client.pools = async ({ chain, addresses }) => {
    ctx.calls.push({ kind: 'pools', chain, addresses: [...addresses] });
    return addresses.flatMap(tokenAddress => [
      ctx.pool(chain, tokenAddress, { poolAddress: chain === 'bnb' ? bnbAddress(12) : solAddress(12), liquidityUsd: 2000000, volume24hUsd: 1000, volume1hUsd: 0, trades1h: 0 }),
      ctx.pool(chain, tokenAddress, { liquidityUsd: 80000, volume24hUsd: 50000, volume1hUsd: 2000, trades1h: 12 }),
    ]);
  };
  await ctx.service.scan();
  const row = rowFor(ctx, asset.id);
  assert.equal(row.market.bnb.poolAddress, CHAINS.bnb.poolAddress);
  assert.equal(row.market.solana.poolAddress, CHAINS.solana.poolAddress);
  assert.equal(row.marketQualified, true); assert.equal(row.opportunityQualified, true);
  assert.equal(row.feeStatus, 'unknown'); assert.equal(row.executable, false);
});

test('an approved inactive pool cannot be silently replaced by another active pool for the same asset', async t => {
  const ctx = setup(t), asset = alt(ctx); approve(ctx, asset);
  ctx.client.pools = async ({ chain, addresses }) => addresses.flatMap(tokenAddress => [
    ctx.pool(chain, tokenAddress, { volume1hUsd: 0, trades1h: 0 }),
    ctx.pool(chain, tokenAddress, { poolAddress: chain === 'bnb' ? bnbAddress(13) : solAddress(13), liquidityUsd: 300000 }),
  ]);
  await ctx.service.setEnabled(true);
  const row = rowFor(ctx, asset.id);
  assert.equal(row.asset.mapping.confirmed, true);
  assert.equal(row.market.bnb.poolAddress, CHAINS.bnb.poolAddress);
  assert.equal(row.market.solana.poolAddress, CHAINS.solana.poolAddress);
  assert.equal(row.marketQualified, false); assert.equal(row.opportunityQualified, false);
  assert.equal(row.executable, false); assert.equal(ctx.service.executionCandidates().length, 0);
  assert.equal(ctx.store.allTrades().length, 0);
});

test('missing recent-volume or trade metrics remain unknown and cannot qualify as active markets', async t => {
  const ctx = setup(t), asset = alt(ctx);
  ctx.client.pools = async ({ chain, addresses }) => addresses.map(tokenAddress => ctx.pool(chain, tokenAddress, {
    volume1hUsd: chain === 'solana' ? null : 1000, trades1h: chain === 'solana' ? null : 20,
  }));
  await ctx.service.scan();
  const row = rowFor(ctx, asset.id);
  assert.equal(row.universe.eligible, true); assert.equal(row.marketQualified, false);
  assert.equal(row.opportunityQualified, false); assert.equal(row.stage, 'blocked');
  assert.equal(row.market.solana.volume1hUsd, null); assert.equal(row.market.solana.trades1h, null);
  assert(row.reasons.some(reason => /成交|交易|活跃/.test(reason)));
  assert.equal(ctx.service.snapshot().counts.dualActive, 0); assert.equal(ctx.service.executionCandidates().length, 0);
});

test('an anomalous apparent spread remains visible as reference but cannot become an opportunity', async t => {
  const ctx = setup(t), asset = alt(ctx);
  ctx.client.pools = async ({ chain, addresses }) => addresses.map(tokenAddress => ctx.pool(chain, tokenAddress, { priceUsd: chain === 'bnb' ? 1 : 2 }));
  await ctx.service.scan();
  const row = rowFor(ctx, asset.id);
  assert.equal(row.marketQualified, true); assert.equal(row.spreadBps, 10000);
  assert.equal(row.opportunityQualified, false); assert.equal(row.stage, 'blocked');
  assert(row.reasons.some(reason => /异常|上限|价差/.test(reason)));
  assert.equal(ctx.service.snapshot().counts.opportunities, 0); assert.equal(ctx.service.executionCandidates().length, 0);
});

test('a valid reference opportunity cannot enter execution before explicit identity approval and a complete fresh quote', async t => {
  const ctx = setup(t), asset = alt(ctx), config = JSON.stringify(ctx.store.config);
  await ctx.service.setEnabled(true);
  let row = rowFor(ctx, asset.id);
  assert.equal(row.opportunityQualified, true); assert.equal(row.stage, 'needs_mapping');
  assert.equal(row.feeStatus, 'unknown'); assert.equal(row.executable, false);
  assert.equal(ctx.service.executionCandidates().length, 0); assert.throws(() => ctx.service.getApprovedAsset(asset.id));
  approve(ctx, asset); await ctx.service.scan(); row = rowFor(ctx, asset.id);
  assert.equal(row.stage, 'candidate'); assert.equal(row.executable, false);
  assert.equal(ctx.service.executionCandidates().length, 1);
  ctx.service.recordEvaluation(asset.id, { executable: true, buyChain: 'bnb', sellChain: 'solana', amountUsd: 5,
    netProfitUsd: 1, expiresAt: new Date(ctx.now() + 15000).toISOString() });
  assert.equal(rowFor(ctx, asset.id).executable, false, 'missing fees must not become executable');
  assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.allTrades().length, 0);
});

test('stale, skewed and incomplete second-chain observations do not reuse a prior apparent opportunity', async t => {
  const ctx = setup(t), asset = alt(ctx); await ctx.service.setEnabled(true);
  assert.equal(rowFor(ctx, asset.id).opportunityQualified, true);
  ctx.advance(120001); assert.equal(rowFor(ctx, asset.id).marketQualified, false);
  ctx.client.pools = async ({ chain, addresses }) => addresses.map(tokenAddress => ctx.pool(chain, tokenAddress, { observedAt: chain === 'bnb' ? ctx.now() - 31001 : ctx.now() }));
  await ctx.service.scan();
  assert.equal(rowFor(ctx, asset.id).marketQualified, false, 'separate observations beyond the side-skew window are blocked');
  ctx.client.pools = async ({ chain, addresses }) => {
    if (chain === 'solana') throw Object.assign(new Error('provider private response'), { code: 'DISCOVERY_NETWORK', networkReason: 'TIMEOUT' });
    return addresses.map(tokenAddress => ctx.pool(chain, tokenAddress));
  };
  await ctx.service.scan();
  const row = rowFor(ctx, asset.id);
  assert.equal(row.marketQualified, false); assert.equal(row.opportunityQualified, false);
  assert.equal(row.executable, false); assert.equal(ctx.service.executionCandidates().length, 0);
  assert.equal(JSON.stringify(ctx.service.snapshot()).includes('provider private response'), false);
});

test('scope changes preserve the persistent request quota and do not enable trading or approve stable assets', async t => {
  const ctx = setup(t), asset = alt(ctx), usd = stable(ctx), config = JSON.stringify(ctx.store.config);
  await ctx.service.scan(); assert.equal(ctx.service.snapshot().usage.total, 2);
  ctx.service.saveSettings({ maxRequestsPerDay: 2, includeStablecoins: true, includeMajors: true });
  await ctx.service.scan();
  const snapshot = ctx.service.snapshot();
  assert.equal(snapshot.usage.total, 2); assert.equal(ctx.calls.length, 2);
  assert.equal(rowFor(ctx, usd.id).universe.eligible, true); assert.equal(rowFor(ctx, usd.id).asset.mapping.confirmed, false);
  assert.equal(rowFor(ctx, asset.id).executable, false); assert.equal(ctx.service.enabled, false);
  assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.allTrades().length, 0);
});

function catalogClient(ctx, entries, { failChain = null, code = 'DISCOVERY_NETWORK', retryAfterMs = 3600000 } = {}) {
  ctx.client.discover = async () => {
    ctx.calls.push({ kind: 'directory' });
    throw Object.assign(new Error('private CoinGecko response must not be copied'), { code: 'DISCOVERY_AUTH' });
  };
  ctx.client.contracts = async ({ chain }) => {
    ctx.calls.push({ kind: 'contracts', chain });
    if (chain === failChain) throw Object.assign(new Error('private contract provider response'), { code, retryAfterMs });
    return entries[chain];
  };
}
const catalogEntries = () => ({
  bnb: [{ coinId: 'fixalt-fixture-altcoin', address: CHAINS.bnb.address }],
  solana: [{ coinId: 'fixalt-fixture-altcoin', address: CHAINS.solana.address }],
});

test('CoinPaprika adds independently sourced canonical-ID candidates and counts each platform read before any trading approval', async t => {
  const ctx = setup(t), config = JSON.stringify(ctx.store.config);
  catalogClient(ctx, catalogEntries());
  await ctx.service.discover();
  const snapshot = ctx.service.snapshot(), asset = snapshot.assets.find(item => item.id === 'coinpaprika:fixalt-fixture-altcoin');
  assert(asset); assert.equal(asset.source, 'coinpaprika'); assert.equal(asset.mapping.confirmed, false);
  assert.equal(asset.chains.bnb.address.toLowerCase(), CHAINS.bnb.address.toLowerCase());
  assert.equal(asset.chains.solana.address, CHAINS.solana.address);
  assert.deepEqual(ctx.calls.map(call => call.kind === 'contracts' ? `contracts:${call.chain}` : call.kind), ['directory', 'contracts:bnb', 'contracts:solana']);
  assert.equal(snapshot.usage.total, 3);
  const cache = ctx.store.getMeta('opportunities.contract-catalogs.v1');
  assert.equal(cache.bnb.entries.length, 1); assert.equal(cache.solana.entries.length, 1);
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coingecko').status, 'auth_required');
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika').status, 'ready');
  assert.equal(JSON.stringify(snapshot).includes('private CoinGecko response'), false);
  assert.equal(rowFor(ctx, asset.id).opportunityQualified, false, 'address discovery has no fabricated pool prices');
  assert.equal(rowFor(ctx, asset.id).executable, false); assert.throws(() => ctx.service.getApprovedAsset(asset.id));
  assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.allTrades().length, 0);
});

test('same display symbols with different canonical IDs never create a cross-chain asset', async t => {
  const ctx = setup(t);
  catalogClient(ctx, {
    bnb: [{ coinId: 'same-one-asset', address: CHAINS.bnb.address, symbol: 'SAME', approved: true }],
    solana: [{ coinId: 'same-unrelated-asset', address: CHAINS.solana.address, symbol: 'SAME', approved: true }],
  });
  await ctx.service.discover();
  const snapshot = ctx.service.snapshot();
  assert.equal(snapshot.assets.length, 0); assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.usage.total, 3); assert.equal(snapshot.counts.opportunities, 0);
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika').status, 'empty');
  assert.deepEqual(ctx.service.executionCandidates(), []); assert.equal(ctx.store.allTrades().length, 0);
});

test('a failed platform preserves the healthy catalog across restart and retries only the failed platform within six hours', async t => {
  const ctx = setup(t), entries = catalogEntries();
  catalogClient(ctx, entries, { failChain: 'solana' });
  await ctx.service.discover();
  assert.equal(ctx.service.snapshot().assets.length, 0); assert.equal(ctx.service.snapshot().usage.total, 3);
  const firstCache = structuredClone(ctx.store.getMeta('opportunities.contract-catalogs.v1'));
  assert(firstCache.bnb); assert.equal(firstCache.solana, undefined);
  const failed = ctx.service.snapshot().directory.sourceAttempts.find(source => source.source === 'coinpaprika-solana');
  assert.equal(failed.status, 'retrying'); assert.equal(failed.errorCode, 'DISCOVERY_NETWORK');
  ctx.advance(failed.nextAttemptAt - ctx.now() + 1);
  catalogClient(ctx, entries);
  const resumed = new OpportunityService({ store: ctx.store, client: ctx.client, now: ctx.now, sleep: async ms => ctx.advance(ms) });
  try {
    await resumed.discover();
    const snapshot = resumed.snapshot(), cache = ctx.store.getMeta('opportunities.contract-catalogs.v1');
    assert.deepEqual(ctx.calls.map(call => call.kind === 'contracts' ? `contracts:${call.chain}` : call.kind), ['directory', 'contracts:bnb', 'contracts:solana', 'contracts:solana']);
    assert.equal(snapshot.usage.total, 4);
    assert.equal(cache.bnb.observedAt, firstCache.bnb.observedAt);
    assert.deepEqual(cache.bnb.entries, firstCache.bnb.entries);
    assert.equal(snapshot.assets.length, 1); assert.equal(snapshot.assets[0].id, 'coinpaprika:fixalt-fixture-altcoin');
    assert.equal(snapshot.assets[0].mapping.confirmed, false); assert.equal(snapshot.rows[0].executable, false);
    assert.equal(ctx.store.allTrades().length, 0);
  } finally { resumed.stop(); }
});

test('a fresh platform catalog cannot join against a retained counterpart older than six hours', async t => {
  const ctx = setup(t), entries = catalogEntries();
  catalogClient(ctx, entries, { failChain: 'solana' }); await ctx.service.discover();
  const oldBnb = structuredClone(ctx.store.getMeta('opportunities.contract-catalogs.v1').bnb);
  assert.equal(ctx.service.snapshot().assets.length, 0);
  ctx.advance(6 * 3600000 + 1001);
  catalogClient(ctx, entries, { failChain: 'bnb' }); await ctx.service.discover();
  let snapshot = ctx.service.snapshot(), caches = ctx.store.getMeta('opportunities.contract-catalogs.v1');
  assert.equal(caches.bnb.observedAt, oldBnb.observedAt);
  assert(ctx.now() - caches.bnb.observedAt > 6 * 3600000);
  assert(ctx.now() - caches.solana.observedAt < 1000);
  assert.equal(snapshot.assets.length, 0); assert.equal(snapshot.counts.opportunities, 0);
  assert.equal(snapshot.usage.total, 6);
  const healthySolanaAt = caches.solana.observedAt;
  const retryAt = snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika-bnb').nextAttemptAt;
  ctx.advance(retryAt - ctx.now() + 1); catalogClient(ctx, entries);
  const before = ctx.calls.length; await ctx.service.discover();
  assert.deepEqual(ctx.calls.slice(before), [{ kind: 'contracts', chain: 'bnb' }]);
  snapshot = ctx.service.snapshot(); caches = ctx.store.getMeta('opportunities.contract-catalogs.v1');
  assert.equal(caches.solana.observedAt, healthySolanaAt);
  assert.equal(snapshot.usage.total, 7); assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.assets[0].mapping.confirmed, false); assert.equal(ctx.store.allTrades().length, 0);
});

test('CoinPaprika 429 cools both platforms without blocking DEX reads or clearing quota on settings, credentials or restart', async t => {
  const ctx = setup(t), asset = alt(ctx), config = JSON.stringify(ctx.store.config), entries = catalogEntries();
  catalogClient(ctx, entries, { failChain: 'bnb', code: 'DISCOVERY_RATE_LIMIT', retryAfterMs: 3600000 });
  await ctx.service.discover();
  let snapshot = ctx.service.snapshot();
  assert.deepEqual(ctx.calls.map(call => call.kind === 'contracts' ? `contracts:${call.chain}` : call.kind), ['directory', 'contracts:bnb']);
  assert.equal(snapshot.usage.total, 2);
  const retryAt = snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika-bnb').nextAttemptAt;
  assert(retryAt > ctx.now() + 3500000);
  await ctx.service.scan();
  assert.equal(ctx.service.snapshot().usage.total, 4); assert.equal(rowFor(ctx, asset.id).opportunityQualified, true);
  assert.equal(ctx.calls.filter(call => call.kind === 'pools').length, 2);
  ctx.service.credentialsChanged(); ctx.service.saveSettings({ minVolume1hUsd: 200 });
  ctx.service.network = { snapshot: () => ({ mode: 'direct', proxyUrl: '' }), saveSettings: async () => ({ mode: 'direct', proxyUrl: '' }) };
  await ctx.service.saveNetworkSettings({ mode: 'direct', proxyUrl: '' });
  snapshot = ctx.service.snapshot();
  assert.equal(snapshot.usage.total, 4);
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika-bnb').nextAttemptAt, retryAt);
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika-bnb').errorCode, 'DISCOVERY_RATE_LIMIT');
  const before = ctx.calls.length;
  const resumed = new OpportunityService({ store: ctx.store, client: ctx.client, now: ctx.now, sleep: async ms => ctx.advance(ms) });
  try {
    await resumed.discover();
    const afterRestart = ctx.calls.slice(before);
    assert(afterRestart.every(call => call.kind === 'directory'), 'independent CoinGecko may retry after its credentials change, but neither limited platform may retry');
    assert.equal(ctx.calls.filter(call => call.kind === 'contracts').length, 1);
    assert.equal(resumed.snapshot().usage.total, 4 + afterRestart.length, 'every allowed retry remains charged against the retained ledger');
    assert.equal(resumed.snapshot().directory.sourceAttempts.find(source => source.source === 'coinpaprika-bnb').nextAttemptAt, retryAt);
  } finally { resumed.stop(); }
  assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.allTrades().length, 0);
  assert.equal(JSON.stringify(snapshot).includes('private contract provider response'), false);
});

test('reusing fresh contract caches cannot advance directory success or asset provenance timestamps', async t => {
  const ctx = setup(t); catalogClient(ctx, catalogEntries());
  await ctx.service.discover();
  const initial = ctx.service.snapshot();
  const assetId = 'coinpaprika:fixalt-fixture-altcoin';
  const observed = initial.assets.find(asset => asset.id === assetId).sourceObservedAt;
  const aggregate = initial.directory.sourceAttempts.find(source => source.source === 'coinpaprika');
  const directoryUpdatedAt = initial.directoryUpdatedAt;
  const catalogs = structuredClone(ctx.store.getMeta('opportunities.contract-catalogs.v1'));
  assert.equal(observed, Math.min(catalogs.bnb.observedAt, catalogs.solana.observedAt));
  ctx.advance(10000); const before = ctx.calls.length;
  await ctx.service.discover();
  let snapshot = ctx.service.snapshot();
  assert.equal(ctx.calls.length, before, 'cached reuse is not an HTTP read');
  assert.equal(snapshot.usage.total, initial.usage.total);
  assert.equal(snapshot.directoryUpdatedAt, directoryUpdatedAt);
  assert.equal(snapshot.directory.lastSuccessAt, directoryUpdatedAt);
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika').lastSuccessAt, aggregate.lastSuccessAt);
  assert.equal(snapshot.assets.find(asset => asset.id === assetId).sourceObservedAt, observed);
  ctx.advance(900000); await ctx.service.discover();
  snapshot = ctx.service.snapshot();
  assert.equal(ctx.calls.length, before + 1); assert.equal(ctx.calls.at(-1).kind, 'directory');
  assert.equal(snapshot.directoryUpdatedAt, directoryUpdatedAt);
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika').lastSuccessAt, aggregate.lastSuccessAt);
  assert.equal(snapshot.assets.find(asset => asset.id === assetId).sourceObservedAt, observed);
  assert.deepEqual(ctx.store.getMeta('opportunities.contract-catalogs.v1'), catalogs);
  assert.equal(ctx.store.getMeta('opportunities.registry.v1').find(asset => asset.id === assetId).sourceObservedAt, observed);
  assert.equal(ctx.store.allTrades().length, 0);
});

test('a stable-only CoinGecko success does not suppress the independent altcoin fallback', async t => {
  const ctx = setup(t), fallbackId = `wormhole:${'9'.repeat(40)}`;
  ctx.client.discover = async () => {
    ctx.calls.push({ kind: 'directory' });
    return [{ id: 'coingecko:usd-coin', name: 'USD Coin', symbol: 'USDC', source: 'coingecko', observedAt: ctx.now(),
      chains: { bnb: { address: bnbAddress(91) }, solana: { address: solAddress(91) } } }];
  };
  ctx.client.discoverWrapped = async () => {
    ctx.calls.push({ kind: 'wrapped' });
    return [{ id: fallbackId, name: 'Fixture Wrapped Altcoin', symbol: 'FIXALT', source: 'wormhole', observedAt: ctx.now(),
      origin: { chain: 'Ethereum', address: bnbAddress(555) }, chains: CHAINS }];
  };
  await ctx.service.discover();
  let snapshot = ctx.service.snapshot();
  assert.deepEqual(ctx.calls.map(call => call.kind), ['directory', 'wrapped']);
  assert.equal(snapshot.usage.total, 2); assert.equal(snapshot.assets.length, 2);
  assert.equal(snapshot.counts.eligible, 1); assert.equal(snapshot.counts.excluded, 1);
  assert.equal(rowFor(ctx, 'coingecko:usd-coin').universe.eligible, false);
  assert.equal(rowFor(ctx, fallbackId).universe.eligible, true);
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coingecko').status, 'ready');
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'wormhole').status, 'ready');
  await ctx.service.scan(); snapshot = ctx.service.snapshot();
  assert.equal(snapshot.usage.total, 4); assert.equal(snapshot.counts.opportunities, 1);
  assert.equal(rowFor(ctx, fallbackId).opportunityQualified, true);
  assert.equal(rowFor(ctx, fallbackId).asset.mapping.confirmed, false); assert.equal(rowFor(ctx, fallbackId).executable, false);
  for (const call of ctx.calls.filter(call => call.kind === 'pools')) assert.deepEqual(call.addresses, [CHAINS[call.chain].address]);
  assert.equal(ctx.store.allTrades().length, 0);
});

test('saving a new network route releases a cleared CoinGecko transport failure without waiting for a healthy catalog cache', async t => {
  const ctx = setup(t), entries = catalogEntries();
  ctx.client.discover = async () => {
    ctx.calls.push({ kind: 'directory' });
    throw Object.assign(new Error('private network response'), { code: 'DISCOVERY_NETWORK', networkReason: 'TIMEOUT' });
  };
  ctx.client.contracts = async ({ chain }) => {
    ctx.calls.push({ kind: 'contracts', chain });
    if (chain === 'solana') throw Object.assign(new Error('private rate response'), { code: 'DISCOVERY_RATE_LIMIT', retryAfterMs: 3600000 });
    return entries[chain];
  };
  await ctx.service.discover();
  const initial = ctx.service.snapshot(), catalog = structuredClone(ctx.store.getMeta('opportunities.contract-catalogs.v1'));
  assert.equal(initial.usage.total, 3);
  const healthy = initial.directory.sourceAttempts.find(source => source.source === 'coinpaprika-bnb');
  const limited = initial.directory.sourceAttempts.find(source => source.source === 'coinpaprika-solana');
  assert(healthy.nextAttemptAt > ctx.now() + 5 * 3600000);
  assert.equal(limited.errorCode, 'DISCOVERY_RATE_LIMIT');
  ctx.service.network = { snapshot: () => ({ mode: 'direct', proxyUrl: '' }), saveSettings: async () => ({ mode: 'direct', proxyUrl: '' }) };
  await ctx.service.saveNetworkSettings({ mode: 'direct', proxyUrl: '' });
  const saved = ctx.service.snapshot();
  assert.equal(saved.usage.total, 3); assert.equal(saved.directory.sourceAttempts.find(source => source.source === 'coingecko').status, 'idle');
  assert(ctx.store.getMeta('opportunities.budget.v1').directoryNextAt <= ctx.now(), 'a missing source state is ready now, not after another provider cache expires');
  assert.equal(saved.directory.sourceAttempts.find(source => source.source === 'coinpaprika-solana').nextAttemptAt, limited.nextAttemptAt);
  assert.equal(saved.directory.sourceAttempts.find(source => source.source === 'coinpaprika-solana').errorCode, 'DISCOVERY_RATE_LIMIT');
  assert.deepEqual(ctx.store.getMeta('opportunities.contract-catalogs.v1'), catalog);
  ctx.client.discover = async () => {
    ctx.calls.push({ kind: 'directory' });
    return [{ id: 'coingecko:network-restored-alt', name: 'Network Restored Fixture Alt', symbol: 'FIXALT', source: 'coingecko', observedAt: ctx.now(), chains: CHAINS }];
  };
  const before = ctx.calls.length; await ctx.service.discover();
  const snapshot = ctx.service.snapshot();
  assert.deepEqual(ctx.calls.slice(before), [{ kind: 'directory' }]);
  assert.equal(snapshot.usage.total, 4); assert(snapshot.assets.some(asset => asset.id === 'coingecko:network-restored-alt'));
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika-solana').nextAttemptAt, limited.nextAttemptAt);
  assert.equal(snapshot.directory.sourceAttempts.find(source => source.source === 'coinpaprika-solana').errorCode, 'DISCOVERY_RATE_LIMIT');
  assert.equal(ctx.store.allTrades().length, 0);
});
