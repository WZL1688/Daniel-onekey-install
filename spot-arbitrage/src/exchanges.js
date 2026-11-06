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
function validateAssetFilters(filters, id) {
  if (!Array.isArray(filters)) throw Error('Binance 账户资产过滤器响应错误');
  const { base, quote } = pair(id), assets = new Set();
  return filters.map(filter => {
    if (!filter || filter.filterType !== 'MAX_ASSET') throw Error('未知 Binance 账户资产过滤器，停止接入');
    if (![base, quote].includes(filter.asset) || assets.has(filter.asset)) throw Error('Binance 账户资产过滤器交易对不匹配或重复');
    assets.add(filter.asset);
    return { filterType: 'MAX_ASSET', asset: filter.asset, limit: decimal(filter.limit, 'MAX_ASSET 限额', { zero: true }).toString() };
  });
}
function okxAccount(data, expectedUid) {
  if (!Array.isArray(data?.data) || data.data.length !== 1) throw Error('OKX 账户配置响应错误');
  const account = data.data[0], uid = String(account?.uid ?? '');
  if (!/^\d+$/.test(uid) || (expectedUid && uid !== expectedUid)) throw Error('OKX 账户 UID 缺失或不匹配');
  if (!['1', '2'].includes(account.acctLv)) throw Error('OKX 仅支持现货模式或合约模式下的 cash 现货账户；当前账户模式不受支持');
  if (account.roleType !== '0' || account.spotRoleType !== '0') throw Error('OKX 带单、跟单或未知账户角色不受支持');
  return { accountUid: uid, accountMode: account.acctLv, roleType: account.roleType, spotRoleType: account.spotRoleType };
}
export async function transport({ url, method, headers, body, mutation, dispatcher: requestDispatcher = dispatcher }) {
  const startedAt = Date.now(), signal = AbortSignal.timeout(10000), maxBytes = 15000000;
  let response, size = 0;
  // A response body can fail after HTTP 200 headers arrive. Keep those failures
  // distinct from malformed JSON, and never expose a raw upstream error message.
  const failure = (message, code, error) => {
    const detail = String(error?.cause?.code ?? error?.code ?? error?.name ?? '');
    const safeDetail = /^[A-Za-z0-9_-]{1,64}$/.test(detail) ? detail : '';
    return new ApiError(`${message}（HTTP ${response?.status || 0}，已接收 ${size} 字节，耗时 ${Date.now() - startedAt} 毫秒，错误 ${code}${safeDetail && safeDetail !== code ? ' / ' + safeDetail : ''}）${mutation ? '；提交结果未知，禁止自动重发' : ''}`, {
      status: response?.status || 0, code, retryAfter: response?.headers.get('retry-after') ?? null, unknown: Boolean(mutation),
    });
  };
  const timedOut = () => signal.aborted && signal.reason?.name === 'TimeoutError';
  try { response = await fetch(url, { method, headers, body: body || undefined, dispatcher: requestDispatcher, signal, redirect: 'error' }); }
  catch (error) { throw failure(timedOut() ? '等待响应头超过 10000 毫秒' : '连接或响应头读取失败', timedOut() ? 'HEADERS_TIMEOUT' : 'REQUEST_FAILED', error); }
  const resultHeaders = Object.fromEntries(response.headers);
  const chunks = [], tooLarge = Symbol('response-too-large');
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw tooLarge;
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error === tooLarge) throw failure(`响应体超过 ${maxBytes} 字节上限`, 'RESPONSE_TOO_LARGE');
    throw failure(timedOut() ? '读取响应体超过请求总时限 10000 毫秒' : '响应体读取中断', timedOut() ? 'BODY_TIMEOUT' : 'BODY_READ_ERROR', error);
  }
  let data;
  try { data = parseExchangeJson(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('响应体不是有效 JSON', 'BAD_JSON'); }
  return { status: response.status, headers: resultHeaders, data };
}
export class Exchanges {
  constructor(store, vault, scheduler, request = transport) { this.store = store; this.vault = vault; this.scheduler = scheduler; this.transport = request; this.rotations = {}; this.okxContexts = new Map(); }
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
    const cached = this.store.state.exchangeMeta[exchange]?.clock, age = Date.now() - cached?.at;
    if (Number.isSafeInteger(cached?.at) && cached.at > 0 && Number.isFinite(cached.offset) && Math.abs(cached.offset) <= 30000 && age >= 0 && age < 60000) return;
    let start;
    const data = await this.request(exchange, { path: exchange === 'binance' ? '/api/v3/time' : '/api/v5/public/time', priority, onSend: () => { start = Date.now(); }, endpointCap: 4 });
    const end = Date.now(), serverTime = Number(exchange === 'binance' ? data.serverTime : data.data?.[0]?.ts);
    const rtt = end - start;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 2000 || !Number.isSafeInteger(serverTime) || serverTime <= 0) throw Error('时间同步往返延迟无效（要求 0 至 2000 毫秒）或服务器时间无效');
    const offset = serverTime - (start + end) / 2;
    if (!Number.isFinite(offset)) throw Error('时间同步偏差计算无效，请同步系统时钟');
    if (Math.abs(offset) > 30000) throw Error(`本机与交易所时间偏差 ${offset.toFixed(1)} 毫秒（允许正负 30000 毫秒），请同步系统时钟`);
    (this.store.state.exchangeMeta[exchange] ||= {}).clock = { at: end, offset, rtt };
    this.store.save();
  }
  async rules(exchange, priority = 1, force = false) {
    const old = this.store.state.exchangeMeta[exchange];
    if (!force && old?.rulesAt && Date.now() - old.rulesAt < 3600000 &&
      (exchange !== 'okx' || Object.values(this.store.state.rules.okx || {}).every(rule => Object.hasOwn(rule, 'maxUsdNotional')))) return;
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
        // OKX maxLmtAmt is denominated in USD, never the pair's quote asset.
        maxQty: x.maxLmtSz || null, minNotional: '0', maxNotional: null, maxUsdNotional: x.maxLmtAmt || null, at: Date.now(),
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
    if (!x || (exchange === 'okx' && (!Array.isArray(data.data) || data.data.length !== 1)) || (x.instId && x.instId !== rule.symbol) || (exchange === 'binance' && !Number.isSafeInteger(x.lastUpdateId))) throw Error('盘口标识错误');
    const at = Date.now(), exchangeAt = exchange === 'okx' ? Number(x.ts) : null;
    if (exchange === 'okx') {
      if (!/^\d+$/.test(String(x.ts ?? '')) || !Number.isSafeInteger(exchangeAt) || exchangeAt <= 0) throw Error('OKX 盘口时间缺失或无效');
      const clock = this.store.state.exchangeMeta.okx?.clock;
      const calibrated = Boolean(clock && Number.isFinite(clock.offset) && Math.abs(clock.offset) <= 30000 && at - clock.at >= 0 && at - clock.at < 300000);
      const offset = calibrated ? clock.offset : 0;
      const age = at + offset - exchangeAt;
      if (age < -1000 || age > this.store.state.config.maxBookAgeMs) throw Error(`OKX 交易所盘口时间已过期或处于未来（实际时差 ${age.toFixed(1)} 毫秒，允许 -1000 至 ${this.store.state.config.maxBookAgeMs} 毫秒，时钟${calibrated ? '已校准' : '未校准'}）`);
    }
    const normalized = normalizeBook({ pair: id, bids: x.bids, asks: x.asks, at, exchangeAt, depthLimit: exchange === 'binance' ? 100 : 400 }, id);
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
      if (key.exchange === 'okx') okxAccount(data);
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
      if (exchange === 'okx' && (!Array.isArray(data.data) || data.data.length !== 1)) throw Error('OKX 余额响应账户数量错误');
      const rows = exchange === 'binance' ? data.balances : data.data?.[0]?.details;
      if (!Array.isArray(rows)) throw Error('余额响应格式错误');
      for (const x of rows) {
        const ccy = exchange === 'binance' ? x.asset : x.ccy;
        if (!/^[A-Z0-9]{1,20}$/.test(ccy)) continue;
        if (assets[ccy]) throw Error('余额响应包含重复资产');
        const free = decimal(exchange === 'binance' ? x.free : x.availBal, '可用余额', { zero: true });
        const locked = decimal(exchange === 'binance' ? x.locked : x.frozenBal, '冻结余额', { zero: true });
        // frozenBal may overlap strategy/position balances. cashBal is cash
        // inventory; adding availBal and frozenBal can inflate capital quotas.
        const total = exchange === 'binance' ? free.plus(locked) : decimal(x.cashBal, '现金余额', { zero: true });
        if (free.gt(total)) throw Error('可用余额超过现金库存，当前账户余额不受支持');
        assets[ccy] = { free: free.toString(), locked: locked.toString(), total: total.toString() };
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
    const context = exchange === 'okx' ? this.okxContexts.get(id) : null;
    if (exchange === 'okx') {
      try { this.assertPriceContext(exchange, id, side, qty, price, context); }
      catch (error) { throw new ApiError(error.message, { code: 'PRE_SUBMIT_GUARD', unknown: false }); }
    }
    const data = await this.request(exchange, exchange === 'binance' ? {
      path: '/api/v3/order', method: 'POST', key, mutation: true, priority: 0, beforeSend: guard,
      params: { symbol: rule.symbol, side, type: 'LIMIT', timeInForce: 'IOC', quantity: qty, price, newClientOrderId: clientId, newOrderRespType: 'ACK' },
    } : { path: '/api/v5/trade/order', method: 'POST', key, mutation: true, priority: 0,
      beforeSend: () => { guard(); this.assertPriceContext(exchange, id, side, qty, price, context); },
      body: { instId: rule.symbol, tdMode: 'cash', side: side.toLowerCase(), ordType: 'ioc', sz: qty, px: price, clOrdId: clientId, pxAmendType: '0', tradeQuoteCcy: context.tradeQuoteCcy },
    });
    const item = exchange === 'binance' ? data : data.data?.[0];
    if (exchange === 'okx' && item?.sCode !== '0') throw new ApiError(`OKX 下单未确认 (${item?.sCode || 'BAD_ACK'})`, { code: item?.sCode, unknown: true });
    const orderId = String(exchange === 'binance' ? item?.orderId ?? '' : item?.ordId ?? '');
    if (!/^\d+$/.test(orderId)) throw new ApiError('下单响应没有有效订单号；提交结果未知', { unknown: true });
    if (exchange === 'binance' ? item.symbol !== rule.symbol || item.clientOrderId !== clientId : !Array.isArray(data.data) || data.data.length !== 1 || item.clOrdId !== clientId) throw new ApiError('下单响应订单身份不匹配；提交结果未知', { unknown: true });
    key.status = 'WORKING_NOT_QUERIED'; this.store.save();
    return { orderId, status: 'ACKNOWLEDGED', clientId };
  }
  async assertNoOpenOrders(exchange, id) {
    const rule = this.store.state.rules[exchange]?.[id], key = this.chooseQuery(exchange);
    if (!rule?.symbol) throw Error(`${exchange} ${id} 无有效现货规则`);
    // MAX_POSITION includes open BUY quantities in the base asset, including
    // orders on another quote pair. A symbol-scoped query cannot establish that
    // none exist. Refuse those orders conservatively rather than using a cached
    // pending quantity that could become stale before submission.
    const accountWide = exchange === 'binance' && rule.filters?.some(f => f.filterType === 'MAX_POSITION');
    const data = await this.request(exchange, { path: exchange === 'binance' ? '/api/v3/openOrders' : '/api/v5/trade/orders-pending',
      params: exchange === 'binance' ? accountWide ? {} : { symbol: rule.symbol } : { instType: 'SPOT', instId: rule.symbol },
      key, priority: 0, weight: exchange === 'binance' ? accountWide ? 80 : 6 : 1 });
    const rows = exchange === 'binance' ? data : data.data;
    if (!Array.isArray(rows)) throw Error(`${exchange} 开放订单响应错误`);
    if (accountWide) {
      const base = pair(id).base;
      const bases = new Map(Object.entries(this.store.state.rules.binance).map(([other, entry]) => [entry.symbol, pair(other).base]));
      for (const order of rows) {
        if (!order || typeof order.symbol !== 'string' || !['BUY', 'SELL'].includes(order.side)) throw Error('Binance 账户开放订单响应错误，无法复核最大持仓');
        try {
          const original = decimal(order.origQty, '开放订单原数量');
          if (decimal(order.executedQty, '开放订单已成交数量', { zero: true }).gt(original)) throw Error('已成交数量大于原数量');
        } catch { throw Error('Binance 开放订单数量错误，无法复核最大持仓'); }
        if (order.symbol === rule.symbol) throw Error(`${exchange} ${id} 有开放订单，禁止新批次`);
        if (order.side === 'BUY') {
          const orderBase = bases.get(order.symbol);
          if (!orderBase) throw Error('Binance 开放买单交易对规则缺失，无法复核最大持仓');
          if (orderBase === base) throw Error(`Binance ${base} 在其他交易对有开放买单，禁止新批次以复核最大持仓`);
        }
      }
      return;
    }
    if (rows.length) throw Error(`${exchange} ${id} 有 ${rows.length} 笔开放订单，禁止新批次`);
  }
  async priceContext(exchange, id) {
    const rule = this.store.state.rules[exchange]?.[id];
    if (!rule?.symbol) throw Error(`${exchange} ${id} 无有效现货规则`);
    const key = this.chooseQuery(exchange);
    if (exchange === 'okx') {
      this.okxContexts.delete(id);
      if (key.accountUid !== this.store.state.accounts.okx) throw Error('查询 Key 账户不匹配');
      const account = okxAccount(await this.request(exchange, { path: '/api/v5/account/config', key, priority: 0 }), key.accountUid), accountAt = Date.now();
      const data = await this.request(exchange, { path: '/api/v5/account/instruments', params: { instType: 'SPOT', instId: rule.symbol }, key, priority: 0 });
      if (!Array.isArray(data.data) || data.data.length !== 1) throw Error('OKX 账户交易对规则响应错误');
      const instrument = data.data[0], { base, quote } = pair(id);
      if (!instrument || instrument.instId !== rule.symbol || instrument.instType !== 'SPOT' || instrument.baseCcy !== base || instrument.quoteCcy !== quote || instrument.state !== 'live') throw Error('OKX 账户交易对不匹配或不可交易');
      const quotes = instrument.tradeQuoteCcyList;
      if (!Array.isArray(quotes) || !quotes.length || !quotes.every(value => typeof value === 'string' && /^[A-Z0-9]{1,20}$/.test(value)) || !quotes.includes(quote)) throw Error('OKX 账户不支持当前报价资产；禁止隐式更换 tradeQuoteCcy');
      const context = { ...account, pair: id, symbol: rule.symbol, tradeQuoteCcy: quote, tradeQuoteCcyList: [...quotes], maxUsdNotional: instrument.maxLmtAmt, at: accountAt };
      this.okxContexts.set(id, context); return context;
    }
    if (key.accountUid !== this.store.state.accounts.binance) throw Error('查询 Key 账户不匹配');
    // exchangeInfo does not expose account MAX_ASSET. Query it for every
    // preflight, even when this symbol has no percentage-price filter.
    const account = await this.request(exchange, { path: '/api/v3/myFilters', params: { symbol: rule.symbol }, key, priority: 0, weight: 40 });
    if (!account || !Array.isArray(account.exchangeFilters) || !Array.isArray(account.symbolFilters) || !Array.isArray(account.rateLimits)) throw Error('Binance 账户过滤器响应错误');
    const context = { pair: id, accountUid: key.accountUid, assetFilters: validateAssetFilters(account.assetFilters, id), assetFiltersAt: Date.now() };
    const filters = rule?.filters?.filter(f => ['PERCENT_PRICE', 'PERCENT_PRICE_BY_SIDE'].includes(f.filterType)) || [];
    if (!filters.length) return context;
    const ref = await this.request(exchange, { path: '/api/v3/referencePrice', params: { symbol: rule.symbol }, priority: 0, weight: 2, allowCode: '-2043' });
    if (ref.referencePrice != null) return { ...context, reference: decimal(ref.referencePrice).toString(), at: Date.now() };
    const avg = await this.request(exchange, { path: '/api/v3/avgPrice', params: { symbol: rule.symbol }, priority: 0, weight: 2 });
    if (!filters.every(f => f.avgPriceMins === avg.mins)) throw Error('百分比价格过滤器与公开均价周期不一致，无法可靠复核，取消批次');
    return { ...context, reference: decimal(avg.price).toString(), at: Date.now() };
  }
  assertPriceContext(exchange, id, side, qty, price, context) {
    const rule = this.store.state.rules[exchange]?.[id]; validateOrder(rule, qty, price);
    if (!['BUY', 'SELL'].includes(side)) throw Error('订单方向错误');
    if (exchange === 'okx') {
      const age = Date.now() - context?.at, { quote } = pair(id);
      if (!context || context.pair !== id || context.symbol !== rule.symbol || context.accountUid !== this.store.state.accounts.okx ||
        !['1', '2'].includes(context.accountMode) || context.roleType !== '0' || context.spotRoleType !== '0' ||
        !Number.isFinite(context.at) || age < -1000 || age > 10000 || context.tradeQuoteCcy !== quote || !Array.isArray(context.tradeQuoteCcyList) || !context.tradeQuoteCcyList.includes(quote)) throw Error('OKX 账户及报价资产复核上下文缺失、不匹配或过期');
      // No USD=stablecoin assumption: a USD cap cannot be checked against a
      // USDT/USDC/BTC notional without a verified USD conversion source.
      if (quote !== 'USD') throw Error('OKX maxLmtAmt 为美元限额；当前报价资产缺少经核验的美元换算，禁止实盘提交');
      const amount = D(qty).mul(price);
      for (const value of [rule.maxUsdNotional, context.maxUsdNotional]) if (amount.gt(decimal(value, 'OKX 美元单笔限额'))) throw Error('订单超过 OKX 美元单笔限额');
      return;
    }
    const age = Date.now() - context?.assetFiltersAt;
    if (!context || context.pair !== id || !context.accountUid || context.accountUid !== this.store.state.accounts.binance ||
      !Number.isFinite(context.assetFiltersAt) || age < -1000 || age > 10000) throw Error('账户资产过滤器复核上下文缺失、不匹配或过期');
    const { base } = pair(id);
    for (const filter of validateAssetFilters(context.assetFilters, id)) {
      const amount = filter.asset === base ? D(qty) : D(qty).mul(price);
      if (amount.gt(filter.limit)) throw Error(`订单超过 Binance ${filter.asset} MAX_ASSET 单笔账户资产限额`);
    }
    for (const f of rule.filters || []) {
      if (['PERCENT_PRICE', 'PERCENT_PRICE_BY_SIDE'].includes(f.filterType)) {
        const priceAge = Date.now() - context.at;
        if (!Number.isFinite(context.at) || priceAge < -1000 || priceAge > 10000) throw Error('价格百分比复核上下文缺失或过期');
        const reference = decimal(context.reference, '价格百分比复核参考价格');
        const up = f.filterType === 'PERCENT_PRICE' ? f.multiplierUp : side === 'BUY' ? f.bidMultiplierUp : f.askMultiplierUp;
        const down = f.filterType === 'PERCENT_PRICE' ? f.multiplierDown : side === 'BUY' ? f.bidMultiplierDown : f.askMultiplierDown;
        if (D(price).gt(reference.mul(decimal(up, '价格上界倍数'))) || D(price).lt(reference.mul(decimal(down, '价格下界倍数')))) throw Error('限价不满足交易所百分比价格过滤器');
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
    if (!symbol) throw Error('撤单交易对规则缺失');
    const data = await this.request(exchange, exchange === 'binance' ? { path: '/api/v3/order', method: 'DELETE', params: { symbol, orderId }, key, mutation: true, priority: 0 } :
      { path: '/api/v5/trade/cancel-order', method: 'POST', body: { instId: symbol, ordId: orderId }, key, mutation: true, priority: 0 });
    if (exchange === 'okx' && data.data?.[0]?.sCode !== '0') throw new ApiError('OKX 撤单未确认', { unknown: true });
    if (exchange === 'binance' ? data?.symbol !== symbol || String(data.orderId) !== String(orderId) : !Array.isArray(data.data) || data.data.length !== 1 || String(data.data[0].ordId) !== String(orderId)) throw new ApiError('撤单响应订单身份不匹配；撤单结果未知', { unknown: true });
    return { status: 'CANCEL_ACKNOWLEDGED' }; // A cancel acknowledgment does not prove no fill.
  }
}
