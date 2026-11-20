import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { DiscoveryClient, normalizeDiscovery, normalizePools } from '../src/opportunities/sources.mjs';

const now = Date.parse('2026-11-20T08:00:00Z');
const bnb = '0x1111111111111111111111111111111111111111';
const anotherBnb = '0x2222222222222222222222222222222222222222';
const bnbPool = '0x3333333333333333333333333333333333333333';
const bnbQuote = '0x4444444444444444444444444444444444444444';
const solana = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const solanaOther = 'So11111111111111111111111111111111111111112';
const solanaPool = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const coin = patch => ({ id: 'example-asset', symbol: 'example', name: 'Example asset', platforms: { 'binance-smart-chain': bnb, solana }, ...patch });
const pool = patch => ({ chainId: 'bsc', pairAddress: bnbPool, baseToken: { address: bnb }, quoteToken: { address: bnbQuote }, priceUsd: '0.01234', liquidity: { usd: '40000' }, volume: { h24: 20000 }, dexId: 'pancakeswap', ...patch });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const client = fetchImpl => new DiscoveryClient({ fetchImpl, now: () => now });

test('CoinGecko discovers candidates by shared coin ID and exact two-chain contracts, never by ticker', () => {
  const result = normalizeDiscovery([
    coin(),
    coin({ id: 'single-chain', symbol: 'example', platforms: { solana } }),
    coin({ id: 'bad-address', platforms: { 'binance-smart-chain': 'javascript:go()', solana } }),
    coin({ id: '../injected-route' }),
    coin({ id: 'CaseMismatch' }),
    coin({ id: 'zero-address', platforms: { 'binance-smart-chain': `0x${'0'.repeat(40)}`, solana } }),
  ], { observedAt: now });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { id: 'coingecko:example-asset', symbol: 'example', name: 'Example asset', source: 'coingecko', sourceRef: 'https://www.coingecko.com/en/coins/example-asset', chains: { bnb: { address: bnb }, solana: { address: solana } }, observedAt: now });
  assert.equal('approved' in result[0], false); assert.equal('safe' in result[0], false);
});

test('discovery truncates untrusted descriptions and discards response URLs and hidden controls', () => {
  const [result] = normalizeDiscovery([coin({ symbol: 'X\u0000'.repeat(100), name: '<b>N</b>'.repeat(100), sourceRef: 'https://malicious.invalid', approved: true, safe: true })], { observedAt: now });
  assert.equal(result.symbol.length, 32); assert.equal(result.symbol.includes('\u0000'), false); assert.equal(result.name.length, 100);
  assert.equal(result.sourceRef, 'https://www.coingecko.com/en/coins/example-asset');
  assert.equal('approved' in result, false); assert.equal('safe' in result, false);
});

test('duplicate or reused contract identities are quarantined, exact duplicate rows are deduplicated', () => {
  assert.equal(normalizeDiscovery([coin(), coin()], { observedAt: now }).length, 1);
  assert.deepEqual(normalizeDiscovery([coin(), coin({ platforms: { 'binance-smart-chain': anotherBnb, solana: solanaOther } })], { observedAt: now }), []);
  assert.deepEqual(normalizeDiscovery([coin(), coin({ id: 'same-bnb-other-origin', platforms: { 'binance-smart-chain': bnb, solana: solanaOther } })], { observedAt: now }), []);
  assert.deepEqual(normalizeDiscovery([coin(), coin({ id: 'same-solana-other-origin', platforms: { 'binance-smart-chain': anotherBnb, solana } })], { observedAt: now }), []);
  assert.deepEqual(normalizeDiscovery([coin(), coin({ platforms: {} })], { observedAt: now }), []);
});

test('discovery checks entries after the result cap before exposing the first200 candidates', () => {
  const rows = Array.from({ length: 201 }, (_, index) => coin({ id: `asset-${index}`, platforms: { 'binance-smart-chain': `0x${(index + 50).toString(16).padStart(40, '0')}`, solana: publicKeyFor(index) } }));
  rows.push({ ...rows[0], name: 'Changed duplicate after cap' });
  const result = normalizeDiscovery(rows, { observedAt: now });
  assert.equal(result.length, 200); assert.equal(result.some(row => row.id === 'coingecko:asset-0'), false);
});

function publicKeyFor(index) {
  // Distinct valid Base58 public keys with no generated secret material.
  const bytes = new Uint8Array(32); bytes[30] = Math.floor((index + 1) / 256); bytes[31] = (index + 1) % 256;
  return new PublicKey(bytes).toBase58();
}

test('pool lookup accepts only requested exact-chain base tokens, never infers quote prices', () => {
  const result = normalizePools([
    pool(), pool({ chainId: 'solana' }), pool({ pairAddress: 'https://malicious.invalid' }),
    pool({ baseToken: { address: anotherBnb }, quoteToken: { address: bnb } }),
    pool({ baseToken: { address: bnb }, quoteToken: { address: bnb } }),
    pool({ baseToken: { address: anotherBnb } }), pool({ priceUsd: 0 }),
  ], { chain: 'bnb', addresses: [bnb], observedAt: now });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { chain: 'bnb', tokenAddress: bnb, poolAddress: bnbPool, quoteAddress: bnbQuote, priceUsd: .01234, liquidityUsd: 40000, volume24hUsd: 20000, observedAt: now, sourceUpdatedAt: null, dexId: 'pancakeswap' });
});

