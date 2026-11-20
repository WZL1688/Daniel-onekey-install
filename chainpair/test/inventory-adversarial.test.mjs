import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';
import { InventoryCoordinator } from '../src/opportunities/coordinator.mjs';

const ca = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const solPool = 'So11111111111111111111111111111111111111112';
const now = Date.parse('2026-11-20T05:00:00Z');
const vault = { publicStatus: () => ({ bnb: {}, solana: {} }), redact: value => value };

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'inventory-adversarial-'));
  const store = new Store(directory);
  store.setConfig({ ...structuredClone(DEFAULT_CONFIG), executionMode: 'inventory' });
  const engine = new Engine({ store, vault });
  return { store, engine, close() { engine.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('the longest supported discovery ID also fits its immutable execution context', async () => {
  const ctx = setup(), id = `coingecko:${'a'.repeat(100)}`;
  const scanner = new OpportunityService({ store: ctx.store, now: () => now, client: { discover: async () => [{ id, name: 'Long identifier', symbol: 'LID', chains: { bnb: { address: ca }, solana: { address: mint } } }] } });
  try {
    await scanner.discover();
    const entry = scanner.snapshot().assets[0];
    assert.equal(entry.id, id);
    scanner.approveAsset({ id, revision: entry.revision, confirmed: true, evidence: 'Fixture independent contract mapping verification', chains: { bnb: { decimals: 18, poolAddress: pool }, solana: { decimals: 6, poolAddress: solPool } } });
    const coordinator = new InventoryCoordinator({ engine: ctx.engine, scanner, now: () => now });
    assert.doesNotThrow(() => coordinator.context(scanner.getApprovedAsset(id)));
  } finally { scanner.stop(); ctx.close(); }
});

test('a rejected child context cannot leave the parent trading mutex claimed', () => {
  const ctx = setup();
  try {
    const asset = { id: 'manual:invalid', revision: 1, mappingEvidence: 'Fixture invalid context', chains: { bnb: { address: 'bad', decimals: 18, poolAddress: pool }, solana: { address: mint, decimals: 6, poolAddress: solPool } } };
    const scanner = { getApprovedAsset: () => asset };
    const coordinator = new InventoryCoordinator({ engine: ctx.engine, scanner, now: () => now });
    assert.throws(() => coordinator.launch(asset, 'quote'));
    assert.equal(ctx.engine.busy, false);
    assert.equal(coordinator.worker, null);
  } finally { ctx.close(); }
});

test('manual-only scanning does not acquire an unexpected dependency on CoinGecko access', async () => {
  const ctx = setup(); let clock = now, directoryCalls = 0;
  const scanner = new OpportunityService({ store: ctx.store, now: () => clock, sleep: async ms => { clock += ms; }, client: {
    discover: async () => { directoryCalls++; throw Object.assign(new Error('fixture directory requires account'), { code: 'DISCOVERY_AUTH' }); },
    pools: async ({ chain, addresses }) => [{ chain, tokenAddress: addresses[0], poolAddress: chain === 'bnb' ? pool : solPool, quoteAddress: chain === 'bnb' ? '0x3333333333333333333333333333333333333333' : solPool, priceUsd: chain === 'bnb' ? 1 : 1.1, liquidityUsd: 100000, volume24hUsd: 10000, observedAt: clock, dexId: 'fixture' }],
  } });
  try {
    scanner.saveAsset({ name: 'Manual verified candidate', symbol: 'MAN', chains: { bnb: { address: ca }, solana: { address: mint } } });
    await scanner.setEnabled(true);
    assert.equal(scanner.enabled, true); assert.equal(directoryCalls, 0);
    clock += 61000; await scanner.tick();
    assert.equal(directoryCalls, 0);
    assert.equal(scanner.enabled, true);
  } finally { scanner.stop(); ctx.close(); }
});

test('editing a confirmed current pair revokes its old mapping until an explicit reconfirmation', async () => {
  const ctx = setup();
  try {
    const config = structuredClone(ctx.engine.config);
    config.inventory = { ...config.inventory, assetId: 'manual:original', mappingConfirmed: true, mappingEvidence: 'Fixture evidence for the original pair' };
    Object.assign(config.chains.bnb, { tokenAddress: ca, poolAddress: pool, tokenDecimals: 18 });
    Object.assign(config.chains.solana, { tokenAddress: mint, poolAddress: solPool, tokenDecimals: 6 });
    ctx.store.setConfig(config); ctx.engine.config = ctx.store.config;
    const replacement = structuredClone(config);
    replacement.chains.bnb.tokenAddress = '0x4444444444444444444444444444444444444444';
    await ctx.engine.saveConfig(replacement);
    assert.equal(ctx.engine.config.inventory.mappingConfirmed, false);
    assert.equal(ctx.engine.config.inventory.mappingEvidence, '');
    const reconfirmed = structuredClone(ctx.engine.config);
    reconfirmed.inventory.mappingConfirmed = true;
    reconfirmed.inventory.mappingEvidence = 'Fixture new evidence explicitly checked for the replacement pair';
    await ctx.engine.saveConfig(reconfirmed);
    assert.equal(ctx.engine.config.inventory.mappingConfirmed, true);
  } finally { ctx.close(); }
});
