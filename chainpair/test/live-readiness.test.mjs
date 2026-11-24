import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Decimal from 'decimal.js';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { LiveReadinessService } from '../src/live-readiness.mjs';

const safe = message => Object.assign(new Error(message), { safe: true });
const asRaw = (units, decimals) => new Decimal(units).mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
const units = (raw, decimals) => new Decimal(raw).div(new Decimal(10).pow(decimals));
const SPENDER = '0x4444444444444444444444444444444444444444';
const assetFixture = () => ({ id: 'manual:readiness-fixture', name: 'Offline fixture', symbol: 'FIX', revision: 1, enabled: true,
  mappingEvidence: 'Synthetic test fixture only, not a real asset claim', chains: {
    bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' },
    solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', decimals: 9, poolAddress: '11111111111111111111111111111111' },
  } });
function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'live-readiness-')), store = new Store(directory), config = structuredClone(DEFAULT_CONFIG);
  let clock = Date.now(), asset = assetFixture(), quarantined = false, revoked = false, quoteIndex = 0;
  config.mode = options.mode ?? 'live'; config.executionMode = options.executionMode ?? 'inventory';
  config.inventory = { ...config.inventory, assetId: asset.id, mappingConfirmed: true, mappingEvidence: asset.mappingEvidence };
  for (const chain of ['bnb', 'solana']) config.chains[chain] = { ...config.chains[chain], tokenAddress: asset.chains[chain].address, tokenDecimals: asset.chains[chain].decimals, poolAddress: asset.chains[chain].poolAddress };
  config.chains.bnb.routerAllowlist = [SPENDER];
  store.setConfig(config);
  const wallets = { bnb: { mode: 'private', address: '0x3333333333333333333333333333333333333333', unlocked: true, canSign: true }, solana: { mode: 'browser', address: '11111111111111111111111111111111', unlocked: true, canSign: true }, okxConfigured: true, locked: false };
  if (options.readonly) for (const chain of ['bnb', 'solana']) Object.assign(wallets[chain], { mode: 'readonly', unlocked: false, canSign: false });
  const counters = { factory: 0, quote: 0, allowanceQuery: 0, simulation: 0, signing: 0, submission: 0, mutation: 0 };
  const vault = { publicStatus: () => structuredClone(wallets), getOkxCredentials: () => ({ apiKey: 'fixture-only-key', secretKey: 'fixture-only-secret', passphrase: 'fixture-only-passphrase' }),
    redact: value => String(value).replaceAll('fixture-only-secret', '[REDACTED]'),
    signer() { counters.signing++; throw Error('parent signer must not be reached'); }, getPrivateKey() { counters.signing++; throw Error('must not read a private key'); } };
  const engine = new Engine({ store, vault });
  const scanner = { busy: false, getApprovedAsset(id) { if (revoked || id !== asset.id) throw safe('同币映射已撤销'); return structuredClone(asset); }, assertComparisonUsable() { if (quarantined) throw safe('行情已隔离'); } };
  let factoryArgs;
  const adapterFactory = args => {
    counters.factory++; factoryArgs = args;
    return {
      async market(chain) { await options.onMarket?.(chain, { args, engine, scanner }); return { connected: !options.marketDown, priceUsd: chain === 'bnb' ? (options.bnbPrice ?? .01) : (options.sellPrice ?? .011), updatedAt: new Date().toISOString(), liquidityUsd: 100000 }; },
      async balances(chain) { return { stableUsd: options.emptyStable ? 0 : 100, nativeBalance: options.emptyGas ? 0 : 1, tokenRaw: asRaw(options.emptyInventory ? 0 : 10000, args.getConfig().chains[chain].tokenDecimals) }; },
      async quoteSwap({ chain, fromToken, toToken, amountRaw, allowUnapproved }) {
        counters.quote++; assert.equal(allowUnapproved, true);
        await options.onQuote?.({ args, engine, chain });
        if (options.failQuote === chain) throw safe('test quote unavailable');
        const buying = fromToken.kind === 'stable', price = chain === 'bnb' ? (options.bnbPrice ?? .01) : (options.sellPrice ?? .011);
        const output = buying ? units(amountRaw, fromToken.decimals).div(price) : units(amountRaw, fromToken.decimals).mul(price);
        const amountOutRaw = asRaw(output, toToken.decimals);
        const quote = { id: 'fixture-quote-' + (++quoteIndex), kind: 'swap', fromChain: chain, toChain: chain, fromToken: structuredClone(fromToken), toToken: structuredClone(toToken),
          amountInRaw: amountRaw, amountOutRaw, minOutRaw: new Decimal(amountOutRaw).mul(.995).floor().toFixed(0),
          sender: wallets[chain].address, recipient: wallets[chain].address, feeUsd: .002, estimatedRentUsd: 0, bnbGas: chain === 'bnb' ? .000003 : 0,
          solFee: chain === 'solana' ? .00001 : 0, priceImpactBps: 5, expiresAt: new Date(clock + (options.ttl ?? 15000)).toISOString(), raw: { secretKey: 'fixture-only-secret' } };
        if (chain === 'bnb' && !options.omitAllowance) quote.approvalRequirement = { chain: 'bnb', tokenAddress: fromToken.address, spender: SPENDER, owner: wallets.bnb.address,
          requiredRaw: amountRaw, currentRaw: options.allowanceCurrentRaw ?? (options.missingAllowance ? '0' : amountRaw), sufficient: BigInt(options.allowanceCurrentRaw ?? (options.missingAllowance ? '0' : amountRaw)) >= BigInt(amountRaw) };
        options.changeQuote?.(quote);
        return quote;
      },
      async allowanceRequirement(quote) {
        counters.allowanceQuery++;
        await options.onAllowanceQuery?.(quote);
        if (options.failExpectedAllowance) throw safe('预期授权查询未完成');
        const currentRaw = options.allowanceCurrentRaw ?? (options.missingAllowance ? '0' : quote.amountInRaw);
        const requirement = { chain: 'bnb', tokenAddress: quote.fromToken.address, spender: options.expectedSpender ?? SPENDER, owner: wallets.bnb.address,
          requiredRaw: quote.amountInRaw, currentRaw, sufficient: BigInt(currentRaw) >= BigInt(quote.amountInRaw) };
        options.changeExpectedRequirement?.(requirement, quote);
        return requirement;
      },
      async preflightSwap(quote) {
        counters.simulation++; await options.onSimulation?.({ args, engine, quote });
        if (options.failSimulation === quote.fromChain) throw options.simulationError || safe('RPC未签名模拟失败');
        const result = { verified: true, readOnly: true, chain: quote.fromChain, quoteId: quote.id, checkedAt: new Date(clock).toISOString(), expiresAt: quote.expiresAt };
        options.changeSimulation?.(result, quote); return result;
      },
      submit() { counters.submission++; throw Error('Must not submit'); }, confirm() { counters.submission++; throw Error('Must not confirm'); },
    };
  };
  const readiness = new LiveReadinessService({ engine, scanner, adapterFactory, now: () => clock });
  t.after(async () => { await readiness.pending?.catch(() => {}); engine.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { readiness, engine, store, scanner, wallets, counters, adapterFactory, get factoryArgs() { return factoryArgs; }, getAsset: () => structuredClone(asset),
    now: () => clock, advance: amount => { clock += amount; }, changeAsset: () => { asset.revision++; }, quarantine: () => { quarantined = true; }, revoke: () => { revoked = true; } };
}
const blocked = (report, id) => report.checks.some(check => check.id === id && check.status === 'blocked');

test('live readiness verifies two exact unsigned legs without signing, changing config or creating trades', async t => {
  const ctx = fixture(t), before = JSON.stringify(ctx.store.config), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, true, JSON.stringify(report.checks)); assert.equal(report.status, 'ready');
  assert.equal(report.readOnly, true); assert.equal(report.executable, false); assert.equal(report.simulationVerified, true);
  assert.equal(report.opportunity.amountUsd, 5); assert(report.opportunity.stressNetProfitUsd > .03);
  assert.equal(ctx.counters.quote, 2); assert.equal(ctx.counters.simulation, 2); assert.equal(ctx.counters.signing, 0); assert.equal(ctx.counters.submission, 0);
  assert.equal(ctx.engine.busy, false); assert.equal(ctx.engine.running, false); assert.equal(JSON.stringify(ctx.store.config), before);
  assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.store.stats('live').executions, 0); assert.equal(report.approvals.length, 0);
  assert(report.checks.some(check => check.id === 'solana-instruction-semantics' && check.status === 'warning'));
  assert(!JSON.stringify(report).includes('fixture-only-secret')); assert(!JSON.stringify(report).includes('fixture-quote-'));
});

