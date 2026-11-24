import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Decimal from 'decimal.js';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { OpportunityQualityService } from '../src/opportunities/quality.mjs';

const asRaw = (units, decimals) => new Decimal(units).mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
const units = (raw, decimals) => new Decimal(raw).div(new Decimal(10).pow(decimals));
const fixtureAsset = () => ({ id: 'manual:quality-fixture', revision: 1, name: 'Quality fixture', symbol: 'QFIX', mappingEvidence: 'Synthetic fixture; no real trading claim', chains: {
  bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' },
  solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', decimals: 9, poolAddress: '11111111111111111111111111111111' },
} });

function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'readonly-quality-')), store = new Store(dir);
  store.setConfig(structuredClone(DEFAULT_CONFIG));
  let clock = Date.now(), asset = fixtureAsset(), stale = false, quarantined = false, generation = 'fixture-generation', poolChanged = false, sourceObservationShift = 0;
  let missing = options.missing || false, quoteCount = 0, marketCount = 0, submitCount = 0, signerCount = 0, writes = 0;
  const walletState = { bnb: { mode: 'readonly', address: '0x3333333333333333333333333333333333333333', unlocked: false, canSign: false }, solana: { mode: 'readonly', address: '11111111111111111111111111111111', unlocked: false, canSign: false }, okxConfigured: true, locked: false };
  const vault = { publicStatus: () => missing ? { bnb: {}, solana: {}, okxConfigured: false, locked: true } : structuredClone(walletState),
    getOkxCredentials: () => ({ apiKey: 'fixture-api-key', secretKey: 'fixture-api-secret', passphrase: 'fixture-passphrase' }),
    signer() { signerCount++; throw Error('Must not reach parent signer'); }, getPrivateKey() { signerCount++; throw Error('Must not read private keys'); },
    redact: value => String(value).replace(/fixture-api-secret/g, '[REDACTED]'),
  };
  const engine = new Engine({ store, vault });
  const row = () => ({ asset: { ...structuredClone(asset), enabled: true }, stage: 'candidate', marketQualified: true, opportunityQualified: true, universe: { eligible: true },
    comparisonStatus: quarantined ? 'quarantined' : 'comparable', anomalous: quarantined, generation, observedAt: clock - (stale ? 120001 : 0) - sourceObservationShift,
    market: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { priceUsd: chain === 'bnb' ? .01 : .011, poolAddress: poolChanged && chain === 'bnb' ? '0x4444444444444444444444444444444444444444' : asset.chains[chain].poolAddress, priceConfidence: 'pool-consensus', observedAt: clock - (stale ? 120001 : 0) - sourceObservationShift }])) });
  const scanner = { enabled: true, busy: false, settings: { maxSideSkewMs: 30000 },
    getApprovedAsset(id) { assert.equal(id, asset.id); return structuredClone(asset); },
    assertComparisonUsable() { if (quarantined) throw Object.assign(Error('quarantined'), { safe: true }); },
    snapshot: () => ({ rows: [row()] }), executionCandidates: () => [row()], recordEvaluation() { writes++; throw Error('Cannot authorize readonly result'); },
  };
  let factoryArgs, quoteId = 0;
  const adapterFactory = args => {
    factoryArgs = args;
    return {
      async market(chain) { marketCount++; await options.onMarket?.(chain, { engine, scanner, vault, args }); return { connected: true, priceUsd: chain === 'bnb' ? .01 : (options.sellPrice ?? .011), liquidityUsd: 500000, updatedAt: new Date().toISOString() }; },
      async balances() { return { stableUsd: 100, nativeBalance: 1, tokenRaw: asRaw(10000, 9) }; },
      async quoteSwap({ chain, fromToken, toToken, amountRaw }) {
        quoteCount++; await options.onQuote?.({ engine, args, chain });
        const price = chain === 'bnb' ? .01 : (options.sellPrice ?? .011), buying = fromToken.kind === 'stable';
        const output = buying ? units(amountRaw, fromToken.decimals).div(price) : units(amountRaw, fromToken.decimals).mul(price);
        const amountOutRaw = asRaw(output, toToken.decimals), minOutRaw = new Decimal(amountOutRaw).mul(.995).floor().toFixed(0);
        return { id: `readonly-fixture-${++quoteId}`, kind: 'swap', fromChain: chain, toChain: chain, fromToken, toToken, amountInRaw: amountRaw,
          amountOutRaw, minOutRaw, sender: walletState[chain].address, recipient: walletState[chain].address,
          feeUsd: .002, bnbGas: chain === 'bnb' ? .000003 : 0, solFee: chain === 'solana' ? .00001 : 0, estimatedRentUsd: 0, priceImpactBps: 5,
          expiresAt: new Date(Date.now() + (options.ttl ?? 15000)).toISOString(), raw: { secretKey: 'fixture-api-secret' } };
      },
      submit() { submitCount++; throw Error('Never submit'); }, confirm() { submitCount++; throw Error('Never confirm'); },
    };
  };
  const quality = new OpportunityQualityService({ engine, scanner, now: () => clock, adapterFactory });
  t.after(async () => { quality.stop(); await quality.pending?.catch(() => {}); engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { quality, engine, scanner, store, vault, walletState,
    get counts() { return { quoteCount, marketCount, submitCount, signerCount, writes }; }, get factoryArgs() { return factoryArgs; },
    getAsset: () => structuredClone(asset), changeAsset: () => { asset.revision++; }, setStale: value => { stale = value; }, setQuarantined: value => { quarantined = value; }, setMissing: value => { missing = value; }, advance: ms => { clock += ms; },
    changeGeneration: () => { generation += '-changed'; }, changePool: () => { poolChanged = true; }, shiftSourceObservation: () => { sourceObservationShift++; },
  };
}

test('real readonly route check works with readonly addresses while preserving parent demo mode, no archive or authorization', async t => {
  const ctx = setup(t), before = JSON.stringify(ctx.store.config);
  const report = await ctx.quality.verify(ctx.getAsset().id);
  assert.equal(report.qualityPassed, true, report.reasons.join(';'));
  assert.equal(report.mode, 'live'); assert.equal(report.parentMode, 'demo');
  assert.equal(report.readOnly, true); assert.equal(report.executable, false); assert.equal(report.simulationVerified, false);
  assert.equal(report.closedInventory, false); assert.equal(report.includesRestockingCosts, false);
  assert.equal(report.status, 'passed'); assert(report.stressNetProfitUsd < report.netProfitUsd);
  assert.equal(ctx.counts.quoteCount, 2); assert.equal(ctx.counts.submitCount, 0); assert.equal(ctx.counts.signerCount, 0); assert.equal(ctx.counts.writes, 0);
  assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.store.stats().executions, 0); assert.equal(ctx.engine.config.mode, 'demo');
  assert.equal(ctx.engine.running, false); assert.equal(ctx.engine.busy, false); assert.equal(JSON.stringify(ctx.store.config), before);
  assert(!JSON.stringify(ctx.quality.snapshot()).includes('fixture-api-secret')); assert(!JSON.stringify(ctx.quality.snapshot()).includes('raw'));
});

