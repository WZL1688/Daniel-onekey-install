// Local fixture only: no signing, actual quotes, RPC requests or live trades.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { startLocalServer } from '../src/server.mjs';
const { server, url } = await startLocalServer({ engine: { config: { mode: 'demo' }, snapshot: () => ({ engine: {} }) }, store: {}, vault: {} });
const calls = [], forbidden = [], errors = [], policy = 'a'.repeat(64), now = Date.now();
const report = (id, patch = {}) => ({ assetId: 'coingecko:' + id, symbol: id.toUpperCase(), assetRevision: 2, parentRevision: 0, parentPolicyFingerprint: policy, mode: 'live', readOnly: true, executable: false, qualityPassed: true, simulationVerified: false, amountUsd: 5, netProfitUsd: .2, stressNetProfitUsd: .16, gasUsd: .01, slippageUsd: .03, priceImpactBps: 100, expiresAt: new Date(now + 60000).toISOString(), reasons: [], ...patch });
let quality = { enabled: false, busy: false, lastError: '', lastAttemptAt: now, reports: [report('alpha'), report('beta', { stressNetProfitUsd: .18 }), report('demo', { mode: 'demo', stressNetProfitUsd: 70000 }), report('expired', { expiresAt: new Date(now - 1).toISOString() }), report('wrong-revision', { parentRevision: 9 }), report('wrong-policy', { parentPolicyFingerprint: 'b'.repeat(64) }), report('unsigned-executable', { executable: true }), report('missing-fee', { gasUsd: null }), report('stress-fail', { stressNetProfitUsd: .01 }), report('failure', { qualityPassed: false, reasons: ['高价链库存不足 <img src=x onerror="window.injection=true">'] })] };
const stats = (patch = {}) => ({ mode: 'live', executionMode: 'inventory', scope: { kind: 'global' }, window: { limit: 200 }, counts: { attempts: 0, successes: 0, verifiedLosses: 0, unknown: 0, failed: 0, pending: 0 }, observedRate: null, wilsonLowerBound: null, wilsonUpperBound: null, minSamples: 100, targetRate: .7, confidence: .95, historicalEvidenceMet: false, ...patch });
let performance = stats(), readFails = false, hold = false, release;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/') && !['/api/opportunities/quality', '/api/opportunities/quality/enabled', '/api/performance'].includes(path)) forbidden.push(request.method() + ' ' + path); });
  await page.route('**/quality-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="fixture-main"><div id="quality-root"></div></main><script type="module">import {createQualityPanel} from '/quality-panel.js';window.appState={config:{mode:'demo',executionMode:'inventory',risk:{amountUsd:5,minProfitUsd:.03}},engine:{configRevision:0,configuring:false,pausedReason:''},policyFingerprint:'${policy}',features:{quality:true,performance:true}};window.opens=[];window.notices=[];window.apiCount=0;window.panel=createQualityPanel({getState:()=>window.appState,onOpenAsset:id=>window.opens.push(id),toast:(...args)=>window.notices.push(args),api:(path,options={})=>{window.apiCount++;return fetch(path,{method:options.method||'GET',signal:options.signal,headers:{'Content-Type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})}).then(async response=>{if(!response.ok)throw new Error('secret-canary-hidden');return response.json();});}});window.panel.mount(document.querySelector('#quality-root'));</script></body></html>` }));
  await page.route('**/api/opportunities/quality**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    calls.push({ path, method, body: method === 'POST' ? request.postDataJSON() : null });
    if (method === 'POST') { assert.equal(path, '/api/opportunities/quality/enabled'); quality.enabled = request.postDataJSON().enabled; return route.fulfill({ json: quality }); }
    if (hold) await new Promise(resolve => { release = resolve; });
    if (readFails) return route.fulfill({ status: 500, json: { error: 'secret-canary-hidden' } }).catch(() => {});
    return route.fulfill({ json: quality }).catch(() => {});
  });
  await page.route('**/api/performance**', route => { calls.push({ path: new URL(route.request().url()).pathname, query: new URL(route.request().url()).search, method: route.request().method() }); return route.fulfill({ json: performance }); });
  await page.goto(url + '/quality-test');
  const cards = page.locator('.quality-report');
  await expect(cards).toHaveCount(2); await expect(cards.first()).toHaveAttribute('data-quality-asset', 'coingecko:beta');
  await expect(page.locator('.quality-panel')).toContainText('不签名、不下单');
  await expect(page.locator('.quality-panel')).toContainText('未进行成交模拟');
  assert.equal((await page.locator('.quality-panel').textContent()).includes('70,000'), false);
  await expect(page.locator('[data-performance-rate]')).toHaveText('已观察盈利比例：尚无真实样本');
  await expect(page.locator('[data-performance-lower]')).toHaveText('95% Wilson 区间下限：尚无统计');
  await expect(page.locator('[data-performance-evidence]')).toContainText('盈利能力尚未验证');
  await cards.first().locator('[data-quality-open]').click(); assert.deepEqual(await page.evaluate(() => window.opens), ['coingecko:beta']);
  await page.locator('.quality-panel details summary').click(); await expect(page.locator('.quality-panel details')).toContainText('<img src=x');
  assert.equal(await page.locator('.quality-panel img').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.injection)), false);
  console.log('PASS real read-only quotes stay separate from parent demo, require complete current reports and rank by stress estimate; no samples never display an invented rate');

  const before = await page.evaluate(() => window.apiCount);
  await page.evaluate(() => window.panel.mount(document.querySelector('#quality-root')));
  assert.equal(await page.evaluate(() => window.apiCount), before);
  for (const update of [{ engine: { configRevision: 1 } }, { policyFingerprint: 'c'.repeat(64) }, { config: { mode: 'live', executionMode: 'inventory', risk: { amountUsd: 4, minProfitUsd: .03 } } }]) {
    await page.evaluate(update => { Object.assign(window.appState, update);window.panel.mount(document.querySelector('#quality-root')); }, update);
    await expect(cards).toHaveCount(0);
    await page.evaluate(policy => {window.appState.engine={configRevision:0,configuring:false,pausedReason:''};window.appState.policyFingerprint=policy;window.appState.config={mode:'demo',executionMode:'inventory',risk:{amountUsd:5,minProfitUsd:.03}};window.panel.mount(document.querySelector('#quality-root'));}, policy);
    await expect(cards).toHaveCount(2);
  }
  quality.reports = [report('short', { expiresAt: new Date(Date.now() + 300).toISOString() })];
  await page.evaluate(() => window.panel.refresh({ force: true })); await expect(cards).toHaveCount(1);
  const expiryReads = await page.evaluate(() => window.apiCount); await expect(cards).toHaveCount(0, { timeout: 2000 }); assert.equal(await page.evaluate(() => window.apiCount), expiryReads);
  console.log('PASS remount is idempotent; wallet/policy/amount changes and expiry remove passed quotes without extra requests');

  performance = stats({ counts: { attempts: 100, successes: 70, verifiedLosses: 10, unknown: 5, failed: 10, pending: 5 }, observedRate: .7, wilsonLowerBound: .604, wilsonUpperBound: .781 });
  await page.evaluate(() => window.panel.refresh({ force: true }));
  await expect(page.locator('[data-performance-rate]')).toContainText('70.0%'); await expect(page.locator('[data-performance-lower]')).toContainText('60.4%');
  await expect(page.locator('[data-performance-evidence]')).toContainText('未达到七成');
  for (const [key, number] of Object.entries(performance.counts)) await expect(page.locator(`[data-performance-count="${key}"]`)).toHaveText(String(number));
  performance = stats({ counts: { attempts: 100, successes: 90, verifiedLosses: 10, unknown: 0, failed: 0, pending: 0 }, observedRate: .9, wilsonLowerBound: .826, wilsonUpperBound: .945, historicalEvidenceMet: true });
  await page.evaluate(() => window.panel.refresh({ force: true })); await expect(page.locator('[data-performance-evidence]')).toContainText('历史窗口达到证据门槛，不能保证未来七成');
  await expect(page.locator('.performance-panel')).toContainText('不能作为某一代币的成功率');
  await expect(page.locator('.performance-panel')).toContainText('未包含未来补库费用');
  performance = stats({ mode: 'demo', historicalEvidenceMet: true }); await page.evaluate(() => window.panel.refresh({ force: true })); await expect(page.locator('[data-performance-count]')).toHaveCount(0);
  performance = stats({ executionMode: 'bridge' }); await page.evaluate(() => {window.appState.config.executionMode='bridge';return window.panel.refresh({force:true});});
  await expect(page.locator('.performance-panel')).toContainText('跨链套利模式'); assert(calls.some(call => call.query === '?executionMode=bridge'));
  console.log('PASS real archive counts keep failures and unknown results; historical lower-bound target is separate from observed rate, demo and execution modes');

  const toggle = page.locator('[data-quality-toggle]'); await toggle.click();
  await expect(toggle).toHaveText('停止自动只读复核');
  await page.evaluate(() => window.panel.mount(document.querySelector('#quality-root'))); await toggle.click(); await expect(toggle).toHaveText('开启自动只读复核');
  const posts = calls.filter(call => call.method === 'POST'); assert.deepEqual(posts.map(call => call.body), [{ enabled: true }, { enabled: false }]);
  assert(posts.every(call => call.path === '/api/opportunities/quality/enabled'));
  readFails = true; await page.evaluate(() => window.panel.refresh({ force: true })); await expect(cards).toHaveCount(0); await expect(page.locator('[data-quality-status]')).toContainText('读取失败');
  assert.equal((await page.locator('#quality-root').textContent()).includes('secret-canary-hidden'), false);
  readFails = false; await page.evaluate(() => window.panel.refresh({ force: true }));
  const disableReads = await page.evaluate(() => window.apiCount);
  await page.evaluate(() => {window.appState.features={quality:false,performance:false};return window.panel.refresh({force:true});});
  assert.equal(await page.evaluate(() => window.apiCount), disableReads); await expect(toggle).toBeDisabled(); await expect(page.locator('[data-quality-status]')).toContainText('尚未启用');
  console.log('PASS only read-only enablement POSTs are issued; failures hide old results and raw errors, unsupported features avoid requests');

  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.evaluate(() => {window.appState.features={quality:true,performance:true};}); hold = true;
  await page.evaluate(() => {window.pendingRead=window.panel.refresh({force:true});}); await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(() => {window.panel.unmount();document.querySelector('#quality-root').innerHTML='<p>unmounted fixture</p>';});
  release(); await page.evaluate(() => window.pendingRead); await expect(page.locator('#quality-root')).toHaveText('unmounted fixture');
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS narrow viewport and aborted late read preserve unmounted view; no execution or signing endpoints called');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
