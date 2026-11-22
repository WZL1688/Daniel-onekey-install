import { getAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { WORMHOLE_WRAPPED_URL, normalizeWrappedMapping } from './wormhole.mjs';

// Independent, read-only clients for the documented CoinGecko coin directory
// and DexScreener token-pool lookup APIs. The caller owns request scheduling.
const DIRECTORY_URL = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
const POOLS_ORIGIN = 'https://api.dexscreener.com';
const CHAINS = Object.freeze({ bnb: 'bsc', solana: 'solana' });
const DEADLINE_MS = 12000;
const MIN_RETRY_MS = 60000;
const MAX_RETRY_MS = 86400000;
const knownErrors = new WeakSet();
const safeError = (message, code, details = {}) => {
  const error = Object.assign(new Error(message), { safe: true, code, ...details });
  knownErrors.add(error);
  return error;
};
const text = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const chainKey = chain => Object.hasOwn(CHAINS, chain) ? CHAINS[chain] : null;
const addressKey = (chain, address) => chain === 'bnb' ? address.toLowerCase() : address;

function addressFor(chain, value) {
  if (!chainKey(chain) || typeof value !== 'string' || value.length > 128) return null;
  try {
    const normalized = chain === 'bnb' ? getAddress(value.trim()) : new PublicKey(value.trim()).toBase58();
    return chain === 'bnb' && /^0x0{40}$/i.test(normalized) ? null : normalized;
  } catch { return null; }
}
function numeric(value, positive = false) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && (value.length > 100 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) && (positive ? number > 0 : number >= 0) ? number : null;
}
function validTime(at) { return typeof at === 'number' && Number.isSafeInteger(at) && at >= Date.UTC(2009, 0, 1); }

/** Directory membership is only candidate identity evidence, never approval. */
export function normalizeDiscovery(rows, { observedAt = Date.now(), limit = 200 } = {}) {
  if (!Array.isArray(rows) || rows.length > 100000 || !validTime(observedAt)) throw safeError('同币目录格式无效', 'DISCOVERY_FORMAT');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw safeError('目录数量限制无效', 'DISCOVERY_FORMAT');
  const byId = new Map(), conflicts = new Set(), addresses = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(row.id)) continue;
    const id = `coingecko:${row.id}`;
    const platforms = row.platforms && typeof row.platforms === 'object' && !Array.isArray(row.platforms) ? row.platforms : {};
    const bnb = addressFor('bnb', platforms['binance-smart-chain']), solana = addressFor('solana', platforms.solana);
    const candidate = bnb && solana ? {
      id, symbol: text(row.symbol, 32), name: text(row.name, 100), source: 'coingecko',
      sourceRef: `https://www.coingecko.com/en/coins/${row.id}`,
      chains: { bnb: { address: bnb }, solana: { address: solana } }, observedAt,
    } : null;
    const signature = candidate ? JSON.stringify([candidate.symbol, candidate.name, bnb.toLowerCase(), solana]) : null;
    if (byId.has(id)) {
      if (byId.get(id).signature !== signature) conflicts.add(id);
    } else byId.set(id, { candidate, signature });
    if (!candidate) continue;
    for (const [chain, address] of [['bnb', bnb], ['solana', solana]]) {
      const key = `${chain}:${addressKey(chain, address)}`;
      if (addresses.has(key) && addresses.get(key) !== id) { conflicts.add(id); conflicts.add(addresses.get(key)); }
      else addresses.set(key, id);
    }
  }
  // Check the full bounded directory before taking a page: a later conflicting
  // entry cannot escape quarantine just because it follows the first200 rows.
  return [...byId.entries()].filter(([id, item]) => item.candidate && !conflicts.has(id)).map(([, item]) => item.candidate).slice(0, limit);
}

/** priceUsd denotes the BASE token only; quote-token prices are never inferred. */
export function normalizePools(rows, { chain, addresses, observedAt = Date.now() } = {}) {
  if (!chainKey(chain) || !Array.isArray(rows) || rows.length > 10000 || !validTime(observedAt) || !Array.isArray(addresses)) throw safeError('交易池行情格式无效', 'DISCOVERY_FORMAT');
  const requested = new Set(addresses.map(value => addressFor(chain, value)).filter(Boolean).map(address => addressKey(chain, address)));
  const normalized = new Map(), conflicts = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.chainId !== CHAINS[chain]) continue;
    const tokenAddress = addressFor(chain, row.baseToken?.address), poolAddress = addressFor(chain, row.pairAddress), quoteAddress = addressFor(chain, row.quoteToken?.address);
    const priceUsd = numeric(row.priceUsd, true);
    if (!tokenAddress || !poolAddress || !quoteAddress || priceUsd === null || !requested.has(addressKey(chain, tokenAddress)) || addressKey(chain, tokenAddress) === addressKey(chain, quoteAddress)) continue;
    const result = { chain, tokenAddress, poolAddress, quoteAddress, priceUsd,
      liquidityUsd: numeric(row.liquidity?.usd), volume24hUsd: numeric(row.volume?.h24),
      observedAt, sourceUpdatedAt: null, dexId: text(row.dexId, 64) };
    const key = addressKey(chain, poolAddress), prior = normalized.get(key);
    if (prior) { if (JSON.stringify(prior) !== JSON.stringify(result)) conflicts.add(key); }
    else normalized.set(key, result);
  }
  return [...normalized.entries()].filter(([key]) => !conflicts.has(key)).map(([, row]) => row);
}

