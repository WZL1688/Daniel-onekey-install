import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { Interface } from 'ethers';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { OnchainQuoteClient, RESEARCH_AMOUNTS } from '../src/onchain-research/quotes.mjs';

const NOW = Date.parse('2026-11-24T08:00:00Z');
const CLASSIC_SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ERC20 = new Interface(['function decimals() view returns(uint8)']);
const token = { bnb: '0x1111111111111111111111111111111111111111', solana: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr' };
const pool = { bnb: '0x2222222222222222222222222222222222222222', solana: '11111111111111111111111111111111' };
const wallets = { bnb: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mode: 'readonly', unlocked: false, canSign: false }, solana: { address: '11111111111111111111111111111111', mode: 'readonly', unlocked: false, canSign: false }, locked: false, okxConfigured: true };
const safe = message => Object.assign(new Error(message), { safe: true });

function fixture(options = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.chains.bnb.routingMode = 'aggregator'; config.chains.solana.routingMode = 'aggregator';
  const writes = [], requests = [], reads = [], validated = [];
  let time = NOW, args, instance;
  const engine = { config, configRevision: 3, pausedReason: '', vault: { publicStatus: () => structuredClone(wallets), getOkxCredentials: () => ({ apiKey: 'hidden-key', secretKey: 'hidden-secret' }), redact: value => String(value).replaceAll('hidden-secret', '[已隐藏]') },
    store: { stats: mode => { assert.equal(mode, 'live'); return { executions: 0, cumulativeUsd: 0 }; }, allTrades: () => [], getReservedInventory: () => '0', setMeta: (...input) => writes.push(input), saveTrade: (...input) => writes.push(input) } };
  const asset = { id: 'manual:quote-fixture', symbol: 'FIX', name: 'Offline quote fixture', enabled: true, revision: 7,
    mapping: { confirmed: true, evidence: 'Offline same-asset fixture, no real token assertion', warning: '' },
    chains: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { address: token[chain], poolAddress: pool[chain], decimals: chain === 'bnb' ? 18 : 9 }])) };
  const row = { asset: structuredClone(asset), generation: 'fresh-offline-round', observedAt: time, comparisonStatus: 'comparable', marketQualified: true, opportunityQualified: true, universe: { eligible: true }, buyChain: 'bnb', sellChain: 'solana',
    market: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { tokenAddress: token[chain], poolAddress: pool[chain], observedAt: time, priceUsd: chain === 'bnb' ? .01 : .0115, priceConfidence: 'pool-consensus' }])) };
  const client = new OnchainQuoteClient({ engine, now: () => time, rateGate: { acquire: async () => {}, observe: () => {} }, adapterFactory: async input => {
    args = input;
    instance = {
      rpc: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { call: async (method, parameters) => {
        reads.push({ chain, method, parameters });
        if (chain === 'bnb') return ERC20.encodeFunctionResult('decimals', [options.bnbDecimals ?? 18]);
        const bytes = Buffer.alloc(82); bytes[44] = options.solDecimals ?? 9; bytes[45] = options.uninitialized ? 0 : 1;
        return { value: { owner: options.token2022 ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : CLASSIC_SPL, data: [bytes.toString('base64'), 'base64'] } };
      } }])),
      validateToken: async (chain, value) => {
        validated.push({ chain, ...value });
        const c = input.getConfig().chains[chain], expected = value.address === c.stableAddress ? c.stableDecimals : chain === 'bnb' ? options.bnbDecimals ?? 18 : options.solDecimals ?? 9;
        if (value.decimals !== expected) throw safe('链上精度与配置不一致');
      },
      balances: () => { throw Error('Research must not require real balances'); },
      submit: () => { throw Error('Research must not submit'); }, confirm: () => { throw Error('Research must not confirm'); },
      quoteSwap: async request => {
        requests.push(structuredClone(request)); assert.equal(request.allowUnapproved, true);
        if (options.attackStore) input.store.saveTrade({ secret: 'must-not-write' });
        const c = input.getConfig(), buying = request.fromToken.kind === 'stable', price = request.chain === 'bnb' ? .01 : .0115;
        const amount = new Decimal(request.amountRaw).div(new Decimal(10).pow(request.fromToken.decimals));
        const output = (buying ? amount.div(price) : amount.mul(price)).mul('.997').mul(new Decimal(10).pow(request.toToken.decimals)).floor().toFixed(0);
        const bnbGas = request.chain === 'bnb' ? .000001 : 0, solFee = request.chain === 'solana' ? .000012 : 0;
        const quote = { id: 'quote-' + requests.length, kind: 'swap', fromChain: request.chain, toChain: request.chain,
          sender: wallets[request.chain].address, recipient: wallets[request.chain].address, fromToken: { ...request.fromToken }, toToken: { ...request.toToken },
          amountInRaw: request.amountRaw, amountOutRaw: output, minOutRaw: new Decimal(output).mul('.995').floor().toFixed(0),
          requestedAt: new Date(time).toISOString(), expiresAt: new Date(time + (options.remainingMs ?? c.quoteTtlMs)).toISOString(),
          bnbGas, solFee, feeUsd: bnbGas * c.chains.bnb.nativeUsd + solFee * c.chains.solana.nativeUsd,
          estimatedRentUsd: request.chain === 'solana' ? .0003 : 0, priceImpactBps: 10,
          raw: { authorization: 'hidden-secret' }, tx: { data: 'must-not-export', privateKey: 'hidden-secret' } };
        await options.changeQuote?.(quote, requests.length, { engine, input, requests });
        return quote;
      }
    };
    return instance;
  } });
  return { client, engine, asset, row, writes, requests, reads, validated, args: () => args, instance: () => instance, setTime: value => { time = value; } };
}

