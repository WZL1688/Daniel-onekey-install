import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { InventoryCoordinator } from '../src/opportunities/coordinator.mjs';

const assetFixture = () => ({ id: 'manual:fixture-one', name: 'Local fixture', symbol: 'FIX', revision: 1,
  mappingEvidence: 'Fixed test fixture only; no real asset claim', chains: {
    bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' },
    solana: { address: 'So11111111111111111111111111111111111111112', decimals: 9, poolAddress: '11111111111111111111111111111111' }
  } });
async function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coordinator-fixture-')), store = new Store(dir);
  const config = structuredClone(DEFAULT_CONFIG); config.executionMode = 'inventory'; config.inventory.scanApprovedAssets = true;
  if (options.cap) config.risk.maxExecutions = options.cap;
  store.setConfig(config);
  let asset = assetFixture(), approved = true, empty = false, clock = Date.now(); const sent = [];
  const vault = { publicStatus: () => ({ bnb: { mode: 'none' }, solana: { mode: 'none' } }), redact: s => String(s) };
  class Adapter extends DemoAdapter {
    async quoteTokenBridge() { throw new Error('Inventory worker must never request a bridge'); }
    async balances(chain) { const result = await super.balances(chain); if (empty && chain === 'solana') result.tokenRaw = '0'; return result; }
    async submit(q, { onSubmitted } = {}) { const s = { hash: `coordinator-demo-${sent.length}`, quote: q }; sent.push(q); await onSubmitted?.(s); return s; }
    async confirm(s) { const r = await super.confirm(s); await options.afterConfirm?.(s.quote.fromToken.kind === 'stable' ? 'BUY' : 'SELL', { changeRevision: () => asset.revision++, engine, store }); return r; }
  }
  const engine = new Engine({ store, vault, adapterFactory: args => new Adapter(args) }); await engine.init(); engine.stop();
  const evaluations = [];
  const scanner = { enabled: true, busy: false,
    getApprovedAsset(id) { if (!approved || id !== asset.id) throw Object.assign(new Error('该同币条目尚未核验'), { safe: true }); return structuredClone(asset); },
    recordEvaluation(id, report) { evaluations.push({ id, ...structuredClone(report) }); },
    executionCandidates: () => [{ asset: structuredClone(asset), stage: 'candidate' }]
  };
  const coordinator = new InventoryCoordinator({ engine, scanner, now: () => clock });
  t.after(async () => { if (coordinator.pending) await coordinator.pending.catch(() => {}); engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, scanner, coordinator, sent, evaluations, getAsset: () => structuredClone(asset), changeRevision: () => asset.revision++, setApproved: value => { approved = value; }, setEmpty: value => { empty = value; }, advance: ms => { clock += ms; } };
}

test('approved asset executes with an immutable context, two receipts and no global asset rewrite', async t => {
  const ctx = await setup(t), before = JSON.stringify(ctx.store.config);
  const report = await ctx.coordinator.quote(ctx.getAsset().id); assert.equal(report.executable, true, report.reasons.join(';'));
  const accepted = ctx.coordinator.execute(ctx.getAsset().id); assert.equal(accepted.accepted, true); assert.equal(ctx.engine.busy, true);
  const trade = await ctx.coordinator.pending;
  assert.equal(trade.status, 'COMPLETED'); assert.equal(trade.assetId, ctx.getAsset().id); assert.equal(trade.legs.length, 2);
  assert.equal(trade.policySnapshot.chains.bnb.tokenAddress, ctx.getAsset().chains.bnb.address);
  assert.equal(trade.policySnapshot.chains.solana.poolAddress, ctx.getAsset().chains.solana.poolAddress);
  assert.equal(trade.actual.closedInventory, false); assert.equal(ctx.sent.length, 2);
  assert.equal(JSON.stringify(ctx.store.config), before); assert.equal(ctx.engine.busy, false);
  assert.equal(ctx.store.stats().profitUsd, 0); assert(ctx.store.stats().inventoryCashSpreadUsd > 0);
  assert.equal(ctx.coordinator.snapshot().job.status, 'completed');
});

