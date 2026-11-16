/** Rotating, identity-checked JSON-RPC. Signed broadcasts are never retried automatically. */
export class RpcPool {
  constructor({ chain, getUrls, fetchImpl = globalThis.fetch, onStatus = () => {}, timeoutMs = 12000 }) {
    this.chain = chain; this.getUrls = getUrls; this.fetch = fetchImpl;
    this.onStatus = onStatus; this.timeoutMs = timeoutMs; this.cursor = 0; this.sequence = 0;
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
  async call(method, params = [], { broadcast = false } = {}) {
    const urls = [...new Set(this.getUrls() ?? [])];
    if (!urls.length) throw new Error(`${this.chain} 未配置 RPC`);
    let last;
    for (let offset = 0; offset < (broadcast ? 1 : urls.length); offset++) {
      const index = this.cursor++ % urls.length, url = urls[index];
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('RPC 仅支持 HTTP(S)');
        await this.identity(url);
        const result = await this.request(url, method, params);
        this.onStatus(this.chain, { connected: true, endpointIndex: index, host: parsed.hostname, updatedAt: new Date().toISOString(), error: null });
        return result;
      } catch (error) {
        last = error;
        this.onStatus(this.chain, { connected: false, endpointIndex: index, updatedAt: new Date().toISOString(), error: String(error.message).slice(0, 180) });
      }
    }
    throw new Error(`${this.chain} RPC 全部失败：${last?.message ?? '连接失败'}`);
  }
}
