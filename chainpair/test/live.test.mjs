import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
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

function timedQuoteFixture(t, { ttlMs = 5000, requestMs = 400 } = {}) {
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start });
  const config = { quoteTtlMs: ttlMs, chains: { bnb: { rpcs: [], nativeUsd: 600 }, solana: { rpcs: [], nativeUsd: 150 } }, risk: { maxSlippageBps: 50, maxPriceImpactBps: 100 } };
  const calls = [], fromToken = { address: token, decimals: 18 }, toToken = { address: other, decimals: 18 };
  const adapter = new LiveAdapter({ getConfig: () => config, vault: {
    publicStatus: () => ({ bnb: { address: owner, mode: 'readonly' }, solana: { address: solOwner, mode: 'readonly' } }),
    signer: () => { throw new Error('quote must not request a signer'); }
  }, fetchImpl: async () => { throw new Error('tests forbid real network access'); } });
  adapter.validateToken = async () => {};
  adapter.okx = async endpoint => {
    calls.push(endpoint); t.mock.timers.tick(requestMs);
    if (endpoint.endsWith('/aggregator/swap')) return { routerResult: { chainIndex: '56', fromToken: { tokenContractAddress: token, tokenUnitPrice: '1' }, toToken: { tokenContractAddress: other, tokenUnitPrice: '1' }, fromTokenAmount: '1000', toTokenAmount: '990', priceImpactPercent: '0.1' }, tx: {} };
    if (endpoint.endsWith('/cross-chain/quote')) return { fromChainIndex: '56', toChainIndex: '501', fromToken: { tokenContractAddress: token }, toToken: { tokenContractAddress: mint }, fromTokenAmount: '1000', routerList: [{ bridgeId: '1', bridgeName: 'debridge', toTokenAmount: '990', priceImpactPercentage: '0.1' }] };
    if (endpoint.endsWith('/cross-chain/swap')) return { tx: {}, router: { bridgeId: '1' }, fromTokenAmount: '1000', toTokenAmount: '990', minimumReceived: '985' };
    throw new Error('unexpected endpoint');
  };
  adapter.estimateFee = async () => { t.mock.timers.tick(200); return { feeUsd: .006, bnbGas: .00001, solFee: 0, estimatedRentUsd: 0 }; };
  adapter.validateEvmTx = async () => { t.mock.timers.tick(100); };
  adapter.assertAllowance = async () => { t.mock.timers.tick(100); };
  return { adapter, start, calls, fromToken, toToken };
}

test('swap quote timing starts before its HTTP request and includes validation latency in the original TTL', async t => {
  const { adapter, start, fromToken, toToken } = timedQuoteFixture(t);
  const quote = await adapter.quoteSwap({ chain: 'bnb', fromToken, toToken, amountRaw: '1000' });
  assert.equal(Date.parse(quote.requestedAt), start);
  assert.equal(Date.parse(quote.receivedAt), start + 400);
  assert.equal(Date.parse(quote.validatedAt), start + 800);
  assert.equal(Date.parse(quote.expiresAt), start + 5000);
  assert.equal(Date.parse(quote.expiresAt) - Date.now(), 4200);
});

test('bridge quote TTL includes both the route request and transaction construction', async t => {
  const { adapter, start, calls, fromToken } = timedQuoteFixture(t);
  const quote = await adapter.quoteTokenBridge({ fromChain: 'bnb', toChain: 'solana', fromToken, toToken: { address: mint, decimals: 6 }, amountRaw: '1000' });
  assert.deepEqual(calls, ['/api/v6/dex/cross-chain/quote', '/api/v6/dex/cross-chain/swap']);
  assert.equal(Date.parse(quote.requestedAt), start);
  assert.equal(Date.parse(quote.receivedAt), start + 800);
  assert.equal(Date.parse(quote.validatedAt), start + 1200);
  assert.equal(Date.parse(quote.expiresAt), start + 5000);
});

for (const kind of ['swap', 'bridge']) test(`${kind} response that expires during network and validation is never remembered`, async t => {
  const { adapter, fromToken, toToken } = timedQuoteFixture(t, { ttlMs: 1000, requestMs: 800 });
  const pending = kind === 'swap'
    ? adapter.quoteSwap({ chain: 'bnb', fromToken, toToken, amountRaw: '1000' })
    : adapter.quoteTokenBridge({ fromChain: 'bnb', toChain: 'solana', fromToken, toToken: { address: mint, decimals: 6 }, amountRaw: '1000' });
  await assert.rejects(pending, /报价已过期/);
  assert.equal(adapter.quotes.size, 0);
});

