// Local fixture only: no public-chain APIs, wallets, quotes or execution.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { startLocalServer } from '../src/server.mjs';
const engine = { snapshot: () => ({ engine: {} }), config: { mode: 'demo' } };
const { server, url } = await startLocalServer({ engine, store: {}, vault: {} });
const now = Date.now(), errors = [], calls = [], forbidden = [];
const baseRow = (id, patch = {}) => ({
  asset: { id: 'coingecko:' + id, symbol: id.toUpperCase(), name: id + ' fixture', revision: 2, enabled: true, mapping: { confirmed: false, warning: '' } },
  universe: { category: 'altcoin', eligible: true }, marketQualified: true, opportunityQualified: true, comparisonStatus: 'comparable', anomalous: false,
  market: { bnb: { priceUsd: .01, observedAt: now, priceConfidence: 'pool-consensus' }, solana: { priceUsd: .0104, observedAt: now, priceConfidence: 'single-pool' } },
  observedAt: now, generation: 'fixture-generation', buyChain: 'bnb', sellChain: 'solana', spreadBps: 400, executable: false, evaluation: null, ...patch
});
const quote = patch => ({ executable: true, mode: 'demo', assetRevision: 2, quotedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), amountUsd: 5, netProfitUsd: .2, gasUsd: .01, slippageUsd: .03, priceImpactBps: 100, buyChain: 'bnb', sellChain: 'solana', ...patch });
const approvedRow = (id, report = quote()) => { const row = baseRow(id); row.asset.mapping.confirmed = true; row.executable = true; row.evaluation = report; return row; };
const reference = baseRow('reference'); reference.asset.name = '<img src=x onerror="window.injected=true">';
const anomaly = baseRow('anomaly', { anomalous: true, comparisonStatus: 'quarantined', spreadBps: 1683507894, indicativeGrossUsd: 841753.9472, executable: true, evaluation: quote({ netProfitUsd: 841753.9472 }) }); anomaly.asset.mapping.confirmed = true;
const stale = baseRow('stale', { observedAt: now - 121000 }); stale.market.bnb.observedAt = now - 121000;
const conflict = baseRow('conflicting'); conflict.market.solana.priceConfidence = 'conflicting-pools';
const single = baseRow('one-side'); delete single.market.solana;
const duplicate = baseRow('duplicate');
let fixture = { enabled: true, busy: false, status: 'monitoring', lastError: null, updatedAt: now, settings: { minSpreadBps: 50, maxSpreadBps: 3000, maxSideSkewMs: 30000 }, counts: { quarantined: 1 }, rows: [reference, approvedRow('quoted'), anomaly, stale, conflict, single, approvedRow('expired', quote({ expiresAt: new Date(now - 1).toISOString() })), approvedRow('wrong-mode', quote({ mode: 'live' })), approvedRow('wrong-revision', quote({ assetRevision: 1 })), approvedRow('incomplete', quote({ gasUsd: null })), duplicate, structuredClone(duplicate)], execution: { busy: false, running: false, mode: 'demo' } };
let hold = false, delayed;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/') && (path !== '/api/opportunities' || request.method() !== 'GET')) forbidden.push(request.method() + ' ' + path); });
  await page.route('**/board-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="fixture-main"><div id="scanner-board-root"></div></main><script type="module">import {createScannerBoard} from "/scanner-board.js"; window.boardAppState={config:{mode:"demo",risk:{amountUsd:5}},engine:{running:false,busy:false,configuring:false,pausedReason:""},inventoryExecution:{busy:false},features:{opportunities:true}}; window.boardOpens=[];window.boardNotices=[];window.boardApiCalls=0;window.boardSyncFailure=false;const api=(path,options={})=>{window.boardApiCalls++;if(window.boardSyncFailure)throw new Error("secret-error-canary");return fetch(path,{signal:options.signal}).then(async response=>{const body=await response.json();if(!response.ok)throw new Error("secret-error-canary");return body;});};window.board=createScannerBoard({api,getState:()=>window.boardAppState,onOpenAsset:id=>window.boardOpens.push(id),toast:(...args)=>window.boardNotices.push(args)});window.board.mount(document.querySelector("#scanner-board-root"));</script></body></html>' }));
  await page.route('**/api/opportunities', async route => { calls.push({ method: route.request().method(), path: new URL(route.request().url()).pathname }); if (hold) { await new Promise(resolve => { delayed = resolve; }); } await route.fulfill({ json: fixture }).catch(() => {}); });
  await page.goto(url + '/board-test');
  const cards = page.locator('.scanner-board-row'), ids = () => cards.evaluateAll(nodes => nodes.map(node => node.dataset.scannerBoardAsset));
  await expect(page.locator('[data-scanner-board-reference-count]')).toHaveText('6');
  await expect(page.locator('[data-scanner-board-quote-count]')).toHaveText('1');
  await expect(page.locator('[data-scanner-board-quarantine-count]')).toHaveText('1');
  await expect(cards).toHaveCount(6);
  assert.deepEqual(new Set(await ids()), new Set(['coingecko:reference','coingecko:quoted','coingecko:expired','coingecko:wrong-mode','coingecko:wrong-revision','coingecko:incomplete']));
  await expect(cards.first()).toHaveAttribute('data-scanner-board-asset', 'coingecko:quoted');
  await expect(page.locator('.scanner-board')).toContainText('交易模式：模拟');
  await expect(page.locator('.scanner-board')).toContainText('多池价格一致');
  await expect(page.locator('.scanner-board')).toContainText('单池参考');
  await expect(page.locator('[data-scanner-board-asset="coingecko:reference"] .scanner-board-quote')).toContainText('未报价');
  assert.equal(await page.locator('.scanner-board img').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  assert.equal((await page.locator('.scanner-board').textContent()).includes('841,753'), false);
  await page.locator('[data-scanner-board-filter=executable]').click(); await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('$0.20');
  await cards.first().locator('[data-scanner-board-open]').click(); assert.deepEqual(await page.evaluate(() => window.boardOpens), ['coingecko:quoted']);
  assert(calls.every(call => call.method === 'GET'));
  console.log('PASS public reference opportunities appear on dashboard; only current complete matching-mode quotes show money; unsafe/stale/conflicting/duplicate rows excluded');

  const reads = await page.evaluate(() => window.boardApiCalls);
  await page.evaluate(() => { window.boardAppState.engine.pausedReason='Fixture pause';window.board.mount(document.querySelector('#scanner-board-root')); });
  await expect(cards).toHaveCount(0); await expect(page.locator('[data-scanner-board-quote-count]')).toHaveText('0');
  assert.equal(await page.evaluate(() => window.boardApiCalls), reads, 'A global dashboard rerender does not create extra GETs inside polling gap');
  for (const update of [
    { engine: { busy: true, configuring:false, pausedReason:'' } },
    { engine: { busy:false,configuring:true,pausedReason:'' } },
    { engine: { busy:false,configuring:false,pausedReason:'' }, inventoryExecution:{busy:true} },
    { inventoryExecution:{busy:false},config:{mode:'live',risk:{amountUsd:5}} }
  ]) {
    await page.evaluate(update => { Object.assign(window.boardAppState,update);window.board.mount(document.querySelector('#scanner-board-root')); },update);
    await expect(cards).toHaveCount(0);
  }
  await page.evaluate(() => { window.boardAppState.config.mode='demo';window.boardAppState.engine={busy:false,configuring:false,pausedReason:''};window.board.mount(document.querySelector('#scanner-board-root')); });
  await expect(cards).toHaveCount(1);
  fixture.rows.find(row=>row.asset.id==='coingecko:quoted').evaluation.parentPolicyFingerprint='policy-a';
  await page.evaluate(()=>{window.boardAppState.config.executionMode='inventory';window.boardAppState.policyFingerprint='policy-a';return window.board.refresh({force:true});});
  await expect(cards).toHaveCount(1);
  await page.evaluate(()=>{window.boardAppState.policyFingerprint='policy-b';window.board.mount(document.querySelector('#scanner-board-root'));});await expect(cards).toHaveCount(0);
  await page.evaluate(()=>{window.boardAppState.policyFingerprint='policy-a';window.boardAppState.config.executionMode='bridge';window.board.mount(document.querySelector('#scanner-board-root'));});await expect(cards).toHaveCount(0);
  await page.evaluate(()=>{window.boardAppState.config.executionMode='inventory';window.board.mount(document.querySelector('#scanner-board-root'));});await expect(cards).toHaveCount(1);
  fixture.rows.find(row=>row.asset.id==='coingecko:quoted').evaluation.parentRevision=0;
  await page.evaluate(()=>{window.boardAppState.engine.configRevision=0;return window.board.refresh({force:true});});await expect(cards).toHaveCount(1);
  await page.evaluate(()=>{window.boardAppState.engine.configRevision=1;window.board.mount(document.querySelector('#scanner-board-root'));});await expect(cards).toHaveCount(0);
  await page.evaluate(()=>{window.boardAppState.engine.configRevision=0;window.board.mount(document.querySelector('#scanner-board-root'));});await expect(cards).toHaveCount(1);
  console.log('PASS wallet/context revision changes suppress old executable quotes even when mode, signing availability and risk fingerprint stay the same');
  const baselineRows=fixture.rows;
  fixture={...fixture,rows:[approvedRow('live-ready',quote({mode:'live'}))],execution:{...fixture.execution,mode:'live'}};
  await page.evaluate(()=>{window.boardAppState.config.mode='live';window.boardAppState.wallets={bnb:{canSign:false},solana:{canSign:true}};return window.board.refresh({force:true});});await expect(cards).toHaveCount(0);
  await page.evaluate(()=>{window.boardAppState.wallets.bnb.canSign=true;window.board.mount(document.querySelector('#scanner-board-root'));});await expect(cards).toHaveCount(1);
  await page.evaluate(()=>{window.boardAppState.wallets.solana.canSign=false;window.board.mount(document.querySelector('#scanner-board-root'));});await expect(cards).toHaveCount(0);
  fixture={...fixture,rows:baselineRows,execution:{...fixture.execution,mode:'demo'}};
  await page.evaluate(()=>{window.boardAppState.config.mode='demo';return window.board.refresh({force:true});});await expect(cards).toHaveCount(1);
  console.log('PASS paused/configuring/busy engine, inventory job and changed trade mode cannot present old executable quotes');
  console.log('PASS changed risk fingerprint, bridge execution mode and locked/disconnected live wallets suppress stale executable quotes');

  fixture = { ...fixture, status:'error', lastError:'private-rpc-and-secret-error-canary' };
  await page.evaluate(() => window.board.refresh({force:true})); await expect(cards).toHaveCount(0);
  await expect(page.locator('[data-scanner-board-reference-count]')).toHaveText('—');
  await expect(page.locator('.scanner-board-status')).toContainText('未通过');
  assert.equal((await page.locator('.scanner-board').textContent()).includes('secret-error-canary'),false);
  fixture={...fixture,status:'partial',lastError:'directory-auth-fixture'};
  await page.evaluate(() => window.board.refresh({force:true}));await expect(cards).toHaveCount(1);await expect(page.locator('.scanner-board-status')).toContainText('部分来源');
  fixture={...fixture,status:'monitoring',lastError:null,busy:true};await page.evaluate(() => window.board.refresh({force:true}));await expect(cards).toHaveCount(0);
  fixture={...fixture,busy:false};
  await page.evaluate(() => {window.boardSyncFailure=true;return window.board.refresh({force:true});});
  await expect(page.locator('.scanner-board-status')).toContainText('读取失败');await expect(cards).toHaveCount(0);
  await page.evaluate(() => {window.boardSyncFailure=false;return window.board.refresh({force:true});});await expect(cards).toHaveCount(1);
  console.log('PASS source failures, local read errors and in-flight scan state never leave a false executable quote; partial source status remains explicit');

  const beforeUnsupported=await page.evaluate(()=>window.boardApiCalls);
  await page.evaluate(()=>{window.boardAppState.features.opportunities=false;window.board.mount(document.querySelector('#scanner-board-root'));});
  await expect(page.locator('.scanner-board-status')).toContainText('未启用');await expect(cards).toHaveCount(0);
  await page.evaluate(()=>window.board.refresh({force:true}));assert.equal(await page.evaluate(()=>window.boardApiCalls),beforeUnsupported);
  await page.evaluate(()=>{window.boardAppState.features.opportunities=true;window.board.mount(document.querySelector('#scanner-board-root'));});await expect(cards).toHaveCount(1);
  fixture={...fixture,rows:[approvedRow('deadline',quote({expiresAt:new Date(Date.now()+400).toISOString()}))]};
  await page.evaluate(()=>window.board.refresh({force:true}));await expect(cards).toHaveCount(1);const beforeExpiry=await page.evaluate(()=>window.boardApiCalls);
  await expect(cards).toHaveCount(0,{timeout:2000});assert.equal(await page.evaluate(()=>window.boardApiCalls),beforeExpiry,'Expiry display updates without adding network polling');
  await page.locator('[data-scanner-board-filter=reference]').click();await expect(cards).toHaveCount(1);await expect(cards.first().locator('.scanner-board-quote')).toContainText('未报价');
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  console.log('PASS feature-unavailable fallback makes no unsupported requests, quote expiry updates locally and dashboard layout fits390px');

  hold=true;await page.evaluate(()=>{window.delayedBoardRead=window.board.refresh({force:true});});await expect.poll(()=>Boolean(delayed)).toBe(true);
  await page.evaluate(()=>{window.board.unmount();document.querySelector('#fixture-main').innerHTML='<h1 id="other-view">Another view</h1>';});
  fixture={...fixture,rows:[baseRow('late-poison')]};delayed();await page.waitForTimeout(100);
  await expect(page.locator('#other-view')).toHaveText('Another view');assert.equal(await page.locator('.scanner-board').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
  console.log('PASS late responses cannot restore an unmounted board; every network operation is read-only and no wallet/configuration/quote/execution request occurs');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