test('parent demo and readonly wallets can run unsigned checks but cannot claim live readiness', async t => {
  const ctx = fixture(t, { mode: 'demo', readonly: true }), report = await ctx.readiness.check();
  assert.equal(report.simulationVerified, true); assert.equal(report.readyForLive, false); assert.equal(report.parentMode, 'demo');
  assert(blocked(report, 'run-mode')); assert(blocked(report, 'wallet-signing-bnb')); assert(blocked(report, 'wallet-signing-solana'));
  assert.equal(ctx.engine.config.mode, 'demo'); assert.equal(ctx.counters.submission, 0);
});

test('missing canSign evidence never passes signing checks even for unlocked private wallets', async t => {
  const ctx = fixture(t); delete ctx.wallets.bnb.canSign;
  const report = await ctx.readiness.check(); assert.equal(report.readyForLive, false); assert(blocked(report, 'wallet-signing-bnb'));
});

test('all readonly facades reject signatures, broadcasts and trade/config writes', async t => {
  const ctx = fixture(t, { onQuote: ({ args }) => {
    assert.throws(() => args.vault.signer('bnb'), /只读/); assert.throws(() => args.vault.getPrivateKey('bnb'), /只读/);
    assert.throws(() => args.browserWallets.request('bnb', {}), /只读/);
    for (const name of ['saveTrade', 'saveQuote', 'appendEvent', 'reserveExecution', 'reserveInventory', 'setConfig', 'setMeta']) assert.throws(() => args.store[name]({}), /只读/);
  } });
  const report = await ctx.readiness.check(); assert.equal(report.readyForLive, true); assert.equal(ctx.counters.signing, 0);
});

