// Real local HTTP + synthetic public protocol data. No real accounts or orders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { marketFixture } from './fixtures.js';
import { summarizeSoak, fixtureFailures } from './soak-metrics.js';
import { CANDLE_MS } from '../src/market-watch.js';

const seconds = Number(process.env.MARKET_WATCH_SOAK_SECONDS ?? 65);
if (!Number.isFinite(seconds) || seconds < 60 || seconds > 600) throw Error('观察验证时长必须为60–600秒');
const assets = ['TSTA', 'TSTB', 'TSTC'], pairs = assets.map(asset => asset + '/USDT');
const anchor = Math.floor(Date.now() / CANDLE_MS) * CANDLE_MS;
const eventEnd = Math.floor(anchor / (3 * CANDLE_MS)) * 3 * CANDLE_MS;
const eventStart = eventEnd - 3 * CANDLE_MS;
const candles = Array.from({ length: 872 }, (_, i) => {
  const at = anchor - (872 - i) * CANDLE_MS;
  const event = at >= eventStart && at < eventEnd;
  const close = at >= eventEnd - CANDLE_MS ? '10.6' : '10';
  return [at, '10', event ? '12' : close === '10.6' ? '10.8' : '10.2', '9.9', close,
    i === 871 ? '500' : '100', at + CANDLE_MS - 1, i === 871 ? '5000' : '1000', 100, '50', '500', '0'];
});
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-market-watch-'));
let app, attempts = 0, klineRequests = 0;
try {
  app = createApp({ dataDir: directory, startEngine: false, transport: async request => {
    assert.equal(request.method, 'GET'); assert.equal(request.mutation, false);
    assert.equal(Object.keys(request.headers).length, 0); attempts++;
    const url = new URL(request.url);
    if (url.pathname === '/api/v3/klines') {
      assert.equal(url.hostname, 'api.binance.com');
      assert.equal(url.searchParams.get('interval'), '5m');
      assert.equal(url.searchParams.get('limit'), '872'); klineRequests++;
      return { status: 200, headers: {}, data: candles };
    }
    const response = await marketFixture(request);
    if (url.pathname === '/api/v3/exchangeInfo') {
      for (const asset of assets) response.data.symbols.push({ ...structuredClone(response.data.symbols[0]), symbol: asset + 'USDT', baseAsset: asset });
    } else if (url.pathname === '/api/v5/public/instruments') {
      for (const asset of assets) response.data.data.push({ ...structuredClone(response.data.data[0]), instId: asset + '-USDT', baseCcy: asset });
    } else if (url.pathname.endsWith('/depth') || url.pathname.endsWith('/books')) {
      const symbol = url.searchParams.get('symbol') || url.searchParams.get('instId');
      if (assets.some(asset => symbol.startsWith(asset))) {
        const book = { bids: [[url.hostname === 'api.binance.com' ? '10.59' : '10.68', '1000']], asks: [[url.hostname === 'api.binance.com' ? '10.6' : '10.69', '1000']] };
        if (url.hostname === 'api.binance.com') Object.assign(response.data, book);
        else Object.assign(response.data.data[0], book);
      }
    }
    return response;
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async route => { const r = await fetch(base + route); assert.equal(r.status, 200); return r.json(); };
  const session = await fetch(base + '/api/session');
  const { csrf } = await session.json(), cookie = session.headers.get('set-cookie').split(';')[0];
  const post = async (route, data) => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify(data) });
    assert.ok(r.ok, `${route}: ${r.status} ${await r.clone().text()}`); return r.json();
  };
  for (let i = 0; i < 5; i++) await get('/api/state');
  assert.equal(attempts, 0, '页面刷新不能请求交易所');
  await post('/api/config', { config: { scanPairs: pairs, scanExcludeAssets: ['BTC', 'ETH', 'SOL'],
    amount: '20', fallbackAmounts: ['10', '5'], buffer: '0.01', minProfit: '0.01', minDepthProfit: '0.01',
    marketWatch: { enabled: true } } });
  await post('/api/scan', {});
  const before = await get('/api/state'), start = Date.now(), samples = [], completedRuns = new Set();
  let baselineAlertCount = null, secondStarted = false, observedFresh = 0;
  app.engine.start();
  while (Date.now() - start < seconds * 1000) {
    const at = Date.now(), state = await get('/api/state'), health = await get('/health');
    assert.equal(health.status, 'ok'); assert.equal(state.config.autoTrading, false);
    assert.equal(state.keys.length, 0); assert.equal(state.batches.length, 0);
    const run = state.engine.scanRun; assert.equal(run.failed, 0);
    for (const [id, summary] of Object.entries(state.marketWatch.samples)) {
      assert.ok(pairs.includes(id));
      if (['READY', 'PARTIAL'].includes(summary.status)) {
        observedFresh++; assert.equal(summary.volumeRatio5m, '5');
        assert.ok(summary.signals.length > 0);
      }
    }
    if (run.status === 'COMPLETED') {
      completedRuns.add(run.id);
      if (!secondStarted) {
        baselineAlertCount = state.marketWatch.alerts.length;
        assert.ok(baselineAlertCount >= 3);
        secondStarted = true; await post('/api/scan', {});
      } else assert.equal(state.marketWatch.alerts.length, baselineAlertCount, '同一已闭合柱不应重复提醒');
    }
    samples.push({ at: Date.now(), httpMs: Date.now() - at, polls: state.engine.polls, cycleMs: state.engine.cycleMs, lastCycleAt: state.engine.lastCycleAt });
    if (samples.length % 15 === 0) console.log(`LOCAL MARKET WATCH ${Math.round((Date.now() - start) / 1000)}s: HTTP OK, alerts=${state.marketWatch.alerts.length}, completedRuns=${completedRuns.size}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const after = await get('/api/state');
  assert.ok(completedRuns.size >= 2); assert.ok(observedFresh > 0);
  assert.equal(after.marketWatch.alerts.length, baselineAlertCount);
  assert.equal(klineRequests, 3, '第二轮相同候选应复用一分钟缓存');
  const report = summarizeSoak({ fixture: true, start, end: Date.now(), before, after, samples, port: app.server.address().port });
  report.validationFailures = fixtureFailures(report); assert.deepEqual(report.validationFailures, []);
  Object.assign(report, { scope: 'MARKET_WATCH_LOCAL_ONLY', candidatePairs: pairs, completedScanRuns: completedRuns.size,
    klineRequests, alerts: after.marketWatch.alerts.length, observedFresh, repeatedCandleAlerts: 0,
    exchangeNetworkRequests: 0, userDataTouched: false,
    limitations: ['价格、K线和放量来自本地合成夹具，不是实盘机会、未来涨幅或市值数据。', '仅验证观察与去重，未使用真实账户或发送订单。'] });
  fs.writeFileSync(new URL('../reports/market-watch-soak.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (app) await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
