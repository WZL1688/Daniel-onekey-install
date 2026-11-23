// Controlled browser fixtures only: no real pool, wallet, signing or trade.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { startLocalServer } from '../src/server.mjs';
const config=structuredClone(DEFAULT_CONFIG), calls=[], forbidden=[], errors=[];
const unexpected=name=>()=>{forbidden.push(name);throw new Error('No execution expected')};
const engine={config,snapshot:()=>({config,market:{},balances:{},opportunity:{},engine:{running:false,busy:false},wallets:{bnb:{mode:'none'},solana:{mode:'none'}},stats:{}}),start:unexpected('start'),execute:unexpected('execute'),pause:unexpected('pause'),saveConfig:unexpected('saveConfig')};
const {server,url}=await startLocalServer({engine,store:{},vault:{publicStatus:()=>({})}});
const now=Date.now(),bnbPool='0x3333333333333333333333333333333333333333',solPool='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const asset=(id,symbol,confirmed=false)=>({id,symbol,name:symbol,source:'coingecko',enabled:true,revision:1,mapping:{confirmed,evidence:confirmed?'Fixture only':''},chains:{bnb:{address:'0x1111111111111111111111111111111111111111',decimals:18,poolAddress:bnbPool},solana:{address:'11111111111111111111111111111112',decimals:6,poolAddress:solPool}}});
const pools={bnb:{priceUsd:.0105,poolAddress:bnbPool,liquidityUsd:1756506.38,observedAt:now,trades1h:30,priceMethod:'provider-base-usd'},solana:{priceUsd:.00000006,poolAddress:solPool,liquidityUsd:3851275.47,observedAt:now,trades1h:102,priceMethod:'derived-from-base-native'}};
const good=asset('coingecko:good-fixture','GOOD'),ant=asset('coingecko:antfun','ANTFUN'),stale=asset('coingecko:stale-quote','STALE',true),unsafe=asset('coingecko:unsafe-link','LINK');
const makeRow=item=>({asset:item,universe:{category:'altcoin',eligible:true,reasons:[],evidence:'directory'},marketQualified:true,opportunityQualified:false,comparisonStatus:'quarantined',anomalous:true,stage:'blocked',reasons:['价差异常过大，须核对池、单位关系和可卖出性'],market:structuredClone(pools),observedAt:now,buyChain:'solana',sellChain:'bnb',spreadBps:1683507894.4,indicativeGrossUsd:841753.9472,evaluation:null,executable:false});
const rows=[makeRow(ant),makeRow(stale),makeRow(unsafe),{...makeRow(good),market:{bnb:{...pools.bnb,priceUsd:.01},solana:{...pools.solana,priceUsd:.0104}},comparisonStatus:'comparable',anomalous:false,spreadBps:400,indicativeGrossUsd:.2,opportunityQualified:true,stage:'needs_mapping',reasons:[]}];
rows[1].executable=true;rows[1].evaluation={executable:true,mode:'demo',assetRevision:1,expiresAt:new Date(now+300000).toISOString(),amountUsd:5,netProfitUsd:841753.9472,gasUsd:.01,slippageUsd:.01};
rows[2].market.solana.poolAddress='javascript:alert(1)';
const fixture={enabled:true,busy:false,assets:rows.map(r=>r.asset),rows,status:'monitoring',reason:'只读扫描',lastError:null,usage:{day:4,total:4},settings:{pollIntervalMs:60000,minLiquidityUsd:20000,minSpreadBps:50,maxSpreadBps:3000,maxAssetsPerScan:30,maxRequestsPerDay:5000,includeStablecoins:false,includeMajors:false,minVolume24hUsd:10000,minVolume1hUsd:100,minTrades1h:3,maxSideSkewMs:30000},counts:{total:4,opportunities:1},scope:{kind:'altcoins',reasonCounts:[{reason:'异常行情已隔离',count:3}]},directory:{status:'ready',source:'coingecko',foundCount:4,sourceAttempts:[]},scanProgress:{totalAssets:4,scannedAssets:4,withBothMarkets:4},execution:{busy:false,running:false,mode:'demo',executionMode:'inventory'}};
let browser;
try{
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1040}});page.on('pageerror',e=>errors.push(e.message));
 page.on('request',req=>{const pathname=new URL(req.url()).pathname;if(req.method()!=='GET'&&pathname.startsWith('/api/'))forbidden.push(req.method()+' '+pathname)});
 await page.route('**/api/opportunities**',route=>{calls.push(route.request().method());return route.fulfill({json:fixture})});
 await page.goto(url);await page.locator('[data-market-view=opportunities]').click();
 const cards=page.locator('#opp-assets article.opp-asset');await expect(cards).toHaveCount(1);await expect(cards).toHaveAttribute('data-asset-id',good.id);await expect(page.locator('#opp-opportunity-count')).toHaveText('1');
 await page.locator('#opp-filter').selectOption('excluded');await expect(cards).toHaveCount(3);
 const antCard=page.locator('[data-asset-id="'+ant.id+'"]');await antCard.locator('details.opp-asset-details > summary').click();
 await expect(antCard).toContainText('停止估算：价格异常，待核对');assert.equal((await antCard.innerText()).includes('$841,753'),false);await expect(antCard.locator('[data-opp-quote]')).toBeDisabled();await expect(antCard.locator('[data-opp-execute]')).toBeDisabled();await expect(antCard.locator('[data-opp-execute]')).toHaveText('异常行情已拦截');await expect(antCard.locator('.opp-compact-spread')).not.toContainText('Solana → BNB');
 await expect(antCard.locator('.opp-pool-trace')).toHaveCount(2);await expect(antCard.locator('.opp-pool-trace')).toContainText([bnbPool,solPool]);
 const links=antCard.locator('.opp-pool-trace a');await expect(links).toHaveCount(2);assert.equal(await links.nth(0).getAttribute('href'),'https://dexscreener.com/bsc/'+bnbPool);assert.equal(await links.nth(1).getAttribute('href'),'https://dexscreener.com/solana/'+solPool);await expect(antCard).toContainText('priceNative');
 const staleCard=page.locator('[data-asset-id="'+stale.id+'"]');await staleCard.locator('details.opp-asset-details > summary').click();await expect(staleCard.locator('[data-opp-execute]')).toBeDisabled();await expect(staleCard.locator('[data-opp-quote]')).toBeDisabled();assert.equal(await staleCard.locator('.opp-evaluation').count(),0);assert.equal((await staleCard.innerText()).includes('$841,753'),false);
 await staleCard.locator('[data-opp-execute]').evaluate(button=>button.click());await staleCard.locator('[data-opp-execute]').dispatchEvent('click');assert.deepEqual(forbidden,[]);
 const disabledColors=await staleCard.locator('[data-opp-execute]').evaluate(button=>({bg:getComputedStyle(button).backgroundColor,opacity:getComputedStyle(button).opacity}));assert.equal(disabledColors.bg,'rgb(23, 32, 43)');assert.equal(disabledColors.opacity,'1');
 const unsafeCard=page.locator('[data-asset-id="'+unsafe.id+'"]');await unsafeCard.locator('details.opp-asset-details > summary').click();await expect(unsafeCard.locator('.opp-pool-trace a')).toHaveCount(1);assert.equal(await page.locator('a[href^="javascript:"]').count(),0);
 console.log('PASS anomalous screenshot values quarantined from default board, no gross-profit estimate, stale valid quote blocked, disabled buttons neutral, safe selected-pool trace');
 // A later partial scan must retain the first anomalous pool only as history.
 rows[0].quarantineEvidence={observedAt:now-60000,market:structuredClone(pools)};
 rows[0].market.solana=null;rows[0].market.bnb.poolAddress='0x4444444444444444444444444444444444444444';
 await page.locator('[data-market-view=arbitrage]').click();await page.locator('[data-market-view=opportunities]').click();await page.locator('#opp-filter').selectOption('excluded');
 const historyCard=page.locator('[data-asset-id="'+ant.id+'"]');await historyCard.locator('details.opp-asset-details > summary').click();
 await expect(historyCard.locator('.opp-pool-trace-historical')).toHaveCount(2);await expect(historyCard.locator('.opp-pool-trace-historical')).toContainText([bnbPool,solPool]);
 await expect(historyCard.locator('.opp-pool-trace-historical').first()).toContainText('首次异常所选池（历史，非当前报价）');await expect(historyCard.locator('.opp-pool-trace-historical').first()).toContainText('异常记录时间');
 await expect(historyCard.locator('.opp-quote-price').nth(1)).toHaveText('未知');await expect(historyCard.locator('.opp-pool-trace:not(.opp-pool-trace-historical)').nth(1)).toContainText('未知');
 await expect(historyCard.locator('.opp-pool-trace:not(.opp-pool-trace-historical)').first()).toContainText('0x4444444444444444444444444444444444444444');
 assert.equal(await historyCard.locator('.opp-pool-trace-historical').nth(1).locator('a').getAttribute('href'),'https://dexscreener.com/solana/'+solPool);
 assert.equal((await historyCard.locator('.opp-pool-trace-historical').allInnerTexts()).some(text=>text.includes('$')),false);await expect(historyCard.locator('[data-opp-execute]')).toBeDisabled();
 console.log('PASS first anomalous pool evidence survives partial/current-pool changes and remains explicitly historical, without backfilling current prices');
 // Old source rows may omit new flags; numeric anomaly fallback still blocks.
 delete rows[1].comparisonStatus;delete rows[1].anomalous;rows[1].opportunityQualified=true;
 await page.locator('[data-market-view=arbitrage]').click();await page.locator('[data-market-view=opportunities]').click();await expect(cards).toHaveCount(1);
 await page.locator('#opp-filter').selectOption('candidate');await expect(cards).toHaveCount(1);await expect(cards).toHaveAttribute('data-asset-id',good.id);
 await page.locator('#opp-filter').selectOption('all');await expect(cards).toHaveCount(4);const fallback=page.locator('[data-asset-id="'+stale.id+'"]');await fallback.locator('details.opp-asset-details > summary').click();await expect(fallback.locator('[data-opp-execute]')).toBeDisabled();assert.equal((await fallback.innerText()).includes('$841,753'),false);
 // Truly legacy snapshots omit universe as well; numeric anomaly fallback still
 // isolates from the default and candidate lists while preserving inspection.
 delete fixture.scope;for(const row of rows)delete row.universe;
 await page.locator('[data-market-view=arbitrage]').click();await page.locator('[data-market-view=opportunities]').click();await expect(cards).toHaveCount(1);await expect(cards).toHaveAttribute('data-asset-id',good.id);
 await page.locator('#opp-filter').selectOption('excluded');await expect(cards).toHaveCount(3);const oldView=page.locator('[data-asset-id="'+stale.id+'"]');await expect(oldView.locator('[data-opp-execute]')).toBeDisabled();assert.equal((await oldView.innerText()).includes('$841,753'),false);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);assert(calls.every(m=>m==='GET'));
 console.log('PASS malformed older snapshots cannot restore anomalous quote actions or numerical earnings; 390px and read-only local behavior');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
