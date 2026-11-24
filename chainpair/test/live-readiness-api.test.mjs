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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'readiness-api-'));
  const store = new Store(dir), vault = new Vault(dir), engine = new Engine({ store, vault });
  await engine.init(); engine.stop(); const calls = [];
  const readinessService = { snapshot: () => ({ readOnly: true, report: null }), check: async input => { calls.push(['check', input]); return { readOnly: true, executable: false, readyForLive: false }; } };
  const approvalService = { snapshot: () => ({ busy: false, job: null }), prepare: async input => { calls.push(['prepare', input]); return { id: 'fixture-intent', amountRaw: '1', action: 'approve' }; }, execute: input => { calls.push(['execute', input]); return { accepted: true, jobId: 'fixture-job' }; } };
  const opportunityService = { getApprovedAsset(id) { if (id !== 'manual:fixture') throw Object.assign(new Error('未核验'), { safe: true }); return { revision: 2 }; } };
  const { server, url } = await startLocalServer({ engine, store, vault, readinessService, approvalService, opportunityService });
  const session = await fetch(url + '/api/session'), { csrfToken } = await session.json(), cookie = session.headers.get('set-cookie').split(';')[0];
  const request = (route, body, csrf = true) => fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { engine.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, calls, request, url };
}

test('live readiness routes require a local session, CSRF, matching mode and exact asset revision', async t => {
  const ctx = await fixture(t);
  assert.equal((await fetch(ctx.url + '/api/live-readiness')).status, 401);
  assert.equal((await ctx.request('/api/live-readiness/check', { expectedMode: 'demo' }, false)).status, 403);
  assert.equal((await ctx.request('/api/live-readiness/check', {})).status, 400);
  assert.equal((await ctx.request('/api/live-readiness/check', { expectedMode: 'live' })).status, 400);
  assert.equal((await ctx.request('/api/live-readiness/check', { expectedMode: 'demo', assetId: 'manual:fixture', revision: 1 })).status, 400);
  assert.equal((await ctx.request('/api/live-readiness/check', { expectedMode: 'demo', assetId: 'manual:unknown', revision: 2 })).status, 400);
  const before = JSON.stringify(ctx.engine.config);
  assert.equal((await ctx.request('/api/live-readiness/check', { expectedMode: 'demo' })).status, 200);
  assert.equal((await ctx.request('/api/live-readiness/check', { expectedMode: 'demo', assetId: 'manual:fixture', revision: 2, execute: true })).status, 200);
  assert.deepEqual(ctx.calls, [['check', {}], ['check', { assetId: 'manual:fixture' }]]);
  assert.equal(JSON.stringify(ctx.engine.config), before); assert.equal(ctx.engine.running, false); assert.equal(ctx.store.allTrades().length, 0);
});

test('finite approval routes only pass reviewed identifiers and explicit confirmation to the service', async t => {
  const ctx = await fixture(t);
  assert.equal((await fetch(ctx.url + '/api/bnb-approvals')).status, 401);
  assert.equal((await ctx.request('/api/bnb-approvals/prepare', { expectedMode: 'demo', reportId: 'fixture-report', index: 0 }, false)).status, 403);
  for (const index of [-1, 1.5, '0', 99]) assert.equal((await ctx.request('/api/bnb-approvals/prepare', { expectedMode: 'demo', reportId: 'fixture-report', index })).status, 400);
  const forged = { tokenAddress: 'attacker', spender: 'attacker', amountRaw: 'unlimited', transaction: { to: 'attacker' } };
  assert.equal((await ctx.request('/api/bnb-approvals/prepare', { ...forged, expectedMode: 'demo', reportId: 'fixture-report', index: 0 })).status, 200);
  assert.deepEqual(ctx.calls[0], ['prepare', { reportId: 'fixture-report', index: 0 }]);
  assert.equal((await ctx.request('/api/bnb-approvals/execute', { expectedMode: 'demo', intentId: 'fixture-intent' })).status, 400);
  assert.equal((await ctx.request('/api/bnb-approvals/execute', { expectedMode: 'demo', intentId: 'fixture-intent', confirmed: 'true' })).status, 400);
  assert.equal((await ctx.request('/api/bnb-approvals/execute', { expectedMode: 'live', intentId: 'fixture-intent', confirmed: true })).status, 400);
  assert.equal((await ctx.request('/api/bnb-approvals/execute', { ...forged, expectedMode: 'demo', intentId: 'fixture-intent', confirmed: true })).status, 400);
  assert.equal(ctx.calls.length, 1, 'demo requests must not enter the approval executor');
  ctx.engine.config.mode = 'live';
  assert.equal((await ctx.request('/api/bnb-approvals/execute', { ...forged, expectedMode: 'live', intentId: 'fixture-intent', confirmed: true })).status, 202);
  assert.deepEqual(ctx.calls[1], ['execute', { expectedMode: 'live', intentId: 'fixture-intent', confirmed: true }]);
  const state = await (await ctx.request('/api/state')).json();
  assert.equal(state.features.liveReadiness, true); assert.equal(state.features.bnbApprovals, true);
});
