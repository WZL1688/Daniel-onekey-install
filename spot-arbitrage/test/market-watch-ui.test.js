import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { defaults } from '../src/store.js';

let imports = 0;
const tick = async () => { for (let i = 0; i < 5; i++) await nextTurn(); };
const watchDefaults = () => ({ enabled: false, volumeRatio: '3', priceMoveBps: '500', rejectionBps: '500', cooldownMs: 1800000 });
function snapshot() {
  const s = defaults(); s.now = Date.now(); s.config.pairs = ['BTC/USDT'];
  s.config.marketWatch = watchDefaults(); s.marketWatch = { enabled: false, samples: {}, alerts: [] };
  s.engine = { ...s.engine, busy: false, estimatedCycleMs: 3000 };
  s.liveReasons = ['实盘验收未完成']; s.balanceDirections = { 'BTC/USDT': { reasons: ['暂无盘口'] } };
  s.risk = { latched: false, day: '2026-11-19', timeZone: 'Asia/Shanghai', lossByQuote: {}, limits: {}, latches: {} };
  s.rates = Object.fromEntries(s.config.exchanges.map(ex => [ex, { metrics: { public: 0, private: 0, orders: 0, limited: 0, delayed: 0, lastLatencyMs: 0, waitMs: 0 }, windows: {}, queue: [] }]));
  return s;
}
function sample(s, extra = {}) {
  return { exchange: 'binance', pair: 'ADA/USDT', status: 'READY', observedAt: s.now - 200, lastClosedAt: s.now - 1000,
    barsUsed: 870, volume5m: '90', meanVolume5m: '20', volumeRatio5m: '4.5', baselineBars: 12, price1hBps: '-650', price24hBps: '250', high72h: '10', low72h: '5', fromLow72hBps: '2000', toHigh72hBps: '4000',
    rejection15m: { at: s.now - 2000, high: '10', close: '9.4', drawdownBps: '600', new72hHigh: true }, missing: [],
    signals: [{ code: 'VOLUME_EXPANSION', at: s.now - 1000, value: '4.5' }, { code: 'FAST_MOVE', at: s.now - 1000, value: '-650' }, { code: 'HIGH_REJECTION', at: s.now - 2000, value: '600' }], ...extra };
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
    if (url === '/api/session') result = { csrf: 'market-watch-ui-csrf' };
    else if (url === '/api/state') result = rawState ? s : structuredClone(s);
    else if (url === '/api/config') {
      s.config = { ...s.config, ...payload.config };
      s.marketWatch = { ...(s.marketWatch || {}), enabled: s.config.marketWatch?.enabled === true };
      result = { config: s.config };
    } else throw Error('Unexpected UI request: ' + url);
    return { ok: true, json: async () => result };
  } });
  t.after(async () => { await tick(); Object.assign(globalThis, previous); });
  await import('../public/app.js?marketWatchUI=' + (++imports));
  const click = async selector => { const el = document.querySelector(selector); assert.ok(el, selector); el.dispatchEvent(new window.Event('click', { bubbles: true })); await tick(); };
  return { s, document, requests, click, poll: async () => { await poll(); await tick(); }, submit: async form => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); } };
}
function row(ui, id) { return [...ui.document.querySelectorAll('[data-market-pair]')].find(el => el.getAttribute('data-market-pair') === id); }
function panel(ui) { return [...ui.document.querySelectorAll('.card')].find(card => card.querySelector('h2')?.textContent === '现货量价观察'); }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

test('旧快照缺少量价字段仍正常渲染，默认关闭且不产生额外请求', async t => {
  const s = snapshot(); delete s.config.marketWatch; delete s.marketWatch;
  const ui = await boot(t, s);
  assert.match(panel(ui).textContent, /观察已关闭/);
  assert.match(panel(ui).textContent, /没有新增观察请求/);
  assert.equal(ui.document.querySelectorAll('#nav button').length, 8);
  await ui.click('[data-page="settings"]');
  const form = ui.document.querySelector('#settings-form');
  assert.equal(form.querySelector('[name="marketWatchEnabled"]').hasAttribute('checked'), false);
  assert.equal(form.querySelector('[name="marketWatchVolumeRatio"]').value, '3');
  assert.equal(form.querySelector('[name="marketWatchCooldownMinutes"]').value, '30');
  assert.ok(ui.requests.every(request => ['/api/session', '/api/state'].includes(request.url)));
});