test('unapproved or stale asset authorizations never reach signing and blocked requotes clear old intent', async t => {
  const ctx = await setup(t), id = ctx.getAsset().id;
  assert.throws(() => ctx.coordinator.execute(id), /重新复核/);
  ctx.setApproved(false); await assert.rejects(ctx.coordinator.quote(id), /核验/); ctx.setApproved(true);
  await ctx.coordinator.quote(id); ctx.changeRevision(); assert.throws(() => ctx.coordinator.execute(id), /重新复核/);
  await ctx.coordinator.quote(id); ctx.setEmpty(true);
  const blocked = await ctx.coordinator.quote(id); assert.equal(blocked.executable, false);
  assert.throws(() => ctx.coordinator.execute(id), /重新复核/); assert.equal(ctx.sent.length, 0); assert.equal(ctx.engine.busy, false);
});

test('all assets share parent mutex and active quote prevents concurrent configuration edits', async t => {
  const ctx = await setup(t), id = ctx.getAsset().id;
  const first = ctx.coordinator.quote(id);
  await assert.rejects(ctx.coordinator.quote(id), /已有/);
  await assert.rejects(ctx.engine.saveConfig(ctx.store.config), /进行中/);
  await first; assert.equal(ctx.engine.busy, false); assert.equal(ctx.sent.length, 0);
});

test('approval change after confirmed buy pauses parent, retains stock reservation and forbids sell', async t => {
  const ctx = await setup(t, { afterConfirm: (stage, helpers) => { if (stage === 'BUY') helpers.changeRevision(); } });
  const id = ctx.getAsset().id; await ctx.coordinator.quote(id); ctx.engine.running = true; ctx.coordinator.execute(id);
  await assert.rejects(ctx.coordinator.pending, /已变化/);
  assert.equal(ctx.sent.length, 1); assert.equal(ctx.engine.running, false); assert.match(ctx.engine.pausedReason, /核对/);
  const trade = ctx.store.allTrades()[0]; assert.equal(trade.status, 'NEEDS_REVIEW');
  assert(BigInt(ctx.store.getReservedInventory({ mode: 'demo', chain: trade.sellChain, address: ctx.getAsset().chains[trade.sellChain].address })) > 0n);
  ctx.engine.acknowledge({ tradeId: trade.id, note: 'Fixture manually checked; no real broadcasts' });
  assert.equal(ctx.store.getReservedInventory({ mode: 'demo', chain: trade.sellChain, address: ctx.getAsset().chains[trade.sellChain].address }), '0');
});

test('automation has an independent opt-in, no configured-pair fallback and global attempt cap', async t => {
  const ctx = await setup(t, { cap: 1 });
  await ctx.coordinator.tick(); assert.equal(ctx.sent.length, 0);
  ctx.engine.running = true; ctx.scanner.enabled = false; await ctx.coordinator.tick(); assert.equal(ctx.sent.length, 0);
  ctx.scanner.enabled = true; await ctx.coordinator.tick(); await ctx.coordinator.pending;
  assert.equal(ctx.store.stats().executions, 1); assert.equal(ctx.sent.length, 2);
  ctx.advance(60001); await ctx.coordinator.tick(); if (ctx.coordinator.pending) await ctx.coordinator.pending;
  assert.equal(ctx.store.stats().executions, 1); assert.equal(ctx.sent.length, 2); assert.equal(ctx.coordinator.snapshot().job.status, 'blocked');
});

test('persisted review exposure blocks worker creation even when a parent pause flag was cleared', async t => {
  const ctx = await setup(t); ctx.store.saveTrade({ id: 'uncertain-fixture', status: 'NEEDS_REVIEW', mode: 'demo', assetId: 'another-asset' });
  ctx.engine.pausedReason = '';
  await assert.rejects(ctx.coordinator.quote(ctx.getAsset().id), /待核对/); assert.equal(ctx.sent.length, 0);
});
