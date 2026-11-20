import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { Vault } from '../src/vault.mjs';

const password='radar-test-password-123';
const aveKey='test-only-AVE-key-do-not-send';
const temporary=()=>mkdtempSync(path.join(os.tmpdir(),'chainpair-radar-vault-'));

test('AVE credentials persist encrypted, are never in public metadata, and restart locked',()=>{
  const dir=temporary();
  try{
    const vault=new Vault(dir);
    assert.deepEqual(vault.setAveCredentials({apiKey:aveKey,password}),{configured:true});
    assert.equal(vault.publicStatus().aveConfigured,true);
    assert.deepEqual(vault.getAveCredentials(),{apiKey:aveKey});
    const returned=vault.getAveCredentials();returned.apiKey='changed-copy';
    assert.equal(vault.getAveCredentials().apiKey,aveKey);
    for(const file of ['vault.json','wallets.json']){
      const text=readFileSync(path.join(dir,file),'utf8');
      assert.equal(text.includes(aveKey),false);assert.equal(text.includes(password),false);
      assert.equal(statSync(path.join(dir,file)).mode&0o777,0o600);
    }
    assert.equal(JSON.stringify(vault.publicStatus()).includes(aveKey),false);
    assert.equal(vault.redact(`AVE failure: ${aveKey}`).includes(aveKey),false);
    const capturedPayload=vault.payload;
    vault.lock();assert.equal(capturedPayload.ave.apiKey,'');assert.equal(vault.getAveCredentials(),null);
    const restarted=new Vault(dir);
    assert.equal(restarted.publicStatus().aveConfigured,true);assert.equal(restarted.publicStatus().locked,true);
    assert.equal(restarted.getAveCredentials(),null);
    assert.throws(()=>restarted.unlock('incorrect-password-123'));
    assert.equal(restarted.getAveCredentials(),null);
    restarted.unlock(password);assert.equal(restarted.getAveCredentials().apiKey,aveKey);
    restarted.lock();assert.equal(restarted.getAveCredentials(),null);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('adding AVE credentials keeps existing wallet and OKX vault entries and requires the same password',()=>{
  const dir=temporary();
  try{
    const vault=new Vault(dir),wallet=Wallet.createRandom();
    vault.importWallet({chain:'bnb',mode:'private',secret:wallet.privateKey,password});
    vault.setOkxCredentials({apiKey:'test-only-okx-key',secretKey:'test-only-okx-secret',passphrase:'test-only-okx-pass',password});
    vault.lock();
    assert.throws(()=>vault.setAveCredentials({apiKey:aveKey,password:'different-password-123'}));
    assert.equal(vault.publicStatus().aveConfigured,false);assert.equal(vault.getAveCredentials(),null);
    vault.setAveCredentials({apiKey:aveKey,password});
    assert.equal(vault.publicStatus().locked,true);assert.equal(vault.getAveCredentials(),null);
    assert.throws(()=>vault.signer('bnb'));
    vault.unlock(password);
    assert.equal(vault.signer('bnb').address,wallet.address);
    assert.equal(vault.getOkxCredentials().secretKey,'test-only-okx-secret');
    vault.lock();
    const restarted=new Vault(dir);restarted.unlock(password);
    assert.equal(restarted.signer('bnb').address,wallet.address);
    assert.equal(restarted.getAveCredentials().apiKey,aveKey);
    assert.equal(restarted.getOkxCredentials().secretKey,'test-only-okx-secret');
    restarted.clearAveCredentials();
    assert.equal(restarted.getAveCredentials(),null);assert.equal(restarted.publicStatus().aveConfigured,false);
    assert.equal(restarted.signer('bnb').address,wallet.address);
    assert.equal(restarted.getOkxCredentials().secretKey,'test-only-okx-secret');
    restarted.lock();assert.throws(()=>restarted.clearAveCredentials());
    const deleted=new Vault(dir);deleted.unlock(password);
    assert.equal(deleted.getAveCredentials(),null);assert.equal(deleted.publicStatus().aveConfigured,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('invalid AVE keys cannot create or mutate a vault and validation never echoes credentials',()=>{
  const dir=temporary();
  try{
    const vault=new Vault(dir);
    for(const apiKey of [null,12,'','   ','has a space','has\na\nnewline','中文密钥','a'.repeat(1001)]){
      assert.throws(()=>vault.setAveCredentials({apiKey,password}),error=>error.safe===true&&!error.message.includes('has a space'));
    }
    assert.equal(vault.publicStatus().unlocked,false);assert.equal(vault.publicStatus().aveConfigured,false);
    vault.setAveCredentials({apiKey:`  ${aveKey}  `,password});
    assert.equal(vault.getAveCredentials().apiKey,aveKey);
    assert.throws(()=>vault.setAveCredentials({apiKey:'replacement-key',password:'wrong-password-123'}));
    assert.equal(vault.getAveCredentials().apiKey,aveKey);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
