// Controlled offline regression: a delayed state read cannot undo a confirmed configuration save.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';
let config = structuredClone(DEFAULT_CONFIG), delayNext = false, release;
const errors = [], writes = [];
const snapshot = () => ({ config: structuredClone(config), market: {}, balances: {}, opportunity: { executable: false, reasons: ['Offline fixture'] }, engine: { running: false, busy: false }, wallets: {}, stats: {} });
const engine = { config, snapshot, saveConfig: async input => { config = structuredClone(input); engine.config = config; writes.push(config); return snapshot(); } };
const { server, url } = await startLocalServer({ engine, store: {}, vault: { publicStatus: () => ({}) } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/state', async route => {
    if (!delayNext) return route.continue(); delayNext = false;
    const old = snapshot(); await new Promise(resolve => { release = resolve; });
    return route.fulfill({ json: { ...old, features: { opportunities: false, quality: false, performance: false, liveReadiness: false, bnbApprovals: false, onchainResearch: false } } });
  });
  await page.goto(url + '/#settings'); await expect(page.locator('#execution-mode')).toHaveValue('bridge');
  await page.locator('#execution-mode').selectOption('inventory');
  delayNext = true; await expect.poll(() => typeof release, { timeout: 7000 }).toBe('function');
  await page.locator('#config-form button[type=submit]').click();
  await expect.poll(() => writes.length).toBe(1); await expect(page.locator('#execution-mode')).toHaveValue('inventory');
  release(); release = null; await page.waitForTimeout(300);
  await expect(page.locator('#execution-mode')).toHaveValue('inventory');
  await page.locator('[data-tab=market]').first().click();
  await expect(page.locator('.direction-detail')).toContainText('卖出现有库存');
  assert.equal(config.executionMode, 'inventory'); assert.deepEqual(errors, []);
  console.log('PASS an obsolete in-flight state response cannot overwrite confirmed configuration or reset the selected execution mode');
} finally { release?.(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
