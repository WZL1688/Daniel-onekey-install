/** Controlled dual-profile browser QA. All wallet, chain and price data are
 * synthetic TEST FIXTURES. This script never contacts or writes mainnet.
 * Positive identity/transaction cases require genuine canonical runtime bytecode
 * fixtures from the separately verified official-artifact preparation process;
 * no production identity gate or source is modified by this test.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { decodeAbiParameters, decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, toHex, zeroAddress } from 'viem';

const BASE = process.env.LP_TEST_URL || 'http://127.0.0.1:5173';
const OUTPUT = process.env.QA_OUTPUT_DIR ? resolve(process.env.QA_OUTPUT_DIR) : fileURLToPath(new URL('../work/qa-v4/', import.meta.url));
const RUNTIME_PATH = process.env.V4_RUNTIME_FIXTURES ? resolve(process.env.V4_RUNTIME_FIXTURES) : fileURLToPath(new URL('./fixtures/v4-runtime.json', import.meta.url));
await mkdir(OUTPUT, { recursive: true });
let runtimes;
if (existsSync(RUNTIME_PATH)) {
  const value = JSON.parse(await readFile(RUNTIME_PATH, 'utf8'));
  runtimes = value.codes ?? value.runtimes ?? value;
  for (const key of ['manager','poolManager','stateView','permit2']) assert.match(runtimes[key], /^0x[0-9a-f]+$/i, `canonical ${key} fixture`);
}
const ACCOUNT = '0x1234567890123456789012345678901234567890';
const OTHER = '0x9999999999999999999999999999999999999999';
const K = '0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0';
const W = '0xba876237b0f021a6c6d852d6c26e107997cc5e81';
const M = '0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518';
const PM = '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1';
const SV = '0x27ed73ae0652fdcf71d6793412a7525f32be9dfe';
const P2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const V3K = '0x000000000000780555bd0bca3791f89f9542c2d6';
const V3W = '0x5555555555555555555555555555555555555555';
const V3F = '0xf0db7b58379503491d857db50ac9ece64c653918';
const POOL = { currency0: zeroAddress, currency1: K, fee: 10000, tickSpacing: 200, hooks: zeroAddress };
const BLOCK_HASH = '0x' + 'ab'.repeat(32);
const BLOCK_NUMBER = 300000n;
const LIQUIDITY = 10n ** 22n;
const Q128 = 1n << 128n;
const packed = ((BigInt.asUintN(24, -200n)) << 8n) | (200n << 32n);
const ABI = parseAbi([
  'function symbol() view returns(string)', 'function decimals() view returns(uint8)',
  'function balanceOf(address owner) view returns(uint256)',
  'function allowance(address owner,address spender) view returns(uint256)',
  'function allowance(address owner,address token,address spender) view returns(uint160,uint48,uint48)',
  'function factory() view returns(address)', 'function WETH9() view returns(address)',
  'function getPool(address,address,uint24) view returns(address)',
  'function poolManager() view returns(address)', 'function permit2() view returns(address)',
  'function nextTokenId() view returns(uint256)', 'function ownerOf(uint256) view returns(address)',
  'function getPoolAndPositionInfo(uint256) view returns((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256)',
  'function getPositionLiquidity(uint256) view returns(uint128)',
  'function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)',
  'function getLiquidity(bytes32) view returns(uint128)',
  'function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns(uint128,uint256,uint256)',
  'function getFeeGrowthInside(bytes32,int24,int24) view returns(uint256,uint256)',
  'function modifyLiquidities(bytes,uint256) payable',
]);
const ERROR_ABI = parseAbi(['error Error(string)']);
const sends = [], trace = [], errors = [], checks = [];
let identityKnown = false, stale = false, receiptMode = 'success', nextNonce = 0;
const record = (name) => checks.push(name);
class FixtureRevert extends Error { constructor(reason) { super(reason); this.reason = reason; } }

function contract(to, data) {
  const { functionName: name, args = [] } = decodeFunctionData({ abi: ABI, data });
  const address = to.toLowerCase();
  let result;
  switch (name) {
    case 'symbol': result = [K, V3K].includes(address) ? 'KNTQ' : 'WHYPE'; break;
    case 'decimals': result = 18; break;
    case 'balanceOf': result = address === M ? 3n : address === K || address === V3K ? 10000n * 10n ** 18n : 1000n * 10n ** 18n; break;
    case 'allowance': result = args.length === 3 ? [0n, 0, 0] : 0n; break;
    case 'factory': result = V3F; break;
    case 'WETH9': result = address === M ? W : V3W; break;
    case 'getPool': result = zeroAddress; break;
    case 'poolManager': result = PM; break;
    case 'permit2': result = P2; break;
    case 'nextTokenId': result = 300n; break;
    case 'ownerOf': {
      const id = args[0];
      if ([100n, 201n, 202n].includes(id)) result = ACCOUNT;
      else if (id === 203n) result = OTHER;
      else throw new FixtureRevert('NOT_MINTED');
      break;
    }
    case 'getPoolAndPositionInfo': result = [{ ...POOL, hooks: args[0] === 202n ? OTHER : zeroAddress }, packed]; break;
    case 'getPositionLiquidity': result = LIQUIDITY; break;
    case 'getSlot0': result = [1n << 96n, 0, 0, 10000]; break;
    case 'getLiquidity': result = 10n ** 25n; break;
    case 'getPositionInfo': result = [LIQUIDITY, 0n, 0n]; break;
    case 'getFeeGrowthInside': result = [Q128 / 1000n, Q128 / 2000n]; break;
    case 'modifyLiquidities': result = undefined; break;
    default: throw new Error('Unhandled contract function ' + name);
  }
  return encodeFunctionResult({ abi: ABI, functionName: name, result });
}
function code(address) {
  if (!identityKnown || !runtimes) return '0x6001600055';
  const key = ({ [M]: 'manager', [PM]: 'poolManager', [SV]: 'stateView', [P2]: 'permit2' })[address.toLowerCase()];
  return key ? runtimes[key] : '0x6001600055';
}
function block() {
  return { number: toHex(BLOCK_NUMBER), hash: BLOCK_HASH, parentHash: '0x' + 'cd'.repeat(32), timestamp: toHex(BigInt(Math.floor(Date.now() / 1000) - (stale ? 500 : 0))), gasLimit:'0x1c9c380',gasUsed:'0x0',baseFeePerGas:'0x3b9aca00',miner:zeroAddress,difficulty:'0x0',extraData:'0x',size:'0x1',transactions:[],uncles:[],logsBloom:'0x'+'00'.repeat(256),transactionsRoot:BLOCK_HASH,stateRoot:BLOCK_HASH,receiptsRoot:BLOCK_HASH,nonce:'0x0000000000000000',sha3Uncles:BLOCK_HASH,mixHash:BLOCK_HASH };
}
function transaction(hash) {
  const tx = sends.find((entry) => entry.hash === hash);
  if (!tx) return null;
  return { hash, nonce:tx.nonce,blockHash:BLOCK_HASH,blockNumber:toHex(BLOCK_NUMBER),transactionIndex:'0x0',from:tx.from,to:tx.to,value:tx.value,input:tx.data,gas:tx.gas,gasPrice:tx.gasPrice,type:'0x0',chainId:'0x1863d',v:'0x1b',r:BLOCK_HASH,s:BLOCK_HASH };
}
async function routes(context) {
  const rpcHosts = new Set(['rpc.elysium.kinetiq.xyz','node.eleos.fun','rpc-live.boxa.club','rpc.hyperliquid.xyz','hyperliquid-json-rpc.stakely.io']);
  await context.route('https://**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'api.hyperliquid.xyz' && url.pathname === '/info') return route.fulfill({ json: { HYPE: '32.5' } });
    if (!rpcHosts.has(url.hostname)) { errors.push('Unexpected external URL ' + url.href); return route.abort(); }
    const req = route.request().postDataJSON();
    trace.push({ method:req.method, params:req.params, url:url.href, at:Date.now() });
    let result;
    try {
      switch (req.method) {
        case 'eth_chainId': result = url.hostname.includes('hyperliquid') || url.hostname.includes('stakely') ? '0x3e7' : '0x1863d'; break;
        case 'eth_getBlockByNumber': case 'eth_getBlockByHash': result = block(); break;
        case 'eth_blockNumber': result = toHex(BLOCK_NUMBER); break;
        case 'eth_getCode': result = code(req.params[0]); break;
        case 'eth_getBalance': result = toHex(1000n * 10n ** 18n); break;
        case 'eth_call': result = contract(req.params[0].to, req.params[0].data); break;
        case 'eth_getLogs': result = []; break;
        case 'eth_estimateGas': result = toHex(100000n); break;
        case 'eth_gasPrice': result = toHex(1000000000n); break;
        case 'eth_getTransactionCount': result = toHex(nextNonce); break;
        case 'eth_getTransactionByHash': result = transaction(req.params[0]); break;
        case 'eth_getTransactionReceipt': {
          if (receiptMode === 'unavailable') throw new FixtureRevert('TEST receipt unavailable');
          const tx = sends.find((entry) => entry.hash === req.params[0]);
          result = !tx ? null : {transactionHash:tx.hash,transactionIndex:'0x0',blockHash:BLOCK_HASH,blockNumber:toHex(BLOCK_NUMBER),from:tx.from,to:tx.to,cumulativeGasUsed:'0x186a0',gasUsed:'0x186a0',contractAddress:null,logs:[],logsBloom:'0x'+'00'.repeat(256),status:receiptMode==='reverted'?'0x0':'0x1',effectiveGasPrice:'0x3b9aca00',type:'0x0'};
          break;
        }
        default: throw new Error('Unhandled RPC ' + req.method);
      }
      return route.fulfill({ json: { jsonrpc:'2.0', id:req.id, result } });
    } catch (error) {
      if (!(error instanceof FixtureRevert)) errors.push(error.message);
      return route.fulfill({ json: { jsonrpc:'2.0',id:req.id,error:{code:error instanceof FixtureRevert?3:-32000,message:error.message,data:error instanceof FixtureRevert?encodeErrorResult({abi:ERROR_ABI,errorName:'Error',args:[error.reason]}):'0x'} } });
    }
  });
}

const browser = await chromium.launch({ executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined), headless:true,args:['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport:{width:1500,height:1100},deviceScaleFactor:1 });
  await routes(context);
  await context.exposeBinding('__v4RecordSend', async (_source, tx) => {
    assert.equal(Number(tx.chainId), 99901);
    assert.equal(Number(tx.nonce), nextNonce);
    const hash = '0x' + (sends.length + 1).toString(16).padStart(64,'0');
    trace.push({method:'wallet_send',tx,at:Date.now()}); sends.push({...tx,hash}); nextNonce++;
    return hash;
  });
  await context.addInitScript(({ account }) => {
    const listeners={}; window.__walletChain='0x3e7';window.__walletAccount=account;window.__sendAttempts=0;window.__rejectSend=false;window.__walletSwitches=[];
    localStorage.setItem('kntq-lp:settings:v1',JSON.stringify({rpcUrls:['https://rpc.hyperliquid.xyz/evm','https://hyperliquid-json-rpc.stakely.io'],fee:3000,slippageBps:37,staleSeconds:90,refreshSeconds:60,gasReserveHype:'0.02',trackedIds:[]}));
    const provider={isMetaMask:true,on(event,fn){(listeners[event]??=[]).push(fn);},removeListener(event,fn){listeners[event]=(listeners[event]||[]).filter((f)=>f!==fn);},async request({method,params}){
      if(method==='eth_accounts'||method==='eth_requestAccounts')return[window.__walletAccount];
      if(method==='eth_chainId')return window.__walletChain;
      if(method==='wallet_switchEthereumChain'){window.__walletChain=params[0].chainId;window.__walletSwitches.push(params[0].chainId);for(const fn of listeners.chainChanged||[])fn(window.__walletChain);return null;}
      if(method==='wallet_addEthereumChain')return null;
      if(method==='eth_sendTransaction'){window.__sendAttempts++;if(window.__rejectSend)throw Object.assign(new Error('TEST user rejected'),{code:4001});return window.__v4RecordSend(params[0]);}
      throw new Error('Unexpected wallet method '+method);
    }};
    window.ethereum=provider;window.__changeAccount=(next)=>{window.__walletAccount=next;for(const fn of listeners.accountsChanged||[])fn([next]);};
  },{account:ACCOUNT});
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',(error)=>errors.push('pageerror '+error.message));
  page.on('console',(entry)=>{if(entry.type()==='error')errors.push('console '+entry.text());});
  await page.goto(BASE);
  await page.getByLabel('选择网络与协议').selectOption('elysium-v4');
  await page.getByText('Elysium 合约身份尚未通过校验，交易已锁定',{exact:true}).waitFor();record('profile switch and unknown-code gate');
  await page.getByRole('button',{name:'连接钱包',exact:true}).first().click();await page.getByRole('button',{name:'MetaMask',exact:true}).click();
  await page.locator('.position-card').first().waitFor();
  assert.equal(await page.evaluate(()=>window.__walletChain),'0x1863d');assert.deepEqual(await page.evaluate(()=>window.__walletSwitches),['0x1863d']);record('connect and selected-chain wallet switch');
  assert.equal(await page.locator('.position-card').count(),1,'hooked pool must not enter target cards');
  await page.getByText(/持仓扫描不完整/).first().waitFor();record('full PoolKey filtering and partial-scan warning');
  assert.ok(!(await page.locator('.position-card').first().innerText()).includes('WHYPE'));
  assert.ok((await page.locator('.position-card').first().innerText()).includes('HYPE'));record('native HYPE quote labels');
  assert.ok(await page.locator('.position-card').first().getByRole('button',{name:'领取手续费',exact:true}).isDisabled());
  assert.ok(await page.locator('.position-card').first().getByRole('button',{name:'撤池',exact:false}).isDisabled());record('unknown identity blocks collect and exit');
  await page.getByRole('button',{name:'新建流动性仓位',exact:true}).click();
  await page.getByLabel('KNTQ 预算',{exact:true}).fill('10');await page.getByLabel('HYPE 预算',{exact:true}).fill('10');
  assert.ok(await page.getByLabel('池费率',{exact:true}).isDisabled());assert.ok(!(await page.getByRole('dialog').innerText()).includes('自动包装'));record('v4 fixed fee and no wrap flow');
  for(const percent of [2,5,10,20]){
    await page.getByRole('button',{name:`±${percent}%`,exact:true}).click();
    assert.ok(Math.abs(Number(await page.getByLabel('最低价格',{exact:true}).inputValue())-(1-percent/100))<1e-12);
    assert.ok(Math.abs(Number(await page.getByLabel('最高价格',{exact:true}).inputValue())-(1+percent/100))<1e-12);
  }record('four percentage range presets');
  await page.getByRole('button',{name:'全区间',exact:true}).click();assert.equal(await page.getByRole('button',{name:'全区间',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByLabel('最低价格',{exact:true}).count(),0);assert.ok(await page.getByRole('button',{name:'等待合约身份校验',exact:true}).isDisabled());record('full-range preset and locked mint preview');
  await page.getByRole('button',{name:'关闭对话框'}).click();
  await page.getByLabel('跟踪 TokenId').fill('-1');await page.getByRole('button',{name:'核对并跟踪',exact:true}).click();await page.getByRole('status').filter({hasText:'有效的正整数 TokenId'}).waitFor();record('manual TokenId syntax validation');
  await page.getByLabel('跟踪 TokenId').fill('203');await page.getByRole('button',{name:'核对并跟踪',exact:true}).click();await page.getByRole('status').filter({hasText:'不属于当前账户'}).waitFor();record('manual TokenId owner validation');
  await page.getByLabel('跟踪 TokenId').fill('202');await page.getByRole('button',{name:'核对并跟踪',exact:true}).click();await page.getByRole('status').filter({hasText:'无 hook'}).waitFor();record('manual TokenId hooks validation');
  await page.getByLabel('跟踪 TokenId').fill('100');await page.getByRole('button',{name:'核对并跟踪',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.position-card').length===2);assert.equal(await page.getByText(/持仓扫描不完整/).count(),0);record('validated historical TokenId recovery');
  await page.getByRole('button',{name:'连接与设置',exact:true}).click();await page.getByLabel('固定滑点 (%)',{exact:true}).fill('0.65');await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('kntq-lp:settings:v1:elysium-v4')).slippageBps===65);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('kntq-lp:settings:v1')).slippageBps),37);record('network-isolated settings persistence');
  await page.getByLabel('选择网络与协议').selectOption('hyperevm-v3');assert.equal(await page.locator('.position-card').count(),0);await page.getByRole('button',{name:'连接与设置',exact:true}).click();assert.equal(await page.getByLabel('固定滑点 (%)',{exact:true}).inputValue(),'0.37');await page.getByRole('button',{name:'关闭对话框'}).click();record('network switch clears account and preserves v3 settings');
  await page.getByLabel('选择网络与协议').selectOption('elysium-v4');await page.getByRole('button',{name:'连接钱包',exact:true}).first().click();await page.getByRole('button',{name:'MetaMask',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.position-card').length===2);
  const card=()=>page.locator('.position-card').filter({hasText:'#201'});
  async function previewCollect(){await card().getByRole('button',{name:'领取手续费',exact:true}).click();await page.getByText('首步骤模拟通过',{exact:true}).waitFor();await page.getByRole('checkbox').last().check();}
  if(runtimes){
    identityKnown=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('Elysium 合约代码身份与关联校验已通过',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.collect-button')?.disabled);record('canonical runtime identity permits transaction preparation');
    // A second same-origin document holds the actual browser Web Lock. The
    // application must refuse a send before a wallet popup or pending write.
    await previewCollect();
    const guard=await context.newPage();await guard.goto(BASE);
    await guard.evaluate((key)=>{window.__guardWait=new Promise(resolve=>{window.__guardRelease=resolve;});void navigator.locks.request(key,async()=>{window.__guardHeld=true;await window.__guardWait;});},`kntq-lp:pending:v4:99901:${M}:${ACCOUNT.toLowerCase()}`);
    await guard.waitForFunction(()=>window.__guardHeld);
    await page.getByRole('button',{name:'确认预算并执行',exact:true}).click();
    await page.getByText(/其他标签页/).first().waitFor();
    assert.equal(sends.length,0);assert.equal(await page.evaluate(()=>window.__sendAttempts),0);
    await page.getByRole('button',{name:'关闭对话框'}).click();
    await guard.evaluate(()=>window.__guardRelease());await guard.close();
    await page.getByRole('button',{name:'连接与设置',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'查询待确认交易',exact:true}).click();
    await page.locator('.pending-clear').waitFor();await page.getByRole('button',{name:'关闭对话框'}).click();
    record('cross-document lock blocks simultaneous sending and releases safely');
    await previewCollect();assert.equal(sends.length,0);record('collect preview sends nothing');
    await page.getByRole('button',{name:'确认预算并执行',exact:true}).click();await page.getByText('所有步骤已获链上确认',{exact:true}).waitFor();assert.equal(sends.length,1);
    const submitted=sends[0];const main=decodeFunctionData({abi:ABI,data:submitted.data});assert.equal(main.functionName,'modifyLiquidities');
    const [actions,params]=decodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],main.args[0]);assert.equal(actions,'0x0111');
    const dec=decodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint128'},{type:'uint128'},{type:'bytes'}],params[0]);assert.deepEqual(dec,[201n,0n,0n,0n,'0x']);
    const take=decodeAbiParameters([{type:'address'},{type:'address'},{type:'address'}],params[1]);assert.equal(take[2].toLowerCase(),ACCOUNT.toLowerCase());assert.equal(BigInt(submitted.value),0n);
    const sentAt=trace.findIndex((entry)=>entry.method==='wallet_send');assert.ok(trace.slice(0,sentAt).some((entry)=>entry.method==='eth_call'&&entry.params[0].data===submitted.data));assert.ok(trace.slice(0,sentAt).some((entry)=>entry.method==='eth_estimateGas'&&entry.params[0].data===submitted.data));record('collect zero-principal minima, recipient, simulation and one send');
    await page.getByRole('button',{name:'返回持仓',exact:true}).click();
    await page.evaluate(()=>{window.__rejectSend=true;});await previewCollect();await page.getByRole('button',{name:'确认预算并执行',exact:true}).click();await page.getByText('TEST user rejected',{exact:false}).first().waitFor();assert.ok(await page.getByRole('button',{name:'确认预算并执行',exact:true}).isDisabled());await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>window.__sendAttempts),2);assert.equal(sends.length,1);await page.getByRole('button',{name:'关闭对话框'}).click();record('wallet rejection consumes plan and never resends');
    await page.evaluate(()=>{window.__rejectSend=false;});receiptMode='reverted';await previewCollect();await page.getByRole('button',{name:'确认预算并执行',exact:true}).click();await page.getByText('交易已回滚',{exact:false}).first().waitFor();assert.equal(await page.getByText('所有步骤已获链上确认',{exact:true}).count(),0);await page.getByRole('button',{name:'关闭对话框'}).click();record('reverted receipt is a failure');
    receiptMode='unavailable';await previewCollect();await page.getByRole('button',{name:'确认预算并执行',exact:true}).click();await page.getByText('存在尚未核实的交易，后续签名已锁定',{exact:true}).waitFor();await page.getByRole('button',{name:'关闭对话框'}).click();assert.ok(await card().getByRole('button',{name:'领取手续费',exact:true}).isDisabled());const sendsBeforeRecovery=sends.length;record('ambiguous receipt persists lock and blocks new send');
    receiptMode='success';await page.getByRole('button',{name:'连接与设置',exact:true}).click();await page.getByLabel('待确认交易哈希').fill(sends[0].hash);await page.getByRole('dialog').getByRole('button',{name:'查询待确认交易',exact:true}).click();await page.locator('.pending-blocked').filter({hasText:'不符'}).waitFor();record('recovery rejects a different nonce transaction');
    await page.getByLabel('待确认交易哈希').fill(sends.at(-1).hash);await page.getByRole('dialog').getByRole('button',{name:'查询待确认交易',exact:true}).click();await page.locator('.pending-clear').filter({hasText:'已确认'}).waitFor();assert.equal(sends.length,sendsBeforeRecovery);await page.getByRole('button',{name:'关闭对话框'}).click();record('verified recovery clears lock without broadcast');
  }
  stale=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('链上数据已过期',{exact:true}).waitFor();assert.ok(await card().getByRole('button',{name:'领取手续费',exact:true}).isDisabled());record('stale block prevents signature');
  stale=false;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('链上数据已同步',{exact:true}).waitFor();
  await page.evaluate(()=>{const badge=document.createElement('div');badge.textContent='TEST FIXTURE · Elysium 受控测试数据';badge.style.cssText='position:fixed;right:8px;bottom:6px;z-index:9999;pointer-events:none;background:#15251dd9;color:#d5e6c2;padding:5px 8px;border-radius:4px;font:10px sans-serif';document.body.append(badge);});
  await page.screenshot({path:join(OUTPUT,'elysium-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(OUTPUT,'elysium-mobile.png'),fullPage:true});record('mobile layout without horizontal overflow');
  await page.setViewportSize({width:1500,height:1100});
  if(runtimes){await previewCollect();const attemptsBefore=await page.evaluate(()=>window.__sendAttempts);await page.evaluate((other)=>window.__changeAccount(other),OTHER);await page.getByRole('button',{name:'连接钱包',exact:true}).first().waitFor();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('.position-card').count(),0);assert.equal(await page.evaluate(()=>window.__sendAttempts),attemptsBefore);record('account change invalidates prepared recipient and clears holdings');}
  else{await page.evaluate((other)=>window.__changeAccount(other),OTHER);await page.getByRole('button',{name:'连接钱包',exact:true}).first().waitFor();assert.equal(await page.locator('.position-card').count(),0);record('account change clears holdings');}
  assert.deepEqual(errors,[],'no page/console/unhandled RPC errors');record('zero page and console errors');
  console.log(JSON.stringify({passed:true,checks:checks.length,checkNames:checks,positiveTransactionChecks:!!runtimes,positiveSkippedReason:runtimes?undefined:'Canonical runtime fixtures unavailable; identity negative path only',fixtureBroadcasts:sends.length,walletSendAttempts:await page.evaluate(()=>window.__sendAttempts),rpcRequests:trace.filter((entry)=>entry.method!=='wallet_send').length,screenshots:[join(OUTPUT,'elysium-desktop.png'),join(OUTPUT,'elysium-mobile.png')],mainnetWrites:0}));
  await context.close();
}finally{await browser.close();}