test('量价设置按单位序列化并带CSRF，不打开自动扫描或实盘、不清除旧费用风控', async t => {
  const s = snapshot(); s.config.fees.binance = '0.0007'; s.config.risk.dailyLossByQuote.USDT = '3';
  const ui = await boot(t, s); await ui.click('[data-page="settings"]');
  const form = ui.document.querySelector('#settings-form');
  form.querySelector('[name="marketWatchEnabled"]').checked = true;
  form.querySelector('[name="marketWatchVolumeRatio"]').value = '4.5';
  form.querySelector('[name="marketWatchPriceMoveBps"]').value = '650';
  form.querySelector('[name="marketWatchRejectionBps"]').value = '400';
  form.querySelector('[name="marketWatchCooldownMinutes"]').value = '12.5';
  await ui.submit(form);
  const posts = ui.requests.filter(request => request.options.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].url, '/api/config');
  assert.equal(posts[0].options.headers['X-CSRF-Token'], 'market-watch-ui-csrf');
  assert.deepEqual(posts[0].payload.config.marketWatch, { enabled: true, volumeRatio: '4.5', priceMoveBps: '650', rejectionBps: '400', cooldownMs: 750000 });
  assert.equal(posts[0].payload.config.scannerAuto, false); assert.equal(posts[0].payload.config.autoTrading, undefined);
  assert.equal(s.config.autoTrading, false); assert.equal(s.config.fees.binance, '0.0007'); assert.equal(s.config.risk.dailyLossByQuote.USDT, '3');
  const current = ui.document.querySelector('#settings-form');
  current.querySelector('[name="marketWatchCooldownMinutes"]').value = '0'; await ui.submit(current);
  assert.equal(ui.requests.filter(request => request.options.method === 'POST').length, 1);
  assert.match(ui.document.querySelector('#notice').textContent, /提醒冷却须为/);
});

test('当前观察展示闭合周期口径与正负百分比，覆盖不足的缺值保持缺失', async t => {
  const s = snapshot(); s.config.marketWatch.enabled = true; s.marketWatch.enabled = true;
  s.marketWatch.samples = {
    'ADA/USDT': sample(s),
    'NEW/USDT': sample(s, { status: 'PARTIAL', volume5m: '0', meanVolume5m: '0', volumeRatio5m: null, price1hBps: null, price24hBps: null, high72h: null, low72h: null, fromLow72hBps: null, toHigh72hBps: null, rejection15m: null, missing: ['72h', '1h'], signals: [] }),
  };
  const ui = await boot(t, s), ready = row(ui, 'ADA/USDT'), partial = row(ui, 'NEW/USDT');
  assert.match(ready.textContent, /Binance 现货/); assert.match(ready.textContent, /4\.5 倍/);
  assert.match(ready.textContent, /1 小时 -6\.5%/); assert.match(ready.textContent, /24 小时 2\.5%/);
  assert.match(ready.textContent, /冲高回落观察 6%/); assert.match(ready.textContent, /距 72 小时高点回撤 40%/);
  assert.match(partial.textContent, /覆盖不足/); assert.match(partial.textContent, /1 小时 —/); assert.match(partial.textContent, /24 小时 —/);
  assert.doesNotMatch(partial.textContent, /1 小时 0%|24 小时 0%/);
  assert.match(panel(ui).textContent, /前 12 柱同周期平均/); assert.match(panel(ui).textContent, /成交额不等于可成交深度/);
  assert.doesNotMatch(panel(ui).textContent, /翻倍|钉顶|出货|开多|开空|买入信号/);
});

