import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { PAPRIKA_PLATFORMS, normalizeContractCatalog, mergeContractCatalogs, projectDirectory } from '../src/opportunities/catalogs.mjs';

const at = Date.parse('2026-11-22T02:00:00Z');
const bnbAddress = index => `0x${BigInt(index + 1).toString(16).padStart(40, '0')}`;
const solAddress = index => {
  const bytes = new Uint8Array(32); bytes[30] = (index + 1) >> 8; bytes[31] = (index + 1) & 255;
  return new PublicKey(bytes).toBase58();
};
const contracts = (chain, id = 'alt-same-asset', index = 0, patch = {}) => ({ id, address: chain === 'bnb' ? bnbAddress(index) : solAddress(index), ...patch });
const merged = (bnb, solana, patch = {}) => mergeContractCatalogs({ bnb, solana, observedAt: at, ...patch });

test('platform IDs are provider IDs and the parser strips all remote trading and identity claims', () => {
  assert.deepEqual(PAPRIKA_PLATFORMS, { bnb: 'bnb-binance-coin', solana: 'sol-solana' });
  const [row] = normalizeContractCatalog([contracts('bnb', 'alt-same-asset', 0, {
    coinId: 'forged-other-id', symbol: 'USDT', name: 'Forged', sourceRef: 'https://evil.invalid/',
    approved: true, mapping: { confirmed: true }, privateKey: 'not-for-catalog', priceUsd: 999,
  })], { chain: 'bnb' });
  assert.deepEqual(row, { coinId: 'alt-same-asset', address: bnbAddress(0) });
  assert.deepEqual(normalizeContractCatalog([{ coinId: 'forged-id', address: bnbAddress(0) }], { chain: 'bnb' }), []);
});

test('catalogs reject invalid identifiers, addresses, inactive records and noncontract BNB formats', () => {
  const rows = [null, [], true, 'text', contracts('bnb'), contracts('bnb', '../bad'), contracts('bnb', 'CaseBad'),
    contracts('bnb', 'has space'), contracts('bnb', 'too-long-'.repeat(20)), contracts('bnb', 'inactive', 1, { active: false }),
    contracts('bnb', 'zero', 1, { address: `0x${'0'.repeat(40)}` }),
    contracts('bnb', 'bep2', 1, { address: 'bnb1thisisnotanEVMcontract' }),
    contracts('bnb', 'bad-route', 1, { address: 'javascript:go()' }),
    contracts('bnb', 'overlong', 1, { address: '0x' + '1'.repeat(200) })];
  assert.deepEqual(normalizeContractCatalog(rows, { chain: 'bnb' }), [{ coinId: 'alt-same-asset', address: bnbAddress(0) }]);
  assert.deepEqual(normalizeContractCatalog([contracts('bnb')], { chain: 'solana' }), []);
  assert.equal(normalizeContractCatalog([contracts('solana')], { chain: 'solana' }).length, 1);
});

test('exact duplicate records and EVM casing normalize once, while Solana case remains exact', () => {
  const baby = '0xc748673057861a797275CD8A068AbB95A902e8de';
  assert.deepEqual(normalizeContractCatalog([{ id: 'baby-doge', address: baby }, { id: 'baby-doge', address: baby.toLowerCase() }], { chain: 'bnb' }), [{ coinId: 'baby-doge', address: baby }]);
  const rows = [contracts('solana'), contracts('solana')];
  assert.equal(normalizeContractCatalog(rows, { chain: 'solana' }).length, 1);
});

test('joining uses the exact canonical coin ID, never a shared symbol or name', () => {
  const bnb = normalizeContractCatalog([contracts('bnb', 'alt-first', 0, { symbol: 'SAME' })], { chain: 'bnb' });
  const solana = normalizeContractCatalog([contracts('solana', 'alt-other', 0, { symbol: 'SAME' })], { chain: 'solana' });
  assert.deepEqual(merged(bnb, solana), []);
  const [row] = merged(bnb, normalizeContractCatalog([contracts('solana', 'alt-first')], { chain: 'solana' }));
  assert.deepEqual(row, {
    id: 'coinpaprika:alt-first', name: 'alt-first', symbol: 'ALT', source: 'coinpaprika', sourceKind: 'remote',
    sourceRef: 'https://coinpaprika.com/coin/alt-first', evidenceKind: 'provider-coin-id',
    chains: { bnb: { address: bnbAddress(0) }, solana: { address: solAddress(0) } }, observedAt: at,
  });
  for (const key of ['mapping', 'approved', 'safe', 'priceUsd', 'feeUsd', 'balance']) assert.equal(Object.hasOwn(row, key), false);
});