test('missing credentials or invalid addresses stop before constructing network adapters', async t => {
  const ctx = fixture(t); ctx.wallets.okxConfigured = false; ctx.wallets.solana.address = '';
  const report = await ctx.readiness.check(); assert.equal(report.readyForLive, false); assert(blocked(report, 'okx')); assert(blocked(report, 'wallet-address-solana')); assert.equal(ctx.counters.factory, 0);
});

test('incomplete configured mapping stops without pretending that public quotes confirm identity', async t => {
  const ctx = fixture(t); ctx.engine.config.inventory.mappingConfirmed = false;
  const report = await ctx.readiness.check(); assert(blocked(report, 'configuration')); assert.equal(ctx.counters.factory, 0);
});

test('bridge parent mode is reported as outside this preflight scope', async t => {
  const ctx = fixture(t, { executionMode: 'bridge' }), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert(blocked(report, 'execution-mode')); assert.equal(report.simulationVerified, true);
  assert.equal(ctx.engine.config.executionMode, 'bridge'); assert.equal(ctx.store.allTrades().length, 0);
});

test('missing BNB allowance is reviewable with exact safe context, without authorizing execution', async t => {
  const ctx = fixture(t, { missingAllowance: true }), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert(blocked(report, 'approval-BUY')); assert.equal(report.approvals.length, 1);
  const approval = ctx.readiness.getReviewableApproval(report.id, 0); assert.equal(approval.currentRaw, '0'); assert.equal(approval.requiredRaw, asRaw(5, 18)); assert.equal(approval.spender, SPENDER);
  const context = ctx.readiness.getApprovalContext(report.id, 0); assert.equal(context.config.mode, 'live'); assert.equal(context.amountRaw, approval.requiredRaw); assert.equal(context.fromToken.kind, 'stable');
  context.config.risk.amountUsd = 10; assert.equal(ctx.readiness.getApprovalContext(report.id, 0).config.risk.amountUsd, 5);
  assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.counters.submission, 0);
});