const reviewedSwap = new Interface(['function dagSwapTo(uint256 orderId,address receiver,(uint256 fromToken,address toToken,uint256 fromTokenAmount,uint256 minReturnAmount,uint256 deadLine) baseRequest,(address[] mixAdapters,address[] assetTo,uint256[] rawData,bytes[] extraData,uint256 fromToken)[] paths) payable returns(uint256)']);
const erc20Reads = new Interface(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)', 'function decimals() view returns(uint8)']);
function unsignedEvmFixture({ allowance = 1000n, swapOutput = 495n, gas = 90000n, result, failMethod, nativeBalance = '1000000000000000000', tokenBalance = 1000n } = {}) {
  const config = { quoteTtlMs: 20000, chains: { bnb: { rpcs: [], nativeUsd: 600, stableAddress: token, stableDecimals: 18, tokenAddress: other, tokenDecimals: 18, routerAllowlist: [owner] }, solana: { rpcs: [], nativeUsd: 150 } }, risk: { maxSlippageBps: 50, maxPriceImpactBps: 100, maxBnbGas: .001, maxSolFee: .01, reserveBnb: .003, reserveSol: .03 } };
  const calls = [], quote = { id: 'unsigned-evm', kind: 'swap', fromChain: 'bnb', toChain: 'bnb', sender: owner, recipient: owner,
    fromToken: { address: token, decimals: 18 }, toToken: { address: other, decimals: 18 }, amountInRaw: '500', amountOutRaw: '495', minOutRaw: '490',
    expiresAt: new Date(Date.now() + 20000).toISOString(), tx: { from: owner, to: owner, chainId: '56', gas: '100000', gasPrice: '1000000000', value: '0', data: reviewedSwap.encodeFunctionData('dagSwapTo', [1n, owner, [BigInt(token), other, 500n, 490n, BigInt(Math.floor(Date.now() / 1000) + 600)], []]) } };
  const adapter = new LiveAdapter({ getConfig: () => config, vault: { publicStatus: () => ({ bnb: { address: owner, mode: 'readonly', canSign: false } }), signer: () => { calls.push('signer'); throw new Error('forbidden signer'); } }, browserWallets: { request: () => { calls.push('browser'); throw new Error('forbidden browser request'); } }, fetchImpl: async () => { throw new Error('forbidden network'); } });
  adapter.okx = async path => { calls.push(path); return { dexContractAddress: owner }; };
  adapter.rpc.bnb.call = async (method, params) => {
    calls.push(method);
    if (method === failMethod && (method !== 'eth_call' || params[1] === 'pending')) throw new Error('RPC details containing a private URL must not escape');
    if (method === 'eth_getBalance') return '0x' + BigInt(nativeBalance).toString(16);
    if (method === 'eth_estimateGas') { assert.equal(params[0].gas, '0x186a0'); assert.equal(params[0].gasPrice, '0x3b9aca00'); return '0x' + gas.toString(16); }
    if (method === 'eth_call') {
      if (params[1] === 'pending') { assert.equal(params[0].gas, '0x186a0'); assert.equal(params[0].from, owner); assert.equal(params[0].to, quote.tx.to); assert.equal(params[0].data, quote.tx.data); assert.equal(params[0].value, '0x0'); return result ?? reviewedSwap.encodeFunctionResult('dagSwapTo', [swapOutput]); }
      const call = erc20Reads.parseTransaction({ data: params[0].data });
      return erc20Reads.encodeFunctionResult(call.name, [call.name === 'allowance' ? allowance : call.name === 'decimals' ? 18 : tokenBalance]);
    }
    throw new Error('Unexpected RPC: ' + method);
  };
  adapter.remember(quote);
  return { adapter, quote, calls, config };
}

