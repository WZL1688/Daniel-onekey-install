import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Decimal from 'decimal.js';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.mjs';
import { convertInventoryAmount, createPolicySnapshot, intentForLeg, policyRecord } from '../src/policy.mjs';

const safe = message => Object.assign(new Error(message), { safe: true });
const stage = q => q.fromToken.kind === 'stable' ? 'BUY' : 'SELL';
class InventoryAdapter extends DemoAdapter {
  constructor(args, options = {}) { super(args); this.options = options; this.sent = []; this.bridgeCalls = 0; this.buyConfirmed = false; }
  async quoteTokenBridge() { this.bridgeCalls++; throw Error('inventory must never bridge'); }
  async balances(chain) {
    const result = await super.balances(chain);
    const isSell = this.prices.bnb < this.prices.solana ? chain === 'solana' : chain === 'bnb';
    if (isSell && (this.options.empty || (this.options.drainAfterBuy && this.buyConfirmed) || (this.options.drainBeforeBuy && this.store.allTrades().length))) result.tokenRaw = '0';
    return result;
  }
  async quoteSwap(input) {
    const q = await super.quoteSwap(input);
    if (this.options.badSellIntent && stage(q) === 'SELL' && this.buyConfirmed) q.amountInRaw = (BigInt(q.amountInRaw) + 1n).toString();
    if (this.options.sellLosesProfit && stage(q) === 'SELL' && this.buyConfirmed) {
      q.amountOutRaw = new Decimal(q.amountOutRaw).div(2).floor().toFixed(0); q.minOutRaw = new Decimal(q.amountOutRaw).mul('.995').floor().toFixed(0);
    }
    return q;
  }
  async submit(quote, { onSubmitted } = {}) {
    if (stage(quote) === 'SELL') assert.equal(this.buyConfirmed,true,'sell cannot broadcast before confirmed buy');
    const sent = { hash: `inventory-test-${this.sent.length}`, quote }; this.sent.push(sent); await onSubmitted?.(sent); return sent;
  }
  async confirm(sent) {
    const q = sent.quote, name = stage(q);
    if (name === this.options.throwStage) throw safe('库存单边失败');
    const receipt = { confirmed: name !== this.options.unconfirmedStage, hash: sent.hash, spentRaw: q.amountInRaw,
      receivedRaw: new Decimal(q.amountOutRaw).mul(this.options.actualFraction || 1).floor().toFixed(0), feeUsd: q.feeUsd, rentUsd: 0,
      feesNative: { [q.fromChain]: q.fromChain === 'bnb' ? q.bnbGas : q.solFee }, receipt: { simulated: true } };
    if (name === 'BUY') this.buyConfirmed = receipt.confirmed;
    this.options.afterConfirm?.(name, receipt);
    return receipt;
  }
}
async function setup(t, options = {}, mutate = () => {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(),'inventory-engine-')), store = new Store(directory);
  const config = structuredClone(DEFAULT_CONFIG); config.executionMode = 'inventory';
  config.inventory = { assetId: 'fixture-asset', mappingConfirmed: true, mappingEvidence: 'local fixture verifies 1:1', scanApprovedAssets: false };
  mutate(config); store.setConfig(config);
  const vault = { publicStatus: () => ({ bnb: { mode: 'none' }, solana: { mode: 'none' } }) };
  let adapter;
  const engine = new Engine({ store, vault, adapterFactory: args => adapter = new InventoryAdapter(args,options) });
  await engine.init(); engine.stop();
  t.after(()=>{ engine.stop();store.close();rmSync(directory,{recursive:true,force:true}); });
  return { engine, store, adapter };
}

