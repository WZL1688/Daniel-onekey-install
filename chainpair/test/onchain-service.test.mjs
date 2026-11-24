import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Decimal from 'decimal.js';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { ResearchStore } from '../src/onchain-research/store.mjs';
import { OnchainQuoteClient } from '../src/onchain-research/quotes.mjs';
import { OnchainPaperEngine } from '../src/onchain-research/paper.mjs';
import { OnchainResearchService } from '../src/onchain-research/service.mjs';

const copy = value => structuredClone(value);
const raw = (value, decimals) => new Decimal(value).mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
async function fixture(t, options = {}) {
  let clock = Date.parse('2026-11-24T08:00:00Z'), counter = 0;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onchain-service-')), store = new ResearchStore({ dataDir: dir, now: () => clock }), meta = new Map(), trades = [];
  const config = copy(DEFAULT_CONFIG), calls = [];
  const addresses = { bnb: '0x1111111111111111111111111111111111111111', solana: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr' };
  const wallets = { bnb: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mode: 'readonly' }, solana: { address: '11111111111111111111111111111111', mode: 'readonly' }, okxConfigured: true, locked: false };
  const engine = { config, configRevision: 0, busy: false, refreshing: false, configuring: false, quoteBuilders: 0, pausedReason: '', running: false,
    store: { getMeta: k => meta.get(k), setMeta: (k, v) => meta.set(k, copy(v)), allTrades: () => copy(trades), stats: () => ({ executions: 0, cumulativeUsd: 0 }), getReservedInventory: () => '0' },
    vault: { publicStatus: () => copy(wallets), redact: value => String(value), getOkxCredentials: () => ({ apiKey: 'fixture-only', secretKey: 'fixture-only', passphrase: 'fixture-only' }) },
    pause(reason) { this.running = false; calls.push(['pause', reason]); }, execute() { throw Error('Research must never execute live'); } };
  const asset = { id: 'manual:service-fixture', revision: 1, name: 'Offline fixture', symbol: 'FIX', enabled: true, mapping: { confirmed: true, evidence: 'Offline same-asset fixture only', warning: '' }, chains: {
    bnb: { address: addresses.bnb, decimals: 6, poolAddress: '0x2222222222222222222222222222222222222222' },
    solana: { address: addresses.solana, decimals: 9, poolAddress: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' } } };
  let row = makeRow('round-1');
  function makeRow(generation) { return { asset: copy(asset), generation, observedAt: clock, comparisonStatus: 'comparable', marketQualified: true, opportunityQualified: true, universe: { eligible: true }, buyChain: 'bnb', sellChain: 'solana', spreadBps: 2000,
    market: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { tokenAddress: addresses[chain], poolAddress: asset.chains[chain].poolAddress, observedAt: clock, priceUsd: chain === 'bnb' ? 1 : 1.2, priceConfidence: 'pool-consensus', liquidityUsd: 100000 }])) }; }
  const scanner = { busy: false, lastScanFailed: false, settings: { pollIntervalMs: 60000 }, snapshot: () => ({ updatedAt: row.observedAt, rows: [copy(row)], assets: [copy(asset)] }), assertComparisonUsable() { if (row.anomalous) throw Object.assign(new Error('价格异常'), { safe: true }); } };
  const client = new OnchainQuoteClient({ engine, now: () => clock, rateGate: { acquire: async () => {}, observe() {} }, adapterFactory: async ({ getConfig, vault }) => ({
    validateToken: async () => {},
    quoteSwap: async request => {
      calls.push(['quote', request]); await options.onQuote?.({ engine, scanner });
      const input = new Decimal(request.amountRaw).div(new Decimal(10).pow(request.fromToken.decimals)), stable = request.fromToken.kind === 'stable', price = row.market[request.chain].priceUsd;
      const output = raw(stable ? input.div(price).mul(.997) : input.mul(price).mul(.997), request.toToken.decimals), feeNative = .000001;
      return { id: 'offline-quote-' + ++counter, kind: 'swap', fromChain: request.chain, toChain: request.chain, sender: vault.publicStatus()[request.chain].address, recipient: vault.publicStatus()[request.chain].address,
        fromToken: request.fromToken, toToken: request.toToken, amountInRaw: request.amountRaw, amountOutRaw: output, minOutRaw: new Decimal(output).mul(.995).floor().toFixed(0),
        feeUsd: feeNative * getConfig().chains[request.chain].nativeUsd, estimatedRentUsd: 0, bnbGas: request.chain === 'bnb' ? feeNative : 0, solFee: request.chain === 'solana' ? feeNative : 0, priceImpactBps: 8,
        requestedAt: new Date(clock).toISOString(), receivedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 15000).toISOString() };
    }, submit() { throw Error('No live submit'); }, confirm() { throw Error('No live receipt'); }
  }) });
  const paper = new OnchainPaperEngine({ store, quoteClient: client, now: () => clock, sleep: async ms => { clock += ms; } });
  const service = new OnchainResearchService({ engine, scanner, store, quoteClient: client, paper, now: () => clock });
  t.after(async () => { service.stop(); if (service.pending) await service.pending; store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, store, paper, client, engine, scanner, asset, calls, trades, meta, row: () => copy(row), advance: ms => clock += ms, replaceRow: generation => { row = makeRow(generation); }, anomaly: () => { row.anomalous = true; row.comparisonStatus = 'quarantined'; } };
}

