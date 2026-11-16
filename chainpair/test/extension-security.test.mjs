import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { Vault } from '../src/vault.mjs';
import { Store } from '../src/store.mjs';
import { createApp, startLocalServer } from '../src/server.mjs';
import { BrowserWalletBridge } from '../src/browser-wallets.mjs';

const temp=()=>mkdtempSync(path.join(os.tmpdir(),'chainpair-extension-'));
const password='browser-wallet-test-password';
const safe=message=>Object.assign(new Error(message),{safe:true});
function fakeBroker(){
  const connections=new Map(),calls=[];
  return {connections,calls,
    connect(input){calls.push(['connect',input]);connections.set(input.chain,{...input,connected:true});return this.status(input.chain);},
    status(chain){return connections.get(chain)||{connected:false};},
    disconnect({chain,clientId}){const c=connections.get(chain);if(c&&c.clientId!==clientId)throw safe('页面标识不匹配');calls.push(['disconnect',chain]);connections.delete(chain);},
    disconnectChain(chain){calls.push(['disconnectChain',chain]);connections.delete(chain);},
    disconnectAll(){connections.clear();},
    heartbeat({clientId,connections:rows}){for(const row of rows){const c=connections.get(row.chain);if(!c||c.clientId!==clientId||c.address!==row.address)throw safe('插件连接已变更');}calls.push(['heartbeat']);return {ok:true};},
    poll(clientId){calls.push(['poll',clientId]);return {requests:[]};},
    resolve(input){calls.push(['resolve',input]);return {signedTransactionBase64:'must-not-echo-result'};}
  };
}
async function withServer(fn,{refresh,realBroker=false}={}){
  const dir=temp(),store=new Store(dir),browserWallets=realBroker?new BrowserWalletBridge({store}):fakeBroker(),vault=new Vault(dir,{browserWallets});
  const engine={busy:false,configuring:false,refreshing:false,quoteBuilders:0,plan:{},bridgeQuotes:new Map(),balances:{bnb:{stableUsd:99}},running:true,
    snapshot(){return {engine:{busy:this.busy},wallets:vault.publicStatus()};},
    pause(){this.running=false;return this.snapshot();},
    refresh:refresh||(()=>Promise.resolve())
  };
  const {server,url}=await startLocalServer({app:createApp({engine,store,vault,browserWallets,publicDir:dir})});
  const sessionResponse=await fetch(url+'/api/session'),{csrfToken}=await sessionResponse.json();
  const headers={Cookie:sessionResponse.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const post=(endpoint,data,extra={})=>fetch(url+endpoint,{method:'POST',headers,body:JSON.stringify(data),...extra});
  try{await fn({url,headers,post,engine,vault,store,browserWallets});}
  finally{browserWallets.close?.();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});}
}

