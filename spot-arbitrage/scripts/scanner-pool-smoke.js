// Local protocol fixture only: no real exchange, account, balance or order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { marketFixture } from './fixtures.js';
import { summarizeSoak, fixtureFailures } from './soak-metrics.js';

const seconds = Number(process.env.SCANNER_SOAK_SECONDS ?? 65);
if (!Number.isFinite(seconds) || seconds < 60 || seconds > 600) throw Error('扫描验证时长必须为 60–600 秒');
const assets = ['TSTA', 'TSTB', 'TSTC'];
const pairs = assets.map(asset => asset + '/USDT');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-scanner-pool-'));
let app, attempts = 0;
try {
  app = createApp({ dataDir: directory, startEngine: false, transport: async request => {
    assert.equal(request.mutation, false);
    assert.equal(request.method, 'GET');
    assert.equal(Object.keys(request.headers).length, 0);
    attempts++;
    const url = new URL(request.url);
    const response = await marketFixture(request);
    if (url.pathname === '/api/v3/exchangeInfo') {
      assert.equal(url.searchParams.get('showPermissionSets'), 'false');
      for (const asset of assets) response.data.symbols.push({ ...structuredClone(response.data.symbols[0]), symbol: asset + 'USDT', baseAsset: asset });
    } else if (url.pathname === '/api/v5/public/instruments') {
      for (const asset of assets) response.data.data.push({ ...structuredClone(response.data.data[0]), instId: asset + '-USDT', baseCcy: asset });
    } else if (url.pathname.endsWith('/depth') || url.pathname.endsWith('/books')) {
      const symbol = url.searchParams.get('symbol') || url.searchParams.get('instId');
      if (assets.some(asset => symbol.startsWith(asset))) {
        const bids = [[url.hostname === 'api.binance.com' ? '9.99' : '10.08', '1000']];
        const asks = [[url.hostname === 'api.binance.com' ? '10' : '10.09', '1000']];
        if (url.hostname === 'api.binance.com') Object.assign(response.data, { bids, asks });
        else Object.assign(response.data.data[0], { bids, asks });
      }
    }
    return response;
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async route => { const r = await fetch(base + route); assert.equal(r.status, 200); return r.json(); };
  const session = await fetch(base + '/api/session');
  const { csrf } = await session.json(), cookie = session.headers.get('set-cookie').split(';')[0];
  const post = async (route, body) => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    assert.ok(r.ok, `${route}: ${r.status} ${await r.clone().text()}`); return r.json();
  };
  for (let i = 0; i < 5; i++) await get('/api/state');
  assert.equal(attempts, 0, '刷新页面不能启动交易所请求');
  await post('/api/config', { config: { scanPairs: pairs, scanExcludeAssets: ['BTC', 'ETH', 'SOL'], amount: '20', fallbackAmounts: ['10', '5'], minProfit: '0.01', minDepthProfit: '0.01', buffer: '0.01' } });
  await post('/api/scan', {});
  const before = await get('/api/state'), start = Date.now(), samples = [];
  let freshObservations = 0, historicalObservations = 0, completed = 0;
  app.engine.start();
  while (Date.now() - start < seconds * 1000) {
    const at = Date.now(), health = await get('/health'), state = await get('/api/state');
    assert.equal(health.status, 'ok'); assert.equal(state.config.autoTrading, false);
    assert.equal(state.keys.length, 0); assert.equal(state.batches.length, 0);
    const run = state.engine.scanRun;
    assert.ok(run); assert.equal(run.mode, 'manual');
    assert.ok(run.completed >= completed); assert.ok(run.completed <= 3);
    assert.equal(run.failed, 0); completed = run.completed;
    for (const [id, result] of Object.entries(state.scanResults)) {
      assert.ok(pairs.includes(id), '排除币种不得进入扫描结果');
      assert.ok(result.directions.length === 2 && !result.error);
      if (result.stale) historicalObservations++;
      else {
        freshObservations++;
        assert.ok(result.directions.some(direction => direction.eligible), '合成正利润候选应通过原有门槛');
      }
    }
    samples.push({ at: Date.now(), httpMs: Date.now() - at, polls: state.engine.polls, cycleMs: state.engine.cycleMs, lastCycleAt: state.engine.lastCycleAt });
    if (samples.length % 15 === 0) console.log(`LOCAL SCANNER ${Math.round((Date.now() - start) / 1000)}s: HTTP OK, ${run.completed}/${run.total}, status=${run.status}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const after = await get('/api/state');
  assert.equal(after.engine.scanRun.status, 'COMPLETED');
  assert.equal(after.engine.scanRun.total, 3); assert.equal(after.engine.scanRun.completed, 3);
  assert.deepEqual(Object.keys(after.scanResults).sort(), [...pairs].sort());
  assert.ok(freshObservations > 0 && historicalObservations > 0);
  const report = summarizeSoak({ fixture: true, start, end: Date.now(), before, after, samples, port: app.server.address().port });
  report.validationFailures = fixtureFailures(report); assert.deepEqual(report.validationFailures, []);
  Object.assign(report, { scope: 'SCANNER_CANDIDATE_POOL_LOCAL_ONLY', scanRun: after.engine.scanRun, scannedPairs: Object.keys(after.scanResults).sort(), freshObservations, historicalObservations, exchangeNetworkRequests: 0, userDataTouched: false,
    limitations: ['所有币种价格、规则及正利润来自本地合成夹具，不是实际小币机会或市值数据。', '未使用真实 Key、私人接口或订单；不能作为实盘验收。'] });
  fs.writeFileSync(new URL('../reports/scanner-pool-soak.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (app) await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
