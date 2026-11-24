// Offline UI fixtures only. No real market request, signing or chain transaction.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { startLocalServer } from '../src/server.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const { server, url } = await startLocalServer({ engine: { config: { mode: 'demo' }, snapshot: () => ({ engine: {} }) }, store: {}, vault: {} });
const policy = 'a'.repeat(64), calls = [], forbidden = [], errors = [];
const asset = { id: 'manual:ui-research', revision: 2, symbol: '<img src=x onerror="window.injected=1">', enabled: true };
const quote = patch => ({ id: 'fixture-quote', assetId: asset.id, assetRevision: 2, mode: 'research', readOnly: true, executable: false,
  identityVerified: true, qualityPassed: true, parentRevision: 0, parentPolicyFingerprint: policy, amountUsd: 20,
  buyChain: 'bnb', sellChain: 'solana', netProfitUsd: .2, stressNetProfitUsd: .15, gasUsd: .02, slippageUsd: .03, estimatedRentUsd: .001, priceImpactBps: 20,
  quotedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 55000).toISOString(), reasons: [], ...patch });
const risk = { minProfitUsd: .03, maxDailyLossUsd: 5, maxInventoryLossUsd: 10, maxExposureUsd: 50, maxTokenExposureUsd: 150, inventoryPenaltyBps: 25 };
const emptyPaper = () => ({ mode: 'paper', sessionId: null, running: false, busy: false, needsReview: false, risk, stats: {} });
let snapshot = { settings: { enabled: false, amounts: [1, 2, 5, 10, 20, 50], quoteIntervalMs: 15000, maxJobsPerDay: 500 }, busy: false, globalStop: false, queue: [], assets: [asset],
  rankings: [{ assetId: asset.id, assetRevision: 2, symbol: asset.symbol, episodes: 3, refPositiveSamples: 8, positiveRealQuoteSamples: 2, dualDirections: true, referenceDurationMs: 120000, lastSeen: Date.now(), latestQuote: quote() }],
  coverage: { scope: 'single-asset-version-policy', validDurationMs: 60000, currentContinuousMs: 60000, elapsedMs: 60000, gapCount: 0, observations: 2, firstAt: Date.now() - 60000, lastAt: Date.now(), validated14Days: false },
  recentQuotes: [quote(), quote({ id: 'unverified', identityVerified: false }), quote({ id: 'past', expiresAt: new Date(Date.now() - 1).toISOString() }), quote({ id: 'old-version', assetRevision: 1 }), quote({ id: 'demo', mode: 'demo' }), quote({ id: 'fee-missing', gasUsd: null })], paper: emptyPaper() };
