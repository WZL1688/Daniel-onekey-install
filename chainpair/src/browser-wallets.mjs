import { randomUUID, createHash } from 'node:crypto';
import { getAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';

const fail = message => Object.assign(new Error(message), { safe: true });
const CLIENT_ID = /^[a-zA-Z0-9_-]{16,100}$/;
const CHAINS = { bnb: ['metamask', 'okx'], solana: ['phantom', 'okx'] };
const active = request => ['QUEUED', 'DISPATCHED'].includes(request.status);
const normalize = (chain, address) => {
  try { return chain === 'bnb' ? getAddress(String(address).trim()) : new PublicKey(String(address).trim()).toBase58(); }
  catch { throw fail('插件钱包地址格式无效'); }
};
const same = (chain, a, b) => chain === 'bnb' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/** Local session bridge. Only public accounts and unsigned requests reach the page. */
export class BrowserWalletBridge {
  constructor({ store, requestTimeoutMs = 120000, connectionTtlMs = 35000, clock = Date.now, onUncertain = () => {} } = {}) {
    this.store = store; this.requestTimeoutMs = requestTimeoutMs; this.connectionTtlMs = connectionTtlMs;
    this.clock = clock; this.onUncertain = onUncertain; this.connections = new Map(); this.requests = new Map();
  }
  client(clientId) { if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw fail('插件会话无效，请刷新页面重新连接'); return clientId; }
  status(chain) {
    const connection = this.connections.get(chain);
    return { connected: Boolean(connection && connection.expiresAt > this.clock()), address: connection?.address || null, provider: connection?.provider || null,
      pendingCount: [...this.requests.values()].filter(request => request.chain === chain && active(request)).length };
  }
  connect({ chain, address, provider, clientId }) {
    this.client(clientId);
    if (!CHAINS[chain]?.includes(provider)) throw fail('不支持的链或插件钱包');
    address = normalize(chain, address);
    const prior = this.connections.get(chain);
    if (this.status(chain).pendingCount) throw fail('该链仍有待确认的插件请求，请先处理弹窗与交易档案');
    if (prior && prior.clientId !== clientId && prior.expiresAt > this.clock()) throw fail('该钱包正在另一个页面连接，请先断开旧页面');
    this.connections.set(chain, { chain, address, provider, clientId, expiresAt: this.clock() + this.connectionTtlMs });
    return this.status(chain);
  }
  heartbeat({ clientId, connections }) {
    this.client(clientId);
    if (!Array.isArray(connections) || connections.length > 2) throw fail('插件心跳参数无效');
    for (const item of connections) {
      const current = this.connections.get(item?.chain);
      if (!current || current.clientId !== clientId) continue;
      let reported;
      try { reported = normalize(item.chain, item.address); }
      catch { this.disconnectChain(item.chain); throw fail('插件账户状态无效，请重新连接；新交易已停止'); }
      if (!same(item.chain, reported, current.address)) {
        this.disconnectChain(item.chain);
        throw fail('插件账户已经变化，请重新连接；新交易已停止');
      }
      current.expiresAt = this.clock() + this.connectionTtlMs;
    }
    return { bnb: this.status('bnb'), solana: this.status('solana') };
  }
  disconnect({ chain, clientId }) {
    this.client(clientId);
    if (!Object.hasOwn(CHAINS, chain)) throw fail('链名称无效');
    const connection = this.connections.get(chain);
    if (connection && connection.clientId !== clientId) throw fail('无法断开其他页面的插件会话');
    this.disconnectChain(chain); return { ok: true };
  }
  disconnectChain(chain) {
    this.connections.delete(chain);
    for (const request of this.requests.values()) if (request.chain === chain && active(request)) {
      this.finishError(request, 'DISCONNECTED', '插件已断开；如弹窗曾提交交易，请核对链上记录');
    }
  }
  disconnectAll() { for (const chain of Object.keys(CHAINS)) this.disconnectChain(chain); }
  record(request, state, extra = {}) {
    const quote = this.store?.getQuote?.(request.quoteId);
    if (quote?.tradeId) this.store.appendEvent(quote.tradeId, { state, requestId: request.id, quoteId: request.quoteId, chain: request.chain, kind: request.kind, at: new Date(this.clock()).toISOString(), ...extra });
    return quote?.tradeId;
  }
  request(chain, input) {
    const connection = this.connections.get(chain);
    if (!this.status(chain).connected) return Promise.reject(fail('插件钱包未连接，请保持页面打开并重新连接'));
    if (this.status(chain).pendingCount) return Promise.reject(fail('该插件仍有待处理请求，禁止重复发送'));
    if ((chain === 'bnb' ? input.kind !== 'evmSend' : input.kind !== 'solSign') || !input.payload || typeof input.quoteId !== 'string') return Promise.reject(fail('插件签名请求参数无效'));
    const expectedSender = input.kind === 'evmSend' ? input.payload.transaction?.from : input.payload.sender;
    if (!same(chain, expectedSender, connection.address)) return Promise.reject(fail('请求账户与已连接插件不一致'));
    const quoteExpiry = input.expiresAt ? Date.parse(input.expiresAt) : Infinity;
    if (Number.isNaN(quoteExpiry) || quoteExpiry <= this.clock()) return Promise.reject(fail('插件请求报价已过期，请重新报价'));
    const deadline = Math.min(this.clock() + this.requestTimeoutMs, quoteExpiry);
    const request = { id: randomUUID(), chain, clientId: connection.clientId, kind: input.kind, payload: structuredClone(input.payload), quoteId: input.quoteId,
      summary: input.summary || null, expiresAt: new Date(deadline).toISOString(), status: 'QUEUED' };
    const promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    request.timer = setTimeout(() => this.finishError(request, 'TIMED_OUT', '插件确认超时；请取消仍打开的确认弹窗并核对交易档案，禁止自动重试'), Math.max(1, deadline - this.clock()));
    request.timer.unref?.();
    this.requests.set(request.id, request);
    this.record(request, 'BROWSER_CONFIRMATION_REQUESTED', { expiresAt: request.expiresAt });
    this.prune(); return promise;
  }
  poll(clientId) {
    this.client(clientId); const requests = [];
    for (const request of this.requests.values()) {
      if (request.clientId !== clientId || request.status !== 'QUEUED') continue;
      if (Date.parse(request.expiresAt) <= this.clock()) { this.finishError(request, 'TIMED_OUT', '插件报价已过期，请核对档案后重新报价'); continue; }
      // Delivery is consumed before replying: a lost response never replays a send.
      request.status = 'DISPATCHED';
      requests.push({ id: request.id, chain: request.chain, kind: request.kind, payload: structuredClone(request.payload), quoteId: request.quoteId, summary: request.summary, expiresAt: request.expiresAt });
    }
    return { requests };
  }
  resolve({ clientId, requestId, result, error }) {
    this.client(clientId); const request = this.requests.get(requestId);
    if (!request || request.clientId !== clientId) throw fail('插件请求不存在或不属于当前页面');
    if (result && error) throw fail('插件结果不能同时成功和失败');
    if (!result && !error) throw fail('缺少插件处理结果');
    if (request.status === 'QUEUED') throw fail('插件请求尚未交给浏览器，不能提交结果');
    if (result) {
      if (request.kind === 'evmSend') {
        if (typeof result.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.hash)) throw fail('插件交易哈希格式无效');
        result = { hash: result.hash };
      } else {
        if (typeof result.signedTransactionBase64 !== 'string' || result.signedTransactionBase64.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.signedTransactionBase64)) throw fail('插件签名交易格式无效');
        result = { signedTransactionBase64: result.signedTransactionBase64 };
      }
    }
    const outcomeDigest = createHash('sha256').update(JSON.stringify(result ? { result } : { error: Number(error.code) === 4001 ? 'CANCELLED' : 'FAILED' })).digest('hex');
    if (['RESOLVED', 'REJECTED', 'LATE_RESOLVED'].includes(request.status)) {
      if (request.outcomeDigest === outcomeDigest) return { ok: true, duplicate: true };
      throw fail('插件结果已经处理，不能提交不同结果');
    }
    request.outcomeDigest = outcomeDigest;
    const late = !active(request) || Date.parse(request.expiresAt) <= this.clock();
    clearTimeout(request.timer);
    if (late) {
      if (active(request)) this.finishError(request, 'TIMED_OUT', '插件结果超过报价有效期，请核对档案');
      const tradeId = this.record(request, 'BROWSER_LATE_RESULT', { hash: result?.hash || null, reason: result?.hash ? '过期的插件请求返回了已广播哈希，需要人工核对' : '过期签名未由本机程序广播' });
      if (result?.hash) this.onUncertain({ tradeId, hash: result.hash, requestId, quoteId: request.quoteId, reason: '过期或已断开的插件请求返回了交易哈希，请核对该交易；禁止自动重试' });
      request.status = 'LATE_RESOLVED'; request.payload = null;
      return { ok: true, late: true };
    }
    if (error) {
      this.finishError(request, 'REJECTED', Number(error.code) === 4001 ? '用户取消了插件确认；流程已暂停，请核对档案' : '插件处理失败或连接中断；请核对交易档案');
    } else {
      request.status = 'RESOLVED'; request.payload = null;
      this.record(request, 'BROWSER_RESPONSE_RECEIVED', { hash: result.hash || null });
      request.resolve(result); request.resolve = null; request.reject = null;
    }
    return { ok: true };
  }
  finishError(request, state, message) {
    if (!active(request)) return;
    clearTimeout(request.timer); request.status = state;
    this.record(request, `BROWSER_${state}`, { reason: message });
    request.reject?.(fail(message)); request.reject = null; request.resolve = null;
    // Retain only IDs for late-result attribution; never retain signed bytes.
    request.payload = null;
  }
  prune() {
    if (this.requests.size <= 200) return;
    for (const [id, request] of this.requests) { if (this.requests.size <= 200) break; if (!active(request)) this.requests.delete(id); }
  }
  close() { this.disconnectAll(); }
}
