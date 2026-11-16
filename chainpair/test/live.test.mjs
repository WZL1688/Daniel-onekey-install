import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { RpcPool } from '../src/adapters/rpc.mjs';
import { LiveAdapter, tokenNetFromEvmReceipt, tokenNetFromSolanaReceipt, validateDlnBridgeIntent, validateSolanaSimulationTokens } from '../src/adapters/live.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const solOwner = '11111111111111111111111111111111';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const response = result => ({ ok: true, json: async () => ({ result }) });

test('RPC rotates failed endpoints and rejects the wrong chain before a read', async () => {
  const calls = [];
  const rpc = new RpcPool({ chain: 'bnb', getUrls: () => ['https://wrong.test', 'https://ok.test'], fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); calls.push([url, request.method]);
    return response(request.method === 'eth_chainId' ? (url.includes('wrong') ? '0x1' : '0x38') : '0x123');
  } });
  assert.equal(await rpc.call('eth_blockNumber'), '0x123');
  assert.deepEqual(calls, [['https://wrong.test', 'eth_chainId'], ['https://ok.test', 'eth_chainId'], ['https://ok.test', 'eth_blockNumber']]);
});
test('RPC broadcast is never replayed to another endpoint after an uncertain response', async () => {
  const calls = [];
  const rpc = new RpcPool({ chain: 'bnb', getUrls: () => ['https://a.test', 'https://b.test'], fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); calls.push(request.method);
    if (request.method === 'eth_chainId') return response('0x38');
    throw new Error('socket lost after acceptance');
  } });
  await assert.rejects(rpc.call('eth_sendRawTransaction', ['0x123'], { broadcast: true }));
  assert.deepEqual(calls, ['eth_chainId', 'eth_sendRawTransaction']);
});
test('EVM actual receipt counts only selected token transfers involving this owner', () => {
  const iface = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log = (address, from, to, value) => ({ address, ...iface.encodeEventLog('Transfer', [from, to, value]) });
  const receipt = { logs: [log(token, other, owner, 100n), log(token, owner, other, 4n), log(other, other, owner, 50000n), log(token, other, other, 900n)] };
  assert.equal(tokenNetFromEvmReceipt(receipt, token, owner), 96n);
});
test('Solana actual receipt counts exact raw mint amount only for this owner', () => {
  const row = (mint, owner, amount) => ({ mint, owner, uiTokenAmount: { amount } });
  const receipt = { meta: { err: null, preTokenBalances: [row(mint, solOwner, '9007199254740993000')], postTokenBalances: [row(mint, solOwner, '9007199254740993007'), row(mint, 'other', '999999')] } };
  assert.equal(tokenNetFromSolanaReceipt(receipt, mint, solOwner), 7n);
  assert.throws(() => tokenNetFromSolanaReceipt({ meta: { err: { InstructionError: [0, 'bad'] } } }, mint, solOwner));
});

const orderCreation = '(address giveTokenAddress,uint256 giveAmount,bytes takeTokenAddress,uint256 takeAmount,uint256 takeChainId,bytes receiverDst,address givePatchAuthoritySrc,bytes orderAuthorityAddressDst,bytes allowedTakerDst,bytes externalCall,bytes allowedCancelBeneficiarySrc)';
const dln = new Interface([`function createOrder(${orderCreation} order,bytes affiliateFee,uint32 referralCode,bytes permitEnvelope) payable returns(bytes32)`]);
const hexSol = address => `0x${Buffer.from(new PublicKey(address).toBytes()).toString('hex')}`;
const dlnQuote = { kind: 'bridge', fromChain: 'bnb', toChain: 'solana', fromToken: { address: token, decimals: 18 }, toToken: { address: mint, decimals: 6 }, sender: owner, recipient: solOwner, amountInRaw: '5000', minOutRaw: '4900' };
const order = { giveTokenAddress: token, giveAmount: 5000n, takeTokenAddress: hexSol(mint), takeAmount: 4950n, takeChainId: 7565164n, receiverDst: hexSol(solOwner), givePatchAuthoritySrc: owner, orderAuthorityAddressDst: hexSol(solOwner), allowedTakerDst: '0x', externalCall: '0x', allowedCancelBeneficiarySrc: '0x' };
const dlnTx = changes => ({ to: '0xef4fb24ad0916217251f553c0596f8edc630eb66', value: '100', data: dln.encodeFunctionData('createOrder', [{ ...order, ...changes }, '0x', 0, '0x']) });
test('reviewed deBridge DLN decoder permits BNB to Solana direct createOrder', () => {
  assert.equal(validateDlnBridgeIntent(dlnQuote, dlnTx()).takeAmount, '4950');
});
for (const [label, changes] of Object.entries({ 'wrong destination chain': { takeChainId: 1n }, 'wrong mint': { takeTokenAddress: hexSol(solOwner) }, 'excess input': { giveAmount: 5001n }, 'below minimum': { takeAmount: 4899n }, 'external call': { externalCall: '0x1234' }, 'wrong patch authority': { givePatchAuthoritySrc: other } })) {
  test(`deBridge decoder blocks ${label}`, () => assert.throws(() => validateDlnBridgeIntent(dlnQuote, dlnTx(changes))));
}
test('unknown bridge calldata is blocked before signing', () => assert.throws(() => validateDlnBridgeIntent(dlnQuote, { to: other, data: '0x1234' })));

