import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DiscoveryClient } from '../src/opportunities/sources.mjs';
import { normalizeWrappedMapping, WORMHOLE_WRAPPED_URL, WORMHOLE_SOURCE_REF } from '../src/opportunities/wormhole.mjs';

const now = Date.parse('2026-11-20T10:00:00Z');
const origin = '0x1111111111111111111111111111111111111111';
const bnb = '0x2222222222222222222222222222222222222222';
const bnbOther = '0x3333333333333333333333333333333333333333';
const solana = 'So11111111111111111111111111111111111111112';
const solanaOther = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const wrap = body => `export const MAINNET_WRAPPED_TOKENS = { ${body} };`;
const mapping = wrap(`Ethereum: { '${origin}': { Bsc: '${bnb}', Solana: '${solana}', }, },`);
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('official origin mapping creates unapproved BNB/Solana candidates without ticker matching', () => {
  const [candidate] = normalizeWrappedMapping(mapping, { observedAt: now });
  assert.equal(candidate.id, `wormhole:${createHash('sha256').update(`Ethereum:${origin}`).digest('hex').slice(0, 40)}`);
  assert.deepEqual(candidate.chains, { bnb: { address: bnb }, solana: { address: solana } });
  assert.equal(candidate.sourceRef, WORMHOLE_SOURCE_REF); assert.equal(candidate.source, 'wormhole');
  assert.equal(candidate.symbol, 'WRAPPED'); assert.equal(candidate.evidenceKind, 'canonical-origin-map');
  assert.match(candidate.riskNotice, /包装资产/); assert.equal('approved' in candidate, false); assert.equal('safe' in candidate, false);
});

test('BNB and Solana native origins use their original contract instead of requiring redundant destinations', () => {
  const fromBnb = normalizeWrappedMapping(wrap(`Bsc: { '${bnb}': { Solana: '${solana}' } }`), { observedAt: now });
  const fromSolana = normalizeWrappedMapping(wrap(`Solana: { '${solana}': { Bsc: '${bnb}' } }`), { observedAt: now });
  assert.equal(fromBnb.length, 1); assert.equal(fromSolana.length, 1);
  assert.equal(fromBnb[0].origin.chain, 'Bsc'); assert.equal(fromSolana[0].origin.chain, 'Solana');
  assert.deepEqual(normalizeWrappedMapping(wrap(`Bsc: { '${bnb}': { Bsc: '${bnbOther}', Solana: '${solana}' } }`), { observedAt: now }), []);
});

test('parser accepts only pinned data grammar, comments, trailing commas and a const assertion', () => {
  const input = `/* provenance */ export const MAINNET_WRAPPED_TOKENS /* data */ = { // chain\n Ethereum: { '${origin}': { Bsc: '${bnb}', Solana: '${solana}', }, }, } as const; // end`;
  assert.equal(normalizeWrappedMapping(input, { observedAt: now }).length, 1);
  for (const source of [
    mapping + ' globalThis.compromised = true;',
    wrap(`Ethereum: (() => { globalThis.compromised = true; return {}; })()`),
    wrap(`Ethereum: { ['${origin}']: { Bsc: '${bnb}', Solana: '${solana}' } }`),
    wrap(`Ethereum: { '${origin}': { Bsc: '${bnb}', Solana: process.env.SECRET } }`),
    wrap(`__proto__: { '${origin}': { Bsc: '${bnb}', Solana: '${solana}' } }`),
    wrap(`Ethereum: { '${origin}': { Bsc: '${bnb}', Solana: \\`),
    `import 'untrusted'; ${mapping}`,
    mapping.replace('export const', 'export let'),
    mapping.replace('MAINNET_WRAPPED_TOKENS', 'OTHER_CONSTANT'),
    wrap(`Ethereum: { '${origin}': { Bsc: '${bnb}', Bsc: '${bnbOther}', Solana: '${solana}' } }`),
    wrap(`Ethereum: { '${origin}': { Bsc: '${bnb}', Solana: { nested: '${solana}' } } }`),
  ]) assert.throws(() => normalizeWrappedMapping(source, { observedAt: now }), { safe: true, code: 'DISCOVERY_FORMAT' });
  assert.equal(globalThis.compromised, undefined);
});

test('identical aliases deduplicate, conflicting repeated addresses are quarantined', () => {
  const identical = wrap(`Ethereum: { '${origin}': { Bsc:'${bnb}', Solana:'${solana}' } }, Base: { '${origin}': { Bsc:'${bnb}', Solana:'${solana}' } }`);
  assert.equal(normalizeWrappedMapping(identical, { observedAt: now }).length, 1);
  for (const second of [`Bsc:'${bnb}', Solana:'${solanaOther}'`, `Bsc:'${bnbOther}', Solana:'${solana}'`]) {
    const conflicting = wrap(`Ethereum: { '${origin}': { Bsc:'${bnb}', Solana:'${solana}' }, '${bnbOther}': { ${second} } }`);
    assert.deepEqual(normalizeWrappedMapping(conflicting, { observedAt: now }), []);
  }
});