test('approval report expiry blocks new prepares but an existing immutable context has an independent validity contract', async t => {
  const ctx = fixture(t, { missingAllowance: true }), report = await ctx.readiness.check(), context = ctx.readiness.getApprovalContext(report.id, 0);
  ctx.advance(15001); assert.equal(ctx.readiness.snapshot().report.status, 'stale');
  assert.throws(() => ctx.readiness.getReviewableApproval(report.id, 0), /失效/); assert.equal(ctx.readiness.assertApprovalContextCurrent(context), true);
  ctx.wallets.solana.address = '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr';
  assert.throws(() => ctx.readiness.assertApprovalContextCurrent(context), /钱包/);
});

for (const kind of ['missing', 'wrong-owner', 'wrong-amount', 'outside-allowlist', 'inconsistent']) test(`BNB allowance ${kind} never becomes a reviewable authorization`, async t => {
  const options = { missingAllowance: true, omitAllowance: kind === 'missing', changeQuote: quote => {
    if (quote.fromChain !== 'bnb' || !quote.approvalRequirement) return;
    if (kind === 'wrong-owner') quote.approvalRequirement.owner = '0x5555555555555555555555555555555555555555';
    if (kind === 'wrong-amount') quote.approvalRequirement.requiredRaw = '1';
    if (kind === 'outside-allowlist') quote.approvalRequirement.spender = '0x5555555555555555555555555555555555555555';
    if (kind === 'inconsistent') quote.approvalRequirement.sufficient = true;
  } };
  const ctx = fixture(t, options), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert.equal(report.approvals.length, 0); assert(blocked(report, 'approval-BUY'));
  assert.throws(() => ctx.readiness.getReviewableApproval(report.id, 0), /失效/);
});

test('failed sell quote cannot be mistaken for a complete two-leg plan', async t => {
  const ctx = fixture(t, { failQuote: 'solana' }), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert.equal(report.simulationVerified, false); assert(blocked(report, 'quotes-risk')); assert(blocked(report, 'simulation-incomplete'));
});

test('RPC and market failures remain blocked rather than reporting simulated balances as real', async t => {
  const ctx = fixture(t, { marketDown: true, emptyGas: true }), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert(blocked(report, 'market-bnb')); assert.equal(report.simulationVerified, false);
});

test('insufficient inventory and weak profit fail the same real execution risk checks', async t => {
  const ctx = fixture(t, { emptyInventory: true, sellPrice: .01002 }), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert(blocked(report, 'quotes-risk')); assert.match(report.checks.find(check => check.id === 'quotes-risk').message, /库存|压力|利润/);
});

for (const kind of ['wrong-quote', 'wrong-chain', 'expired', 'future', 'before-request', 'signed', 'missing']) test(`unsigned simulation evidence ${kind} is rejected`, async t => {
  const ctx = fixture(t, { changeSimulation: result => {
    if (result.chain !== 'solana') return;
    if (kind === 'wrong-quote') result.quoteId = 'not-this-quote';
    if (kind === 'wrong-chain') result.chain = 'bnb';
    if (kind === 'expired') result.expiresAt = new Date(Date.now() - 1000).toISOString();
    if (kind === 'future') result.checkedAt = new Date(Date.now() + 10000).toISOString();
    if (kind === 'before-request') result.checkedAt = new Date(Date.now() - 10000).toISOString();
    if (kind === 'signed') result.readOnly = false;
    if (kind === 'missing') delete result.verified;
  } });
  const report = await ctx.readiness.check(); assert.equal(report.readyForLive, false); assert.equal(report.simulationVerified, false); assert(blocked(report, 'simulation-SELL'));
});