function retryAfter(headers, now) {
  const value = headers?.get?.('retry-after');
  let delay = MIN_RETRY_MS;
  if (typeof value === 'string') {
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) delay = Number(value) * 1000;
    else { const date = Date.parse(value); if (Number.isFinite(date)) delay = date - now; }
  }
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.ceil(delay)));
}

async function readBody(response, maxBytes) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw safeError('公开行情响应超过本机大小限制', 'DISCOVERY_FORMAT');
  }
  if (!response.body?.getReader) throw safeError('公开行情响应格式无效', 'DISCOVERY_FORMAT');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw safeError('公开行情响应超过本机大小限制', 'DISCOVERY_FORMAT'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

function networkReason(error) {
  if (['DNS','TIMEOUT','CONNECTION','TLS','PROXY','NETWORK'].includes(error?.networkReason)) return error.networkReason;
  const code = error?.cause?.code || error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'TIMEOUT';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code)) return 'CONNECTION';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code)) return 'TLS';
  if (['UND_ERR_PRX_TLS', 'ERR_PROXY_CONNECTION_FAILED'].includes(code)) return 'PROXY';
  return 'NETWORK';
}

export class DiscoveryClient {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now } = {}) { this.fetchImpl = fetchImpl; this.now = now; }

  async #get(url, { signal, maxBytes, maxRows, apiKey, rawText = false }) {
    const timeout = AbortSignal.timeout(DEADLINE_MS), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let httpStatus = null;
    try {
      const headers = { Accept: rawText ? 'text/plain' : 'application/json' };
      if (apiKey !== undefined && url === DIRECTORY_URL) headers['x-cg-demo-api-key'] = apiKey;
      const response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: combined });
      httpStatus = response.status;
      if (!response.ok) response.body?.cancel?.().catch(() => {});
      if (response.status === 429) throw safeError('公开行情接口限流，请等待冷却', 'DISCOVERY_RATE_LIMIT', { retryAfterMs: retryAfter(response.headers, this.now()), httpStatus: 429 });
      if (response.status === 401 || response.status === 403) throw safeError('公开行情接口要求账户或凭证，请核对服务权限', 'DISCOVERY_AUTH', { httpStatus: response.status });
      if (response.status >= 500) throw safeError('公开行情服务暂时不可用', 'DISCOVERY_UNAVAILABLE', { httpStatus: response.status });
      if (!response.ok) throw safeError('公开行情服务拒绝请求', 'DISCOVERY_REJECTED', { httpStatus: response.status });
      const content = await readBody(response, maxBytes);
      if (rawText) return content;
      let body; try { body = JSON.parse(content); } catch { throw safeError('公开行情响应无法解析', 'DISCOVERY_FORMAT'); }
      if (body && typeof body === 'object' && !Array.isArray(body) && (Object.hasOwn(body, 'error') || Object.hasOwn(body, 'status'))) throw safeError('公开行情接口返回非成功结果，请核对服务状态及权限', 'DISCOVERY_REJECTED');
      if (!Array.isArray(body) || body.length > maxRows) throw safeError('公开行情响应数组格式无效', 'DISCOVERY_FORMAT');
      return body;
    } catch (error) {
      if (knownErrors.has(error)) { if (httpStatus !== null && error.httpStatus === undefined) error.httpStatus = httpStatus; throw error; }
      if (timeout.aborted) throw safeError('公开行情请求超时', 'DISCOVERY_TIMEOUT', { networkReason: 'TIMEOUT' });
      if (signal?.aborted) throw safeError('公开行情请求已取消', 'DISCOVERY_ABORTED');
      throw safeError('公开行情网络请求失败，请检查连接', 'DISCOVERY_NETWORK', { networkReason: networkReason(error) });
    }
  }
  async discover({ signal, apiKey } = {}) {
    if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey || apiKey.length > 1000 || !/^[\x21-\x7e]+$/.test(apiKey))) throw safeError('CoinGecko Demo Key 格式无效', 'DISCOVERY_CREDENTIALS');
    const body = await this.#get(DIRECTORY_URL, { signal, maxBytes: 8 * 1024 * 1024, maxRows: 100000, apiKey });
    const candidates = normalizeDiscovery(body, { observedAt: this.now() });
    // A malformed provider response must not reflect the credential into a
    // public token field, registry entry or externally displayed source link.
    return apiKey ? candidates.filter(candidate => !JSON.stringify(candidate).includes(apiKey)) : candidates;
  }
  async discoverWrapped({ signal } = {}) {
    const content = await this.#get(WORMHOLE_WRAPPED_URL, { signal, maxBytes: 256 * 1024, rawText: true });
    return normalizeWrappedMapping(content, { observedAt: this.now() });
  }
  async pools({ chain, addresses, signal } = {}) {
    const remoteChain = chainKey(chain);
    if (!remoteChain || !Array.isArray(addresses) || addresses.length < 1 || addresses.length > 30) throw safeError('请选择有效链和1–30个代币地址', 'DISCOVERY_FORMAT');
    const validated = addresses.map(value => addressFor(chain, value));
    if (validated.some(value => !value)) throw safeError('行情查询代币地址无效', 'DISCOVERY_FORMAT');
    const unique = [...new Map(validated.map(address => [addressKey(chain, address), address])).values()];
    const url = `${POOLS_ORIGIN}/tokens/v1/${remoteChain}/${unique.join(',')}`;
    const body = await this.#get(url, { signal, maxBytes: 2 * 1024 * 1024, maxRows: 10000 });
    return normalizePools(body, { chain, addresses: unique, observedAt: this.now() });
  }
}