test('readonly facade and adapter reject signing, browser requests and state mutations', async t => {
  const ctx = setup(t, { onQuote: ({ args }) => {
    assert.throws(() => args.vault.signer('bnb'), /只读/);
    assert.throws(() => args.vault.getPrivateKey('bnb'), /只读/);
    assert.throws(() => args.browserWallets.request('bnb', {}), /只读/);
    assert.throws(() => args.store.saveTrade({}), /只读/);
    assert.throws(() => args.store.setMeta('anything', {}), /只读/);
  } });
  await ctx.quality.verify(ctx.getAsset().id);
  const adapter = await ctx.quality.adapter(ctx.factoryArgs);
  assert.throws(() => adapter.submit({}), /只读/); assert.throws(() => adapter.confirm({}), /只读/); assert.throws(() => adapter.quoteTokenBridge({}), /只读/);
  assert.equal(ctx.counts.submitCount, 0); assert.equal(ctx.counts.signerCount, 0); assert.equal(ctx.store.allTrades().length, 0);
});

test('manual and automatic checks share durable 60-second budget, including failed prerequisite attempts', async t => {
  const ctx = setup(t, { missing: true }), id = ctx.getAsset().id;
  const blocked = await ctx.quality.verify(id); assert.equal(blocked.qualityPassed, false); assert.match(blocked.reasons.join(';'), /公开地址/);
  assert.equal(ctx.counts.marketCount, 0); assert.equal(ctx.counts.quoteCount, 0);
  ctx.setMissing(false); await assert.rejects(ctx.quality.verify(id), /60秒/);
  ctx.quality.setEnabled(true); await ctx.quality.tick(); assert.equal(ctx.counts.quoteCount, 0);
  const reboot = new OpportunityQualityService({ engine: ctx.engine, scanner: ctx.scanner });
  assert.equal(reboot.snapshot().enabled, true); await assert.rejects(reboot.verify(id), /60秒/); reboot.stop();
  ctx.advance(60001); await ctx.quality.tick(); assert.equal(ctx.counts.quoteCount, 2); assert.equal(ctx.store.allTrades().length, 0);
});