test('network error strings never expose URLs, RPC keys or provider payloads', async t => {
  const ctx = fixture(t, { failSimulation: 'solana', simulationError: Error('https://rpc.invalid/key/fixture-only-secret privateKey=fixture-key') });
  const report = await ctx.readiness.check(), serialized = JSON.stringify(report);
  assert.equal(report.readyForLive, false); assert(!serialized.includes('rpc.invalid')); assert(!serialized.includes('fixture-only-secret')); assert(!serialized.includes('fixture-key'));
});

test('quotes with less than three seconds remaining cannot claim live readiness', async t => {
  const ctx = fixture(t, { ttl: 2000 }), report = await ctx.readiness.check(); assert.equal(report.readyForLive, false); assert(blocked(report, 'quote-freshness'));
});

test('public signing and OKX state changes immediately stale cached readiness', async t => {
  const ctx = fixture(t); const report = await ctx.readiness.check(); assert.equal(report.readyForLive, true);
  ctx.wallets.locked = true; const snapshot = ctx.readiness.snapshot(); assert.equal(snapshot.report.status, 'stale'); assert.equal(snapshot.report.readyForLive, false);
});

test('configuration version and policy changes stale reports even without an asset edit', async t => {
  const ctx = fixture(t); await ctx.readiness.check(); ctx.engine.config.risk.minProfitUsd++;
  assert.equal(ctx.readiness.snapshot().report.status, 'stale');
});

for (const edit of ['asset', 'quarantine', 'revoke']) test(`approved scanner ${edit} invalidates report and review contexts`, async t => {
  const ctx = fixture(t, { missingAllowance: true }), report = await ctx.readiness.check({ assetId: ctx.getAsset().id });
  if (edit === 'asset') ctx.changeAsset(); if (edit === 'quarantine') ctx.quarantine(); if (edit === 'revoke') ctx.revoke();
  assert.equal(ctx.readiness.snapshot().report.status, 'stale'); assert.throws(() => ctx.readiness.getApprovalContext(report.id, 0), /失效/);
});

test('state changes during a simulation never return a late ready signal', async t => {
  const ctx = fixture(t, { onSimulation: ({ engine, quote }) => { if (quote.fromChain === 'solana') engine.configRevision++; } });
  const report = await ctx.readiness.check(); assert.equal(report.readyForLive, false); assert.equal(ctx.engine.busy, false); assert(blocked(report, 'precheck-error'));
});

test('shared mutex rejects concurrent checks and configuration changes while RPC work is pending', async t => {
  let release, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = fixture(t, { onMarket: async () => { if (first) { first = false; await gate; } } });
  const pending = ctx.readiness.check();
  assert.equal(ctx.engine.busy, true); assert.equal(ctx.readiness.busy, true);
  await assert.rejects(ctx.readiness.check(), /已有/); await assert.rejects(ctx.engine.saveConfig(ctx.engine.config), /进行中/);
  release(); const report = await pending; assert.equal(report.readyForLive, true); assert.equal(ctx.engine.busy, false);
});

test('failed checks consume a persistent thirty-second budget, clock rollback also blocks', async t => {
  const ctx = fixture(t); ctx.wallets.okxConfigured = false;
  await ctx.readiness.check(); await assert.rejects(ctx.readiness.check(), /30秒/);
  const restarted = new LiveReadinessService({ engine: ctx.engine, scanner: ctx.scanner, adapterFactory: ctx.adapterFactory, now: ctx.now });
  await assert.rejects(restarted.check(), /30秒/); ctx.advance(-1000); await assert.rejects(restarted.check(), /时钟回退/);
  assert.equal(restarted.snapshot().report, null); ctx.advance(31000); const report = await restarted.check(); assert.equal(report.readyForLive, false);
});

test('a backward clock removes a previously passed cached report', async t => {
  const ctx = fixture(t); await ctx.readiness.check(); ctx.advance(-1); assert.equal(ctx.readiness.snapshot().report.status, 'stale');
});

