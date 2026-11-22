import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.mjs';
import { Vault } from '../src/vault.mjs';
import { Engine } from '../src/engine.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';
import { InventoryCoordinator } from '../src/opportunities/coordinator.mjs';
import { startLocalServer } from '../src/server.mjs';

const chains = { bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' }, solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', decimals: 9, poolAddress: '11111111111111111111111111111111' } };
async function fixture(t, { rejectPools = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opportunities-api-')), store = new Store(dir), vault = new Vault(dir);
  const engine = new Engine({ store, vault }); await engine.init(); engine.stop();
  let clock = Date.now(); const calls = [];
  const client = {
    discover: async () => { calls.push('discover'); return [{ id: 'coingecko:fixture', name: 'Fixture only', symbol: 'FIX', source: 'coingecko', observedAt: clock, chains }]; },
    pools: async ({ chain, addresses }) => {
      calls.push(chain);
      if (rejectPools) throw Object.assign(new Error('private provider text must never appear'), { code: 'DISCOVERY_AUTH' });
      return addresses.map(tokenAddress => ({ chain, tokenAddress, poolAddress: chains[chain].poolAddress, quoteAddress: store.config.chains[chain].stableAddress, priceUsd: chain === 'bnb' ? .0124 : .0131, liquidityUsd: 100000, volume24hUsd: 500000, volume1hUsd: 2000, trades1h: 20, observedAt: clock, dexId: 'fixture' }));
    }
  };
  const scanner = new OpportunityService({ store, getConfig: () => engine.config, client, now: () => clock, sleep: async ms => { clock += ms; } });
  const coordinator = new InventoryCoordinator({ engine, scanner });
  const { server, url } = await startLocalServer({ engine, store, vault, opportunityService: scanner, inventoryCoordinator: coordinator });
  const response = await fetch(`${url}/api/session`), { csrfToken } = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
  const request = (path, body, { method = 'POST', csrf = true, origin } = {}) => fetch(url + path, { method, headers: { Cookie: cookie, ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}), ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }) });
  t.after(async () => { if (coordinator.pending) await coordinator.pending.catch(() => {}); engine.stop(); scanner.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, engine, scanner, coordinator, url, request, calls };
}
async function approved(ctx) {
  const saved = await ctx.request('/api/opportunities/assets', { asset: { name: 'Fixture only', symbol: 'FIX', chains, mapping: { confirmed: true }, confirmed: true } });
  assert.equal(saved.status, 200); const asset = (await saved.json()).assets[0]; assert.equal(asset.mapping.confirmed, false);
  const response = await ctx.request('/api/opportunities/approve', { id: asset.id, revision: asset.revision, confirmed: true, evidence: 'Local simulation fixture; no real asset claim', chains });
  assert.equal(response.status, 200); return (await response.json()).assets[0];
}

test('opportunity routes protect sessions, CSRF, mode and mapping revision before execution', async t => {
  const ctx = await fixture(t);
  assert.equal((await fetch(`${ctx.url}/api/opportunities`)).status, 401);
  assert.equal((await ctx.request('/api/opportunities/discover', {}, { csrf: false })).status, 403);
  assert.equal((await ctx.request('/api/opportunities/discover', {}, { origin: 'https://foreign.invalid' })).status, 403);
  const asset = await approved(ctx);
  assert.equal((await ctx.request('/api/opportunities/quote', { id: asset.id, revision: asset.revision })).status, 400);
  assert.equal((await ctx.request('/api/opportunities/execute', { id: asset.id, revision: asset.revision, expectedMode: 'live' })).status, 400);
  assert.equal((await ctx.request('/api/opportunities/automation', { enabled: true })).status, 400);
  assert.equal((await ctx.request('/api/opportunities/quote', { id: asset.id, revision: asset.revision - 1, expectedMode: 'demo' })).status, 400);
  assert.equal(ctx.engine.running, false); assert.equal(ctx.store.allTrades().length, 0);
});

