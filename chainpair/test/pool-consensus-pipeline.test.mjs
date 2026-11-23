// Real scanner/coordinator with controlled public observations and local Demo
// quotes. No external market request, wallet secret, signature or submission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { getAddress } from 'ethers';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';
import { InventoryCoordinator } from '../src/opportunities/coordinator.mjs';

const bnb = index => getAddress(`0x${(index + 7000).toString(16).padStart(40, '0')}`);
const sol = index => { const bytes = new Uint8Array(32); bytes[0] = 37; bytes[28] = 99; bytes[30] = Math.floor(index / 256); bytes[31] = index % 256; return new PublicKey(bytes).toBase58(); };
const poolAddress = (chain, index) => chain === 'bnb' ? bnb(index + 10) : sol(index + 10);
const chains = { bnb: { address: bnb(1), decimals: 18, poolAddress: poolAddress('bnb', 1) }, solana: { address: sol(1), decimals: 9, poolAddress: poolAddress('solana', 1) } };

async function setup(t, { approved = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pool-consensus-pipeline-')), store = new Store(dir);
  const config = structuredClone(store.config); config.executionMode = 'inventory'; store.setConfig(config);
  const vault = { publicStatus: () => ({ bnb: { mode: 'none' }, solana: { mode: 'none' } }), redact: value => String(value) };
  const sent = [], calls = []; let clock = Date.now();
  class QuoteOnlyAdapter extends DemoAdapter {
    async submit(quote) { sent.push(quote); throw new Error('This read-only consensus fixture must never submit'); }
  }
  const engine = new Engine({ store, vault, adapterFactory: args => new QuoteOnlyAdapter(args) }); await engine.init(); engine.stop();
  const pool = (chain, index, priceUsd = chain === 'bnb' ? 1 : 1.02, patch = {}) => ({
    chain, tokenAddress: chains[chain].address, quoteAddress: chain === 'bnb' ? bnb(90) : sol(90), poolAddress: poolAddress(chain, index),
    priceUsd, priceMethod: 'provider-base-usd', liquidityUsd: 100000, volume24hUsd: 100000, volume1hUsd: 2000, trades1h: 20,
    observedAt: clock, dexId: 'controlled-pool-fixture', ...patch,
  });
  const client = { discover: async () => [], pools: async ({ chain, addresses }) => { calls.push({ chain, addresses }); return [pool(chain, 1)]; } };
  const args = { store, vault, getConfig: () => engine.config, client, now: () => clock, sleep: async ms => { clock += ms; } };
  const scanner = new OpportunityService(args);
  const assetId = scanner.saveAsset({ name: 'Consensus fixture altcoin', symbol: 'CFALT', chains }).assets[0].id;
  if (approved) { const asset = scanner.assets.get(assetId); scanner.approveAsset({ id: assetId, revision: asset.revision, confirmed: true, evidence: 'Controlled source identity, not a real investment claim', chains }); }
  scanner.enabled = true; const coordinator = new InventoryCoordinator({ engine, scanner });
  const restarted = [];
  t.after(async () => {
    await coordinator.pending?.catch(() => {});
    for (const item of restarted) item.stop();
    scanner.stop(); engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, engine, scanner, coordinator, sent, calls, client, pool, assetId, now: () => clock, advance: ms => { clock += ms; },
    row: (service = scanner) => service.snapshot().rows.find(row => row.asset.id === assetId),
    restart: () => { const item = new OpportunityService(args); restarted.push(item); return item; } };
}
const isQuarantined = error => error?.safe === true && /隔离|异常/.test(error.message);

test('a single pool on each chain remains a low-confidence normal reference and cannot auto-approve an asset', async t => {
  const ctx = await setup(t); await ctx.scanner.scan(); const row = ctx.row();
  assert.equal(row.comparisonStatus, 'comparable'); assert.equal(row.marketQualified, true); assert.equal(row.opportunityQualified, true);
  for (const chain of ['bnb', 'solana']) {
    assert.equal(row.market[chain].priceConfidence, 'single-pool'); assert.equal(row.market[chain].priceConflict, false);
    assert.deepEqual(row.market[chain].poolDiagnostics, { eligiblePools: 1, totalPools: 1, agreementPools: 1, rejectedOutliers: 0 });
  }
  assert.equal(row.asset.mapping.confirmed, false); assert.equal(row.executable, false); assert.equal(ctx.store.allTrades().length, 0); assert.deepEqual(ctx.sent, []);
});

test('two agreeing live pools select a real observed quote instead of a much larger-liquidity outlier', async t => {
  const ctx = await setup(t);
  ctx.client.pools = async ({ chain }) => [
    ctx.pool(chain, 1, chain === 'bnb' ? 1 : 1.03),
    ctx.pool(chain, 2, chain === 'bnb' ? 1.01 : 1.04, { liquidityUsd: 200000 }),
    ctx.pool(chain, 3, .00000006, { liquidityUsd: 5000000 }),
  ];
  await ctx.scanner.scan(); const row = ctx.row();
  assert.equal(row.comparisonStatus, 'comparable'); assert.equal(row.opportunityQualified, true);
  assert.equal(row.market.bnb.priceUsd, 1.01); assert.equal(row.market.solana.priceUsd, 1.04);
  for (const chain of ['bnb', 'solana']) {
    assert.equal(row.market[chain].poolAddress, poolAddress(chain, 2)); assert.equal(row.market[chain].priceConfidence, 'pool-consensus');
    assert.equal(row.market[chain].priceConflict, false); assert.equal(row.market[chain].poolDiagnostics.agreementPools, 2); assert.equal(row.market[chain].poolDiagnostics.rejectedOutliers, 1);
  }
  assert.equal(ctx.store.stats().executions, 0); assert.deepEqual(ctx.sent, []);
});

test('a same-chain conflict quarantines a small cross-chain spread and invalidates a previously valid manual authorization', async t => {
  const ctx = await setup(t, { approved: true }); await ctx.scanner.scan();
  assert.equal((await ctx.coordinator.quote(ctx.assetId)).executable, true); assert(ctx.coordinator.authorizations.has(ctx.assetId));
  const revision = ctx.scanner.assets.get(ctx.assetId).revision;
  ctx.client.pools = async ({ chain }) => chain === 'bnb'
    ? [ctx.pool(chain, 1, 1, { liquidityUsd: 200000 }), ctx.pool(chain, 2, .00000006)]
    : [ctx.pool(chain, 1, 1.02)];
  await ctx.scanner.scan(); const row = ctx.row();
  assert(row.spreadBps > 100 && row.spreadBps < 3000, 'the cross-chain difference alone would look ordinary');
  assert.equal(row.asset.revision, revision); assert.equal(row.market.bnb.priceConflict, true); assert.equal(row.market.bnb.priceConfidence, 'conflicting-pools');
  assert.equal(row.comparisonStatus, 'quarantined'); assert.equal(row.marketQualified, false); assert.equal(row.opportunityQualified, false);
  assert.equal(row.indicativeGrossUsd, null); assert.equal(row.executable, false); assert(row.reasons.some(reason => reason.includes('同链')));
  assert.throws(() => ctx.coordinator.authorization(ctx.assetId), isQuarantined); assert.equal(ctx.coordinator.authorizations.has(ctx.assetId), false);
  assert.throws(() => ctx.coordinator.execute(ctx.assetId), isQuarantined); assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.store.stats().executions, 0); assert.deepEqual(ctx.sent, []);
});

test('an approved outlier pool is preserved and quarantined rather than silently replaced by the consensus', async t => {
  const ctx = await setup(t, { approved: true });
  ctx.client.pools = async ({ chain }) => chain === 'bnb'
    ? [ctx.pool(chain, 1, .00000006, { liquidityUsd: 5000000 }), ctx.pool(chain, 2, 1), ctx.pool(chain, 3, 1.01)]
    : [ctx.pool(chain, 1, 1.02), ctx.pool(chain, 2, 1.03)];
  await ctx.scanner.scan(); const row = ctx.row();
  assert.equal(row.market.bnb.poolAddress, chains.bnb.poolAddress); assert.equal(row.market.bnb.priceUsd, .00000006);
  assert.equal(row.market.bnb.priceConflict, true); assert.equal(row.comparisonStatus, 'quarantined'); assert.equal(row.indicativeGrossUsd, null);
  await assert.rejects(ctx.coordinator.quote(ctx.assetId), isQuarantined); assert.equal(ctx.coordinator.worker, null); assert.deepEqual(ctx.sent, []);
});

test('conflict fields and first-pool evidence survive partial observations and restart until a fresh bilateral consensus scan', async t => {
  const ctx = await setup(t, { approved: true });
  ctx.client.pools = async ({ chain }) => chain === 'bnb'
    ? [ctx.pool(chain, 1, 1, { liquidityUsd: 200000 }), ctx.pool(chain, 2, .00000006)]
    : [ctx.pool(chain, 1, 1.02)];
  await ctx.scanner.scan(); const evidence = structuredClone(ctx.row().quarantineEvidence);
  assert.equal(evidence.market.bnb.priceConflict, true); assert.equal(evidence.market.bnb.priceConfidence, 'conflicting-pools');
  assert.equal(ctx.store.getMeta('opportunities.market.v1')[ctx.assetId].bnb.priceConflict, true);
  const restored = ctx.restart();
  assert.equal(ctx.row(restored).market.bnb.priceConflict, true); assert.equal(ctx.row(restored).comparisonStatus, 'quarantined');
  assert.deepEqual(ctx.row(restored).quarantineEvidence, evidence);
  ctx.client.pools = async ({ chain }) => chain === 'solana' ? [] : [ctx.pool(chain, 1, 1), ctx.pool(chain, 2, 1.01)];
  await restored.scan(); assert.equal(ctx.row(restored).comparisonStatus, 'quarantined'); assert.equal(ctx.row(restored).market.solana, null);
  assert.deepEqual(ctx.row(restored).quarantineEvidence, evidence);
  ctx.client.pools = async ({ chain }) => [ctx.pool(chain, 1, chain === 'bnb' ? 1 : 1.03), ctx.pool(chain, 2, chain === 'bnb' ? 1.01 : 1.04)];
  await restored.scan(); const recovered = ctx.row(restored);
  assert.equal(recovered.market.bnb.priceConfidence, 'pool-consensus'); assert.equal(recovered.market.solana.priceConfidence, 'pool-consensus');
  assert.equal(recovered.comparisonStatus, 'comparable'); assert.equal(recovered.anomalous, false); assert.equal(recovered.quarantineEvidence, null);
  assert.equal(Object.hasOwn(ctx.store.getMeta('opportunities.comparison-quarantine.v1'), ctx.assetId), false);
  assert.doesNotThrow(() => restored.assertComparisonUsable(ctx.assetId)); assert.deepEqual(ctx.sent, []);
});

test('pool confidence diagnostics are recomputed and sanitized instead of trusting remote claims', async t => {
  const ctx = await setup(t), secret = 'fixture-untrusted-consensus-metadata-not-a-key';
  ctx.client.pools = async ({ chain }) => [ctx.pool(chain, 1, chain === 'bnb' ? 1 : 1.02, {
    secretKey: secret, raw: { token: secret }, priceConfidence: 'pool-consensus', priceConflict: false,
    poolDiagnostics: { totalPools: 900000, agreementPools: 900000, eligiblePools: 900000, rejectedOutliers: -1, secretKey: secret },
  })];
  await ctx.scanner.scan(); const row = ctx.row();
  assert.equal(row.market.bnb.priceConfidence, 'single-pool'); assert.equal(row.market.bnb.poolDiagnostics.totalPools, 1);
  assert.deepEqual(Object.keys(row.market.bnb.poolDiagnostics).sort(), ['agreementPools','eligiblePools','rejectedOutliers','totalPools']);
  assert.equal(JSON.stringify(ctx.scanner.snapshot()).includes(secret), false);
});

test('a missing approved pool cannot silently migrate to another agreeing reference', async t => {
  const ctx = await setup(t, { approved: true });
  ctx.client.pools = async ({ chain }) => [ctx.pool(chain, 2, chain === 'bnb' ? 1 : 1.02), ctx.pool(chain, 3, chain === 'bnb' ? 1.01 : 1.03)];
  await ctx.scanner.scan(); const row = ctx.row();
  assert.equal(row.market.bnb, null); assert.equal(row.market.solana, null); assert.equal(row.marketQualified, false);
  assert.equal(row.opportunityQualified, false); assert.equal(row.executable, false); assert.equal(row.indicativeGrossUsd, null);
  assert.equal(ctx.scanner.assets.get(ctx.assetId).chains.bnb.poolAddress, chains.bnb.poolAddress); assert.deepEqual(ctx.sent, []);
});

test('a previously conflicted side cannot be released merely because only one normal-looking pool is returned', async t => {
  const ctx = await setup(t, { approved: true });
  ctx.client.pools = async ({ chain }) => chain === 'bnb'
    ? [ctx.pool(chain, 1, 1, { liquidityUsd: 200000 }), ctx.pool(chain, 2, .00000006)]
    : [ctx.pool(chain, 1, 1.02)];
  await ctx.scanner.scan(); assert.equal(ctx.row().comparisonStatus, 'quarantined');
  assert(ctx.store.getMeta('opportunities.comparison-quarantine.v1')[ctx.assetId].requiresConsensus.includes('bnb'));
  ctx.client.pools = async ({ chain }) => [ctx.pool(chain, 1)];
  await ctx.scanner.scan();
  assert.equal(ctx.row().market.bnb.priceConfidence, 'single-pool'); assert.equal(ctx.row().market.bnb.priceConflict, false);
  assert.equal(ctx.row().comparisonStatus, 'quarantined'); assert.equal(ctx.row().indicativeGrossUsd, null);
  const restarted = ctx.restart(); assert.equal(ctx.row(restarted).comparisonStatus, 'quarantined');
  ctx.client.pools = async ({ chain }) => [ctx.pool(chain, 1), ctx.pool(chain, 2, chain === 'bnb' ? 1.01 : 1.03)];
  await restarted.scan(); assert.equal(ctx.row(restarted).comparisonStatus, 'comparable');
  assert.equal(ctx.row(restarted).market.bnb.priceConfidence, 'pool-consensus'); assert.equal(ctx.row(restarted).market.solana.priceConfidence, 'pool-consensus');
});

test('later same-chain conflicts upgrade an earlier cross-chain quarantine without replacing its first evidence', async t => {
  const ctx = await setup(t, { approved: true });
  ctx.client.pools = async ({ chain }) => [ctx.pool(chain, 1, chain === 'bnb' ? .0105 : .00000006)];
  await ctx.scanner.scan(); const originalEvidence = structuredClone(ctx.row().quarantineEvidence);
  assert.equal(ctx.row().comparisonStatus, 'quarantined');
  assert.deepEqual(ctx.store.getMeta('opportunities.comparison-quarantine.v1')[ctx.assetId].requiresConsensus || [], []);
  ctx.client.pools = async ({ chain }) => chain === 'bnb'
    ? [ctx.pool(chain, 1, 1, { liquidityUsd: 200000 }), ctx.pool(chain, 2, .00000006)]
    : [ctx.pool(chain, 1, 1.02)];
  await ctx.scanner.scan();
  assert(ctx.store.getMeta('opportunities.comparison-quarantine.v1')[ctx.assetId].requiresConsensus.includes('bnb'));
  assert.deepEqual(ctx.row().quarantineEvidence, originalEvidence);
  ctx.client.pools = async ({ chain }) => [ctx.pool(chain, 1)];
  await ctx.scanner.scan(); assert.equal(ctx.row().comparisonStatus, 'quarantined');
  assert.deepEqual(ctx.row().quarantineEvidence, originalEvidence); assert.deepEqual(ctx.sent, []);
});
