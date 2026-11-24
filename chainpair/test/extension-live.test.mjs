import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, keccak256 } from 'ethers';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { LiveAdapter, verifyPublishedEvmTransaction, validateBrowserSolanaSignature } from '../src/adapters/live.mjs';

const bnbOwner = '0x1111111111111111111111111111111111111111';
const bnbTarget = '0x2222222222222222222222222222222222222222';
const tokenA = '0x3333333333333333333333333333333333333333';
const tokenB = '0x4444444444444444444444444444444444444444';
const hash = '0x' + 'ab'.repeat(32);
const config = { chains: { bnb: { rpcs: [], nativeUsd: 600 }, solana: { rpcs: [], nativeUsd: 150 } }, risk: { reserveBnb: .003, reserveSol: .03, maxBnbGas: .001, maxSolFee: .01 } };
const evmQuote = () => ({ id: 'browser-evm-quote', kind: 'swap', fromChain: 'bnb', toChain: 'bnb', sender: bnbOwner, recipient: bnbOwner,
  fromToken: { address: tokenA, decimals: 18 }, toToken: { address: tokenB, decimals: 18 }, amountInRaw: '500', amountOutRaw: '495', minOutRaw: '490',
  expiresAt: new Date(Date.now() + 60000).toISOString(), tx: { from: bnbOwner, to: bnbTarget, data: '0x12345678', value: '0', gas: '100000', gasPrice: '1000000000' } });
function evmFixture({ published, response, brokerError, mode = 'browser', pendingTimeout = 15000 } = {}) {
  const calls = []; const localWallet = Wallet.createRandom();
  const quote = evmQuote(); if (mode === 'private') quote.sender = quote.recipient = localWallet.address;
  const adapter = new LiveAdapter({ getConfig: () => config, browserTransactionTimeoutMs: pendingTimeout,
    vault: { publicStatus: () => ({ bnb: { address: quote.sender, mode, canSign: true }, solana: {} }), signer: () => { calls.push('local-signer'); if (mode === 'browser') throw new Error('browser must never request private signer'); return localWallet; } },
    browserWallets: { request: async (chain, request) => { calls.push('broker'); assert.equal(chain, 'bnb'); assert.equal(request.kind, 'evmSend'); assert.equal(request.quoteId, quote.id); assert.equal(request.payload.transaction.chainId, '0x38'); if (brokerError) throw brokerError; return response ?? { hash }; } }
  });
  adapter.balances = async () => ({ native: 1, nativeRaw: '1000000000000000000' });
  adapter.balanceRaw = async () => '1000';
  adapter.validateEvmTx = async () => { calls.push('validate-intent'); return { bnbGas: .0001, solFee: 0, feeUsd: .06 }; };
  adapter.assertAllowance = async () => { calls.push('allowance'); };
  adapter.rpc.bnb.call = async (method, params) => {
    calls.push(method);
    if (method === 'eth_call') return '0x';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_sendRawTransaction') return keccak256(params[0]);
    if (method === 'eth_getTransactionByHash') return published === undefined ? { hash, from: quote.sender, to: bnbTarget, input: quote.tx.data, value: '0x0', gas: '0x186a0', gasPrice: '0x3b9aca00', chainId: '0x38' } : published;
    throw new Error('unexpected RPC method');
  };
  adapter.remember(quote); return { adapter, quote, calls };
}

test('browser EVM signing runs all preflight checks, journals returned hash, and never broadcasts twice', async () => {
  const { adapter, quote, calls } = evmFixture();
  const result = await adapter.submit(quote, { onSubmitted: async submitted => { calls.push('journal'); assert.equal(submitted.hash, hash); assert.equal(submitted.signer, 'browser'); } });
  assert.equal(result.hash, hash);
  assert.deepEqual(calls, ['validate-intent', 'allowance', 'eth_call', 'broker', 'journal', 'eth_getTransactionByHash']);
  await assert.rejects(adapter.submit(quote), /禁止重复发送/);
  assert.equal(calls.filter(x => x === 'broker').length, 1);
});

