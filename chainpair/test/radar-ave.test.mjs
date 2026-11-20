import test from 'node:test';
import assert from 'node:assert/strict';
import { AveClient, normalizeToken } from '../src/radar/ave.mjs';

const now = Date.UTC(2026, 10, 19, 12);
const bnb = '0x2222222222222222222222222222222222222222';
const pool = '0x3333333333333333333333333333333333333333';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const fixture = changes => ({
  chain: 'bsc', token: bnb, symbol: 'TEST', name: 'Test token',
  current_price_usd: '0.0000012', main_pair_tvl: '45000.25', market_cap: '400000',
  token_tx_volume_usd_5m: '950.1', holders: '234', main_pair: pool,
  created_at: Math.floor((now - 3600_000) / 1000), updated_at: Math.floor((now - 10_000) / 1000),
  ...changes,
});
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify({ status: 1, data }), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const client = fetchImpl => new AveClient({ fetchImpl, now: () => now });

test('radar normalization preserves identity, independent source/fetch times and documented market fields', () => {
  const token = normalizeToken(fixture(), 'bnb', { observedAt: now });
  assert.equal(token.id, `bnb:${bnb}`);
  assert.equal(token.address, bnb);
  assert.equal(token.chain, 'bnb');
  assert.equal(token.poolAddress, pool);
  assert.equal(token.priceUsd, 0.0000012);
  assert.equal(token.liquidityUsd, 45000.25);
  assert.equal(token.marketCapUsd, 400000);
  assert.equal(token.volume5mUsd, 950.1);
  assert.equal(token.holders, 234);
  assert.equal(token.createdAt, now - 3600_000);
  assert.equal(token.sourceUpdatedAt, now - 10_000);
  assert.equal(token.observedAt, now);
  assert.equal(token.aveUrl, `https://ave.ai/token/${bnb}-bsc`);
});

test('radar rejects invalid addresses, cross-chain data and zero EVM token; Solana mint remains distinct', () => {
  assert.equal(normalizeToken(fixture({ token: 'https://evil.test' }), 'bnb', { observedAt: now }), null);
  assert.equal(normalizeToken(fixture({ chain: 'solana' }), 'bnb', { observedAt: now }), null);
  assert.equal(normalizeToken(fixture({ chain: {} }), 'bnb', { observedAt: now }), null);
  assert.equal(normalizeToken(fixture({ token: `0x${'0'.repeat(40)}` }), 'bnb', { observedAt: now }), null);
  assert.equal(normalizeToken(fixture(), 'eth', { observedAt: now }), null);
  const sol = normalizeToken(fixture({ chain: 'solana', token: mint, main_pair: '<script>' }), 'solana', { observedAt: now });
  assert.equal(sol.id, `solana:${mint}`);
  assert.equal(sol.poolAddress, null);
  assert.equal(sol.aveUrl, `https://ave.ai/token/${mint}-solana`);
});

test('missing, nonfinite, boolean and nonsensical numeric values stay unknown, with no FDV substitution', () => {
  const token = normalizeToken(fixture({
    current_price_usd: Infinity, main_pair_tvl: '', tvl: -1, market_cap: null, fdv: '999999999',
    token_tx_volume_usd_5m: false, holders: '3.5', created_at: 0, updated_at: now,
  }), 'bnb', { observedAt: now });
  for (const key of ['priceUsd', 'liquidityUsd', 'marketCapUsd', 'volume5mUsd', 'holders', 'createdAt', 'sourceUpdatedAt']) assert.equal(token[key], null, key);
  assert.equal(normalizeToken(fixture({ created_at: (now + 3_600_000) / 1000 }), 'bnb', { observedAt: now }).createdAt, null);
  assert.equal(normalizeToken(fixture({ current_price_usd: '0xFF' }), 'bnb', { observedAt: now }).priceUsd, null);
});

