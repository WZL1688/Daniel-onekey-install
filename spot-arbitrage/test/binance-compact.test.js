import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent } from 'undici';
import { Exchanges, transport } from '../src/exchanges.js';
import { diagnoseNetwork } from '../scripts/diagnose-network.js';
import { setup, scheduler, sleep } from './helpers.js';

function exchangeInfo() {
  return {
    timezone: 'UTC', serverTime: Date.now(),
    rateLimits: [
      { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 6000 },
      { rateLimitType: 'RAW_REQUESTS', interval: 'MINUTE', intervalNum: 5, limit: 61000 },
      { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50 },
    ],
    symbols: ['BTC', 'ETH', 'SOL', 'ADA'].map((asset, index) => ({
      symbol: asset + 'USDT', baseAsset: asset, quoteAsset: 'USDT',
      status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT', 'MARKET'],
      filters: [
        { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: String(10000 + index), stepSize: '0.00001000' },
        { filterType: 'PRICE_FILTER', minPrice: '0.00010000', maxPrice: '1000000.00000000', tickSize: '0.00010000' },
        { filterType: 'NOTIONAL', minNotional: '5.00000000', maxNotional: '10000000.00000000', applyMinToMarket: true, applyMaxToMarket: false, avgPriceMins: 5 },
        { filterType: 'MAX_POSITION', maxPosition: String(20000 + index) },
      ],
    })),
  };
}

test('真实本地HTTP复现冗余权限数据超限，精简规则仍保留全市场过滤器与20权重公共调度', async t => {
  const x = setup(t), queue = scheduler(t, x.store), dispatcher = new Agent();
  const compact = exchangeInfo(), received = [], calls = [];
  // Synthetic fixture only: its size is not a measurement of Binance's response.
  const expanded = JSON.stringify({ ...compact, symbols: compact.symbols.map((symbol, index) => ({
    ...symbol, permissionSets: index ? [['SPOT']] : [['SPOT'], ['SYNTHETIC_' + 'P'.repeat(15000000)]],
  })) });
  assert.ok(Buffer.byteLength(expanded) > 15000000);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const seen = { url, method: req.method, headers: req.headers, bodyBytes: 0 };
    received.push(seen); req.on('data', chunk => { seen.bodyBytes += chunk.length; });
    res.setHeader('Content-Type', 'application/json');
    res.end(url.searchParams.get('showPermissionSets') === 'false' ? JSON.stringify(compact) : expanded);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await dispatcher.close(); await new Promise(resolve => server.close(resolve)); });
  const local = 'http://127.0.0.1:' + server.address().port;
  await assert.rejects(transport({ url: local + '/api/v3/exchangeInfo', method: 'GET', mutation: false, dispatcher }), error => {
    assert.equal(error.status, 200); assert.equal(error.code, 'RESPONSE_TOO_LARGE');
    assert.equal(error.unknown, false); assert.match(error.message, /15000000 字节上限/);
    assert.doesNotMatch(error.message, /SYNTHETIC_|PPPPPP/); return true;
  });

  const adapter = new Exchanges(x.store, x.vault, queue, request => {
    const upstream = new URL(request.url);
    assert.equal(upstream.origin, 'https://api.binance.com');
    calls.push(request);
    return transport({ ...request, url: local + upstream.pathname + upstream.search, dispatcher });
  });
  await adapter.rules('binance');
  await sleep(0); // Let the scheduler persist completion before cleanup assertions.
  assert.equal(x.store.state.keys.length, 0);
  assert.equal(calls.length, 1);
  const requested = new URL(calls[0].url);
  assert.deepEqual([...requested.searchParams], [['showPermissionSets', 'false']]);
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].mutation, false);
  assert.deepEqual(calls[0].headers, {});
  assert.equal(received.length, 2, 'Only one legacy probe and one compact request are sent');
  for (const request of received) {
    assert.equal(request.method, 'GET'); assert.equal(request.bodyBytes, 0);
    assert.equal(request.headers['x-mbx-apikey'], undefined);
    assert.equal(request.headers['ok-access-key'], undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.url.searchParams.has('signature'), false);
  }
  assert.deepEqual(x.store.state.exchangeMeta.binance.rateLimits, compact.rateLimits);
  const rules = x.store.state.rules.binance;
  assert.deepEqual(Object.keys(rules).sort(), ['ADA/USDT', 'BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  assert.equal(x.store.state.config.pairs.includes('ADA/USDT'), false);
  for (const symbol of compact.symbols) {
    const rule = rules[symbol.baseAsset + '/USDT'];
    assert.equal(rule.enabled, true); assert.equal(rule.symbol, symbol.symbol);
    assert.deepEqual(rule.filters, symbol.filters);
    assert.equal(rule.step, '0.00001000'); assert.equal(rule.tick, '0.00010000');
    assert.equal(rule.minNotional, '5.00000000'); assert.equal(rule.maxNotional, '10000000.00000000');
    assert.equal(rule.minQty, symbol.filters[0].minQty); assert.equal(rule.maxQty, symbol.filters[0].maxQty);
    assert.equal(rule.minPrice, '0.00010000'); assert.equal(rule.maxPrice, '1000000.00000000');
  }
  const rate = queue.rate('binance');
  assert.equal(rate.windows.configured.used, 20);
  assert.equal(rate.metrics.public, 1); assert.equal(rate.metrics.private, 0);
  assert.equal(rate.metrics.orders, 0); assert.equal(rate.metrics.failures, 0);
});

test('独立诊断与应用使用同一精简参数，保留所有现货市场且不携带私人凭据', async () => {
  const seen = [], compact = exchangeInfo();
  const report = await diagnoseNetwork({ fetchFn: async (url, options) => {
    const parsed = new URL(url); seen.push({ parsed, options });
    let data;
    if (parsed.pathname === '/api/v3/time') data = { serverTime: Date.now() };
    else if (parsed.pathname === '/api/v3/exchangeInfo') {
      assert.deepEqual([...parsed.searchParams], [['showPermissionSets', 'false']]);
      data = compact;
    } else if (parsed.pathname === '/api/v3/depth') data = { lastUpdateId: 1, bids: [['99', '10']], asks: [['100', '10']] };
    else if (parsed.pathname === '/api/v5/public/time') data = { code: '0', data: [{ ts: String(Date.now()) }] };
    else if (parsed.pathname === '/api/v5/public/instruments') data = { code: '0', data: [{ instId: 'ETH-USDT' }] };
    else if (parsed.pathname === '/api/v5/market/books') data = { code: '0', data: [{ ts: String(Date.now()), bids: [['99', '10']], asks: [['100', '10']] }] };
    else throw Error('Unexpected diagnostic route');
    return new Response(JSON.stringify(data), { status: 200 });
  } });
  assert.equal(report.diagnosticsPassed, true); assert.equal(report.publicRequests, 6);
  assert.equal(report.exchanges.binance.requests[1].items, 4);
  assert.equal(report.privateRequests, 0); assert.equal(report.orderRequests, 0);
  assert.equal(seen.filter(({ parsed }) => parsed.pathname === '/api/v3/exchangeInfo').length, 1);
  for (const { options } of seen) {
    assert.equal(options.method, 'GET'); assert.equal(options.headers, undefined);
    assert.equal(options.body, undefined); assert.equal(options.redirect, 'error');
  }
});