test('live execution caps are read from the live archive even while parent is in demo mode', async t => {
  const ctx = fixture(t, { mode: 'demo' });
  ctx.store.saveTrade({ id: 'prior-live-attempt', mode: 'live', type: 'arbitrage', status: 'COMPLETED', createdAt: new Date().toISOString() });
  ctx.store.reserveExecution('prior-live-attempt', 5); ctx.engine.config.risk.maxExecutions = 1;
  const report = await ctx.readiness.check(); assert(blocked(report, 'quotes-risk')); assert.match(report.checks.find(check => check.id === 'quotes-risk').message, /次数/);
});

for (const fault of ['token', 'sender', 'amount', 'expiry']) test(`an invalid ${fault} quote never supplies a finite-approval review context`, async t => {
  const ctx = fixture(t, { missingAllowance: true, changeQuote: quote => {
    if (quote.fromChain !== 'bnb') return;
    if (fault === 'token') { quote.fromToken.address = '0x5555555555555555555555555555555555555555'; quote.approvalRequirement.tokenAddress = quote.fromToken.address; }
    if (fault === 'sender') { quote.sender = '0x5555555555555555555555555555555555555555'; quote.approvalRequirement.owner = quote.sender; }
    if (fault === 'amount') { quote.amountInRaw = '1'; quote.approvalRequirement.requiredRaw = '1'; }
    if (fault === 'expiry') quote.expiresAt = 'invalid';
  } });
  const report = await ctx.readiness.check(); assert.equal(report.readyForLive, false); assert.equal(report.approvals.length, 0);
  assert.throws(() => ctx.readiness.getApprovalContext(report.id, 0), /失效/); assert.equal(ctx.counters.simulation, 0);
});

test('BNB no-return simulation exposes its limited output evidence instead of claiming a verified balance delta', async t => {
  const ctx = fixture(t, { changeSimulation: (result, quote) => { if (quote.fromChain === 'bnb') result.outputVerified = false; } });
  const report = await ctx.readiness.check();
  assert.equal(report.simulationVerified, true); assert(report.checks.some(check => check.id === 'simulation-output-BUY' && check.status === 'warning'));
  assert.match(report.checks.find(check => check.id === 'simulation-output-BUY').message, /尚无直接/);
});

test('BNB sell preflight reserves finite allowance for expected bought output rather than only its minimum', async t => {
  const expected = asRaw(500, 18), minimum = asRaw(497.5, 18);
  let queriedRaw, simulatedRaw, simulatedApprovalRaw;
  const ctx = fixture(t, { bnbPrice: .011, sellPrice: .01, allowanceCurrentRaw: minimum,
    onAllowanceQuery: quote => { queriedRaw = quote.amountInRaw; assert.equal(quote.approvalRequirement, undefined); },
    onSimulation: ({ quote }) => { if (quote.fromChain === 'bnb') { simulatedRaw = quote.amountInRaw; simulatedApprovalRaw = quote.approvalRequirement.requiredRaw; } },
  });
  const report = await ctx.readiness.check();
  assert.equal(report.opportunity.buyChain, 'solana'); assert.equal(report.opportunity.sellChain, 'bnb');
  assert.equal(report.readyForLive, false); assert.equal(report.simulationVerified, true);
  assert(blocked(report, 'approval-SELL')); assert.equal(report.approvals.length, 1);
  assert.equal(queriedRaw, expected); assert.equal(simulatedRaw, minimum); assert.equal(simulatedApprovalRaw, minimum);
  const approval = report.approvals[0];
  assert.equal(approval.requiredRaw, expected); assert.equal(approval.currentRaw, minimum); assert.equal(approval.basis, 'expected-buy-output');
  assert.match(approval.message, /预期到账/); assert.match(approval.message, /更多时仍可能暂停/);
  assert(BigInt(approval.requiredRaw) < BigInt(asRaw(10000, 18)));
  const context = ctx.readiness.getApprovalContext(report.id, 0);
  assert.equal(context.amountRaw, expected); assert.equal(context.requiredRaw, expected); assert.equal(context.fromToken.kind, 'token'); assert.equal(context.basis, 'expected-buy-output');
  assert.equal(ctx.counters.allowanceQuery, 1); assert.equal(ctx.counters.signing, 0); assert.equal(ctx.counters.submission, 0); assert.equal(ctx.store.allTrades().length, 0);
});