test('inventory config defaults preserve bridge mode and reject invalid confirmation types',()=>{
  const legacy = structuredClone(DEFAULT_CONFIG); delete legacy.executionMode; delete legacy.inventory;
  assert.equal(validateConfig(legacy).executionMode,'bridge'); assert.equal(validateConfig(legacy).inventory.mappingConfirmed,false);
  for (const patch of [{ executionMode:'instant' }, { inventory:{mappingConfirmed:'yes'} }, { inventory:{scanApprovedAssets:1} }, { inventory:{assetId:'a'.repeat(161)} }, { inventory:{mappingEvidence:'a'.repeat(1001)} }]) assert.throws(()=>validateConfig({...DEFAULT_CONFIG,...patch}));
});

test('inventory conversion preserves equal 1:1 quantities across precision and archives dust',()=>{
  assert.deepEqual(convertInventoryAmount('123456789123456789',18,9,'solana'),{amountRaw:'123456789',dustBuyRaw:'123456789'});
  assert.deepEqual(convertInventoryAmount('123456789',9,18,'bnb'),{amountRaw:'123456789000000000',dustBuyRaw:'0'});
  assert.throws(()=>convertInventoryAmount('1',18,9,'solana'),/正整数/);
  assert.throws(()=>convertInventoryAmount('18446744073709551616',0,0,'solana'),/链上整数/);
  for(const amount of ['0','-1','1.2',1]) assert.throws(()=>convertInventoryAmount(amount,18,9,'solana'));
});

test('inventory uses two legs, actual confirmed buy quantity, and no bridge or fabricated bridge receipt',async t=>{
  const {engine,store,adapter}=await setup(t,{actualFraction:.998});
  assert.equal(engine.opportunity.executable,true,engine.opportunity.reasons.join(';'));
  const trade=await engine.execute();
  assert.equal(trade.status,'COMPLETED'); assert.equal(trade.executionMode,'inventory'); assert.deepEqual(adapter.sent.map(s=>stage(s.quote)),['BUY','SELL']); assert.equal(adapter.bridgeCalls,0);
  const amount=convertInventoryAmount(trade.legs[0].receipt.receivedRaw,18,9,'solana');
  assert.equal(trade.legs[1].quote.amountInRaw,amount.amountRaw); assert.equal(trade.actual.dustBuyRaw,amount.dustBuyRaw);
  assert.equal(trade.actual.closedInventory,false);assert.equal(trade.actual.cashSpreadProfitUsd,trade.actual.profitUsd);assert.equal('bridgedRaw' in trade.actual,false);
  assert.equal(trade.actual.inventoryDelta.bnb.tokenRaw,trade.legs[0].receipt.receivedRaw);assert.equal(trade.actual.inventoryDelta.solana.tokenRaw,`-${trade.legs[1].receipt.spentRaw}`);
  assert.equal(store.getReservedInventory({mode:'demo',chain:'solana',address:'demo-solana-token'}),'0');
  const states=trade.events.map(e=>e.state); assert(states.indexOf('BUY_CONFIRMED')<states.indexOf('SELL_SUBMITTING'));
});

test('empty high-side inventory blocks even the first buy and consumes no attempt quota',async t=>{
  const {engine,store,adapter}=await setup(t,{empty:true});
  assert.equal(engine.opportunity.executable,false);assert.match(engine.opportunity.reasons.join(';'),/库存不足/);
  await assert.rejects(engine.execute(),/库存不足/);assert.equal(adapter.sent.length,0);assert.equal(store.stats().executions,0);
});

test('inventory drained after quote but before BUY is rechecked before any broadcast',async t=>{
  const {engine,store,adapter}=await setup(t,{drainBeforeBuy:true});
  await assert.rejects(engine.execute(),/库存不足/);assert.equal(adapter.sent.length,0);assert.equal(store.allTrades()[0].status,'NEEDS_REVIEW');
});