test('rank safety booleans, scores and remote URLs never become safety assertions or links', () => {
  const token = normalizeToken(fixture({
    is_honeypot: false, is_in_blacklist: false, ave_risk_level: 0,
    has_not_audited: false, has_mint_method: false,
    url: 'javascript:alert(1)', aveUrl: 'https://evil.test/?ref=0001',
    symbol: 'X\u0000'.repeat(100), name: 'N'.repeat(200),
  }), 'bnb', { observedAt: now });
  assert.equal(token.risk.status, 'unknown');
  assert.equal(token.risk.checkedAt, null);
  assert.deepEqual(token.risk.flags, []);
  assert.ok(token.risk.unknowns.length);
  assert.equal(token.symbol.length, 32);
  assert.equal(token.name.length, 96);
  assert.ok(!token.symbol.includes('\u0000'));
  assert.ok(!token.aveUrl.includes('ref='));
  assert.equal(normalizeToken(fixture({ is_honeypot: 1 }), 'bnb', { observedAt: now }).risk.status, 'unknown');
});

test('AVE ranks makes one fixed-origin v2 GET with a header key, redirect prohibition and deadline', async () => {
  const calls = [];
  const api = client(async (url, options) => { calls.push({ url, options }); return json([fixture(), fixture({ chain: 'solana', token: mint })]); });
  const tokens = await api.ranks({ chain: 'bnb', apiKey: 'test-api-key' });
  assert.equal(tokens.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://prod.ave-api.com/v2/ranks?topic=bsc&limit=30');
  assert.equal(calls[0].options.headers['X-API-KEY'], 'test-api-key');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'GET');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.ok(!calls[0].url.includes('test-api-key'));
});

test('AVE validates chain, key and contract address before making any request', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return json([]); });
  await assert.rejects(api.ranks({ chain: 'eth', apiKey: 'key' }), { code: 'AVE_CHAIN', safe: true });
  await assert.rejects(api.ranks({ chain: 'bnb', apiKey: '' }), { code: 'AVE_CREDENTIALS', safe: true });
  await assert.rejects(api.ranks({ chain: 'bnb', apiKey: 'key\r\nInjected: x' }), { code: 'AVE_CREDENTIALS', safe: true });
  await assert.rejects(api.contracts({ chain: 'bnb', address: '../wallet', apiKey: 'key' }), { code: 'AVE_ADDRESS', safe: true });
  assert.equal(calls, 0);
});

