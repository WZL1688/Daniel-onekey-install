import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';
import { bundledDirectory } from '../src/opportunities/bundled.mjs';

const initial = Date.parse('2026-11-20T09:00:00Z');
function setup({ bundle = false, fallback = false, primaryCode = 'DISCOVERY_NETWORK' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'automatic-pipeline-')), store = new Store(dir), calls = [];
  let clock = initial;
  const candidates = bundledDirectory();
  const now = () => clock, sleep = async ms => { clock += ms; };
  const client = {
    discover: async args => { calls.push(['directory', args.apiKey]); throw Object.assign(new Error('Remote error must remain private'), { code: primaryCode }); },
    pools: async ({ chain, addresses }) => { calls.push([chain, addresses.length, addresses.slice()]); return addresses.map(tokenAddress => ({ chain, tokenAddress, poolAddress: chain === 'bnb' ? '0x2222222222222222222222222222222222222222' : '11111111111111111111111111111111', quoteAddress: store.config.chains[chain].stableAddress, priceUsd: chain === 'bnb' ? .01 : .012, liquidityUsd: 100000, volume24hUsd: 1000000, volume1hUsd: 2000, trades1h: 20, observedAt: clock, dexId: 'fixed-fixture-only' })); }
  };
  if (fallback) client.discoverWrapped = async () => { calls.push(['wrapped']); return candidates.slice(0, 1).map(row => ({ ...row, sourceKind: 'remote' })); };
  const service = new OpportunityService({ store, client, now, sleep, bundledCandidates: bundle ? candidates : [] });
  return { dir, store, service, client, calls, now, sleep, advance: ms => { clock += ms; }, close() { service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function settled(service) { for (let i = 0; i < 100; i++) { await new Promise(resolve => setImmediate(resolve)); if (!service.busy) return; } throw new Error('Fixture automatic job failed to settle'); }

test('bundled official mappings are real origin-backed metadata with no fabricated price, balance or approval', () => {
  const rows = bundledDirectory(); assert.equal(rows.length, 32);
  const identities = new Set();
  for (const row of rows) {
    assert.match(row.id, /^wormhole:[a-f0-9]{40}$/); assert(row.origin.chain); assert(row.origin.address);
    assert.equal(row.sourceDate, '2026-04-08'); assert.equal(row.sourceKind, 'bundled');
    assert.equal(row.mapping, undefined); assert.equal(row.priceUsd, undefined); assert.equal(row.balance, undefined);
    assert(!identities.has(row.id)); identities.add(row.id);
  }
});

test('first launch automatically seeds and scans both chains despite directory network failure, without manual input or trades', async () => {
  const ctx = setup({ bundle: true });
  try {
    const config = JSON.stringify(ctx.store.config);
    ctx.service.start();
    assert.equal(ctx.service.enabled, true); assert.equal(ctx.service.snapshot().assets.length, 32, 'seed is immediately visible before remote fetch');
    await settled(ctx.service);
    const state = ctx.service.snapshot();
    assert(ctx.calls.some(call => call[0] === 'directory')); assert(ctx.calls.some(call => call[0] === 'bnb')); assert(ctx.calls.some(call => call[0] === 'solana'));
    assert.equal(state.directory.source, 'bundled-wormhole'); assert.equal(state.directory.sourceDate, '2026-04-08');
    // The bundled32 remains observable, but only its9 altcoin candidates use
    // pool requests; stablecoins and BTC/ETH/BNB/SOL wrappers stay excluded.
    assert.equal(state.scanProgress.scannedAssets, 9); assert.equal(state.scanProgress.withBothMarkets, 9);
    assert.equal(state.counts.eligible, 9); assert.equal(state.counts.excluded, 23);
    assert.equal(state.counts.candidate, 9); assert.deepEqual(ctx.service.executionCandidates(), []);
    const requestedBnb = ctx.calls.find(call => call[0] === 'bnb')[2];
    assert.equal(requestedBnb.length, 9);
    for (const row of state.rows.filter(row => ['stablecoin', 'major'].includes(row.universe.category))) {
      assert.equal(requestedBnb.includes(row.asset.chains.bnb.address), false);
      assert.equal(row.marketQualified, false); assert.equal(row.opportunityQualified, false);
    }
    assert.equal(state.status, 'partial'); assert.match(state.lastError, /CoinGecko/);
    assert(state.assets.every(asset => asset.mapping.confirmed === false)); assert(state.rows.every(row => row.executable === false));
    assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.allTrades().length, 0);
  } finally { ctx.close(); }
});

test('network retry is exponential, visible and persistent without clearing consumed requests', async () => {
  const ctx = setup();
  try {
    await ctx.service.setEnabled(true);
    let state = ctx.service.snapshot(); assert.equal(state.usage.total, 1); assert.equal(state.directoryNextRequestAt, initial + 60000);
    await ctx.service.scan(); assert.equal(ctx.service.snapshot().usage.total, 1);
    ctx.advance(60001); await ctx.service.tick(); state = ctx.service.snapshot();
    assert.equal(state.usage.total, 2); assert.equal(state.directory.errorCode, 'DISCOVERY_NETWORK');
    assert(state.directoryNextRequestAt >= ctx.now() + 120000); assert(state.directoryNextRequestAt < ctx.now() + 900001);
    const restarted = new OpportunityService({ store: ctx.store, client: ctx.client, now: ctx.now, sleep: ctx.sleep });
    assert.match(restarted.snapshot().lastError, /CoinGecko/); assert.equal(restarted.snapshot().usage.total, 2);
    assert.equal(restarted.snapshot().directoryNextRequestAt, state.directoryNextRequestAt); restarted.stop();
  } finally { ctx.close(); }
});

test('a stable or major official fallback is counted but cannot consume pool requests or become an altcoin opportunity', async () => {
  const ctx = setup({ fallback: true, primaryCode: 'DISCOVERY_AUTH' });
  try {
    await ctx.service.setEnabled(true); const state = ctx.service.snapshot();
    assert.deepEqual(ctx.calls.map(call => call[0]), ['directory','wrapped']);
    assert.equal(state.usage.total, 2); assert.equal(state.enabled, true); assert.equal(state.directory.source, 'wormhole');
    assert.equal(state.assets.length, 1); assert.equal(state.assets[0].mapping.confirmed, false); assert.equal(state.rows[0].stage, 'blocked');
    assert.equal(state.rows[0].universe.eligible, false); assert.equal(state.rows[0].opportunityQualified, false);
    assert.equal(state.directory.sourceAttempts.find(source => source.source === 'coingecko').status, 'auth_required');
    assert.equal(state.directory.sourceAttempts.find(source => source.source === 'wormhole').status, 'ready');
    assert.equal(state.scanProgress.withBothMarkets, 0); assert.equal(ctx.store.allTrades().length, 0);
  } finally { ctx.close(); }
});

test('read-only auto-scan preference survives restart while a user stop is respected', async () => {
  const ctx = setup({ bundle: true });
  try {
    ctx.service.start(); await settled(ctx.service); ctx.service.stop(); ctx.advance(2000);
    const resumed = new OpportunityService({ store: ctx.store, client: ctx.client, now: ctx.now, sleep: ctx.sleep });
    resumed.start(); assert.equal(resumed.enabled, true); await settled(resumed);
    await resumed.setEnabled(false); resumed.stop();
    const before = ctx.calls.length, stopped = new OpportunityService({ store: ctx.store, client: ctx.client, now: ctx.now, sleep: ctx.sleep });
    stopped.start(); await settled(stopped); assert.equal(stopped.enabled, false); assert.equal(ctx.calls.length, before); stopped.stop();
    assert.equal(ctx.store.config.mode, 'demo'); assert.equal(ctx.store.allTrades().length, 0);
  } finally { ctx.close(); }
});

test('v1.4 failed six-hour local cooldown migrates without erasing quota or a provider Retry-After', () => {
  const ctx = setup();
  try {
    ctx.store.setMeta('opportunities.budget.v1', { total: 1, requests: [initial], lastClock: initial, nextAt: initial + 3600000, directoryNextAt: initial + 21600000 });
    const upgraded = new OpportunityService({ store: ctx.store, client: ctx.client, now: ctx.now, sleep: ctx.sleep });
    assert.equal(upgraded.snapshot().usage.total, 1); assert.equal(upgraded.snapshot().nextRequestAt, initial + 3600000);
    assert.equal(ctx.store.getMeta('opportunities.budget.v1').requests.length, 1); upgraded.stop();
  } finally { ctx.close(); }
});

test('stopping discovery discards late data and does not start an extra fallback or pool request', async () => {
  const ctx = setup({ fallback: true }); let finish;
  try {
    ctx.client.discover = () => new Promise(resolve => { finish = resolve; });
    const pending = ctx.service.scan({ refreshDirectory: true });
    assert.equal(ctx.service.busy, true); await ctx.service.setEnabled(false);
    finish(bundledDirectory().slice(0, 1)); await pending;
    assert.equal(ctx.service.snapshot().assets.length, 0); assert.equal(ctx.service.snapshot().usage.total, 1);
    assert.equal(ctx.calls.length, 0); assert.equal(ctx.service.enabled, false); assert.equal(ctx.service.busy, false);
    assert.notEqual(ctx.service.snapshot().directory.sourceAttempts[0].status, 'loading');
  } finally { ctx.close(); }
});

test('credential changes preserve a directory provider Retry-After and all consumed budget', async () => {
  const ctx = setup({ bundle: true, fallback: true, primaryCode: 'DISCOVERY_RATE_LIMIT' });
  try {
    await ctx.service.setEnabled(true);
    const before = ctx.service.snapshot(), retryAt = before.directory.sourceAttempts.find(source => source.source === 'coingecko').nextAttemptAt;
    ctx.service.credentialsChanged(); await ctx.service.discover();
    assert.equal(ctx.service.snapshot().usage.total, before.usage.total);
    assert.equal(ctx.calls.filter(call => call[0] === 'directory').length, 1);
    assert.equal(ctx.service.snapshot().directory.sourceAttempts.find(source => source.source === 'coingecko').nextAttemptAt, retryAt);
    ctx.advance(retryAt - ctx.now() + 1); await ctx.service.discover();
    assert.equal(ctx.calls.filter(call => call[0] === 'directory').length, 2);
    assert(ctx.service.snapshot().directoryNextRequestAt >= ctx.now() + 120000);
  } finally { ctx.close(); }
});

test('automatic startup extends a previous manual list with unapproved official candidates', async () => {
  const ctx = setup({ bundle: true });
  try {
    ctx.service.saveAsset({ name: 'Manual fixture', chains: { bnb: { address: '0x1111111111111111111111111111111111111111' }, solana: { address: 'So11111111111111111111111111111111111111112' } } });
    ctx.service.start(); await settled(ctx.service);
    assert.equal(ctx.service.snapshot().assets.filter(asset => asset.source === 'wormhole').length, 32);
    assert(ctx.calls.some(call => call[0] === 'directory')); assert(ctx.calls.some(call => call[0] === 'solana'));
    assert(ctx.service.snapshot().assets.every(asset => !asset.mapping.confirmed)); assert.equal(ctx.store.allTrades().length, 0);
  } finally { ctx.close(); }
});
