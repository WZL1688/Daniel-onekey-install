import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcPool } from '../src/adapters/rpc.mjs';

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const response = result => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
function fixture({ chain = 'bnb', urls = ['https://one.invalid/rpc'], onCall, now = 100000 } = {}) {
  const calls = [], statuses = [];
  let clock = now, endpoints = urls;
  const rpc = new RpcPool({ chain, now: () => clock, getUrls: () => endpoints,
    onStatus: (...input) => statuses.push(input),
    fetchImpl: async (url, options) => {
      const { method, params } = JSON.parse(options.body);
      const call = { url, method, params, options }; calls.push(call);
      const result = onCall ? await onCall(call) : method === 'eth_chainId' ? '0x38' : method === 'getGenesisHash' ? GENESIS : '0x10';
      return response(result);
    }
  });
  return { rpc, calls, statuses, at: value => { clock = value; }, urls: value => { endpoints = value; }, count: method => calls.filter(call => call.method === method).length };
}

test('ordinary BNB reads reuse a verified identity for less than ten seconds', async () => {
  const ctx = fixture();
  assert.equal(await ctx.rpc.call('eth_getBalance', ['0x1', 'latest']), '0x10');
  ctx.at(109999);
  assert.equal(await ctx.rpc.call('eth_call', [{ to: '0x1' }, 'latest']), '0x10');
  assert.equal(ctx.count('eth_chainId'), 1);
  ctx.at(110000);
  await ctx.rpc.call('eth_estimateGas', [{ to: '0x1' }]);
  assert.equal(ctx.count('eth_chainId'), 2);
  assert(ctx.calls.every(call => call.options.redirect === 'error'));
  assert(ctx.calls.every(call => call.options.signal instanceof AbortSignal));
});

test('clock rollback invalidates an otherwise unexpired identity', async () => {
  const ctx = fixture();
  await ctx.rpc.call('eth_blockNumber');
  ctx.at(105000); await ctx.rpc.call('eth_blockNumber');
  assert.equal(ctx.count('eth_chainId'), 1);
  ctx.at(104999); await ctx.rpc.call('eth_blockNumber');
  assert.equal(ctx.count('eth_chainId'), 2);
});

test('identity cache belongs to the exact URL, including path and query, and removed URLs are forgotten', async () => {
  const a = 'https://one.invalid/path?key=fixture-one', b = 'https://one.invalid/other?key=fixture-two';
  const ctx = fixture({ urls: [a, b] });
  await ctx.rpc.call('eth_blockNumber'); await ctx.rpc.call('eth_blockNumber');
  await ctx.rpc.call('eth_blockNumber'); await ctx.rpc.call('eth_blockNumber');
  assert.deepEqual(ctx.calls.filter(call => call.method === 'eth_chainId').map(call => call.url), [a, b]);
  ctx.urls([a]); await ctx.rpc.call('eth_blockNumber');
  ctx.urls([b]); await ctx.rpc.call('eth_blockNumber');
  assert.equal(ctx.count('eth_chainId'), 3);
  assert(ctx.statuses.every(([, status]) => !JSON.stringify(status).includes('fixture-')));
});

test('concurrent read calls share only their pending identity check', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = fixture({ onCall: async ({ method }) => {
    if (method === 'eth_chainId') { await pending; return '0x38'; }
    return '0x1';
  } });
  const first = ctx.rpc.call('eth_getBalance', ['0x1', 'latest']);
  const second = ctx.rpc.call('eth_call', [{ to: '0x1' }, 'latest']);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ctx.count('eth_chainId'), 1);
  assert.equal(ctx.count('eth_getBalance'), 0);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['0x1', '0x1']);
  assert.equal(ctx.count('eth_chainId'), 1);
});

test('wrong-chain identity is never cached and no business read occurs before verification', async () => {
  let correct = false;
  const ctx = fixture({ onCall: ({ method }) => method === 'eth_chainId' ? correct ? '0x38' : '0x1' : '0x10' });
  await assert.rejects(ctx.rpc.call('eth_getBalance', ['0x1', 'latest']), /BNB 主网 56/);
  assert.equal(ctx.count('eth_getBalance'), 0);
  correct = true; await ctx.rpc.call('eth_getBalance', ['0x1', 'latest']);
  assert.equal(ctx.count('eth_chainId'), 2);
});

test('a business request failure invalidates identity before the endpoint can be used again', async () => {
  let fail = true;
  const ctx = fixture({ onCall: ({ method }) => {
    if (method === 'eth_chainId') return '0x38';
    if (fail) throw new Error('fixture transport disconnected');
    return '0x10';
  } });
  await assert.rejects(ctx.rpc.call('eth_blockNumber'), /全部失败/);
  fail = false; await ctx.rpc.call('eth_blockNumber');
  assert.equal(ctx.count('eth_chainId'), 2);
});