for (const options of [{unconfirmedStage:'BUY'},{throwStage:'SELL'},{drainAfterBuy:true},{sellLosesProfit:true},{badSellIntent:true}]) test(`inventory failure pauses and retains reservation: ${Object.keys(options)[0]}`,async t=>{
  const {engine,store,adapter}=await setup(t,options);
  await assert.rejects(engine.execute());
  assert.equal(engine.running,false);assert.match(engine.pausedReason,/核对/); const trade=store.allTrades()[0];assert.equal(trade.status,'NEEDS_REVIEW');
  assert(BigInt(store.getReservedInventory({mode:'demo',chain:'solana',address:'demo-solana-token'}))>0n);
  if(!options.throwStage) assert.equal(adapter.sent.length,1);
  engine.acknowledge({tradeId:trade.id,note:'已核对实际回执及两侧库存'});
  assert.equal(store.getReservedInventory({mode:'demo',chain:'solana',address:'demo-solana-token'}),'0');
});

test('inventory snapshot rejects a bridge leg and unconfirmed or repeated sell',async t=>{
  const {engine}=await setup(t);const trade={type:'arbitrage',buyChain:'bnb',sellChain:'solana',amountUsd:5,...policyRecord(engine.config),legs:[]};
  assert.throws(()=>intentForLeg(trade,'SELL'),/买入确认/);assert.throws(()=>intentForLeg(trade,'BRIDGE'),/禁止跨链/);
  const confirmed={name:'BUY',status:'CONFIRMED',receipt:{confirmed:true,receivedRaw:'1000000000000000000'}};
  trade.legs=[confirmed];assert.equal(intentForLeg(trade,'SELL').amountInRaw,'1000000000');
  trade.legs.push({name:'SELL',status:'CONFIRMED',receipt:{confirmed:true}});assert.throws(()=>intentForLeg(trade,'SELL'));
  const changed=structuredClone(engine.config);changed.inventory.mappingEvidence='other verified mapping';assert.notDeepEqual(createPolicySnapshot(changed),trade.policySnapshot);
});

test('inventory never auto-rebalances and approved-assets coordinator prevents configured-pair fallback',async t=>{
  const {engine,adapter}=await setup(t,{},c=>{c.rebalance.enabled=true;c.inventory.scanApprovedAssets=true;});
  engine.balances={bnb:{stableUsd:4},solana:{stableUsd:20}};assert.equal(engine.rebalanceRequest(),null);
  let ticks=0;engine.inventoryCoordinator={active:()=>true,tick:async()=>{ticks++;}};engine.running=true;await engine.refresh();assert.equal(ticks,1);assert.equal(adapter.sent.length,0);assert.equal(adapter.bridgeCalls,0);
});

test('per-asset execution guard is checked before entry and before sell after asynchronous confirmation',async t=>{
  const {engine,store,adapter}=await setup(t,{afterConfirm:name=>{if(name==='BUY')engine.executionGuard=()=>{throw safe('approved asset mapping changed');};}});
  await assert.rejects(engine.execute(),/mapping changed/);assert.equal(adapter.sent.length,1);assert.equal(store.allTrades()[0].status,'NEEDS_REVIEW');
});

test('demo inventory persists/depletes actual high-side tokens and isolates another asset',async t=>{
  const {engine,store}=await setup(t);engine.adapter=new DemoAdapter({getConfig:()=>engine.config,store});
  const original=(await engine.adapter.balances('solana')).tokenRaw;
  const trade=await engine.execute();const after=(await engine.adapter.balances('solana')).tokenRaw;
  assert.equal(BigInt(original)-BigInt(after),BigInt(trade.actual.soldRaw));
  const restarted=new DemoAdapter({getConfig:()=>engine.config,store});assert.equal((await restarted.balances('solana')).tokenRaw,after);
  const other=structuredClone(engine.config);other.inventory.assetId='other';other.chains.solana.tokenAddress='So11111111111111111111111111111111111111112';other.chains.bnb.tokenAddress='0x2222222222222222222222222222222222222222';
  const another=new DemoAdapter({getConfig:()=>other,store});assert.equal((await another.balances('solana')).tokenRaw,'1000000000000');
  assert.equal((await another.balances('solana')).stableUsd,(await restarted.balances('solana')).stableUsd,'stable/native funds shared across asset contexts');
});
