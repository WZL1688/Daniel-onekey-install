// Browser fixtures only: network settings and public diagnostics never call a
// real market API, import a wallet, request a signature, or execute a trade.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';

const config = structuredClone(DEFAULT_CONFIG), calls = [], errors = [], forbidden = [];
const unexpected = name => () => { forbidden.push(name); throw new Error('Only public market-network actions are expected'); };
const engine = { config, snapshot: () => ({ config, market: {}, balances: {}, opportunity: {}, engine: { running: false, busy: false }, wallets: { bnb: { mode: 'none' }, solana: { mode: 'none' } }, stats: {} }), start: unexpected('start'), execute: unexpected('execute'), pause: unexpected('pause'), saveConfig: unexpected('saveConfig') };
const { server, url } = await startLocalServer({ engine, store: {}, vault: { publicStatus: () => ({}) } });
const now = Date.now(), secret = 'fixture-hidden-proxy-password', hiddenUrl = `http://user:${secret}@hidden-proxy.invalid:9999`, address = '0x1111111111111111111111111111111111111111';
const snapshot = {
  enabled: true, autoScanPreferred: true, busy: false,
  settings: { pollIntervalMs: 60000, minLiquidityUsd: 20000, minSpreadBps: 50, maxAssetsPerScan: 30, maxRequestsPerDay: 5000 },
  assets: [], rows: [], status: 'error', reason: '两链交易池行情网络连接失败', lastError: '两链交易池行情网络连接失败', notice: '',
  usage: { day: 1, total: 1 }, updatedAt: null, directoryUpdatedAt: null, nextRequestAt: now + 60000,
  directory: { status: 'ready', source: 'bundled-wormhole', sourceDate: '2026-04-08', foundCount: 32, sourceAttempts: [] },
  credentials: { configured: false, locked: false }, scanProgress: { totalAssets: 32, scannedAssets: 0, withBothMarkets: 0, opportunities: 0 },
  execution: { busy: false, running: false, mode: 'demo', executionMode: 'bridge', lastError: '' },
  network: { mode: 'auto', proxyUrl: '', effectiveRoute: 'env', proxyDetected: true, routeLabel: '环境代理（尚未验证连接）', diagnostics: [], testing: false, lastTestAt: null, nextTestAt: null, reason: '检测到代理配置；尚未进行连接测试', proxyEnvUrl: hiddenUrl, walletAddress: address }
};
const diagnostics = [
  { source: 'bnb-pools', status: 'ok', httpStatus: 200, errorCode: null, networkReason: null, message: '已读取 BNB 公开交易池', records: 2, checkedAt: now },
  { source: 'solana-pools', status: 'error', httpStatus: null, errorCode: 'DISCOVERY_NETWORK', networkReason: 'DNS', message: 'DNS 解析失败 <img src=x onerror="window.networkInjection=true">', records: null, checkedAt: now },
  { source: 'coingecko-directory', status: 'auth_required', httpStatus: 403, errorCode: 'DISCOVERY_AUTH_REQUIRED', networkReason: null, message: '公共目录需要有效的数据 Key', records: null, checkedAt: now }
];
let browser, releaseTest, holdTest = false;
const networkPosts = () => calls.filter(call => call.method === 'POST' && call.pathname === '/api/opportunities/network');
const reads = () => calls.filter(call => call.method === 'GET' && call.pathname === '/api/opportunities').length;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (/^\/api\/(?:engine(?:\/|$)|config(?:\/|$)|wallet(?:s)?(?:\/|$))/.test(pathname) || /^\/api\/opportunities\/(?:execute|automation|quote|approve)$/.test(pathname)) forbidden.push(`${request.method()} ${pathname}`);
  });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedNetworkSummary = value; } } }); });
  await page.route('**/api/opportunities**', async route => {
    const request = route.request(), method = request.method(), pathname = new URL(request.url()).pathname;
    const body = method === 'GET' || method === 'DELETE' ? null : request.postDataJSON(); calls.push({ method, pathname, body });
    if (method === 'GET') return route.fulfill({ json: snapshot });
    if (pathname === '/api/opportunities/network') {
      assert.deepEqual(Object.keys(body).sort(), ['mode', 'proxyUrl']);
      snapshot.network = { ...snapshot.network, mode: body.mode, proxyUrl: body.proxyUrl, effectiveRoute: body.mode === 'proxy' ? 'manual' : body.mode === 'direct' ? 'direct' : 'env', routeLabel: body.mode === 'proxy' ? '手动本机 HTTP 代理（尚未验证）' : body.mode === 'direct' ? '直连（尚未验证）' : '环境代理（尚未验证）', diagnostics: [], testing: false, lastTestAt: null, reason: '设置已保存；尚未进行连接测试' };
      return route.fulfill({ json: snapshot });
    }
    if (pathname === '/api/opportunities/network/test') {
      assert.deepEqual(body, {}); snapshot.network.testing = true;
      if (holdTest) await new Promise(resolve => { releaseTest = resolve; });
      snapshot.network = { ...snapshot.network, diagnostics, testing: false, lastTestAt: Date.now(), nextTestAt: null, reason: 'BNB 连接通过；Solana DNS 解析失败；CoinGecko HTTP 403' };
      return route.fulfill({ json: snapshot });
    }
    throw new Error(`Unexpected opportunity action: ${method} ${pathname}`);
  });
  await page.goto(url); await expect(page.locator('h1')).toHaveText('双链行情工作台');
  await page.locator('[data-market-view=opportunities]').click(); await expect(page.locator('h1')).toHaveText('同币机会扫描');
  await expect(page.locator('.nav-item')).toHaveCount(5);
  const panel = page.locator('details.opp-network-config');
  if (!(await panel.evaluate(node => node.open))) await panel.locator('summary').click();
  const mode = page.locator('#opp-network-form select[name=mode]'), proxy = page.locator('#opp-network-form input[name=proxyUrl]');
  await expect(mode).toHaveValue('auto'); await expect(page.locator('#opp-network-route')).toContainText('尚未验证');
  await expect(page.locator('#opp-network-reason')).toContainText('尚未进行连接测试');
  await expect(page.locator('#opp-network-test')).toBeVisible();
  await mode.selectOption('proxy');
  for (const invalid of ['socks5://127.0.0.1:7891', 'http://proxy.example:7891', 'http://user:pass@127.0.0.1:7891', 'http://127.0.0.1']) {
    await proxy.fill(invalid); await page.locator('#opp-network-save').click();
    assert.equal(networkPosts().length, 0, `Invalid proxy must be rejected locally: ${invalid}`);
  }
  await proxy.fill('http://127.0.0.1:7891'); await page.locator('#opp-network-save').click();
  await expect.poll(() => networkPosts().length).toBe(1);
  assert.deepEqual(networkPosts()[0].body, { mode: 'proxy', proxyUrl: 'http://127.0.0.1:7891' });
  await expect(proxy).toHaveValue('http://127.0.0.1:7891');
  await proxy.fill('http://127.0.0.1:7892'); const beforePoll = reads();
  await expect.poll(reads, { timeout: 16000, intervals: [500] }).toBeGreaterThan(beforePoll);
  await expect(proxy).toHaveValue('http://127.0.0.1:7892');
  assert.equal(networkPosts().length, 1, 'Typing does not save or replace the owner-provided proxy port');
  await proxy.fill('http://127.0.0.1:7891');
  console.log('PASS automatic mode stays unverified, local-only HTTP proxy validation, exact custom port and unsaved draft across polling');

  await page.locator('#opp-network-test').click();
  const results = page.locator('#opp-network-results');
  await expect(results).toContainText('BNB'); await expect(results).toContainText('Solana');
  await expect(results).toContainText('200'); await expect(results).toContainText('403'); await expect(results).toContainText('DNS');
  await expect(results).toContainText('解析失败'); await expect(results).toContainText('Key');
  await expect(results).toContainText('2026');
  assert.equal(await results.locator('img').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.networkInjection)), false);
  await page.locator('#opp-network-copy').click();
  const copied = await page.evaluate(() => window.copiedNetworkSummary);
  assert.equal(typeof copied, 'string'); assert.match(copied, /BNB/); assert.match(copied, /Solana/); assert.match(copied, /200/); assert.match(copied, /DNS/);
  assert.equal(copied.includes(secret), false); assert.equal(copied.includes(hiddenUrl), false); assert.equal(copied.includes(address), false); assert.equal(copied.includes('hidden-proxy.invalid'), false);
  assert.equal(await page.locator('#opportunities-view').textContent().then(value => value.includes(hiddenUrl)), false);
  assert.equal(await results.textContent().then(value => /\$0\.0/.test(value)), false, 'A failed pool lookup is never displayed as a zero price');
  console.log('PASS per-chain HTTP and DNS diagnostics, escaped provider text and safe copy summary');

  holdTest = true; await page.locator('#opp-network-test').click(); await expect.poll(() => Boolean(releaseTest)).toBe(true);
  await expect(page.locator('#opp-network-test')).toBeDisabled();
  await page.locator('[data-tab=settings]').click(); await expect(page.locator('h1')).toHaveText('设置与钱包');
  releaseTest(); releaseTest = null; await page.waitForTimeout(150);
  await expect(page.locator('h1')).toHaveText('设置与钱包');
  await page.locator('[data-tab=market]').click(); await expect(page.locator('h1')).toHaveText('同币机会扫描');
  if (!(await panel.evaluate(node => node.open))) await panel.locator('summary').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Network diagnostics fit a 390px viewport');
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  assert.equal(calls.filter(call => call.method !== 'GET').every(call => ['/api/opportunities/network', '/api/opportunities/network/test'].includes(call.pathname)), true);
  console.log('PASS late diagnostic responses stay in their view, 390px layout, and no wallet, engine or execution actions');
} finally { releaseTest?.(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
