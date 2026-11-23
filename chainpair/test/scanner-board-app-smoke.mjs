// Offline full-app integration: public scanner board -> exact radar asset.
// No real provider requests, wallet access, signatures or mutations.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';

const now = Date.now(), errors = [], forbidden = [], requests = [];
const config = structuredClone(DEFAULT_CONFIG); config.executionMode = 'inventory';
const fingerprint = 'a'.repeat(64);
const chains = {
  bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' },
  solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', decimals: 9, poolAddress: '11111111111111111111111111111112' }
};
const asset = (suffix, confirmed) => ({ id: 'coingecko:' + suffix, name: suffix + ' fixture', symbol: suffix.toUpperCase(), source: 'coingecko', enabled: true, revision: 1, mapping: { confirmed, evidence: confirmed ? 'Offline fixture identity evidence' : '', warning: '' }, chains: structuredClone(chains) });
const market = {
  bnb: { chain: 'bnb', tokenAddress: chains.bnb.address, poolAddress: chains.bnb.poolAddress, priceUsd: .01, liquidityUsd: 100000, volume24hUsd: 100000, volume1hUsd: 2000, trades1h: 20, priceConfidence: 'pool-consensus', observedAt: now },
  solana: { chain: 'solana', tokenAddress: chains.solana.address, poolAddress: chains.solana.poolAddress, priceUsd: .0104, liquidityUsd: 110000, volume24hUsd: 100000, volume1hUsd: 2000, trades1h: 20, priceConfidence: 'single-pool', observedAt: now }
};
const row = (suffix, confirmed) => {
  const candidate = asset(suffix, confirmed);
  return { asset: candidate, universe: { category: 'altcoin', eligible: true, reasons: [], evidence: 'directory' }, marketQualified: true, opportunityQualified: true, anomalous: false, comparisonStatus: 'comparable', market: structuredClone(market), generation: 'fixture-round', observedAt: now, buyChain: 'bnb', sellChain: 'solana', spreadBps: 400, indicativeGrossUsd: .2, stage: confirmed ? 'candidate' : 'needs_mapping', reasons: confirmed ? [] : ['同币映射尚未核验'], feeStatus: confirmed ? 'quoted' : 'unknown', executable: confirmed, evaluation: confirmed ? { executable: true, assetRevision: 1, mode: 'demo', executionMode: 'inventory', parentPolicyFingerprint: fingerprint, amountUsd: config.risk.amountUsd, netProfitUsd: 1, gasUsd: .01, slippageUsd: .01, priceImpactBps: 10, quotedAt: new Date(now).toISOString(), expiresAt: new Date(now + 110000).toISOString(), buyChain: 'bnb', sellChain: 'solana', reasons: [] } : null };
};
const rows = [row('board-alpha', false), row('board-quoted', true)];
const fixture = {
  enabled: true, autoScanPreferred: true, busy: false, status: 'monitoring', reason: 'Offline app integration fixture', lastError: null, notice: '', usage: { day: 2, total: 2 }, updatedAt: now, directoryUpdatedAt: now, nextRequestAt: now,
  settings: { pollIntervalMs: 60000, minLiquidityUsd: 20000, minVolume24hUsd: 10000, minVolume1hUsd: 100, minTrades1h: 3, minSpreadBps: 50, maxSpreadBps: 3000, maxPoolDeviationBps: 1500, maxSideSkewMs: 30000, maxAssetsPerScan: 30, maxRequestsPerDay: 5000, includeStablecoins: false, includeMajors: false },
  assets: rows.map(item => item.asset), rows, counts: { total: 2, approved: 1, candidate: 2, eligible: 2, excluded: 0, dualActive: 2, opportunities: 2, executable: 1, quarantined: 0 },
  scope: { kind: 'altcoins', eligible: 2, excluded: 0, quarantined: 0, reasonCounts: [], identityNotice: 'Offline fixture, not live market evidence' },
  directory: { status: 'ready', source: 'coingecko', foundCount: 2, sourceAttempts: [] }, credentials: { configured: false, locked: false }, scanProgress: { totalAssets: 2, scannedAssets: 2, withBothMarkets: 2, withActiveMarkets: 2, opportunities: 2 },
  execution: { busy: false, running: false, mode: 'demo', executionMode: 'inventory', lastError: '' }
};
let stateReads = 0, opportunityReads = 0;
const unexpected = name => () => { forbidden.push(name); throw new Error('No mutation is expected in this browser fixture'); };
const engine = { config, snapshot: () => { stateReads++; return { config, policyFingerprint: fingerprint, market: {}, balances: {}, opportunity: { executable: false, reasons: ['No configured-pair action expected'] }, engine: { running: false, busy: false, configuring: false, pausedReason: '' }, wallets: { bnb: { mode: 'none', canSign: false }, solana: { mode: 'none', canSign: false } }, inventoryExecution: { busy: false }, stats: {} }; }, start: unexpected('engine.start'), execute: unexpected('engine.execute'), pause: unexpected('engine.pause'), saveConfig: unexpected('engine.saveConfig') };
const emptyPage = () => ({ items: [], total: 0, page: 1, pageSize: 10, pages: 1 });
const store = { listNotes: emptyPage, listTrades: emptyPage };
const opportunityService = { snapshot: () => { opportunityReads++; return structuredClone(fixture); } };
const { server, url } = await startLocalServer({ engine, store, vault: { publicStatus: () => ({}) }, opportunityService, inventoryCoordinator: { snapshot: () => fixture.execution } });
let browser, releaseHeld;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { const pathname = new URL(request.url()).pathname; requests.push({ pathname, method: request.method() }); if (pathname.startsWith('/api/') && request.method() !== 'GET') forbidden.push(request.method() + ' ' + pathname); });
  await page.route('**/api/review**', route => route.fulfill({ json: { day: '2026-11-23', mode: 'demo', timeZone: 'Asia/Shanghai', counts: {}, pnl: {}, inventory: {}, byType: [], observations: [], policyVersions: 0, coverage: {} } }));
  await page.goto(url);
  await expect(page.locator('h1')).toHaveText('双链行情工作台');
  await expect(page.locator('#scanner-board-root')).toContainText('扫描套利机会');
  await expect(page.locator('[data-scanner-board-reference-count]')).toHaveText('2');
  await expect(page.locator('[data-scanner-board-quote-count]')).toHaveText('1');
  await expect(page.locator('.scanner-board-row')).toHaveCount(2);
  await expect(page.locator('h2').filter({ hasText: '配置币对执行预览' })).toBeVisible();
  await page.locator('[data-scanner-board-filter=executable]').click();
  await expect(page.locator('.scanner-board-row')).toHaveCount(1);
  await page.locator('#scanner-board-root').evaluate(node => { node.dataset.integrationMarker = 'retained-root'; });
  const beforeState = stateReads, beforeOpportunities = opportunityReads;
  await expect.poll(() => stateReads, { timeout: 8000 }).toBeGreaterThanOrEqual(beforeState + 2);
  await expect(page.locator('#scanner-board-root')).toHaveAttribute('data-integration-marker', 'retained-root');
  await expect(page.locator('[data-scanner-board-filter=executable]')).toHaveAttribute('aria-pressed', 'true');
  assert(opportunityReads - beforeOpportunities <= 1, '2.5s global refresh must not cause repeated scanner GETs');
  console.log('PASS full app defaults to scanner opportunities on arbitrage dashboard; global state refresh preserves board node/filter and polling budget');

  await page.locator('[data-scanner-board-filter=reference]').click();
  const target = page.locator('[data-scanner-board-asset="coingecko:board-alpha"]');
  await target.locator('[data-scanner-board-open]').click();
  await expect(page.locator('h1')).toHaveText('同币机会扫描');
  await expect(page.locator('#opp-filter')).toHaveValue('all');
  const selected = page.locator('[data-asset-id="coingecko:board-alpha"]');
  await expect(selected).toBeVisible();
  await expect(selected.locator('.opp-asset-details')).toHaveAttribute('open', '');
  await expect(selected.locator('[data-opp-quote]')).toBeDisabled();
  await expect(selected.locator('[data-opp-execute]')).toBeDisabled();
  assert.equal(await page.locator('#scanner-board-root').count(), 0);
  console.log('PASS dashboard action opens the exact scanner asset and expands its evidence without changing configuration or authorizing execution');

  await page.locator('[data-market-view=arbitrage]').click();
  await expect(page.locator('.scanner-board-row')).toHaveCount(2);
  let held = false;
  await page.route('**/api/opportunities', async route => {
    held = true; await new Promise(resolve => { releaseHeld = resolve; });
    await route.fulfill({ json: fixture }).catch(() => {});
  });
  await page.locator('[data-scanner-board-refresh]').click();
  await expect.poll(() => held).toBe(true);
  await page.locator('.nav-item[data-tab=notes]').click();
  await expect(page.locator('h1')).toHaveText('备忘录');
  releaseHeld(); releaseHeld = null;
  const readsAfterUnmount = requests.filter(item => item.pathname === '/api/opportunities').length;
  const stateAfterUnmount = stateReads;
  await expect.poll(() => stateReads, { timeout: 5000 }).toBeGreaterThan(stateAfterUnmount);
  await expect(page.locator('h1')).toHaveText('备忘录');
  assert.equal(requests.filter(item => item.pathname === '/api/opportunities').length, readsAfterUnmount);
  await page.unroute('**/api/opportunities');
  console.log('PASS leaving the dashboard aborts an in-flight scanner read; delayed responses and global polling cannot pull the user back');

  for (const tab of ['settings', 'bridge', 'trades', 'notes', 'market']) {
    await page.locator(`.nav-item[data-tab=${tab}]`).click();
    await expect(page.locator('h1')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), tab + ' mobile overflow');
    await page.setViewportSize({ width: 1440, height: 1040 });
  }
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS all five tabs at 390px, no page/console errors and no POST, wallet, configuration, approval or execution actions');
} finally {
  releaseHeld?.(); await browser?.close(); await new Promise(resolve => server.close(resolve));
}
