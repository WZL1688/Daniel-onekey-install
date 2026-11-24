// Offline full-app integration with real persistence, vault and demo engine.
// Quality and scanner services are fixtures: no RPC, real quote or signing.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { Store } from '../src/store.mjs';
import { Vault } from '../src/vault.mjs';
import { Engine } from '../src/engine.mjs';
import { ReviewService } from '../src/review.mjs';
import { startLocalServer } from '../src/server.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'chainpair-quality-app-'));
const store = new Store(dir), vault = new Vault(dir), config = store.config;
config.executionMode = 'inventory'; store.setConfig(config);
const engine = new Engine({ store, vault }); await engine.init();
const reviewService = new ReviewService({ store });
const errors = [], calls = [], forbidden = [], verifies = [], toggles = [];
let stateReads = 0, qualityReads = 0;
const originalSnapshot = engine.snapshot.bind(engine);
engine.snapshot = () => { stateReads++; return originalSnapshot(); };
const now = Date.now();
const asset = { id: 'manual:quality-app', symbol: 'QUALITY', name: 'Offline quality integration asset', source: 'manual', enabled: true, revision: 3, mapping: { confirmed: true, evidence: 'Offline test mapping only', warning: '' }, chains: {
  bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' },
  solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', decimals: 9, poolAddress: '11111111111111111111111111111112' }
} };
const execution = { busy: false, running: false, mode: 'demo', executionMode: 'inventory', lastError: '' };
const row = { asset, universe: { category: 'altcoin', eligible: true, reasons: [] }, marketQualified: true, opportunityQualified: true, anomalous: false, comparisonStatus: 'comparable', generation: 'quality-app-fixture', observedAt: now, buyChain: 'bnb', sellChain: 'solana', spreadBps: 400, indicativeGrossUsd: .2, stage: 'candidate', reasons: [], executable: false, evaluation: null, market: Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { chain, tokenAddress: asset.chains[chain].address, poolAddress: asset.chains[chain].poolAddress, priceUsd: chain === 'bnb' ? .01 : .0104, liquidityUsd: 100000, volume24hUsd: 100000, volume1hUsd: 2000, trades1h: 20, priceConfidence: 'pool-consensus', priceMethod: 'provider-base-usd', observedAt: now }])) };
const scannerSnapshot = {
  enabled: true, busy: false, status: 'monitoring', reason: 'Offline integration fixture', lastError: '', notice: '', updatedAt: now, directoryUpdatedAt: now, nextRequestAt: now,
  settings: { pollIntervalMs: 60000, minLiquidityUsd: 20000, minVolume24hUsd: 10000, minVolume1hUsd: 100, minTrades1h: 3, minSpreadBps: 50, maxSpreadBps: 3000, maxPoolDeviationBps: 1500, maxSideSkewMs: 30000, maxAssetsPerScan: 30, maxRequestsPerDay: 5000, includeStablecoins: false, includeMajors: false },
  assets: [asset], rows: [row], counts: { total: 1, approved: 1, candidate: 1, eligible: 1, excluded: 0, dualActive: 1, opportunities: 1, executable: 0, quarantined: 0 }, usage: { day: 0, total: 0 },
  directory: { status: 'ready', source: 'manual', foundCount: 1, sourceAttempts: [] }, credentials: { configured: false, locked: false }, scanProgress: { totalAssets: 1, scannedAssets: 1, withBothMarkets: 1, withActiveMarkets: 1, opportunities: 1 }
};
const opportunityService = {
  snapshot: () => structuredClone(scannerSnapshot),
  getApprovedAsset: id => { assert.equal(id, asset.id); return structuredClone(asset); }
};
const fail = name => () => { forbidden.push(name); throw new Error('No trading operation is permitted by this fixture'); };
const inventoryCoordinator = { snapshot: () => structuredClone(execution), quote: fail('quote'), execute: fail('execute') };
let qualityState = { enabled: false, busy: false, lastError: '', lastAttemptAt: null, reports: [] };
const qualityService = {
  snapshot: () => { qualityReads++; return structuredClone(qualityState); },
  setEnabled: enabled => { assert.equal(typeof enabled, 'boolean'); toggles.push(enabled); qualityState.enabled = enabled; return structuredClone(qualityState); },
  verify: id => {
    verifies.push(id); assert.equal(id, asset.id);
    const report = { assetId: id, assetRevision: asset.revision, parentRevision: engine.configRevision, parentPolicyFingerprint: originalSnapshot().policyFingerprint, mode: 'live', readOnly: true, executable: false, simulationVerified: false, qualityPassed: true, amountUsd: engine.config.risk.amountUsd, netProfitUsd: .2, stressNetProfitUsd: .16, gasUsd: .01, slippageUsd: .03, priceImpactBps: 100, expiresAt: new Date(Date.now() + 60000).toISOString(), reasons: [] };
    qualityState = { ...qualityState, lastAttemptAt: Date.now(), reports: [report] }; return structuredClone(report);
  }
};
const { server, url } = await startLocalServer({ engine, store, vault, reviewService, opportunityService, inventoryCoordinator, qualityService });
const initialConfig = JSON.stringify(engine.config), initialArchive = store.allTrades();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const requestUrl = new URL(request.url()), pathname = requestUrl.pathname;
    calls.push({ pathname, method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
    if (requestUrl.origin !== url || pathname.startsWith('/api/') && request.method() !== 'GET' && !['/api/opportunities/quality/enabled', '/api/opportunities/quality/verify'].includes(pathname)) forbidden.push(request.method() + ' ' + request.url());
  });
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) errors.push(response.status() + ' ' + new URL(response.url()).pathname); });
  await page.goto(url);
  await expect(page.locator('h1')).toHaveText('双链行情工作台');
  await expect(page.locator('#mode-badge')).toHaveText('模拟模式');
  await expect(page.locator('#quality-panel-root')).toContainText('真实只读报价复核');
  await expect(page.locator('[data-performance-count=attempts]')).toHaveText('0');
  await expect(page.locator('[data-performance-rate]')).toContainText('尚无真实样本');
  await expect(page.locator('[data-quality-empty]')).toContainText('当前没有已验证机会');
  const state = await (await page.request.get(url + '/api/state')).json();
  assert.equal(state.features.quality, true); assert.equal(state.features.performance, true);
  await page.locator('#quality-panel-root').evaluate(node => { node.dataset.qualityMarker = 'preserved-on-state-refresh'; });
  const beforeState = stateReads, beforeQuality = qualityReads;
  await expect.poll(() => stateReads, { timeout: 8000 }).toBeGreaterThanOrEqual(beforeState + 2);
  await expect(page.locator('#quality-panel-root')).toHaveAttribute('data-quality-marker', 'preserved-on-state-refresh');
  assert(qualityReads - beforeQuality <= 1, '2.5s global polling must not multiply quality reads or timers');
  console.log('PASS full app exposes real quality/performance services, excludes demo from real evidence and preserves the quality node across global state refreshes');

  const toggle = page.locator('[data-quality-toggle]');
  await toggle.click(); await expect(toggle).toHaveText('停止自动只读复核');
  assert.deepEqual(toggles, [true]);
  assert.equal(JSON.stringify(engine.config), initialConfig); assert.equal(engine.config.mode, 'demo'); assert.equal(engine.running, false); assert.deepEqual(store.allTrades(), initialArchive);
  const beforeSecondRefresh = stateReads;
  await expect.poll(() => stateReads, { timeout: 5000 }).toBeGreaterThan(beforeSecondRefresh);
  await expect(page.locator('#quality-panel-root')).toHaveAttribute('data-quality-marker', 'preserved-on-state-refresh');
  assert.deepEqual(toggles, [true], 'state refresh cannot replay the read-only toggle');
  console.log('PASS automatic read-only enablement makes one POST and leaves mode, risk settings, execution state and transaction archive unchanged');

  await page.locator('[data-market-view=opportunities]').click();
  await expect(page.locator('h1')).toHaveText('同币机会扫描');
  await expect(page.locator('#quality-panel-root')).toHaveCount(0);
  const selected = page.locator('[data-asset-id="manual:quality-app"]');
  await selected.locator('.opp-asset-details').evaluate(node => { node.open = true; });
  await expect(selected.locator('[data-opp-quality]')).toBeEnabled();
  await selected.locator('[data-opp-quality]').click();
  await expect.poll(() => verifies.length).toBe(1);
  const verifyPosts = calls.filter(call => call.method === 'POST' && call.pathname === '/api/opportunities/quality/verify');
  assert.equal(verifyPosts.length, 1); assert.deepEqual(verifyPosts[0].body, { id: asset.id, revision: asset.revision, expectedMode: 'demo' });
  await expect(page.locator('.toast').last()).toContainText('未签名或下单');
  const afterRadarRead = qualityReads, afterRadarState = stateReads;
  // More than a full 8s quality polling period elapses while the radar is open.
  await expect.poll(() => stateReads, { timeout: 12000 }).toBeGreaterThanOrEqual(afterRadarState + 4);
  assert.equal(qualityReads, afterRadarRead, 'leaving the dashboard stops quality polling even while global state refresh continues');
  console.log('PASS radar real-read-only button sends exact asset/revision/parent-mode fields; dashboard polling stops without invoking quote or execution');

  for (const [tab, heading] of [['trades', '交易档案'], ['settings', '设置与钱包']]) {
    await page.locator(`.nav-item[data-tab=${tab}]`).click(); await expect(page.locator('h1')).toHaveText(heading);
    const priorReads = qualityReads, priorStateReads = stateReads;
    await expect.poll(() => stateReads, { timeout: 5000 }).toBeGreaterThan(priorStateReads);
    assert.equal(qualityReads, priorReads, tab + ' does not restart quality polling');
  }
  await page.locator('.nav-item[data-tab=market]').click();
  await expect(page.locator('h1')).toHaveText('同币机会扫描');
  const beforeRemount = qualityReads;
  await page.locator('[data-market-view=arbitrage]').click();
  await expect(page.locator('.quality-report')).toHaveCount(1);
  await expect(page.locator('.quality-report')).toContainText('$0.16');
  await expect(page.locator('[data-performance-count=attempts]')).toHaveText('0');
  assert.equal(qualityReads - beforeRemount, 1, 'returning mounts once and reads once');
  await page.locator('[data-quality-toggle]').click(); await expect(page.locator('[data-quality-toggle]')).toHaveText('开启自动只读复核');
  assert.deepEqual(toggles, [true, false]);
  assert.equal(JSON.stringify(engine.config), initialConfig); assert.equal(engine.running, false); assert.deepEqual(store.allTrades(), initialArchive);
  assert(calls.filter(call => call.method === 'POST').every(call => call.pathname.startsWith('/api/opportunities/quality/')));
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS trade/settings views keep quality polling stopped; returning mounts once and shows the real read-only report independently of the unchanged demo mode and archive');
} finally {
  await browser?.close(); engine.stop(); reviewService.stop();
  await new Promise(resolve => server.close(resolve)); vault.lock(); store.close(); rmSync(dir, { recursive: true, force: true });
}