test('browser EVM user rejection consumes the request without server broadcast or private signer access', async () => {
  const rejection = Object.assign(new Error('用户拒绝插件确认'), { safe: true });
  const { adapter, quote, calls } = evmFixture({ brokerError: rejection });
  await assert.rejects(adapter.submit(quote), error => error === rejection);
  assert.equal(adapter.used.has(quote.id), true);
  assert.equal(calls.includes('eth_sendRawTransaction'), false);
  assert.equal(calls.includes('local-signer'), false);
});

test('browser EVM pending lookup timeout preserves the already-journaled hash and does not resend', async () => {
  const { adapter, quote, calls } = evmFixture({ published: null, pendingTimeout: 1 });
  let journal;
  await assert.rejects(adapter.submit(quote, { onSubmitted: async sent => { journal = sent; } }), error => error.safe && error.hash === hash && /禁止重发/.test(error.message));
  assert.equal(journal.hash, hash);
  assert.equal(calls.filter(x => x === 'broker').length, 1);
  assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('browser EVM mismatched onchain transaction preserves hash evidence and pauses before confirmation', async () => {
  const { adapter, quote } = evmFixture({ published: { hash, from: bnbOwner, to: bnbTarget, input: '0xdeadbeef', value: '0x0', gas: '0x186a0', gasPrice: '0x3b9aca00' } });
  let journaled = false;
  await assert.rejects(adapter.submit(quote, { onSubmitted: async () => { journaled = true; } }), error => error.safe && error.sourceHash === hash);
  assert.equal(journaled, true);
});

const expected = { from: bnbOwner, to: bnbTarget, data: '0x12345678', value: '0x0', gas: '0x186a0', gasPrice: '0x3b9aca00', chainId: '0x38' };
const published = { ...expected, input: expected.data, hash };
for (const [label, patch] of Object.entries({ sender: { from: bnbTarget }, calldata: { input: '0x1234' }, value: { value: '0x1' }, gas: { gas: '0x186a1' }, gasPrice: { gasPrice: '0x3b9aca01' }, chain: { chainId: '0x1' } })) {
  test(`published browser transaction rejects changed ${label}`, () => assert.throws(() => verifyPublishedEvmTransaction(expected, { ...published, ...patch }, hash)));
}

test('local EVM signing still journals deterministic hash before RPC broadcast', async () => {
  const { adapter, quote, calls } = evmFixture({ mode: 'private' });
  const result = await adapter.submit(quote, { onSubmitted: async () => { calls.push('journal'); } });
  assert.match(result.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(calls.includes('broker'), false);
  assert(calls.indexOf('journal') < calls.indexOf('eth_sendRawTransaction'));
});

const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const solMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function solTransaction(keypair, lamports = 0) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports })] }).compileToV0Message());
}
function splAccount(owner, amount) {
  const bytes = Buffer.alloc(165);
  new PublicKey(solMint).toBuffer().copy(bytes); new PublicKey(owner).toBuffer().copy(bytes, 32); bytes.writeBigUInt64LE(BigInt(amount), 64); bytes[108] = 1;
  return { owner: tokenProgram, data: [bytes.toString('base64'), 'base64'] };
}

test('Solana browser signature must be cryptographically valid over the exact original message', () => {
  const keypair = Keypair.generate(), original = solTransaction(keypair);
  const signed = VersionedTransaction.deserialize(original.serialize()); signed.sign([keypair]);
  const encoded = Buffer.from(signed.serialize()).toString('base64');
  assert.deepEqual(validateBrowserSolanaSignature(encoded, original, keypair.publicKey.toBase58()).serialize(), signed.serialize());
  const zeroed = VersionedTransaction.deserialize(original.serialize());
  assert.throws(() => validateBrowserSolanaSignature(Buffer.from(zeroed.serialize()).toString('base64'), original, keypair.publicKey.toBase58()));
  const altered = solTransaction(keypair, 1); altered.sign([keypair]);
  assert.throws(() => validateBrowserSolanaSignature(Buffer.from(altered.serialize()).toString('base64'), original, keypair.publicKey.toBase58()));
  assert.throws(() => validateBrowserSolanaSignature(encoded, original, Keypair.generate().publicKey.toBase58()));
});

