import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { normalizeToken } from '../src/radar/ave.mjs';
import { RadarService } from '../src/radar/service.mjs';
import { RadarBudget, AVE_MIN_GAP_MS } from '../src/radar/budget.mjs';
import { DEFAULT_RADAR_SETTINGS as defaults, validateRadarSettings, filterRadarToken } from '../src/radar/settings.mjs';

const initial = Date.parse('2026-11-19T06:00:00Z');
const address = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const fixture = (at, patch = {}) => normalizeToken({ token: address, chain: 'bsc', name: 'Observation', symbol: 'OBS', current_price_usd: '.01', main_pair_tvl: '30000', market_cap: '100000', token_tx_volume_usd_5m: '8000', holders: '500', created_at: (at - 86400000) / 1000, updated_at: at / 1000, is_honeypot: false, ...patch }, 'bnb', { observedAt: at });
function setup(client = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'radar-service-'));
  const store = new Store(dir); let clock = initial, locked = false, configured = true, calls = 0;
  const vault = { publicStatus: () => ({ aveConfigured: configured }), getAveCredentials: () => configured && !locked ? { apiKey: 'fixture-ave-key-only' } : null, redact: s => s.replaceAll('fixture-ave-key-only', '[REDACTED]') };
  const adapter = { ranks: async () => { calls++; return [fixture(clock)]; }, contracts: async () => { calls++; return { status: 'unknown', flags: [], checkedAt: clock, source: 'AVE contracts', unknowns: ['尚未核验'] }; }, ...client };
  const service = new RadarService({ store, vault, client: adapter, now: () => clock });
  return { dir, store, vault, service, adapter, now: () => clock, advance: ms => { clock += ms; }, setClock: at => { clock = at; }, setLocked: b => { locked = b; }, setConfigured: b => { configured = b; }, calls: () => calls,
    close: () => { service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('radar settings reject hidden control fields, nonfinite values and invalid ranges', () => {
  assert.deepEqual(validateRadarSettings(), defaults);
  for (const patch of [{ chain: 'eth' }, { pollIntervalMs: 299999 }, { minLiquidityUsd: NaN }, { minHolders: 1.1 }, { maxRequestsPerHour: 13 }, { apiKey: 'never-store' }, { minMarketCapUsd: 200, maxMarketCapUsd: 100 }, { minAgeMinutes: 100, maxAgeHours: 1 }]) assert.throws(() => validateRadarSettings(patch));
  assert.equal(validateRadarSettings({ chain: 'solana' }).minLiquidityUsd, defaults.minLiquidityUsd);
});

test('market filter never certifies safety and missing required values cannot pass as zero', () => {
  const token = fixture(initial);
  assert.equal(filterRadarToken(token, defaults, initial).status, 'candidate');
  assert.equal(filterRadarToken(token, defaults, initial).safety, 'unverified');
  for (const field of ['priceUsd', 'liquidityUsd', 'marketCapUsd', 'volume5mUsd', 'holders', 'createdAt', 'sourceUpdatedAt']) assert.equal(filterRadarToken({ ...token, [field]: null }, defaults, initial).status, 'insufficient', field);
  assert.equal(filterRadarToken({ ...token, priceUsd: 0 }, defaults, initial).status, 'excluded');
  assert.equal(filterRadarToken({ ...token, conflict: true }, defaults, initial).status, 'excluded');
  assert.equal(filterRadarToken({ ...token, risk: { status: 'flagged', flags: ['卖出限制'] } }, defaults, initial).status, 'excluded');
  assert.equal(filterRadarToken(token, defaults, initial + 600001).status, 'excluded');
  assert.equal(filterRadarToken(token, { ...defaults, pollIntervalMs: 86400000 }, initial + 47 * 3600000).status, 'excluded');
  assert.equal(filterRadarToken({ ...token, sourceUpdatedAt: initial - 900000 }, defaults, initial).status, 'excluded');
});

test('all dispatches share durable rolling budgets and cooldown, including failures and restarts', async () => {
  const ctx = setup({ ranks: async () => { throw new Error('fixture-ave-key-only raw provider body'); } });
  try {
    await ctx.service.refresh();
    let state = ctx.service.snapshot();
    assert.equal(state.usage.lifetime, 1); assert.equal(state.usage.hour, 1);
    assert.equal(JSON.stringify(state).includes('fixture-ave-key-only'), false);
    await ctx.service.refresh(); assert.equal(ctx.service.snapshot().usage.lifetime, 1);
    const restarted = new RadarService({ store: ctx.store, vault: ctx.vault, client: ctx.adapter, now: ctx.now });
    assert.equal(restarted.snapshot().enabled, false);
    assert.equal(restarted.snapshot().usage.lifetime, 1);
    assert.equal(restarted.snapshot().nextRequestAt, initial + AVE_MIN_GAP_MS);
    restarted.credentialsChanged(); assert.equal(restarted.snapshot().usage.lifetime, 1);
    ctx.advance(AVE_MIN_GAP_MS); await restarted.refresh(); assert.equal(restarted.snapshot().usage.lifetime, 2);
    ctx.advance(86400001); assert.equal(restarted.snapshot().usage.day, 0); assert.equal(restarted.snapshot().usage.lifetime, 2);
    restarted.stop();
  } finally { ctx.close(); }
});

test('budget failure is recorded before client executes, tighter limits and clock rollback fail closed', async () => {
  const ctx = setup();
  try {
    let called = 0;
    ctx.service.client.ranks = async () => { called++; assert.equal(ctx.store.getMeta('radar.budget.v1').lifetime, 1); return [fixture(ctx.now())]; };
    ctx.service.saveSettings({ maxRequestsPerHour: 1 });
    await ctx.service.refresh(); ctx.advance(AVE_MIN_GAP_MS); await ctx.service.refresh();
    assert.equal(called, 1); assert.match(ctx.service.snapshot().reason, /1小时/);
    ctx.advance(3600000); assert.equal(ctx.service.budget.check(ctx.service.settings).allowed, true);
    ctx.setClock(initial - 1); assert.equal(ctx.service.budget.check(ctx.service.settings).allowed, false); assert.match(ctx.service.snapshot().reason, /时间回退/);
    ctx.setClock(initial + 3600000); ctx.service.saveSettings({ maxRequestsLifetime: 1 });
    assert.match(ctx.service.snapshot().reason, /累计/);
  } finally { ctx.close(); }
});

test('429 backoff persists and auth errors disable auto scanning without leaking provider errors', async () => {
  const ctx = setup({ ranks: async () => { throw Object.assign(new Error('do-not-echo'), { code: 'AVE_RATE_LIMIT', retryAfterMs: 7200000 }); } });
  try {
    await ctx.service.setEnabled(true); assert.equal(ctx.service.snapshot().nextRequestAt, initial + 7200000);
    assert.equal(ctx.service.snapshot().lastError.includes('do-not-echo'), false);
    const restartedBudget = new RadarBudget({ store: ctx.store, now: ctx.now }); assert.equal(restartedBudget.state.nextAt, initial + 7200000);
    ctx.advance(7200000); ctx.service.client.ranks = async () => { throw Object.assign(new Error('key=bad'), { code: 'AVE_AUTH' }); };
    await ctx.service.refresh(); assert.equal(ctx.service.enabled, false); assert.match(ctx.service.snapshot().reason, /鉴权/);
    ctx.advance(AVE_MIN_GAP_MS); ctx.service.client.ranks = async () => { throw Object.assign(new Error('raw provider rejection'), { code: 'AVE_REJECTED' }); };
    await ctx.service.setEnabled(true); assert.equal(ctx.service.enabled, false); assert.match(ctx.service.snapshot().reason, /拒绝/);
  } finally { ctx.close(); }
});

test('disabled/unconfigured state makes no network calls; scan is independent from all trading state', async () => {
  const ctx = setup();
  try {
    const config = JSON.stringify(ctx.store.config), trades = ctx.store.listTrades().total;
    await ctx.service.tick(); assert.equal(ctx.calls(), 0); assert.equal(ctx.service.snapshot().tokens.length, 0);
    ctx.setConfigured(false); assert.equal(ctx.service.snapshot().status, 'unconfigured'); await assert.rejects(ctx.service.refresh(), /配置/);
    ctx.setConfigured(true); ctx.setLocked(true); await assert.rejects(ctx.service.setEnabled(true), /解锁/);
    ctx.setLocked(false); await ctx.service.setEnabled(true); assert.equal(ctx.calls(), 1);
    assert.equal(ctx.store.config.mode, 'demo'); assert.equal(JSON.stringify(ctx.store.config), config); assert.equal(ctx.store.listTrades().total, trades);
    const state = ctx.service.snapshot(); assert.equal(state.tokens[0].risk.status, 'unknown'); assert.equal(state.tokens[0].decision.status, 'candidate');
    assert.equal(state.tokens[0].aveUrl.includes('ref='), false);
  } finally { ctx.close(); }
});

test('parallel refresh/risk cannot spend extra quota; settings/credential changes discard inflight data', async () => {
  let finish;
  const ctx = setup({ ranks: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const first = ctx.service.refresh();
    await ctx.service.refresh(); assert.equal(ctx.service.snapshot().usage.lifetime, 1);
    ctx.service.saveSettings({ chain: 'solana' }); finish([fixture(initial)]); await first;
    assert.equal(ctx.service.snapshot().tokens.length, 0); assert.equal(ctx.service.cache.bnb.length, 0);
    ctx.service.saveSettings({ chain: 'bnb' }); ctx.advance(AVE_MIN_GAP_MS);
    const second = ctx.service.refresh(); ctx.setLocked(true); ctx.service.credentialsChanged(); finish([fixture(ctx.now())]); await second;
    assert.equal(ctx.service.cache.bnb.length, 0); assert.equal(ctx.service.enabled, false); assert.equal(ctx.service.snapshot().usage.lifetime, 2);
  } finally { ctx.close(); }
});

test('conflicting records quarantine an identity and exact duplicates do not erase retained risk', async () => {
  const ctx = setup();
  try {
    ctx.service.client.ranks = async () => [fixture(ctx.now()), fixture(ctx.now(), { current_price_usd: '.02' }), fixture(ctx.now(), { token: other })];
    await ctx.service.refresh(); const state = ctx.service.snapshot();
    assert.equal(state.tokens.length, 2); assert.equal(state.tokens[0].decision.status, 'excluded'); assert.equal(state.tokens[0].conflict, true);
    ctx.advance(AVE_MIN_GAP_MS); ctx.service.client.ranks = async () => [fixture(ctx.now()), fixture(ctx.now())];
    await ctx.service.refresh(); assert.equal(ctx.service.snapshot().tokens[0].conflict, false);
    ctx.advance(AVE_MIN_GAP_MS); ctx.service.client.contracts = async () => ({ flags: ['存在卖出限制'], checkedAt: ctx.now(), source: 'AVE contracts', unknowns: [] });
    await ctx.service.checkRisk({ chain: 'bnb', address }); assert.equal(ctx.service.snapshot().tokens[0].risk.status, 'flagged');
    ctx.advance(AVE_MIN_GAP_MS); await ctx.service.refresh(); assert.equal(ctx.service.snapshot().tokens[0].conflict, false); assert.equal(ctx.service.snapshot().tokens[0].decision.status, 'excluded');
    ctx.advance(AVE_MIN_GAP_MS); ctx.service.client.contracts = async () => ({ flags: [], checkedAt: ctx.now(), source: 'AVE contracts', unknowns: [] });
    await ctx.service.checkRisk({ chain: 'bnb', address }); assert.equal(ctx.service.snapshot().tokens[0].risk.status, 'flagged');
    await assert.rejects(ctx.service.checkRisk({ chain: 'bnb', address: other }), /已扫描/);
  } finally { ctx.close(); }
});

test('watch notes persist locally, do not reset quotas, and old cache retains original fetch times', async () => {
  const ctx = setup();
  try {
    await ctx.service.refresh(); ctx.service.toggleWatch({ chain: 'bnb', address });
    ctx.service.toggleWatch({ chain: 'bnb', address, note: '只观察，不签名 <script>test</script>' });
    assert.equal(ctx.service.snapshot().tokens[0].watched, true);
    assert.match(ctx.service.snapshot().tokens[0].note, /只观察/);
    ctx.advance(AVE_MIN_GAP_MS); ctx.service.client.ranks = async () => []; await ctx.service.refresh();
    assert.equal(ctx.service.snapshot().tokens.length, 1); assert.equal(ctx.service.snapshot().tokens[0].observedAt, initial);
    ctx.advance(600001);
    const restarted = new RadarService({ store: ctx.store, vault: ctx.vault, client: ctx.adapter, now: ctx.now });
    assert.equal(restarted.snapshot().tokens[0].decision.status, 'excluded'); assert.equal(restarted.snapshot().tokens[0].watched, true);
    assert.equal(restarted.snapshot().usage.lifetime, 2); assert.equal(restarted.enabled, false);
    restarted.toggleWatch({ chain: 'bnb', address }); assert.equal(restarted.snapshot().tokens.length, 0); restarted.stop();
  } finally { ctx.close(); }
});

test('corrupt durable budget fails closed instead of silently granting a fresh allowance', () => {
  const ctx = setup();
  try { ctx.store.setMeta('radar.budget.v1', { lifetime: -1, requests: [], lastClock: 0, nextAt: 0 }); assert.throws(() => new RadarBudget({ store: ctx.store, now: ctx.now }), /损坏/); }
  finally { ctx.close(); }
});

test('known risk warnings survive ranking rotation, watch removal, and service restart', async () => {
  const ctx = setup();
  try {
    await ctx.service.refresh(); ctx.advance(AVE_MIN_GAP_MS);
    ctx.service.client.contracts = async () => ({ flags: ['存在卖出限制'], checkedAt: ctx.now(), source: 'AVE contracts', unknowns: [] });
    await ctx.service.checkRisk({ chain: 'bnb', address });
    ctx.service.toggleWatch({ chain: 'bnb', address }); ctx.service.toggleWatch({ chain: 'bnb', address });
    ctx.advance(AVE_MIN_GAP_MS); ctx.service.client.ranks = async () => []; await ctx.service.refresh();
    assert.equal(ctx.service.cache.bnb.length, 0);
    ctx.advance(AVE_MIN_GAP_MS); ctx.service.client.ranks = async () => [fixture(ctx.now())];
    const restarted = new RadarService({ store: ctx.store, vault: ctx.vault, client: ctx.service.client, now: ctx.now });
    await restarted.refresh();
    assert.equal(restarted.snapshot().tokens[0].decision.status, 'excluded');
    assert.deepEqual(restarted.snapshot().tokens[0].risk.flags, ['存在卖出限制']); restarted.stop();
  } finally { ctx.close(); }
});

test('a conflicting duplicate after the first30 rows still isolates the original identity', async () => {
  const ctx = setup();
  try {
    ctx.service.client.ranks = async () => [fixture(ctx.now()), ...Array.from({ length: 29 }, (_, i) => fixture(ctx.now(), { token: `0x${(i + 50).toString(16).padStart(40, '0')}` })), fixture(ctx.now(), { current_price_usd: '.09' })];
    await ctx.service.refresh(); assert.equal(ctx.service.snapshot().tokens.length, 30); assert.equal(ctx.service.snapshot().tokens[0].conflict, true);
  } finally { ctx.close(); }
});

test('two local instances share atomic request reservations and cannot overwrite each other’s cooldown', () => {
  const ctx = setup(), secondStore = new Store(ctx.dir);
  try {
    const first = new RadarBudget({ store: ctx.store, now: ctx.now }), second = new RadarBudget({ store: secondStore, now: ctx.now });
    assert.equal(first.reserve(defaults).allowed, true);
    assert.equal(second.reserve(defaults).allowed, false); assert.equal(second.usage().lifetime, 1);
    second.backoff(7200000); assert.equal(first.check(defaults).nextAt, initial + 7200000);
    ctx.advance(7200000); assert.equal(first.reserve(defaults).allowed, true); assert.equal(second.usage().lifetime, 2);
  } finally { secondStore.close(); ctx.close(); }
});
