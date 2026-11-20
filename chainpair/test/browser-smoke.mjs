import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { Store } from '../src/store.mjs';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'chainpair-browser-'));
const store = new Store(dataDir);
store.saveTrade({ id: 'browser-recovery', mode: 'demo', type: 'arbitrage', status: 'BUY_SUBMITTING', amountUsd: 5 });
store.close();
const child = spawn(process.execPath, ['src/main.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '0', DUALARB_DATA_DIR: dataDir, DUALARB_AUTO_SCAN: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
let browser;
const failures = [];
try {
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('本机服务启动超时')), 15000);
    child.stdout.on('data', bytes => { output += bytes; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`服务退出 ${code}`)); });
  });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto(url);
  await expect(page.locator('h1')).toHaveText('双链行情工作台');
  await expect(page.locator('#mode-badge')).toHaveText('模拟模式');
  await page.locator('#acknowledge').click();
  await page.locator('#ack-note').fill('已核对测试记录没有实际广播，仅验证中断恢复与人工核对。');
  await page.locator('#ack-form button[type=submit]').click();
  await expect(page.locator('#detail-dialog')).not.toBeVisible();
  await expect(page.locator('#execute-arbitrage')).toBeEnabled();
  console.log('PASS recovery review UI unlocks using persisted trade id');
  const session = await (await page.request.get(`${url}/api/session`)).json();
  const post = async (endpoint, body) => {
    const response = await page.request.post(url + endpoint, { headers: { 'X-CSRF-Token': session.csrfToken }, data: body });
    const data = await response.json(); assert.equal(response.status(), 200, JSON.stringify(data)); return data;
  };
  const getState = async () => (await page.request.get(`${url}/api/state`)).json();
  await page.locator('#execute-arbitrage').click();
  await expect.poll(async () => (await getState()).stats.completed, { timeout: 10000 }).toBe(1);
  const trades = await (await page.request.get(`${url}/api/trades`)).json();
  const arb = trades.items.find(t => t.type === 'arbitrage' && t.status === 'COMPLETED');
  const details = await (await page.request.get(`${url}/api/trades/${arb.id}`)).json();
  const steps = details.events.map(event => event.state);
  assert(steps.indexOf('BUY_CONFIRMED') < steps.indexOf('BRIDGE_SUBMITTING'));
  assert(steps.indexOf('BRIDGE_CONFIRMED') < steps.indexOf('SELL_SUBMITTING'));
  assert.equal(details.legs[1].quote.amountInRaw, details.legs[0].receipt.receivedRaw);
  assert.equal(details.legs[2].quote.amountInRaw, details.legs[1].receipt.receivedRaw);
  assert(Number.isFinite(details.actual.profitUsd));
  console.log('PASS UI arbitrage completion and actual-quantity ordering');
  await page.locator('.nav-item[data-tab="notes"]').click();
  await page.locator('#note-form textarea').fill('浏览器验收备忘：时间、分页与持久化');
  await page.locator('#note-form button[type=submit]').click();
  await expect(page.locator('.note-content')).toContainText('浏览器验收备忘');
  for (let i = 0; i < 11; i++) {
    const response = await page.request.post(`${url}/api/notes`, { headers: { 'X-CSRF-Token': session.csrfToken }, data: { text: `分页验收 ${i}` } });
    assert.equal(response.status(), 201);
  }
  await page.locator('.nav-item[data-tab="market"]').click();
  await page.locator('.nav-item[data-tab="notes"]').click();
  await expect(page.locator('#note-next')).toBeEnabled();
  await page.locator('#note-next').click();
  await expect(page.locator('.pager')).toContainText('第 2 / 2 页');
  await expect(page.locator('.note-content').last()).toContainText('浏览器验收备忘');
  console.log('PASS memo save timestamps and pagination');
  await page.locator('.nav-item[data-tab="bridge"]').click();
  await page.locator('#bridge-amount').fill('2');
  await page.locator('#bridge-form button[type=submit]').click();
  await expect(page.locator('#bridge-execute')).toBeEnabled();
  await page.locator('#bridge-execute').click();
  await expect.poll(async () => (await getState()).stats.completed, { timeout: 10000 }).toBe(2);
  assert.equal((await getState()).stats.executions, 1);
  console.log('PASS bridge quote, execution and independent arbitrage counters');
  await page.locator('.nav-item[data-tab="trades"]').click();
  await expect(page.locator('table tbody tr')).toHaveCount(3);
  await page.locator('[data-trade-id]').first().click();
  await expect(page.locator('.record-json')).toContainText('CONFIRMED');
  await page.locator('#dialog-close').click();
  console.log('PASS archive detail with raw receipts');
  const config = structuredClone((await getState()).config);
  config.risk.maxExecutions = 2; config.risk.maxCumulativeUsd = 10; config.pollIntervalMs = 1000;
  await post('/api/config', { config });
  await post('/api/engine/start', {});
  await expect.poll(async () => (await getState()).stats.executions, { timeout: 10000 }).toBe(2);
  await expect.poll(async () => (await getState()).engine.busy, { timeout: 10000 }).toBe(false);
  await post('/api/engine/pause', {});
  assert((await getState()).opportunity.reasons.some(reason => /上限/.test(reason)));
  console.log('PASS automatic polling executes and stops triggering at cap');
  for (const tab of ['settings', 'bridge', 'trades', 'notes', 'market']) {
    await page.locator(`.nav-item[data-tab="${tab}"]`).click();
    await expect(page.locator('h1')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${tab} mobile overflow`);
    await page.setViewportSize({ width: 1440, height: 1040 });
  }
  if (process.env.SCREENSHOT_DIR) {
    mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'dashboard-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'dashboard-mobile.png'), fullPage: true });
  }
  assert.deepEqual(failures, []);
  console.log('PASS all 5 tabs at 390px, no page or console errors');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
  rmSync(dataDir, { recursive: true, force: true });
}
