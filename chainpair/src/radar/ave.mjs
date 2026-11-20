import { getAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';

// Independently implemented against AVE's public v2 reference. This client only
// reads data; the caller owns persistent request accounting and scheduling.
const ORIGIN = 'https://prod.ave-api.com';
const CHAINS = Object.freeze({ bnb: 'bsc', solana: 'solana' });
const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;
const MIN_TIME = Date.UTC(2009, 0, 1);
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const clientErrors = new WeakSet();
const safe = (message, code, details = {}) => {
  const error = Object.assign(new Error(message), { safe: true, code, ...details });
  clientErrors.add(error);
  return error;
};

function chainName(chain) {
  if (!Object.hasOwn(CHAINS, chain)) throw safe('雷达仅支持 BNB Chain 和 Solana', 'AVE_CHAIN');
  return CHAINS[chain];
}

function addressFor(chain, value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  try {
    const address = chain === 'bnb' ? getAddress(value.trim()) : new PublicKey(value.trim()).toBase58();
    if (chain === 'bnb' && /^0x0{40}$/i.test(address)) return null;
    return address;
  } catch { return null; }
}

function numeric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && (!value.trim() || value.length > 100 || !NUMERIC.test(value.trim()))) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function timestamp(value, observedAt) {
  const seconds = numeric(value);
  if (!Number.isInteger(seconds)) return null;
  const millis = seconds * 1000;
  return Number.isSafeInteger(millis) && millis >= MIN_TIME && millis <= observedAt + 60_000 ? millis : null;
}

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
}

function unknownRisk() {
  return {
    status: 'unknown', flags: [], checkedAt: null, source: 'AVE ranks',
    unknowns: ['行情榜单未完成合约安全核验；旧安全字段不作安全结论'],
  };
}

/** Missing numeric fields deliberately stay null, rather than a passing zero. */
export function normalizeToken(row, chain, { observedAt = Date.now() } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(CHAINS, chain)) return null;
  if (!Number.isFinite(observedAt) || observedAt < MIN_TIME) return null;
  if (row.chain !== undefined && (typeof row.chain !== 'string' || row.chain.toLowerCase() !== CHAINS[chain])) return null;
  const address = addressFor(chain, row.token);
  if (!address) return null;
  const holders = numeric(row.holders);
  return {
    id: `${chain}:${address}`, chain, address,
    symbol: text(row.symbol, 32), name: text(row.name, 96),
    priceUsd: numeric(row.current_price_usd),
    liquidityUsd: numeric(row.main_pair_tvl) ?? numeric(row.tvl),
    marketCapUsd: numeric(row.market_cap),
    volume5mUsd: numeric(row.token_tx_volume_usd_5m),
    holders: Number.isSafeInteger(holders) ? holders : null,
    createdAt: timestamp(row.created_at, observedAt) ?? timestamp(row.launch_at, observedAt),
    sourceUpdatedAt: timestamp(row.updated_at, observedAt), observedAt,
    poolAddress: addressFor(chain, row.main_pair),
    aveUrl: `https://ave.ai/token/${address}-${CHAINS[chain]}`,
    risk: unknownRisk(),
  };
}

const positiveFlag = value => value === true || value === 1 || value === '1';

// An absent warning is not proof of safety. In particular, -1 and risk_score
// have no verified safe interpretation in the public response example.
function normalizeRisk(data, checkedAt) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw safe('AVE 风险报告格式无效', 'AVE_FORMAT');
  const checks = [
    ['is_honeypot', 'AVE 报告存在貔貅风险'],
    ['cannot_buy', 'AVE 报告存在买入限制'],
    ['cannot_sell_all', 'AVE 报告存在卖出限制'],
    ['transfer_pausable', 'AVE 报告合约可暂停转账'],
    ['has_black_method', 'AVE 报告存在黑名单方法'],
  ];
  const flags = checks.filter(([key]) => positiveFlag(data[key])).map(([, label]) => label);
  return {
    status: flags.length ? 'flagged' : 'unknown', flags, checkedAt, source: 'AVE contracts',
    unknowns: ['报告未证明代币安全；税率单位、评分含义及未支持字段未核验', 'Solana 权限及完整可卖出性未核验'],
  };
}

