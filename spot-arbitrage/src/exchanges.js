import crypto from 'node:crypto';
import { fetch, EnvHttpProxyAgent } from 'undici';
import { parse } from 'lossless-json';
import { ApiError } from './scheduler.js';
import { D, decimal, normalizeBook, pair, validateOrder } from './math.js';
const ORIGINS = { binance: 'https://api.binance.com', okx: 'https://www.okx.com' };
const dispatcher = new EnvHttpProxyAgent();
export const parseExchangeJson = text => parse(text, undefined, { parseNumber: value => Number.isSafeInteger(Number(value)) ? Number(value) : value });
export function signBinance(secret, params) { const payload = new URLSearchParams(params).toString(); return { payload, signature: crypto.createHmac('sha256', secret).update(payload).digest('hex') }; }
export function signOkx(secret, timestamp, method, requestPath, body = '') { return crypto.createHmac('sha256', secret).update(timestamp + method.toUpperCase() + requestPath + body).digest('base64'); }
export async function transport({ url, method, headers, body, mutation, dispatcher: requestDispatcher = dispatcher }) {
  let response;
  try { response = await fetch(url, { method, headers, body: body || undefined, dispatcher: requestDispatcher, signal: AbortSignal.timeout(10000), redirect: 'error' }); }
  catch (e) { throw new ApiError(`网络请求失败 (${e.cause?.code || e.code || e.name})${mutation ? '；提交结果未知，禁止自动重发' : ''}`, { code: e.cause?.code || e.code || e.name, unknown: mutation }); }
  const resultHeaders = Object.fromEntries(response.headers);
  let data;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 15000000) throw Error('RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
    data = parseExchangeJson(Buffer.concat(chunks).toString('utf8'));
  }
  catch { throw new ApiError(`HTTP ${response.status} 返回畸形或过大数据`, { status: response.status, retryAfter: response.headers.get('retry-after'), unknown: mutation }); }
  return { status: response.status, headers: resultHeaders, data };
}
export class Exchanges {
  constructor(store, vault, scheduler, request = transport) { this.store = store; this.vault = vault; this.scheduler = scheduler; this.transport = request; this.rotations = {}; }
  chooseQuery(exchange, explicitId, allowUnverified = false) {
    const keys = this.store.state.keys.filter(k => k.exchange === exchange && k.role === 'query' && k.enabled &&
      (explicitId ? k.id === explicitId : allowUnverified || k.status === 'VERIFIED'));
    if (!keys.length) throw Error(`${exchange} 没有${allowUnverified ? '' : '已验证同账户的'}查询 Key；交易 Key 不可查询`);
    const index = (this.rotations[exchange] ||= 0) % keys.length; this.rotations[exchange]++;
    return keys[index];
  }
  chooseTrade(exchange) {
    const uid = this.store.state.accounts[exchange];
    const key = this.store.state.keys.find(k => k.exchange === exchange && k.role === 'trade' && k.enabled && k.attested && k.accountUid === uid);
    if (!key) throw Error(`${exchange} 缺少声明归属同账户 UID 的交易 Key`);
    return key;
  }
  request(exchange, { path, method = 'GET', params = {}, body, priority = 1, weight = 1, endpointCap = 4, key, mutation = false, dedupe, allowCode, onSend, beforeSend }) {
    if (key && ((mutation && key.role !== 'trade') || (!mutation && key.role !== 'query'))) throw Error('Key 角色隔离：交易 Key 禁止查询，查询 Key 禁止下单');
    if (!mutation && method !== 'GET') throw Error('非交易请求只能使用 GET');
    if (mutation && !key) throw Error('交易请求缺少专用交易 Key');
    const kind = mutation ? 'order' : key ? 'private' : 'public';
    return this.scheduler.enqueue({ exchange, route: path, kind, priority, weight, endpointCap, dedupe }, async () => {
      if (beforeSend) {
        try { beforeSend(); } catch (e) { throw new ApiError(e.message, { code: 'PRE_SUBMIT_GUARD', unknown: false }); }
      }
      let headers = {}, query = new URLSearchParams(params).toString(), requestBody = body ? JSON.stringify(body) : '';
      if (key) {
        const credential = this.vault.open(key), clock = this.store.state.exchangeMeta[exchange]?.clock;
        if (!clock || Date.now() - clock.at > 300000 || Math.abs(clock.offset) > 30000) throw new ApiError('服务器时间未同步或偏差过大，禁止签名请求', { code: 'CLOCK' });
        const at = Date.now() + clock.offset;
        if (exchange === 'binance') {
          const signed = signBinance(credential.secret, { ...params, recvWindow: '5000', timestamp: String(Math.floor(at)) });
          query = signed.payload + '&signature=' + signed.signature; headers['X-MBX-APIKEY'] = credential.apiKey;
        } else {
          const timestamp = new Date(at).toISOString(), requestPath = path + (query ? '?' + query : '');
          Object.assign(headers, { 'OK-ACCESS-KEY': credential.apiKey, 'OK-ACCESS-PASSPHRASE': credential.passphrase,
            'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-SIGN': signOkx(credential.secret, timestamp, method, requestPath, requestBody) });
        }
        key.requests++; key.lastAt = Date.now(); this.store.save();
      }
      if (requestBody) headers['Content-Type'] = 'application/json';
      try {
        onSend?.();
        const result = await this.transport({ url: ORIGINS[exchange] + path + (query ? '?' + query : ''), method, headers, body: requestBody, mutation });
        this.scheduler.observeHeaders(exchange, result.headers);
        const { data, status } = result;
        const businessError = exchange === 'binance' ? typeof data?.code === 'number' && data.code < 0 : data?.code !== '0';
        if (allowCode && String(data?.code) === String(allowCode) && status < 500) return data;
        if (status < 200 || status >= 300 || businessError) {
          const code = String(data?.code ?? 'BAD_RESPONSE');
          const definitelyRejected = exchange === 'binance' && [-1013, -1021, -1022, -2010, -2014, -2015, -1111, -1100, -1102].includes(Number(code));
          throw new ApiError(`${exchange} HTTP ${status}，错误代码 ${/^-?\d+$/.test(code) ? code : 'BAD_RESPONSE'}`, {
            status, code, retryAfter: result.headers['retry-after'], unknown: mutation && !definitelyRejected,
          });
        }
        return data;
      } catch (error) { if (key) { key.failures++; key.lastError = `HTTP ${error.status || 0} / ${error.code || 'NETWORK'}`; } throw error; }
    });
  }
  async syncClock(exchange, priority = 1) {
    if (Date.now() - (this.store.state.exchangeMeta[exchange]?.clock?.at || 0) < 60000) return;
    let start;
    const data = await this.request(exchange, { path: exchange === 'binance' ? '/api/v3/time' : '/api/v5/public/time', priority, onSend: () => { start = Date.now(); }, endpointCap: 4 });
    const end = Date.now(), serverTime = Number(exchange === 'binance' ? data.serverTime : data.data?.[0]?.ts);
    if (!Number.isFinite(serverTime) || end - start > 2000) throw Error('时间同步往返延迟超过 2 秒或服务器时间无效');
    (this.store.state.exchangeMeta[exchange] ||= {}).clock = { at: end, offset: serverTime - (start + end) / 2, rtt: end - start };
    this.store.save();
  }
  async rules(exchange, priority = 1, force = false) {
    const old = this.store.state.exchangeMeta[exchange];
    if (!force && old?.rulesAt && Date.now() - old.rulesAt < 3600000) return;
    const data = await this.request(exchange, { path: exchange === 'binance' ? '/api/v3/exchangeInfo' : '/api/v5/public/instruments',
      params: exchange === 'binance' ? {} : { instType: 'SPOT' }, priority, weight: exchange === 'binance' ? 20 : 1, dedupe: exchange + ':rules', endpointCap: 4 });
    const rules = {};
    if (exchange === 'binance') {
      if (!Array.isArray(data.symbols) || !Array.isArray(data.rateLimits) || data.symbols.length === 0) throw Error('Binance 交易规则响应错误');
      for (const x of data.symbols) {
        if (!x.baseAsset || !x.quoteAsset || x.symbol !== x.baseAsset + x.quoteAsset || !Array.isArray(x.filters)) continue;
        const filters = Object.fromEntries(x.filters.map(f => [f.filterType, f]));
        if (!filters.LOT_SIZE || !filters.PRICE_FILTER) continue;
        const lot = filters.LOT_SIZE, price = filters.PRICE_FILTER, notional = filters.NOTIONAL || filters.MIN_NOTIONAL;
        const id = `${x.baseAsset}/${x.quoteAsset}`;
        rules[id] = { symbol: x.symbol, enabled: x.status === 'TRADING' && x.isSpotTradingAllowed === true && x.orderTypes?.includes('LIMIT'),
          step: lot.stepSize, tick: price.tickSize, minQty: lot.minQty, maxQty: lot.maxQty, minPrice: price.minPrice, maxPrice: price.maxPrice,
          minNotional: notional?.minNotional || '0', maxNotional: notional?.maxNotional || null, filters: x.filters, at: Date.now() };
      }
      for (const r of data.rateLimits) if (!['REQUEST_WEIGHT', 'ORDERS', 'RAW_REQUESTS'].includes(r.rateLimitType) || !['SECOND', 'MINUTE', 'HOUR', 'DAY'].includes(r.interval) || !Number.isSafeInteger(r.intervalNum) || r.intervalNum < 1 || !Number.isSafeInteger(r.limit) || r.limit < 1) throw Error('未知 Binance 限速规则，停止接入');
      (this.store.state.exchangeMeta[exchange] ||= {}).rateLimits = data.rateLimits;
    } else {
      if (!Array.isArray(data.data) || data.data.length === 0) throw Error('OKX 交易规则响应错误');
      for (const x of data.data) if (x.instType === 'SPOT' && x.baseCcy && x.quoteCcy && x.instId === x.baseCcy + '-' + x.quoteCcy) rules[`${x.baseCcy}/${x.quoteCcy}`] = {
        symbol: x.instId, enabled: x.state === 'live', step: x.lotSz, tick: x.tickSz, minQty: x.minSz,
        maxQty: x.maxLmtSz || null, minNotional: '0', maxNotional: x.maxLmtAmt || null, at: Date.now(),
      };
    }
    this.store.state.rules[exchange] = rules; (this.store.state.exchangeMeta[exchange] ||= {}).rulesAt = Date.now(); this.store.save();
  }
  async book(exchange, id, priority = 1, { persist = true } = {}) {
    pair(id); const rule = this.store.state.rules[exchange]?.[id];
    if (!rule?.enabled) throw Error(`${exchange} ${id} 无有效现货规则`);
    const data = await this.request(exchange, { path: exchange === 'binance' ? '/api/v3/depth' : '/api/v5/market/books',
      params: exchange === 'binance' ? { symbol: rule.symbol, limit: '100' } : { instId: rule.symbol, sz: '400' },
      priority, weight: exchange === 'binance' ? 5 : 1, endpointCap: 8, dedupe: `${exchange}:book:${id}` });
    const x = exchange === 'binance' ? data : data.data?.[0];
    if (!x || (x.instId && x.instId !== rule.symbol) || (exchange === 'binance' && !Number.isSafeInteger(x.lastUpdateId))) throw Error('盘口标识错误');
    const normalized = normalizeBook({ pair: id, bids: x.bids, asks: x.asks, at: Date.now(), exchangeAt: x.ts ? Number(x.ts) : null, depthLimit: exchange === 'binance' ? 100 : 400 }, id);
    if (normalized.exchangeAt && Date.now() - normalized.exchangeAt > this.store.state.config.maxBookAgeMs) throw Error('交易所盘口时间已过期');
    if (persist) { (this.store.state.books[exchange] ||= {})[id] = normalized; this.store.save(); } return normalized;
  }
  async validateKey(id) {
    const key = this.store.state.keys.find(k => k.id === id);
    if (!key || key.role !== 'query' || !key.enabled) throw Error('仅允许验证启用的查询 Key；交易 Key 禁止查询');
    await this.syncClock(key.exchange, 3);
    try {
      const data = await this.request(key.exchange, { path: key.exchange === 'binance' ? '/api/v3/account' : '/api/v5/account/config',
        key, priority: 3, weight: key.exchange === 'binance' ? 20 : 1 });
      const uid = String(key.exchange === 'binance' ? data.uid ?? '' : data.data?.[0]?.uid ?? '');
      if (!/^\d+$/.test(uid)) throw Error('交易所未返回账户 UID，无法验证同账户');
      const old = this.store.state.accounts[key.exchange];
      if (old && old !== uid) throw Error('查询 Key 属于不同账户，已隔离，不能轮换');
      key.accountUid = uid; key.status = 'VERIFIED'; delete key.lastError;
      this.store.state.accounts[key.exchange] = uid; this.store.save(); return uid;
    } catch (e) { key.status = 'FAILED'; key.lastError = e.message; this.store.save(); throw e; }
  }
  async balances(exchange, priority = 3) {
    try {
      const key = this.chooseQuery(exchange);
      if (key.accountUid !== this.store.state.accounts[exchange]) throw Error('查询 Key 账户不匹配');
      await this.syncClock(exchange, priority);
      const data = await this.request(exchange, { path: exchange === 'binance' ? '/api/v3/account' : '/api/v5/account/balance', key, priority, weight: exchange === 'binance' ? 20 : 1 });
      if (exchange === 'binance' && String(data.uid) !== key.accountUid) throw Error('查询返回账户 UID 已变化');
      const assets = {};
      const rows = exchange === 'binance' ? data.balances : data.data?.[0]?.details;
      if (!Array.isArray(rows)) throw Error('余额响应格式错误');
      for (const x of rows) {
        const ccy = exchange === 'binance' ? x.asset : x.ccy;
        if (!/^[A-Z0-9]{1,20}$/.test(ccy)) continue;
        const free = decimal(exchange === 'binance' ? x.free : x.availBal || '0', '可用余额', { zero: true });
        const locked = decimal(exchange === 'binance' ? x.locked : x.frozenBal || '0', '冻结余额', { zero: true });
        assets[ccy] = { free: free.toString(), locked: locked.toString(), total: free.plus(locked).toString() };
      }
      this.store.state.balances[exchange] = { assets, at: Date.now(), valid: true, accountUid: key.accountUid };
      this.store.save(); return this.store.state.balances[exchange];
    } catch (e) {
      const old = this.store.state.balances[exchange] ||= { assets: {}, at: 0 };
      old.valid = false; old.error = `余额更新失败，保留旧数据并暂停该路径：${e.message}`;
      this.store.save(); throw e;
    }
  }
  async order(exchange, { pair: id, side, qty, price, clientId, guard }) {
    if (typeof guard !== 'function') throw new ApiError('缺少统一最终复核保护，拒绝下单', { unknown: false });
    const key = this.chooseTrade(exchange), rule = this.store.state.rules[exchange]?.[id];
    if (!rule?.enabled || !['BUY', 'SELL'].includes(side) || !/^[a-zA-Z0-9]{1,32}$/.test(clientId)) throw Error('订单参数错误');
    validateOrder(rule, qty, price);
    const data = await this.request(exchange, exchange === 'binance' ? {
      path: '/api/v3/order', method: 'POST', key, mutation: true, priority: 0, beforeSend: guard,
      params: { symbol: rule.symbol, side, type: 'LIMIT', timeInForce: 'IOC', quantity: qty, price, newClientOrderId: clientId, newOrderRespType: 'ACK' },
    } : { path: '/api/v5/trade/order', method: 'POST', key, mutation: true, priority: 0, beforeSend: guard,
      body: { instId: rule.symbol, tdMode: 'cash', side: side.toLowerCase(), ordType: 'ioc', sz: qty, px: price, clOrdId: clientId },
    });
    const item = exchange === 'binance' ? data : data.data?.[0];
    if (exchange === 'okx' && item?.sCode !== '0') throw new ApiError(`OKX 下单未确认 (${item?.sCode || 'BAD_ACK'})`, { code: item?.sCode, unknown: true });
    const orderId = String(exchange === 'binance' ? item?.orderId ?? '' : item?.ordId ?? '');
    if (!/^\d+$/.test(orderId)) throw new ApiError('下单响应没有有效订单号；提交结果未知', { unknown: true });
    key.status = 'WORKING_NOT_QUERIED'; this.store.save();
    return { orderId, status: 'ACKNOWLEDGED', clientId };
  }
  async assertNoOpenOrders(exchange, id) {
    const rule = this.store.state.rules[exchange]?.[id], key = this.chooseQuery(exchange);
    const data = await this.request(exchange, { path: exchange === 'binance' ? '/api/v3/openOrders' : '/api/v5/trade/orders-pending',
      params: exchange === 'binance' ? { symbol: rule.symbol } : { instType: 'SPOT', instId: rule.symbol }, key, priority: 0, weight: exchange === 'binance' ? 6 : 1 });
    const rows = exchange === 'binance' ? data : data.data;
    if (!Array.isArray(rows)) throw Error(`${exchange} 开放订单响应错误`);
    if (rows.length) throw Error(`${exchange} ${id} 有 ${rows.length} 笔开放订单，禁止新批次`);
  }
  async priceContext(exchange, id) {
    if (exchange !== 'binance') return null;
    const rule = this.store.state.rules[exchange]?.[id];
    const filters = rule?.filters?.filter(f => ['PERCENT_PRICE', 'PERCENT_PRICE_BY_SIDE'].includes(f.filterType)) || [];
    if (!filters.length) return null;
    const ref = await this.request(exchange, { path: '/api/v3/referencePrice', params: { symbol: rule.symbol }, priority: 0, weight: 2, allowCode: '-2043' });
    if (ref.referencePrice != null) return { reference: decimal(ref.referencePrice).toString(), at: Date.now() };
    const avg = await this.request(exchange, { path: '/api/v3/avgPrice', params: { symbol: rule.symbol }, priority: 0, weight: 2 });
    if (!filters.every(f => f.avgPriceMins === avg.mins)) throw Error('百分比价格过滤器与公开均价周期不一致，无法可靠复核，取消批次');
    return { reference: decimal(avg.price).toString(), at: Date.now() };
  }
  assertPriceContext(exchange, id, side, qty, price, context) {
    const rule = this.store.state.rules[exchange]?.[id]; validateOrder(rule, qty, price);
    if (exchange !== 'binance') return;
    for (const f of rule.filters || []) {
      if (['PERCENT_PRICE', 'PERCENT_PRICE_BY_SIDE'].includes(f.filterType)) {
        if (!context || Date.now() - context.at > 10000) throw Error('价格百分比复核上下文缺失或过期');
        const up = f.filterType === 'PERCENT_PRICE' ? f.multiplierUp : side === 'BUY' ? f.bidMultiplierUp : f.askMultiplierUp;
        const down = f.filterType === 'PERCENT_PRICE' ? f.multiplierDown : side === 'BUY' ? f.bidMultiplierDown : f.askMultiplierDown;
        if (D(price).gt(D(context.reference).mul(up)) || D(price).lt(D(context.reference).mul(down))) throw Error('限价不满足交易所百分比价格过滤器');
      }
      if (f.filterType === 'MAX_POSITION' && side === 'BUY') {
        const base = pair(id).base, held = this.store.state.balances[exchange]?.assets[base]?.total || '0';
        if (D(held).plus(qty).gt(f.maxPosition)) throw Error('买入后超过 Binance 最大持仓过滤器');
      }
    }
  }
  async cancel(exchange, id, orderId) {
    if (!/^\d+$/.test(String(orderId))) throw Error('订单号错误');
    const key = this.chooseTrade(exchange), symbol = this.store.state.rules[exchange]?.[id]?.symbol;
    const data = await this.request(exchange, exchange === 'binance' ? { path: '/api/v3/order', method: 'DELETE', params: { symbol, orderId }, key, mutation: true, priority: 0 } :
      { path: '/api/v5/trade/cancel-order', method: 'POST', body: { instId: symbol, ordId: orderId }, key, mutation: true, priority: 0 });
    if (exchange === 'okx' && data.data?.[0]?.sCode !== '0') throw new ApiError('OKX 撤单未确认', { unknown: true });
    return { status: 'CANCEL_ACKNOWLEDGED' }; // A cancel acknowledgment does not prove no fill.
  }
}
