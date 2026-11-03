import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { marketFixture } from './fixtures.js';
import { fixtureFailures, summarizeSoak } from './soak-metrics.js';
const fixture = process.argv.includes('--fixture'), seconds = Number(process.env.SOAK_SECONDS || 65);
if (!Number.isFinite(seconds) || seconds < 60 || seconds > 3600) throw Error('连续验证时长必须为 60–3600 秒');
let app, dir, base = 'http://127.0.0.1:' + (process.env.PORT || 8888);
try {
if (fixture) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-soak-fixture-'));
  app = createApp({ dataDir: dir, transport: marketFixture });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + app.server.address().port;
}
const get = async url => { const r = await fetch(base + url); if (!r.ok) throw Error('本地 HTTP 状态 ' + r.status); return r.json(); };
const start = Date.now(), before = await get('/api/state'), samples = [];
  const batchIds = new Set(before.batches.map(batch => batch.id));
  let previousUptime = -1;
  while (Date.now() - start < seconds * 1000) {
    const at = Date.now(), health = await get('/health'), state = await get('/api/state');
    if (health.status !== 'ok' || health.uptime < previousUptime || state.config.autoTrading || state.batches.some(batch => !batchIds.has(batch.id))) throw Error('服务异常、进程重启或非预期实盘／订单活动');
    previousUptime = health.uptime;
    samples.push({ at: Date.now(), httpMs: Date.now() - at, polls: state.engine.polls,
      cycleMs: state.engine.cycleMs, lastCycleAt: state.engine.lastCycleAt,
      freshPairs: Object.values(state.opportunities).filter(x => !x.stale && !x.error).length });
    if (samples.length % 15 === 0) console.log(`${fixture ? 'FIXTURE' : 'LIVE-NETWORK'} ${Math.round((Date.now() - start) / 1000)}s: local HTTP OK, polls=${state.engine.polls}, freshPairs=${samples.at(-1).freshPairs}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  const after = await get('/api/state');
  const report = summarizeSoak({ fixture, start, end: Date.now(), before, after, samples, port: new URL(base).port });
  report.validationFailures = fixture ? fixtureFailures(report) : [];
  if (report.validationFailures.length) report.status = 'FAILED';
  fs.mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  const file = new URL('../reports/' + (fixture ? 'soak-fixture.json' : 'soak-network.json'), import.meta.url);
  fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  if (report.validationFailures.length) throw Error(report.validationFailures.join('；'));
} finally { if (app) { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } }
