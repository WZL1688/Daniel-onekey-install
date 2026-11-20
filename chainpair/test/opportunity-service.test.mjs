import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { Store } from '../src/store.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';

const initial = Date.parse('2026-11-20T08:00:00Z');
const bnb = '0x1111111111111111111111111111111111111111';
const otherBnb = '0x2222222222222222222222222222222222222222';
const bnbPool = '0x3333333333333333333333333333333333333333';
const bnbQuote = '0x4444444444444444444444444444444444444444';
const solana = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const otherSolana = 'So11111111111111111111111111111111111111112';
const solanaPool = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const chainDetails = { bnb: { address: bnb, decimals: 18, poolAddress: bnbPool }, solana: { address: solana, decimals: 6, poolAddress: solanaPool } };
const directory = patch => ({ id: 'coingecko:example', name: 'Example', symbol: 'SAME', source: 'coingecko', chains: { bnb: { address: bnb }, solana: { address: solana } }, ...patch });
function setup(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chainpair-opportunities-')), store = new Store(dir); let clock = initial;
  const calls = [], getConfig = () => store.config;
  const client = {
    discover: async () => { calls.push(['discover']); return [directory()]; },
    pools: async ({ chain, addresses }) => { calls.push(['pools', chain, addresses]); return addresses.map(address => ({ chain, tokenAddress: address, poolAddress: chain === 'bnb' ? bnbPool : solanaPool, quoteAddress: chain === 'bnb' ? bnbQuote : otherSolana, priceUsd: chain === 'bnb' ? .01 : .012, liquidityUsd: 50000, volume24hUsd: 100000, observedAt: clock, sourceUpdatedAt: null, dexId: chain === 'bnb' ? 'pancakeswap' : 'raydium' })); }, ...overrides,
  };
  const now = () => clock, sleep = async ms => { clock += ms; };
  const service = new OpportunityService({ store, client, getConfig, now, sleep });
  return { dir, store, service, client, calls, now, sleep, advance: ms => { clock += ms; }, setClock: value => { clock = value; },
    close: () => { service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function manual(ctx, patch = {}) { ctx.service.saveAsset({ name: 'Example', symbol: 'SAME', chains: chainDetails, ...patch }); return ctx.service.snapshot().assets.at(-1); }
function approve(ctx, id) { const asset = ctx.service.snapshot().assets.find(a => a.id === id); return ctx.service.approveAsset({ id, revision: asset.revision, confirmed: true, evidence: '已核对项目官方两链合约及1:1单位关系', chains: asset.chains }); }

test('manual registry requires valid addresses and explicit versioned identity approval', () => {
  const ctx = setup();
  try {
    const config = JSON.stringify(ctx.store.config), asset = manual(ctx);
    assert.equal(asset.mapping.confirmed, false); assert.throws(() => ctx.service.getApprovedAsset(asset.id));
    assert.throws(() => ctx.service.approveAsset({ id: asset.id, confirmed: true, evidence: 'yes', chains: chainDetails }), /刷新/);
    assert.throws(() => ctx.service.approveAsset({ id: asset.id, revision: asset.revision, confirmed: true, evidence: '', chains: chainDetails }), /依据/);
    approve(ctx, asset.id); const approved = ctx.service.getApprovedAsset(asset.id);
    assert.equal(approved.chains.bnb.address, bnb); assert(Object.isFrozen(approved.chains));
    assert.throws(() => { approved.chains.bnb.address = otherBnb; });
    ctx.service.saveAsset({ id: asset.id, chains: { bnb: { address: otherBnb } }, secretKey: 'never-keep-this-field' });
    assert.throws(() => ctx.service.getApprovedAsset(asset.id));
    assert.equal(JSON.stringify(ctx.service.snapshot()).includes('never-keep-this-field'), false);
    assert.throws(() => ctx.service.saveAsset({ chains: { bnb: { address: 'bad' }, solana: { address: solana } } }), /地址/);
    assert.throws(() => ctx.service.saveAsset({ chains: { ...chainDetails, solana: { ...chainDetails.solana, decimals: 10 } } }), /精度/);
    assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.allTrades().length, 0);
  } finally { ctx.close(); }
});

test('automatic directory is candidate evidence, preserves manual details, and revokes source address changes without repointing', async () => {
  const ctx = setup();
  try {
    await ctx.service.discover(); let asset = ctx.service.snapshot().assets[0];
    assert.equal(asset.id, 'coingecko:example'); assert.equal(asset.chains.bnb.decimals, null); assert.equal(asset.mapping.confirmed, false);
    ctx.service.saveAsset({ id: asset.id, chains: chainDetails }); approve(ctx, asset.id);
    const revision = ctx.service.getApprovedAsset(asset.id).revision;
    ctx.advance(6 * 3600000); await ctx.service.discover();
    assert.equal(ctx.service.getApprovedAsset(asset.id).revision, revision); assert.equal(ctx.service.getApprovedAsset(asset.id).chains.solana.decimals, 6);
    ctx.client.discover = async () => [directory({ chains: { bnb: { address: otherBnb }, solana: { address: solana } } })];
    ctx.advance(6 * 3600000); await ctx.service.discover(); asset = ctx.service.snapshot().assets[0];
    assert.equal(asset.chains.bnb.address, bnb); assert.equal(asset.sourceProposal.bnb, otherBnb); assert.equal(asset.mapping.confirmed, false);
    assert.match(asset.mapping.warning, /地址已变化/); assert.throws(() => ctx.service.getApprovedAsset(asset.id));
    assert.throws(() => ctx.service.approveAsset({ id: asset.id, revision, confirmed: true, evidence: 'stale form', chains: chainDetails }), /刷新/);
  } finally { ctx.close(); }
});

test('duplicate chain identities cannot be approved by matching names or metadata alone', () => {
  const ctx = setup();
  try {
    const first = manual(ctx), second = manual(ctx, { symbol: 'DIFFERENT' });
    assert.notEqual(first.id, second.id); assert.throws(() => approve(ctx, first.id), /冲突/);
    ctx.service.saveAsset({ id: second.id, enabled: false }); approve(ctx, first.id);
    assert.equal(ctx.service.getApprovedAsset(first.id).id, first.id);
    ctx.service.removeAsset(first.id); assert.throws(() => ctx.service.getApprovedAsset(first.id));
  } finally { ctx.close(); }
});

test('same-scan two-chain prices produce only indicative candidates with unknown costs, no automatic buy', async () => {
  const ctx = setup();
  try {
    const asset = manual(ctx); await ctx.service.setEnabled(true);
    let row = ctx.service.snapshot().rows[0];
    assert.equal(row.stage, 'needs_mapping'); assert.equal(row.buyChain, 'bnb'); assert.equal(row.sellChain, 'solana');
    assert(Math.abs(row.spreadBps - 2000) < 1e-8); assert.equal(row.feeStatus, 'unknown'); assert.equal(row.executable, false);
    assert.equal(row.safety, 'unverified'); assert.equal(row.sourceUpdateStatus, 'provider-timestamp-unavailable'); assert.equal(ctx.service.executionCandidates().length, 0);
    approve(ctx, asset.id); await ctx.service.scan(); row = ctx.service.snapshot().rows[0];
    assert.equal(row.stage, 'candidate'); assert.equal(row.executable, false); assert.equal(ctx.service.executionCandidates().length, 1);
    assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.store.config.mode, 'demo'); assert.equal(ctx.calls.filter(c => c[0] === 'pools').length, 4);
  } finally { ctx.close(); }
});

test('fixed freshness, missing liquidity, changed approved pools and partial scans block candidates', async () => {
  const ctx = setup();
  try {
    const asset = manual(ctx); approve(ctx, asset.id); await ctx.service.setEnabled(true);
    ctx.service.saveSettings({ pollIntervalMs: 3600000 }); ctx.advance(120001);
    assert.equal(ctx.service.snapshot().rows[0].stage, 'blocked'); assert.equal(ctx.service.executionCandidates().length, 0);
    ctx.client.pools = async ({ chain, addresses }) => addresses.map(tokenAddress => ({ chain, tokenAddress, poolAddress: chain === 'bnb' ? bnbPool : solanaPool, quoteAddress: chain === 'bnb' ? bnbQuote : otherSolana, priceUsd: chain === 'bnb' ? .01 : .012, liquidityUsd: null, observedAt: ctx.now() }));
    await ctx.service.scan(); assert.equal(ctx.service.snapshot().rows[0].stage, 'blocked'); assert.match(ctx.service.snapshot().rows[0].reasons.join(), /流动性/);
    ctx.client.pools = async ({ chain }) => { if (chain === 'solana') throw new Error('raw-provider-body'); return []; };
    await ctx.service.scan(); assert.equal(ctx.service.executionCandidates().length, 0); assert.match(ctx.service.snapshot().rows[0].reasons.join(), /未完成/);
    assert.equal(JSON.stringify(ctx.service.snapshot()).includes('raw-provider-body'), false);
  } finally { ctx.close(); }
});

test('persisted cache is timestamped and disabled after restart; approval survives unchanged addresses', async () => {
  const ctx = setup();
  try {
    const asset = manual(ctx); approve(ctx, asset.id); await ctx.service.setEnabled(true);
    const observed = ctx.service.snapshot().rows[0].observedAt, count = ctx.service.snapshot().usage.total;
    ctx.advance(120001);
    const restarted = new OpportunityService({ store: ctx.store, client: ctx.client, now: ctx.now, sleep: ctx.sleep });
    assert.equal(restarted.enabled, false); assert.equal(restarted.snapshot().rows[0].observedAt, observed); assert.equal(restarted.snapshot().rows[0].stage, 'blocked');
    assert.equal(restarted.snapshot().usage.total, count); assert.equal(restarted.getApprovedAsset(asset.id).id, asset.id); assert.equal(restarted.executionCandidates().length, 0); restarted.stop();
  } finally { ctx.close(); }
});

test('exact quote evaluation exposes only bounded public fields and expires; missing fees cannot become executable', async () => {
  const ctx = setup();
  try {
    const asset = manual(ctx); approve(ctx, asset.id); await ctx.service.setEnabled(true);
    ctx.service.recordEvaluation(asset.id, { executable: true, amountUsd: 5, netProfitUsd: 1, buyChain: 'bnb', sellChain: 'solana', expiresAt: new Date(ctx.now() + 15000).toISOString(), raw: { privateKey: 'never-expose' } });
    assert.equal(ctx.service.snapshot().rows[0].executable, false); assert.equal(JSON.stringify(ctx.service.snapshot()).includes('never-expose'), false);
    ctx.service.recordEvaluation(asset.id, { executable: true, amountUsd: 5, netProfitUsd: .1, gasUsd: .02, slippageUsd: .01, priceImpactBps: 5, buyChain: 'bnb', sellChain: 'solana', expiresAt: new Date(ctx.now() + 15000).toISOString() });
    assert.equal(ctx.service.snapshot().rows[0].executable, true);
    ctx.advance(15001); assert.equal(ctx.service.snapshot().rows[0].executable, false);
  } finally { ctx.close(); }
});

test('persistent pre-dispatch requests include failures, six-hour directory cooldown and shared cross-instance quotas', async () => {
  let ctx;
  ctx = setup({ discover: async () => { assert.equal(ctx.store.getMeta('opportunities.budget.v1').total, 1); throw new Error('private-api-key=do-not-echo'); } });
  let secondStore;
  try {
    await ctx.service.discover(); await ctx.service.discover();
    assert.equal(ctx.service.snapshot().usage.total, 1); assert.equal(JSON.stringify(ctx.service.snapshot()).includes('do-not-echo'), false);
    secondStore = new Store(ctx.dir);
    const second = new OpportunityService({ store: secondStore, client: ctx.client, now: ctx.now, sleep: ctx.sleep });
    await second.discover(); assert.equal(second.snapshot().usage.total, 1);
    ctx.advance(6 * 3600000); await second.discover(); assert.equal(ctx.service.snapshot().usage.total, 2);
    ctx.setClock(initial - 1); assert.match(ctx.service.snapshot().reason, /时钟回退/); second.stop();
  } finally { secondStore?.close(); ctx.close(); }
});

test('429 persists backoff, auth rejection stops automatic scans, and failed second leg cannot mix old/new prices', async () => {
  const ctx = setup({ discover: async () => { throw Object.assign(new Error('untrusted body'), { code: 'DISCOVERY_RATE_LIMIT', retryAfterMs: 3600000 }); } });
  try {
    await ctx.service.discover(); assert.equal(ctx.service.snapshot().nextRequestAt, initial + 3600000);
    assert.equal(ctx.service.snapshot().usage.total, 1);
    const restart = new OpportunityService({ store: ctx.store, client: ctx.client, now: ctx.now, sleep: ctx.sleep }); assert.equal(restart.snapshot().nextRequestAt, initial + 3600000); restart.stop();
    ctx.advance(3600000); manual(ctx); ctx.client.pools = async () => { throw Object.assign(new Error('key and secret'), { code: 'DISCOVERY_AUTH' }); };
    await ctx.service.setEnabled(true); assert.equal(ctx.service.enabled, false); assert.match(ctx.service.snapshot().reason, /账户权限/);
    assert.equal(JSON.stringify(ctx.service.snapshot()).includes('key and secret'), false);
  } finally { ctx.close(); }
});

test('registry mutations abort late scans and concurrent scan/discovery calls cannot duplicate network requests', async () => {
  let finish;
  const ctx = setup({ pools: async () => new Promise(resolve => { finish = resolve; }) });
  try {
    const asset = manual(ctx), scanning = ctx.service.scan();
    await ctx.service.scan(); await ctx.service.discover(); assert.equal(ctx.service.snapshot().usage.total, 1);
    ctx.service.saveAsset({ id: asset.id, name: 'Changed while pending' });
    finish([{ chain: 'bnb', tokenAddress: bnb, poolAddress: bnbPool, quoteAddress: bnbQuote, priceUsd: .01, liquidityUsd: 50000, observedAt: ctx.now() }]);
    await scanning; assert.equal(ctx.service.snapshot().rows[0].market.bnb, null); assert.equal(ctx.service.busy, false);
  } finally { ctx.close(); }
});

test('round-robin scans batch at most30 addresses and preserve a global request budget', async () => {
  const ctx = setup();
  try {
    for (let i = 1; i <= 65; i++) manual(ctx, { chains: { bnb: { address: `0x${i.toString(16).padStart(40, '0')}` }, solana: { address: new PublicKey(Uint8Array.from({ length: 32 }, (_, p) => p === 31 ? i : 0)).toBase58() } } });
    await ctx.service.scan(); await ctx.service.scan();
    const requests = ctx.calls.filter(call => call[0] === 'pools');
    assert.equal(requests.length, 4); assert(requests.every(call => call[2].length === 30));
    assert.notDeepEqual(requests[0][2], requests[2][2]); assert.equal(ctx.service.snapshot().usage.total, 4);
    ctx.service.saveSettings({ maxRequestsPerDay: 4 }); await ctx.service.scan(); assert.equal(ctx.service.snapshot().usage.total, 4); assert.match(ctx.service.snapshot().reason, /预算/);
    assert.throws(() => ctx.service.saveSettings({ pollIntervalMs: 29999 })); assert.throws(() => ctx.service.saveSettings({ endpoint: 'https://untrusted.invalid' }));
  } finally { ctx.close(); }
});