test('readonly EVM preflight uses frozen gas and uint ABI minimum output without signer, popup or broadcast', async () => {
  const { adapter, quote, calls } = unsignedEvmFixture();
  const report = await adapter.preflightSwap(quote);
  assert.equal(report.verified, true); assert.equal(report.readOnly, true); assert.equal(report.outputVerified, true);
  assert.equal(report.onChainMinimumDecoded, true); assert.deepEqual(report.limitations, []);
  assert.equal(report.simulatedOutRaw, '495'); assert.equal(report.estimatedGas, '90000');
  assert(calls.includes('eth_estimateGas')); assert(calls.includes('/api/v6/dex/aggregator/approve-transaction'));
  assert(!calls.some(method => ['signer', 'browser', 'eth_sendRawTransaction', 'sendTransaction'].includes(method)));
  assert.equal(adapter.used.size, 0);
  assert(!JSON.stringify(report).includes(quote.tx.data)); assert(!JSON.stringify(report).includes(owner));
});
for (const [label, options, pattern] of [
  ['allowance missing', { allowance: 0n }, /APPROVAL_REQUIRED/],
  ['input holdings missing', { tokenBalance: 499n }, /余额不足/],
  ['gas reserve missing', { nativeBalance: '3000000000000000' }, /Gas/],
  ['pending call reverts', { failMethod: 'eth_call' }, /未签名交易模拟失败/],
  ['RPC estimate unsupported', { failMethod: 'eth_estimateGas' }, /未签名交易模拟失败/],
  ['gas demand exceeds frozen quote', { gas: 100001n }, /Gas.*上限/],
  ['minimum output not met', { swapOutput: 489n }, /输出低于最低到账/],
  ['missing ABI output', { result: '0x' }, /未返回.*到账数量/]
]) test(`readonly EVM preflight blocks ${label}`, async () => {
  const { adapter, quote, calls } = unsignedEvmFixture(options);
  await assert.rejects(adapter.preflightSwap(quote), pattern);
  assert(!calls.some(method => ['signer', 'browser', 'eth_sendRawTransaction'].includes(method)));
});
test('preflight refuses modified, consumed, expired quotes and changed public wallets', async () => {
  const { adapter, quote } = unsignedEvmFixture();
  await assert.rejects(adapter.preflightSwap({ ...quote, amountInRaw: '501' }), /已被修改/);
  adapter.used.add(quote.id); await assert.rejects(adapter.preflightSwap(quote), /已提交/); adapter.used.clear();
  adapter.vault.publicStatus = () => ({ bnb: { address: other } }); await assert.rejects(adapter.preflightSwap(quote), /钱包已变更/);
  adapter.vault.publicStatus = () => ({ bnb: { address: owner } }); quote.expiresAt = new Date(Date.now() - 1).toISOString(); adapter.remember(quote);
  await assert.rejects(adapter.preflightSwap(quote), /已过期/);
});

test('allowanceRequirement returns exact raw amounts and a reviewed nonzero spender without approving', async () => {
  const { adapter, quote, calls } = unsignedEvmFixture({ allowance: 15n });
  assert.deepEqual(await adapter.allowanceRequirement(quote), { chain: 'bnb', tokenAddress: token, spender: owner, owner, requiredRaw: '500', currentRaw: '15', sufficient: false });
  await assert.rejects(adapter.assertAllowance(quote), /APPROVAL_REQUIRED/);
  assert(!calls.includes('eth_sendRawTransaction')); assert(!calls.includes('signer'));
  for (const spender of ['0x' + '0'.repeat(40), 'malformed', other]) {
    adapter.okx = async () => ({ dexContractAddress: spender });
    await assert.rejects(adapter.allowanceRequirement(quote), /spender/);
  }
});

test('allowUnapproved is an explicit quote-only option and never bypasses allowance at preflight or submit', async () => {
  const { adapter, config, calls } = unsignedEvmFixture({ allowance: 0n });
  const q = { chain: 'bnb', fromToken: { address: token, decimals: 18 }, toToken: { address: other, decimals: 18 }, amountRaw: '500' };
  adapter.okx = async path => path.endsWith('/aggregator/swap') ? { routerResult: { chainIndex: '56', fromToken: { tokenContractAddress: token }, toToken: { tokenContractAddress: other }, fromTokenAmount: '500', toTokenAmount: '495', priceImpactPercent: '.1' }, tx: { from: owner, to: owner, chainId: '56', gas: '100000', gasPrice: '1000000000', value: '0', data: reviewedSwap.encodeFunctionData('dagSwapTo', [1n, owner, [BigInt(token), other, 500n, 492n, BigInt(Math.floor(Date.now() / 1000) + 600)], []]) } } : { dexContractAddress: owner };
  await assert.rejects(adapter.quoteSwap(q), /APPROVAL_REQUIRED/);
  const quote = await adapter.quoteSwap({ ...q, allowUnapproved: true });
  assert.equal(quote.approvalRequirement.sufficient, false); assert.equal(quote.approvalRequirement.requiredRaw, '500');
  await assert.rejects(adapter.preflightSwap(quote), /APPROVAL_REQUIRED/);
  adapter.vault.signer = () => { calls.push('private-key-access'); return { signTransaction: () => { calls.push('private-sign'); throw new Error('forbidden'); } }; };
  adapter.vault.publicStatus = () => ({ bnb: { address: owner, mode: 'private', canSign: true } });
  await assert.rejects(adapter.submit(quote), /APPROVAL_REQUIRED/);
  assert(!calls.includes('private-key-access')); assert(!calls.includes('private-sign')); assert(!calls.includes('eth_sendRawTransaction'));
  assert.equal(config.risk.maxBnbGas, .001);
});

