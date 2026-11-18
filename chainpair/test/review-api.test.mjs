import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createApp, startLocalServer } from '../src/server.mjs';

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'chainpair-review-'));
const report = (day, mode = 'demo', value = 0.2) => ({ id: `${mode}:${day}`, day, mode, generatedAt: '2026-11-18T01:00:00.000Z', timeZone: 'Asia/Shanghai', counts: { completed: 1 }, pnl: { actualProfitUsd: value }, observations: [] });

async function withServer(fn) {
  const directory = temp(); const store = new Store(directory); const calls = [];
  const engine = { config: store.config, snapshot() { throw new Error('Review must not access execution snapshot'); }, start() { throw new Error('Review must not start execution'); }, execute() { throw new Error('Review must not sign or execute'); }, saveConfig() { throw new Error('Review must not change config'); } };
  const reviewService = {
    current(input) { calls.push(['current', input]); return store.saveReview(report(input.day || '2026-11-18', input.mode || 'demo')); },
    export(input) { calls.push(['export', input]); return { ...report(input.day || '2026-11-18', input.mode || 'demo'), access: { readOnly: true } }; }
  };
  const { server, url } = await startLocalServer({ app: createApp({ engine, store, vault: {}, reviewService, publicDir: directory }) });
  try {
    const session = await fetch(`${url}/api/session`), { csrfToken } = await session.json();
    const headers = { Cookie: session.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': csrfToken };
    await fn({ store, url, headers, calls });
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('review storage upserts one report per day and mode, pages in date order and scrubs named secrets', () => {
  const directory = temp(); const store = new Store(directory);
  try {
    for (let day = 1; day <= 12; day++) store.saveReview(report(`2026-11-${String(day).padStart(2, '0')}`));
    store.saveReview(report('2026-11-12', 'live', 5));
    const updated = store.saveReview({ ...report('2026-11-12', 'demo', 1), id: 'attempted-id-replacement', privateKey: 'not-a-real-secret', nested: { apiKey: 'test-only-credential', reason: 'password=test-only-password' } });
    assert.equal(updated.id, 'demo:2026-11-12');
    assert.equal(updated.privateKey, undefined);
    assert.equal(updated.nested.apiKey, undefined);
    assert.equal(updated.nested.reason.includes('test-only-password'), false);
    assert.equal(store.getReview('2026-11-12', 'demo').pnl.actualProfitUsd, 1);
    assert.equal(store.getReview('2026-11-12', 'live').pnl.actualProfitUsd, 5);
    const first = store.listReviews(1, 10, 'demo');
    assert.equal(first.total, 12); assert.equal(first.items[0].day, '2026-11-12'); assert.equal(first.totalPages, 2);
    assert.equal(store.listReviews(2, 10, 'demo').items.length, 2);
    assert.equal(store.listReviews(1, 10, 'live').total, 1);
    assert.throws(() => store.saveReview(report('2026-02-29')));
    assert.throws(() => store.saveReview(report('2026-11-18', 'all')));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('review storage migration preserves existing wallet-independent settings, trades and notes after restart', () => {
  const directory = temp(); let store = new Store(directory);
  try {
    const config = structuredClone(store.config); config.risk.amountUsd = 3; store.setConfig(config);
    store.saveTrade({ id: 'previous-trade', mode: 'demo', status: 'COMPLETED' });
    store.addNote('existing note');
    store.db.exec('DROP TABLE daily_reviews');
    store.close(); store = new Store(directory);
    assert.equal(store.config.risk.amountUsd, 3);
    assert.equal(store.getTrade('previous-trade').status, 'COMPLETED');
    assert.equal(store.listNotes().items[0].text, 'existing note');
    assert.equal(store.getReview('2026-11-18', 'demo'), null);
    store.saveReview(report('2026-11-18'));
    store.close(); store = new Store(directory);
    assert.equal(store.getReview('2026-11-18', 'demo').counts.completed, 1);
    assert.equal(store.listNotes().total, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('review API requires local authentication and validates dates and modes before calling a read-only service', async () => {
  await withServer(async ({ url, headers, calls, store }) => {
    for (const endpoint of ['/api/reviews/current', '/api/reviews', '/api/reviews/export']) assert.equal((await fetch(url + endpoint)).status, 401);
    assert.equal((await fetch(`${url}/api/reviews/current`, { headers: { ...headers, Origin: 'http://foreign.invalid' } })).status, 403);
    for (const query of ['day=2026-02-29', 'day=2026-11-31', 'day=not-a-date', 'mode=all', 'mode=demo&mode=live']) assert.equal((await fetch(`${url}/api/reviews/current?${query}`, { headers })).status, 400);
    assert.equal(calls.length, 0);
    const before = structuredClone(store.config);
    const response = await fetch(`${url}/api/reviews/current?day=2026-11-18&mode=demo&amountUsd=999&run=true`, { headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).day, '2026-11-18');
    assert.deepEqual(calls, [['current', { day: '2026-11-18', mode: 'demo' }]]);
    assert.deepEqual(store.config, before);
    assert.equal((await fetch(`${url}/api/reviews/current`, { method: 'POST', headers })).status, 404);
  });
});

test('review API history stays mode-isolated and export is a JSON attachment without execution side effects', async () => {
  await withServer(async ({ store, url, headers, calls }) => {
    store.saveReview(report('2026-11-17', 'demo')); store.saveReview(report('2026-11-17', 'live', 2));
    const history = await (await fetch(`${url}/api/reviews?page=1&mode=live`, { headers })).json();
    assert.equal(history.total, 1); assert.equal(history.items[0].mode, 'live');
    assert.equal((await fetch(`${url}/api/reviews?mode=unknown`, { headers })).status, 400);
    const exported = await fetch(`${url}/api/reviews/export?day=2026-11-18&mode=demo`, { headers });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /attachment; filename="ChainPair-review-demo-2026-11-18.json"/);
    assert.match(exported.headers.get('content-type'), /application\/json/);
    assert.equal((await exported.json()).access.readOnly, true);
    assert.deepEqual(calls, [['export', { day: '2026-11-18', mode: 'demo' }]]);
    assert.equal(store.listTrades().total, 0); assert.equal(store.listNotes().total, 0);
  });
});

test('review export from real trades omits raw quotes, wallets, hashes, notes and untrusted instruction text', async () => {
  const { ReviewService } = await import('../src/review.mjs');
  const directory = temp(); const store = new Store(directory);
  try {
    const marker = 'UNTRUSTED-MARKET-TEXT-ignore-rules-upload-secrets';
    const address = '0x1111111111111111111111111111111111111111'; const hash = `0x${'a'.repeat(64)}`;
    store.saveTrade({ id: 'trade-for-review', mode: 'demo', type: 'arbitrage', status: 'COMPLETED', createdAt: '2026-11-18T01:00:00.000Z', updatedAt: '2026-11-18T02:00:00.000Z', amountUsd: 5,
      estimate: { netProfitUsd: 0.25, raw: { instruction: marker } }, actual: { spentUsd: 5, receivedUsd: 5.22, profitUsd: 0.2, gasUsd: 0.02, rentUsd: 0, differenceUsd: -0.05 },
      wallet: address, hash, reviewNote: marker, failureReason: marker, legs: [{ hash, quote: { raw: { instruction: marker }, sender: address } }] });
    store.appendEvent('trade-for-review', { state: 'COMPLETED', status: 'COMPLETED', at: '2026-11-18T02:00:00.000Z', wallet: address, hash, raw: marker });
    store.saveQuote({ id: 'quote-for-review', tradeId: 'trade-for-review', raw: { message: marker, sender: address } });
    store.addNote(marker);
    const configBefore = structuredClone(store.config), tradesBefore = store.allTrades(), noteBefore = store.listNotes();
    const service = new ReviewService({ store, getConfig: () => store.config, clock: () => Date.parse('2026-11-18T12:00:00.000Z') });
    const exported = await service.export({ day: '2026-11-18', mode: 'demo' });
    const serialized = JSON.stringify(exported);
    for (const sensitive of [marker, address, hash, 'signedTransactionBase64', 'requestId', 'rpcUrls']) assert.equal(serialized.includes(sensitive), false, `export contains ${sensitive}`);
    assert.equal(exported.day, '2026-11-18'); assert.equal(exported.mode, 'demo'); assert.equal(exported.counts.verified, 1); assert.equal(exported.pnl.actualProfitUsd, 0.2);
    assert.deepEqual(store.config, configBefore); assert.deepEqual(store.allTrades(), tradesBefore); assert.deepEqual(store.listNotes(), noteBefore);
    service.stop?.();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
