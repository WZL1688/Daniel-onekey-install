import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';

const start = Date.parse('2026-11-20T08:00:00Z');
const addresses = { bnb: '0x1111111111111111111111111111111111111111', solana: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr' };
const pools = { bnb: '0x2222222222222222222222222222222222222222', solana: '11111111111111111111111111111111' };
function fixture({ failDirectory = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autodiscovery-regression-')), store = new Store(dir), calls = [];
  let clock = start;
  const now = () => clock;
  const client = {
    discover: async () => {
      calls.push('directory');
      if (failDirectory) throw Object.assign(new Error('Fixture network failure; do not echo raw details'), { code: 'DISCOVERY_NETWORK' });
      return [{ id: 'coingecko:fixture', name: 'Automatic fixture', symbol: 'FIX', source: 'coingecko', chains: { bnb: { address: addresses.bnb }, solana: { address: addresses.solana } }, observedAt: clock }];
    },
    pools: async ({ chain, addresses: requested }) => {
      calls.push(`pools:${chain}`);
      return requested.map(tokenAddress => ({ chain, tokenAddress, poolAddress: pools[chain], quoteAddress: store.config.chains[chain].stableAddress,
        priceUsd: chain === 'bnb' ? .01 : .012, liquidityUsd: 100000, volume24hUsd: 100000, volume1hUsd: 2000, trades1h: 20, observedAt: clock, sourceUpdatedAt: null, dexId: 'fixture' }));
    }
  };
  const service = new OpportunityService({ store, client, now, sleep: async ms => { clock += ms; } });
  return { store, service, client, calls, now, advance: ms => { clock += ms; }, close() { service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('automatic enable bootstraps the directory and scans both chains without any manual asset', async () => {
  const ctx = fixture();
  try {
    const config = JSON.stringify(ctx.store.config);
    await ctx.service.setEnabled(true);
    const snapshot = ctx.service.snapshot();
    assert.deepEqual(ctx.calls, ['directory', 'pools:bnb', 'pools:solana']);
    assert.equal(snapshot.assets.length, 1); assert.equal(snapshot.assets[0].source, 'coingecko');
    assert.equal(snapshot.assets[0].mapping.confirmed, false); assert(snapshot.rows[0].observedAt);
    assert.equal(snapshot.rows[0].stage, 'needs_mapping'); assert.equal(snapshot.rows[0].executable, false);
    assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.allTrades().length, 0);
  } finally { ctx.close(); }
});

test('a failed bootstrap keeps its visible error when an empty scan or timer runs', async () => {
  const ctx = fixture({ failDirectory: true });
  try {
    await ctx.service.setEnabled(true);
    let snapshot = ctx.service.snapshot();
    assert(snapshot.lastError, 'directory failure must remain visible after enable');
    assert.notEqual(snapshot.status, 'monitoring');
    assert.equal(snapshot.directoryUpdatedAt, null); assert.equal(snapshot.updatedAt, null);
    await ctx.service.scan(); ctx.advance(60001); await ctx.service.tick();
    snapshot = ctx.service.snapshot();
    assert(snapshot.lastError, 'an empty scan or cooled-down retry must not erase the last data-source failure');
    assert.notEqual(snapshot.status, 'monitoring');
    assert.equal(ctx.calls.filter(call => call.startsWith('pools:')).length, 0);
    assert.equal(ctx.store.allTrades().length, 0);
  } finally { ctx.close(); }
});

test('empty-directory state reports the actual next directory request time and preserves consumed budget', async () => {
  const ctx = fixture({ failDirectory: true });
  try {
    await ctx.service.setEnabled(true); ctx.advance(2000);
    const snapshot = ctx.service.snapshot();
    assert.equal(snapshot.usage.total, 1);
    assert(snapshot.nextRequestAt > ctx.now(), 'the displayed next request must reflect directory cooldown, not the expired one-second pool gate');
    if (snapshot.directoryNextRequestAt) assert(snapshot.nextRequestAt >= snapshot.directoryNextRequestAt);
    await ctx.service.scan();
    assert.equal(ctx.service.snapshot().usage.total, 1, 'repeated clicks during cooldown do not dispatch or reset budget');
  } finally { ctx.close(); }
});

test('one-shot scanning also discovers an empty directory instead of requiring manual additions', async () => {
  const ctx = fixture();
  try {
    await ctx.service.scan();
    assert.deepEqual(ctx.calls, ['directory', 'pools:bnb', 'pools:solana']);
    assert.equal(ctx.service.snapshot().assets.length, 1);
    assert.equal(ctx.service.snapshot().assets[0].mapping.confirmed, false);
    assert.equal(ctx.store.allTrades().length, 0);
  } finally { ctx.close(); }
});
