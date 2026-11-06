// Public GET requests only. Does not import application state or credentials.
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch } from 'undici';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const routes = {
  binance: ['https://api.binance.com/api/v3/time', 'https://api.binance.com/api/v3/exchangeInfo', 'https://api.binance.com/api/v3/depth?symbol=ETHUSDT&limit=100'],
  okx: ['https://www.okx.com/api/v5/public/time', 'https://www.okx.com/api/v5/public/instruments?instType=SPOT', 'https://www.okx.com/api/v5/market/books?instId=ETH-USDT&sz=400'],
};
const maxBytes = 15000000;
export function validateProxyUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('INVALID_PROXY_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw Error('INVALID_PROXY_URL');
  return url.href;
}
function networkCode(error, phase, signal) {
  if ((signal.aborted && signal.reason?.name === 'TimeoutError') || error?.name === 'TimeoutError' || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error?.cause?.code)) return phase + '_TIMEOUT';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error?.cause?.code)) return 'TLS_CERTIFICATE_ERROR';
  return phase + '_READ_ERROR';
}
async function check(url, exchange, index, dispatcher, fetchFn, now, timeoutSignal) {
  const start = now(), monotonic = performance.now();
  const signal = timeoutSignal();
  const result = { route: new URL(url).pathname, http: null, elapsedMs: 0, bytes: 0, code: 'OK' };
  let response, phase = 'HEADERS';
  try {
    response = await fetchFn(url, { method: 'GET', dispatcher, signal, redirect: 'error' });
    result.http = response.status;
    if (response.status !== 200) {
      result.code = response.status === 451 ? 'HTTP_451_RESTRICTED_LOCATION' : 'HTTP_ERROR';
      try { await response.body?.cancel(); } catch { /* The HTTP refusal is already definitive. */ }
      return { result };
    }
    phase = 'BODY';
    const chunks = [];
    for await (const chunk of response.body) {
      result.bytes += chunk.length;
      if (result.bytes > maxBytes) { result.code = 'RESPONSE_TOO_LARGE'; return { result }; }
      chunks.push(Buffer.from(chunk));
    }
    const end = now();
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { result.code = 'INVALID_JSON'; return { result }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { result.code = 'INVALID_JSON_DATA'; return { result }; }
    if (exchange === 'okx' && String(data?.code) !== '0') { result.code = 'EXCHANGE_ERROR'; return { result }; }
    if (index === 0) {
      const serverTime = Number(exchange === 'okx' ? data.data?.[0]?.ts : data.serverTime);
      if (!Number.isSafeInteger(serverTime) || serverTime <= 0) { result.code = 'INVALID_TIME_DATA'; return { result }; }
      return { result, offsetMs: serverTime - (start + end) / 2, localElapsedMs: end - start };
    }
    if (index === 1) {
      const items = exchange === 'okx' ? data.data : data.symbols;
      if (!Array.isArray(items) || !items.length) result.code = 'INVALID_RULES_DATA';
      else result.items = items.length;
      return { result };
    }
    const book = exchange === 'okx' ? data.data?.[0] : data;
    if (!Array.isArray(book?.bids) || !book.bids.length || !Array.isArray(book?.asks) || !book.asks.length) {
      result.code = 'INVALID_BOOK_DATA'; return { result };
    }
    result.bidLevels = book.bids.length; result.askLevels = book.asks.length;
    if (exchange === 'okx') {
      const ts = Number(book.ts);
      if (!Number.isSafeInteger(ts) || ts <= 0) { result.code = 'INVALID_BOOK_TIME'; return { result }; }
      return { result, bookAt: ts, receivedAt: end };
    }
    return { result };
  } catch (error) {
    result.code = networkCode(error, phase, signal);
    return { result };
  } finally { result.elapsedMs = Math.round(performance.now() - monotonic); }
}
export async function diagnoseNetwork({ dispatcher, fetchFn = fetch, now = Date.now, timeoutSignal = () => AbortSignal.timeout(10000) } = {}) {
  const report = { scope: 'PUBLIC_NETWORK_DIAGNOSTIC', publicOnly: true, privateRequests: 0, orderRequests: 0, exchanges: {} };
  await Promise.all(Object.entries(routes).map(async ([exchange, urls]) => {
    const entry = report.exchanges[exchange] = { requests: [] };
    let offsetMs;
    for (let index = 0; index < urls.length; index++) {
      const sample = await check(urls[index], exchange, index, dispatcher, fetchFn, now, timeoutSignal);
      entry.requests.push(sample.result);
      if (sample.result.code !== 'OK') { entry.stoppedAfterFailure = true; break; }
      if (index === 0) {
        offsetMs = sample.offsetMs;
        entry.clockOffsetMs = Math.round(offsetMs);
        entry.clockRttWithin2000Ms = sample.result.elapsedMs <= 2000;
        entry.clockOffsetWithin30000Ms = Math.abs(offsetMs) <= 30000;
        entry.localClockChangedDuringTimeRequest = Math.abs(sample.localElapsedMs - sample.result.elapsedMs) > 250;
        entry.localClockStable = !entry.localClockChangedDuringTimeRequest;
        entry.clockTrustedForApp = entry.clockRttWithin2000Ms && entry.clockOffsetWithin30000Ms && !entry.localClockChangedDuringTimeRequest;
      }
      if (sample.bookAt !== undefined) {
        entry.estimatedBookAgeMs = Math.round(sample.receivedAt + offsetMs - sample.bookAt);
        entry.bookAgeEstimateTrusted = entry.clockTrustedForApp;
        entry.bookTimeWithinDefaultWindow = entry.bookAgeEstimateTrusted ? entry.estimatedBookAgeMs >= -1000 && entry.estimatedBookAgeMs <= 5000 : null;
      }
    }
  }));
  report.publicRequests = Object.values(report.exchanges).reduce((sum, entry) => sum + entry.requests.length, 0);
  report.diagnosticsPassed = Object.entries(report.exchanges).every(([exchange, entry]) => !entry.stoppedAfterFailure && entry.clockTrustedForApp === true && (exchange !== 'okx' || entry.bookTimeWithinDefaultWindow === true));
  return report;
}
export function parseArgs(args) {
  if (!args.length) return { mode: 'environment' };
  if (args.length === 1 && args[0] === '--direct') return { mode: 'direct' };
  if (args.length === 1 && args[0] === '--interactive') return { mode: 'interactive' };
  if (args.length === 2 && args[0] === '--proxy') return { mode: 'proxy', proxy: validateProxyUrl(args[1]) };
  throw Error('INVALID_ARGUMENTS');
}
async function main() {
  let options = parseArgs(process.argv.slice(2));
  if (options.mode === 'interactive') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = (await rl.question('Proxy URL (Enter = http://127.0.0.1:7897; direct = no proxy): ')).trim(); }
    finally { rl.close(); }
    options = answer === 'direct' ? { mode: 'direct' } : { mode: 'proxy', proxy: validateProxyUrl(answer || 'http://127.0.0.1:7897') };
  }
  const dispatcher = options.mode === 'proxy' ? new ProxyAgent(options.proxy) : options.mode === 'direct' ? new Agent() : new EnvHttpProxyAgent();
  try {
    const report = await diagnoseNetwork({ dispatcher });
    report.proxyMode = options.mode;
    console.log(JSON.stringify(report, null, 2));
    if (!report.diagnosticsPassed) process.exitCode = 1;
  } finally { await dispatcher.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('DIAGNOSTIC_ERROR: Check arguments, proxy format and installed dependencies.'); process.exitCode = 1; });
}
