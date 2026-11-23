// Controlled references and local DemoAdapter only. No network or user wallets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';
import { InventoryCoordinator } from '../src/opportunities/coordinator.mjs';

const chains = {
  bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' },
  solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', decimals: 9, poolAddress: '11111111111111111111111111111111' },
};
async function setup(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'anomaly-execution-')), store = new Store(directory);
  const config = structuredClone(store.config); config.executionMode = 'inventory'; store.setConfig(config);
  const vault = { publicStatus: () => ({ bnb: { mode: 'none' }, solana: { mode: 'none' } }), redact: value => String(value) };
  const sent = []; let scanner, asset, adapterCreations = 0, changed = false, referenceCount = 0;
  const pool = (chain, priceUsd) => ({ chain, tokenAddress: chains[chain].address, poolAddress: chains[chain].poolAddress,
    quoteAddress: chain === 'bnb' ? '0x3333333333333333333333333333333333333333' : 'So11111111111111111111111111111111111111112',
    priceUsd, liquidityUsd: 100000, volume24hUsd: 100000, volume1hUsd: 1000, trades1h: 20, observedAt: Date.now() });
  const reference = anomalous => { scanner.markets[asset.id] = { bnb: pool('bnb', anomalous ? .0105 : 1), solana: pool('solana', anomalous ? .00000006 : 1.02), generation: `fixture-${anomalous ? 'quarantine' : 'normal'}-${referenceCount++}` }; };
  class Adapter extends DemoAdapter {
    constructor(args) { super(args); this.buyConfirmed = false; this.sellQuotedAfterBuy = false; }
    async quoteTokenBridge() { throw new Error('Inventory fixture must not request a bridge'); }
    async quoteSwap(args) {
      if (this.buyConfirmed && args.fromToken.kind !== 'stable') this.sellQuotedAfterBuy = true;
      return super.quoteSwap(args);
    }
    async balances(chain) {
      const result = await super.balances(chain);
      if (options.duringSellBalances && this.buyConfirmed && this.sellQuotedAfterBuy && !changed) { changed = true; reference(true); }
      return result;
    }
    async submit(quote, { onSubmitted } = {}) {
      sent.push(quote); const submission = { hash: `anomaly-demo-${sent.length}`, quote, demo: true };
      await onSubmitted?.(submission); return submission;
    }
    async confirm(submission) {
      const receipt = await super.confirm(submission);
      if (submission.quote.fromToken.kind === 'stable') {
        this.buyConfirmed = true;
        if (options.afterBuy && !changed) { changed = true; reference(true); }
      }
      return receipt;
    }
  }
  const engine = new Engine({ store, vault, adapterFactory: args => { adapterCreations++; return new Adapter(args); } });
  await engine.init(); engine.stop();
  scanner = new OpportunityService({ store, getConfig: () => engine.config, client: { discover: async () => [], pools: async () => [] } });
  asset = scanner.saveAsset({ name: 'Anomaly fixture only', symbol: 'ANMFIX', chains }).assets[0];
  scanner.approveAsset({ id: asset.id, revision: asset.revision, confirmed: true, evidence: 'Controlled fixture mapping; no real asset claim', chains });
  asset = scanner.assets.get(asset.id); scanner.enabled = true;
  const coordinator = new InventoryCoordinator({ engine, scanner });
  t.after(async () => {
    if (coordinator.pending) await coordinator.pending.catch(() => {});
    scanner.stop(); engine.stop(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { engine, store, scanner, coordinator, asset, sent, reference, adapterCreations: () => adapterCreations };
}
const errorIsQuarantine = error => error?.safe === true && /异常|隔离|价差/.test(error.message);

test('a known anomalous comparison is refused before creating any quote worker or consuming execution quota', async t => {
  const ctx = await setup(t); ctx.reference(true);
  assert.equal(ctx.scanner.snapshot().rows[0].comparisonStatus, 'quarantined');
  const before = ctx.adapterCreations();
  await assert.rejects(ctx.coordinator.quote(ctx.asset.id), errorIsQuarantine);
  assert.equal(ctx.adapterCreations(), before); assert.equal(ctx.coordinator.worker, null); assert.equal(ctx.coordinator.job, null);
  assert.equal(ctx.engine.busy, false); assert.equal(ctx.store.stats().executions, 0); assert.equal(ctx.store.allTrades().length, 0); assert.deepEqual(ctx.sent, []);
});

test('a previously fresh authorization is deleted when a newer same-asset comparison is quarantined', async t => {
  const ctx = await setup(t); ctx.reference(false);
  assert.equal((await ctx.coordinator.quote(ctx.asset.id)).executable, true);
  assert(ctx.coordinator.authorizations.has(ctx.asset.id));
  const revision = ctx.asset.revision; ctx.reference(true);
  assert.equal(ctx.asset.revision, revision); assert.equal(ctx.scanner.snapshot().rows[0].executable, false);
  assert.throws(() => ctx.coordinator.execute(ctx.asset.id), errorIsQuarantine);
  assert.equal(ctx.coordinator.authorizations.has(ctx.asset.id), false); assert.equal(ctx.engine.busy, false);
  assert.equal(ctx.store.stats().executions, 0); assert.deepEqual(ctx.sent, []);
  // A recovered reference does not resurrect a consumed authorization.
  ctx.reference(false); ctx.scanner.updateComparisonQuarantine(ctx.asset); assert.throws(() => ctx.coordinator.execute(ctx.asset.id), /重新复核/);
});

test('a rejected requote clears an old authorization rather than leaving it available after recovery', async t => {
  const ctx = await setup(t); ctx.reference(false); await ctx.coordinator.quote(ctx.asset.id);
  ctx.reference(true); await assert.rejects(ctx.coordinator.quote(ctx.asset.id), errorIsQuarantine);
  ctx.reference(false); ctx.scanner.updateComparisonQuarantine(ctx.asset); assert.throws(() => ctx.coordinator.authorization(ctx.asset.id), /重新复核/);
  assert.deepEqual(ctx.sent, []); assert.equal(ctx.store.allTrades().length, 0);
});

test('missing public reference observations still allow an explicitly approved fresh adapter quote', async t => {
  const ctx = await setup(t);
  assert.equal(ctx.scanner.snapshot().rows[0].comparisonStatus, 'unavailable');
  assert.equal((await ctx.coordinator.quote(ctx.asset.id)).executable, true);
  assert.equal(ctx.store.stats().executions, 0); assert.deepEqual(ctx.sent, []);
});

for (const [name, options] of [
  ['after the confirmed buy', { afterBuy: true }],
  ['during asynchronous sell balance rechecks', { duringSellBalances: true }],
]) test(`a comparison quarantined ${name} prevents SELL and retains unresolved exposure`, async t => {
  const ctx = await setup(t, options); ctx.reference(false);
  await ctx.coordinator.quote(ctx.asset.id); ctx.engine.running = true;
  assert.equal(ctx.coordinator.execute(ctx.asset.id).accepted, true);
  const pending = ctx.coordinator.pending;
  await assert.rejects(pending, errorIsQuarantine);
  assert.equal(ctx.sent.length, 1); assert.equal(ctx.sent[0].fromToken.kind, 'stable');
  assert.equal(ctx.engine.running, false); assert.match(ctx.engine.pausedReason, /核对/);
  const trade = ctx.store.allTrades()[0]; assert.equal(trade.status, 'NEEDS_REVIEW');
  assert.equal(trade.legs.length, 1); assert.equal(trade.legs[0].name, 'BUY'); assert.equal(trade.legs[0].status, 'CONFIRMED');
  assert(BigInt(ctx.store.getReservedInventory({ mode: 'demo', chain: trade.sellChain, address: chains[trade.sellChain].address })) > 0n);
  assert.equal(ctx.store.stats().executions, 1); assert.equal(ctx.coordinator.snapshot().job.status, 'needs_review');
  assert.equal(ctx.coordinator.authorizations.size, 0);
});


test('an incomplete later reference cannot clear a quarantined pair and the latch survives scanner restart', async t => {
  const ctx = await setup(t); ctx.reference(false); await ctx.coordinator.quote(ctx.asset.id);
  ctx.reference(true);
  const fixtureSecret = 'fixture-untrusted-evidence-field-not-a-real-key';
  Object.assign(ctx.scanner.markets[ctx.asset.id].solana, { secretKey: fixtureSecret, extraUntrusted: fixtureSecret, raw: { password: fixtureSecret } });
  assert.throws(() => ctx.coordinator.authorization(ctx.asset.id), errorIsQuarantine);
  const originalEvidence = structuredClone(ctx.scanner.snapshot().rows[0].quarantineEvidence);
  assert.equal(originalEvidence.market.solana.poolAddress, chains.solana.poolAddress);
  assert.equal(originalEvidence.market.solana.priceUsd, .00000006);
  assert(Number.isSafeInteger(originalEvidence.observedAt));
  assert.equal(JSON.stringify(originalEvidence).includes(fixtureSecret), false);
  for (const name of ['secretKey','extraUntrusted','raw']) assert.equal(Object.hasOwn(originalEvidence.market.solana, name), false);
  delete ctx.scanner.markets[ctx.asset.id].solana;
  ctx.scanner.updateComparisonQuarantine(ctx.asset);
  const incomplete = ctx.scanner.snapshot().rows[0];
  assert.equal(incomplete.comparisonStatus, 'quarantined');
  assert.equal(incomplete.market.solana, null); assert.deepEqual(incomplete.quarantineEvidence, originalEvidence);
  await assert.rejects(ctx.coordinator.quote(ctx.asset.id), errorIsQuarantine);
  const restarted = new OpportunityService({ store: ctx.store, getConfig: () => ctx.engine.config, client: { discover: async () => [], pools: async () => [] } });
  try {
    const restored = restarted.snapshot().rows[0];
    assert.equal(restored.comparisonStatus, 'quarantined'); assert.deepEqual(restored.quarantineEvidence, originalEvidence);
    assert.equal(restored.quarantineEvidence.market.solana.poolAddress, chains.solana.poolAddress);
    assert.equal(restored.quarantineEvidence.market.solana.priceUsd, .00000006);
    assert.equal(JSON.stringify(restored.quarantineEvidence).includes(fixtureSecret), false);
    assert.throws(() => restarted.assertComparisonUsable(ctx.asset.id), errorIsQuarantine);
    assert.equal(ctx.store.stats().executions, 0); assert.deepEqual(ctx.sent, []);
  } finally { restarted.stop(); }
});

test('only a fresh bilateral normal reference releases quarantine and no previous execution authorization returns', async t => {
  const ctx = await setup(t); ctx.reference(false); await ctx.coordinator.quote(ctx.asset.id);
  ctx.reference(true); assert.throws(() => ctx.coordinator.authorization(ctx.asset.id), errorIsQuarantine);
  ctx.reference(false);
  for (const chain of ['bnb','solana']) ctx.scanner.markets[ctx.asset.id][chain].observedAt = Date.now() - 121000;
  ctx.scanner.updateComparisonQuarantine(ctx.asset);
  assert.equal(ctx.scanner.snapshot().rows[0].comparisonStatus, 'quarantined');
  ctx.reference(false); ctx.scanner.updateComparisonQuarantine(ctx.asset);
  assert.equal(ctx.scanner.snapshot().rows[0].comparisonStatus, 'comparable');
  assert.throws(() => ctx.coordinator.execute(ctx.asset.id), /重新复核/);
  assert.equal(ctx.coordinator.authorizations.has(ctx.asset.id), false); assert.deepEqual(ctx.sent, []);
  assert.equal((await ctx.coordinator.quote(ctx.asset.id)).executable, true);
  assert.equal(ctx.store.stats().executions, 0);
});