function retryAfter(headers, now) {
  const value = headers?.get?.('retry-after');
  let delay = MIN_RETRY_MS;
  if (typeof value === 'string') {
    const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    const date = Date.parse(value);
    if (Number.isFinite(seconds)) delay = seconds * 1000;
    else if (Number.isFinite(date)) delay = date - now;
  }
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.ceil(delay)));
}

async function bodyJson(response) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw safe('AVE 响应超过本机大小限制', 'AVE_BODY_SIZE');
  }
  // Native fetch provides a stream; avoid buffering an unbounded body first.
  if (!response.body?.getReader) throw safe('AVE 响应格式无效', 'AVE_FORMAT');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw safe('AVE 响应超过本机大小限制', 'AVE_BODY_SIZE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw safe('AVE 返回的数据无法解析', 'AVE_FORMAT'); }
}

export class AveClient {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async #request(path, { apiKey, signal } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 2000 || /[\r\n]/.test(apiKey)) throw safe('请先保存并解锁 AVE API Key', 'AVE_CREDENTIALS');
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(`${ORIGIN}${path}`, {
        method: 'GET', headers: { 'X-API-KEY': apiKey.trim(), Accept: 'application/json' },
        redirect: 'error', signal: combinedSignal,
      });
      if (!response.ok) response.body?.cancel?.().catch(() => {});
      if (response.status === 429) throw safe('AVE 请求受限，已进入冷却', 'AVE_RATE_LIMIT', { retryAfterMs: retryAfter(response.headers, this.now()) });
      if (response.status === 401 || response.status === 403) throw safe('AVE 凭证或套餐未获授权，请核对账号', 'AVE_AUTH');
      if (!response.ok) throw safe('AVE 服务暂不可用，请稍后再试', 'AVE_HTTP');
      const body = await bodyJson(response);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw safe('AVE 返回格式无效', 'AVE_FORMAT');
      if (typeof body.status === 'number' && Number.isFinite(body.status) && body.status !== 1) throw safe('AVE 明确拒绝请求，请核对接口、凭证及套餐', 'AVE_REJECTED');
      if (body.status !== 1 || !Object.hasOwn(body, 'data')) throw safe('AVE 返回格式无效', 'AVE_FORMAT');
      return body.data;
    } catch (error) {
      // Only errors created by this client may cross the API boundary. Network
      // errors can contain request headers, API keys, remote bodies or URLs.
      if (clientErrors.has(error)) throw error;
      if (timeout.aborted) throw safe('AVE 请求超时，请稍后再试', 'AVE_TIMEOUT');
      if (signal?.aborted) throw safe('AVE 请求已取消', 'AVE_ABORTED');
      throw safe('AVE 网络请求失败，请检查连接', 'AVE_NETWORK');
    }
  }

  async ranks({ chain, apiKey, signal } = {}) {
    const topic = chainName(chain);
    const rows = await this.#request(`/v2/ranks?topic=${topic}&limit=30`, { apiKey, signal });
    if (!Array.isArray(rows) || rows.length > 300) throw safe('AVE 行情榜单格式无效', 'AVE_FORMAT');
    const observedAt = this.now();
    return rows.map(row => normalizeToken(row, chain, { observedAt })).filter(Boolean);
  }

  async contracts({ chain, address, apiKey, signal } = {}) {
    const topic = chainName(chain);
    const normalized = addressFor(chain, address);
    if (!normalized) throw safe('待核验代币地址无效', 'AVE_ADDRESS');
    const data = await this.#request(`/v2/contracts/${normalized}-${topic}`, { apiKey, signal });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (Object.hasOwn(data, 'chain') && (typeof data.chain !== 'string' || data.chain.toLowerCase() !== topic)) throw safe('AVE 风险报告链与请求不一致', 'AVE_IDENTITY');
      for (const key of ['token', 'address']) if (Object.hasOwn(data, key) && addressFor(chain, data[key]) !== normalized) throw safe('AVE 风险报告地址与请求不一致', 'AVE_IDENTITY');
    }
    return normalizeRisk(data, this.now());
  }
}
