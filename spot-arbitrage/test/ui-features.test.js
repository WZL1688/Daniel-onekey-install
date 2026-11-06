import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { defaults } from '../src/store.js';
import { validateConfig } from '../src/engine.js';
import { syncRisk } from '../src/policies.js';

let imports = 0;
const tick = async () => { for (let i = 0; i < 5; i++) await nextTurn(); };
function snapshot() {
  const s = defaults();
  s.config.pairs = ['BTC/USDT']; s.now = Date.now();
  s.engine = { ...s.engine, busy: false, estimatedCycleMs: 3000 };
  s.liveReasons = ['OKX 官方规则验收未完成']; s.balanceDirections = { 'BTC/USDT': { reasons: ['暂无盘口'] } };
  s.risk = { latched: false, day: '2026-11-05', timeZone: 'Asia/Shanghai', lossByQuote: {}, limits: {}, latches: {} };
  s.rates = Object.fromEntries(s.config.exchanges.map(ex => [ex, { metrics: { public: 0, private: 0, orders: 0, limited: 0, delayed: 0, lastLatencyMs: 0, waitMs: 0 }, windows: {}, queue: [] }]));
  return s;
}
// Linkedom has real DOM events but no browser FormData or dialog implementation.
class DOMFormData {
  constructor(form) {
    this.values = [...form.querySelectorAll('input[name],select[name],textarea[name]')].filter(el => !el.disabled && (!['checkbox', 'radio'].includes(el.type) || (el.checked ?? el.hasAttribute('checked')))).map(el => [el.name, el.value || (el.type === 'checkbox' ? 'on' : '')]);
  }
  get(key) { return this.values.find(([name]) => name === key)?.[1] ?? null; }
  has(key) { return this.values.some(([name]) => name === key); }
  [Symbol.iterator]() { return this.values[Symbol.iterator](); }
}
async function boot(t, s = snapshot()) {
  const { document, window } = parseHTML(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  const previous = Object.fromEntries(['document', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'FormData'].map(key => [key, globalThis[key]]));
  const requests = []; let poll;
  const dialog = document.querySelector('#modal');
  dialog.showModal = () => dialog.setAttribute('open', ''); dialog.close = () => dialog.removeAttribute('open');
  document.querySelector('#modal-ok').value = 'ok';
  Object.assign(globalThis, { document, FormData: DOMFormData, setTimeout: () => 0, clearTimeout: () => {}, setInterval: callback => { poll = callback; return 0; }, fetch: async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, options, payload });
    let result;
    if (url === '/api/session') result = { csrf: 'test-ui-csrf' };
    else if (url === '/api/state') result = structuredClone(s);
    else if (url === '/api/config') { s.config = validateConfig(payload.config, s.config, payload.confirm); if (s.riskState) s.risk = syncRisk(s); result = { ok: true }; }
    else if (url === '/api/risk/reset') { s.risk.latched = false; s.risk.latches = {}; result = { ok: true }; }
    else throw Error('界面不应发起此请求：' + url);
    return { ok: true, json: async () => result };
  } });
  t.after(async () => { await tick(); Object.assign(globalThis, previous); });
  await import('../public/app.js?uiFeatures=' + (++imports));
  assert.equal(document.querySelector('#connection').textContent, '本机在线');
  const click = async selector => { const el = typeof selector === 'string' ? document.querySelector(selector) : selector; assert.ok(el, String(selector)); el.dispatchEvent(new window.Event('click', { bubbles: true })); await tick(); };
  const submit = async form => {
    const event = new window.Event('submit', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'submitter', { value: document.querySelector('#modal-ok') });
    // Linkedom does not dispatch the HTMLFormElement onsubmit property.
    if (form.onsubmit) await form.onsubmit(event); else form.dispatchEvent(event);
    await tick();
  };
  return { s, document, requests, click, submit, poll: async () => { await poll(); await tick(); } };
}

test('四项设置通过实际 DOM 保存，空上限不限、显式零保留，使用原会话 CSRF', async t => {
  const ui = await boot(t);
  await ui.click('[data-page="settings"]');
  const { document } = ui, form = document.querySelector('#settings-form');
  const set = (name, value) => { form.querySelector(`[name="${name}"]`).value = value; };
  set('filterMinNetBps', '12.5'); set('filterMaxSpreadBps', '8'); set('filterMinDepthNotional', '300'); set('filterMaxBookSkewMs', '0');
  form.querySelector('[name="capitalEnabled"]').checked = true;
  const quote = form.querySelector('[data-quote-policy-row]');
  quote.querySelector('[data-field="rebalance"]').value = '0.10'; quote.querySelector('[data-field="loss"]').value = '0';
  await ui.click('#add-quote-policy');
  const quote2 = form.querySelectorAll('[data-quote-policy-row]')[1];
  quote2.querySelector('[data-field="quote"]').value = 'usdc'; quote2.querySelector('[data-field="rebalance"]').value = ''; quote2.querySelector('[data-field="loss"]').value = '4';
  await ui.click('#add-capital-policy');
  const row = form.querySelector('[data-capital-policy-row]');
  row.querySelector('[data-field="asset"]').value = 'usdt'; row.querySelector('[data-field="reserve"]').value = '25'; row.querySelector('[data-field="maxOrder"]').value = '0';
  await ui.click('#add-capital-policy');
  const row2 = form.querySelectorAll('[data-capital-policy-row]')[1];
  row2.querySelector('[data-field="asset"]').value = 'BTC'; row2.querySelector('[data-field="maxHolding"]').value = '2';
  row2.querySelector('option[selected]').removeAttribute('selected'); row2.querySelector('option[value="okx"]').setAttribute('selected', '');
  await ui.submit(form);
  assert.equal(document.querySelector('#notice').textContent, '设置已保存。');
  const saved = ui.requests.find(x => x.url === '/api/config'); assert.ok(saved);
  assert.equal(saved.options.headers['X-CSRF-Token'], 'test-ui-csrf'); assert.equal(saved.options.method, 'POST');
  assert.deepEqual(saved.payload.config.filters, { minNetBps: '12.5', maxSpreadBps: '8', minDepthNotional: '300', maxBookSkewMs: 0 });
  assert.deepEqual(saved.payload.config.costs, { rebalanceByQuote: { USDT: '0.10' } });
  assert.deepEqual(saved.payload.config.risk, { dailyLossByQuote: { USDT: '0', USDC: '4' } });
  assert.deepEqual(saved.payload.config.capital, { enabled: true, byExchange: { binance: { USDT: { reserve: '25', maxOrder: '0', maxHolding: null } }, okx: { BTC: { reserve: '0', maxOrder: null, maxHolding: '2' } } } });
  assert.ok(!ui.requests.some(x => ['/api/live', '/api/submit'].includes(x.url)));
});

test('设置行可新增、删除且保留空筛选，重复资产和无效时差不会静默关闭保护', async t => {
  const ui = await boot(t); await ui.click('[data-page="settings"]');
  const form = ui.document.querySelector('#settings-form');
  await ui.click('#add-quote-policy');
  const added = form.querySelectorAll('[data-quote-policy-row]')[1];
  added.querySelector('[data-field="quote"]').value = 'USDC';
  await ui.click('[data-quote-policy-row]:last-child [data-policy-remove]');
  assert.equal(form.querySelectorAll('[data-quote-policy-row]').length, 1);
  form.querySelector('[name="filterMaxBookSkewMs"]').value = '1.5';
  await ui.submit(form); assert.equal(ui.requests.filter(x => x.url === '/api/config').length, 0);
  assert.match(ui.document.querySelector('#notice').textContent, /整数毫秒/);
  form.querySelector('[name="filterMaxBookSkewMs"]').value = '';
  await ui.click('#add-capital-policy'); await ui.click('#add-capital-policy');
  for (const row of form.querySelectorAll('[data-capital-policy-row]')) row.querySelector('[data-field="asset"]').value = 'BTC';
  await ui.submit(form); assert.equal(ui.requests.filter(x => x.url === '/api/config').length, 0);
  assert.match(ui.document.querySelector('#notice').textContent, /配额重复/);
  await ui.click('[data-capital-policy-row]:last-child [data-policy-remove]');
  await ui.submit(form);
  const config = ui.requests.find(x => x.url === '/api/config').payload.config;
  assert.equal(config.filters.maxBookSkewMs, null); assert.equal(config.filters.maxSpreadBps, null);
});