test('mapping data rejects oversized inputs, invalid clocks and unsupported addresses without inventing tokens', () => {
  assert.throws(() => normalizeWrappedMapping(' '.repeat(256 * 1024 + 1), { observedAt: now }), { code: 'DISCOVERY_FORMAT' });
  assert.throws(() => normalizeWrappedMapping(mapping, { observedAt: 0 }), { code: 'DISCOVERY_FORMAT' });
  assert.throws(() => normalizeWrappedMapping(mapping, { observedAt: now, limit: 101 }), { code: 'DISCOVERY_FORMAT' });
  assert.deepEqual(normalizeWrappedMapping(wrap(`Ethereum: { '${origin}': { Bsc:'javascript:alert(1)', Solana:'${solana}' } }`), { observedAt: now }), []);
});

test('a conflicting origin alias cannot re-enter through an identical pair under another origin', () => {
  const lower = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', upper = `0x${lower.slice(2).toUpperCase()}`;
  const input = wrap(`Ethereum: { '${lower}': { Bsc:'${bnb}', Solana:'${solana}' }, '${upper}': { Bsc:'${bnbOther}', Solana:'${solanaOther}' } }, Base: { '${origin}': { Bsc:'${bnb}', Solana:'${solana}' } }`);
  assert.deepEqual(normalizeWrappedMapping(input, { observedAt: now }), []);
});

test('CoinGecko key is a header on its exact origin only, with one request per client method', async () => {
  const key = 'test-only-cg-demo-key', calls = [];
  const client = new DiscoveryClient({ now: () => now, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url === WORMHOLE_WRAPPED_URL) return new Response(mapping);
    return json([]);
  } });
  await client.discover({ apiKey: key });
  await client.pools({ chain: 'bnb', addresses: [bnb], apiKey: key });
  const wrapped = await client.discoverWrapped({ apiKey: key });
  assert.equal(wrapped.length, 1); assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers['x-cg-demo-api-key'], key);
  for (const call of calls.slice(1)) assert.equal('x-cg-demo-api-key' in call.options.headers, false);
  assert(calls.every(call => !call.url.includes(key) && call.options.method === 'GET' && call.options.redirect === 'error' && call.options.signal instanceof AbortSignal));
  assert.equal(calls[2].url, WORMHOLE_WRAPPED_URL);
});

test('invalid credentials fail locally and provider rejection cannot reflect a key', async () => {
  const key = 'test-only-sensitive-demo-key'; let calls = 0;
  const invalid = new DiscoveryClient({ fetchImpl: async () => { calls++; return json([]); } });
  for (const apiKey of ['', 'has space', 'x\ny', 'x'.repeat(1001), 42]) await assert.rejects(invalid.discover({ apiKey }), { safe: true, code: 'DISCOVERY_CREDENTIALS' });
  assert.equal(calls, 0);
  const reflected = new DiscoveryClient({ fetchImpl: async () => json({ status: { error_message: key } }) });
  await assert.rejects(reflected.discover({ apiKey: key }), error => error.code === 'DISCOVERY_REJECTED' && !JSON.stringify(error).includes(key) && !error.message.includes(key));
  const malformed = new DiscoveryClient({ fetchImpl: async () => json([{ id: 'test-only-sensitive-demo-key', name: key, symbol: key, platforms: { 'binance-smart-chain': bnb, solana } }]) });
  assert.deepEqual(await malformed.discover({ apiKey: key }), []);
});

test('network diagnostics publish only classifications and 5xx stays distinct from permission failures', async () => {
  for (const [code, reason] of [['ENOTFOUND', 'DNS'], ['ETIMEDOUT', 'TIMEOUT'], ['ECONNRESET', 'CONNECTION'], ['CERT_HAS_EXPIRED', 'TLS'], ['ERR_PROXY_CONNECTION_FAILED', 'PROXY'], ['SECRET-ARBITRARY-CODE', 'NETWORK']]) {
    const api = new DiscoveryClient({ fetchImpl: async () => { throw Object.assign(new Error('private secret url'), { cause: { code } }); } });
    await assert.rejects(api.discover(), error => error.code === 'DISCOVERY_NETWORK' && error.networkReason === reason && !JSON.stringify(error).includes('private secret'));
  }
  for (const [status, expected] of [[403, 'DISCOVERY_AUTH'], [404, 'DISCOVERY_REJECTED'], [503, 'DISCOVERY_UNAVAILABLE']]) {
    const api = new DiscoveryClient({ fetchImpl: async () => new Response('raw private provider body', { status }) });
    await assert.rejects(api.discoverWrapped(), error => error.code === expected && error.httpStatus === status && !error.message.includes('raw private'));
  }
});

test('wrapped response uses a256KB streaming body cap and never evaluates injected source', async () => {
  const api = new DiscoveryClient({ fetchImpl: async () => new Response(mapping, { headers: { 'content-length': String(256 * 1024 + 1) } }) });
  await assert.rejects(api.discoverWrapped(), { code: 'DISCOVERY_FORMAT', safe: true });
  const streaming = new DiscoveryClient({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); controller.close(); } })) });
  await assert.rejects(streaming.discoverWrapped(), { code: 'DISCOVERY_FORMAT', safe: true });
  const injection = new DiscoveryClient({ fetchImpl: async () => new Response(mapping + 'globalThis.compromised=true;') });
  await assert.rejects(injection.discoverWrapped(), { code: 'DISCOVERY_FORMAT', safe: true }); assert.equal(globalThis.compromised, undefined);
});