test('过期、失败、禁用及未来采样不显示当前信号，旧数值仅为历史', async t => {
  const s = snapshot(); s.config.marketWatch.enabled = true; s.marketWatch.enabled = true;
  s.marketWatch.samples = {
    'STALE/USDT': sample(s, { lastClosedAt: s.now - 400000 }),
    'FAIL/USDT': sample(s, { status: 'UNAVAILABLE', error: '读取失败', volumeRatio5m: '88' }),
    'OFF/USDT': sample(s, { status: 'DISABLED' }),
    'FUTURE/USDT': sample(s, { lastClosedAt: s.now + 1000 }),
    'CLOCK/USDT': sample(s, { clockOffsetMs: 50000 }),
  };
  const ui = await boot(t, s);
  for (const id of Object.keys(s.marketWatch.samples)) {
    const element = row(ui, id); assert.match(element.textContent, /历史/); assert.match(element.textContent, /不展示当前信号/);
    assert.equal(element.querySelector('.positive'), null); assert.doesNotMatch(element.textContent, /成交额放大 4\.5|快速涨跌 -6\.5|冲高回落观察 6%/);
  }
  assert.match(row(ui, 'CLOCK/USDT').textContent, /数据不可用/);
  s.config.marketWatch.enabled = false; s.marketWatch.enabled = false; await ui.poll();
  assert.ok([...ui.document.querySelectorAll('[data-market-pair]')].every(element => element.textContent.includes('观察已关闭')));
});

test('观察字段及历史提醒严格转义，提醒只显示本机历史且最多20条', async t => {
  const s = snapshot(); s.config.marketWatch.enabled = true; s.marketWatch.enabled = true;
  s.marketWatch.samples = { '<img src=x>/USDT': sample(s, { status: 'UNAVAILABLE', error: '<script>remote()</script>', missing: ['<img src=x>'], high72h: '<img src=x>' }) };
  s.marketWatch.alerts = Array.from({ length: 25 }, (_, index) => ({ id: String(index), pair: index === 24 ? '<img src=x>/USDT' : 'ADA/USDT', code: index === 24 ? '<script>remote()</script>' : 'VOLUME_EXPANSION', at: s.now - 1000, observedAt: s.now - 25 + index, value: index === 24 ? '<img src=x>' : '4', source: 'binance' }));
  const ui = await boot(t, s), section = panel(ui);
  assert.equal(section.querySelectorAll('[data-market-alert]').length, 20);
  assert.match(section.textContent, /<script>remote\(\)<\/script>/);
  assert.match(section.textContent, /历史提醒，事件闭合/);
  assert.equal(section.querySelector('script'), null); assert.equal(section.querySelector('img'), null);
  assert.ok(ui.requests.every(request => ['/api/session', '/api/state'].includes(request.url)));
});

test('反复渲染不修改缓存、提醒或候选排序，不新增导航或外部交易请求', async t => {
  const s = snapshot(); s.config.marketWatch.enabled = true; s.marketWatch.enabled = true;
  s.marketWatch.samples = { 'LOW/USDT': sample(s), 'HIGH/USDT': sample(s, { signals: [] }) };
  const direction = amount => ({ buyExchange: 'binance', sellExchange: 'okx', qty: '1', amount: '20', net: amount, conservative: amount, netBps: '12', sampleAt: s.now, at: s.now, eligible: true, reasons: [] });
  s.scanResults = { 'LOW/USDT': { at: s.now, directions: [direction('1')] }, 'HIGH/USDT': { at: s.now, directions: [direction('5')] } };
  s.marketWatch.alerts = [{ id: 'local', pair: 'LOW/USDT', code: 'FAST_MOVE', at: s.now - 1000, observedAt: s.now, value: '-650', source: 'binance' }];
  freeze(s); const before = JSON.stringify(s), ui = await boot(t, s, { rawState: true });
  for (let i = 0; i < 20; i++) await ui.poll();
  assert.equal(JSON.stringify(s), before);
  assert.equal(ui.document.querySelectorAll('#nav button').length, 8);
  assert.deepEqual([...ui.document.querySelectorAll('[data-scan-pair]')].map(element => element.getAttribute('data-scan-pair')), ['HIGH/USDT', 'LOW/USDT']);
  assert.ok(ui.requests.every(request => ['/api/session', '/api/state'].includes(request.url)));
  assert.equal(ui.requests.filter(request => request.options.method === 'POST').length, 0);
});