let held = false, release, readFails = false, browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/') && !path.startsWith('/api/onchain-research') && path !== '/api/state' && path !== '/api/session') forbidden.push(request.method() + ' ' + path); });
  await page.route('**/research-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="fixture-main"><div id="research-root"></div></main><script type="module">import {createOnchainResearchView} from '/onchain-research.js';window.appState={features:{onchainResearch:false},policyFingerprint:'${policy}',engine:{configRevision:0,busy:false,configuring:false,pausedReason:''},config:{mode:'demo',executionMode:'inventory',risk:{amountUsd:5,minProfitUsd:.03}}};window.opens=[];window.notices=[];window.panel=createOnchainResearchView({getState:()=>window.appState,onOpenAsset:id=>window.opens.push(id),toast:(...args)=>window.notices.push(args),api:async(path,options={})=>{const response=await fetch(path,{method:options.method||'GET',signal:options.signal,headers:{'Content-Type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});if(!response.ok)throw new Error('secret-canary-hidden');return response.json();}});window.panel.mount(document.querySelector('#research-root'));</script></body></html>` }));
  await page.route('**/api/onchain-research**', async route => {
    const request = route.request(), endpoint = new URL(request.url()), method = request.method(), body = method === 'POST' ? request.postDataJSON() : null;
    calls.push({ path: endpoint.pathname, query: endpoint.search, method, body });
    if (method === 'POST') {
      const path = endpoint.pathname.replace('/api/onchain-research', '');
      if (path === '/settings') snapshot.settings = { ...snapshot.settings, ...body.settings };
      if (path === '/stop') { snapshot.globalStop = true; snapshot.settings.enabled = false; snapshot.paper.running = false; }
      if (path === '/clear-stop') { assert.equal(body.confirmed, true); snapshot.globalStop = false; }
      if (path === '/paper/start') { assert.equal(body.assetId, asset.id); snapshot.paper = { ...emptyPaper(), sessionId: 'virtual-session', asset, running: true,
        positions: { bnb: { cashUsd: '50', tokenRaw: '5000', tokenDecimals: 2 }, solana: { cashUsd: '50', tokenRaw: '4000', tokenDecimals: 2 } }, reservations: { cashUsd: { bnb: '0', solana: '0' }, tokenRaw: { bnb: '0', solana: '0' } },
        stats: { contributedCapitalUsd: 200, realizedCashSpreadUsd: 0, tradingFeesUsd: 0, netEquityUsd: 200, netEquityPnlUsd: 0, maxDrawdownPct: 0, successfulBothLegsRate: null } }; }
      if (path === '/paper/pause') snapshot.paper.running = false;
      if (path === '/paper/resume') snapshot.paper.running = true;
      if (path === '/paper/settings') snapshot.paper.risk = body.risk;
      assert(['/settings', '/quote', '/matrix', '/stop', '/clear-stop', '/paper/start', '/paper/run', '/paper/pause', '/paper/resume', '/paper/settings'].includes(path));
      return route.fulfill({ status: ['/quote', '/matrix', '/paper/run'].includes(path) ? 202 : 200, json: { accepted: true } });
    }
    if (endpoint.pathname.endsWith('/history')) return route.fulfill({ json: { page: Number(endpoint.searchParams.get('page')), pageSize: 20, total: 22, totalPages: 2, items: [{ assetId: asset.id, status: '<script>window.injected=1</script>', createdAt: new Date().toISOString() }] } });
    if (held) await new Promise(resolve => { release = resolve; });
    if (readFails) return route.fulfill({ status: 500, json: { error: 'secret-canary-hidden' } }).catch(() => {});
    return route.fulfill({ json: structuredClone(snapshot) }).catch(() => {});
  });
  await page.goto(url + '/research-test');
  await expect(page.locator('[data-research-status]')).toContainText('尚未启用'); assert.equal(calls.length, 0);
  await page.evaluate(() => { window.appState.features.onchainResearch = true; return window.panel.refresh({ force: true }); });
  await expect(page.locator('[data-research-rank]')).toHaveCount(1);
  await expect(page.locator('[data-research-validation]')).toContainText('尚未完成');
  assert.equal(await page.locator('[data-research-rank] img').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  await expect(page.locator('[data-research-quotes] .badge.green')).toHaveCount(1);
  await expect(page.locator('[data-paper-stat=netEquityUsd]')).toHaveText('未知');
  await expect(page.locator('#onchain-research-view')).toContainText('20U／50U仅用于研究和 paper');
  assert.equal(calls.some(call => call.method === 'POST'), false);
  console.log('PASS explicit feature opt-in, real-quote/current-version evidence, zero real history and unknown paper values stay honest; names are escaped');

  snapshot.coverage = { ...snapshot.coverage, validated14Days: true, currentContinuousMs: 1000, elapsedMs: 30 * 86400000 };
  await page.evaluate(() => window.panel.refresh({ force: true })); await expect(page.locator('[data-research-validation]')).toContainText('尚未完成');
  snapshot.coverage.currentContinuousMs = 14 * 86400000;
  await page.evaluate(() => window.panel.refresh({ force: true })); await expect(page.locator('[data-research-validation]')).toContainText('已达到14天记录条件');
  await page.evaluate(() => { window.appState.engine.configRevision = 2; window.panel.mount(document.querySelector('#research-root')); });
  await expect(page.locator('[data-research-quotes] .badge.green')).toHaveCount(0);
  await page.evaluate(() => { window.appState.engine.configRevision = 0; window.panel.mount(document.querySelector('#research-root')); });
  snapshot.recentQuotes = [quote({ id: 'short', expiresAt: new Date(Date.now() + 350).toISOString() })];
  await page.evaluate(() => window.panel.refresh({ force: true })); await expect(page.locator('[data-research-quotes] .badge.green')).toHaveCount(1);
  const beforeExpiryReads = calls.length; await expect(page.locator('[data-research-quotes] .badge.green')).toHaveCount(0, { timeout: 2500 }); assert.equal(calls.length, beforeExpiryReads);
  console.log('PASS 14-day coverage uses continuous same-scope evidence rather than elapsed dates; stale policy/version/expiry removes green state without extra requests');

  await page.locator('[data-research-amount]').selectOption('50'); await page.locator('[data-research-buy]').selectOption('solana');
  await page.locator('[data-research-quote]').click(); await expect.poll(() => calls.filter(call => call.path.endsWith('/quote') && call.method === 'POST').length).toBe(1);
  const quoted = calls.find(call => call.path.endsWith('/quote') && call.method === 'POST'); assert.deepEqual(quoted.body, { assetId: asset.id, revision: 2, amountUsd: 50, buyChain: 'solana' });
  await page.locator('[data-research-matrix]').click(); await expect.poll(() => calls.filter(call => call.path.endsWith('/matrix')).length).toBe(1);
  await page.locator('[data-research-open]').click(); assert.deepEqual(await page.evaluate(() => window.opens), [asset.id]);
  await page.locator('[data-research-settings] [name=maxJobsPerDay]').fill('333');
  await page.evaluate(() => window.panel.refresh({ force: true })); await expect(page.locator('[data-research-settings] [name=maxJobsPerDay]')).toHaveValue('333');
  await page.locator('[data-research-settings] [name=enabled]').check(); await page.locator('[data-research-settings] [type=submit]').click(); await expect.poll(() => snapshot.settings.enabled).toBe(true);
  assert.equal(snapshot.settings.maxJobsPerDay, 333);
  await page.locator('[data-paper-start]').click(); await expect(page.locator('[data-paper-stat=netEquityUsd]')).toHaveText('$200.00'); await expect(page.locator('[data-paper-status]')).toContainText(asset.id);
  await page.locator('[data-paper-run]').click(); await expect.poll(() => calls.filter(call => call.path.endsWith('/paper/run')).length).toBe(1);
  await page.locator('[data-paper-pause]').click(); await expect.poll(() => snapshot.paper.running).toBe(false);
  await page.locator('[data-paper-resume]').click(); await expect.poll(() => snapshot.paper.running).toBe(true);
  await page.locator('[data-research-stop]').click(); await expect(page.locator('[data-research-clear-stop]')).toBeVisible();
  await expect(page.locator('[data-research-quotes] .badge.green')).toHaveCount(0); await expect(page.locator('[data-paper-run]')).toBeDisabled();
  await page.locator('[data-research-clear-stop]').click(); assert.equal(calls.some(call => call.path.endsWith('/clear-stop')), false);
  await page.locator('[data-research-clear-stop]').click(); await expect.poll(() => calls.filter(call => call.path.endsWith('/clear-stop')).length).toBe(1);
  assert.equal(snapshot.settings.enabled, false); assert.equal(snapshot.paper.running, false);
  await page.locator('[data-research-history] summary').click(); await expect.poll(() => calls.filter(call => call.path.endsWith('/history')).length).toBeGreaterThan(0);
  await page.locator('[data-history-next]').click(); await expect(page.locator('[data-history-page]')).toHaveText('第 2 / 2 页');
  assert(calls.some(call => call.query === '?kind=quote&page=2')); assert.equal(await page.locator('[data-history-content] script').count(), 0);
  assert.equal((await page.locator('#research-root').textContent()).includes('secret-canary-hidden'), false);
  console.log('PASS only explicit research/paper commands are issued with exact IDs and amounts; stop clear needs confirmation and does not resume; independent history paginates');

  readFails = true; await page.evaluate(() => window.panel.refresh({ force: true })); await expect(page.locator('[data-research-rank]')).toHaveCount(0);
  await expect(page.locator('[data-research-quote]')).toBeDisabled(); assert.equal((await page.locator('#research-root').textContent()).includes('secret-canary-hidden'), false);
  readFails = false; await page.evaluate(() => window.panel.refresh({ force: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  held = true; await page.evaluate(() => { window.heldRead = window.panel.refresh({ force: true }); }); await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(() => { window.panel.unmount(); document.querySelector('#research-root').innerHTML = '<p>unmounted fixture</p>'; });
  release(); await page.evaluate(() => window.heldRead); await expect(page.locator('#research-root')).toHaveText('unmounted fixture');
  const afterUnmount = calls.length; await new Promise(resolve => setTimeout(resolve, 1200)); assert.equal(calls.length, afterUnmount);
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS read failures remove old opportunities, 390px layout fits, and unmount aborts late reads and stops polling without live or signing calls');

  held = false; readFails = false; snapshot.recentQuotes = [quote()]; snapshot.paper = emptyPaper();
  const config = structuredClone(DEFAULT_CONFIG); let stateReads = 0;
  await page.route('**/api/state', route => {
    stateReads++;
    return route.fulfill({ json: { appVersion: '3.0.0', config, policyFingerprint: policy, market: {}, balances: {}, opportunity: { executable: false, reasons: ['Offline research fixture'] },
      engine: { configRevision: 0, running: false, busy: false, configuring: false, pausedReason: '' }, wallets: { bnb: { mode: 'none', canSign: false }, solana: { mode: 'none', canSign: false } }, stats: {},
      features: { onchainResearch: true, opportunities: false, quality: false, performance: false, liveReadiness: false, bnbApprovals: false } } });
  });
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.goto(url + '/');
  await expect(page.locator('[data-market-view]')).toHaveCount(4);
  await page.locator('[data-market-view=research]').click(); await expect(page.locator('h1')).toHaveText('链上机会研究');
  await page.evaluate(() => { window.fullResearchNode = document.querySelector('#onchain-research-view'); });
  const beforeGlobal = stateReads, beforeResearchReads = calls.filter(call => call.method === 'GET' && call.path === '/api/onchain-research').length;
  await expect.poll(() => stateReads, { timeout: 9000 }).toBeGreaterThan(beforeGlobal + 1);
  assert.equal(await page.evaluate(() => window.fullResearchNode === document.querySelector('#onchain-research-view')), true);
  assert(calls.filter(call => call.method === 'GET' && call.path === '/api/onchain-research').length - beforeResearchReads <= 1);
  const mutationsBeforeSwitch = calls.filter(call => call.method === 'POST').length;
  await page.locator('[data-tab=settings]').first().click(); await expect(page.locator('h1')).toHaveText('设置与钱包');
  const afterLeave = calls.filter(call => call.method === 'GET' && call.path === '/api/onchain-research').length;
  await new Promise(resolve => setTimeout(resolve, 8500));
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/api/onchain-research').length, afterLeave);
  await page.locator('[data-tab=market]').first().click(); await expect(page.locator('h1')).toHaveText('链上机会研究');
  await page.locator('[data-market-view=arbitrage]').click(); await expect(page.locator('h1')).toHaveText('双链行情工作台');
  await expect(page.locator('[data-market-view=research]')).toHaveCount(1);
  await page.locator('[data-market-view=research]').click(); await expect(page.locator('h1')).toHaveText('链上机会研究');
  assert.equal(calls.filter(call => call.method === 'POST').length, mutationsBeforeSwitch);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS full app preserves the research view through 2.5s state polls, stops research reads when leaving, retains all original tabs and never writes on navigation');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
