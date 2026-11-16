import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Vault } from '../src/vault.mjs';
import { Store } from '../src/store.mjs';
import { validateConfig, DEFAULT_CONFIG } from '../src/config.mjs';
import { createApp, startLocalServer } from '../src/server.mjs';

const temp=()=>mkdtempSync(path.join(os.tmpdir(),'dualarb-test-'));
const password='test-password-12345';
test('private wallets and OKX credentials persist encrypted, restart locked, incorrect password never unlocks',()=>{
 const dir=temp();try{
  const vault=new Vault(dir);const wallet=Wallet.createRandom();const kp=Keypair.generate();const solSecret=bs58.encode(kp.secretKey);
  vault.importWallet({chain:'bnb',mode:'private',secret:wallet.privateKey,password});
  vault.importWallet({chain:'solana',mode:'private',secret:solSecret,password});
  vault.setOkxCredentials({apiKey:'test-api-123',secretKey:'test-secret-456',passphrase:'test-pass-789',password});
  assert.equal(vault.signer('bnb').address,wallet.address);assert.equal(vault.signer('solana').publicKey.toBase58(),kp.publicKey.toBase58());
  const stored=readFileSync(path.join(dir,'vault.json'),'utf8');for(const value of [wallet.privateKey,solSecret,password,'test-secret-456','test-api-123'])assert.equal(stored.includes(value),false);
  const redacted=vault.redact(`provider failure ${wallet.privateKey} ${solSecret} test-secret-456`);assert.equal(redacted.includes(wallet.privateKey),false);assert.equal(redacted.includes(solSecret),false);assert.equal(redacted.includes('test-secret-456'),false);
  const status=JSON.stringify(vault.publicStatus());assert.equal(status.includes(wallet.privateKey),false);assert.equal(status.includes(solSecret),false);
  assert.equal(statSync(path.join(dir,'vault.json')).mode&0o777,0o600);
  const restarted=new Vault(dir);assert.equal(restarted.publicStatus().bnb.locked,true);assert.throws(()=>restarted.signer('bnb'));assert.throws(()=>restarted.unlock('wrong-password-123'));
  assert.equal(restarted.publicStatus().bnb.locked,true);restarted.unlock(password);assert.equal(restarted.signer('bnb').address,wallet.address);assert.equal(restarted.getOkxCredentials().secretKey,'test-secret-456');
  restarted.lock();assert.equal(restarted.getOkxCredentials(),null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('readonly wallet cannot sign even after replacing private wallet while vault is locked',()=>{
 const dir=temp();try{const vault=new Vault(dir);const wallet=Wallet.createRandom();vault.importWallet({chain:'bnb',mode:'private',secret:wallet.privateKey,password});vault.lock();vault.importWallet({chain:'bnb',mode:'readonly',address:wallet.address});vault.unlock(password);assert.equal(vault.publicStatus().bnb.mode,'readonly');assert.throws(()=>vault.signer('bnb'));}finally{rmSync(dir,{recursive:true,force:true});}
});
test('config enforces arbitrage range, fixed rebalance policy, fees and RPC constraints',()=>{
 for(const amountUsd of [0,0.9,10.1,NaN,Infinity])assert.throws(()=>validateConfig({...DEFAULT_CONFIG,risk:{...DEFAULT_CONFIG.risk,amountUsd}}));
 assert.equal(validateConfig({...DEFAULT_CONFIG,risk:{...DEFAULT_CONFIG.risk,amountUsd:1}}).risk.amountUsd,1);
 assert.throws(()=>validateConfig({...DEFAULT_CONFIG,rebalance:{...DEFAULT_CONFIG.rebalance,triggerUsd:6}}));
 assert.throws(()=>validateConfig({...DEFAULT_CONFIG,chains:{...DEFAULT_CONFIG.chains,bnb:{...DEFAULT_CONFIG.chains.bnb,rpcs:['javascript:alert(1)']}}}));
 const result=validateConfig({...DEFAULT_CONFIG,password:'never-store-me'});assert.equal('password' in result,false);
});
test('durable journal, idempotent reservations, safe archives and note paging survive restart',()=>{
 const dir=temp();try{let store=new Store(dir);store.saveTrade({id:'trade-1',status:'BUY_SUBMITTING',amountUsd:5,privateKey:'forbidden-secret'});store.reserveExecution('trade-1',5);store.reserveExecution('trade-1',5);store.appendEvent('trade-1',{status:'BUY_SUBMITTED',hash:'0xabc'});store.saveQuote({id:'quote-1',nested:{password:'redact-me',amountRaw:'100000000'}});for(let i=0;i<12;i++)store.addNote(`note-${i}`);assert.equal(store.stats().count,1);assert.equal(store.stats().volumeUsd,5);assert.equal(store.getTrade('trade-1').privateKey,undefined);assert.equal(store.getQuote('quote-1').nested.password,undefined);assert.equal(store.listNotes(2,10).items.length,2);store.close();store=new Store(dir);assert.equal(store.getTrade('trade-1').status,'BUY_SUBMITTED');assert.equal(store.getTrade('trade-1').events[0].hash,'0xabc');assert.equal(store.stats().count,1);store.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('loopback API rejects foreign Host/Origin, unauthenticated reads and missing CSRF; never returns SDK secrets',async()=>{
 const dir=temp();const store=new Store(dir);const vault=new Vault(dir);const engine={snapshot:()=>({engine:{busy:false}}),saveConfig:()=>{throw new Error('privateKey=do-not-expose');},pause:()=>({ok:true})};
 const {server,url}=await startLocalServer({app:createApp({engine,store,vault,publicDir:dir})});
 try{
  assert.equal((await fetch(`${url}/api/state`)).status,401);
  const foreignHostStatus=await new Promise((resolve,reject)=>{const req=http.get(`${url}/api/session`,{headers:{Host:'evil.invalid'}},(res)=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(foreignHostStatus,403);
  assert.equal((await fetch(`${url}/api/session`,{headers:{Origin:'http://evil.invalid'}})).status,403);
  const session=await fetch(`${url}/api/session`);const {csrfToken}=await session.json();const cookie=session.headers.get('set-cookie').split(';')[0];
  assert.match(session.headers.get('set-cookie'),/HttpOnly/);assert.match(session.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await fetch(`${url}/api/state`,{headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(`${url}/api/config`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  const response=await fetch(`${url}/api/config`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:'{}'});
  assert.equal(response.status,400);assert.equal((await response.text()).includes('do-not-expose'),false);
 }finally{await new Promise((resolve)=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});}
});
test('occupied explicit port falls back to an automatically selected loopback port',async()=>{
 const app=createApp({engine:{snapshot:()=>({})},store:{},vault:{},publicDir:'/nonexistent'});const a=await startLocalServer({app});let b;try{b=await startLocalServer({app,port:a.port});assert.notEqual(a.port,b.port);assert.equal(a.server.address().address,'127.0.0.1');}finally{if(b)await new Promise((resolve)=>b.server.close(resolve));await new Promise((resolve)=>a.server.close(resolve));}
});

test('demo reservations cannot consume live caps and live history cannot be reset by mode switching',()=>{
 const dir=temp();try{const store=new Store(dir);store.saveTrade({id:'demo',mode:'demo',status:'COMPLETED',actual:{profitUsd:0.25}});store.reserveExecution('demo',5);store.saveTrade({id:'live',mode:'live',status:'COMPLETED',actual:{profitUsd:0.15}});store.reserveExecution('live',3);assert.equal(store.stats().volumeUsd,5);assert.equal(store.stats().profitUsd,0.25);store.setConfig({...store.config,mode:'live'});assert.equal(store.stats().volumeUsd,3);assert.equal(store.stats().profitUsd,0.15);store.setConfig({...store.config,mode:'demo'});assert.equal(store.stats().volumeUsd,5);store.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
