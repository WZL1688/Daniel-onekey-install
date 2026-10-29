import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { marketFixture } from './fixtures.js';
const fixture = process.argv.includes('--fixture'), seconds = Number(process.env.SOAK_SECONDS || 65);
if (seconds < 60 || seconds > 3600) throw Error('连续验证时长必须为 60–3600 秒');
let app, dir, base = 'http://127.0.0.1:' + (process.env.PORT || 8888);
if (fixture) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-soak-fixture-'));
  app = createApp({ dataDir: dir, transport: marketFixture });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + app.server.address().port;
}
const get = async url => { const r = await fetch(base + url); if (!r.ok) throw Error('本地 HTTP 状态 ' + r.status); return r.json(); };
const start = Date.now(), before = await get('/api/state'), samples = [];
try {
  while (Date.now() - start < seconds * 1000) {
    const at = Date.now(), health = await get('/health'), state = await get('/api/state');
    if (health.status !== 'ok' || state.config.autoTrading || state.batches.length) throw Error('服务异常或非预期实盘／订单活动');
    samples.push({ at: Date.now(), httpMs: Date.now() - at, polls: state.engine.polls,
      freshPairs: Object.values(state.opportunities).filter(x => !x.stale && !x.error).length });
    if (samples.length % 15 === 0) console.log(`${fixture ? 'FIXTURE' : 'LIVE-NETWORK'} ${Math.round((Date.now() - start) / 1000)}s: local HTTP OK, polls=${state.engine.polls}, freshPairs=${samples.at(-1).freshPairs}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  const after = await get('/api/state'), counters = {};
  for (const ex of after.config.exchanges) {
    counters[ex] = {};
    for (const name of ['public', 'private', 'orders', 'failures', 'limited', 'delayed', 'waitMs', 'latencyMs']) counters[ex][name] = after.rates[ex].metrics[name] - before.rates[ex].metrics[name];
    counters[ex].backoffReason = after.rates[ex].reason;
    counters[ex].httpStatuses = after.rates[ex].metrics.httpStatuses || {};
    const count = counters[ex].public + counters[ex].private;
    counters[ex].averageExchangeAttemptMs = count ? Math.round(counters[ex].latencyMs / count) : null;
  }
  const report = { type: fixture ? 'OFFICIAL_SHAPED_LOCAL_FIXTURE_NOT_EXCHANGE' : 'CURRENT_ENVIRONMENT_REAL_NETWORK_ATTEMPTS',
    startedAt: new Date(start).toISOString(), elapsedMs: Date.now() - start, localSamples: samples.length,
    localHttpAverageMs: Math.round(samples.reduce((sum, x) => sum + x.httpMs, 0) / samples.length),
    slotMs: after.engine.slotMs, expectedCycleMs: after.engine.estimatedCycleMs, observedCycleMs: after.engine.cycleMs,
    pollRounds: after.engine.polls - before.engine.polls, successfulSampledPairs: Object.keys(after.opportunities).filter(id => after.opportunities[id].at),
    counters, liveTrading: after.config.autoTrading, batchesCreated: after.batches.length, pendingQueue: Object.fromEntries(Object.entries(after.rates).map(([ex, r]) => [ex, r.queue.length])),
    limitations: fixture ? ['本地协议夹具，不能作为交易所联网或实盘验收'] : Object.values(after.opportunities).filter(x => x.error).map(x => x.error) };
  fs.mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  const file = new URL('../reports/' + (fixture ? 'soak-fixture.json' : 'soak-network.json'), import.meta.url);
  fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  if (fixture && report.successfulSampledPairs.length !== 3) throw Error('夹具轮询未覆盖三个交易对');
} finally { if (app) { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } }
