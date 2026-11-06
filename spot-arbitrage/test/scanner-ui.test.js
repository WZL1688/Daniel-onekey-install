import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { defaults } from '../src/store.js';
import { validateConfig } from '../src/engine.js';

let imports = 0;
const tick = async () => { for (let i = 0; i < 5; i++) await nextTurn(); };
function snapshot() {
  const s = defaults(); s.now = Date.now(); s.config.pairs = ['BTC/USDT'];
  s.config.scanExcludeAssets = ['BTC', 'ETH', 'SOL']; s.config.scanPairs = [];
  s.engine = { ...s.engine, busy: false, estimatedCycleMs: 3000 };
  s.liveReasons = ['OKX 接入验收未完成'];
  s.balanceDirections = { 'BTC/USDT': { reasons: ['暂无盘口'] } };
  s.risk = { latched: false, day: '2026-11-06', timeZone: 'Asia/Shanghai', lossByQuote: {}, limits: {}, latches: {} };
  s.rates = Object.fromEntries(s.config.exchanges.map(ex => [ex, { metrics: { public: 0, private: 0, orders: 0, limited: 0, delayed: 0, lastLatencyMs: 0, waitMs: 0 }, windows: {}, queue: [] }]));
  return s;
}
function direction(s, conservative, eligible = true, extra = {}) {
  return { buyExchange: 'binance', sellExchange: 'okx', qty: '1', amount: '20', net: conservative,
    conservative, netBps: '12', buyDepthNotional: '200', sellDepthNotional: '150', sampleAt: s.now,
    at: s.now, eligible, reasons: eligible ? [] : ['有效深度未满足门槛'], ...extra };
}
class DOMFormData {
  constructor(form) {
    this.values = [...form.querySelectorAll('input[name],select[name],textarea[name]')]
      .filter(el => !el.disabled && (!['checkbox', 'radio'].includes(el.type) || (el.checked ?? el.hasAttribute('checked'))))
      .map(el => [el.name, el.value || (el.type === 'checkbox' ? 'on' : '')]);
  }
  get(key) { return this.values.find(([name]) => name === key)?.[1] ?? null; }
  has(key) { return this.values.some(([name]) => name === key); }
  [Symbol.iterator]() { return this.values[Symbol.iterator](); }
}
async function boot(t, s = snapshot(), { rawState = false } = {}) {
  const { document, window } = parseHTML(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  const previous = Object.fromEntries(['document', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'FormData'].map(key => [key, globalThis[key]]));
  const requests = []; let poll;
  const dialog = document.querySelector('#modal'); dialog.showModal = () => dialog.setAttribute('open', ''); dialog.close = () => dialog.removeAttribute('open');
  Object.assign(globalThis, { document, FormData: DOMFormData, setTimeout: () => 0, clearTimeout: () => {}, setInterval: callback => { poll = callback; return 0; }, fetch: async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, options, payload }); let result;
    if (url === '/api/session') result = { csrf: 'scanner-ui-csrf' };
    else if (url === '/api/state') result = rawState ? s : structuredClone(s);
    else if (url === '/api/config') { s.config = validateConfig(payload.config, s.config, payload.confirm); result = { config: s.config }; }
    else if (url === '/api/scan') { s.engine.scanRun = { id: 'ui-run', status: 'PREPARING', total: 0, completed: 0, failed: 0, startedAt: s.now, endedAt: null, currentPair: null, mode: 'manual' }; result = { queued: true }; }
    else if (url === '/api/scan/stop') { if (s.engine.scanRun) s.engine.scanRun.status = 'STOPPED'; s.config.scannerAuto = false; result = { stopped: true }; }
    else throw Error('Unexpected UI request: ' + url);
    return { ok: true, json: async () => result };
  } });
  t.after(async () => { await tick(); Object.assign(globalThis, previous); });
  await import('../public/app.js?scannerUI=' + (++imports));
  const click = async selector => { const el = typeof selector === 'string' ? document.querySelector(selector) : selector; assert.ok(el, String(selector)); el.dispatchEvent(new window.Event('click', { bubbles: true })); await tick(); };
  return { s, document, requests, click, poll: async () => { await poll(); await tick(); }, submit: async form => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); } };
}

function rows(ui) { return [...ui.document.querySelectorAll('[data-scan-pair]')]; }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }

test('候选池设置兼容旧快照并使用会话CSRF保存名单，不清除费用与风险设置', async t => {
  const s = snapshot(); delete s.config.scanExcludeAssets; delete s.config.scanPairs;
  s.config.fees.binance = '0.0005'; s.config.risk.dailyLossByQuote.USDT = '3';
  const ui = await boot(t, s); await ui.click('[data-page="settings"]');
  const form = ui.document.querySelector('#settings-form');
  assert.equal(form.querySelector('[name="scanExcludeAssets"]').value, 'BTC, ETH, SOL');
  assert.equal(form.querySelector('[name="scanPairs"]').value, '');
  form.querySelector('[name="scanExcludeAssets"]').value = 'btc, eth, bnb';
  form.querySelector('[name="scanPairs"]').value = 'ada/usdt, dot/usdt';
  await ui.submit(form);
  const saved = ui.requests.find(request => request.url === '/api/config');
  assert.ok(saved); assert.equal(saved.options.method, 'POST'); assert.equal(saved.options.headers['X-CSRF-Token'], 'scanner-ui-csrf');
  assert.deepEqual(saved.payload.config.scanExcludeAssets, ['BTC', 'ETH', 'BNB']);
  assert.deepEqual(saved.payload.config.scanPairs, ['ADA/USDT', 'DOT/USDT']);
  assert.equal(s.config.fees.binance, '0.0005'); assert.equal(s.config.risk.dailyLossByQuote.USDT, '3');
  assert.ok(ui.requests.every(request => ['/api/session', '/api/state', '/api/config'].includes(request.url)));
});

test('候选排序优先有效且满足门槛，历史正利润和最近失败不伪装成当前机会', async t => {
  const s = snapshot();
  s.scanResults = {
    'FAIL/USDT': { at: s.now, failedAt: s.now, failed: true, error: '最新连接失败', directions: [direction(s, '1000')] },
    'OLD/USDT': { at: s.now - 10000, directions: [direction(s, '999', true, { sampleAt: s.now - 10000 })] },
    'HIGH/USDT': { at: s.now, directions: [direction(s, '10', false)] },
    'LOW/USDT': { at: s.now, directions: [direction(s, '2')] },
  };
  const ui = await boot(t, s), result = rows(ui);
  assert.deepEqual(result.map(row => row.getAttribute('data-scan-pair')), ['LOW/USDT', 'HIGH/USDT', 'OLD/USDT', 'FAIL/USDT']);
  assert.match(result[0].textContent, /通过 · 待复核/); assert.match(result[1].textContent, /不满足/);
  assert.match(result[2].textContent, /已过期.*历史/s); assert.equal(result[2].querySelector('.positive'), null);
  assert.match(result[3].textContent, /最近失败.*最新连接失败/s); assert.equal(result[3].querySelector('.positive'), null);
  assert.match(ui.document.querySelector('#content').textContent, /没有真实流通市值数据/);
  assert.match(ui.document.querySelector('#content').textContent, /同名交易对仍需核对为同一资产/);
});

test('候选池仅展示当前名单，试算按金额分组，失败原因和恶意文本全部转义', async t => {
  const s = snapshot();
  s.config.scanPairs = ['ADA/USDT', 'DOT/USDT', 'BTC/USDT'];
  const attempts = [{ amount: '20', net: '-0.1', conservative: '-0.2', reasons: ['<img src=x>金额20未通过'] }, { amount: '10', net: '-0.05', conservative: '-0.1', reasons: ['金额10未通过'] }];
  s.scanResults = {
    'BTC/USDT': { at: s.now, directions: [direction(s, '50')] },
    'OUT/USDT': { at: s.now, directions: [direction(s, '100')] },
    'ADA/USDT': { at: s.now, directions: [direction(s, '-0.2', false, { attempts })] },
    'DOT/USDT': { at: s.now, failedAt: s.now, error: '<script>remote()</script>服务器失败', directions: [direction(s, '1')] },
  };
  const ui = await boot(t, s);
  assert.deepEqual(rows(ui).map(row => row.getAttribute('data-scan-pair')), ['ADA/USDT', 'DOT/USDT']);
  const text = ui.document.querySelector('#content').textContent;
  assert.match(text, /试算金额 20/); assert.match(text, /试算金额 10/);
  assert.match(text, /金额20未通过/); assert.match(text, /<script>remote\(\)<\/script>服务器失败/);
  assert.equal(ui.document.querySelector('#content img'), null); assert.equal(ui.document.querySelector('#content script'), null);
  assert.equal(rows(ui)[0].querySelectorAll('details').length, 1);
});

test('加入关注仅提交pairs补丁并保留配置，历史候选重新采样而非授权交易', async t => {
  const s = snapshot(); s.config.fees.binance = '0.0007';
  s.scanResults = { 'ADA/USDT': { at: s.now - 10000, directions: [direction(s, '99', true, { sampleAt: s.now - 10000 })] } };
  const ui = await boot(t, s); await ui.click('[data-watch="ADA/USDT"]');
  const saved = ui.requests.filter(request => request.options.method === 'POST');
  assert.equal(saved.length, 1); assert.equal(saved[0].url, '/api/config');
  assert.deepEqual(saved[0].payload, { config: { pairs: ['BTC/USDT', 'ADA/USDT'] } });
  assert.equal(saved[0].options.headers['X-CSRF-Token'], 'scanner-ui-csrf'); assert.equal(s.config.fees.binance, '0.0007');
  assert.equal(ui.document.querySelector('[data-watch="ADA/USDT"]').disabled, true);
  assert.match(ui.document.querySelector('#notice').textContent, /重新采样|后台将重新采样/);
  assert.ok(ui.requests.every(request => ['/api/session', '/api/state', '/api/config'].includes(request.url)));
});