test('清空及删除已有设置发送逐项 tombstone，保存刷新后保留其他额度与已有熔断', async t => {
  const s = snapshot(), caps = { reserve: '1', maxOrder: '2', maxHolding: '3' };
  s.config.costs = { rebalanceByQuote: { USDT: '.1', USDC: '.2' } };
  s.config.risk = { dailyLossByQuote: { USDT: '5', USDC: '6' } };
  s.config.capital = { enabled: true, byExchange: { binance: { BTC: { ...caps }, SOL: { ...caps } }, okx: { ETH: { ...caps } } } };
  s.batches = [{ id: 'ui-confirmed-loss', pair: 'BTC/USDT', status: 'RESOLVED', at: s.now, realizedNet: '-5', resolution: { at: s.now }, legs: [] }];
  s.risk = syncRisk(s, s.now); assert.equal(s.risk.latched, true);
  const ui = await boot(t, s); await ui.click('[data-page="settings"]');
  const form = ui.document.querySelector('#settings-form');
  const usdt = [...form.querySelectorAll('[data-quote-policy-row]')].find(row => row.querySelector('[data-field="quote"]').value === 'USDT');
  usdt.querySelector('[data-field="rebalance"]').value = ''; usdt.querySelector('[data-field="loss"]').value = '';
  const capitalRows = [...form.querySelectorAll('[data-capital-policy-row]')];
  await ui.click(capitalRows.find(row => row.querySelector('[data-field="asset"]').value === 'BTC').querySelector('[data-policy-remove]'));
  const moved = capitalRows.find(row => row.querySelector('[data-field="asset"]').value === 'ETH');
  moved.querySelector('[data-field="asset"]').value = 'XRP';
  moved.querySelector('option[selected]').removeAttribute('selected'); moved.querySelector('option[value="binance"]').setAttribute('selected', '');
  await ui.submit(form);
  assert.equal(ui.document.querySelector('#notice').textContent, '设置已保存。');
  const posted = ui.requests.find(x => x.url === '/api/config').payload.config;
  assert.equal(posted.costs.rebalanceByQuote.USDT, null); assert.equal(posted.risk.dailyLossByQuote.USDT, null);
  assert.equal(posted.capital.byExchange.binance.BTC, null); assert.equal(posted.capital.byExchange.okx.ETH, null);
  assert.deepEqual(s.config.costs.rebalanceByQuote, { USDC: '0.2' }); assert.deepEqual(s.config.risk.dailyLossByQuote, { USDC: '6' });
  assert.deepEqual(s.config.capital.byExchange.binance, { SOL: caps, XRP: caps }); assert.deepEqual(s.config.capital.byExchange.okx, {});
  assert.equal(s.risk.latched, true); assert.equal(s.risk.latches.USDT.loss, '5');
  assert.match(ui.document.querySelector('#content').textContent, /已锁定 · 停止新单/);
  assert.equal(ui.document.querySelectorAll('[data-capital-policy-row]').length, 2);
});

test('成本与流动性详情及持久化风险状态转义全部配置字符串，旧快照安全显示', async t => {
  const s = snapshot(), attack = '"><img src=x onerror=alert(1)>';
  s.config.costs = { rebalanceByQuote: { [attack]: attack } };
  s.config.capital = { enabled: true, byExchange: { binance: { [attack]: { reserve: attack, maxOrder: attack, maxHolding: attack } }, okx: {} } };
  s.risk = { latched: true, day: attack, timeZone: attack, lossByQuote: { [attack]: '3' }, limits: { [attack]: '2' }, latches: { [attack]: { day: attack, loss: attack, limit: attack, at: s.now } } };
  s.opportunities['BTC/USDT'] = { at: s.now, directions: [{ buyExchange: 'binance', sellExchange: 'okx', reasons: [], executionNet: '1.2', rebalanceCost: '.1', totalCosts: '.4', netBps: '10.5', buySpreadBps: '1', sellSpreadBps: '2', bookSkewMs: 31, buyDepthNotional: '300', sellDepthNotional: '400' }] };
  const ui = await boot(t, s);
  assert.match(ui.document.querySelector('#content').textContent, /保守净收益率（买入最坏成本口径）/);
  assert.match(ui.document.querySelector('#content').textContent, /10.5 bp/); assert.match(ui.document.querySelector('#content').textContent, /31 ms/);
  assert.match(ui.document.querySelector('#content').textContent, /停止新单/);
  assert.equal(ui.document.querySelector('#content img'), null);
  await ui.click('[data-page="settings"]');
  assert.equal(ui.document.querySelector('#content img'), null); assert.equal(ui.document.querySelector('#content script'), null);
  assert.equal(ui.document.querySelector('[data-capital-policy-row] [data-field="asset"]').value, attack);
  delete s.risk; delete s.config.costs; delete s.config.filters; delete s.config.capital; delete s.config.risk;
  s.opportunities['BTC/USDT'].directions = [{ buyExchange: 'binance', sellExchange: 'okx', reasons: [] }];
  await ui.click('[data-page="opportunities"]'); await ui.poll();
  assert.match(ui.document.querySelector('#content').textContent, /风险状态尚未读取/);
  assert.equal(ui.document.querySelector('#risk-reset'), null);
  await ui.click('[data-page="settings"]');
  assert.equal(ui.document.querySelector('[name="filterMinNetBps"]').value, '0');
});