function unsignedSolFixture({ output = 495n, inputSpent = 500n, nativeDebit = 5000, simulationError = null, beforeDelegated = false, afterDelegated = false, extraDebit = false, accountsMissing = false, signed = false } = {}) {
  const key = Keypair.generate(), sender = key.publicKey.toBase58(), inputAccount = Keypair.generate().publicKey.toBase58(), unrelatedMint = Keypair.generate().publicKey.toBase58(), unrelatedAccount = Keypair.generate().publicKey.toBase58();
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: key.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 0 })] }).compileToV0Message());
  if (signed) transaction.sign([key]);
  const account = (mintAddress, amount, delegated = false) => { const b = Buffer.alloc(165); new PublicKey(mintAddress).toBuffer().copy(b); key.publicKey.toBuffer().copy(b, 32); b.writeBigUInt64LE(BigInt(amount), 64); b[108] = 1; if (delegated) b[72] = 1; return { owner: tokenProgram, data: [b.toString('base64'), 'base64'] }; };
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const config = { chains: { bnb: { rpcs: [], nativeUsd: 600 }, solana: { rpcs: [], nativeUsd: 150, stableAddress: mint, stableDecimals: 6, tokenAddress: outputMint, tokenDecimals: 9, programAllowlist: ['11111111111111111111111111111111'] } }, risk: { reserveSol: .03, maxSolFee: .01, maxBnbGas: .001 } };
  const calls = [], quote = { id: 'unsigned-sol', kind: 'swap', fromChain: 'solana', toChain: 'solana', sender, recipient: sender, fromToken: { address: mint, decimals: 6 }, toToken: { address: outputMint, decimals: 9 }, amountInRaw: '500', amountOutRaw: '495', minOutRaw: '490', expiresAt: new Date(Date.now() + 20000).toISOString(), tx: { data: bs58.encode(transaction.serialize()) } };
  const adapter = new LiveAdapter({ getConfig: () => config, vault: { publicStatus: () => ({ solana: { address: sender, mode: 'readonly', canSign: false } }), signer: () => { calls.push('signer'); throw new Error('forbidden signer'); } }, browserWallets: { request: () => { calls.push('browser'); throw new Error('forbidden popup'); } }, fetchImpl: async () => { throw new Error('forbidden network'); } });
  adapter.rpc.solana.call = async (method, params) => {
    calls.push(method);
    if (method === 'getBalance') return { value: 1000000000 };
    if (method === 'getFeeForMessage') return { value: 5000 };
    if (method === 'getAccountInfo') return { value: null };
    if (method === 'getTokenAccountsByOwner') {
      if (params[2].encoding === 'jsonParsed') return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: params[1].mint === mint ? '1000' : '0' } } } } } }] };
      return { value: [{ pubkey: inputAccount, account: account(mint, 1000n, beforeDelegated) }, { pubkey: unrelatedAccount, account: account(unrelatedMint, 50n) }] };
    }
    if (method === 'simulateTransaction') {
      assert.equal(params[1].sigVerify, false); assert.equal(params[1].replaceRecentBlockhash, false);
      const decoded = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64')); assert(decoded.signatures[0].every(byte => byte === 0));
      assert.equal(params[1].accounts.addresses.length, 4);
      return { value: { err: simulationError, ...(accountsMissing ? {} : { accounts: [{ lamports: 1000000000 - nativeDebit }, account(mint, 1000n - inputSpent, afterDelegated), account(unrelatedMint, extraDebit ? 49n : 50n), account(outputMint, output)] }) } };
    }
    throw new Error('Unexpected RPC ' + method);
  };
  adapter.remember(quote); return { adapter, quote, calls, config };
}

