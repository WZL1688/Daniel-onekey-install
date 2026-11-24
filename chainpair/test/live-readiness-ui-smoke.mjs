// All service replies are local fixtures. No RPC, wallet signature or broadcast.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { startLocalServer } from '../src/server.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const { server, url } = await startLocalServer({ engine: { config: { mode: 'demo' }, snapshot: () => ({ engine: {} }) }, store: {}, vault: {} });
const policy = 'a'.repeat(64), owner = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222', spender = '0x3333333333333333333333333333333333333333';
const calls = [], forbidden = [], errors = [];
let now = Date.now(), failRead = false, holdRead = false, releaseRead;
const need = () => ({ chain: 'bnb', tokenAddress: token, spender, owner, side: 'BUY', requiredRaw: '5000000000000000000', currentRaw: '0' });
const report = (patch = {}) => ({ id: 'readiness-fixture', readOnly: true, executable: false, mode: 'live', parentMode: 'demo', parentRevision: 1, parentPolicyFingerprint: policy, checkedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'blocked', readyForLive: false, simulationVerified: false, executionMode: 'inventory', checks: [{ id: 'approval-BUY', label: 'BNB授权额度', status: 'blocked', message: '额度不足 <img src=x onerror="window.injection=true">' }, { id: 'sol-minimum', label: 'Solana最低到账', status: 'warning', message: '当前状态模拟不证明已解析路由指令的最低到账语义' }], approvals: [need()], opportunity: { amountUsd: 5, netProfitUsd: .2, stressNetProfitUsd: .15, gasUsd: .01 }, ...patch });
let snap = { busy: false, report: report(), lastAttemptAt: now, nextAttemptAt: now + 30000 };
let approvalState = { busy: false, job: null };
let intentPatch = {}, intentAction = 'approve';
const intentFixture = () => ({ id: 'approval-intent-fixture', chain: 'bnb', readOnly: true, realTransaction: true, tokenAddress: token, spender, owner, requiredRaw: need().requiredRaw, currentRaw: intentAction === 'reset' ? '10' : '0', amountRaw: intentAction === 'reset' ? '0' : need().requiredRaw, action: intentAction, feeNative: .00002, feeUsd: .012, expiresAt: new Date(Date.now() + 60000).toISOString(), ...intentPatch });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/readiness-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="fixture-main"><div id="live-root"></div></main><script type="module">import {createLiveReadinessPanel} from '/live-readiness.js';window.state={config:{mode:'demo',executionMode:'inventory',risk:{amountUsd:5,minProfitUsd:.03}},engine:{configRevision:1,busy:false,configuring:false,pausedReason:''},policyFingerprint:'${policy}',features:{},wallets:{bnb:{address:'${owner}',canSign:false},solana:{canSign:false}}};window.notices=[];window.settings=0;window.panel=createLiveReadinessPanel({getState:()=>window.state,onOpenSettings:()=>window.settings++,toast:(...args)=>window.notices.push(args),api:(path,options={})=>fetch(path,{method:options.method||'GET',signal:options.signal,headers:{'Content-Type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})}).then(async response=>{if(!response.ok)throw new Error('secret-canary-private-rpc');return response.json();})});window.panel.mount(document.querySelector('#live-root'));</script></body></html>` }));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = method === 'POST' ? request.postDataJSON() : null; calls.push({ path, method, body });
    if (!['/api/live-readiness', '/api/live-readiness/check', '/api/bnb-approvals', '/api/bnb-approvals/prepare', '/api/bnb-approvals/execute'].includes(path)) { forbidden.push(method + ' ' + path); return route.fulfill({ status: 400, json: {} }); }
    if (method === 'GET') {
      if (path === '/api/live-readiness' && holdRead) await new Promise(resolve => { releaseRead = resolve; });
      if (failRead) return route.fulfill({ status: 500, json: { error: 'secret-canary-private-rpc' } }).catch(() => {});
      return route.fulfill({ json: path === '/api/live-readiness' ? snap : approvalState }).catch(() => {});
    }
    if (path === '/api/live-readiness/check') return route.fulfill({ json: snap.report });
    if (path === '/api/bnb-approvals/prepare') return route.fulfill({ json: intentFixture() });
    if (path === '/api/bnb-approvals/execute') { approvalState.job = { status: 'completed', hash: '0x' + 'f'.repeat(64) }; return route.fulfill({ status: 202, json: { accepted: true, jobId: 'job-fixture' } }); }
    forbidden.push(method + ' ' + path); return route.fulfill({ status: 400, json: {} });
  });
  await page.goto(url + '/readiness-fixture');
  await expect(page.locator('[data-live-status]')).toContainText('尚未启用'); assert.equal(calls.length, 0, 'missing feature flags must not call new APIs');
  await page.evaluate(async () => { window.state.features = { liveReadiness: true, bnbApprovals: true }; await window.panel.refresh({ force: true }); });
  await expect(page.locator('[data-live-prepare]')).toHaveCount(1);
  await expect(page.locator('[data-live-checks]')).toContainText('<img src=x'); assert.equal(await page.evaluate(() => Boolean(window.injection)), false);
  await page.locator('[data-live-check]').click(); await expect(page.locator('[data-live-action]')).toContainText('没有签名或下单');
  assert.deepEqual(calls.find(c => c.path === '/api/live-readiness/check').body, { expectedMode: 'demo' });
  await page.locator('[data-live-prepare]').click(); await expect(page.locator('[data-live-intent]')).toContainText('真实 BNB 授权交易');
  await expect(page.locator('[data-live-intent-raw]')).toHaveText(need().requiredRaw);
  await expect(page.locator('[data-live-approval-send]')).toBeDisabled();
  assert.equal(calls.filter(c => c.path === '/api/bnb-approvals/execute').length, 0);
  console.log('PASS missing features avoid requests; parent demo performs real read-only preflight and finite review without enabling approval sends; strings are escaped');

  await page.evaluate(() => { window.state.config.mode = 'live'; window.state.wallets.bnb.canSign = true; window.state.wallets.solana.canSign = true; });
  await expect(page.locator('[data-live-approval-send]')).toBeDisabled();
  await page.locator('[data-live-approval-cancel]').click();
  snap.report = report({ parentMode: 'live', status: 'ready', readyForLive: true, simulationVerified: true, checks: [{ id: 'simulation', label: '双边模拟', status: 'passed', message: '仅本地固定响应' }], approvals: [] });
  await page.evaluate(() => window.panel.refresh({ force: true }));
  await expect(page.locator('[data-live-status]')).toContainText('预检通过');
  snap.report.opportunity.stressNetProfitUsd = -.1;
  await page.evaluate(() => window.panel.refresh({ force: true }));
  await expect(page.locator('[data-live-status]')).toContainText('未满足');
  snap.report = report({ parentMode: 'live' });
  await page.evaluate(() => window.panel.refresh({ force: true }));
  await page.locator('[data-live-prepare]').click(); await expect(page.locator('[data-live-approval-send]')).toBeEnabled();
  await page.evaluate(() => { window.state.engine.busy = true; });
  await expect(page.locator('[data-live-approval-send]')).toBeDisabled();
  await page.evaluate(() => { window.state.engine.busy = false; });
  await expect(page.locator('[data-live-approval-send]')).toBeEnabled();
  assert.equal(calls.filter(c => c.path === '/api/bnb-approvals/execute').length, 0, 'preparing or polling cannot execute');
  await page.locator('[data-live-approval-send]').click();
  await expect(page.locator('[data-live-action]')).toContainText('不会自动套利');
  assert.deepEqual(calls.filter(c => c.path === '/api/bnb-approvals/execute').map(c => c.body), [{ intentId: 'approval-intent-fixture', expectedMode: 'live', confirmed: true }]);
  await expect(page.locator('[data-live-approval-job]')).toContainText('授权已确认');
  console.log('PASS actual send requires a second explicit live-mode click; nominal ready flags cannot override negative pressure headroom; no automatic trading or consecutive approvals');

  intentAction = 'reset'; approvalState.job = null;
  await page.evaluate(() => window.panel.refresh({ force: true }));
  await page.locator('[data-live-prepare]').click(); await expect(page.locator('[data-live-intent-raw]')).toHaveText('0');
  await expect(page.locator('[data-live-approval-send]')).toHaveText('确认清零旧额度');
  await expect(page.locator('[data-live-intent]')).toContainText('不会自动发送第二笔');
  await page.evaluate(() => { window.state.engine.configRevision++; });
  await expect(page.locator('[data-live-approval-send]')).toBeDisabled();
  await page.locator('[data-live-approval-cancel]').click();
  snap.report = report({ parentMode: 'live', parentRevision: 2 });
  await page.evaluate(() => window.panel.refresh({ force: true }));
  intentAction = 'approve'; intentPatch = { owner: '0x4444444444444444444444444444444444444444' };
  await page.locator('[data-live-prepare]').click(); await expect(page.locator('[data-live-approval-send]')).toBeDisabled();
  await page.locator('[data-live-approval-cancel]').click();
  intentPatch = { amountRaw: ((1n << 256n) - 1n).toString(), requiredRaw: ((1n << 256n) - 1n).toString() };
  await page.locator('[data-live-prepare]').click(); await expect(page.locator('[data-live-approval-send]')).toBeDisabled();
  await page.locator('[data-live-approval-cancel]').click();
  intentPatch = { expiresAt: new Date(Date.now() - 1).toISOString() };
  await page.locator('[data-live-prepare]').click(); await expect(page.locator('[data-live-approval-send]')).toBeDisabled();
  assert.equal(calls.filter(c => c.path === '/api/bnb-approvals/execute').length, 1);
  console.log('PASS reset is explicitly separate; configuration, wallet owner, unbounded amounts and expiry prevent sends');

  failRead = true; await page.evaluate(() => window.panel.refresh({ force: true }));
  await expect(page.locator('[data-live-status]')).toContainText('读取失败');
  assert.equal((await page.locator('#live-root').textContent()).includes('secret-canary'), false);
  failRead = false; intentPatch = {}; await page.evaluate(() => window.panel.refresh({ force: true }));
  const beforeRemount = calls.length;
  await page.evaluate(() => { window.panel.mount(document.querySelector('#live-root')); window.panel.mount(document.querySelector('#live-root')); });
  await page.waitForTimeout(1100); assert.equal(calls.length, beforeRemount, 'same-node mounting must not multiply reads');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  holdRead = true;
  const beforeHeld = calls.length;
  const refreshPending = page.evaluate(() => { void window.panel.refresh({ force: true }); }); await refreshPending;
  await expect.poll(() => calls.length).toBeGreaterThan(beforeHeld);
  await page.evaluate(() => { window.panel.unmount(); document.querySelector('#live-root').innerHTML = '<p id="left-panel">已离开</p>'; });
  releaseRead?.(); holdRead = false;
  await page.waitForTimeout(1100); await expect(page.locator('#left-panel')).toHaveText('已离开');
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS read failures hide old readiness, raw errors stay hidden, mounting is idempotent, 390px layout and unmounted late responses remain safe');

  // Full application mount, route setting and explicit-save integration.
  const appPage = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  appPage.on('pageerror', error => errors.push(error.message));
  const appConfig = structuredClone(DEFAULT_CONFIG); appConfig.executionMode = 'inventory';
  let appRevision = 1, appReads = 0, readinessReads = 0;
  const appWrites = [];
  const state = () => ({ config: structuredClone(appConfig), appVersion: '1.9.0', policyFingerprint: policy, market: {}, balances: {}, opportunity: { executable: false, reasons: ['离线测试，不执行'] }, engine: { running: false, busy: false, configuring: false, configRevision: appRevision, pausedReason: '' }, wallets: { bnb: { address: owner, mode: 'readonly', canSign: false }, solana: { mode: 'none', canSign: false } }, stats: { executions: 0, cumulativeUsd: 0, completed: 0, profitUsd: 0 }, features: { opportunities: false, quality: false, performance: false, liveReadiness: true, bnbApprovals: true } });
  await appPage.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (method !== 'GET') {
      appWrites.push({ path, body: request.postDataJSON() });
      if (path === '/api/config') { Object.assign(appConfig, request.postDataJSON().config); appRevision++; return route.fulfill({ json: state() }); }
      forbidden.push(method + ' ' + path); return route.fulfill({ status: 400, json: {} });
    }
    if (path === '/api/session') return route.fulfill({ json: { csrfToken: 'local-fixture-only' } });
    if (path === '/api/state') { appReads++; return route.fulfill({ json: state() }); }
    if (path === '/api/live-readiness') { readinessReads++; return route.fulfill({ json: { busy: false, report: null } }); }
    if (path === '/api/bnb-approvals') return route.fulfill({ json: { busy: false, job: null } });
    forbidden.push(method + ' ' + path); return route.fulfill({ status: 400, json: {} });
  });
  await appPage.goto(url);
  await expect(appPage.locator('#live-readiness-root .live-readiness-panel')).toBeVisible();
  await appPage.locator('#live-readiness-root').evaluate(node => { node.dataset.marker = 'preserved'; });
  const beforeAppReads = appReads, beforeReadinessReads = readinessReads;
  await expect.poll(() => appReads, { timeout: 9000 }).toBeGreaterThanOrEqual(beforeAppReads + 2);
  await expect(appPage.locator('#live-readiness-root')).toHaveAttribute('data-marker', 'preserved');
  assert(readinessReads - beforeReadinessReads <= 1);
  await appPage.locator('[data-tab=settings]').first().click();
  await expect(appPage.locator('#live-readiness-root .live-readiness-panel')).toBeVisible();
  await expect(appPage.locator('#route-mode-bnb')).toHaveValue('pinned');
  await appPage.locator('[data-route-template=bnb]').click();
  await expect(appPage.locator('[name="chains.bnb.routerAllowlist"]')).toHaveValue(/0x5994814f2c4040b863a0125a45de152a8c2a4dec/);
  assert.equal(appWrites.length, 0, 'official template only fills the unsaved form');
  await appPage.locator('#route-mode-bnb').selectOption('aggregator');
  await appPage.locator('#route-mode-solana').selectOption('aggregator');
  await appPage.locator('[data-route-template=solana]').click();
  await appPage.locator('#config-form button[type=submit]').click();
  await expect.poll(() => appWrites.length).toBe(1);
  assert.equal(appWrites[0].path, '/api/config');
  assert.equal(appWrites[0].body.config.chains.bnb.routingMode, 'aggregator');
  assert.equal(appWrites[0].body.config.chains.solana.routingMode, 'aggregator');
  assert.equal(appWrites[0].body.config.mode, 'demo');
  assert.equal(appWrites[0].body.config.chains.solana.programAllowlist.includes('proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u'), true);
  await appPage.locator('[data-tab=bridge]').first().click();
  const leftReads = readinessReads; await appPage.waitForTimeout(8500); assert.equal(readinessReads, leftReads, 'leaving market/settings stops live-readiness polling');
  await appPage.locator('[data-tab=market]').first().click();
  await expect(appPage.locator('#live-readiness-root .live-readiness-panel')).toHaveCount(1);
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS full app preserves one readiness panel across 2.5s state refresh, mounts settings, saves explicit route choices/templates only on demand and stops polling when leaving');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
