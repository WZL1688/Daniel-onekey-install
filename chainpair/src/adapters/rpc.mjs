/** Rotating, identity-checked JSON-RPC. Signed broadcasts are never retried automatically. */
const IDENTITY_CACHE_MS = 10000;
const broadcastMethods = new Set(['eth_sendRawTransaction', 'eth_sendTransaction', 'sendTransaction']);
const readMethod = method => /^eth_(?:call|estimateGas|get\w+|blockNumber|chainId|feeHistory|maxPriorityFeePerGas|gasPrice)$/.test(method) || /^(?:get[A-Z]\w*|isBlockhashValid|simulateTransaction)$/.test(method);
export class RpcPool {
  constructor({ chain, getUrls, fetchImpl = globalThis.fetch, onStatus = () => {}, timeoutMs = 12000, now = Date.now }) {
    this.chain = chain; this.getUrls = getUrls; this.fetch = fetchImpl;
    this.onStatus = onStatus; this.timeoutMs = timeoutMs; this.cursor = 0; this.sequence = 0;
    this.now = now; this.lastIdentityClock = null; this.identityGeneration = 0;
    this.identityCache = new Map(); this.pendingIdentities = new Map();
  }
  async request(url, method, params) {
    const response = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.sequence, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`RPC ${data.error.code}: ${String(data.error.message).slice(0, 180)}`);
    if (!Object.hasOwn(data, 'result')) throw new Error('RPC 响应缺少 result');
    return data.result;
  }
  async identity(url) {
    if (this.chain === 'bnb') {
      if (BigInt(await this.request(url, 'eth_chainId', [])) !== 56n) throw new Error('RPC 链身份错误：需要 BNB 主网 56');
    } else {
      if (await this.request(url, 'getGenesisHash', []) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('RPC 链身份错误：需要 Solana 主网');
    }
  }
  identityTime() {
    const at = this.now();
    if (!Number.isFinite(at)) throw new Error('RPC 身份检查时间无效');
    if (this.lastIdentityClock !== null && at < this.lastIdentityClock) {
      this.identityGeneration++; this.identityCache.clear(); this.pendingIdentities.clear();
    }
    this.lastIdentityClock = at; return at;
  }
  invalidateIdentity(url) {
    this.identityGeneration++;
    const key = `${this.chain}\0${url}`;
    this.identityCache.delete(key); this.pendingIdentities.delete(key);
  }
  async verifiedIdentity(url, { force = false } = {}) {
    const key = `${this.chain}\0${url}`, at = this.identityTime();
    const cached = this.identityCache.get(key);
    if (!force && cached && at >= cached.checkedAt && at - cached.checkedAt < IDENTITY_CACHE_MS) return;
    const pending = this.pendingIdentities.get(key);
    if (!force && pending && pending.generation === this.identityGeneration) return pending.promise;
    // A broadcast always obtains its own fresh network identity check. It does
    // not borrow a prior read's cache or in-flight identity request.
    const entry = { generation: this.identityGeneration, checkedAt: at, promise: null };
    const check = async () => {
      try {
        await this.identity(url);
        const completedAt = this.identityTime();
        if (entry.generation === this.identityGeneration && completedAt >= at && completedAt - at < IDENTITY_CACHE_MS &&
            (force || this.pendingIdentities.get(key) === entry)) this.identityCache.set(key, { checkedAt: at });
      } catch (error) { this.invalidateIdentity(url); throw error; }
      finally { if (this.pendingIdentities.get(key) === entry) this.pendingIdentities.delete(key); }
    };
    // Queue the read so the entry is installed before a synchronously-resolved
    // test transport or another caller can finish the check.
    entry.promise = Promise.resolve().then(check);
    if (!force) this.pendingIdentities.set(key, entry);
    return entry.promise;
  }
  async call(method, params = [], { broadcast = false } = {}) {
    const urls = [...new Set(this.getUrls() ?? [])];
    if (!urls.length) throw new Error(`${this.chain} 未配置 RPC`);
    broadcast ||= broadcastMethods.has(method);
    const activeKeys = new Set(urls.map(url => `${this.chain}\0${url}`));
    for (const key of this.identityCache.keys()) if (!activeKeys.has(key)) this.identityCache.delete(key);
    for (const key of this.pendingIdentities.keys()) if (!activeKeys.has(key)) this.pendingIdentities.delete(key);
    let last;
    for (let offset = 0; offset < (broadcast ? 1 : urls.length); offset++) {
      const index = this.cursor++ % urls.length, url = urls[index];
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('RPC 仅支持 HTTP(S)');
        await this.verifiedIdentity(url, { force: broadcast || !readMethod(method) });
        const result = await this.request(url, method, params);
        this.onStatus(this.chain, { connected: true, endpointIndex: index, host: parsed.hostname, updatedAt: new Date().toISOString(), error: null });
        return result;
      } catch (error) {
        this.invalidateIdentity(url);
        last = error;
        this.onStatus(this.chain, { connected: false, endpointIndex: index, updatedAt: new Date().toISOString(), error: String(error.message).slice(0, 180) });
      }
    }
    throw new Error(`${this.chain} RPC 全部失败：${last?.message ?? '连接失败'}`);
  }
}