test('normal expected BNB sell allowance is sufficient while simulations keep the original conservative quote', async t => {
  const minimum = asRaw(497.5, 18), expected = asRaw(500, 18);
  const ctx = fixture(t, { bnbPrice: .011, sellPrice: .01, allowanceCurrentRaw: expected,
    onSimulation: ({ quote }) => { if (quote.fromChain === 'bnb') assert.equal(quote.amountInRaw, minimum); },
  });
  const report = await ctx.readiness.check();
  assert.equal(report.readyForLive, true, JSON.stringify(report.checks)); assert.equal(report.approvals.length, 0);
  assert.equal(ctx.counters.allowanceQuery, 1); assert.match(report.checks.find(check => check.id === 'approval-SELL').message, /预期到账/);
});

test('missing BNB sell approval still reviews only current expected output rather than wallet inventory', async t => {
  const ctx = fixture(t, { bnbPrice: .011, sellPrice: .01, missingAllowance: true }), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert.equal(report.approvals[0].requiredRaw, asRaw(500, 18)); assert.equal(report.approvals[0].currentRaw, '0');
  assert.equal(report.approvals[0].basis, 'expected-buy-output');
});

test('an unavailable expected sell allowance query blocks readiness without an approval context', async t => {
  const ctx = fixture(t, { bnbPrice: .011, sellPrice: .01, failExpectedAllowance: true }), report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert(blocked(report, 'approval-SELL')); assert.equal(report.approvals.length, 0);
  assert.match(report.checks.find(check => check.id === 'approval-SELL').message, /查询未完成/);
  assert.throws(() => ctx.readiness.getApprovalContext(report.id, 0), /失效/);
});

test('expected sell allowance may not switch spender even to another allowlisted address', async t => {
  const anotherSpender = '0x5555555555555555555555555555555555555555';
  const ctx = fixture(t, { bnbPrice: .011, sellPrice: .01, expectedSpender: anotherSpender });
  ctx.engine.config.chains.bnb.routerAllowlist.push(anotherSpender);
  const report = await ctx.readiness.check();
  assert.equal(report.readyForLive, false); assert(blocked(report, 'approval-SELL')); assert.equal(report.approvals.length, 0);
  assert.match(report.checks.find(check => check.id === 'approval-SELL').message, /原真实路线不一致/);
});

for (const error of ['amount', 'owner', 'token', 'chain', 'sufficient']) test(`inconsistent expected sell allowance ${error} is never trusted`, async t => {
  const ctx = fixture(t, { bnbPrice: .011, sellPrice: .01, changeExpectedRequirement: requirement => {
    if (error === 'amount') requirement.requiredRaw = '1';
    if (error === 'owner') requirement.owner = '0x5555555555555555555555555555555555555555';
    if (error === 'token') requirement.tokenAddress = '0x5555555555555555555555555555555555555555';
    if (error === 'chain') requirement.chain = 'solana';
    if (error === 'sufficient') requirement.sufficient = false;
  } });
  const report = await ctx.readiness.check(); assert.equal(report.readyForLive, false); assert(blocked(report, 'approval-SELL')); assert.equal(report.approvals.length, 0);
});

test('BNB buy approval remains the exact stablecoin input and does not query an expanded token reserve', async t => {
  const ctx = fixture(t, { missingAllowance: true }), report = await ctx.readiness.check();
  const approval = report.approvals[0]; assert.equal(approval.side, 'BUY'); assert.equal(approval.basis, 'exact-input'); assert.equal(approval.requiredRaw, asRaw(5, 18));
  assert.equal(ctx.readiness.getApprovalContext(report.id, 0).amountRaw, asRaw(5, 18)); assert.equal(ctx.counters.allowanceQuery, 0);
});
