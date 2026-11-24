// Offline labels only: synthetic prices, mixed-mode archives and no wallet/signing actions.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';

const config = structuredClone(DEFAULT_CONFIG);
config.executionMode = 'inventory';
const now = Date.now(), errors = [], writes = [], external = [], mutations = [];
const fingerprint = 'c'.repeat(64);
const trades = [
  { id: 'demo-bridge', mode: 'demo', type: 'arbitrage', executionMode: 'bridge', status: 'COMPLETED', amountUsd: 5, createdAt: now, buyChain: 'bnb', sellChain: 'solana', estimate: { netProfitUsd: .159 }, actual: { profitUsd: .2373, profitDifferenceUsd: .0783 }, events: [{ state: 'BUY_CONFIRMED', at: now }], legs: [{ receipt: { hash: 'synthetic-demo-hash' } }] },
  { id: 'live-bridge', mode: 'live', type: 'arbitrage', executionMode: 'bridge', status: 'COMPLETED', amountUsd: 5, createdAt: now - 1, buyChain: 'bnb', sellChain: 'solana', estimate: { netProfitUsd: .12 }, actual: { profitUsd: .03 } },
  { id: 'demo-inventory', mode: 'demo', type: 'arbitrage', executionMode: 'inventory', status: 'COMPLETED', amountUsd: 5, createdAt: now - 2, estimate: { netProfitUsd: .08 }, actual: { cashSpreadProfitUsd: .06, closedInventory: false } },
  { id: 'live-inventory', mode: 'live', type: 'arbitrage', executionMode: 'inventory', status: 'COMPLETED', amountUsd: 5, createdAt: now - 3, estimate: { netProfitUsd: .07 }, actual: { cashSpreadProfitUsd: .04, closedInventory: false } },
  { id: 'legacy-unknown', type: 'arbitrage', status: 'COMPLETED', amountUsd: 5, createdAt: now - 4, estimate: { netProfitUsd: .01 }, actual: { profitUsd: .005 } }
];
const originalTrades = structuredClone(trades);
const market = {
  bnb: { connected: true, priceUsd: .0124, symbol: 'DEMO', liquidityUsd: 182400, updatedAt: now, rpc: '本地模拟器' },
  solana: { connected: true, priceUsd: .0131, symbol: 'DEMO', liquidityUsd: 143800, updatedAt: now, rpc: '本地模拟器' }
};
const balances = { bnb: { stableUsd: 20, nativeBalance: .025, tokenBalance: 1000 }, solana: { stableUsd: 30.49, nativeBalance: .3, tokenBalance: 1000 } };
const asset = { id: 'coingecko:public-altcoin', name: 'Public altcoin fixture', symbol: 'ALT', revision: 1, enabled: true, mapping: { confirmed: true } };
function scannerSnapshot() {
  const sampled = Date.now();
  return {
    status: 'monitoring', enabled: true, busy: false, updatedAt: sampled,
    settings: { minSpreadBps: 50, maxSpreadBps: 3000, maxSideSkewMs: 30000 }, counts: { quarantined: 0 },
    rows: [{ asset, generation: 'offline-public-reference', opportunityQualified: true, marketQualified: true, universe: { eligible: true }, comparisonStatus: 'comparable', observedAt: sampled, buyChain: 'bnb', sellChain: 'solana', spreadBps: 400, executable: true,
      market: { bnb: { priceUsd: .01, observedAt: sampled, priceConfidence: 'pool-consensus' }, solana: { priceUsd: .0104, observedAt: sampled, priceConfidence: 'pool-consensus' } },
      evaluation: { mode: config.mode, executionMode: 'inventory', executable: true, assetRevision: 1, parentPolicyFingerprint: fingerprint, amountUsd: config.risk.amountUsd, netProfitUsd: .2, gasUsd: .01, slippageUsd: .01, priceImpactBps: 10, buyChain: 'bnb', sellChain: 'solana', quotedAt: new Date(sampled).toISOString(), expiresAt: new Date(sampled + 60000).toISOString() }
    }]
  };
}
const forbid = name => () => { mutations.push(name); throw new Error('No mutation expected: ' + name); };
const engine = {
  config,
  snapshot: () => ({ config: structuredClone(config), policyFingerprint: fingerprint, market, balances, opportunity: { executable: true, reasons: [], buyChain: 'bnb', sellChain: 'solana', spreadBps: 565, amountUsd: 5, netProfitUsd: .159, grossProfitUsd: .2823, slippageUsd: .026, gasUsd: .0081, bridgeFeeUsd: .005, priceImpactBps: 8 }, engine: { running: false, busy: false, configuring: false, pausedReason: '' }, wallets: { bnb: { mode: 'local', canSign: true }, solana: { mode: 'local', canSign: true } }, stats: { executions: 2, cumulativeUsd: 10, profitUsd: .2373, inventoryCompleted: 1, inventoryCashSpreadUsd: .06 } }),
  start: forbid('start'), pause: forbid('pause'), execute: forbid('execute'), saveConfig: forbid('saveConfig'), quoteBridge: forbid('quoteBridge'), executeBridge: forbid('executeBridge')
};
const store = { allTrades: () => structuredClone(trades), listTrades: () => ({ items: structuredClone(trades), total: trades.length, page: 1, pageSize: 10, pages: 1 }), getTrade: id => structuredClone(trades.find(row => row.id === id)), listNotes: () => ({ items: [], total: 0, page: 1, pages: 1 }) };
const reviewService = { current: ({ mode }) => ({ mode, day: '2026-11-24', generatedAt: now, timeZone: 'Asia/Shanghai', counts: { verified: 2, closed: 1, compared: 1 }, pnl: { actualProfitUsd: .2373, estimatedProfitUsd: .159, pairedActualProfitUsd: .2373, differenceUsd: .0783, networkAndProtocolUsd: .0081, rentUsd: .001 }, inventory: { verified: 1, compared: 1, cashSpreadProfitUsd: .06, estimatedCashSpreadUsd: .08, differenceUsd: -.02 }, byType: [{ type: 'arbitrage', count: 2, profitUsd: .2373 }], observations: [] }) };
const { server, url } = await startLocalServer({ engine, store, vault: { publicStatus: () => ({}) }, reviewService, opportunityService: { snapshot: scannerSnapshot }, inventoryCoordinator: { snapshot: () => ({ mode: config.mode, executionMode: 'inventory', busy: false, running: false }) } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith(url)) external.push(request.url()); if (request.method() !== 'GET') writes.push(request.method() + ' ' + request.url()); });
  await page.goto(url);
  await expect(page.locator('#mode-badge')).toHaveText('模拟模式');
  await expect(page.locator('#main > .notice')).toContainText('模拟流程演练（虚拟资金）');
  await expect(page.locator('#main > .notice')).toContainText('实盘成功率未验证');
  await expect(page.locator('.chain-grid')).toContainText('虚拟稳定币');
  await expect(page.locator('.chain-grid')).toContainText('模拟行情');
  await expect(page.locator('.chain-grid')).toContainText('$0.01240000');
  await expect(page.locator('.opportunity')).toContainText('模拟估算现金流价差');
  await expect(page.locator('.opportunity')).toContainText('模拟流程检查通过');
  await expect(page.locator('.opportunity')).not.toContainText('已通过执行检查');
  await expect(page.locator('#engine-toggle')).toContainText('启动自动演练');
  await expect(page.locator('#execute-arbitrage')).toHaveText('模拟执行一笔');
  await expect(page.locator('[data-scanner-board-reference-count]')).toHaveText('1');
  await expect(page.locator('[data-scanner-board-quote-count]')).toHaveText('1');
  await expect(page.locator('[data-scanner-board-description]')).toContainText('真实公开行情');
  await expect(page.locator('[data-scanner-board-filter=executable]')).toHaveText('模拟流程报价');
  await expect(page.locator('.scanner-board-prices')).toContainText('$0.01');
  await expect(page.locator('.scanner-board-row')).toContainText('模拟流程验证通过');
  await expect(page.locator('.scanner-board-quote')).toContainText('模拟估算现金流价差');
  await expect(page.locator('.scanner-board-quote')).toContainText('虚拟金额');
  await expect(page.locator('#scanner-board-root')).not.toContainText('可执行报价');
  console.log('PASS fixed DEMO preview is virtual flow practice; public reference prices remain public while demo quotes cannot advertise live execution');

  await page.locator('.nav-item[data-tab=trades]').click();
  await expect(page.locator('#review-body')).toContainText('模拟闭环成交结果');
  await expect(page.locator('#review-body')).toContainText('模拟库存模式现金流价差');
  await expect(page.locator('#trade-data .mini-stats')).toContainText('模拟闭环累计结果');
  await expect(page.locator('table thead')).not.toContainText('实际净收益');
  const demoRow = page.locator('tr[data-trade-mode=demo]').filter({ has: page.locator('[data-trade-id=demo-bridge]') });
  await expect(demoRow).toContainText('模拟 · 虚拟资金');
  await expect(demoRow).toContainText('模拟估算净收益');
  await expect(demoRow).toContainText('模拟成交结果');
  await expect(demoRow).not.toContainText('实际净收益');
  await expect(demoRow).toContainText('$0.2373');
  const liveRow = page.locator('tr[data-trade-mode=live]').filter({ has: page.locator('[data-trade-id=live-bridge]') });
  await expect(liveRow).toContainText('实盘实际净收益');
  await expect(liveRow).not.toContainText('模拟');
  const inventoryRow = page.locator('tr').filter({ has: page.locator('[data-trade-id=live-inventory]') });
  await expect(inventoryRow).toContainText('实盘实际现金流价差');
  await expect(inventoryRow).toContainText('未含补库成本 · 未闭环');
  await expect(inventoryRow).not.toContainText('净收益');
  await expect(page.locator('tr[data-trade-mode=unknown]')).toContainText('模式未记录');
  await expect(page.locator('tr[data-trade-mode=unknown]')).not.toContainText('实盘');
  await page.locator('[data-trade-id=demo-bridge]').click();
  await expect(page.locator('#dialog-content')).toContainText('模拟成交结果（虚拟资金）');
  await expect(page.locator('#dialog-content')).toContainText('未在主网成交');
  assert.deepEqual(JSON.parse(await page.locator('.record-json').textContent()), originalTrades[0]);
  await page.locator('#dialog-close').click();
  await page.locator('[data-trade-id=live-inventory]').click();
  await expect(page.locator('#dialog-content')).toContainText('实盘交易详情');
  await expect(page.locator('#dialog-content')).toContainText('不作为闭环净收益');
  await expect(page.locator('#dialog-content .detail-list').first()).toContainText('实盘实际现金流价差');
  await page.locator('#dialog-close').click();
  console.log('PASS mixed historical archives derive every result label from its original mode, preserve values/raw records and keep inventory cash spreads distinct from closed profits');

  await page.locator('.nav-item[data-tab=bridge]').click();
  await expect(page.locator('#main')).toContainText('模拟手动跨链兑换');
  await expect(page.locator('#main')).toContainText('来源虚拟资金');
  await expect(page.locator('#main')).toContainText('双链虚拟稳定币总额');

  // Fixture-side mode change only; the browser never sends a configuration request.
  config.mode = 'live';
  await expect(page.locator('#mode-badge')).toHaveText('实盘模式', { timeout: 5000 });
  await page.locator('.nav-item[data-tab=market]').click();
  await expect(page.locator('[data-scanner-board-filter=executable]')).toHaveText('可执行报价');
  await expect(page.locator('[data-scanner-board-quote-count]')).toHaveText('1');
  await expect(page.locator('.scanner-board-row')).toContainText('当前报价检查通过');
  await expect(page.locator('.scanner-board-quote')).not.toContainText('模拟');
  await page.locator('.nav-item[data-tab=trades]').click();
  await expect(page.locator('#trade-data .mini-stats')).toContainText('实盘闭环累计净收益');
  await expect(page.locator('tr[data-trade-mode=demo]').first()).toContainText('模拟成交结果');
  await expect(page.locator('tr[data-trade-mode=live]').first()).toContainText('实盘实际净收益');
  for (const tab of ['market', 'bridge', 'trades']) {
    await page.locator(`.nav-item[data-tab=${tab}]`).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), tab + ' mobile overflow');
    await page.setViewportSize({ width: 1440, height: 1040 });
  }
  assert.deepEqual(trades, originalTrades);
  assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.deepEqual(mutations, []); assert.deepEqual(errors, []);
  console.log('PASS live labels stay live; switching display context cannot relabel old demo profits; layouts fit390px with no write, external call, wallet or execution action');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