test('automatic verification is opt-in and never starts execution or enables parent trading', async t => {
  const ctx = setup(t);
  await ctx.quality.tick(); assert.equal(ctx.counts.quoteCount, 0);
  assert.equal(ctx.quality.snapshot().enabled, false); ctx.quality.setEnabled(true);
  await ctx.quality.tick(); assert.equal(ctx.counts.quoteCount, 2); assert.equal(ctx.counts.submitCount, 0);
  assert.equal(ctx.engine.running, false); assert.equal(ctx.engine.config.executionMode, 'bridge'); assert.equal(ctx.store.allTrades().length, 0);
  ctx.quality.setEnabled(false); ctx.advance(60001); await ctx.quality.tick(); assert.equal(ctx.counts.quoteCount, 2);
});

test('stale reference prices and quarantined pools are blocked before any route requests', async t => {
  const ctx = setup(t), id = ctx.getAsset().id;
  ctx.setStale(true); await assert.rejects(ctx.quality.verify(id), /过期/);
  ctx.setStale(false); ctx.setQuarantined(true); await assert.rejects(ctx.quality.verify(id), /quarantined/);
  assert.equal(ctx.counts.quoteCount, 0); assert.equal(ctx.counts.marketCount, 0); assert.equal(ctx.engine.busy, false);
});

for (const change of ['expiry', 'configRevision', 'policy', 'assetRevision', 'quarantine', 'generation', 'pool', 'sourceObservation', 'walletLock', 'walletAddress']) {
  test(`readonly quality lights cannot survive ${change}`, async t => {
    const ctx = setup(t), id = ctx.getAsset().id;
    const report = await ctx.quality.verify(id); assert.equal(report.qualityPassed, true, report.reasons.join(';'));
    if (change === 'expiry') ctx.advance(15001);
    if (change === 'configRevision') ctx.engine.configRevision++;
    if (change === 'policy') ctx.engine.config.risk.minProfitUsd += .01;
    if (change === 'assetRevision') ctx.changeAsset();
    if (change === 'quarantine') ctx.setQuarantined(true);
    if (change === 'generation') ctx.changeGeneration();
    if (change === 'pool') ctx.changePool();
    if (change === 'sourceObservation') ctx.shiftSourceObservation();
    if (change === 'walletLock') ctx.walletState.locked = true;
    if (change === 'walletAddress') ctx.walletState.bnb.address = '0x5555555555555555555555555555555555555555';
    const stale = ctx.quality.snapshot().reports[0]; assert.equal(stale.qualityPassed, false); assert.equal(stale.executable, false); assert.equal(stale.status, 'stale');
    assert.equal(ctx.counts.submitCount, 0);
  });
}

test('additional price and fee stress can reject a nominally profitable quote', async t => {
  const ctx = setup(t, { sellPrice: .0102 });
  const report = await ctx.quality.verify(ctx.getAsset().id);
  assert(report.netProfitUsd >= ctx.engine.config.risk.minProfitUsd);
  assert(report.stressNetProfitUsd < ctx.engine.config.risk.minProfitUsd);
  assert.equal(report.qualityPassed, false); assert.match(report.reasons.join(';'), /压力复核/); assert.equal(report.executable, false);
});

test('concurrent quote check owns parent mutex and releases it after errors without exposing secrets', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = setup(t, { onQuote: async () => { await gate; throw Object.assign(Error('secretKey=fixture-api-secret https://example.test/private-key'), { safe: true }); } });
  const id = ctx.getAsset().id, pending = ctx.quality.verify(id);
  assert.equal(ctx.engine.busy, true); await assert.rejects(ctx.quality.verify(id), /已有/); await assert.rejects(ctx.engine.saveConfig(ctx.store.config), /进行中/);
  release(); const report = await pending;
  assert.equal(report.qualityPassed, false); assert.equal(report.executable, false); assert.equal(ctx.engine.busy, false); assert.equal(ctx.quality.busy, false);
  assert(!JSON.stringify(report).includes('fixture-api-secret')); assert(!JSON.stringify(report).includes('https://example.test'));
});