test('one coin with multiple contracts on either chain is quarantined in full', () => {
  assert.deepEqual(merged([contracts('bnb'), contracts('bnb', 'alt-same-asset', 1)], [contracts('solana')]), []);
  assert.deepEqual(merged([contracts('bnb')], [contracts('solana'), contracts('solana', 'alt-same-asset', 1)]), []);
  assert.equal(merged([contracts('bnb'), contracts('bnb')], [contracts('solana'), contracts('solana')]).length, 1);
});

test('address reuse across canonical IDs quarantines both identities including single-chain conflicts', () => {
  assert.deepEqual(merged([contracts('bnb'), contracts('bnb', 'other-id')], [contracts('solana')]), []);
  assert.deepEqual(merged([contracts('bnb')], [contracts('solana'), contracts('solana', 'other-id')]), []);
  assert.deepEqual(merged([contracts('bnb'), contracts('bnb', 'other-id')], [contracts('solana'), contracts('solana', 'other-id', 1)]), []);
});

test('conflicts after the output cap are checked before truncation and results have stable order', () => {
  const bnb = Array.from({ length: 301 }, (_, index) => contracts('bnb', `asset-${String(index).padStart(3, '0')}`, index));
  const solana = Array.from({ length: 301 }, (_, index) => contracts('solana', `asset-${String(index).padStart(3, '0')}`, index));
  bnb.push(contracts('bnb', 'asset-000', 999));
  const rows = merged(bnb, solana);
  assert.equal(rows.length, 300); assert.equal(rows.some(row => row.id === 'coinpaprika:asset-000'), false);
  assert.equal(rows[0].id, 'coinpaprika:asset-001');
  assert.deepEqual(merged(bnb.slice().reverse(), solana.slice().reverse()), rows);
});

test('bounded shapes, timestamps and output limits fail with fixed safe format errors', () => {
  for (const input of [null, {}, 'rows', Array(50001).fill(null)]) assert.throws(() => normalizeContractCatalog(input, { chain: 'bnb' }), { safe: true, code: 'DISCOVERY_FORMAT' });
  for (const chain of ['ethereum', '__proto__', null]) assert.throws(() => normalizeContractCatalog([], { chain }), { code: 'DISCOVERY_FORMAT' });
  for (const observedAt of [0, NaN, Infinity, '2026-11-22', -1, 1.5]) assert.throws(() => merged([], [], { observedAt }), { safe: true, code: 'DISCOVERY_FORMAT' });
  for (const limit of [0, 301, 1.5, '1', Infinity]) assert.throws(() => merged([], [], { limit }), { code: 'DISCOVERY_FORMAT' });
  assert.throws(() => merged({}, []), { code: 'DISCOVERY_FORMAT' });
});

test('issuer snapshot is dated address evidence only and each call is isolated', () => {
  const first = projectDirectory({ observedAt: at });
  assert.equal(first.length, 1); const row = first[0];
  assert.equal(row.id, 'project:babydoge'); assert.equal(row.sourceRef, 'https://babydoge.com/transparency/');
  assert.equal(row.sourceDate, '2026-11-22'); assert.equal(row.evidenceKind, 'issuer-published-addresses');
  assert.equal(row.chains.bnb.address, '0xc748673057861a797275CD8A068AbB95A902e8de');
  assert.equal(row.chains.solana.address, '7dUKUopcNWW6CcU4eRxCHh1uiMh32zDrmGf6ufqhxann');
  assert.equal(row.observedAt, at);
  for (const key of ['mapping', 'approved', 'safe', 'priceUsd', 'tax', 'feeUsd', 'balance']) assert.equal(Object.hasOwn(row, key), false);
  row.chains.bnb.address = bnbAddress(0); first.push({});
  assert.equal(projectDirectory({ observedAt: at }).length, 1);
  assert.equal(projectDirectory({ observedAt: at })[0].chains.bnb.address, '0xc748673057861a797275CD8A068AbB95A902e8de');
  assert.throws(() => projectDirectory({ observedAt: Infinity }), { code: 'DISCOVERY_FORMAT' });
});