test('资金配额预览区分缓存估计与资金未核对，始终保留提交前重新复核提示', async t => {
  const s = snapshot(); s.config.capital.enabled = true;
  s.opportunities['BTC/USDT'] = { at: s.now, directions: [{ buyExchange: 'binance', sellExchange: 'okx', reasons: [], capital: { enabled: true, checked: true, status: 'CACHED', source: 'cache' } }] };
  s.balanceDirections['BTC/USDT'] = { reasons: ['余额过期'], capital: { enabled: true, checked: false, status: 'UNCONFIRMED', source: 'cache', error: 'OKX 余额过期' } };
  const ui = await boot(t, s);
  assert.match(ui.document.querySelector('#content').textContent, /缓存配额估计/);
  assert.match(ui.document.querySelector('#content').textContent, /提交前仍须刷新余额、盘口并完成最终复核/);
  s.opportunities['BTC/USDT'].directions[0].capital = { enabled: true, checked: false, status: 'UNCONFIRMED', error: '<img src=x>余额缺失' };
  await ui.poll();
  assert.match(ui.document.querySelector('#content').textContent, /资金未核对/);
  assert.equal(ui.document.querySelector('#content img'), null);
  await ui.click('[data-page="balance"]');
  assert.match(ui.document.querySelector('#content').textContent, /资金未核对/);
  assert.match(ui.document.querySelector('#content').textContent, /OKX 余额过期/);
  assert.ok(ui.requests.every(x => ['/api/session', '/api/state'].includes(x.url)));
});

test('熔断复位要求逐字确认，仅发送风险复位请求，不启动实盘或交易所刷新', async t => {
  const s = snapshot(); s.risk.latched = true; s.risk.latches = { USDT: { day: '2026-11-04', loss: '5', limit: '5', at: s.now } };
  const ui = await boot(t, s);
  assert.equal(ui.document.querySelector('#risk-reset').disabled, false);
  await ui.click('#risk-reset');
  const form = ui.document.querySelector('#modal form');
  form.querySelector('[name="confirm"]').value = '确认'; await ui.submit(form);
  assert.equal(ui.requests.filter(x => x.url === '/api/risk/reset').length, 0);
  form.querySelector('[name="confirm"]').value = '确认复位风险熔断'; await ui.submit(form);
  const reset = ui.requests.find(x => x.url === '/api/risk/reset'); assert.ok(reset);
  assert.equal(reset.options.headers['X-CSRF-Token'], 'test-ui-csrf'); assert.deepEqual(reset.payload, { confirm: '确认复位风险熔断' });
  assert.equal(ui.requests.filter(x => x.options.method === 'POST').length, 1);
  await ui.poll(); await ui.click('[data-page="errors"]'); await ui.click('[data-page="opportunities"]');
  assert.ok(ui.requests.every(x => ['/api/session', '/api/state', '/api/risk/reset'].includes(x.url)));
  assert.equal(s.config.autoTrading, false);
});

test('实盘开启、批次执行或未核对订单时，DOM 复位操作阻塞且不发送请求', async t => {
  const s = snapshot(); s.risk.latched = true;
  const ui = await boot(t, s);
  for (const mode of ['live', 'busy', 'unresolved']) {
    s.config.autoTrading = mode === 'live'; s.engine.busy = mode === 'busy';
    s.batches = mode === 'unresolved' ? [{ status: 'UNKNOWN' }] : [];
    await ui.poll(); assert.equal(ui.document.querySelector('#risk-reset').disabled, true, mode);
    await ui.click('#risk-reset');
    assert.equal(ui.document.querySelector('#modal').hasAttribute('open'), false, mode);
  }
  assert.equal(ui.requests.filter(x => x.url === '/api/risk/reset').length, 0);
});
