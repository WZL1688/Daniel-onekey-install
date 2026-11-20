import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/vault.mjs';
import { createApp, startLocalServer } from '../src/server.mjs';

const password='radar-api-test-password';
const apiKey='test-only-radar-api-key-not-real';
const endpoints=[['POST','settings',{settings:{chain:'bnb'}}],['POST','enabled',{enabled:true}],['POST','refresh',{}],['POST','risk',{chain:'bnb',address:'0x1111111111111111111111111111111111111111'}],['POST','watch',{chain:'bnb',address:'0x1111111111111111111111111111111111111111',note:'local note'}],['POST','credentials',{apiKey,password}],['DELETE','credentials',{}]];

async function withServer(fn,{withoutService=false}={}){
  const dir=mkdtempSync(path.join(os.tmpdir(),'chainpair-radar-api-'));const vault=new Vault(dir),calls=[];
  const fail=()=>{throw new Error('Radar must never access trading engine');};
  const engine={snapshot:fail,start:fail,execute:fail,saveConfig:fail,pause:fail};
  const radarService={
    snapshot(){calls.push(['snapshot']);return {readOnly:true,enabled:false,items:[]};},
    saveSettings(settings){calls.push(['settings',settings]);return {settings};},
    setEnabled(enabled){calls.push(['enabled',enabled]);return {enabled};},
    refresh(){calls.push(['refresh']);return {items:[]};},
    checkRisk(input){calls.push(['risk',input]);return {status:'unknown'};},
    toggleWatch(input){calls.push(['watch',input]);return {watched:true};},
    credentialsChanged(){calls.push(['credentialsChanged']);}
  };
  const {server,url}=await startLocalServer({app:createApp({engine,store:{},vault,radarService:withoutService?undefined:radarService,publicDir:dir})});
  try{
    const session=await fetch(`${url}/api/session`),{csrfToken}=await session.json();
    const headers={Cookie:session.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':csrfToken,'Content-Type':'application/json'};
    const request=(method,suffix,body={},extra={})=>fetch(`${url}/api/radar${suffix?`/${suffix}`:''}`,{method,headers:{...headers,...extra},...(method==='GET'?{}:{body:JSON.stringify(body)})});
    await fn({dir,vault,calls,url,headers,request});
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
}

test('radar reads require local session and mutations require CSRF and matching Origin',async()=>{
  await withServer(async({url,headers,request,calls})=>{
    assert.equal((await fetch(`${url}/api/radar`)).status,401);
    assert.equal((await request('GET','',{}, {Origin:'http://foreign.invalid'})).status,403);
    for(const [method,path,body] of endpoints){
      const noCsrf=await fetch(`${url}/api/radar/${path}`,{method,headers:{Cookie:headers.Cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(noCsrf.status,403);
      assert.equal((await request(method,path,body,{Origin:'http://foreign.invalid'})).status,403);
    }
    assert.deepEqual(calls,[]);
    const response=await request('GET','');assert.equal(response.status,200);assert.equal((await response.json()).readOnly,true);
    assert.deepEqual(calls,[['snapshot']]);
  });
});

test('radar routes allowlist inputs and have no trading, wallet-signing, or config side effects',async()=>{
  await withServer(async({request,calls})=>{
    const address='0x1111111111111111111111111111111111111111';
    assert.equal((await request('POST','settings',{settings:{chain:'bnb'},execute:true})).status,200);
    assert.equal((await request('POST','enabled',{enabled:true,execute:true})).status,200);
    assert.equal((await request('POST','refresh',{execute:true,amountUsd:10})).status,200);
    assert.equal((await request('POST','risk',{chain:'bnb',address,execute:true})).status,200);
    assert.equal((await request('POST','watch',{chain:'bnb',address,note:'local note',password:'do-not-pass'})).status,200);
    assert.deepEqual(calls,[['settings',{chain:'bnb'}],['enabled',true],['refresh'],['risk',{chain:'bnb',address}],['watch',{chain:'bnb',address,note:'local note'}]]);
  });
});

test('radar credential routes store encrypted locally without echo and require unlock to delete',async()=>{
  await withServer(async({dir,vault,request,calls})=>{
    const response=await request('POST','credentials',{apiKey,password});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{configured:true});
    assert.deepEqual(calls,[['credentialsChanged']]);
    assert.equal(vault.getAveCredentials().apiKey,apiKey);
    for(const file of ['vault.json','wallets.json'])assert.equal(readFileSync(path.join(dir,file),'utf8').includes(apiKey),false);
    const bad=await request('POST','credentials',{apiKey:'bad key secret',password});
    assert.equal(bad.status,400);assert.equal((await bad.text()).includes('bad key secret'),false);
    vault.lock();
    const locked=await request('DELETE','credentials');assert.equal(locked.status,400);
    assert.equal(vault.publicStatus().aveConfigured,true);assert.equal(calls.length,1);
    vault.unlock(password);
    const removed=await request('DELETE','credentials');assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{configured:false});
    assert.equal(vault.getAveCredentials(),null);assert.deepEqual(calls,[['credentialsChanged'],['credentialsChanged']]);
  });
});

test('unavailable radar service fails before credential mutations',async()=>{
  await withServer(async({request,vault})=>{
    assert.equal((await request('GET','')).status,400);
    assert.equal((await request('POST','credentials',{apiKey,password})).status,400);
    assert.equal(vault.publicStatus().aveConfigured,false);
  },{withoutService:true});
});