test('BNB fee estimate includes native protocol fee in risk and USD totals', async () => {
  const adapter = new LiveAdapter({ getConfig: () => ({ chains: { bnb: { nativeUsd: 600, rpcs: [] } }, risk: {} }), vault: {} });
  const fee = await adapter.estimateFee('bnb', { gasLimit: '100000', gasPrice: '1000000000', value: '200000000000000' });
  assert.equal(fee.bnbGas, 0.0003); assert.equal(fee.feeUsd, 0.18);
});
test('API signing never includes credentials in query and rejects null credentials safely', async () => {
  const adapter = new LiveAdapter({ getConfig: () => ({ chains: {}, okx: {} }), vault: { getOkxCredentials: () => null } });
  await assert.rejects(adapter.okx('/api/v6/dex/aggregator/quote'), error => error.safe === true && /凭据/.test(error.message));
});
const spl = (mintAddress, amount, delegated = false) => {
  const bytes = Buffer.alloc(165); Buffer.from(new PublicKey(mintAddress).toBytes()).copy(bytes, 0); Buffer.from(new PublicKey(solOwner).toBytes()).copy(bytes, 32); bytes.writeBigUInt64LE(BigInt(amount), 64); bytes[108] = 1;
  if (delegated) bytes[72] = 1;
  return { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [bytes.toString('base64'), 'base64'] };
};
const outputMint = 'So11111111111111111111111111111111111111112';
const simulationQuote = { kind: 'swap', sender: solOwner, fromToken: { address: mint }, toToken: { address: outputMint }, amountInRaw: '500', minOutRaw: '490' };
test('Solana preflight verifies exact input, new ATA output and unchanged unrelated holdings', () => {
  assert.doesNotThrow(() => validateSolanaSimulationTokens({ quote: simulationQuote, beforeAccounts: [spl(mint, 1000), null], afterAccounts: [spl(mint, 500), spl(outputMint, 495)] }));
});
test('Solana preflight rejects excess debit before signing', () => {
  assert.throws(() => validateSolanaSimulationTokens({ quote: simulationQuote, beforeAccounts: [spl(mint, 1000), null], afterAccounts: [spl(mint, 499), spl(outputMint, 495)] }));
});
test('Solana preflight rejects delegated authority changes', () => {
  assert.throws(() => validateSolanaSimulationTokens({ quote: simulationQuote, beforeAccounts: [spl(mint, 1000), null], afterAccounts: [spl(mint, 500, true), spl(outputMint, 495)] }));
});
test('Solana preflight rejects below-minimum simulated output', () => {
  assert.throws(() => validateSolanaSimulationTokens({ quote: simulationQuote, beforeAccounts: [spl(mint, 1000), null], afterAccounts: [spl(mint, 500), spl(outputMint, 489)] }));
});
test('Solana preflight rejects spending unquoted mint', () => {
  assert.throws(() => validateSolanaSimulationTokens({ quote: { ...simulationQuote, kind: 'bridge' }, beforeAccounts: [spl(mint, 1000), spl(outputMint, 900)], afterAccounts: [spl(mint, 500), spl(outputMint, 899)] }));
});
test('Solana quote includes missing ATA rent in conservative USD and native cap', async () => {
  const adapter = new LiveAdapter({ getConfig: () => ({ chains: { solana: { nativeUsd: 150, rpcs: [] } }, risk: {} }), vault: {} });
  adapter.decodeSolana = () => ({ message: { serialize: () => new Uint8Array([1]) } });
  adapter.solanaKeys = async () => ({ payerKey: new PublicKey(solOwner), instructions: [{ programId: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), keys: [{ pubkey: new PublicKey(solOwner) }, { pubkey: new PublicKey(mint) }] }] });
  adapter.rpc.solana.call = async method => method === 'getFeeForMessage' ? { value: 5000 } : method === 'getMinimumBalanceForRentExemption' ? 2039280 : { value: null };
  const quote = await adapter.estimateFee('solana', { data: 'mock' });
  assert.equal(quote.solFee, 0.00204428); assert.equal(quote.feeUsd, 0.306642); assert.equal(quote.estimatedRentUsd, 0.305892);
});
test('known reverted chain receipt remains attached for persistent failure evidence', async () => {
  const adapter = new LiveAdapter({ getConfig: () => ({ chains: { bnb: { rpcs: [] } } }), vault: {} });
  adapter.rpc.bnb.call = async () => ({ status: '0x0', transactionHash: '0xknown' });
  await assert.rejects(adapter.receipt('bnb', '0xknown'), error => error.safe && error.hash === '0xknown' && error.receipt.status === '0x0');
});