for (const amountUsd of RESEARCH_AMOUNTS) test(`real-route research accepts ${amountUsd}U without changing live amount or requiring funded wallets`, async () => {
  const ctx = fixture(), original = JSON.stringify(ctx.engine.config);
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd, buyChain: 'bnb' });
  assert.equal(result.verified, true, result.reasons.join(';')); assert.equal(result.qualityPassed, true, result.reasons.join(';'));
  assert.equal(result.executable, false); assert.equal(result.executionReady, false); assert.equal(result.simulationVerified, false);
  assert.equal(result.mode, 'research'); assert.equal(result.amountUsd, amountUsd); assert.equal(result.readOnly, true);
  assert.equal(ctx.requests[0].amountRaw, new Decimal(amountUsd).mul('1e18').toFixed(0));
  assert.equal(JSON.stringify(ctx.engine.config), original); assert.equal(ctx.engine.config.risk.amountUsd, 5);
  assert.equal(ctx.writes.length, 0); assert.equal(result.estimatedRentIncludedInFees, true);
});

test('sell input is exactly converted from minimum buy output and average prices come from route quantities', async () => {
  const ctx = fixture(), result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(ctx.requests[1].amountRaw, (BigInt(result.buyMinOutRaw) / 1000000000n).toString());
  assert.equal(result.sellAmountRaw, ctx.requests[1].amountRaw);
  assert.equal(result.buyAveragePriceUsd, new Decimal(5).div(new Decimal(result.buyAmountOutRaw).div('1e18')).toNumber());
  assert(result.conservativeBuyAveragePriceUsd > result.buyAveragePriceUsd);
  assert(result.sellAveragePriceUsd > result.conservativeSellAveragePriceUsd);
  assert.equal(result.netProfitUsd, new Decimal(result.sellMinOutRaw).div('1e6').minus(5).minus(result.gasUsd).toNumber());
});

