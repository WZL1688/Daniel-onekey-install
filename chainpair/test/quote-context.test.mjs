// Local DemoAdapter only: no signatures, broadcasts, RPC or third-party requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';
import { InventoryCoordinator } from '../src/opportunities/coordinator.mjs';

const chains = {
  bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' },
  solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', decimals: 9, poolAddress: '11111111111111111111111111111111' },
};
async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'quote-context-')), store = new Store(directory);
  const config = structuredClone(store.config); config.executionMode = 'inventory'; store.setConfig(config);
  const vault = { publicStatus: () => ({ bnb: { mode: 'none' }, solana: { mode: 'none' } }), redact: value => String(value) };
  const engine = new Engine({ store, vault }); await engine.init(); engine.stop();
  const scanner = new OpportunityService({ store, getConfig: () => engine.config, client: { discover: async () => [], pools: async () => [] } });
  const initial = scanner.saveAsset({ name: 'Controlled context fixture', symbol: 'CONTEXT', chains }).assets[0];
  scanner.approveAsset({ id: initial.id, revision: initial.revision, confirmed: true, evidence: 'Local fixture only', chains });
  const asset = scanner.assets.get(initial.id), pool = (chain, priceUsd) => ({ chain, tokenAddress: chains[chain].address, poolAddress: chains[chain].poolAddress,
    quoteAddress: chain === 'bnb' ? '0x3333333333333333333333333333333333333333' : 'So11111111111111111111111111111111111111112',
    priceUsd, liquidityUsd: 100000, volume24hUsd: 100000, volume1hUsd: 1000, trades1h: 20, observedAt: Date.now(), priceConfidence: 'single-pool' });
  scanner.markets[asset.id] = { bnb: pool('bnb', 1), solana: pool('solana', 1.02), generation: 'context-fixture-round' }; scanner.enabled = true;
  const coordinator = new InventoryCoordinator({ engine, scanner });
  t.after(async () => { if (coordinator.pending) await coordinator.pending.catch(() => {}); scanner.stop(); engine.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, scanner, coordinator, asset, row: () => scanner.row(asset) };
}

test('an unchanged parent execution context keeps a fresh genuine quote ready', async t => {
  const ctx = await fixture(t), report = await ctx.coordinator.quote(ctx.asset.id);
  assert.equal(report.executable, true); assert.equal(report.parentRevision, ctx.engine.configRevision);
  assert.equal(ctx.engine.snapshot().engine.configRevision, report.parentRevision);
  assert.equal(ctx.row().evaluation.parentRevision, report.parentRevision); assert.equal(ctx.row().executable, true);
  assert.equal(ctx.coordinator.authorization(ctx.asset.id).parentRevision, report.parentRevision);
  assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.store.stats().executions, 0);
});

test('a consumed quote cannot reappear as ready after its execution finishes', async t => {
  const ctx = await fixture(t); await ctx.coordinator.quote(ctx.asset.id);
  assert.equal(ctx.row().executable, true);
  const accepted = ctx.coordinator.execute(ctx.asset.id); assert.equal(accepted.accepted, true);
  await ctx.coordinator.pending;
  assert.equal(ctx.coordinator.snapshot().busy, false);
  assert.equal(ctx.store.allTrades()[0].status, 'COMPLETED');
  assert.equal(ctx.row().executable, false); assert.equal(ctx.row().evaluation.executable, false);
  assert.throws(() => ctx.coordinator.authorization(ctx.asset.id), /重新复核|过期|变化/);
  assert.equal((await ctx.coordinator.quote(ctx.asset.id)).executable, true);
});

test('wallet changes invalidate quote readiness even when the policy fingerprint stays the same', async t => {
  const ctx = await fixture(t), report = await ctx.coordinator.quote(ctx.asset.id), fingerprint = ctx.engine.snapshot().policyFingerprint;
  assert.equal(ctx.row().executable, true);
  ctx.engine.walletChanged('bnb');
  assert.equal(ctx.engine.snapshot().policyFingerprint, fingerprint); assert.equal(ctx.engine.configRevision, report.parentRevision + 1);
  assert.equal(ctx.row().evaluation.executable, false); assert.equal(ctx.row().executable, false);
  assert.throws(() => ctx.coordinator.authorization(ctx.asset.id), /重新复核|过期|变化/);
  assert.equal(ctx.coordinator.authorizations.has(ctx.asset.id), false); assert.equal(ctx.store.allTrades().length, 0);
  const fresh = await ctx.coordinator.quote(ctx.asset.id);
  assert.equal(fresh.parentRevision, ctx.engine.configRevision); assert.equal(ctx.row().executable, true);
});

test('a committed risk change invalidates old quote context and requires a new genuine quote', async t => {
  const ctx = await fixture(t), report = await ctx.coordinator.quote(ctx.asset.id);
  const changed = structuredClone(ctx.engine.config); changed.risk.minProfitUsd += .0001;
  await ctx.engine.saveConfig(changed); ctx.engine.stop();
  assert.notEqual(ctx.engine.configRevision, report.parentRevision); assert.equal(ctx.row().executable, false);
  assert.equal(ctx.row().evaluation.executable, false); assert.throws(() => ctx.coordinator.authorization(ctx.asset.id), /重新复核|过期|变化/);
  assert.equal(ctx.store.allTrades().length, 0);
  const fresh = await ctx.coordinator.quote(ctx.asset.id); assert.equal(fresh.executable, true); assert.equal(ctx.row().executable, true);
});

test('a mode mismatch cannot present a quote as executable even without a revision change', async t => {
  const ctx = await fixture(t); await ctx.coordinator.quote(ctx.asset.id);
  ctx.engine.config = { ...ctx.engine.config, mode: 'live' }; // No adapter creation or live network access.
  assert.equal(ctx.row().evaluation.mode, 'demo'); assert.equal(ctx.row().evaluation.executable, false); assert.equal(ctx.row().executable, false);
  assert.throws(() => ctx.coordinator.authorization(ctx.asset.id), /重新复核|过期|变化/); assert.equal(ctx.store.allTrades().length, 0);
});

test('malformed or future context metadata cannot manufacture quote readiness', async t => {
  const ctx = await fixture(t), genuine = await ctx.coordinator.quote(ctx.asset.id);
  for (const parentRevision of [-1, .5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    ctx.scanner.recordEvaluation(ctx.asset.id, { ...genuine, parentRevision, secretKey: 'must-not-survive' });
    const row = ctx.row(); assert.equal(row.executable, false); assert.equal(row.evaluation.executable, false); assert.equal(Object.hasOwn(row.evaluation, 'parentRevision'), false);
    assert.equal(JSON.stringify(row.evaluation).includes('must-not-survive'), false);
  }
  ctx.scanner.recordEvaluation(ctx.asset.id, { ...genuine, parentRevision: ctx.engine.configRevision + 1 });
  assert.equal(ctx.row().executable, false); assert.equal(ctx.row().evaluation.executable, false);
  ctx.scanner.recordEvaluation(ctx.asset.id, genuine); assert.equal(ctx.row().executable, true); assert.equal(ctx.store.allTrades().length, 0);
});
