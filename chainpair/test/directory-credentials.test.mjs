import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Vault } from '../src/vault.mjs';
import { createApp, startLocalServer } from '../src/server.mjs';

const password='directory-fixture-password';
const apiKey='fixture-only-coingecko-demo-key';
const temporary=()=>mkdtempSync(path.join(os.tmpdir(),'chainpair-directory-key-'));

test('CoinGecko key is encrypted, private metadata stays private, restart is locked and lock wipes payload',()=>{
  const dir=temporary();
  try{
    const vault=new Vault(dir);
    assert.deepEqual(vault.setCoinGeckoCredentials({apiKey,password}),{configured:true});
    assert.equal(vault.publicStatus().coingeckoConfigured,true);
    assert.deepEqual(vault.getCoinGeckoCredentials(),{apiKey});
    const copy=vault.getCoinGeckoCredentials();copy.apiKey='changed-copy';assert.equal(vault.getCoinGeckoCredentials().apiKey,apiKey);
    assert.equal(JSON.stringify(vault.publicStatus()).includes(apiKey),false);
    for(const name of ['vault.json','wallets.json']){
      const text=readFileSync(path.join(dir,name),'utf8');assert.equal(text.includes(apiKey),false);assert.equal(text.includes(password),false);
      assert.equal(statSync(path.join(dir,name)).mode&0o777,0o600);
    }
    assert.equal(vault.redact(`credential ${apiKey}`).includes(apiKey),false);
    const held=vault.payload;vault.lock();assert.equal(held.coinGecko.apiKey,'');assert.equal(vault.getCoinGeckoCredentials(),null);
    const restarted=new Vault(dir);assert.equal(restarted.publicStatus().coingeckoConfigured,true);assert.equal(restarted.publicStatus().locked,true);
    assert.equal(restarted.getCoinGeckoCredentials(),null);assert.throws(()=>restarted.unlock('wrong-directory-password'));
    restarted.unlock(password);assert.equal(restarted.getCoinGeckoCredentials().apiKey,apiKey);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('saving optional data credentials preserves existing locked BNB/Solana wallets, OKX and AVE entries',()=>{
  const dir=temporary();
  try{
    const vault=new Vault(dir),bnb=Wallet.createRandom(),solana=Keypair.generate();
    vault.importWallet({chain:'bnb',mode:'private',secret:bnb.privateKey,password});
    vault.importWallet({chain:'solana',mode:'private',secret:bs58.encode(solana.secretKey),password});
    vault.setOkxCredentials({apiKey:'fixture-okx-key',secretKey:'fixture-okx-secret',passphrase:'fixture-okx-pass',password});
    vault.setAveCredentials({apiKey:'fixture-ave-key',password});vault.lock();
    assert.throws(()=>vault.setCoinGeckoCredentials({apiKey,password:'incorrect-password'}));
    assert.equal(vault.publicStatus().coingeckoConfigured,false);
    vault.setCoinGeckoCredentials({apiKey,password});
    assert.equal(vault.publicStatus().locked,true);assert.equal(vault.publicStatus().bnb.canSign,false);assert.equal(vault.publicStatus().solana.canSign,false);
    assert.throws(()=>vault.signer('bnb'));assert.throws(()=>vault.signer('solana'));
    assert.equal(vault.getOkxCredentials(),null);assert.equal(vault.getAveCredentials(),null);assert.equal(vault.getCoinGeckoCredentials(),null);
    assert.throws(()=>vault.clearCoinGeckoCredentials(),/解锁/);
    vault.unlock(password);assert.equal(vault.signer('bnb').address,bnb.address);assert.equal(vault.signer('solana').publicKey.toBase58(),solana.publicKey.toBase58());
    assert.equal(vault.getOkxCredentials().secretKey,'fixture-okx-secret');assert.equal(vault.getAveCredentials().apiKey,'fixture-ave-key');
    assert.equal(vault.getCoinGeckoCredentials().apiKey,apiKey);
    assert.deepEqual(vault.clearCoinGeckoCredentials(),{configured:false});assert.equal(vault.getCoinGeckoCredentials(),null);
    assert.equal(vault.getAveCredentials().apiKey,'fixture-ave-key');assert.equal(vault.signer('bnb').address,bnb.address);
    const restarted=new Vault(dir);restarted.unlock(password);assert.equal(restarted.publicStatus().coingeckoConfigured,false);
    assert.equal(restarted.getCoinGeckoCredentials(),null);assert.equal(restarted.getOkxCredentials().secretKey,'fixture-okx-secret');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('CoinGecko key validation rejects unsafe characters and known secrets redact regardless of length',()=>{
  const dir=temporary();
  try{
    const vault=new Vault(dir);
    for(const invalid of [null,1,'',' ','contains space','line\nbreak','制表','x'.repeat(1001)])assert.throws(()=>vault.setCoinGeckoCredentials({apiKey:invalid,password}),e=>e.safe===true&&!e.message.includes('contains space'));
    assert.equal(vault.publicStatus().unlocked,false);assert.equal(vault.publicStatus().coingeckoConfigured,false);
    vault.setCoinGeckoCredentials({apiKey:'a',password});assert.equal(vault.redact('a'),'[REDACTED]');
    vault.setCoinGeckoCredentials({apiKey:` ${apiKey} `,password});assert.equal(vault.getCoinGeckoCredentials().apiKey,apiKey);
    assert.throws(()=>vault.setCoinGeckoCredentials({apiKey:'replacement',password:'wrong-directory-password'}));assert.equal(vault.getCoinGeckoCredentials().apiKey,apiKey);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

async function withServer(t,{withoutService=false,withoutCallback=false}={}){
  const dir=temporary(),vault=new Vault(dir),calls=[];
  const forbidden=name=>()=>{calls.push(name);throw new Error('Data credentials cannot affect trading');};
  const engine={config:{mode:'live'},running:true,snapshot:forbidden('snapshot'),start:forbidden('start'),pause:forbidden('pause'),execute:forbidden('execute'),saveConfig:forbidden('saveConfig'),walletChanged:forbidden('walletChanged')};
  const opportunityService={credentialsChanged(){calls.push('credentialsChanged');}};
  const {server,url}=await startLocalServer({app:createApp({engine,store:{},vault,opportunityService:withoutService?undefined:withoutCallback?{}:opportunityService,publicDir:dir})});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));vault.lock();rmSync(dir,{recursive:true,force:true});});
  const session=await fetch(`${url}/api/session`),{csrfToken}=await session.json();
  const headers={Cookie:session.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':csrfToken,'Content-Type':'application/json'};
  const request=(method,body={},extra={})=>fetch(`${url}/api/opportunities/credentials`,{method,headers:{...headers,...extra},body:JSON.stringify(body)});
  return {dir,vault,calls,engine,url,headers,request};
}

test('directory credential API enforces session, CSRF and origin before mutation',async t=>{
  const ctx=await withServer(t);
  assert.equal((await fetch(`${ctx.url}/api/opportunities/credentials`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey,password})})).status,401);
  for(const method of ['POST','DELETE']){
    assert.equal((await fetch(`${ctx.url}/api/opportunities/credentials`,{method,headers:{Cookie:ctx.headers.Cookie,'Content-Type':'application/json'},body:JSON.stringify({apiKey,password})})).status,403);
    assert.equal((await ctx.request(method,{apiKey,password},{Origin:'http://foreign.invalid'})).status,403);
  }
  assert.equal(ctx.vault.publicStatus().coingeckoConfigured,false);assert.deepEqual(ctx.calls,[]);
});

test('directory credential API returns only configuration state and does not unlock or enable trading',async t=>{
  const ctx=await withServer(t),bnb=Wallet.createRandom();
  ctx.vault.importWallet({chain:'bnb',mode:'private',secret:bnb.privateKey,password});ctx.vault.lock();
  const saved=await ctx.request('POST',{apiKey,password,mode:'demo',enabled:true,execute:true});
  assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{configured:true});assert.deepEqual(ctx.calls,['credentialsChanged']);
  assert.equal(ctx.engine.config.mode,'live');assert.equal(ctx.engine.running,true);assert.equal(ctx.vault.publicStatus().locked,true);assert.throws(()=>ctx.vault.signer('bnb'));
  assert.equal(ctx.vault.getCoinGeckoCredentials(),null);assert.equal(readFileSync(path.join(ctx.dir,'wallets.json'),'utf8').includes(apiKey),false);
  const bad=await ctx.request('POST',{apiKey:'invalid secret key',password});assert.equal(bad.status,400);assert.equal((await bad.text()).includes('invalid secret key'),false);
  assert.equal((await ctx.request('DELETE')).status,400);assert.equal(ctx.vault.publicStatus().coingeckoConfigured,true);
  ctx.vault.unlock(password);const removed=await ctx.request('DELETE');assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{configured:false});
  assert.deepEqual(ctx.calls,['credentialsChanged','credentialsChanged']);assert.equal(ctx.vault.signer('bnb').address,bnb.address);
});

test('missing directory service fails before saving credentials',async t=>{
  const ctx=await withServer(t,{withoutService:true});
  assert.equal((await ctx.request('POST',{apiKey,password})).status,400);assert.equal(ctx.vault.publicStatus().coingeckoConfigured,false);
});

test('a directory service without credential invalidation cannot partially save or delete credentials',async t=>{
  const ctx=await withServer(t,{withoutCallback:true});
  assert.equal((await ctx.request('POST',{apiKey,password})).status,400);assert.equal(ctx.vault.publicStatus().coingeckoConfigured,false);
  ctx.vault.setCoinGeckoCredentials({apiKey,password});
  assert.equal((await ctx.request('DELETE')).status,400);assert.equal(ctx.vault.getCoinGeckoCredentials().apiKey,apiKey);
});

test('locking shared vault notifies directory and radar services without enabling execution',async t=>{
  const dir=temporary(),vault=new Vault(dir),calls=[];
  vault.setCoinGeckoCredentials({apiKey,password});
  const engine={busy:false,snapshot:()=>({engine:{busy:false}}),pause:()=>{calls.push('pause');}};
  const {server,url}=await startLocalServer({engine,store:{},vault,radarService:{credentialsChanged(){calls.push('radar');}},opportunityService:{credentialsChanged(){calls.push('directory');}},publicDir:dir});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const session=await fetch(`${url}/api/session`),{csrfToken}=await session.json();
  const response=await fetch(`${url}/api/wallets/lock`,{method:'POST',headers:{Cookie:session.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':csrfToken,'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,200);assert.deepEqual(calls,['pause','radar','directory']);assert.equal(vault.getCoinGeckoCredentials(),null);
});