test('both directions are quoted independently rather than trusting the reference-price direction', async () => {
  const ctx = fixture(), result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'solana' });
  assert.equal(result.verified, true); assert.equal(result.qualityPassed, false); assert(result.netProfitUsd < 0);
  assert.deepEqual(ctx.requests.map(row => row.chain), ['solana', 'bnb']);
  assert(result.reasons.some(reason => /利润门槛/.test(reason)));
});

test('unverified asset identity produces candidate quotations but never a qualified opportunity', async () => {
  const ctx = fixture(); ctx.asset.mapping.confirmed = false; ctx.asset.mapping.evidence = ''; ctx.row.asset = structuredClone(ctx.asset);
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, true); assert.equal(result.identityVerified, false); assert.equal(result.qualityPassed, false);
  assert(result.netProfitUsd > 0); assert(result.reasons.some(reason => /同币1:1身份/.test(reason)));
});

test('missing precision is read from actual chain metadata without mutating the asset registry', async () => {
  const ctx = fixture(); for (const chain of ['bnb', 'solana']) ctx.asset.chains[chain].decimals = null;
  ctx.row.asset = structuredClone(ctx.asset);
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 2, buyChain: 'bnb' });
  assert.equal(result.verified, true, result.reasons.join(';'));
  assert.deepEqual(result.tokenDecimals, { bnb: 18, solana: 9 });
  assert.equal(result.metadataSources.bnb.source, 'chain-metadata'); assert.equal(result.metadataSources.solana.source, 'chain-metadata');
  assert.equal(ctx.asset.chains.bnb.decimals, null); assert.equal(ctx.reads.length, 2);
  assert.equal(ctx.validated.length, 4, 'both chain tokens and stable inputs are validated');
});

for (const options of [{ uninitialized: true }, { token2022: true }, { solDecimals: 18 }]) test(`unsupported or uninitialized Solana mint cannot be guessed into a quote ${JSON.stringify(options)}`, async () => {
  const ctx = fixture(options); ctx.asset.chains.solana.decimals = null; ctx.row.asset = structuredClone(ctx.asset);
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, false); assert.equal(result.qualityPassed, false); assert.equal(ctx.requests.length, 0);
  assert.equal(result.netProfitUsd, undefined);
});

test('configured precision mismatch fails chain validation before route requests', async () => {
  const ctx = fixture({ bnbDecimals: 8 });
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, false); assert.equal(ctx.requests.length, 0); assert(result.reasons.some(reason => /精度/.test(reason)));
});

for (const mutation of [
  ctx => { ctx.asset.chains.bnb.address = '0x3333333333333333333333333333333333333333'; },
  ctx => { ctx.row.asset.revision++; },
  ctx => { ctx.row.market.bnb.tokenAddress = '0x3333333333333333333333333333333333333333'; },
  ctx => { ctx.row.market.bnb.poolAddress = '0x3333333333333333333333333333333333333333'; },
  ctx => { ctx.row.anomalous = true; },
  ctx => { ctx.row.market.solana.observedAt = NOW - 40000; },
  ctx => { ctx.row.observedAt = NOW - 120001; },
  ctx => { ctx.row.observedAt = NOW + 1001; },
]) test('identity, pool, generation or freshness mismatch blocks same-symbol candidates', async () => {
  const ctx = fixture(); mutation(ctx);
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, false); assert.equal(ctx.requests.length, 0); assert.equal(result.netProfitUsd, undefined);
});

for (const changeQuote of [
  q => { q.amountInRaw = '1'; }, q => { q.sender = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; },
  q => { q.toToken.decimals++; }, q => { q.minOutRaw = q.amountOutRaw + '0'; },
  q => { q.feeUsd = -1; }, q => { q.estimatedRentUsd = undefined; },
  q => { q.feeUsd += 2; }, q => { q.priceImpactBps = 9999; },
  q => { q.expiresAt = new Date(NOW - 1).toISOString(); },
  q => { q.requestedAt = new Date(NOW + 3000).toISOString(); },
]) test('malformed exact route evidence cannot create quoted profit', async () => {
  const ctx = fixture({ changeQuote });
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, false); assert.equal(result.qualityPassed, false); assert.equal(result.netProfitUsd, undefined);
});