function solFixture({ corrupt = false, expireWhileSigning = false, mode = 'browser' } = {}) {
  const keypair = Keypair.generate(), original = solTransaction(keypair), sender = keypair.publicKey.toBase58();
  const calls = []; const quote = { id: 'browser-sol-quote', kind: 'bridge', fromChain: 'solana', toChain: 'bnb', sender, recipient: bnbOwner,
    fromToken: { address: solMint, decimals: 6 }, toToken: { address: tokenA, decimals: 18 }, amountInRaw: '500', amountOutRaw: '495', minOutRaw: '490',
    expiresAt: new Date(Date.now() + 60000).toISOString(), tx: { data: bs58.encode(original.serialize()) } };
  const adapter = new LiveAdapter({ getConfig: () => config,
    vault: { publicStatus: () => ({ solana: { address: sender, mode, canSign: true }, bnb: { address: bnbOwner, mode: 'readonly' } }), signer: () => { if (mode !== 'private') throw new Error('private signer should not be called'); calls.push('local-signer'); return keypair; } },
    browserWallets: { request: async (chain, request) => {
      calls.push('broker'); assert.equal(chain, 'solana'); assert.equal(request.kind, 'solSign'); assert.equal(request.payload.sender, sender);
      const signed = corrupt ? solTransaction(keypair, 1) : VersionedTransaction.deserialize(Buffer.from(request.payload.transactionBase64, 'base64'));
      signed.sign([keypair]);
      if (expireWhileSigning) await new Promise(resolve => setTimeout(resolve, 25));
      return { signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64') };
    } }
  });
  adapter.balances = async () => ({ native: 1, nativeRaw: '1000000000' });
  adapter.balanceRaw = async () => '1000';
  adapter.validateSolanaTx = async () => { calls.push('validate-intent'); return { bnbGas: 0, solFee: .00002, feeUsd: .003 }; };
  adapter.rpc.solana.call = async (method, params) => {
    calls.push(method);
    if (method === 'getTokenAccountsByOwner') return { value: [{ pubkey: Keypair.generate().publicKey.toBase58(), account: splAccount(sender, 1000) }] };
    if (method === 'simulateTransaction') return { value: { err: null, accounts: [{ lamports: 999990000 }, splAccount(sender, 500)] } };
    if (method === 'sendTransaction') {
      assert(calls.includes('journal')); const signed = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64')); return bs58.encode(signed.signatures[0]);
    }
    throw new Error('unexpected RPC method');
  };
  adapter.remember(quote); return { adapter, quote, calls };
}

test('browser Solana signed bytes undergo holdings simulation and deterministic journaling before the sole broadcast', async () => {
  const { adapter, quote, calls } = solFixture();
  const submission = await adapter.submit(quote, { onSubmitted: async sent => { calls.push('journal'); assert.match(sent.hash, /^[1-9A-HJ-NP-Za-km-z]+$/); } });
  assert.equal(submission.broadcastState, 'sent');
  assert.deepEqual(calls, ['validate-intent', 'broker', 'getTokenAccountsByOwner', 'simulateTransaction', 'journal', 'sendTransaction']);
  await assert.rejects(adapter.submit(quote), /禁止重复发送/);
});

test('tampered browser Solana bytes are refused before any RPC simulation or broadcast', async () => {
  const { adapter, quote, calls } = solFixture({ corrupt: true });
  await assert.rejects(adapter.submit(quote), error => error.safe && /签名/.test(error.message));
  assert.equal(calls.includes('sendTransaction'), false);
  assert.equal(calls.includes('simulateTransaction'), false);
});

test('Solana quote expiring in the extension is not broadcast after signing returns', async () => {
  const { adapter, quote, calls } = solFixture({ expireWhileSigning: true });
  quote.expiresAt = new Date(Date.now() + 15).toISOString(); adapter.remember(quote);
  await assert.rejects(adapter.submit(quote), error => error.safe && /报价已过期/.test(error.message));
  assert.equal(calls.includes('sendTransaction'), false);
});

test('local BNB expiry during nonce retrieval prevents private signing and broadcast', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { adapter, quote, calls } = evmFixture({ mode: 'private' });
  adapter.vault.signer = () => ({ signTransaction: async () => { calls.push('private-sign'); throw new Error('expired transaction must not be signed'); } });
  const original = adapter.rpc.bnb.call;
  adapter.rpc.bnb.call = async (method, params) => { const result = await original(method, params); if (method === 'eth_getTransactionCount') t.mock.timers.tick(60001); return result; };
  await assert.rejects(adapter.submit(quote, { onSubmitted: async () => { calls.push('journal'); } }), /报价已过期/);
  assert.equal(calls.includes('private-sign'), false); assert.equal(calls.includes('journal'), false);
  assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('local BNB expiry during asynchronous signing prevents journaling and broadcast', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { adapter, quote, calls } = evmFixture({ mode: 'private' });
  const getSigner = adapter.vault.signer;
  adapter.vault.signer = () => { const signer = getSigner(); return { signTransaction: async request => { const signed = await signer.signTransaction(request); calls.push('private-sign'); t.mock.timers.tick(60001); return signed; } }; };
  await assert.rejects(adapter.submit(quote, { onSubmitted: async () => { calls.push('journal'); } }), /报价已过期/);
  assert.equal(calls.includes('private-sign'), true); assert.equal(calls.includes('journal'), false);
  assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('quote expiry while persisting deterministic submission consumes the quote without broadcasting', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { adapter, quote, calls } = evmFixture({ mode: 'private' }); let journal;
  await assert.rejects(adapter.submit(quote, { onSubmitted: async sent => { journal = sent; t.mock.timers.tick(60001); } }), /报价已过期/);
  assert.equal(journal.broadcastState, 'prepared'); assert.match(journal.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(adapter.used.has(quote.id), true); assert.equal(calls.includes('eth_sendRawTransaction'), false);
  await assert.rejects(adapter.submit(quote)); assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('whole-plan callback can veto BNB after asynchronous preflight before any private signature', async () => {
  const { adapter, quote, calls } = evmFixture({ mode: 'private' }); let wholePlanValid = true;
  adapter.vault.signer = () => ({ signTransaction: async () => { calls.push('private-sign'); throw new Error('invalid whole plan must not be signed'); } });
  const original = adapter.rpc.bnb.call;
  adapter.rpc.bnb.call = async (method, params) => { const result = await original(method, params); if (method === 'eth_getTransactionCount') wholePlanValid = false; return result; };
  await assert.rejects(adapter.submit(quote, { beforeBroadcast: () => { if (!wholePlanValid) throw Object.assign(new Error('SELL quote expired'), { safe: true }); } }), /SELL quote expired/);
  assert.equal(calls.includes('private-sign'), false); assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('browser BNB expiry during preflight prevents requesting a signing popup', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { adapter, quote, calls } = evmFixture();
  const original = adapter.rpc.bnb.call;
  adapter.rpc.bnb.call = async (method, params) => { const result = await original(method, params); if (method === 'eth_call') t.mock.timers.tick(60001); return result; };
  await assert.rejects(adapter.submit(quote), /报价已过期/);
  assert.equal(calls.includes('broker'), false); assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('local Solana expiry during input-balance check prevents private key use', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { adapter, quote, calls } = solFixture({ mode: 'private' });
  const getSigner = adapter.vault.signer;
  adapter.vault.signer = () => { const signer = getSigner(); return { publicKey: signer.publicKey, get secretKey() { calls.push('private-sign'); return signer.secretKey; } }; };
  adapter.balanceRaw = async () => { t.mock.timers.tick(60001); return '1000'; };
  await assert.rejects(adapter.submit(quote), /报价已过期/);
  assert.equal(calls.includes('private-sign'), false); assert.equal(calls.includes('simulateTransaction'), false);
  assert.equal(calls.includes('sendTransaction'), false);
});

test('local Solana expiry during signed simulation prevents journaling and broadcast', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { adapter, quote, calls } = solFixture({ mode: 'private' });
  const original = adapter.rpc.solana.call;
  adapter.rpc.solana.call = async (method, params) => { const result = await original(method, params); if (method === 'simulateTransaction') t.mock.timers.tick(60001); return result; };
  await assert.rejects(adapter.submit(quote, { onSubmitted: async () => { calls.push('journal'); } }), /报价已过期/);
  assert.equal(calls.includes('simulateTransaction'), true); assert.equal(calls.includes('journal'), false);
  assert.equal(calls.includes('sendTransaction'), false);
});