test('已关注、达到上限、实盘及执行批次时禁止加入关注，事件绕过disabled也不请求', async t => {
  const s = snapshot(); s.scanResults = { 'ADA/USDT': { at: s.now, directions: [direction(s, '1')] } };
  const ui = await boot(t, s);
  for (const blocked of ['watched', 'limit', 'live', 'busy']) {
    s.config.pairs = ['BTC/USDT']; s.config.autoTrading = false; s.engine.busy = false;
    if (blocked === 'watched') s.config.pairs.push('ADA/USDT');
    if (blocked === 'limit') s.config.pairs.push(...Array.from({ length: 29 }, (_, i) => `AS${i}/USDT`));
    if (blocked === 'live') s.config.autoTrading = true;
    if (blocked === 'busy') s.engine.busy = true;
    await ui.poll(); const button = ui.document.querySelector('[data-watch="ADA/USDT"]');
    assert.equal(button.disabled, true, blocked); await ui.click(button);
  }
  assert.equal(ui.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('扫描进度与停止只调用各自API，不启动实盘或提交交易', async t => {
  const s = snapshot(); const ui = await boot(t, s);
  await ui.click('#scan');
  assert.match(ui.document.querySelector('#content').textContent, /正在准备.*已处理 0 \/ 0/s);
  assert.equal(ui.document.querySelector('#scan').disabled, true); assert.equal(ui.document.querySelector('#scan-stop').disabled, false);
  s.engine.scanRun = { id: 'ui-run', status: 'RUNNING', total: 8, completed: 3, failed: 1, startedAt: s.now, endedAt: null, currentPair: 'ADA/USDT', mode: 'manual' };
  await ui.poll(); assert.match(ui.document.querySelector('#content').textContent, /已处理 3 \/ 8，其中失败 1 · 当前 ADA\/USDT/);
  await ui.click('#scan-stop');
  assert.equal(s.config.scannerAuto, false); assert.match(ui.document.querySelector('#content').textContent, /已停止/);
  assert.deepEqual(ui.requests.filter(request => request.options.method === 'POST').map(request => request.url), ['/api/scan', '/api/scan/stop']);
  assert.ok(ui.requests.filter(request => request.options.method === 'POST').every(request => request.options.headers['X-CSRF-Token'] === 'scanner-ui-csrf'));
  s.engine.scanRun = null; s.config.scannerAuto = true; await ui.poll();
  assert.equal(ui.document.querySelector('#scan-stop').disabled, false);
  await ui.click('#scan-stop'); assert.equal(s.config.scannerAuto, false);
});

test('反复刷新与切页不突变候选缓存、不累积导航，未来采样时间也不显示为有效机会', async t => {
  const s = snapshot();
  s.scanResults = { 'ADA/USDT': { at: s.now, directions: [direction(s, '1', true, { sampleAt: s.now + 1000, reasons: ['仅有一条原因'] })] } };
  freeze(s); const before = JSON.stringify(s), ui = await boot(t, s, { rawState: true });
  for (let i = 0; i < 20; i++) { await ui.poll(); await ui.click('[data-page="opportunities"]'); }
  assert.equal(JSON.stringify(s), before); assert.equal(ui.document.querySelectorAll('#nav button').length, 8);
  assert.match(rows(ui)[0].textContent, /已过期/); assert.equal(rows(ui)[0].querySelector('.positive'), null);
  assert.equal((rows(ui)[0].textContent.match(/仅有一条原因/g) || []).length, 1);
  assert.ok(ui.requests.every(request => ['/api/session', '/api/state'].includes(request.url)));
});


test('微小非零盘口与候选净利保留有效位，非法数字和恶意文本不显示为有效报价', async t => {
  const s = snapshot(); s.config.pairs = ['TINY/USDT'];
  s.balanceDirections = { 'TINY/USDT': { reasons: ['暂无余额'] } };
  const d = direction(s, '-1e-10', false, { buyBest: '1e-9', sellBest: '1.1e-9', buyAvg: '1e-9', sellAvg: '1.1e-9', buyLimit: '1e-9', sellLimit: '1.1e-9', buyFee: '1e-10', sellFee: 'Infinity', net: '-1e-10', buyDepthNotional: '1e-9', sellDepthNotional: '<img src=x>', netBps: 'NaN' });
  s.opportunities = { 'TINY/USDT': { at: s.now, directions: [d] } };
  s.scanResults = { 'TINY/USDT': { at: s.now, directions: [structuredClone(d)] } };
  const book = { at: s.now, stale: false, bids: [['1e-9', '100']], asks: [['1.1e-9', '<img src=x>']], receivedBidLevels: 1, receivedAskLevels: 1, bidLevels: 1, askLevels: 1 };
  s.books = { binance: { 'TINY/USDT': book }, okx: { 'TINY/USDT': structuredClone(book) } };
  const ui = await boot(t, s), text = ui.document.querySelector('#content').textContent;
  const books = [...ui.document.querySelectorAll('.book')];
  assert.equal(books.length, 2);
  for (const card of books) {
    assert.match(card.textContent, /0\.000000001/);
    assert.match(card.textContent, /0\.0000000011/);
    assert.equal(card.querySelector('img'), null);
  }
  assert.match(text, /-0\.0000000001/);
  assert.match(text, /0\.0000000001/);
  assert.match(rows(ui)[0].textContent, /买侧 0\.000000001/);
  assert.match(rows(ui)[0].textContent, /历史|深度 -0\.0000000001/);
  assert.doesNotMatch(text, /NaN|Infinity/);
  assert.equal(ui.document.querySelector('#content img'), null);
  assert.equal(ui.document.querySelector('#content script'), null);
  assert.ok(ui.requests.every(request => ['/api/session', '/api/state'].includes(request.url)));
});