test('in-flight asset or wallet revision changes invalidate the whole check', async t => {
  const ctx = setup(t, { onQuote: ({ engine }) => { engine.configRevision++; } });
  const report = await ctx.quality.verify(ctx.getAsset().id);
  assert.equal(report.qualityPassed, false); assert.equal(report.executable, false); assert.equal(ctx.counts.submitCount, 0); assert.equal(ctx.engine.busy, false);
});

test('clock rollback and pending review records prevent route requests', async t => {
  const ctx = setup(t), id = ctx.getAsset().id;
  await ctx.quality.verify(id); ctx.advance(-1); await assert.rejects(ctx.quality.verify(id), /时钟回退/);
  ctx.advance(60002); ctx.store.saveTrade({ id: 'pending-review', type: 'arbitrage', status: 'NEEDS_REVIEW', mode: 'demo' });
  await assert.rejects(ctx.quality.verify(id), /待人工核对/); assert.equal(ctx.counts.quoteCount, 2);
});

test('real readonly risk capacity uses live records even while parent remains demo', async t => {
  const ctx = setup(t), id = ctx.getAsset().id;
  ctx.engine.config.risk.maxExecutions = 1; ctx.store.setConfig(ctx.engine.config);
  ctx.store.saveTrade({ id: 'prior-live-attempt', type: 'arbitrage', mode: 'live', executionMode: 'inventory', status: 'REVIEWED' });
  ctx.store.reserveExecution('prior-live-attempt', 5);
  assert.equal(ctx.store.stats().executions, 0); assert.equal(ctx.store.stats('live').executions, 1);
  const report = await ctx.quality.verify(id);
  assert.equal(report.qualityPassed, false); assert.equal(report.executable, false); assert.match(report.reasons.join(';'), /执行次数上限/);
  assert.equal(ctx.engine.config.mode, 'demo'); assert.equal(ctx.store.allTrades().length, 1);
});

test('new pending review during readonly quote invalidates its result even without parent pausedReason', async t => {
  const ctx = setup(t, { onQuote: ({ engine }) => { engine.store.saveTrade({ id: 'arrived-review', type: 'arbitrage', mode: 'live', status: 'NEEDS_REVIEW' }); } });
  const report = await ctx.quality.verify(ctx.getAsset().id);
  assert.equal(report.qualityPassed, false); assert.equal(report.executable, false); assert.equal(ctx.engine.pausedReason, '');
  assert.equal(ctx.engine.busy, false); assert.equal(ctx.counts.submitCount, 0);
});

test('scheduler start is idempotent and chainable, stop does not change execution settings', t => {
  const ctx = setup(t);
  assert.equal(ctx.quality.start(), ctx.quality); const timer = ctx.quality.timer;
  assert.equal(ctx.quality.start(), ctx.quality); assert.equal(ctx.quality.timer, timer);
  ctx.quality.stop(); assert.equal(ctx.quality.timer, null); assert.equal(ctx.engine.running, false);
  assert.equal(ctx.quality.snapshot().enabled, false);
});

test('in-flight source generation and wallet lock changes invalidate readonly results', async t => {
  const ctx = setup(t, { onQuote: ({ scanner }) => { scanner.snapshot = () => ({ rows: [] }); } });
  const report = await ctx.quality.verify(ctx.getAsset().id);
  assert.equal(report.qualityPassed, false); assert.equal(ctx.engine.busy, false);
  assert.equal(ctx.counts.submitCount, 0);
});

test('locking OKX credentials during an in-flight quote invalidates its result', async t => {
  const ctx = setup(t, { onQuote: () => { ctx.walletState.locked = true; } });
  const report = await ctx.quality.verify(ctx.getAsset().id);
  assert.equal(report.qualityPassed, false); assert.equal(report.executable, false); assert.equal(ctx.counts.submitCount, 0); assert.equal(ctx.engine.busy, false);
});

test('concurrent scanner refresh invalidates old readonly quote instead of keeping its quality light', async t => {
  const ctx = setup(t, { onQuote: ({ scanner }) => { scanner.busy = true; } });
  const report = await ctx.quality.verify(ctx.getAsset().id);
  assert.equal(report.qualityPassed, false); assert.equal(report.executable, false); assert.equal(ctx.engine.busy, false);
});
