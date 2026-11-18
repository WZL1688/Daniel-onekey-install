// Read-only review UI fixtures: no wallet access, model calls, RPC, signing or trades.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';

const modeState = { value: 'demo' };
const calls = [];
const mutations = [];
const delayed = new Map();
function gate(day) {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const item = { started, wait, entered, release };
  delayed.set(day, item); return item;
}
function report(day = '2026-11-18', mode = modeState.value) {
  const empty = day === '2026-11-17';
  return {
    id: `review-${mode}-${day}`, day, mode, timeZone: 'Asia/Shanghai', generatedAt: '2026-11-18T03:00:00.000Z',
    counts: { initiated: empty ? 0 : 3, completed: empty ? 0 : 2, verified: empty ? 0 : 2, compared: empty ? 0 : 2, needsReview: empty ? 0 : 1, incomplete: 0 },
    pnl: { actualProfitUsd: empty ? null : day === '2026-11-16' ? 999 : .25, estimatedProfitUsd: empty ? null : .3, pairedActualProfitUsd: empty ? null : .25, differenceUsd: empty ? null : -.05, networkAndProtocolUsd: empty ? 0 : .02, rentUsd: empty ? 0 : .001 },
    byType: empty ? [] : [{ type: 'arbitrage', count: 2, profitUsd: .25 }],
    coverage: { pendingReviewScope: 'all-current-records-in-mode' },
    observations: empty ? [{ code: 'NO_VERIFIED_TRADES', text: '尚无可复核的成交收益' }] : [{ code: 'REVIEW_PENDING', text: '有1笔待人工核对' }, { code: 'FIXTURE_ESCAPE', text: '<img src=x onerror="window.reviewInjected=true">仅作为文字显示' }],
    valuation: '稳定币面值与原生币参考汇率',
  };
}
const reviewService = {
  async current(options = {}) {
    calls.push({ action: 'current', ...options });
    const pending = delayed.get(options.day);
    if (pending) { pending.entered(); await pending.wait; delayed.delete(options.day); }
    return report(options.day, options.mode);
  },
  export(options = {}) { calls.push({ action: 'export', ...options }); const fixture = report(options.day, options.mode); return { schemaVersion: 1, day: fixture.day, mode: fixture.mode, counts: fixture.counts, pnl: fixture.pnl, valuation: fixture.valuation }; },
};
const forbid = name => () => { mutations.push(name); throw new Error(`read-only review must not call ${name}`); };
const engine = {
  config: structuredClone(DEFAULT_CONFIG), busy: false,
  snapshot: () => ({ config: { ...structuredClone(DEFAULT_CONFIG), mode: modeState.value }, market: {}, balances: {}, opportunity: { reasons: ['fixture'], executable: false }, engine: { running: false, busy: false }, wallets: { bnb: { mode: 'none' }, solana: { mode: 'none' } }, stats: { executions: 0, cumulativeUsd: 0, profitUsd: 0, completed: 0 } }),
  saveConfig: forbid('saveConfig'), start: forbid('start'), execute: forbid('execute'), pause: forbid('pause'), quoteBridge: forbid('quoteBridge'), executeBridge: forbid('executeBridge'),
};
const store = { listTrades: () => ({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }), listReviews: () => ({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 1 }), listNotes: () => ({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 1 }) };
const vault = { publicStatus: () => ({ bnb: { mode: 'none' }, solana: { mode: 'none' } }) };
const { server, url } = await startLocalServer({ engine, store, vault, reviewService });
let browser;
const errors = [];
const writeRequests = [];
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writeRequests.push(request.url()); });
  await page.goto(url + '/#trades');
  await expect(page.locator('h1')).toHaveText('交易档案');
  await expect(page.locator('#review-panel')).toBeVisible();
  await expect(page.locator('#review-day')).toHaveValue('2026-11-18');
  await expect(page.locator('#review-mode')).toContainText('模拟');
  await expect(page.locator('#review-panel')).toContainText('只读');
  await expect(page.locator('#review-body')).toContainText('$0.2500');
  await expect(page.locator('#review-body')).toContainText('-0.0500');
  await expect(page.locator('#review-body')).toContainText('$0.0200');
  await expect(page.locator('#review-body')).toContainText('$0.0010');
  await expect(page.locator('#review-body')).toContainText('当前待核对');
  await expect(page.locator('#review-body')).toContainText('有1笔待人工核对');
  assert.equal(await page.evaluate(() => Boolean(window.reviewInjected)), false);
  assert.equal(await page.locator('#review-body img').count(), 0);
  assert(calls.some(call => call.action === 'current' && call.mode === 'demo'));
  console.log('PASS local review renders verified P&L, same-sample estimate difference, costs and current unresolved count');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#review-export').click();
  const download = await downloadPromise;
  const downloaded = JSON.parse(readFileSync(await download.path(), 'utf8'));
  assert.equal(downloaded.mode, 'demo'); assert.equal(downloaded.day, '2026-11-18');
  assert.equal(downloaded.pnl.actualProfitUsd, .25);
  for (const forbidden of ['privateKey', 'password', 'wallets', 'rpcs', 'quote', 'hash', 'notes']) assert.equal(Object.hasOwn(downloaded, forbidden), false);
  assert(calls.some(call => call.action === 'export' && call.mode === 'demo' && call.day === '2026-11-18'));
  console.log('PASS deidentified JSON download uses the displayed date and mode');

  await page.locator('#review-day').fill('2026-11-17');
  await page.locator('#review-day').dispatchEvent('change');
  await page.locator('#review-refresh').click();
  await expect(page.locator('#review-body')).toContainText('净收益未验证');
  await expect(page.locator('#review-body')).not.toContainText('$0.2500');
  assert(calls.some(call => call.action === 'current' && call.day === '2026-11-17'));
  console.log('PASS an empty period never presents invented verified returns');

  const stale = gate('2026-11-16');
  await page.locator('#review-day').fill('2026-11-16');
  await page.locator('#review-day').dispatchEvent('change');
  await page.locator('#review-refresh').click();
  await stale.started;
  await page.locator('#review-day').fill('2026-11-18');
  await page.locator('#review-day').dispatchEvent('change');
  await page.locator('#review-refresh').click();
  await expect(page.locator('#review-body')).toContainText('$0.2500');
  const staleResponse = page.waitForResponse(response => response.url().includes('/api/reviews/current') && response.url().includes('2026-11-16'));
  stale.release(); await (await staleResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#review-day')).toHaveValue('2026-11-18');
  await expect(page.locator('#review-body')).not.toContainText('$999.0000');
  console.log('PASS a delayed report for an older date cannot overwrite the selected date');

  const leaving = gate('2026-11-15');
  await page.locator('#review-day').fill('2026-11-15');
  await page.locator('#review-day').dispatchEvent('change');
  await page.locator('#review-refresh').click(); await leaving.started;
  await page.locator('.nav-item[data-tab="notes"]').click();
  const leavingResponse = page.waitForResponse(response => response.url().includes('/api/reviews/current') && response.url().includes('2026-11-15'));
  leaving.release(); await (await leavingResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('h1')).toHaveText('备忘录');
  assert.equal(await page.locator('#review-panel').count(), 0);
  console.log('PASS a delayed report cannot pull the user back after changing tabs');

  modeState.value = 'live';
  await page.reload();
  await page.locator('.nav-item[data-tab="trades"]').click();
  await expect(page.locator('#review-mode')).toContainText('实盘');
  await expect(page.locator('#review-body')).toContainText('$0.2500');
  assert(calls.some(call => call.action === 'current' && call.mode === 'live'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []); assert.deepEqual(mutations, []); assert.deepEqual(writeRequests, []);
  console.log('PASS explicit mode separation, 390px layout and no execution/configuration/signing writes');
} finally {
  for (const pending of delayed.values()) pending.release();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