test('readonly Solana preflight simulates unsigned exact-input holdings and minimum output without keys or broadcasting', async () => {
  const { adapter, quote, calls } = unsignedSolFixture();
  const report = await adapter.preflightSwap(quote);
  assert.equal(report.verified, true); assert.equal(report.readOnly, true); assert.equal(report.outputVerified, true); assert.equal(report.feeNative, .000005);
  assert.equal(report.onChainMinimumDecoded, false); assert(report.limitations.some(text => /最小到账字段尚未独立解码/.test(text)));
  assert(report.checks.includes('unchanged-unrelated-tokens-and-authority'));
  assert(!calls.some(method => ['signer', 'browser', 'sendTransaction'].includes(method))); assert.equal(adapter.used.size, 0);
  assert(!JSON.stringify(report).includes(quote.tx.data)); assert(!JSON.stringify(report).includes(quote.sender));
});
for (const [label, options, pattern] of [
  ['minimum output missing', { output: 489n }, /输出低于最低到账/],
  ['excess input debit', { inputSpent: 501n }, /实际扣款/],
  ['authority changed', { afterDelegated: true }, /授权/],
  ['unrelated mint spent', { extraDebit: true }, /报价之外的代币/],
  ['network fee cap exceeded', { nativeDebit: 20000000 }, /费用或租金超过限制/],
  ['actual native debit above quoted fee', { nativeDebit: 6000 }, /高于冻结报价费用/],
  ['RPC simulation errored', { simulationError: { InstructionError: [0, 'InvalidAccountData'] } }, /模拟失败/],
  ['RPC omitted accounts', { accountsMissing: true }, /完整账户回执/],
  ['quote already signed', { signed: true }, /空签名交易/]
]) test(`readonly Solana preflight blocks ${label}`, async () => {
  const { adapter, quote, calls } = unsignedSolFixture(options);
  await assert.rejects(adapter.preflightSwap(quote), pattern);
  assert(!calls.some(method => ['signer', 'browser', 'sendTransaction'].includes(method)));
});

test('aggregator routing is explicit while pinned mode keeps pool matching strict', () => {
  const { adapter, config } = unsignedEvmFixture(); config.chains.bnb.poolAddress = token;
  assert.throws(() => adapter.checkPool('bnb', { path: [] }), /POOL_ROUTE_UNVERIFIED/);
  config.chains.bnb.routingMode = 'aggregator'; assert.doesNotThrow(() => adapter.checkPool('bnb', { path: [] }));
  config.chains.bnb.routingMode = 'pinned'; assert.throws(() => adapter.checkPool('bnb', { path: [] }), /POOL_ROUTE_UNVERIFIED/);
});

for (const [label, patch, pattern] of [
  ['boolean honeypot', { isHoneyPot: true }, /貔貅/],
  ['text honeypot', { isHoneyPot: 'true' }, /貔貅/],
  ['ambiguous risk flag', { isHoneyPot: 'maybe' }, /风险标记/],
  ['positive transfer tax', { taxRate: '0.01' }, /转账税/],
  ['invalid decimal transfer tax', { taxRate: 'not-a-number' }, /转账税/],
  ['negative transfer tax', { taxRate: '-0.01' }, /转账税/],
  ['non-finite transfer tax', { taxRate: Infinity }, /转账税/],
  ['malformed transfer tax', { taxRate: true }, /转账税/]
]) test(`swap quote blocks ${label} before it can be cached`, async t => {
  const { adapter, fromToken, toToken } = timedQuoteFixture(t), original = adapter.okx;
  adapter.okx = async (...args) => { const result = await original(...args); Object.assign(result.routerResult.toToken, patch); return result; };
  await assert.rejects(adapter.quoteSwap({ chain: 'bnb', fromToken, toToken, amountRaw: '1000' }), pattern); assert.equal(adapter.quotes.size, 0);
});
test('swap quote rejects extra signature payloads and records absent risk data as unknown', async t => {
  const { adapter, fromToken, toToken } = timedQuoteFixture(t), original = adapter.okx;
  adapter.okx = async (...args) => { const result = await original(...args); result.tx.signatureData = '0x1234'; return result; };
  await assert.rejects(adapter.quoteSwap({ chain: 'bnb', fromToken, toToken, amountRaw: '1000' }), /UNSUPPORTED_SIGNATURE_DATA/); assert.equal(adapter.quotes.size, 0);
  adapter.okx = original;
  const quote = await adapter.quoteSwap({ chain: 'bnb', fromToken, toToken, amountRaw: '1000' });
  assert.deepEqual(quote.tokenRisk, { from: { honeypot: 'unknown', transferTax: 'unknown' }, to: { honeypot: 'unknown', transferTax: 'unknown' } });
});

