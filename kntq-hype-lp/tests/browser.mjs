/** Controlled browser integration QA. Every chain/market response and wallet is
 * a synthetic TEST FIXTURE; this script never connects to or writes mainnet.
 * Requires the existing local dev server at http://127.0.0.1:5173.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { parseAbi, decodeFunctionData, encodeFunctionResult, toHex, zeroAddress } from 'viem';

const BASE = process.env.LP_TEST_URL || 'http://127.0.0.1:5173';
const QA_OUTPUT = process.env.QA_OUTPUT_DIR ? resolve(process.env.QA_OUTPUT_DIR) : fileURLToPath(new URL('../work/qa/', import.meta.url));
await mkdir(QA_OUTPUT, { recursive: true });
const ACCOUNT = '0x1234567890123456789012345678901234567890';
const K = '0x000000000000780555bD0BCA3791f89f9542c2d6';
const W = '0x5555555555555555555555555555555555555555';
const F = '0xf0db7b58379503491d857dB50AC9ece64c653918';
const M = '0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377';
const P = '0x1111111111111111111111111111111111111111';
const H = '0x' + 'ab'.repeat(32);
const ABI = parseAbi([
 'function symbol() view returns(string)', 'function decimals() view returns(uint8)',
 'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
 'function factory() view returns(address)', 'function WETH9() view returns(address)',
 'function getPool(address,address,uint24) view returns(address)', 'function feeAmountTickSpacing(uint24) view returns(int24)',
 'function token0() view returns(address)', 'function token1() view returns(address)', 'function fee() view returns(uint24)',
 'function tickSpacing() view returns(int24)', 'function liquidity() view returns(uint128)',
 'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)',
 'function feeGrowthGlobal0X128() view returns(uint256)', 'function feeGrowthGlobal1X128() view returns(uint256)',
 'function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)',
 'function tokenOfOwnerByIndex(address,uint256) view returns(uint256)',
 'function ownerOf(uint256) view returns(address)',
 'function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
 'function multicall(bytes[] data) payable returns(bytes[] results)',
 'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns(uint256,uint256)',
]);
const positions = new Map([
 [101n,[0n,zeroAddress,K,W,3000,-600,600,10n**22n,0n,0n,2n*10n**18n,3n*10n**18n]],
 [102n,[0n,zeroAddress,K,W,3000,-1200,1200,2n*10n**22n,0n,0n,5n*10n**18n,6n*10n**18n]],
 [103n,[0n,zeroAddress,K,W,3000,-1800,1800,3n*10n**22n,0n,0n,8n*10n**18n,9n*10n**18n]],
 [104n,[0n,zeroAddress,K,W,3000,-600,600,0n,0n,0n,0n,0n]],
 [105n,[0n,zeroAddress,K,W,3000,-600,600,0n,0n,0n,1n*10n**18n,0n]],
]);
const ids = [...positions.keys()];
const trace=[]; const sends=[]; const errors=[]; let stale=false; let activeHash;
function encoded(name,result){return encodeFunctionResult({abi:ABI,functionName:name,result});}
function contract(to,data){
 const {functionName:name,args=[]}=decodeFunctionData({abi:ABI,data});
 const token=to.toLowerCase();
 let result;
 switch(name){
  case 'symbol':result=token===K.toLowerCase()?'KNTQ':'WHYPE';break;
  case 'decimals':result=18;break;
  case 'balanceOf':result=token===M.toLowerCase()?BigInt(ids.length):token===K.toLowerCase()?10000n*10n**18n:1000n*10n**18n;break;
  case 'allowance':result=0n;break;
  case 'factory':result=F;break;
  case 'WETH9':result=W;break;
  case 'getPool':result=P;break;
  case 'feeAmountTickSpacing':result=60;break;
  case 'token0':result=K;break;
  case 'token1':result=W;break;
  case 'fee':result=3000;break;
  case 'tickSpacing':result=60;break;
  case 'liquidity':result=10n**25n;break;
  case 'slot0':result=[1n<<96n,0,0,1,1,0,true];break;
  case 'feeGrowthGlobal0X128':case 'feeGrowthGlobal1X128':result=0n;break;
  case 'ticks':result=[10n**25n,0n,0n,0n,0n,0n,0,true];break;
  case 'tokenOfOwnerByIndex':result=ids[Number(args[1])];break;
  case 'ownerOf':result=ACCOUNT;break;
  case 'positions':result=positions.get(args[0]);break;
  case 'multicall':result=args[0].map(call=>contract(to,call));break;
  case 'collect':result=[2n*10n**18n,3n*10n**18n];break;
  default:throw new Error('Unhandled function '+name);
 }
 return encoded(name,result);
}
function block(){return {number:'0x123456',hash:H,parentHash:'0x'+'cd'.repeat(32),timestamp:toHex(BigInt(Math.floor(Date.now()/1000)-(stale?500:0))),gasLimit:'0x1c9c380',gasUsed:'0x0',baseFeePerGas:'0x3b9aca00',miner:zeroAddress,difficulty:'0x0',extraData:'0x',size:'0x1',transactions:[],uncles:[],logsBloom:'0x'+'00'.repeat(256),transactionsRoot:H,stateRoot:H,receiptsRoot:H,nonce:'0x0000000000000000',sha3Uncles:H,mixHash:H};}
async function installRoutes(context){
 await context.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,contentType:'text/css',body:''}));
 await context.route('https://api.hyperliquid.xyz/info',r=>r.fulfill({json:{HYPE:'32.5'}}));
 for(const host of ['rpc.hyperliquid.xyz','hyperliquid-json-rpc.stakely.io'])await context.route('https://'+host+'/**',async route=>{
  const req=route.request().postDataJSON(); let result;
  trace.push({method:req.method,params:req.params,at:Date.now()});
  try{
   switch(req.method){
    case 'eth_chainId':result='0x3e7';break;
    case 'eth_getBlockByNumber':case 'eth_getBlockByHash':result=block();break;
    case 'eth_blockNumber':result='0x123456';break;
    case 'eth_getCode':result='0x6001600055';break;
    case 'eth_getBalance':result=toHex(1000n*10n**18n);break;
    case 'eth_call':result=contract(req.params[0].to,req.params[0].data);break;
    case 'eth_estimateGas':result=toHex(100000n);break;
    case 'eth_gasPrice':result=toHex(1000000000n);break;
    case 'eth_getTransactionReceipt':result={transactionHash:req.params[0],transactionIndex:'0x0',blockHash:H,blockNumber:'0x123456',from:ACCOUNT,to:M,cumulativeGasUsed:'0x186a0',gasUsed:'0x186a0',contractAddress:null,logs:[],logsBloom:'0x'+'00'.repeat(256),status:'0x1',effectiveGasPrice:'0x3b9aca00',type:'0x0'};break;
    case 'eth_getTransactionByHash':{const tx=sends.find(x=>x.hash===req.params[0]);result={hash:req.params[0],nonce:'0x0',blockHash:H,blockNumber:'0x123456',transactionIndex:'0x0',from:ACCOUNT,to:tx?.to||M,value:tx?.value||'0x0',input:tx?.data||'0x',gas:'0x1d4c0',gasPrice:'0x3b9aca00',type:'0x0',chainId:'0x3e7',v:'0x1b',r:H,s:H};break;}
    default:throw new Error('Unhandled RPC '+req.method);
   }
   await route.fulfill({json:{jsonrpc:'2.0',id:req.id,result}});
  }catch(error){errors.push(String(error));await route.fulfill({json:{jsonrpc:'2.0',id:req.id,error:{code:-32000,message:String(error)}}});}
 });
}
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),headless:true,args:['--no-sandbox']});
try{
 const empty=await browser.newContext({viewport:{width:1440,height:1000}});await installRoutes(empty);const emptyPage=await empty.newPage();
 emptyPage.on('pageerror',e=>errors.push('pageerror '+e.message));emptyPage.on('console',entry=>{if(entry.type()==='error')errors.push('console '+entry.text());});
 await emptyPage.goto(BASE);await emptyPage.getByRole('button',{name:'连接钱包',exact:true}).first().click();
 await emptyPage.getByText('尚未检测到浏览器钱包').waitFor();await emptyPage.getByRole('button',{name:'关闭对话框'}).click();
 assert.equal(await emptyPage.locator('.position-card').count(),0);await empty.close();
 const context=await browser.newContext({viewport:{width:1500,height:1100},deviceScaleFactor:1});await installRoutes(context);
 await context.exposeBinding('__recordSend',async(_,tx,reject)=>{trace.push({method:'wallet_send',at:Date.now(),tx});if(reject)throw new Error('TEST user rejected');const hash='0x'+(sends.length+1).toString(16).padStart(64,'0');sends.push({...tx,hash});activeHash=hash;return hash;});
 await context.addInitScript(({account})=>{
  const listeners={};window.__rejectSend=false;window.__sendAttempts=0;
  // Explicit synthetic 10-minute observation fixtures for UI metric QA only.
  for(const [id,kntq,whype,liquidity] of [[101,2,3,'10000000000000000000000'],[102,5,6,'20000000000000000000000'],[103,8,9,'30000000000000000000000']]){
   localStorage.setItem(`kntq-lp:fees:v1:999:0x39654a85a4c05127f5fd6ed22caec077a0fb1377:${account.toLowerCase()}:${id}`,JSON.stringify([{at:Date.now()-600000,kntq:kntq-.01,whype:whype-.01,liquidity}]));
  }
  const provider={isMetaMask:true,on(event,fn){(listeners[event]??=[]).push(fn);},removeListener(event,fn){listeners[event]=(listeners[event]||[]).filter(f=>f!==fn);},async request({method,params}){
   if(method==='eth_accounts'||method==='eth_requestAccounts')return[account];if(method==='eth_chainId')return'0x3e7';
   if(method==='wallet_switchEthereumChain'||method==='wallet_addEthereumChain')return null;
   if(method==='eth_sendTransaction'){window.__sendAttempts++;return await window.__recordSend(params[0],window.__rejectSend);}throw new Error('Unhandled wallet '+method);
  }};
  window.ethereum=provider;window.__emitWallet=(event)=>{for(const fn of listeners[event]||[])fn();};
 },{account:ACCOUNT});
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push('pageerror '+e.message));page.on('console',entry=>{if(entry.type()==='error')errors.push('console '+entry.text());});
 await page.goto(BASE);await page.getByRole('button',{name:'连接钱包',exact:true}).first().click();await page.getByRole('button',{name:'MetaMask',exact:true}).click();
 await page.locator('.position-card').first().waitFor();assert.equal(await page.locator('.position-card').count(),4,'fully empty hidden, owed retained');
 assert.equal(await page.locator('.position-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),3,'desktop three columns');
 assert.equal(await page.locator('.position-card').first().innerText().then(t=>t.includes('#103')),true,'principal sort descending');
 await page.getByLabel('持仓排序').selectOption('newest');assert.ok((await page.locator('.position-card').first().innerText()).includes('#105'),'newest ordering');
 await page.getByLabel('隐藏空仓 (1)').uncheck();assert.equal(await page.locator('.position-card').count(),5);await page.getByLabel('隐藏空仓 (1)').check();
 await page.getByLabel('持仓排序').selectOption('value');
 // Exercise invalid RPC setting without allowing an invalid setting into live state.
 await page.getByRole('button',{name:'连接与设置',exact:true}).click();await page.locator('textarea').fill('http://example.com');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByRole('status').filter({hasText:'有效的 HTTPS RPC'}).waitFor();assert.equal(await page.getByRole('dialog').count(),1);await page.getByRole('button',{name:'关闭对话框'}).click();
 assert.ok((await page.locator('.position-card').first().locator('.apr strong').innerText()).includes('%'),'real observation fixture computes APR');const beforeEstimate=await page.locator('.position-card').first().locator('.second-estimate strong').innerText();await page.waitForTimeout(1200);assert.notEqual(await page.locator('.position-card').first().locator('.second-estimate strong').innerText(),beforeEstimate,'second estimate advances from measured fee rate');await page.getByRole('status').waitFor({state:'hidden'});await page.evaluate(()=>{const badge=document.createElement('div');badge.textContent='TEST FIXTURE · 受控测试数据';badge.style.cssText='position:fixed;right:8px;bottom:6px;z-index:9999;pointer-events:none;background:#15251dd9;color:#d5e6c2;padding:5px 8px;border-radius:4px;font:9px sans-serif;letter-spacing:1px';document.body.append(badge);});await page.screenshot({path:join(QA_OUTPUT,'qa-desktop.png'),fullPage:true});
 const firstCard=page.locator('.position-card').first();await firstCard.getByRole('button',{name:'领取手续费',exact:true}).click();await page.getByText('首步骤模拟通过',{exact:true}).waitFor();
 assert.equal(sends.length,0,'preview does not sign or send');await page.getByRole('checkbox').last().check();await page.getByRole('button',{name:'确认预算并执行',exact:true}).click();
 await page.getByText('所有步骤已获链上确认',{exact:true}).waitFor();assert.equal(sends.length,1,'collect sent once');
 const sendIndex=trace.findIndex(x=>x.method==='wallet_send');assert.ok(trace.slice(0,sendIndex).some(x=>x.method==='eth_call'&&x.params[0].data===sends[0].data));assert.ok(trace.slice(0,sendIndex).some(x=>x.method==='eth_estimateGas'&&x.params[0].data===sends[0].data));
 await page.waitForFunction(()=>!document.querySelector('.position-card .collect-button')?.disabled);await page.getByRole('button',{name:'返回持仓',exact:true}).click();
 // A user rejection ends this plan; it must never be sent again automatically.
 await page.evaluate(()=>{window.__rejectSend=true;});await firstCard.getByRole('button',{name:'领取手续费',exact:true}).click();await page.getByText('首步骤模拟通过',{exact:true}).waitFor();await page.getByRole('checkbox').last().check();await page.getByRole('button',{name:'确认预算并执行',exact:true}).click();await page.getByText('TEST user rejected',{exact:false}).first().waitFor();
 assert.equal(await page.evaluate(()=>window.__sendAttempts),2);await page.waitForTimeout(1000);assert.equal(await page.evaluate(()=>window.__sendAttempts),2,'no retry after rejection');assert.equal(sends.length,1);assert.ok(await page.getByRole('button',{name:'确认预算并执行',exact:true}).isDisabled());await page.getByRole('button',{name:'关闭对话框'}).click();
 // No re-write of fixed slip settings happened while rejecting a transaction.
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('kntq-lp:settings:v1')||'{"slippageBps":50}').slippageBps),50);
 stale=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('链上数据已过期',{exact:true}).waitFor();assert.ok(await page.locator('.position-card').first().getByRole('button',{name:'领取手续费',exact:true}).isDisabled());
 stale=false;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('链上数据已同步',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(QA_OUTPUT,'qa-mobile.png'),fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile no horizontal overflow');
 await page.evaluate(()=>window.__emitWallet('accountsChanged'));await page.getByRole('button',{name:'连接钱包',exact:true}).first().waitFor();assert.equal(await page.locator('.position-card').count(),0,'account change clears positions');
 assert.deepEqual(errors,[],'no unhandled requests or page errors');
 console.log(JSON.stringify({passed:true,checks:17,successfulWalletSends:sends.length,walletSendAttempts:2,rpcRequests:trace.filter(x=>x.method!=='wallet_send').length,screenshots:[join(QA_OUTPUT,'qa-desktop.png'),join(QA_OUTPUT,'qa-mobile.png')],mainnetWrites:0}));
 await context.close();
}finally{await browser.close();}
