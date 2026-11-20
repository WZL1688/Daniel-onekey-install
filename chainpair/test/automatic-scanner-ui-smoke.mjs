// Local browser fixtures only. No external API, wallet or signing request.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';

const config = structuredClone(DEFAULT_CONFIG), calls = [], errors = [], forbidden = [];
const unexpected = name => () => { forbidden.push(name); throw new Error('No trading action is expected'); };
const engine = { config, snapshot: () => ({ config, market: {}, balances: {}, opportunity: {}, engine: { running: false, busy: false }, wallets: { bnb: { mode: 'none' }, solana: { mode: 'none' } }, stats: {} }), start: unexpected('start'), execute: unexpected('execute'), pause: unexpected('pause'), saveConfig: unexpected('saveConfig') };
const { server, url } = await startLocalServer({ engine, store: {}, vault: { publicStatus: () => ({}) } });
const now = Date.now(), message = 'CoinGecko 网络连接失败，已安排自动重试 <img src=x onerror="window.injection=true">';
const snapshot = { enabled: true, autoScanPreferred: true, busy: false, settings: { pollIntervalMs: 60000, minLiquidityUsd: 20000, minSpreadBps: 50, maxAssetsPerScan: 30, maxRequestsPerDay: 5000 }, assets: [], rows: [], status: 'error', reason: message, lastError: message, notice: '空目录不会要求人工添加；按重试时间继续自动发现', usage: { day: 1, total: 1 }, updatedAt: null, directoryUpdatedAt: null, nextRequestAt: now + 60000,
  directory: { status: 'retrying', lastAttemptAt: now, nextAttemptAt: now + 60000, source: 'coingecko', foundCount: 0, errorCode: 'DISCOVERY_NETWORK', errorMessage: message, sourceAttempts: [{ source: 'coingecko', status: 'failed', errorCode: 'DISCOVERY_NETWORK', message, nextAttemptAt: now + 60000 }] },
  credentials: { configured: false, locked: false }, scanProgress: { totalAssets: 0, scannedAssets: 0, withBothMarkets: 0, opportunities: 0 }, execution: { busy: false, running: false, mode: 'demo', executionMode: 'bridge', lastError: '' } };
