// Offline browser fixtures only. No external API, wallet, signing, or trade.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';

const config = structuredClone(DEFAULT_CONFIG), calls = [], errors = [], forbidden = [];
const unexpected = name => () => { forbidden.push(name); throw new Error('Only scanner display/settings are expected'); };
const engine = { config, snapshot: () => ({ config, market: {}, balances: {}, opportunity: {}, engine: { running: false, busy: false }, wallets: { bnb: { mode: 'none' }, solana: { mode: 'none' } }, stats: {} }), start: unexpected('start'), execute: unexpected('execute'), pause: unexpected('pause'), saveConfig: unexpected('saveConfig') };
const { server, url } = await startLocalServer({ engine, store: {}, vault: { publicStatus: () => ({}) } });
const now = Date.now();
const asset = (id, symbol, approved = false) => ({ id, symbol, name: symbol === 'ALT1' ? '<img src=x onerror="window.altcoinInjection=true">' : `${symbol} fixture`, source: 'wormhole', confirmed: approved, revision: 1, enabled: true, mapping: { confirmed: approved, evidence: approved ? 'Fixture official 1:1 evidence' : '' }, chains: { bnb: { address: '0x1111111111111111111111111111111111111111', decimals: 18, poolAddress: '0x2222222222222222222222222222222222222222' }, solana: { address: 'So11111111111111111111111111111111111111112', decimals: 9, poolAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } });
const market = { bnb: { priceUsd: .01, liquidityUsd: 100000, volume24hUsd: 50000, volume1hUsd: 1000, trades1h: 20, observedAt: now }, solana: { priceUsd: .0104, liquidityUsd: 120000, volume24hUsd: 65000, volume1hUsd: 1200, trades1h: 22, observedAt: now } };
const spec = [
  ['anomaly', 'ANOMALY', 'altcoin', true, true, false, 5000, false, ['价差异常过大，须核对池、单位关系和可卖出性']],
  ['alt1', 'ALT1', 'altcoin', true, true, true, 400, false, []],
  ['alt2', 'ALT2', 'altcoin', true, true, true, 250, true, []],
  ['quiet', 'QUIET', 'altcoin', true, true, false, 20, false, ['价差低于门槛']],
  ['one-side', 'ONE', 'altcoin', true, false, false, null, false, ['Solana 未发现有效活跃交易池']],
  ['stable', 'USDC', 'stablecoin', false, true, false, 150, false, ['稳定币默认排除']],
  ['major', 'WETH', 'major', false, true, false, 170, false, ['主流资产默认排除']],
  ['unknown', 'MYSTERY', 'unknown', false, true, false, 800, false, ['资产类别或同币身份待核验']],
  ['blocked', 'BLOCK', 'altcoin', false, false, false, null, false, ['行情成交活跃度不足 <img src=x onerror="window.altcoinInjection=true">']]
];
const rows = spec.map(([id, symbol, category, eligible, marketQualified, opportunityQualified, spreadBps, approved, reasons]) => {
  const item = asset(id, symbol, approved);
  return { asset: item, universe: { category, eligible, reasons, evidence: 'Fixture official token identity evidence; names alone are insufficient' }, marketQualified, opportunityQualified, stage: approved ? 'candidate' : 'needs_mapping', reasons, market: marketQualified ? structuredClone(market) : { bnb: structuredClone(market.bnb) }, observedAt: now, buyChain: spreadBps === null ? null : 'bnb', sellChain: spreadBps === null ? null : 'solana', spreadBps, indicativeGrossUsd: spreadBps === null ? null : spreadBps / 2000, evaluation: null };
});
const fixture = { enabled: true, autoScanPreferred: true, busy: false, assets: rows.map(row => row.asset), rows, status: 'monitoring', reason: '自动扫描山寨币双链活跃池，交易默认关闭', lastError: null, notice: '', usage: { day: 8, total: 8 }, updatedAt: now, directoryUpdatedAt: now, nextRequestAt: now + 60000,
  settings: { pollIntervalMs: 60000, minLiquidityUsd: 20000, minSpreadBps: 50, maxSpreadBps: 3000, minVolume24hUsd: 10000, minVolume1hUsd: 100, minTrades1h: 3, maxSideSkewMs: 30000, maxAssetsPerScan: 30, maxRequestsPerDay: 5000, includeStablecoins: false, includeMajors: false },
  counts: { total: 9, approved: 1, candidate: 2, eligible: 5, excluded: 4, dualActive: 4, opportunities: 2, executable: 0 },
  scope: { kind: 'altcoins', label: '山寨币同币双链', eligible: 5, excluded: 4, reasonCounts: [{ reason: '稳定币默认排除', count: 1 }, { reason: '主流资产默认排除', count: 1 }, { reason: '资产类别或同币身份待核验', count: 1 }, { reason: '行情成交活跃度不足', count: 1 }], identityNotice: '同名不等于同币；候选仍须核验官方身份、精度与映射。' },
  directory: { status: 'ready', source: 'bundled-wormhole', sourceDate: '2026-04-08', foundCount: 8, sourceAttempts: [{ source: 'coinpaprika-bnb', status: 'ready', foundCount: 8 }, { source: 'coinpaprika-solana', status: 'ready', foundCount: 8 }] }, credentials: { configured: false, locked: false },
  scanProgress: { totalAssets: 9, scannedAssets: 9, withBothMarkets: 7, withActiveMarkets: 4, excludedAssets: 4, eligibleAssets: 5, opportunities: 2 },
  execution: { busy: false, running: false, mode: 'demo', executionMode: 'bridge', lastError: '' }
};
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const pathname = new URL(request.url()).pathname; if (/^\/api\/(?:engine(?:\/|$)|config(?:\/|$)|wallet(?:s)?(?:\/|$))/.test(pathname) || /^\/api\/opportunities\/(?:execute|automation|quote|approve)$/.test(pathname)) forbidden.push(`${request.method()} ${pathname}`); });
  await page.route('**/api/opportunities**', async route => {
    const request = route.request(), method = request.method(), pathname = new URL(request.url()).pathname, body = method === 'GET' ? null : request.postDataJSON();
    calls.push({ method, pathname, body });
    if (method === 'GET') return route.fulfill({ json: fixture });
    assert.equal(pathname, '/api/opportunities/settings'); assert.equal(method, 'POST');
    Object.assign(fixture.settings, body.settings);
    if (body.settings.includeStablecoins) {
      const stable = fixture.rows.find(row => row.asset.id === 'stable'); stable.universe.eligible = true; stable.universe.reasons = []; stable.reasons = [];
      Object.assign(fixture.counts, { eligible: 6, excluded: 3, dualActive: 5 }); Object.assign(fixture.scope, { eligible: 6, excluded: 3 });
      fixture.scope.reasonCounts = fixture.scope.reasonCounts.filter(entry => entry.reason !== '稳定币默认排除');
      Object.assign(fixture.scanProgress, { eligibleAssets: 6, excludedAssets: 3, withActiveMarkets: 5 });
    }
    return route.fulfill({ json: fixture });
  });
  await page.goto(url); await expect(page.locator('h1')).toHaveText('双链行情工作台');
  await page.locator('[data-market-view=opportunities]').click(); await expect(page.locator('h1')).toHaveText('同币机会扫描');
  await expect(page.locator('.nav-item')).toHaveCount(5);
  await expect(page.locator('#opp-source-attempts')).toContainText('CoinPaprika BNB 合约目录');
  await expect(page.locator('#opp-source-attempts')).toContainText('CoinPaprika Solana 合约目录');
  const filter = page.locator('#opp-filter'), cards = page.locator('#opp-assets article.opp-asset'), visibleIds = () => cards.evaluateAll(nodes => nodes.map(node => node.dataset.assetId));
  await expect(filter).toHaveValue('altcoins'); await expect(cards).toHaveCount(4);
  assert.deepEqual(new Set(await visibleIds()), new Set(['alt1', 'alt2', 'quiet', 'anomaly']));
  await expect(page.locator('#opp-assets .opp-compact-row')).toHaveCount(4);
  await expect(cards.first()).toHaveAttribute('data-asset-id', 'alt1');
  const anomaly = page.locator('[data-asset-id=anomaly]');
  await expect(anomaly.locator('.opp-compact-spread')).toContainText('异常价差，待核对');
  await expect(anomaly.locator('.opp-compact-spread > strong')).toHaveClass(/negative/);
  assert.equal(await anomaly.locator('.opp-compact-spread > strong.positive').count(), 0);
  assert.equal(await page.locator('#opp-assets details.opp-asset-details[open]').count(), 0, 'Full identity and mapping editors remain collapsed in compact rows');
  await expect(page.locator('#opp-universe-summary')).toContainText('山寨币');
  await expect(page.locator('#opp-rejection-summary')).toContainText('稳定币');
  for (const [id, value] of [['opp-discovered-count', 9], ['opp-scanned-count', 9], ['opp-dual-active-count', 4], ['opp-eligible-count', 5], ['opp-excluded-count', 4], ['opp-opportunity-count', 2]]) await expect(page.locator(`#${id}`)).toHaveText(String(value));
  const first = page.locator('[data-asset-id=alt1]'); await first.locator('details.opp-asset-details > summary').click();
  await expect(first.locator('[data-opp-quote]')).toBeDisabled(); await expect(first.locator('[data-opp-execute]')).toBeDisabled();
  await expect(first).toContainText('核验'); await expect(first).toContainText('费用');
  assert.equal(await first.locator('.opp-evaluation').count(), 0, 'Unquoted reference spreads never invent fee or profit estimates');
  assert.equal(await page.locator('#opp-assets img').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.altcoinInjection)), false);
  console.log('PASS default eligible active-altcoin view, compact collapsed rows, truthful counters and required mapping/fee checks');

  await filter.selectOption('candidate'); await expect(cards).toHaveCount(2); assert.deepEqual(new Set(await visibleIds()), new Set(['alt1', 'alt2']));
  await filter.selectOption('approved'); await expect(cards).toHaveCount(1); await expect(cards).toHaveAttribute('data-asset-id', 'alt2');
  await filter.selectOption('excluded'); await expect(cards).toHaveCount(5);
  assert.deepEqual(new Set(await visibleIds()), new Set(['one-side', 'stable', 'major', 'unknown', 'blocked']));
  await expect(page.locator('#opp-assets')).toContainText('稳定币'); await expect(page.locator('#opp-assets')).toContainText('主流'); await expect(page.locator('#opp-assets')).toContainText('Solana');
  assert.equal(await page.locator('#opp-assets img').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.altcoinInjection)), false);
  await filter.selectOption('all'); await expect(cards).toHaveCount(9);
  const oneSided = page.locator('[data-asset-id=one-side]'); await oneSided.locator('details.opp-asset-details > summary').click(); await expect(oneSided).toContainText('未知');
  await expect(oneSided.locator('[data-opp-quote]')).toBeDisabled(); await expect(oneSided.locator('[data-opp-execute]')).toBeDisabled();
  assert.equal(calls.some(call => call.method !== 'GET'), false, 'Filters, exclusions and card expansion are local display actions');
  console.log('PASS reference, approved, all and excluded filters expose identity and inactive-market reasons without enabling trades');

  await page.locator('#opp-settings').evaluate(node => { node.parentNode.open = true; });
  const settings = page.locator('#opp-settings');
  await settings.locator('.opp-advanced-scan > summary').click();
  await expect(settings.locator('[name=includeStablecoins]')).not.toBeChecked(); await expect(settings.locator('[name=includeMajors]')).not.toBeChecked();
  await expect(settings.locator('[name=minVolume24hUsd]')).toHaveValue('10000'); await expect(settings.locator('[name=minVolume1hUsd]')).toHaveValue('100');
  await expect(settings.locator('[name=minTrades1h]')).toHaveValue('3'); await expect(settings.locator('[name=maxSideSkewSeconds]')).toHaveValue('30'); await expect(settings.locator('[name=maxSpreadPercent]')).toHaveValue('30');
  await settings.locator('[name=includeStablecoins]').check();
  await settings.locator('[name=minVolume24hUsd]').fill('20000'); await settings.locator('[name=minVolume1hUsd]').fill('250'); await settings.locator('[name=minTrades1h]').fill('5'); await settings.locator('[name=maxSideSkewSeconds]').fill('20'); await settings.locator('[name=maxSpreadPercent]').fill('12');
  await settings.locator('button[type=submit]').click();
  await expect.poll(() => calls.filter(call => call.method === 'POST').length).toBe(1);
  const saved = calls.find(call => call.method === 'POST');
  assert.equal(saved.pathname, '/api/opportunities/settings');
  for (const [key, value] of Object.entries({ includeStablecoins: true, includeMajors: false, minVolume24hUsd: 20000, minVolume1hUsd: 250, minTrades1h: 5, maxSideSkewMs: 20000, maxSpreadBps: 1200 })) assert.equal(saved.body.settings[key], value, `Settings conversion for ${key}`);
  await filter.selectOption('altcoins'); await expect(cards).toHaveCount(5); assert.equal((await visibleIds()).includes('stable'), true, 'Server-confirmed eligibility after explicit opt-in is respected');
  await expect(page.locator('#opp-excluded-count')).toHaveText('3');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS explicit stablecoin opt-in, volume/activity/skew/spread settings conversion, 390px layout and no wallet or execution requests');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