test('discovery and scanning cannot approve an asset, write trading config or start execution', async t => {
  const ctx = await fixture(t), config = JSON.stringify(ctx.store.config);
  assert.equal((await ctx.request('/api/opportunities/discover', { execute: true })).status, 200);
  const response = await ctx.request('/api/opportunities/scan', { execute: true }), snapshot = await response.json();
  assert.equal(response.status, 200); assert.equal(snapshot.rows[0].stage, 'needs_mapping'); assert.equal(snapshot.rows[0].executable, false);
  assert.equal(snapshot.rows[0].feeStatus, 'unknown'); assert.equal(snapshot.assets[0].mapping.confirmed, false);
  assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.engine.running, false); assert.equal(ctx.store.allTrades().length, 0);
  assert.deepEqual(ctx.calls, ['discover', 'bnb', 'solana']);
});

test('the real API integrates approval, fresh two-leg quote and an asynchronous inventory job', async t => {
  const ctx = await fixture(t), asset = await approved(ctx);
  const config = structuredClone(ctx.store.config); config.executionMode = 'inventory'; await ctx.engine.saveConfig(config); ctx.engine.stop();
  const quoted = await ctx.request('/api/opportunities/quote', { id: asset.id, revision: asset.revision, expectedMode: 'demo' });
  assert.equal(quoted.status, 200); const report = await quoted.json(); assert.equal(report.executable, true, JSON.stringify(report));
  const accepted = await ctx.request('/api/opportunities/execute', { id: asset.id, revision: asset.revision, expectedMode: 'demo' });
  assert.equal(accepted.status, 202); assert.equal((await accepted.json()).accepted, true);
  if (ctx.coordinator.pending) await ctx.coordinator.pending;
  const trade = ctx.store.allTrades()[0]; assert.equal(trade.status, 'COMPLETED'); assert.equal(trade.executionMode, 'inventory');
  assert.deepEqual(trade.legs.map(leg => leg.name), ['BUY', 'SELL']); assert.equal(trade.actual.closedInventory, false);
  assert.equal(ctx.store.config.chains.bnb.tokenAddress, ''); assert.equal(ctx.store.stats().profitUsd, 0);
});

test('automation keeps trading paused when its read-only market scanner cannot start', async t => {
  const ctx = await fixture(t, { rejectPools: true }); await approved(ctx);
  const result = await ctx.request('/api/opportunities/automation', { enabled: true, expectedMode: 'demo' });
  assert.equal(result.status, 400); assert.match((await result.json()).error, /保持暂停/);
  assert.equal(ctx.engine.running, false); assert.equal(ctx.scanner.enabled, false); assert.equal(ctx.store.allTrades().length, 0);
  assert.equal(ctx.scanner.snapshot().reason.includes('private provider'), false);
});

test('explicit automation scans an approved asset then completes a simulated inventory trade', async t => {
  const ctx = await fixture(t); await approved(ctx);
  const enabled = await ctx.request('/api/opportunities/automation', { enabled: true, expectedMode: 'demo' });
  assert.equal(enabled.status, 200); assert.equal(ctx.engine.config.mode, 'demo'); assert.equal(ctx.engine.config.executionMode, 'inventory');
  assert.equal(ctx.engine.config.inventory.scanApprovedAssets, true); assert.equal(ctx.scanner.enabled, true);
  for (let i = 0; i < 100 && !ctx.coordinator.pending && !ctx.store.allTrades().length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  if (ctx.coordinator.pending) await ctx.coordinator.pending;
  const trade = ctx.store.allTrades()[0]; assert(trade, 'auto scan must trigger an approved inventory context');
  assert.equal(trade.status, 'COMPLETED'); assert.equal(trade.executionMode, 'inventory'); assert.deepEqual(trade.legs.map(leg => leg.name), ['BUY', 'SELL']);
  assert.equal((await ctx.request('/api/opportunities/automation', { enabled: false })).status, 200); assert.equal(ctx.engine.running, false);
});