let browser, recover = false, failRead = false, failCredentials = false, releaseCredential;
const secret = 'fixture-CG-key-not-a-real-account', password = 'fixture-vault-password-123';
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/opportunities**', async route => {
    const request = route.request(), method = request.method(), pathname = new URL(request.url()).pathname;
    const body = method === 'GET' || method === 'DELETE' ? null : request.postDataJSON(); calls.push({ method, pathname, body });
    if (method === 'GET') return route.fulfill({ status: failRead ? 500 : 200, json: failRead ? { error: '本机状态读取失败测试' } : snapshot });
    if (pathname.endsWith('/credentials')) {
      if (method === 'DELETE') { snapshot.credentials = { configured: false, locked: false }; return route.fulfill({ json: { configured: false } }); }
      assert.equal(body.apiKey, secret); assert.equal(body.password, password);
      if (failCredentials) return route.fulfill({ status: 400, json: { error: '本机保险库密码不正确' } });
      await new Promise(resolve => { releaseCredential = resolve; });
      snapshot.credentials = { configured: true, locked: true }; return route.fulfill({ json: { configured: true } });
    }
    if (recover && pathname.endsWith('/scan')) {
      const asset = { id: 'wormhole:fixture-origin', source: 'wormhole', sourceKind: 'bundled', sourceDate: '2026-04-08', name: 'Official origin mapping fixture', symbol: 'WRAPPED', enabled: true, revision: 1, mapping: { confirmed: false, evidence: '' }, chains: { bnb: { address: '0x1111111111111111111111111111111111111111', decimals: null, poolAddress: '' }, solana: { address: 'So11111111111111111111111111111111111111112', decimals: null, poolAddress: '' } } };
      snapshot.assets = [asset]; snapshot.rows = [{ asset, stage: 'needs_mapping', reasons: ['同币、精度与交易池待核验'], observedAt: Date.now(), buyChain: 'bnb', sellChain: 'solana', spreadBps: 1000, indicativeGrossUsd: .5, evaluation: null, market: { bnb: { priceUsd: .01, liquidityUsd: 100000, observedAt: Date.now() }, solana: { priceUsd: .011, liquidityUsd: 100000, observedAt: Date.now() } } }];
      Object.assign(snapshot, { status: 'monitoring', reason: '自动发现与两链池扫描已完成一轮', lastError: null, notice: '使用内置官方映射候选；不会自动批准交易', updatedAt: Date.now(), directoryUpdatedAt: Date.now(), scanProgress: { totalAssets: 1, scannedAssets: 1, withBothMarkets: 1, opportunities: 0 } });
      snapshot.directory = { status: 'ready', source: 'bundled-wormhole', sourceDate: '2026-04-08', foundCount: 1, nextAttemptAt: now + 3600000, sourceAttempts: [{ source: 'coingecko', status: 'failed', message: '原始目录暂不可达' }, { source: 'bundled-wormhole', status: 'ready', foundCount: 1 }] };
    }
    return route.fulfill({ json: snapshot });
  });
  await page.goto(url); await expect(page.locator('h1')).toHaveText('双链行情工作台');
  await page.locator('[data-market-view=opportunities]').click(); await expect(page.locator('h1')).toHaveText('同币机会扫描');
  await expect(page.locator('.nav-item')).toHaveCount(5);
  await expect(page.locator('#opp-error')).toBeVisible(); await expect(page.locator('#opp-error')).toContainText('网络连接失败');
  await expect(page.locator('#opp-directory-status')).toHaveText('等待自动重试'); await expect(page.locator('#opp-directory-count')).toHaveText('0');
  await expect(page.locator('#opp-notice')).toContainText('不会要求人工添加'); await expect(page.locator('#opp-assets')).toContainText('无需先手工填写合约地址');
  assert.equal(await page.locator('#opportunities-view img').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.injection)), false);
  await expect(page.locator('#opp-add')).not.toBeVisible(); await expect(page.locator('#opp-enable')).toHaveText('停止自动扫描');
  await page.locator('#opp-scan').click(); await expect(page.locator('.toast.error')).toContainText('网络连接失败');
  assert.equal(await page.locator('.toast:not(.error)').count(), 0, 'HTTP200 failed snapshot must not claim a successful scan');
  recover = true; await page.locator('#opp-scan').click();
  await expect(page.locator('#opp-error')).not.toBeVisible(); await expect(page.locator('#opp-assets article')).toHaveCount(1);
  await expect(page.locator('#opp-directory-source')).toContainText('内置官方映射快照（2026-04-08）');
  await expect(page.locator('#opp-scan-progress')).toContainText('已扫描 1 / 1 项');
  await expect(page.locator('#opp-source-attempts')).toContainText('内置官方映射快照');
  await expect(page.locator('[data-opp-quote]')).toBeDisabled(); await expect(page.locator('[data-opp-execute]')).toBeDisabled();
  await expect(page.locator('#opp-assets')).toContainText('可赎回风险尚未核验');
  await page.locator('#opp-filter').selectOption('candidate');
  await expect(page.locator('#opp-assets article'), 'reference opportunities are visible before trading approval').toHaveCount(1);
  await expect(page.locator('[data-opp-execute]')).toBeDisabled();
  await page.locator('#opp-filter').selectOption('approved'); await expect(page.locator('#opp-assets article')).toHaveCount(0);
  await page.locator('#opp-filter').selectOption('all');
  console.log('PASS empty automatic discovery errors, truthful HTTP200 outcomes, retries, progress and unapproved official fallback');

  await page.locator('.opp-source-config summary').click();
  await page.locator('#opp-credentials [name=apiKey]').fill(secret); await page.locator('#opp-credentials [name=password]').fill(password);
  await page.locator('#opp-credentials button[type=submit]').click();
  await expect(page.locator('#opp-credentials [name=apiKey]')).toHaveValue(''); await expect(page.locator('#opp-credentials [name=password]')).toHaveValue('');
  await expect.poll(() => Boolean(releaseCredential)).toBe(true); releaseCredential(); releaseCredential = null;
  await expect(page.locator('#opp-key-status')).toContainText('保险库仍锁定'); await expect(page.locator('#opp-clear-key')).toBeDisabled();
  failCredentials = true;
  await page.locator('#opp-credentials [name=apiKey]').fill(secret); await page.locator('#opp-credentials [name=password]').fill(password);
  await page.locator('#opp-credentials button[type=submit]').click();
  await expect(page.locator('#opp-credentials [name=apiKey]')).toHaveValue(''); await expect(page.locator('#opp-error')).toContainText('密码不正确');
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(stored.includes(secret), false); assert.equal(stored.includes(password), false);
  failRead = true; await page.locator('#opp-scan').click();
  await expect(page.locator('#opp-reason')).toContainText('本机扫描状态读取失败');
  await page.waitForTimeout(100); await expect(page.locator('#opp-reason')).toContainText('本机扫描状态读取失败');
  failRead = false; await page.locator('#opp-scan').click(); await expect(page.locator('#opp-reason')).toHaveText(snapshot.reason);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(calls.some(call => /\/(?:assets|approve|quote|execute|automation)$/.test(call.pathname)), false);
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  console.log('PASS optional credentials clear on success/failure, preserve locked state, persistent local read errors and 390px layout');
} finally { releaseCredential?.(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
