export function marketFixture(request) {
  const url = new URL(request.url), binance = url.hostname === 'api.binance.com';
  const symbols = ['BTC', 'ETH', 'SOL'];
  let data;
  if (url.pathname === '/api/v3/exchangeInfo') data = {
    rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 6000 }, { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50 }, { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160000 }, { rateLimitType: 'RAW_REQUESTS', interval: 'MINUTE', intervalNum: 5, limit: 61000 }],
    symbols: symbols.map(asset => ({ symbol: asset + 'USDT', baseAsset: asset, quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true, orderTypes: ['LIMIT'],
      filters: [{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100000', stepSize: '0.0001' }, { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '10000000', tickSize: '0.01' }, { filterType: 'MIN_NOTIONAL', minNotional: '5' }] })),
  };
  else if (url.pathname === '/api/v5/public/instruments') data = { code: '0', data: symbols.map(asset => ({ instType: 'SPOT', instId: asset + '-USDT', baseCcy: asset, quoteCcy: 'USDT', state: 'live', lotSz: '0.0001', tickSz: '0.01', minSz: '0.0001', maxLmtSz: '100000' })) };
  else if (url.pathname === '/api/v3/depth' || url.pathname === '/api/v5/market/books') {
    const id = url.searchParams.get('symbol') || url.searchParams.get('instId');
    const base = id.startsWith('BTC') ? 65000 : id.startsWith('ETH') ? 3000 : 150;
    const price = base + (binance ? 0 : base * 0.004);
    const b = { bids: [[String(price - 1), '100'], [String(price - 2), '200']], asks: [[String(price), '100'], [String(price + 1), '200']] };
    data = binance ? { lastUpdateId: Date.now(), ...b } : { code: '0', data: [{ ...b, ts: String(Date.now()) }] };
  } else throw Error('Fixture 不允许私人接口或订单请求');
  return Promise.resolve({ status: 200, headers: {}, data });
}