test('read failover still rejects the wrong chain and separately verifies the next URL', async () => {
  const ctx = fixture({ urls: ['https://wrong.invalid', 'https://ok.invalid'], onCall: ({ url, method }) => method === 'eth_chainId' ? url.includes('wrong') ? '0x1' : '0x38' : '0x12' });
  assert.equal(await ctx.rpc.call('eth_blockNumber'), '0x12');
  assert.deepEqual(ctx.calls.map(call => [call.url, call.method]), [
    ['https://wrong.invalid', 'eth_chainId'], ['https://ok.invalid', 'eth_chainId'], ['https://ok.invalid', 'eth_blockNumber']
  ]);
});

test('broadcast rechecks a cached endpoint and refuses a changed chain without trying another endpoint', async () => {
  let changed = false;
  const ctx = fixture({ urls: ['https://one.invalid', 'https://two.invalid'], onCall: ({ url, method }) => method === 'eth_chainId' ? changed && url.includes('one') ? '0x1' : '0x38' : '0x10' });
  await ctx.rpc.call('eth_blockNumber'); await ctx.rpc.call('eth_blockNumber');
  changed = true;
  await assert.rejects(ctx.rpc.call('eth_sendRawTransaction', ['fixture-signed-data'], { broadcast: true }), /BNB 主网 56/);
  assert.equal(ctx.count('eth_chainId'), 3);
  assert.equal(ctx.count('eth_sendRawTransaction'), 0);
  assert.equal(ctx.calls.at(-1).url, 'https://one.invalid');
});

test('a failed broadcast response is never replayed, including when the caller omits the broadcast flag', async () => {
  const ctx = fixture({ urls: ['https://one.invalid', 'https://two.invalid'], onCall: ({ method }) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_sendRawTransaction') throw new Error('fixture response lost after submission');
    return '0x10';
  } });
  await ctx.rpc.call('eth_blockNumber'); await ctx.rpc.call('eth_blockNumber');
  await assert.rejects(ctx.rpc.call('eth_sendRawTransaction', ['fixture-signed-data']), /全部失败/);
  assert.equal(ctx.count('eth_sendRawTransaction'), 1);
  assert.equal(ctx.count('eth_chainId'), 3);
  assert.equal(ctx.calls.at(-1).url, 'https://one.invalid');
});

test('broadcast cannot borrow a read identity check that is still in flight', async () => {
  let release, checks = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = fixture({ onCall: async ({ method }) => {
    if (method === 'eth_chainId') { if (++checks === 1) await pending; return '0x38'; }
    return method === 'eth_sendRawTransaction' ? 'fixture-hash' : '0x10';
  } });
  const read = ctx.rpc.call('eth_blockNumber');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await ctx.rpc.call('eth_sendRawTransaction', ['fixture-signed-data'], { broadcast: true }), 'fixture-hash');
  assert.equal(checks, 2);
  release(); await read;
  assert.equal(ctx.count('eth_sendRawTransaction'), 1);
});

test('Solana reads cache its mainnet genesis only, and sendTransaction always rechecks it', async () => {
  let wrong = false;
  const ctx = fixture({ chain: 'solana', onCall: ({ method }) => method === 'getGenesisHash' ? wrong ? 'fixture-wrong-genesis' : GENESIS : { value: 10 } });
  await ctx.rpc.call('getBalance', ['fixture-owner']); await ctx.rpc.call('simulateTransaction', ['fixture-unsigned', { sigVerify: false }]);
  assert.equal(ctx.count('getGenesisHash'), 1);
  wrong = true;
  await assert.rejects(ctx.rpc.call('sendTransaction', ['fixture-signed'], { broadcast: true }), /Solana 主网/);
  assert.equal(ctx.count('getGenesisHash'), 2);
  assert.equal(ctx.count('sendTransaction'), 0);
});

test('a slow identity response is not given a fresh cache lifetime when it finally returns', async () => {
  let ctx;
  ctx = fixture({ onCall: ({ method }) => { if (method === 'eth_chainId') { ctx.at(120000); return '0x38'; } return '0x10'; } });
  await ctx.rpc.call('eth_blockNumber'); await ctx.rpc.call('eth_blockNumber');
  assert.equal(ctx.count('eth_chainId'), 2);
});

test('a failed concurrent request prevents an older pending identity from repopulating the cache', async () => {
  let release, checks = 0, failBroadcast = true;
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = fixture({ onCall: async ({ method }) => {
    if (method === 'eth_chainId') { if (++checks === 1) await pending; return '0x38'; }
    if (method === 'eth_sendRawTransaction' && failBroadcast) throw new Error('fixture response lost');
    return '0x10';
  } });
  const read = ctx.rpc.call('eth_blockNumber'); await Promise.resolve(); await Promise.resolve();
  await assert.rejects(ctx.rpc.call('eth_sendRawTransaction', ['fixture-data'], { broadcast: true }), /全部失败/);
  release(); await read;
  failBroadcast = false; await ctx.rpc.call('eth_blockNumber');
  assert.equal(checks, 3);
});
