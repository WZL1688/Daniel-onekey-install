import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryClient, normalizePools } from '../src/opportunities/sources.mjs';
import { MarketNetwork } from '../src/market-network.mjs';
const now = Date.parse('2026-11-22T05:00:00Z');
const a = '0x1111111111111111111111111111111111111111', b = '0x2222222222222222222222222222222222222222', p = '0x3333333333333333333333333333333333333333';
const sol = '11111111111111111111111111111112';
const pair = patch => ({ chainId: 'bsc', pairAddress: p, baseToken: { address: a }, quoteToken: { address: b }, priceUsd: '20', priceNative: '4', liquidity: { usd: 100000 }, volume: { h24: 100000, h1: 1000 }, txns: { h1: { buys: 4, sells: 5 } }, ...patch });
const json = body => new Response(JSON.stringify(body));

test('the requested quote token uses the verified base/native ratio and keeps whole-pool activity', () => {
  const [row] = normalizePools([pair()], { chain: 'bnb', addresses: [b], observedAt: now });
  assert.equal(row.tokenAddress, b); assert.equal(row.quoteAddress, a); assert.equal(row.priceUsd, 5); assert.equal(row.priceMethod, 'derived-from-base-native');
  assert.equal(row.volume1hUsd, 1000); assert.equal(row.trades1h, 9); assert.equal(row.sourceUpdatedAt, null);
});

test('both requested sides of the same pool remain independently priced without identity collisions', () => {
  const rows = normalizePools([pair(),pair()], { chain: 'bnb', addresses: [a,b], observedAt: now });
  assert.equal(rows.length, 2); assert.equal(rows.find(row=>row.tokenAddress===a).priceUsd,20); assert.equal(rows.find(row=>row.tokenAddress===a).priceMethod,'provider-base-usd'); assert.equal(rows.find(row=>row.tokenAddress===b).priceUsd,5);
  assert.deepEqual(normalizePools([pair(),pair({ priceUsd:'21' })],{ chain:'bnb',addresses:[a,b],observedAt:now }),[]);
});

test('missing or invalid quote ratios cannot copy a base price into the other token', () => {
  for (const value of [undefined,0,-1,'NaN',Infinity,'0x10']) assert.deepEqual(normalizePools([pair({ priceNative:value })],{chain:'bnb',addresses:[b],observedAt:now}),[]);
});

test('hourly trade metrics stay unknown when invalid, pool creation is not a last-trade timestamp', () => {
  for (const txns of [undefined,{h1:{buys:1}},{h1:{buys:1.5,sells:2}},{h1:{buys:-1,sells:2}},{h1:{buys:Number.MAX_SAFE_INTEGER,sells:1}}]) {
    const [row]=normalizePools([pair({ txns,pairCreatedAt:now })],{chain:'bnb',addresses:[a],observedAt:now});
    assert.equal(row.trades1h,null);assert.equal(row.sourceUpdatedAt,null);assert.equal(row.lastTradeAt,undefined);
  }
});

test('CoinPaprika makes two independently budgetable fixed platform reads without leaking a CoinGecko key', async () => {
  const calls=[],client=new DiscoveryClient({now:()=>now,fetchImpl:async(url,options)=>{calls.push({url,options});return json([{id:'alt-example',address:url.endsWith('sol-solana')?sol:a,symbol:'IGNORED',approved:true}]);}});
  assert.deepEqual(await client.contracts({chain:'bnb'}),[{coinId:'alt-example',address:a}]);
  assert.deepEqual(await client.contracts({chain:'solana'}),[{coinId:'alt-example',address:sol}]);
  assert.deepEqual(calls.map(c=>c.url),['https://api.coinpaprika.com/v1/contracts/bnb-binance-coin','https://api.coinpaprika.com/v1/contracts/sol-solana']);
  for (const call of calls) {assert.deepEqual(call.options.headers,{Accept:'application/json'});assert.equal(call.options.redirect,'error');assert(call.options.signal instanceof AbortSignal);}
  const before=calls.length;await assert.rejects(client.contracts({chain:'../other'}),{code:'DISCOVERY_FORMAT'});assert.equal(calls.length,before);
});

test('malformed and oversized CoinPaprika responses retain safe HTTP diagnostics',async()=>{
  for(const body of [{rows:[]},Array(50001).fill(null)]) {
    const client=new DiscoveryClient({fetchImpl:async()=>json(body),now:()=>now});
    await assert.rejects(client.contracts({chain:'bnb'}),error=>error.safe&&error.code==='DISCOVERY_FORMAT'&&error.httpStatus===200);
  }
  const client=new DiscoveryClient({fetchImpl:async()=>new Response('secret-response',{status:429,headers:{'Retry-After':'120'}})});
  await assert.rejects(client.contracts({chain:'bnb'}),error=>error.code==='DISCOVERY_RATE_LIMIT'&&error.retryAfterMs===120000&&!error.message.includes('secret-response'));
});

test('market transport permits the new provider only at its fixed HTTPS host',async()=>{
  let calls=0;const network=new MarketNetwork({env:{},fetchImpl:async()=>{calls++;return json([])}});
  try {await network.fetch('https://api.coinpaprika.com/v1/contracts/bnb-binance-coin');assert.equal(calls,1);await assert.rejects(network.fetch('https://coinpaprika.example/v1/contracts/bnb-binance-coin'),{code:'MARKET_NETWORK_TARGET'});assert.equal(calls,1);}finally{await network.close();}
});