test('Solana pool identities remain exact and missing liquidity stays unknown rather than a passing zero', () => {
  const rows = [{ chainId: 'solana', pairAddress: solanaPool, baseToken: { address: solana }, quoteToken: { address: solanaOther }, priceUsd: '1', liquidity: { usd: false }, volume: { h24: '' }, dexId: 'raydium\u0000'.repeat(20), updatedAt: now }];
  const [result] = normalizePools(rows, { chain: 'solana', addresses: [solana], observedAt: now });
  assert.equal(result.tokenAddress, solana); assert.equal(result.liquidityUsd, null); assert.equal(result.volume24hUsd, null);
  assert.equal(result.sourceUpdatedAt, null); assert.equal(result.dexId.length, 64); assert.equal(result.dexId.includes('\u0000'), false);
  for (const invalid of [Infinity, NaN, -1, true, '', null, '0xFF']) assert.deepEqual(normalizePools([pool({ priceUsd: invalid })], { chain: 'bnb', addresses: [bnb], observedAt: now }), []);
});

test('conflicting duplicate pools are quarantined instead of choosing an apparent profitable value', () => {
  assert.equal(normalizePools([pool(), pool()], { chain: 'bnb', addresses: [bnb], observedAt: now }).length, 1);
  assert.deepEqual(normalizePools([pool(), pool({ priceUsd: '.02' })], { chain: 'bnb', addresses: [bnb], observedAt: now }), []);
});

test('clients make exactly one fixed-origin GET per request, with no credentials or redirects', async () => {
  const calls = [];
  const api = client(async (url, options) => { calls.push({ url, options }); return json(url.includes('coingecko') ? [coin()] : [pool()]); });
  assert.equal((await api.discover()).length, 1);
  assert.equal((await api.pools({ chain: 'bnb', addresses: [bnb, bnb] })).length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.coingecko.com/api/v3/coins/list?include_platform=true');
  assert.equal(calls[1].url, `https://api.dexscreener.com/tokens/v1/bsc/${bnb}`);
  for (const { options } of calls) { assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal); assert.deepEqual(options.headers, { Accept: 'application/json' }); }
});

test('invalid pool request arguments fail before network dispatch', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return json([]); });
  for (const args of [{ chain: 'eth', addresses: [bnb] }, { chain: 'bnb', addresses: [] }, { chain: 'bnb', addresses: Array(31).fill(bnb) }, { chain: 'bnb', addresses: ['../bad-route'] }, { chain: 'solana', addresses: [bnb] }]) await assert.rejects(api.pools(args), { safe: true, code: 'DISCOVERY_FORMAT' });
  assert.equal(calls, 0);
});

test('429 Retry-After is clamped and returned without automatically retrying', async () => {
  for (const [header, expected] of [['1', 60000], ['300', 300000], ['9999999999999999999999999999999999999999', 86400000], [new Date(now + 900000).toUTCString(), 900000], ['broken', 60000]]) {
    let calls = 0;
    const api = client(async () => { calls++; return new Response('remote body must not echo', { status: 429, headers: { 'Retry-After': header } }); });
    await assert.rejects(api.discover(), error => error.safe && error.code === 'DISCOVERY_RATE_LIMIT' && error.retryAfterMs === expected && !error.message.includes('remote body'));
    assert.equal(calls, 1);
  }
});

test('auth, explicit rejection and network exceptions cannot leak remote messages or response bodies', async () => {
  const secret = 'do-not-echo-sensitive-provider-text';
  for (const status of [401, 403]) await assert.rejects(client(async () => new Response(secret, { status })).discover(), error => error.code === 'DISCOVERY_AUTH' && !error.message.includes(secret));
  await assert.rejects(client(async () => new Response(secret, { status: 500 })).discover(), { safe: true, code: 'DISCOVERY_REJECTED' });
  await assert.rejects(client(async () => json({ error: secret })).discover(), error => error.code === 'DISCOVERY_REJECTED' && !error.message.includes(secret));
  const injected = Object.assign(new Error(secret), { safe: true, code: 'DISCOVERY_NETWORK' });
  await assert.rejects(client(async () => { throw injected; }).discover(), error => error.code === 'DISCOVERY_NETWORK' && error.message !== secret);
});

test('malformed and oversized responses are rejected before unbounded buffering', async () => {
  await assert.rejects(client(async () => new Response('not json')).discover(), { safe: true, code: 'DISCOVERY_FORMAT' });
  await assert.rejects(client(async () => json({ pairs: [] })).pools({ chain: 'bnb', addresses: [bnb] }), { safe: true, code: 'DISCOVERY_FORMAT' });
  for (const [method, limit] of [['discover', 8 * 1024 * 1024], ['pools', 2 * 1024 * 1024]]) {
    const api = client(async () => new Response('[]', { headers: { 'Content-Length': String(limit + 1) } }));
    await assert.rejects(method === 'discover' ? api.discover() : api.pools({ chain: 'bnb', addresses: [bnb] }), { safe: true, code: 'DISCOVERY_FORMAT' });
  }
  let canceled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { canceled = true; } });
  await assert.rejects(client(async () => new Response(stream)).pools({ chain: 'bnb', addresses: [bnb] }), { safe: true, code: 'DISCOVERY_FORMAT' });
  assert.equal(canceled, true);
});

test('caller abort and the twelve-second deadline reach fetch and publish only fixed errors', async t => {
  const controller = new AbortController();
  await assert.rejects(client(async (_url, { signal }) => { controller.abort(); assert.equal(signal.aborted, true); throw new DOMException('remote raw input', 'AbortError'); }).discover({ signal: controller.signal }), { safe: true, code: 'DISCOVERY_ABORTED' });
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 12000); return deadline.signal; });
  await assert.rejects(client(async (_url, { signal }) => { deadline.abort(); assert.equal(signal.aborted, true); throw new DOMException('remote raw input', 'TimeoutError'); }).discover(), { safe: true, code: 'DISCOVERY_TIMEOUT' });
});