test('browser metadata is public only, disconnected after restart, and cannot yield a local signer',()=>{
  const dir=temp();try{
    const browserWallets=fakeBroker(),vault=new Vault(dir,{browserWallets}),wallet=Wallet.createRandom(),clientId=randomUUID();
    browserWallets.connect({chain:'bnb',provider:'metamask',address:wallet.address,clientId});
    vault.importWallet({chain:'bnb',mode:'browser',provider:'metamask',address:wallet.address});
    const status=vault.publicStatus();assert.equal(status.bnb.connected,true);assert.equal(status.bnb.canSign,true);assert.equal(status.bnb.provider,'metamask');
    assert.equal('clientId' in status.bnb,false);assert.equal(JSON.stringify(status).includes(clientId),false);assert.throws(()=>vault.signer('bnb'));
    const metadata=readFileSync(path.join(dir,'wallets.json'),'utf8');assert.equal(metadata.includes(clientId),false);assert.equal(metadata.includes(wallet.privateKey),false);
    const restarted=new Vault(dir);assert.equal(restarted.publicStatus().bnb.mode,'browser');assert.equal(restarted.publicStatus().bnb.canSign,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('connecting a plugin preserves an encrypted local wallet and restore works after restart',()=>{
  const dir=temp();try{
    const browserWallets=fakeBroker(),vault=new Vault(dir,{browserWallets}),local=Wallet.createRandom(),plugin=Wallet.createRandom();
    vault.importWallet({chain:'bnb',mode:'private',secret:local.privateKey,password});const cipherBefore=readFileSync(path.join(dir,'vault.json'),'utf8');
    vault.importWallet({chain:'bnb',mode:'browser',provider:'okx',address:plugin.address});
    assert.equal(vault.publicStatus().bnb.hasLocalProfile,true);assert.equal(vault.publicStatus().bnb.localAddress,local.address);
    assert.equal(readFileSync(path.join(dir,'vault.json'),'utf8'),cipherBefore);assert.throws(()=>vault.getPrivateKey('bnb'));
    const restarted=new Vault(dir,{browserWallets});restarted.unlock(password);assert.throws(()=>restarted.getPrivateKey('bnb'));
    restarted.restoreLocalWallet('bnb');assert.equal(restarted.publicStatus().bnb.address,local.address);assert.equal(restarted.signer('bnb').address,local.address);
    assert.equal(readFileSync(path.join(dir,'vault.json'),'utf8').includes(local.privateKey),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('readonly addresses trim pasted whitespace and browser provider chain combinations are checked',()=>{
  const dir=temp();try{
    const vault=new Vault(dir),bnb=Wallet.createRandom(),sol=Keypair.generate().publicKey.toBase58();
    vault.importWallet({chain:'bnb',mode:'readonly',address:`  ${bnb.address}\n`});assert.equal(vault.publicStatus().bnb.address,bnb.address);
    vault.importWallet({chain:'solana',mode:'readonly',address:`\t${sol}  `});assert.equal(vault.publicStatus().solana.address,sol);
    assert.throws(()=>vault.importWallet({chain:'bnb',mode:'browser',provider:'phantom',address:bnb.address}));
    assert.throws(()=>vault.importWallet({chain:'solana',mode:'browser',provider:'metamask',address:sol}));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('stale browser status cannot enable a different saved address or provider',()=>{
  const dir=temp();try{
    const browserWallets=fakeBroker(),vault=new Vault(dir,{browserWallets}),wallet=Wallet.createRandom();
    vault.importWallet({chain:'bnb',mode:'browser',provider:'metamask',address:wallet.address});
    browserWallets.connect({chain:'bnb',provider:'metamask',address:Wallet.createRandom().address,clientId:randomUUID()});assert.equal(vault.publicStatus().bnb.canSign,false);
    browserWallets.connect({chain:'bnb',provider:'okx',address:wallet.address,clientId:randomUUID()});assert.equal(vault.publicStatus().bnb.canSign,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('plugin connect is authenticated and responds before a hanging network refresh',async()=>{
  let refreshCalls=0;
  await withServer(async({url,headers,post,engine,vault,browserWallets})=>{
    const body={chain:'bnb',provider:'metamask',address:Wallet.createRandom().address,clientId:randomUUID()};
    assert.equal((await fetch(url+'/api/wallets/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
    const noCsrf={...headers};delete noCsrf['X-CSRF-Token'];assert.equal((await post('/api/wallets/connect',body,{headers:noCsrf})).status,403);
    const response=await post('/api/wallets/connect',body,{signal:AbortSignal.timeout(1500)});assert.equal(response.status,200);const status=await response.json();assert.equal(status.bnb.canSign,true);assert.equal(engine.running,false);assert.equal(engine.balances.bnb,undefined);
    assert.equal(status.bnb.clientId,undefined);assert.equal(browserWallets.status('bnb').address,vault.publicStatus().bnb.address);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshCalls,1);
  },{refresh:()=>{refreshCalls++;return new Promise(()=>{});}});
});

test('ordinary import cannot forge browser mode and a failed import preserves an existing browser connection',async()=>{
  await withServer(async({post,browserWallets,vault})=>{
    const body={chain:'bnb',provider:'metamask',address:Wallet.createRandom().address,clientId:randomUUID()};
    assert.equal((await post('/api/wallets/import',{...body,mode:'browser'})).status,400);
    assert.equal(vault.publicStatus().bnb.mode,'none');
    assert.equal((await post('/api/wallets/connect',body)).status,200);
    assert.equal((await post('/api/wallets/import',{chain:'bnb',mode:'readonly',address:'invalid'})).status,400);
    assert.equal(browserWallets.status('bnb').connected,true);assert.equal(vault.publicStatus().bnb.mode,'browser');
  });
});

test('busy execution blocks wallet replacement but allows request delivery/results and provider disconnect',async()=>{
  await withServer(async({url,headers,post,engine,vault,browserWallets})=>{
    const body={chain:'bnb',provider:'metamask',address:Wallet.createRandom().address,clientId:randomUUID()};
    assert.equal((await post('/api/wallets/connect',body)).status,200);engine.busy=true;
    assert.equal((await post('/api/wallets/connect',{...body,address:Wallet.createRandom().address})).status,400);
    assert.equal((await post('/api/wallets/import',{chain:'bnb',mode:'readonly',address:body.address})).status,400);
    assert.equal((await post('/api/wallets/browser/heartbeat',{clientId:body.clientId,connections:[{chain:'bnb',address:body.address}]})).status,200);
    assert.equal((await fetch(url+'/api/wallets/browser/requests?clientId='+body.clientId,{headers})).status,200);
    const result=await post('/api/wallets/browser/result',{clientId:body.clientId,requestId:randomUUID(),result:{signedTransactionBase64:'test-signed-bytes'}});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true});
    assert.equal((await post('/api/wallets/disconnect',{chain:'bnb',clientId:body.clientId})).status,200);
    assert.equal(vault.publicStatus().bnb.address,body.address);assert.equal(vault.publicStatus().bnb.canSign,false);assert.equal(engine.running,false);
    assert(browserWallets.calls.some(call=>call[0]==='resolve'));
  });
});

test('browser request endpoints reject invalid page identifiers and missing CSRF',async()=>{
  await withServer(async({url,headers,post})=>{
    assert.equal((await fetch(url+'/api/wallets/browser/requests?clientId=forged',{headers})).status,400);
    assert.equal((await post('/api/wallets/connect',{chain:'bnb',provider:'metamask',address:Wallet.createRandom().address,clientId:'not-a-uuid'})).status,400);
    const noCsrf={...headers};delete noCsrf['X-CSRF-Token'];
    assert.equal((await post('/api/wallets/browser/result',{clientId:randomUUID(),requestId:randomUUID(),result:{hash:'0x00'}},{headers:noCsrf})).status,403);
  });
});

test('actual broker delivers a signature request once and results do not echo signed payloads',async()=>{
  await withServer(async({url,headers,post,browserWallets})=>{
    const address=Wallet.createRandom().address,id=randomUUID();
    assert.equal((await post('/api/wallets/connect',{chain:'bnb',provider:'metamask',address,clientId:id})).status,200);
    const awaiting=browserWallets.request('bnb',{kind:'evmSend',quoteId:'test-quote',payload:{transaction:{from:address,to:address,chainId:'0x38',value:'0x0'}},expiresAt:new Date(Date.now()+10000).toISOString()});
    const delivered=await (await fetch(url+'/api/wallets/browser/requests?clientId='+id,{headers})).json();
    assert.equal(delivered.requests.length,1);
    assert.equal((await (await fetch(url+'/api/wallets/browser/requests?clientId='+id,{headers})).json()).requests.length,0);
    const hash='0x'+'ab'.repeat(32);
    const reply=await post('/api/wallets/browser/result',{clientId:id,requestId:delivered.requests[0].id,result:{hash,privateKey:'must-not-echo'}});
    assert.equal(reply.status,200);assert.deepEqual(await reply.json(),{ok:true});assert.deepEqual(await awaiting,{hash});
  },{realBroker:true});
});

test('actual broker heartbeat account change pauses running engine and invalidates previous plans',async()=>{
  await withServer(async({post,engine,vault,browserWallets})=>{
    const address=Wallet.createRandom().address,id=randomUUID();
    assert.equal((await post('/api/wallets/connect',{chain:'bnb',provider:'metamask',address,clientId:id})).status,200);
    engine.running=true;engine.plan={old:true};engine.bridgeQuotes.set('old',{id:'old'});
    const response=await post('/api/wallets/browser/heartbeat',{clientId:id,connections:[{chain:'bnb',address:Wallet.createRandom().address}]});
    assert.equal(response.status,400);assert.equal(engine.running,false);assert.equal(engine.plan,null);assert.equal(engine.bridgeQuotes.size,0);
    assert.equal(browserWallets.status('bnb').connected,false);assert.equal(vault.publicStatus().bnb.canSign,false);assert.equal(vault.publicStatus().bnb.address,address);
  },{realBroker:true});
});

test('another active browser session cannot replace a wallet connection or its saved public profile',async()=>{
  await withServer(async({post,vault,browserWallets})=>{
    const first={chain:'bnb',provider:'metamask',address:Wallet.createRandom().address,clientId:randomUUID()};
    assert.equal((await post('/api/wallets/connect',first)).status,200);
    const competing={...first,address:Wallet.createRandom().address,clientId:randomUUID()};
    assert.equal((await post('/api/wallets/connect',competing)).status,400);
    assert.equal(vault.publicStatus().bnb.address,first.address);assert.equal(browserWallets.status('bnb').address,first.address);
    assert.equal((await post('/api/wallets/disconnect',{chain:'bnb',clientId:competing.clientId})).status,400);
    assert.equal(browserWallets.status('bnb').connected,true);
  },{realBroker:true});
});

test('connecting the second chain is allowed while the first wallet refresh is pending',async()=>{
  await withServer(async({post,engine,vault})=>{
    const changed=[];engine.walletChanged=chain=>{changed.push(chain);if(chain)delete engine.balances[chain];};
    const clientId=randomUUID();
    assert.equal((await post('/api/wallets/connect',{chain:'bnb',provider:'metamask',address:Wallet.createRandom().address,clientId})).status,200);
    engine.refreshing=true;engine.quoteBuilders=1;
    const sol=Keypair.generate().publicKey.toBase58();
    assert.equal((await post('/api/wallets/connect',{chain:'solana',provider:'phantom',address:sol,clientId})).status,200);
    assert.equal(vault.publicStatus().bnb.canSign,true);assert.equal(vault.publicStatus().solana.canSign,true);
    assert.deepEqual(changed,['bnb','solana']);
    engine.configuring=true;
    assert.equal((await post('/api/wallets/connect',{chain:'solana',provider:'okx',address:sol,clientId})).status,400);
  },{realBroker:true});
});
