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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'research-api-')), store = new Store(dir), vault = new Vault(dir), engine = new Engine({ store, vault });
  await engine.init(); engine.stop(); const calls = [];
  const researchService = { busy: false, snapshot: () => ({ mode: 'research-paper', liveEnabled: false, coverage: { validated14Days: false } }),
    store: { list: (kind, options) => { calls.push(['history', kind, options]); return { items: [], total: 0, page: options.page, pageSize: 20, totalPages: 1 }; } },
    saveSettings: settings => { calls.push(['settings', settings]); return {}; }, requestQuote: input => { calls.push(['quote', input]); return { accepted: true, executable: false }; }, requestMatrix: input => { calls.push(['matrix', input]); return { accepted: true }; },
    paperStart: input => { calls.push(['start-paper', input]); return {}; }, paperPause: () => { calls.push(['pause-paper']); return {}; }, paperResume: () => { calls.push(['resume-paper']); return {}; }, paperRun: () => { calls.push(['run-paper']); return { accepted: true }; }, paper: { setSettings: input => calls.push(['paper-risk', input]) },
    globalStop: () => { calls.push(['stop']); return {}; }, clearStop: input => { calls.push(['clear-stop', input]); return {}; } };
  const { server, url } = await startLocalServer({ engine, store, vault, researchService });
  const session = await fetch(url + '/api/session'), { csrfToken } = await session.json(), cookie = session.headers.get('set-cookie').split(';')[0];
  const request = (route, body, { csrf = true, origin } = {}) => fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}), ...(origin ? { Origin: origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { engine.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { calls, store, engine, request, url };
}

test('research API enforces local sessions, origins and CSRF before any queue or paper mutation', async t => {
  const ctx = await fixture(t);
  assert.equal((await fetch(ctx.url + '/api/onchain-research')).status, 401);
  assert.equal((await ctx.request('/api/onchain-research/paper/run', {}, { csrf: false })).status, 403);
  assert.equal((await ctx.request('/api/onchain-research/quote', {}, { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal(ctx.calls.length, 0);
  const state = await (await ctx.request('/api/state')).json(); assert.equal(state.features.onchainResearch, true);
});

test('quote and paper commands strip live transaction fields and leave original live settings unchanged', async t => {
  const ctx = await fixture(t), before = JSON.stringify(ctx.engine.config), base = '/api/onchain-research';
  const malicious = { assetId: 'manual:fixture', revision: 1, amountUsd: 50, buyChain: 'bnb', execute: true, privateKey: 'must-not-pass', transaction: { to: 'attacker' }, mode: 'live' };
  assert.equal((await ctx.request(base + '/quote', malicious)).status, 202);
  assert.deepEqual(ctx.calls[0], ['quote', { assetId: 'manual:fixture', revision: 1, amountUsd: 50, buyChain: 'bnb' }]);
  assert.equal((await ctx.request(base + '/matrix', malicious)).status, 202);
  assert.deepEqual(ctx.calls[1], ['matrix', { assetId: 'manual:fixture', revision: 1 }]);
  assert.equal((await ctx.request(base + '/paper/start', { ...malicious, capitalPerChainUsd: 100 })).status, 200);
  assert.deepEqual(ctx.calls[2], ['start-paper', { assetId: 'manual:fixture', revision: 1, capitalPerChainUsd: 100, risk: undefined }]);
  assert.equal(JSON.stringify(ctx.engine.config), before); assert.equal(ctx.engine.running, false); assert.equal(ctx.store.allTrades().length, 0);
});

test('history is paginated and kind allowlisted; research settings must be an object', async t => {
  const ctx = await fixture(t);
  assert.equal((await ctx.request('/api/onchain-research/history?kind=secrets')).status, 400);
  assert.equal((await ctx.request('/api/onchain-research/settings', { settings: [] })).status, 400);
  assert.equal((await ctx.request('/api/onchain-research/history?kind=paper-trade&page=2')).status, 200);
  assert.deepEqual(ctx.calls[0], ['history', 'paper-trade', { page: 2, pageSize: 20 }]);
  assert.equal((await ctx.request('/api/onchain-research/paper/run', {})).status, 202);
  assert.equal(ctx.calls[1][0], 'run-paper');
});