test('contract report exposes explicit warning flags without claiming that any report proves safety', async () => {
  const calls = [];
  const api = client(async (url, options) => { calls.push({ url, options }); return json({ is_honeypot: '1', cannot_sell_all: true, has_black_method: 1, sell_tax: '999', risk_score: 0 }); });
  const risk = await api.contracts({ chain: 'bnb', address: bnb, apiKey: 'key' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://prod.ave-api.com/v2/contracts/${bnb}-bsc`);
  assert.equal(risk.status, 'flagged');
  assert.equal(risk.flags.length, 3);
  assert.equal(risk.checkedAt, now);
  assert.equal(risk.source, 'AVE contracts');
  assert.ok(risk.unknowns.length);
  for (const value of [-1, 0, '0', false, null, undefined, 'true', 2]) {
    const noProof = await client(async () => json({ is_honeypot: value, cannot_sell_all: value, risk_score: 100 })).contracts({ chain: 'solana', address: mint, apiKey: 'key' });
    assert.equal(noProof.status, 'unknown', String(value));
    assert.deepEqual(noProof.flags, []);
  }
});

test('HTTP429 retry is clamped, date-aware and never retries automatically', async () => {
  for (const [header, expected] of [['1', 60_000], ['180', 180_000], ['999999999', 86_400_000], [new Date(now + 600_000).toUTCString(), 600_000], ['broken', 60_000]]) {
    let calls = 0;
    const api = client(async () => { calls++; return new Response('key-in-error-body', { status: 429, headers: { 'Retry-After': header } }); });
    await assert.rejects(api.ranks({ chain: 'bnb', apiKey: 'secret-key' }), error => error.code === 'AVE_RATE_LIMIT' && error.retryAfterMs === expected && !error.message.includes('key-in-error-body'));
    assert.equal(calls, 1);
  }
});

test('authorization, network and provider errors never echo raw messages, bodies, URL or key', async () => {
  const secret = 'private-api-key';
  for (const status of [401, 403, 500]) {
    await assert.rejects(client(async () => new Response(secret, { status })).ranks({ chain: 'bnb', apiKey: secret }), error => error.safe && !error.message.includes(secret));
  }
  const injected = Object.assign(new Error(`headers X-API-KEY=${secret} https://evil.test`), { safe: true, code: 'AVE_NETWORK' });
  await assert.rejects(client(async () => { throw injected; }).ranks({ chain: 'bnb', apiKey: secret }), error => error.code === 'AVE_NETWORK' && error.message !== injected.message && !error.message.includes(secret));
  await assert.rejects(client(async () => new Response(JSON.stringify({ status: 0, msg: secret, data: [] }))).ranks({ chain: 'bnb', apiKey: secret }), error => error.code === 'AVE_REJECTED' && !error.message.includes(secret));
});

test('malformed success envelopes and unexpected rank shapes are rejected', async () => {
  for (const body of ['not json', '[]', '{"status":"1","data":[]}', '{"status":1}', '{"status":1,"data":{}}']) {
    await assert.rejects(client(async () => new Response(body)).ranks({ chain: 'bnb', apiKey: 'key' }), { code: 'AVE_FORMAT', safe: true });
  }
  await assert.rejects(client(async () => json(Array(301).fill(fixture()))).ranks({ chain: 'bnb', apiKey: 'key' }), { code: 'AVE_FORMAT', safe: true });
  await assert.rejects(client(async () => json([])).contracts({ chain: 'bnb', address: bnb, apiKey: 'key' }), { code: 'AVE_FORMAT', safe: true });
});

test('contract reports for a different address or chain cannot attach permanent warnings', async () => {
  for (const data of [{ token: pool, is_honeypot: 1 }, { token: bnb, chain: 'solana', is_honeypot: 1 }, { address: 'invalid', is_honeypot: 1 }]) {
    await assert.rejects(client(async () => json(data)).contracts({ chain: 'bnb', address: bnb, apiKey: 'key' }), { code: 'AVE_IDENTITY', safe: true });
  }
  const risk = await client(async () => json({ token: bnb.toLowerCase(), chain: 'bsc', is_honeypot: 0 })).contracts({ chain: 'bnb', address: bnb, apiKey: 'key' });
  assert.equal(risk.status, 'unknown');
});

test('response body cap rejects both declared and streamed oversized data', async () => {
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { canceled = true; },
  });
  await assert.rejects(client(async () => new Response(stream)).ranks({ chain: 'bnb', apiKey: 'key' }), { code: 'AVE_BODY_SIZE', safe: true });
  assert.equal(canceled, true);
  await assert.rejects(client(async () => new Response('{}', { headers: { 'Content-Length': '1048577' } })).ranks({ chain: 'bnb', apiKey: 'key' }), { code: 'AVE_BODY_SIZE', safe: true });
});

test('caller cancellation reaches native fetch through the combined deadline signal', async () => {
  const controller = new AbortController();
  const api = client(async (_url, { signal }) => {
    assert.equal(signal.aborted, false);
    controller.abort();
    assert.equal(signal.aborted, true);
    throw new DOMException('contains key', 'AbortError');
  });
  await assert.rejects(api.ranks({ chain: 'bnb', apiKey: 'key', signal: controller.signal }), { code: 'AVE_ABORTED', safe: true });
});

test('the 12-second request deadline is classified without leaking the network error', async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 12_000); return deadline.signal; });
  const api = client(async (_url, { signal }) => {
    deadline.abort();
    assert.equal(signal.aborted, true);
    throw new DOMException('raw request header private-api-key', 'TimeoutError');
  });
  await assert.rejects(api.ranks({ chain: 'bnb', apiKey: 'private-api-key' }), error => error.code === 'AVE_TIMEOUT' && !error.message.includes('private-api-key'));
});