test('BNB no-return ABI methods report the absence of simulated output evidence honestly', async () => {
  const { adapter, quote } = unsignedEvmFixture({ result: '0x' });
  const noReturn = new Interface(['function swapWrapToWithBaseRequest(uint256 orderId,address receiver,(uint256 fromToken,address toToken,uint256 fromTokenAmount,uint256 minReturnAmount,uint256 deadLine) baseRequest) payable']);
  quote.tx.data = noReturn.encodeFunctionData('swapWrapToWithBaseRequest', [1n, owner, [BigInt(token), other, 500n, 490n, BigInt(Math.floor(Date.now() / 1000) + 600)]]);
  adapter.remember(quote);
  const report = await adapter.preflightSwap(quote);
  assert.equal(report.verified, true); assert.equal(report.outputVerified, false); assert.equal(report.simulatedOutRaw, null);
  assert.equal(report.onChainMinimumDecoded, true); assert(!report.checks.includes('simulated-output-at-least-minimum'));
  assert(report.limitations.some(text => /未取得模拟余额变动证据/.test(text)));
});

test('a BNB quote that expires while estimating gas never produces a valid preflight report', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { adapter, quote, calls } = unsignedEvmFixture(), original = adapter.rpc.bnb.call;
  adapter.rpc.bnb.call = async (...args) => { const out = await original(...args); if (args[0] === 'eth_estimateGas') t.mock.timers.tick(20001); return out; };
  await assert.rejects(adapter.preflightSwap(quote), /报价已过期/);
  assert(!calls.includes('signer')); assert(!calls.includes('browser')); assert.equal(adapter.used.size, 0);
});

for (const gas of ['0x0', 'invalid']) test(`BNB unverified gas estimate ${gas} never produces a valid preflight report`, async () => {
  const { adapter, quote } = unsignedEvmFixture(), original = adapter.rpc.bnb.call;
  adapter.rpc.bnb.call = async (...args) => args[0] === 'eth_estimateGas' ? gas : original(...args);
  await assert.rejects(adapter.preflightSwap(quote), /Gas/);
});

const patchSpl = (account, change) => {
  const copy = structuredClone(account), bytes = Buffer.from(copy.data[0], 'base64'); change(bytes); copy.data[0] = bytes.toString('base64'); return copy;
};
for (const [label, mutate] of [
  ['delegated amount', bytes => bytes.writeBigUInt64LE(1n, 121)],
  ['wrapped-native control', bytes => bytes.writeUInt32LE(1, 109)],
  ['close authority', bytes => bytes.writeUInt32LE(1, 129)],
]) test(`Solana holdings simulation rejects a changed ${label} even without an owner or delegate-address change`, () => {
  const before = spl(mint, 1000), after = patchSpl(spl(mint, 500), mutate);
  assert.throws(() => validateSolanaSimulationTokens({ quote: simulationQuote, beforeAccounts: [before, null], afterAccounts: [after, spl(outputMint, 495)] }), /授权/);
});
for (const [label, mutate] of [
  ['delegate', bytes => bytes.writeUInt32LE(1, 72)],
  ['close authority', bytes => bytes.writeUInt32LE(1, 129)],
  ['uninitialized state', bytes => { bytes[108] = 0; }],
  ['frozen state', bytes => { bytes[108] = 2; }],
]) test(`Solana holdings simulation rejects a newly created output account with ${label}`, () => {
  const created = patchSpl(spl(outputMint, 495), mutate);
  assert.throws(() => validateSolanaSimulationTokens({ quote: simulationQuote, beforeAccounts: [spl(mint, 1000), null], afterAccounts: [spl(mint, 500), created] }), /新建账户/);
});

test('known-zero source tax and false flags are retained as source assertions, not a safety certification', async t => {
  const { adapter, fromToken, toToken } = timedQuoteFixture(t), original = adapter.okx;
  adapter.okx = async (...args) => { const result = await original(...args); for (const item of [result.routerResult.fromToken, result.routerResult.toToken]) Object.assign(item, { isHoneyPot: false, taxRate: '0' }); return result; };
  const quote = await adapter.quoteSwap({ chain: 'bnb', fromToken, toToken, amountRaw: '1000' });
  assert.deepEqual(quote.tokenRisk.from, { honeypot: 'source-not-flagged', transferTax: 'source-zero' });
  assert.deepEqual(quote.tokenRisk.to, quote.tokenRisk.from);
});
