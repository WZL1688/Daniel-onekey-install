import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici';

const META_KEY = 'market.network.v1';
const DETECTION_TTL = 60000;
const HOSTS = ['api.coingecko.com', 'api.dexscreener.com', 'raw.githubusercontent.com', 'prod.ave-api.com'];
const MODES = new Set(['auto', 'direct', 'proxy']);
const runFile = promisify(execFile);
const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const reasons = new Map([
  ['ENOTFOUND', 'DNS'], ['EAI_AGAIN', 'DNS'],
  ['ETIMEDOUT', 'TIMEOUT'], ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'], ['UND_ERR_HEADERS_TIMEOUT', 'TIMEOUT'], ['UND_ERR_BODY_TIMEOUT', 'TIMEOUT'],
  ['ECONNREFUSED', 'CONNECTION'], ['ECONNRESET', 'CONNECTION'], ['EHOSTUNREACH', 'CONNECTION'], ['ENETUNREACH', 'CONNECTION'], ['UND_ERR_SOCKET', 'CONNECTION'],
  ['CERT_HAS_EXPIRED', 'TLS'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS'], ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS'], ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS'],
  ['UND_ERR_PRX_TLS', 'PROXY'], ['ERR_PROXY_CONNECTION_FAILED', 'PROXY'], ['UND_ERR_PROXY', 'PROXY'],
]);

function failure(message, code = 'MARKET_PROXY_CONFIG', networkReason = 'PROXY') {
  return Object.assign(new Error(message), { safe: true, code, networkReason });
}

// Manual configuration is intentionally limited to an explicitly chosen local
// HTTP proxy. Environment proxy credentials are inherited only, never persisted.
function loopbackProxy(value, { https = false } = {}) {
  if (typeof value !== 'string' || value.length > 200) throw failure('请填写带端口的本机 HTTP 代理地址');
  const match = value.trim().match(/^(http|https):\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/i);
  if (!match || (!https && match[1].toLowerCase() !== 'http')) throw failure('仅支持 localhost、127.0.0.1 或 [::1] 的 HTTP 代理，需明确端口且不能含账户、路径或参数');
  const port = Number(match[3]);
  if (port < 1 || port > 65535) throw failure('代理端口必须在 1–65535 之间');
  return `${match[1].toLowerCase()}://${match[2].toLowerCase()}:${port}`;
}

function settingsFor(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !MODES.has(value.mode ?? 'auto')) throw failure('行情网络模式无效');
  const mode = value.mode ?? 'auto';
  const proxyUrl = value.proxyUrl === undefined || value.proxyUrl === '' ? '' : loopbackProxy(value.proxyUrl);
  if (mode === 'proxy' && !proxyUrl) throw failure('请先填写本机 HTTP 代理地址和端口');
  return { mode, proxyUrl };
}

function environmentValue(env, lower, upper) {
  const value = env[lower] ?? env[upper] ?? '';
  if (typeof value !== 'string' || value.length > 65536 || /[\u0000-\u001f\u007f]/.test(value)) throw failure('环境代理配置无效，请检查 HTTP_PROXY、HTTPS_PROXY 与 NO_PROXY');
  return value;
}

function validateEnvironmentProxy(value) {
  if (!value) return;
  let url;
  try { url = new URL(value); } catch { throw failure('环境代理地址无效，请配置完整的 HTTP(S)_PROXY 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw failure('环境代理仅支持 HTTP(S) 地址；SOCKS 代理请改用软件的 HTTP 或 mixed 端口');
  }
}

async function windowsProxy() {
  const options = { windowsHide: true, timeout: 1500, maxBuffer: 16384, encoding: 'utf8' };
  let enabled;
  try {
    const result = await runFile('reg.exe', ['query', registryKey, '/v', 'ProxyEnable'], options);
    const match = result.stdout.match(/^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)\s*$/im);
    enabled = match ? Number(match[1]) !== 0 : false;
  } catch { return { enabled: false, unavailable: true }; }
  if (!enabled) return { enabled: false };
  try {
    const result = await runFile('reg.exe', ['query', registryKey, '/v', 'ProxyServer'], options);
    return { enabled: true, server: result.stdout.match(/^\s*ProxyServer\s+REG_SZ\s+([^\r\n]*)/im)?.[1] ?? '' };
  } catch { return { enabled: true, server: '' }; }
}

function windowsProxyUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw failure('Windows 手动代理配置无效，请在行情网络设置中指定本机 HTTP 端口');
  const parts = value.split(';').map(part => part.trim()).filter(Boolean);
  const selected = parts.find(part => /^https\s*=/i.test(part))?.replace(/^https\s*=\s*/i, '') ?? parts.find(part => !part.includes('='));
  if (!selected) throw failure('Windows 代理没有可用的 HTTPS 目标配置，请指定本机 HTTP 代理端口');
  try { return loopbackProxy(/^[a-z][a-z0-9+.-]*:\/\//i.test(selected) ? selected : `http://${selected}`, { https: true }); }
  catch { throw failure('Windows 代理不是受支持的本机 HTTP(S) 代理，请在行情网络设置中指定 HTTP 端口'); }
}

function aborted() {
  return Object.assign(new DOMException('行情请求已取消', 'AbortError'), { safe: true, networkReason: 'ABORTED' });
}

async function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw aborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function sanitizedNetworkError(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return aborted();
  if (error?.name === 'TimeoutError') return failure('行情网络请求超时', 'MARKET_NETWORK', 'TIMEOUT');
  const pending = [error];
  let code;
  for (let index = 0; index < pending.length && index < 16; index++) {
    const item = pending[index];
    if (!item || typeof item !== 'object') continue;
    if (reasons.has(item.code)) { code = item.code; break; }
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 4));
  }
  const safe = failure('行情网络请求失败，请检查连接与行情网络设置', 'MARKET_NETWORK', reasons.get(code) ?? 'NETWORK');
  if (code) safe.cause = Object.assign(new Error('行情传输失败'), { code });
  return safe;
}

/** Per-client read-only market transport; never changes global fetch or agents. */
export class MarketNetwork {
  #settings;
  #state;
  #route;
  #pending;
  #generation = 0;
  #closed = false;
  #configurationError;
  #agents = new Set();
  #closing = new Map();
  #detections = new Set();

