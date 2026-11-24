import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Vault } from '../src/vault.mjs';
import { Engine } from '../src/engine.mjs';
import { startLocalServer } from '../src/server.mjs';

async function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quality-api-'));
  const store = new Store(dir), vault = new Vault(dir), engine = new Engine({ store, vault });
  await engine.init(); engine.stop();
  const calls = [];
  let enabled = false;
  const qualityService = {
    snapshot: () => ({ enabled, busy: false, reports: [], readOnly: true }),
    setEnabled(value) { if (typeof value !== 'boolean') throw Object.assign(new Error('只读开关格式无效'), { safe: true }); enabled = value; calls.push('enabled'); return this.snapshot(); },
    verify(id) { calls.push(id); return { assetId: id, readOnly: true, executable: false, qualityPassed: false, reasons: ['本地测试，无真实报价'] }; }
  };
  const opportunityService = { getApprovedAsset(id) { if (id !== 'manual:fixture') throw Object.assign(new Error('映射未核验'), { safe: true }); return { revision: 2 }; } };
  const { server, url } = await startLocalServer({ engine, store, vault, qualityService, opportunityService });
  const session = await fetch(url + '/api/session'), { csrfToken } = await session.json();
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const request = (route, body, csrf = true) => fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { engine.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, calls, request, url };
}

test('quality routes enforce session/CSRF/current revision and never change trading configuration', async t => {
  const ctx = await fixture(t), before = JSON.stringify(ctx.engine.config);
  assert.equal((await fetch(ctx.url + '/api/opportunities/quality')).status, 401);
  assert.equal((await ctx.request('/api/opportunities/quality/enabled', { enabled: true }, false)).status, 403);
  assert.equal((await ctx.request('/api/opportunities/quality/enabled', { enabled: 'true' })).status, 400);
  assert.equal((await ctx.request('/api/opportunities/quality/enabled', { enabled: true })).status, 200);
  const base = { id: 'manual:fixture', expectedMode: 'demo', revision: 2 };
  assert.equal((await ctx.request('/api/opportunities/quality/verify', { ...base, expectedMode: 'live' })).status, 400);
  assert.equal((await ctx.request('/api/opportunities/quality/verify', { ...base, revision: 1 })).status, 400);
  assert.equal((await ctx.request('/api/opportunities/quality/verify', { ...base, id: 'manual:unknown' })).status, 400);
  const verified = await ctx.request('/api/opportunities/quality/verify', base);
  assert.equal(verified.status, 200); assert.equal((await verified.json()).executable, false);
  assert.deepEqual(ctx.calls, ['enabled', 'manual:fixture']);
  assert.equal(JSON.stringify(ctx.engine.config), before); assert.equal(ctx.engine.running, false);
  assert.equal(ctx.store.allTrades().length, 0);
});

test('performance endpoint excludes demo profit and separates inventory from bridge scope', async t => {
  const ctx = await fixture(t);
  ctx.store.saveTrade({ id: 'demo-only', type: 'arbitrage', mode: 'demo', executionMode: 'inventory', status: 'COMPLETED', createdAt: new Date().toISOString(), actual: { profitUsd: 100000 } });
  const response = await ctx.request('/api/performance?executionMode=inventory');
  assert.equal(response.status, 200); const report = await response.json();
  assert.equal(report.counts.attempts, 0); assert.equal(report.observedRate, null);
  assert.equal(report.wilsonLowerBound, null); assert.equal(report.historicalEvidenceMet, false);
  assert.equal((await ctx.request('/api/performance?mode=demo')).status, 400);
  assert.equal((await ctx.request('/api/performance?executionMode=all')).status, 400);
  assert.equal((await ctx.request('/api/performance?executionMode=inventory&executionMode=bridge')).status, 400);
  assert.equal((await ctx.request('/api/performance?assetId=invalid')).status, 400);
  assert.equal((await ctx.request('/api/performance?assetId=manual:fixture')).status, 200);
  const state = await (await ctx.request('/api/state')).json();
  assert.equal(state.features.performance, true); assert.equal(state.features.quality, true);
});
