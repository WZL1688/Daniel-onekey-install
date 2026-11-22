import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';

test('one directory provider rate limit cannot starve fallback and token-pool scanning', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'directory-isolation-')), store = new Store(dir), calls = [];
  let clock = Date.parse('2026-11-20T08:00:00Z');
  const candidate = { id: `wormhole:${'a'.repeat(40)}`, name: 'Fixed metadata fixture', symbol: 'FIX', source: 'wormhole', sourceKind: 'bundled',
    chains: { bnb: { address: '0x1111111111111111111111111111111111111111' }, solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr' } }, observedAt: clock };
  const client = {
    discover: async () => { calls.push('coingecko'); throw Object.assign(new Error('Provider quota fixture'), { code: 'DISCOVERY_RATE_LIMIT', retryAfterMs: 60000 }); },
    discoverWrapped: async () => { calls.push('wormhole'); return [candidate]; },
    pools: async ({ chain, addresses }) => { calls.push(`pools:${chain}`); return addresses.map(tokenAddress => ({ chain, tokenAddress,
      poolAddress: chain === 'bnb' ? '0x2222222222222222222222222222222222222222' : '11111111111111111111111111111111',
      quoteAddress: store.config.chains[chain].stableAddress, priceUsd: chain === 'bnb' ? .01 : .012, liquidityUsd: 100000, volume24hUsd: 50000, volume1hUsd: 2000, trades1h: 20, observedAt: clock, dexId: 'fixture' })); }
  };
  const service = new OpportunityService({ store, client, bundledCandidates: [candidate], now: () => clock, sleep: async ms => { clock += ms; } });
  try {
    await service.setEnabled(true);
    assert.equal(calls.filter(call => call === 'coingecko').length, 1);
    assert(calls.includes('wormhole'), 'independent fallback should remain reachable while primary honors its Retry-After');
    assert(calls.includes('pools:bnb') && calls.includes('pools:solana'), 'known candidates must still obtain both pool markets');
    assert.equal(service.snapshot().rows[0].asset.mapping.confirmed, false);
    assert.equal(service.snapshot().rows[0].executable, false);
    assert(service.snapshot().directory.sourceAttempts.find(item => item.source === 'coingecko').nextAttemptAt > clock);
    assert.equal(store.allTrades().length, 0);
  } finally { service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
