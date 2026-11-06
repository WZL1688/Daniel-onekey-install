// Independent local-only validation. No real account, exchange request or order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { D } from '../src/math.js';
import { marketFixture } from './fixtures.js';
import { fixtureFailures, summarizeSoak } from './soak-metrics.js';

const seconds = Number(process.env.FEATURE_SOAK_SECONDS ?? 65);
if (!Number.isFinite(seconds) || seconds < 60 || seconds > 600) throw Error('验证时间必须为60–600秒');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-four-features-'));
let app;
try {
  app = createApp({ dataDir: directory, startEngine: false, transport: request => {
    assert.equal(request.mutation, false, '本地夹具禁止订单请求');
    for (const key of ['X-MBX-APIKEY', 'OK-ACCESS-KEY']) assert.equal(request.headers[key], undefined, '本地夹具禁止私人凭据');
    return marketFixture(request);
  } });
  // Synthetic cache only. Let it age naturally to validate UNCONFIRMED previews.
  for (const exchange of ['binance', 'okx']) app.store.state.balances[exchange] = {
    valid: true, at: Date.now(), assets: Object.fromEntries([['USDT', '10000'], ['BTC', '10'], ['ETH', '10'], ['SOL', '1000']]
      .map(([asset, amount]) => [asset, { free: amount, locked: '0', total: amount }])),
  };
  app.store.save();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, base = `http://127.0.0.1:${port}`;
  const get = async route => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json(); };
  const session = await fetch(base + '/api/session'), { csrf } = await session.json();
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const config = {
    costs: { rebalanceByQuote: { USDT: '0.05' } },
    filters: { minNetBps: '0', maxSpreadBps: '100', minDepthNotional: '100', maxBookSkewMs: 1000 },
    capital: { enabled: true, byExchange: {
      binance: { USDT: { reserve: '100', maxOrder: '50', maxHolding: null } },
      okx: { USDT: { reserve: '100', maxOrder: '50', maxHolding: null } },
    } },
    risk: { dailyLossByQuote: { USDT: '5' } },
  };
  const saved = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ config }) });
  assert.equal(saved.status, 200, await saved.text());
  const before = await get('/api/state'), start = Date.now(), samples = [];
  const computedPairs = new Set();
  let checkedPreviews = 0, unconfirmedPreviews = 0;
  app.engine.start();
  while (Date.now() - start < seconds * 1000) {
    const at = Date.now(), health = await get('/health'), state = await get('/api/state');
    assert.equal(health.status, 'ok'); assert.equal(state.config.autoTrading, false);
    assert.equal(state.batches.length, 0); assert.equal(state.keys.length, 0);
    assert.equal(state.config.capital.enabled, true); assert.equal(state.config.costs.rebalanceByQuote.USDT, '0.05');
    assert.equal(state.config.filters.maxSpreadBps, '100'); assert.equal(state.risk.limits.USDT, '5');
    assert.equal(state.risk.timeZone, 'Asia/Shanghai'); assert.equal(state.risk.latched, false);
    for (const [id, opportunity] of Object.entries(state.opportunities)) {
      if (!opportunity.at || opportunity.at < start) continue;
      for (const direction of opportunity.directions) {
        if (!direction.qty) continue;
        computedPairs.add(id);
        assert.equal(direction.rebalanceCost, '0.05');
        assert.ok(D(direction.executionNet).minus(direction.rebalanceCost).eq(direction.net));
        assert.ok(Number.isFinite(Number(direction.bookSkewMs)));
        if (direction.capital?.checked) {
          checkedPreviews++;
          assert.ok(D(direction.buyWorstCost).lte('50'), '缓存配额预览超出含费资金上限');
        } else {
          unconfirmedPreviews++;
          assert.equal(direction.capital?.status, 'UNCONFIRMED');
        }
      }
    }
    samples.push({ at: Date.now(), httpMs: Date.now() - at, polls: state.engine.polls, cycleMs: state.engine.cycleMs, lastCycleAt: state.engine.lastCycleAt });
    if (samples.length % 15 === 0) console.log(`LOCAL FOUR FEATURES ${Math.round((Date.now() - start) / 1000)}s: HTTP OK, polls=${state.engine.polls}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const after = await get('/api/state');
  const report = summarizeSoak({ fixture: true, start, end: Date.now(), before, after, samples, port });
  report.validationFailures = fixtureFailures(report);
  assert.deepEqual(report.validationFailures, []);
  assert.equal(computedPairs.size, after.config.pairs.length);
  assert.ok(checkedPreviews > 0, '未验证缓存有效时的配额缩量');
  assert.ok(unconfirmedPreviews > 0, '未验证余额过期后的资金未核对状态');
  Object.assign(report, { scope: 'FOUR_FEATURES_ENABLED_LOCAL_ONLY', configuredEnhancements: config,
    computedPairs: [...computedPairs].sort(), checkedPreviews, unconfirmedPreviews,
    userDataTouched: false, exchangeNetworkRequests: 0,
    limitations: ['本地协议夹具与合成余额，不代表真实账户、交易所行情或实盘成交。', '熔断触发、持久化及复位由独立政策、引擎和HTTP回归测试验证；本次连续观测保持零批次。'] });
  fs.writeFileSync(new URL('../reports/four-features-soak.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (app) await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