test('short remaining validity stays visible but cannot pass quality or authorize execution', async () => {
  const ctx = fixture({ remainingMs: 2000 }), result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, true); assert.equal(result.qualityPassed, false); assert.equal(result.executable, false);
  assert(result.reasons.some(reason => /不足3秒/.test(reason)));
});

test('pressure and configured inventory adjustment reserves are deducted without double-counting rent', async () => {
  const ctx = fixture(), result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb', inventoryAdjustmentCostUsd: .2 });
  assert.equal(result.verified, true);
  const proceeds = new Decimal(result.sellMinOutRaw).div('1e6');
  assert.equal(result.netProfitUsd, proceeds.minus(5).minus(result.gasUsd).minus(.2).toNumber());
  assert.equal(result.stressNetProfitUsd, proceeds.mul('.995').minus(5).minus(new Decimal(result.gasUsd).mul('1.25')).minus(.2).toNumber());
  assert.equal(result.includesActualRestockingCosts, false); assert.equal(result.closedInventory, false);
});

test('paper sell quoting uses its supplied exact quantity and independently fresh route evidence', async () => {
  const ctx = fixture(), amountRaw = '123450000000';
  const result = await ctx.client.quoteSell({ asset: ctx.asset, row: ctx.row, sellChain: 'solana', amountRaw });
  assert.equal(result.kind, 'sell'); assert.equal(result.verified, true); assert.equal(result.readOnly, true); assert.equal(result.executable, false);
  assert.equal(result.amountInRaw, amountRaw); assert.equal(result.inputRaw, amountRaw); assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0].amountRaw, amountRaw); assert.equal(result.fromDecimals, 9); assert.equal(result.toDecimals, 6);
  assert.equal(result.gasUsd, result.feeUsd); assert.equal(result.estimatedRentIncludedInFees, true);
});

test('wallet or parent risk mutation while awaiting a route invalidates the complete report', async () => {
  const ctx = fixture({ changeQuote: (q, count, { engine }) => { if (count === 1) engine.configRevision++; } });
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, false); assert.equal(ctx.requests.length, 1); assert(result.reasons.some(reason => /参数已变化/.test(reason)));
});

test('quote payloads and credentials cannot escape reports; write and signing facades remain blocked', async () => {
  const ctx = fixture({ changeQuote: q => { q.fromToken.privateKey = 'hidden-secret'; } });
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, true); const encoded = JSON.stringify(result);
  for (const canary of ['hidden-key', 'hidden-secret', 'must-not-export', 'privateKey', 'authorization', '"tx"', '"raw"', 'wallets']) assert.equal(encoded.includes(canary), false, canary);
  assert.throws(() => ctx.args().vault.signer('bnb'), /禁止/); assert.throws(() => ctx.args().vault.getPrivateKey('solana'), /禁止/);
  assert.throws(() => ctx.args().store.saveTrade({}), /禁止/); assert.throws(() => ctx.args().store.setMeta('x', 'x'), /禁止/);
  assert.throws(() => ctx.args().browserWallets.request('bnb', {}), /禁止/); assert.equal(ctx.writes.length, 0);
});