  constructor({ store, env = process.env, platform = process.platform, readWindowsProxy = windowsProxy, fetchImpl = undiciFetch, allowedHosts = HOSTS, now = Date.now } = {}) {
    this.store = store;
    this.env = env;
    this.platform = platform;
    this.readWindowsProxy = readWindowsProxy;
    this.fetchImpl = fetchImpl;
    this.allowedHosts = new Set(allowedHosts);
    this.now = now;
    try { this.#settings = settingsFor(store?.getMeta(META_KEY) ?? {}); }
    catch { this.#settings = { mode: 'auto', proxyUrl: '' }; this.#configurationError = failure('保存的行情网络配置无效，请重新保存网络设置'); }
    this.#resetState();
  }

  #resetState() {
    this.#state = { effectiveRoute: 'direct', proxyDetected: false, routeLabel: '等待网络检测', reason: this.#configurationError?.message ?? '首次行情请求时检测；仅影响行情数据，不改变钱包与 RPC 设置', lastDetectedAt: null };
  }

  snapshot() { return { ...this.#settings, ...this.#state }; }

  #retire(agent) {
    if (!agent || this.#closing.has(agent)) return;
    const closing = Promise.resolve().then(() => agent.close()).catch(() => {}).finally(() => { this.#agents.delete(agent); this.#closing.delete(agent); });
    this.#closing.set(agent, closing);
  }

  invalidate() {
    this.#generation++;
    this.#retire(this.#route?.dispatcher);
    this.#route = undefined;
    this.#pending = undefined;
    this.#resetState();
  }

  async refresh() { this.invalidate(); return this.prepare(); }

  async saveSettings(value) {
    if (this.#closed) throw failure('行情网络连接已关闭', 'MARKET_NETWORK_CLOSED', 'NETWORK');
    const next = settingsFor(value);
    this.store?.setMeta(META_KEY, next);
    this.#settings = next;
    this.#configurationError = undefined;
    this.invalidate();
    return this.prepare();
  }

  async #detect() {
    if (this.#configurationError) throw this.#configurationError;
    let effectiveRoute = 'direct', proxyDetected = false, routeLabel = '直接连接', reason = '未检测到 HTTP(S) 代理，行情数据使用直连', create = () => new Agent();
    const { mode, proxyUrl } = this.#settings;
    try {
      if (mode === 'direct') reason = '已明确选择直连；忽略全局环境代理与 Windows 系统代理';
      else if (mode === 'proxy') {
        effectiveRoute = 'manual'; proxyDetected = true; routeLabel = '手动本机代理'; reason = '行情数据使用已保存的本机 HTTP 代理；连接失败时不会改为直连';
        create = () => new ProxyAgent(proxyUrl);
      } else {
        const httpProxy = environmentValue(this.env, 'http_proxy', 'HTTP_PROXY');
        const httpsProxy = environmentValue(this.env, 'https_proxy', 'HTTPS_PROXY');
        const noProxy = environmentValue(this.env, 'no_proxy', 'NO_PROXY');
        const allProxy = environmentValue(this.env, 'all_proxy', 'ALL_PROXY');
        if (httpProxy || httpsProxy || allProxy) {
          effectiveRoute = 'env'; proxyDetected = true; routeLabel = '环境代理';
          if (!httpProxy && !httpsProxy) throw failure('仅检测到 ALL_PROXY；请配置 HTTP_PROXY 或 HTTPS_PROXY，SOCKS 代理需改用 HTTP 或 mixed 端口');
          validateEnvironmentProxy(httpProxy); validateEnvironmentProxy(httpsProxy);
          create = () => new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
          reason = '行情数据遵循 HTTP(S)_PROXY 与 NO_PROXY；代理地址和凭据不会显示或保存';
        } else if (this.platform === 'win32') {
          let detected;
          try { detected = await this.readWindowsProxy(); } catch { throw failure('无法检查 Windows 代理，请手动选择直连或配置本机 HTTP 代理'); }
          if (detected?.unavailable) throw failure('Windows 代理检查不可用，请手动选择直连或配置本机 HTTP 代理');
          if (detected?.enabled) {
            effectiveRoute = 'windows'; proxyDetected = true; routeLabel = 'Windows 本机代理';
            const detectedUrl = windowsProxyUrl(detected.server);
            create = () => new ProxyAgent(detectedUrl);
            reason = '行情数据使用检测到的 Windows 本机 HTTP(S) 代理；未读取或执行 PAC';
          } else reason = 'Windows 未启用可识别的手动代理，行情数据使用直连；可手动填写 HTTP 或 mixed 端口';
        }
      }
      let dispatcher;
      try { dispatcher = create(); } catch { throw failure('无法创建行情代理连接，请检查 HTTP(S) 代理配置'); }
      this.#agents.add(dispatcher);
      return { dispatcher, state: { effectiveRoute, proxyDetected, routeLabel, reason, lastDetectedAt: this.now() } };
    } catch (error) {
      const safe = error?.safe && error?.code === 'MARKET_PROXY_CONFIG' ? error : failure('行情代理配置无效，请重新保存行情网络设置');
      return { error: safe, state: { effectiveRoute, proxyDetected, routeLabel, reason: safe.message, lastDetectedAt: this.now() } };
    }
  }

  async prepare() {
    if (this.#closed) throw failure('行情网络连接已关闭', 'MARKET_NETWORK_CLOSED', 'NETWORK');
    const elapsed = this.now() - this.#state.lastDetectedAt;
    if (this.#route && elapsed >= 0 && elapsed < DETECTION_TTL) {
      if (this.#route.error) throw this.#route.error;
      return this.snapshot();
    }
    if (!this.#pending) {
      const generation = this.#generation;
      const previous = this.#route;
      const pending = this.#detect().then(route => {
        if (this.#closed || generation !== this.#generation) { this.#retire(route.dispatcher); return; }
        this.#route = route;
        this.#state = route.state;
        this.#retire(previous?.dispatcher);
      }).finally(() => { this.#detections.delete(pending); if (this.#pending === pending) this.#pending = undefined; });
      this.#detections.add(pending);
      this.#pending = pending;
    }
    const generation = this.#generation;
    await this.#pending;
    if (generation !== this.#generation) return this.prepare();
    if (this.#closed) throw failure('行情网络连接已关闭', 'MARKET_NETWORK_CLOSED', 'NETWORK');
    if (this.#route?.error) throw this.#route.error;
    return this.snapshot();
  }

  fetch = async (value, options = {}) => {
    let url;
    try { if (typeof value !== 'string' && !(value instanceof URL)) throw new Error(); url = new URL(value); }
    catch { throw failure('行情请求地址无效', 'MARKET_NETWORK_TARGET', 'NETWORK'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !this.allowedHosts.has(url.hostname)) throw failure('行情请求仅支持已登记的 HTTPS 数据来源', 'MARKET_NETWORK_TARGET', 'NETWORK');
    if (options.signal?.aborted) throw aborted();
    await withSignal(this.prepare(), options.signal);
    if (options.signal?.aborted) throw aborted();
    try { return await this.fetchImpl(url.href, { ...options, redirect: 'error', dispatcher: this.#route.dispatcher }); }
    catch (error) { throw sanitizedNetworkError(error, options.signal); }
  };

  async close() {
    this.#closed = true;
    this.#generation++;
    await Promise.all([...this.#detections].map(pending => pending.catch(() => {})));
    for (const agent of this.#agents) this.#retire(agent);
    await Promise.all([...this.#closing.values()]);
  }
}
