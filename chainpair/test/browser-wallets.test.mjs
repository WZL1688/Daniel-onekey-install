import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWalletBridge } from '../src/browser-wallets.mjs';
import { Store } from '../src/store.mjs';

const address = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const hash = `0x${'a'.repeat(64)}`;
const clientId = randomUUID();
const input = { kind: 'evmSend', quoteId: 'quote-1', payload: { transaction: { from: address, chainId: '0x38', to: other, data: '0x1234' } } };
function fixture(options = {}) {
  const broker = new BrowserWalletBridge(options);
  broker.connect({ chain: 'bnb', address, provider: 'metamask', clientId });
  return broker;
}

test('extension request belongs to one page, is delivered once, and identical result retries are idempotent', async () => {
  const broker = fixture();
  try {
    const result = broker.request('bnb', input);
    assert.deepEqual(broker.poll(randomUUID()).requests, []);
    const [request] = broker.poll(clientId).requests;
    assert.equal(request.payload.transaction.from, address);
    assert.deepEqual(broker.poll(clientId).requests, []);
    assert.throws(() => broker.resolve({ clientId: randomUUID(), requestId: request.id, result: { hash } }));
    assert.deepEqual(broker.resolve({ clientId, requestId: request.id, result: { hash } }), { ok: true });
    assert.deepEqual(await result, { hash });
    assert.deepEqual(broker.resolve({ clientId, requestId: request.id, result: { hash } }), { ok: true, duplicate: true });
    assert.throws(() => broker.resolve({ clientId, requestId: request.id, result: { hash: `0x${'b'.repeat(64)}` } }));
    assert.equal('clientId' in broker.status('bnb'), false);
  } finally { broker.close(); }
});

test('requests cannot resolve before browser dispatch and user cancellation cannot be replayed', async () => {
  const broker = fixture();
  try {
    const pending = broker.request('bnb', input);
    const id = [...broker.requests.keys()][0];
    assert.throws(() => broker.resolve({ clientId, requestId: id, result: { hash } }), /尚未交给/);
    const failure = assert.rejects(pending, /用户取消/);
    broker.poll(clientId);
    broker.resolve({ clientId, requestId: id, error: { code: 4001, message: 'sensitive-provider-error-is-not-archived' } });
    await failure;
    assert.deepEqual(broker.poll(clientId).requests, []);
    assert.deepEqual(broker.resolve({ clientId, requestId: id, error: { code: 4001 } }), { ok: true, duplicate: true });
  } finally { broker.close(); }
});

test('invalid or changed heartbeat address disconnects and rejects a pending request', async () => {
  for (const reported of [other, 'not-an-address']) {
    const broker = fixture();
    try {
      const failure = assert.rejects(broker.request('bnb', input), /插件已断开/);
      broker.poll(clientId);
      assert.throws(() => broker.heartbeat({ clientId, connections: [{ chain: 'bnb', address: reported }] }));
      assert.equal(broker.status('bnb').connected, false);
      await failure;
    } finally { broker.close(); }
  }
});

test('heartbeat expiry disables signing and connected pages cannot take over another active page', async () => {
  let clock = Date.now();
  const broker = fixture({ clock: () => clock, connectionTtlMs: 100 });
  try {
    assert.throws(() => broker.connect({ chain: 'bnb', address, provider: 'metamask', clientId: randomUUID() }), /另一个页面/);
    clock += 101;
    assert.equal(broker.status('bnb').connected, false);
    await assert.rejects(broker.request('bnb', input), /未连接/);
    broker.connect({ chain: 'bnb', address, provider: 'okx', clientId });
    assert.equal(broker.status('bnb').connected, true);
  } finally { broker.close(); }
});

test('expired EVM hash is archived and marked uncertain once, without retaining signed bytes', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'extension-late-'));
  const store = new Store(directory);
  let clock = Date.now(); const uncertain = [];
  store.saveTrade({ id: 'trade-late', status: 'BUY_SUBMITTING', mode: 'demo' });
  store.saveQuote({ id: 'quote-1', tradeId: 'trade-late' });
  const broker = fixture({ store, clock: () => clock, requestTimeoutMs: 100, onUncertain: evidence => uncertain.push(evidence) });
  try {
    const failure = assert.rejects(broker.request('bnb', input), /超过报价有效期/);
    const [request] = broker.poll(clientId).requests;
    clock += 101;
    const late = broker.resolve({ clientId, requestId: request.id, result: { hash } });
    await failure;
    assert.equal(late.late, true);
    assert.equal(uncertain[0].tradeId, 'trade-late');
    assert.equal(uncertain[0].hash, hash);
    assert.equal(broker.resolve({ clientId, requestId: request.id, result: { hash } }).duplicate, true);
    assert.equal(uncertain.length, 1);
    const archive = JSON.stringify(store.getTrade('trade-late'));
    assert(archive.includes('BROWSER_LATE_RESULT'));
    assert(archive.includes(hash));
    assert(!archive.includes('signedTransactionBase64'));
    assert(!archive.includes('0x1234'));
  } finally { broker.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('late Solana signature is discarded without broadcast or uncertainty hash', async () => {
  let clock = Date.now(); const uncertain = [];
  const broker = new BrowserWalletBridge({ clock: () => clock, requestTimeoutMs: 100, onUncertain: value => uncertain.push(value) });
  const solAddress = '11111111111111111111111111111111';
  broker.connect({ chain: 'solana', address: solAddress, provider: 'phantom', clientId });
  try {
    const failure = assert.rejects(broker.request('solana', { kind: 'solSign', quoteId: 'sol-quote', payload: { sender: solAddress, transactionBase64: 'AA==' } }), /超过报价有效期/);
    const [request] = broker.poll(clientId).requests;
    clock += 101;
    const result = broker.resolve({ clientId, requestId: request.id, result: { signedTransactionBase64: 'AA==' } });
    await failure;
    assert.equal(result.late, true);
    assert.equal(uncertain.length, 0);
    assert.equal(broker.requests.get(request.id).payload, null);
    assert.equal(broker.requests.get(request.id).resolve, null);
  } finally { broker.close(); }
});