test('an adapter write attempt is rejected and unsafe upstream error text is replaced', async () => {
  const ctx = fixture({ attackStore: true });
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, false); assert.equal(ctx.writes.length, 0);
  const other = fixture({ changeQuote: () => { throw Error('https://secret-rpc/private API_KEY=hidden-secret'); } });
  const failed = await other.client.quote({ asset: other.asset, row: other.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(JSON.stringify(failed).includes('hidden-secret'), false); assert.equal(JSON.stringify(failed).includes('secret-rpc'), false);
});

test('cancellation after the buy quote never requests a sell quote or generates a fake result', async () => {
  const controller = new AbortController(); const ctx = fixture({ changeQuote: () => controller.abort('private-cancel-data') });
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb', signal: controller.signal });
  assert.equal(result.verified, false); assert.equal(ctx.requests.length, 1); assert.equal(result.netProfitUsd, undefined);
  assert.equal(JSON.stringify(result).includes('private-cancel-data'), false); assert(result.reasons.some(reason => /取消/.test(reason)));
});

test('research HTTP wrapper shares provider budget and rejects signing, arbitrary hosts and RPC broadcasts', async () => {
  const ctx = fixture(), dispatched = [], observed = [], acquired = [];
  const response = { status: 429, headers: { get: () => '60' } };
  ctx.client.fetchImpl = async (url, options) => { dispatched.push({ url, options }); return response; };
  ctx.client.rateGate = { acquire: async input => acquired.push(input), observe: value => observed.push(value) };
  const fetch = ctx.client.fetch(ctx.engine.config);
  await fetch('https://web3.okx.com/api/v6/dex/aggregator/swap?chainIndex=56', {});
  assert.equal(acquired.length, 1); assert.deepEqual(observed, [response]); assert.equal(dispatched[0].options.redirect, 'error');
  for (const [url, options] of [
    ['https://attacker.invalid', {}], ['https://web3.okx.com/api/v5/trade/order', { method: 'POST', body: '{}' }],
    [ctx.engine.config.chains.bnb.rpcs[0], { method: 'POST', body: JSON.stringify({ method: 'eth_sendRawTransaction', params: ['private-signed-bytes'] }) }],
    [ctx.engine.config.chains.solana.rpcs[0], { method: 'POST', body: JSON.stringify({ method: 'sendTransaction' }) }],
  ]) await assert.rejects(fetch(url, options), /禁止|只允许/);
  assert.equal(dispatched.length, 1);
  await fetch(ctx.engine.config.chains.bnb.rpcs[0], { method: 'POST', body: JSON.stringify({ method: 'eth_call', params: [] }) });
  assert.equal(dispatched.length, 2); assert.equal(acquired.length, 1, 'RPC endpoints do not bypass or consume an OKX-host quota bucket');
});

test('missing public addresses or locked API credentials do not manufacture a zero-profit quote', async () => {
  for (const state of [{ ...wallets, locked: true }, { ...wallets, okxConfigured: false }, { ...wallets, solana: { mode: 'none' } }]) {
    const ctx = fixture(); ctx.engine.vault.publicStatus = () => structuredClone(state);
    const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
    assert.equal(result.verified, false); assert.equal(result.qualityPassed, false); assert.equal(result.netProfitUsd, undefined); assert.equal(ctx.requests.length, 0);
  }
});

test('invalid tiers, adjustment reserves and sell quantities cannot reach real route construction', async () => {
  const ctx = fixture();
  for (const amountUsd of [0, '5', 3, 100, NaN]) {
    const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd, buyChain: 'bnb' });
    assert.equal(result.verified, false);
  }
  for (const inventoryAdjustmentCostUsd of [-1, Infinity, '0']) assert.equal((await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb', inventoryAdjustmentCostUsd })).verified, false);
  for (const amountRaw of ['0', '-1', '1.5', '9'.repeat(79), (1n << 64n).toString()]) assert.equal((await ctx.client.quoteSell({ asset: ctx.asset, row: ctx.row, sellChain: 'solana', amountRaw })).verified, false);
  assert.equal(ctx.requests.length, 0);
});

test('unknown source price confidence remains blocked instead of becoming independent pool validation', async () => {
  const ctx = fixture(); delete ctx.row.market.bnb.priceConfidence;
  const result = await ctx.client.quote({ asset: ctx.asset, row: ctx.row, amountUsd: 5, buyChain: 'bnb' });
  assert.equal(result.verified, false); assert.equal(ctx.requests.length, 0);
});
