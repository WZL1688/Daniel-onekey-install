import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { RISK_RESET_CONFIRM } from '../src/engine.js';
import { normalizeBook } from '../src/math.js';
import { rule } from './helpers.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-http-features-'));
  let requests = 0;
  const app = createApp({ dataDir: dir, startEngine: false, transport: async () => { requests++; throw Error('测试不允许访问交易所'); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = await fetch(base + '/api/session'), cookie = session.headers.get('set-cookie').split(';')[0], { csrf } = await session.json();
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: cookie }, body: JSON.stringify(body) });
  return { ...app, base, post, requests: () => requests };
}

test('风险快照和配置读取不发交易所请求，复位接口沿用会话与 CSRF 校验', async t => {
  const app = await fixture(t);
  const response = await fetch(app.base + '/api/state'), state = await response.json();
  assert.equal(state.risk.latched, false);
  assert.equal(state.risk.timeZone, 'Asia/Shanghai');
  assert.deepEqual(state.risk.lossByQuote, {});
  const denied = await fetch(app.base + '/api/risk/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: RISK_RESET_CONFIRM }) });
  assert.equal(denied.status, 403);
  assert.equal(app.requests(), 0);
});

test('HTTP 设置补丁合并配额并拒绝修改熔断状态或直接开启实盘', async t => {
  const app = await fixture(t);
  let response = await app.post('/api/config', { config: { capital: { enabled: true, byExchange: { binance: { USDT: { reserve: '10', maxOrder: '100', maxHolding: null } } } }, risk: { dailyLossByQuote: { USDT: '5' } } } });
  assert.equal(response.status, 200);
  response = await app.post('/api/config', { config: { capital: { byExchange: { binance: { USDT: { reserve: '20' } } } } } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.capital.byExchange.binance.USDT.maxOrder, '100');
  for (const config of [{ risk: { latched: false } }, { autoTrading: true }, { capital: { enabled: 'true' } }]) {
    response = await app.post('/api/config', { config });
    assert.equal(response.status, 400);
  }
  assert.equal(app.store.state.config.autoTrading, false);
  assert.equal(app.store.state.config.risk.dailyLossByQuote.USDT, '5');
  assert.equal(app.requests(), 0);
});

test('HTTP 风险复位不能绕过确认及当日限额，成功后仍保留已核对亏损', async t => {
  const app = await fixture(t);
  app.engine.updateConfig({ risk: { dailyLossByQuote: { USDT: '1' } } });
  app.store.state.batches.push({ id: 'manually-reconciled-loss', pair: 'BTC/USDT', mode: 'arbitrage', at: Date.now(), status: 'RESOLVED', legs: [], realizedNet: '-1', resolution: { at: Date.now(), reference: '测试人工核对记录', legs: [] } });
  app.engine.syncRisk();
  assert.equal(app.engine.riskStatus().latched, true);
  let response = await app.post('/api/risk/reset', { confirm: '直接解锁', latched: false });
  assert.equal(response.status, 400);
  response = await app.post('/api/risk/reset', { confirm: RISK_RESET_CONFIRM });
  assert.equal(response.status, 400);
  app.engine.updateConfig({ risk: { dailyLossByQuote: { USDT: '2' } } });
  assert.equal(app.engine.riskStatus().latched, true);
  response = await app.post('/api/risk/reset', { confirm: RISK_RESET_CONFIRM });
  assert.equal(response.status, 200);
  const { risk } = await response.json();
  assert.equal(risk.latched, false);
  assert.equal(risk.lossByQuote.USDT, '1');
  assert.equal(risk.ledgerCount, 1);
  assert.equal(app.store.state.config.autoTrading, false);
  assert.equal(app.requests(), 0);
});

test('HTTP 显式删除配置项保留其他资产限制，删除亏损限额不解除已触发熔断', async t => {
  const app = await fixture(t);
  app.engine.updateConfig({ costs: { rebalanceByQuote: { USDT: '0.1', USDC: '0.2' } },
    capital: { enabled: true, byExchange: { binance: { BTC: { reserve: '1', maxOrder: '2', maxHolding: '3' }, USDT: { reserve: '10', maxOrder: '20', maxHolding: null } }, okx: { BTC: { reserve: '4', maxOrder: null, maxHolding: null } } } },
    risk: { dailyLossByQuote: { USDT: '1', USDC: '2' } } });
  app.store.state.batches.push({ id: 'loss-before-limit-removal', pair: 'BTC/USDT', status: 'RESOLVED', legs: [], realizedNet: '-1', resolution: { at: Date.now(), reference: '人工核对删除限额回归测试记录', legs: [] } });
  app.engine.syncRisk();
  const response = await app.post('/api/config', { config: { costs: { rebalanceByQuote: { USDT: null } },
    capital: { byExchange: { binance: { BTC: null } } }, risk: { dailyLossByQuote: { USDT: null } } } });
  assert.equal(response.status, 200);
  const { config } = await response.json();
  assert.deepEqual(config.costs.rebalanceByQuote, { USDC: '0.2' });
  assert.equal(config.capital.byExchange.binance.BTC, undefined);
  assert.equal(config.capital.byExchange.binance.USDT.maxOrder, '20');
  assert.equal(config.capital.byExchange.okx.BTC.reserve, '4');
  assert.deepEqual(config.risk.dailyLossByQuote, { USDC: '2' });
  const state = await (await fetch(app.base + '/api/state')).json();
  assert.equal(state.risk.latched, true);
  assert.equal(state.risk.latches.USDT.loss, '1');
  assert.equal(state.risk.lossByQuote.USDT, '1');
  assert.equal(state.config.autoTrading, false);
  assert.equal(app.requests(), 0);
});

test('管理快照展示缓存配额缩量及资金未核对状态，刷新页面不查询交易所', async t => {
  const app = await fixture(t), state = app.store.state;
  app.engine.updateConfig({ pairs: ['BTC/USDT'], amount: '100', fallbackAmounts: [], fees: { binance: '0', okx: '0' }, buffer: '0', minProfit: '0', minDepthProfit: '0',
    balance: { 'BTC/USDT': { enabled: true, amount: '100', stopDifference: '0', maxLoss: '0' } },
    capital: { enabled: true, byExchange: { binance: { USDT: { reserve: '0', maxOrder: '50', maxHolding: null } } } } });
  for (const exchange of ['binance', 'okx']) {
    state.rules[exchange] = { 'BTC/USDT': rule() };
    state.balances[exchange] = { valid: true, at: Date.now(), assets: { BTC: { free: '10', locked: '0', total: exchange === 'binance' ? '10' : '12' }, USDT: { free: '10000', locked: '0', total: '10000' } } };
    state.books[exchange] = { 'BTC/USDT': normalizeBook({ pair: 'BTC/USDT', at: Date.now(),
      bids: [[exchange === 'binance' ? '99' : '110', '100']], asks: exchange === 'binance' ? [['100', '0.5'], ['130', '100']] : [['111', '100']] }, 'BTC/USDT') };
  }
  const snapshot = () => { state.opportunities['BTC/USDT'] = { pair: 'BTC/USDT', at: Date.now(), directions: [app.engine.previewDirection('BTC/USDT', 'binance', 'okx')] }; };
  snapshot();
  for (let i = 0; i < 3; i++) {
    const response = await (await fetch(app.base + '/api/state')).json();
    assert.equal(response.opportunities['BTC/USDT'].directions[0].qty, '0.5');
    assert.equal(response.opportunities['BTC/USDT'].directions[0].capital.status, 'CACHED');
    assert.equal(response.balanceDirections['BTC/USDT'].qty, '0.5');
    assert.equal(response.balanceDirections['BTC/USDT'].capital.checked, true);
  }
  state.balances.binance.valid = false; snapshot();
  const response = await (await fetch(app.base + '/api/state')).json();
  assert.equal(response.opportunities['BTC/USDT'].directions[0].qty, '0.88');
  assert.equal(response.opportunities['BTC/USDT'].directions[0].capital.status, 'UNCONFIRMED');
  assert.equal(response.balanceDirections['BTC/USDT'].capital.checked, false);
  assert.match(response.opportunities['BTC/USDT'].directions[0].capital.error, /余额过期或更新失败/);
  assert.equal(app.requests(), 0);
});
