import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { OpportunityService } from '../src/opportunities/service.mjs';
import { DiscoveryClient } from '../src/opportunities/sources.mjs';
import { startLocalServer } from '../src/server.mjs';

const INITIAL = Date.parse('2026-11-22T08:00:00Z');
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const WSOL = 'So11111111111111111111111111111111111111112';
const KEY = 'diagnostic-key-must-stay-local';
const CHAINS = {
  bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' },
  solana: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, poolAddress: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
};
const directoryResult = () => [{ id: 'coingecko:diagnostic-only', name: 'Must not be imported by diagnostics', symbol: 'PROBE', source: 'coingecko', chains: CHAINS }];

function setup(t, { client: clientOverrides = {}, saveSettings, vault: vaultOverrides = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chainpair-network-service-'));
  const store = new Store(dir), calls = [], networkSaves = [], walletCalls = [];
  let clock = INITIAL;
  let route = { mode: 'auto', proxyUrl: '', effectiveRoute: 'direct', proxyDetected: false, routeLabel: 'Direct fixture', reason: 'Read-only fixture', lastDetectedAt: null };
  const network = {
    snapshot: () => structuredClone(route),
    saveSettings: async patch => {
      networkSaves.push(structuredClone(patch));
      if (saveSettings) await saveSettings(patch);
      route = { ...route, ...patch, effectiveRoute: patch.mode === 'proxy' ? 'manual' : 'direct' };
      return network.snapshot();
    },
  };
  const track = (kind, options) => {
    calls.push({ kind, options, reserved: store.getMeta('opportunities.budget.v1')?.total || 0 });
  };
  const client = {
    discover: async options => { track('directory', options); return directoryResult(); },
    pools: async options => {
      track(options.chain, options);
      return options.addresses.map(tokenAddress => ({ chain: options.chain, tokenAddress, poolAddress: CHAINS[options.chain].poolAddress,
        quoteAddress: options.chain === 'bnb' ? '0x4444444444444444444444444444444444444444' : WSOL,
        priceUsd: options.chain === 'bnb' ? .01 : .012, liquidityUsd: 100000, volume24hUsd: 500000, observedAt: clock, dexId: 'fixture' }));
    },
    ...clientOverrides,
  };
  const vault = {
    publicStatus: () => ({ coingeckoConfigured: true }),
    getCoinGeckoCredentials: () => ({ apiKey: KEY }),
    getPrivateKey: () => { walletCalls.push('getPrivateKey'); throw new Error('Diagnostics must not use a signing key'); },
    ...vaultOverrides,
  };
  const service = new OpportunityService({ store, client, network, vault, now: () => clock, sleep: async ms => { clock += ms; } });
  t.after(() => { service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, client, network, calls, networkSaves, walletCalls, now: () => clock, advance: ms => { clock += ms; } };
}

function addAsset(ctx, { approve = false } = {}) {
  const saved = ctx.service.saveAsset({ name: 'Existing asset', symbol: 'SAME', chains: CHAINS });
  const asset = saved.assets.at(-1);
  if (approve) ctx.service.approveAsset({ id: asset.id, revision: asset.revision, confirmed: true, evidence: 'Fixture identity reviewed', chains: CHAINS });
  return asset.id;
}

function tradingState(ctx) {
  return {
    config: ctx.store.config,
    trades: ctx.store.allTrades(),
    registry: ctx.store.getMeta('opportunities.registry.v1'),
    marketCache: ctx.store.getMeta('opportunities.market.v1'),
    evaluations: structuredClone(ctx.service.evaluations),
    enabled: ctx.service.enabled,
    autoScanPreferred: ctx.service.autoScanPreferred,
  };
}

const requestLedger = store => {
  const { directoryNextAt, ...ledger } = store.getMeta('opportunities.budget.v1');
  return ledger;
};

test('network snapshot exposes current read-only transport settings with idle diagnostic state', t => {
  const ctx = setup(t), snapshot = ctx.service.snapshot();
  assert.deepEqual(snapshot.network, { ...ctx.network.snapshot(), diagnostics: [], testing: false, lastTestAt: null, nextTestAt: null });
  assert.equal(ctx.calls.length, 0);
  assert.equal(snapshot.usage.total, 0);
  assert.equal(JSON.stringify(snapshot).includes(KEY), false);
});

test('network test reserves its three public reads and cannot import assets, approve mappings, update quotes or trade', async t => {
  const ctx = setup(t), id = addAsset(ctx, { approve: true });
  await ctx.service.setEnabled(true);
  ctx.service.recordEvaluation(id, { executable: true, buyChain: 'bnb', sellChain: 'solana', amountUsd: 3, netProfitUsd: .1, gasUsd: .01, slippageUsd: .01, priceImpactBps: 1, expiresAt: new Date(ctx.now() + 15000).toISOString() });
  const before = tradingState(ctx), count = ctx.service.snapshot().usage.total;
  ctx.calls.length = 0;
  const result = await ctx.service.testNetwork();
  assert.deepEqual(ctx.calls.map(call => call.kind).sort(), ['bnb', 'directory', 'solana']);
  assert.deepEqual(ctx.calls.find(call => call.kind === 'bnb').options.addresses.map(address => address.toLowerCase()), [WBNB.toLowerCase()]);
  assert.deepEqual(ctx.calls.find(call => call.kind === 'solana').options.addresses, [WSOL]);
  assert.equal(ctx.calls.find(call => call.kind === 'directory').options.apiKey, KEY);
  for (const call of ctx.calls.filter(call => call.kind !== 'directory')) assert.equal(Object.hasOwn(call.options, 'apiKey'), false);
  assert.deepEqual(ctx.calls.map(call => call.reserved), [count + 1, count + 2, count + 3]);
  assert(ctx.calls.every(call => call.options.signal instanceof AbortSignal && !call.options.signal.aborted));
  assert.equal(result.usage.total, count + 3);
  assert.equal(result.network.testing, false);
  assert.equal(result.network.diagnostics.length, 3);
  assert(Number.isSafeInteger(result.network.lastTestAt));
  assert.deepEqual(tradingState(ctx), before);
  assert.deepEqual(ctx.walletCalls, []);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('network diagnostics retain only safe error facts and do not disable scanning on a probe rejection', async t => {
  const ctx = setup(t);
  addAsset(ctx);
  await ctx.service.setEnabled(true);
  const before = tradingState(ctx);
  const secret = 'provider-query-with-private-key-and-proxy-password';
  ctx.client.pools = async () => { throw Object.assign(new Error(secret), { code: 'DISCOVERY_NETWORK', networkReason: 'TLS', body: secret, url: `https://${secret}.invalid/` }); };
  ctx.client.discover = async () => { throw Object.assign(new Error(secret), { code: 'DISCOVERY_AUTH', httpStatus: 403, apiKey: KEY }); };
  const result = await ctx.service.testNetwork();
  const serialized = JSON.stringify(result);
  assert.equal(result.network.diagnostics.length, 3);
  assert.match(JSON.stringify(result.network.diagnostics), /TLS/);
  assert.match(JSON.stringify(result.network.diagnostics), /403/);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(KEY), false);
  assert.deepEqual(tradingState(ctx), before);
  assert.equal(ctx.service.lastError, '');
  assert.equal(ctx.service.directoryError, null);
  assert.equal(ctx.service.poolError, null);
});

test('diagnostic requests share the persistent daily quota and cannot bypass it by rerunning or saving settings', async t => {
  const ctx = setup(t);
  ctx.service.saveSettings({ maxRequestsPerDay: 2 });
  await ctx.service.testNetwork();
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.service.snapshot().usage.total, 2);
  await assert.rejects(ctx.service.testNetwork(), /冷却/);
  await ctx.service.saveNetworkSettings({ mode: 'direct', proxyUrl: '' });
  ctx.advance(60001);
  await ctx.service.testNetwork();
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.service.snapshot().usage.total, 2);
  const restarted = new OpportunityService({ store: ctx.store, client: ctx.client, network: ctx.network, now: ctx.now });
  try {
    await restarted.testNetwork();
    assert.equal(ctx.calls.length, 2);
    assert.equal(restarted.snapshot().usage.total, 2);
  } finally { restarted.stop(); }
});

test('provider rate limiting during diagnostics retains backoff through network changes', async t => {
  const ctx = setup(t);
  const limited = async () => { ctx.calls.push({ kind: 'limited' }); throw Object.assign(new Error('untrusted rate limit body'), { code: 'DISCOVERY_RATE_LIMIT', retryAfterMs: 3600000, httpStatus: 429 }); };
  ctx.client.pools = limited;
  ctx.client.discover = limited;
  await ctx.service.testNetwork();
  assert.equal(ctx.calls.length, 1);
  const before = requestLedger(ctx.store);
  assert(before.nextAt >= ctx.now() + 3600000);
  await ctx.service.saveNetworkSettings({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' });
  assert.deepEqual(requestLedger(ctx.store), before);
  ctx.advance(60001);
  await ctx.service.testNetwork();
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.service.snapshot().usage.total, 1);
});

test('CoinGecko diagnostic rate limiting persists a provider cooldown without importing or skipping future pool checks', async t => {
  const ctx = setup(t);
  ctx.client.discover = async () => {
    ctx.calls.push({ kind: 'directory' });
    throw Object.assign(new Error('private upstream response'), { code: 'DISCOVERY_RATE_LIMIT', retryAfterMs: 3600000, httpStatus: 429 });
  };
  await ctx.service.testNetwork();
  const provider = structuredClone(ctx.service.directoryState.sources.coingecko);
  assert.equal(provider.errorCode, 'DISCOVERY_RATE_LIMIT');
  assert(provider.nextAttemptAt >= ctx.now() + 3600000);
  assert.equal(ctx.service.snapshot().usage.total, 3);
  assert.equal(ctx.service.snapshot().assets.length, 0);
  await ctx.service.saveNetworkSettings({ mode: 'direct', proxyUrl: '' });
  assert.deepEqual(ctx.service.directoryState.sources.coingecko, provider);
  ctx.advance(60001);
  const result = await ctx.service.testNetwork();
  assert.equal(ctx.calls.filter(call => call.kind === 'directory').length, 1);
  assert.equal(ctx.calls.filter(call => call.kind === 'bnb').length, 2);
  assert.equal(ctx.calls.filter(call => call.kind === 'solana').length, 2);
  assert.equal(result.usage.total, 5);
  assert.equal(result.network.diagnostics.find(row => row.source === 'coingecko-directory').status, 'rate_limited');
  assert.deepEqual(ctx.service.directoryState.sources.coingecko, provider);
});

test('network testing shares the scan job lock, preventing duplicate probes and concurrent discovery', async t => {
  const ctx = setup(t);
  let finish;
  const original = ctx.client.pools;
  ctx.client.pools = options => new Promise(resolve => { ctx.calls.push({ kind: options.chain, options }); finish = () => { ctx.client.pools = original; resolve([]); }; });
  const pending = ctx.service.testNetwork();
  await Promise.resolve();
  assert.equal(ctx.service.snapshot().network.testing, true);
  assert.equal(ctx.service.busy, true);
  assert.equal(ctx.calls.length, 1);
  await ctx.service.testNetwork();
  await ctx.service.scan();
  await ctx.service.discover();
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.service.snapshot().usage.total, 1);
  finish();
  await pending;
  assert.equal(ctx.service.busy, false);
  assert.equal(ctx.service.snapshot().network.testing, false);
  assert.equal(ctx.service.snapshot().usage.total, 3);
});

test('saving a network route cancels an old probe before transport mutation and discards late diagnostic results', async t => {
  let ctx, activeSignal, finish;
  ctx = setup(t, { saveSettings: async () => { assert.equal(activeSignal.aborted, true); } });
  ctx.client.pools = options => new Promise(resolve => { activeSignal = options.signal; finish = resolve; ctx.calls.push({ kind: options.chain }); });
  const pending = ctx.service.testNetwork();
  await Promise.resolve();
  const saving = ctx.service.saveNetworkSettings({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(activeSignal.aborted, true);
  finish([]);
  const route = await saving;
  assert.equal(route.network.mode, 'proxy');
  assert.deepEqual(ctx.networkSaves, [{ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' }]);
  await pending;
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.service.snapshot().usage.total, 1);
  assert.deepEqual(ctx.service.snapshot().network.diagnostics, []);
  assert.equal(ctx.service.snapshot().network.lastTestAt, null);
  assert.equal(ctx.service.busy, false);
});

test('a network test waiting for a slow scan cannot start probes after a newer route save invalidates it', async t => {
  const ctx = setup(t);
  addAsset(ctx);
  let finishScan, scanSignal;
  ctx.client.pools = options => new Promise(resolve => {
    ctx.calls.push({ kind: options.chain, route: ctx.network.snapshot().mode });
    scanSignal = options.signal;
    finishScan = resolve;
  });
  const scanning = ctx.service.scan();
  await Promise.resolve();
  assert.equal(ctx.calls.length, 1);
  const testing = ctx.service.testNetwork();
  const saving = ctx.service.saveNetworkSettings({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(scanSignal.aborted, true);
  assert.equal(ctx.networkSaves.length, 0);
  finishScan([]);
  await Promise.all([scanning, testing, saving]);
  assert.deepEqual(ctx.calls, [{ kind: 'bnb', route: 'auto' }]);
  const snapshot = ctx.service.snapshot();
  assert.equal(snapshot.network.mode, 'proxy');
  assert.deepEqual(snapshot.network.diagnostics, []);
  assert.equal(snapshot.network.lastTestAt, null);
  assert.equal(snapshot.network.testing, false);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.usage.total, 1);
  assert.equal(snapshot.rows[0].market.bnb, null);
  assert.equal(snapshot.rows[0].market.solana, null);
});

test('a route persisted before preparation fails cannot retain successful diagnostics from the old route', async t => {
  const ctx = setup(t);
  await ctx.service.testNetwork();
  assert.equal(ctx.service.snapshot().network.diagnostics.length, 3);
  assert.notEqual(ctx.service.snapshot().network.lastTestAt, null);
  const priorUsage = ctx.service.snapshot().usage;
  ctx.network.saveSettings = async patch => {
    ctx.networkSaves.push(structuredClone(patch));
    const route = { ...ctx.network.snapshot(), ...patch, effectiveRoute: 'manual' };
    ctx.store.setMeta('market.network.v1', patch);
    ctx.network.snapshot = () => structuredClone(route);
    assert.deepEqual(ctx.service.snapshot().network.diagnostics, []);
    assert.equal(ctx.service.snapshot().network.lastTestAt, null);
    throw Object.assign(new Error('Saved route could not be prepared'), { safe: true, code: 'MARKET_PROXY_CONFIG' });
  };
  await assert.rejects(ctx.service.saveNetworkSettings({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' }), /could not be prepared/);
  const snapshot = ctx.service.snapshot();
  assert.equal(snapshot.network.mode, 'proxy');
  assert.deepEqual(ctx.store.getMeta('market.network.v1'), { mode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' });
  assert.deepEqual(snapshot.network.diagnostics, []);
  assert.equal(snapshot.network.lastTestAt, null);
  assert.equal(snapshot.network.testing, false);
  assert.deepEqual(snapshot.usage, priorUsage);
  assert.equal(ctx.calls.length, 3);
});

test('saving a valid route preserves cached prices, approvals, counts and trading configuration while clearing transport errors', async t => {
  const ctx = setup(t);
  addAsset(ctx, { approve: true });
  await ctx.service.setEnabled(true);
  ctx.service.poolError = { message: 'Old transport connection failure', errorCode: 'DISCOVERY_NETWORK' };
  ctx.service.directoryState.sources.coingecko = { source: 'coingecko', status: 'retrying', errorCode: 'DISCOVERY_TIMEOUT', message: 'Old transport timeout', nextAttemptAt: ctx.now() + 60000, lastAttemptAt: ctx.now(), failures: 1 };
  ctx.service.syncErrors();
  const before = tradingState(ctx), ledger = requestLedger(ctx.store);
  const snapshot = await ctx.service.saveNetworkSettings({ mode: 'direct', proxyUrl: '' });
  assert.deepEqual(tradingState(ctx), before);
  assert.deepEqual(requestLedger(ctx.store), ledger);
  assert.equal(snapshot.lastError, null);
  assert.equal(ctx.service.poolError, null);
  assert.equal(snapshot.directory.sourceAttempts.some(source => ['DISCOVERY_NETWORK', 'DISCOVERY_TIMEOUT'].includes(source.errorCode)), false);
  assert.equal(ctx.calls.length, 2);
});

test('network saves retain provider rejection, malformed-data and rate-limit errors', async t => {
  for (const code of ['DISCOVERY_AUTH', 'DISCOVERY_REJECTED', 'DISCOVERY_FORMAT', 'DISCOVERY_RATE_LIMIT']) {
    await t.test(code, async t => {
      const ctx = setup(t), message = `Safe retained ${code}`;
      ctx.service.poolError = { message, errorCode: code };
      ctx.service.directoryState.sources.coingecko = { source: 'coingecko', status: 'retrying', errorCode: code, message, nextAttemptAt: ctx.now() + 60000, lastAttemptAt: ctx.now(), failures: 1 };
      ctx.service.syncErrors();
      const source = structuredClone(ctx.service.directoryState.sources.coingecko);
      await ctx.service.saveNetworkSettings({ mode: 'direct', proxyUrl: '' });
      assert.equal(ctx.service.poolError.errorCode, code);
      assert.deepEqual(ctx.service.directoryState.sources.coingecko, source);
      assert.equal(ctx.service.snapshot().lastError, message);
    });
  }
});

test('network validation is delegated to the transport and failed saves cannot reset requests or trading state', async t => {
  const ctx = setup(t, { saveSettings: async () => { throw Object.assign(new Error('Only local HTTP proxies are supported'), { safe: true, code: 'MARKET_PROXY_CONFIG' }); } });
  addAsset(ctx);
  await ctx.service.scan();
  const before = tradingState(ctx), ledger = ctx.store.getMeta('opportunities.budget.v1');
  await assert.rejects(ctx.service.saveNetworkSettings({ mode: 'proxy', proxyUrl: 'socks5://remote.invalid:1080' }), /local HTTP/);
  assert.deepEqual(ctx.networkSaves, [{ mode: 'proxy', proxyUrl: 'socks5://remote.invalid:1080' }]);
  assert.equal(ctx.network.snapshot().mode, 'auto');
  assert.deepEqual(tradingState(ctx), before);
  assert.deepEqual(ctx.store.getMeta('opportunities.budget.v1'), ledger);
});

test('network routes require a local session and CSRF, guard route changes during trading, and keep probes read-only', async t => {
  const ctx = setup(t), config = structuredClone(ctx.store.config);
  const engine = { busy: false, configuring: false, config: ctx.store.config };
  const { server, url } = await startLocalServer({ engine, store: ctx.store, opportunityService: ctx.service });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`${url}/api/session`), { csrfToken } = await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const request = (route, body = {}, headers = {}) => fetch(`${url}${route}`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  for (const route of ['/api/opportunities/network', '/api/opportunities/network/test']) {
    assert.equal((await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await request(route, {}, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request(route, {}, { Origin: 'https://foreign.invalid' })).status, 403);
  }
  engine.busy = true;
  assert.equal((await request('/api/opportunities/network', { mode: 'direct', proxyUrl: '' })).status, 400);
  assert.equal(ctx.networkSaves.length, 0);
  engine.busy = false;
  const saved = await request('/api/opportunities/network', { mode: 'direct', proxyUrl: '' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).network.mode, 'direct');
  assert.deepEqual(ctx.networkSaves, [{ mode: 'direct', proxyUrl: '' }]);
  engine.configuring = true;
  assert.equal((await request('/api/opportunities/network', { mode: 'auto', proxyUrl: '' })).status, 400);
  engine.configuring = false;
  engine.busy = true;
  const tested = await request('/api/opportunities/network/test'), result = await tested.json();
  assert.equal(tested.status, 200);
  assert.equal(result.network.diagnostics.length, 3);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.deepEqual(ctx.store.config, config);
  assert.deepEqual(ctx.store.allTrades(), []);
  assert.deepEqual(ctx.walletCalls, []);
  assert.equal(ctx.service.snapshot().assets.length, 0);
});

test('HTTP 200 malformed API bodies retain the actual status in safe client errors', async t => {
  const secret = 'do-not-reflect-upstream-body';
  const cases = [
    { label: 'invalid JSON', body: `{invalid:${secret}`, code: 'DISCOVERY_FORMAT', directory: false },
    { label: 'provider error envelope', body: JSON.stringify({ status: 200, error: secret }), code: 'DISCOVERY_REJECTED', directory: false },
    { label: 'unexpected pool wrapper', body: JSON.stringify({ pairs: [], privateProviderBody: secret }), code: 'DISCOVERY_FORMAT', directory: false },
    { label: 'unexpected directory wrapper', body: JSON.stringify({ coins: [], privateProviderBody: secret }), code: 'DISCOVERY_FORMAT', directory: true },
  ];
  for (const item of cases) {
    await t.test(item.label, async () => {
      const client = new DiscoveryClient({ fetchImpl: async () => new Response(item.body, { status: 200, headers: { 'Content-Type': 'application/json' } }), now: () => INITIAL });
      const action = item.directory ? client.discover() : client.pools({ chain: 'bnb', addresses: [WBNB] });
      await assert.rejects(action, error => {
        assert.equal(error.safe, true);
        assert.equal(error.code, item.code);
        assert.equal(error.httpStatus, 200);
        assert.equal(JSON.stringify({ ...error, message: error.message }).includes(secret), false);
        return true;
      });
    });
  }
});