test('only successful new scanner generations write history; reads cannot manufacture observations', async t => {
  const ctx = await fixture(t); ctx.service.capture();
  assert.equal(ctx.service.snapshot().coverage.observations, 1);
  ctx.service.snapshot(); ctx.service.capture(); assert.equal(ctx.service.snapshot().coverage.observations, 1);
  ctx.advance(60000); ctx.replaceRow('round-2'); ctx.scanner.lastScanFailed = true; ctx.service.capture();
  assert.equal(ctx.service.snapshot().coverage.observations, 1);
  ctx.scanner.lastScanFailed = false; ctx.service.capture();
  assert.equal(ctx.service.snapshot().coverage.currentContinuousMs, 60000);
  assert.equal(ctx.service.snapshot().coverage.paperValidated, false);
});

test('both-direction amount matrix is queued without changing live settings, with active duplicate protection', async t => {
  const ctx = await fixture(t), before = JSON.stringify(ctx.engine.config); ctx.engine.busy = true;
  const result = ctx.service.requestMatrix({ assetId: ctx.asset.id, revision: 1 });
  assert.equal(result.jobs.length, 12); assert.equal(ctx.service.queue.length, 12);
  const duplicate = ctx.service.requestQuote({ assetId: ctx.asset.id, revision: 1, amountUsd: 50, buyChain: 'solana' }); assert.equal(duplicate.duplicate, true);
  assert.equal(JSON.stringify(ctx.engine.config), before); assert.equal(ctx.engine.running, false);
  ctx.engine.busy = false; await ctx.service.tick();
  assert.equal(ctx.store.list('quote').total, 1); assert.equal(ctx.service.queue.length, 11);
  assert.equal(ctx.engine.config.risk.amountUsd, 5);
});

test('real safe quote roundtrip can seed and run an isolated paper account without old trade writes', async t => {
  const ctx = await fixture(t); ctx.service.capture();
  const request = ctx.service.requestQuote({ assetId: ctx.asset.id, revision: 1, amountUsd: 5, buyChain: 'bnb' }); assert.equal(request.accepted, true);
  if (ctx.service.pending) await ctx.service.pending;
  const quote = ctx.store.list('quote').items[0]; assert.equal(quote.qualityPassed, true, quote.reasons.join(';'));
  ctx.service.paperStart({ assetId: ctx.asset.id, revision: 1 });
  const run = ctx.service.paperRun(); assert.equal(run.accepted, true); await ctx.service.pending;
  assert.equal(ctx.paper.snapshot().stats.completedTrades, 1);
  assert.equal(ctx.engine.store.allTrades().length, 0); assert.equal(ctx.engine.running, false);
  assert.equal(ctx.engine.config.mode, 'demo');
});

test('scan generation, policy and wallet changes invalidate current green state without rewriting quote history', async t => {
  const ctx = await fixture(t); ctx.service.capture(); ctx.service.requestQuote({ assetId: ctx.asset.id, revision: 1, amountUsd: 5, buyChain: 'bnb' }); await ctx.service.pending;
  assert.equal(ctx.service.snapshot().recentQuotes[0].qualityPassed, true);
  ctx.engine.configRevision++;
  assert.equal(ctx.service.snapshot().recentQuotes[0].qualityPassed, false);
  assert.equal(ctx.service.snapshot().rankings[0].currentQuotePassed, false);
  assert.equal(ctx.store.list('quote').items[0].qualityPassed, true, 'historical evidence is immutable');
  assert.throws(() => ctx.service.paperStart({ assetId: ctx.asset.id, revision: 1 }), /真实只读报价/);
});

test('global stop is persisted, survives clearing a UI reason and never resumes live or paper automatically', async t => {
  const ctx = await fixture(t); ctx.service.globalStop(); ctx.engine.pausedReason = '';
  assert.equal(ctx.service.snapshot().globalStop, true);
  assert.throws(() => ctx.service.requestQuote({ assetId: ctx.asset.id, revision: 1, amountUsd: 5, buyChain: 'bnb' }), /全局停止/);
  assert.throws(() => ctx.service.clearStop({ confirmed: false }), /明确确认/);
  ctx.trades.push({ status: 'NEEDS_REVIEW' }); assert.throws(() => ctx.service.clearStop({ confirmed: true }), /核对/); ctx.trades.pop();
  ctx.service.clearStop({ confirmed: true }); assert.equal(ctx.engine.running, false); assert.equal(ctx.paper.snapshot().running, false);
});

test('queue stale revisions, strict settings and job budgets block without signing', async t => {
  const ctx = await fixture(t); ctx.engine.busy = true;
  assert.throws(() => ctx.service.saveSettings({ amounts: [500] }), /设置无效/);
  assert.throws(() => ctx.service.requestQuote({ assetId: ctx.asset.id, revision: 0, amountUsd: 5, buyChain: 'bnb' }), /版本/);
  ctx.service.requestQuote({ assetId: ctx.asset.id, revision: 1, amountUsd: 20, buyChain: 'bnb' }); ctx.engine.configRevision++; ctx.engine.busy = false;
  await ctx.service.tick(); assert.equal(ctx.service.lastJob.status, 'blocked'); assert.equal(ctx.store.list('quote').total, 0);
  assert.equal(ctx.calls.filter(row => row[0] === 'quote').length, 0);
});
