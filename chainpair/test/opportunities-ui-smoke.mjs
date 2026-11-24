// Browser fixtures only: no external quote, wallet, signing, or chain transaction.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';

const now = Date.now();
const config = structuredClone(DEFAULT_CONFIG);
config.inventory ??= { assetId: '', mappingConfirmed: false, mappingEvidence: '', scanApprovedAssets: false };
const asset = index => ({ id: `manual:fixture-${index}`, symbol: `FIX${index}`, name: index === 1 ? '<img src=x onerror="window.opportunityInjected=true">' : `Fixture ${index}`, source: 'manual', confirmed: index > 1, revision: 1, enabled: true, mappingEvidence: index > 1 ? 'Fixture official mapping evidence' : '', chains: { bnb: { address: `0x${String(index).padStart(40, '0')}`, decimals: index === 1 ? null : 18, poolAddress: `0x${String(index + 50).padStart(40, '0')}` }, solana: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: index === 1 ? null : 6, poolAddress: 'So11111111111111111111111111111111111111112' } } });
const fixture = { enabled: false, settings: { pollIntervalMs: 60000, minLiquidityUsd: 20000, minSpreadBps: 50, maxAssetsPerScan: 30, maxRequestsPerDay: 5000 }, assets: Array.from({ length: 12 }, (_, i) => asset(i + 1)), rows: [], status: 'stopped', reason: '默认关闭。发现和扫描不会自动交易。', usage: { day: 2, total: 5 }, directoryUpdatedAt: now, updatedAt: now, nextRequestAt: null, execution: { busy: false, running: false, mode: 'demo', executionMode: 'bridge', scanApprovedAssets: false, lastError: '' } };
fixture.rows = fixture.assets.map(item => ({ asset: item, market: { bnb: { priceUsd: .01, liquidityUsd: 100000, observedAt: now }, solana: { priceUsd: .011, liquidityUsd: 120000, observedAt: now } }, buyChain: 'bnb', sellChain: 'solana', spreadBps: 1000, indicativeGrossUsd: .5, stage: item.confirmed ? 'candidate' : 'needs_mapping', reasons: item.confirmed ? [] : ['请核验同币映射'], evaluation: null, observedAt: now }));
const calls = [], errors = [], forbidden = [], archiveStats = {};
const fail = name => () => { forbidden.push(name); throw new Error('Unexpected real trading call'); };
const engine = {
  config, busy: false,
  snapshot: () => ({ config, market: {}, balances: { bnb: { tokenRaw: '100000000000000000000', tokenBalance: 100 }, solana: { tokenRaw: '200000000', tokenBalance: 200 } }, opportunity: { executable: false, reasons: ['fixture'] }, engine: { running: false, busy: false }, wallets: { bnb: { mode: 'none' }, solana: { mode: 'none' } }, stats: archiveStats }),
  saveConfig: async next => { Object.assign(config, next); return engine.snapshot(); }, start: fail('start'), execute: fail('execute'), pause: fail('pause'), quoteBridge: fail('quoteBridge'), executeBridge: fail('executeBridge')
};
const { server, url } = await startLocalServer({ engine, store: {}, vault: { publicStatus: () => ({}) } });
let browser, releaseSlow;
let slowGet = false;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/opportunities**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const method = request.method(), body = method === 'GET' || method === 'DELETE' ? null : request.postDataJSON();
    calls.push({ method, pathname, body });
    if (method === 'GET') {
      if (slowGet) { slowGet = false; await new Promise(resolve => { releaseSlow = resolve; }); }
      return route.fulfill({ json: fixture });
    }
    if (pathname.endsWith('/approve')) {
      const item = fixture.assets.find(a => a.id === body.id); assert(item);
      if (body.confirmed) { assert(body.evidence); assert.equal(body.revision, item.revision); item.confirmed = true; item.mappingEvidence = body.evidence; item.chains = body.chains; item.revision++; fixture.rows.find(row => row.asset.id === item.id).stage = 'candidate'; }
      else { item.confirmed = false; item.revision++; }
    } else if (pathname.endsWith('/quote')) {
      assert.equal(body.expectedMode, 'demo');
      const row = fixture.rows.find(row => row.asset.id === body.id);
      row.evaluation = { mode: 'demo', assetRevision: row.asset.revision, executable: true, reasons: [], netProfitUsd: .25, gasUsd: .02, slippageUsd: .01, amountUsd: 5, expiresAt: new Date(Date.now() + 60000).toISOString() };
    } else if (pathname.endsWith('/execute')) {
      assert.equal(body.expectedMode, 'demo'); fixture.execution.busy = true; fixture.execution.activeAssetId = body.id;
    } else if (pathname.endsWith('/automation')) {
      assert.equal(body.expectedMode, fixture.execution.mode); fixture.execution.running = body.enabled; fixture.execution.executionMode = 'inventory'; fixture.execution.scanApprovedAssets = true;
    } else if (pathname.endsWith('/enabled')) fixture.enabled = body.enabled;
    else if (pathname.endsWith('/settings')) Object.assign(fixture.settings, body.settings);
    else if (pathname.endsWith('/assets') && method === 'POST') { const item = { ...body.asset, id: 'manual:added', confirmed: false, revision: 1 }; fixture.assets.push(item); }
    else if (method === 'DELETE') fixture.assets = fixture.assets.filter(a => a.id !== decodeURIComponent(pathname.split('/').at(-1)));
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/radar', route => route.fulfill({ json: { settings: {}, enabled: false, configured: false, locked: false, tokens: [], counts: {}, usage: {}, reason: 'fixture' } }));
  await page.goto(url);
  await expect(page.locator('h1')).toHaveText('双链行情工作台');
  await expect(page.locator('.nav-item')).toHaveCount(5);
  await page.locator('[data-market-view=opportunities]').click();
  await expect(page.locator('h1')).toHaveText('同币机会扫描');
  await expect(page.locator('.market-subnav button')).toHaveCount(3);
  await expect(page.locator('#opp-assets article')).toHaveCount(10);
  assert.equal(await page.locator('#opp-assets img').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.opportunityInjected)), false);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
  await expect(page.locator('[data-opp-quote="manual:fixture-1"]')).toBeDisabled();
  await expect(page.locator('[data-opp-execute="manual:fixture-1"]')).toBeDisabled();
  await page.locator('#opp-next').click(); await expect(page.locator('#opp-assets article')).toHaveCount(2);
  await page.locator('#opp-prev').click();
  const first = page.locator('[data-asset-id="manual:fixture-1"]');
  await first.locator('.opp-approval summary').click();
  const form = first.locator('form');
  await expect(form.locator('[name="bnb.address"]')).toHaveAttribute('readonly', '');
  await form.locator('[name="bnb.decimals"]').fill('18'); await form.locator('[name="solana.decimals"]').fill('6');
  await form.locator('[name=evidence]').fill('Independent official 1:1 mapping evidence');
  await form.locator('[name=confirmed]').check();
  await page.locator('#opp-search').focus();
  const previousReads = calls.filter(call => call.method === 'GET').length;
  await expect.poll(() => calls.filter(call => call.method === 'GET').length, { timeout: 15000 }).toBeGreaterThan(previousReads);
  await first.locator('.opp-approval').evaluate(node => { node.open = true; });
  await expect(form.locator('[name=evidence]')).toHaveValue('Independent official 1:1 mapping evidence');
  await expect(form.locator('[name=confirmed]')).toBeChecked();
  await form.locator('button[type=submit]').click();
  await expect(first.locator('.badge')).toHaveText('用户已核验映射');
  assert.equal(calls.some(call => call.pathname.endsWith('/execute') || call.pathname.endsWith('/automation')), false);
  await first.locator('[data-opp-quote]').click();
  await expect(first.locator('[data-opp-execute]')).toBeEnabled();
  await expect(first.locator('.opp-evaluation')).toContainText('预计现金流价差');
  await first.locator('[data-opp-execute]').click();
  await expect(page.locator('#opp-execution')).toContainText('正在执行');
  fixture.execution.busy = false;
  await page.locator('#opp-scan').click();
  await expect(page.locator('#opp-auto')).toHaveText('开启模拟 · 已核验清单自动执行');
  await page.locator('#opp-auto').click();
  await expect(page.locator('#opp-auto')).toHaveText('暂停清单自动执行');
  await page.locator('#opp-auto').click();
  await expect(page.locator('#opp-auto')).toHaveText('开启模拟 · 已核验清单自动执行');
  console.log('PASS explicit mapping approval, two-sided quote, manual execution and separate automation opt-in');
  await page.locator('#opp-settings').evaluate(node => { node.parentNode.open = true; });
  await page.locator('#opp-settings [name=minLiquidityUsd]').fill('54321');
  const beforeEditing = calls.filter(call => call.method === 'GET').length;
  await expect.poll(() => calls.filter(call => call.method === 'GET').length, { timeout: 15000 }).toBeGreaterThan(beforeEditing);
  await expect(page.locator('#opp-settings [name=minLiquidityUsd]')).toHaveValue('54321');
  await page.locator('#opp-settings button[type=submit]').click();
  assert.equal(fixture.settings.minLiquidityUsd, 54321);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#opportunities-view')).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('[data-market-view=radar]').click();
  await expect(page.locator('h1')).toHaveText('Meme 观察雷达');
  await expect(page.locator('.market-subnav button')).toHaveCount(3);
  await page.locator('[data-market-view=opportunities]').click();
  await expect(page.locator('h1')).toHaveText('同币机会扫描');
  slowGet = true;
  const beforeSlow = calls.filter(call => call.method === 'GET').length;
  await expect.poll(() => calls.filter(call => call.method === 'GET').length, { timeout: 15000 }).toBeGreaterThan(beforeSlow);
  await page.locator('[data-tab=settings]').first().click();
  await expect(page.locator('h1')).toHaveText('设置与钱包');
  releaseSlow(); releaseSlow = null;
  await expect(page.locator('h1')).toHaveText('设置与钱包');
  await page.locator('#execution-mode').selectOption('inventory');
  await expect(page.locator('#settings-inventory')).toBeVisible();
  await expect(page.locator('[name="rebalance.enabled"]')).toBeDisabled();
  await page.locator('[name="inventory.mappingConfirmed"]').check();
  await page.locator('[name="chains.bnb.tokenAddress"]').fill('0x9999999999999999999999999999999999999999');
  await expect(page.locator('[name="inventory.mappingConfirmed"]')).not.toBeChecked();
  await page.locator('[name="inventory.mappingEvidence"]').fill('Official current-pair mapping evidence');
  await page.locator('[name="inventory.mappingConfirmed"]').check();
  await page.locator('#config-form button[type=submit]').click();
  await expect(page.locator('#execution-mode')).toHaveValue('inventory');
  assert.equal(config.inventory.mappingConfirmed, true); assert.equal(config.inventory.mappingEvidence, 'Official current-pair mapping evidence');
  await page.locator('[data-tab=market]').first().click();
  await page.locator('[data-market-view=arbitrage]').click();
  await expect(page.locator('.direction-detail')).toContainText('卖出现有库存');
  await expect(page.locator('body')).toContainText('虚拟同币库存');
  Object.assign(archiveStats, { profitUsd: .25, inventoryCashSpreadUsd: .75, inventoryCompleted: 1 });
  const inventoryTrade = { id: 'inventory-fixture', createdAt: new Date().toISOString(), mode: 'demo', executionMode: 'inventory', type: 'arbitrage', status: 'COMPLETED', buyChain: 'bnb', sellChain: 'solana', amountUsd: 5, estimate: { netProfitUsd: .8 }, actual: { cashSpreadProfitUsd: .75, profitUsd: .75, closedInventory: false, dustBuyRaw: '10', inventoryDelta: { bnb: { tokenRaw: '100000000000000000000', decimals: 18 }, solana: { tokenRaw: '-100000000', decimals: 6 } } }, events: [] };
  await page.route('**/api/trades?*', route => route.fulfill({ json: { items: [inventoryTrade], total: 1, page: 1, pageSize: 20 } }));
  await page.route('**/api/trades/inventory-fixture', route => route.fulfill({ json: inventoryTrade }));
  await page.route('**/api/reviews/current?*', route => route.fulfill({ json: { day: '2026-11-20', mode: 'demo', timeZone: 'Asia/Shanghai', counts: { verified: 2, closed: 1, inventory: 1, compared: 1, initiated: 2, completed: 2, needsReview: 0, incomplete: 0 }, pnl: { actualProfitUsd: .25, estimatedProfitUsd: .3, pairedActualProfitUsd: .25, differenceUsd: -.05, networkAndProtocolUsd: .02, rentUsd: 0 }, inventory: { verified: 1, compared: 1, cashSpreadProfitUsd: .75, estimatedCashSpreadUsd: .8, differenceUsd: -.05, closedInventory: false, includesRestockingCosts: false }, byType: [{ type: 'arbitrage', count: 1, profitUsd: .25 }], observations: [] } }));
  await page.locator('[data-tab=trades]').first().click();
  await expect(page.locator('#review-body')).toContainText('模拟闭环成交结果');
  await expect(page.locator('.inventory-review')).toContainText('$0.7500');
  await expect(page.locator('.review-metrics').first()).toContainText('$0.2500');
  await expect(page.locator('#trade-data')).toContainText('库存现金流价差 $0.7500');
  await page.locator('[data-trade-id=inventory-fixture]').click();
  await expect(page.locator('#dialog-content')).toContainText('模拟成交现金流价差');
  await expect(page.locator('#dialog-content')).toContainText('未含未来补库存成本');
  await expect(page.locator('#dialog-content')).toContainText('-100000000');
  await page.locator('#dialog-close').click();
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS XSS escaping, pagination, draft preservation, stale-view protection, five tabs and 390px layout');
} finally {
  releaseSlow?.(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
}
