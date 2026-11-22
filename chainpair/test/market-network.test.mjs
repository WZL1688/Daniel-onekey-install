import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer as netServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getGlobalDispatcher } from 'undici';
import { MarketNetwork } from '../src/market-network.mjs';

const runFile = promisify(execFile);
const endpoint = 'https://api.dexscreener.com/tokens/v1/bsc/fixture';
const memoryStore = initial => ({
  value: initial,
  writes: [],
  getMeta(key) { assert.equal(key, 'market.network.v1'); return this.value; },
  setMeta(key, value) { assert.equal(key, 'market.network.v1'); this.value = structuredClone(value); this.writes.push(this.value); },
});
const configError = error => error.safe === true && error.code === 'MARKET_PROXY_CONFIG' && error.networkReason === 'PROXY';
const setup = (t, options = {}) => {
  const calls = [];
  const network = new MarketNetwork({ store: memoryStore(), env: {}, platform: 'linux', fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('[]'); }, ...options });
  t.after(() => network.close());
  return { network, calls };
};

test('default transport and explicit direct mode keep per-request Agent without changing global agents', async t => {
  const globalFetch = globalThis.fetch, globalDispatcher = getGlobalDispatcher();
  const { network, calls } = setup(t, { env: { HTTPS_PROXY: 'http://private-user:private-pass@proxy.invalid:8080' } });
  await network.saveSettings({ mode: 'direct', proxyUrl: '' });
  const controller = new AbortController(), headers = { Accept: 'application/json', 'x-unit-header': 'preserved' };
  const boundFetch = network.fetch;
  await boundFetch(endpoint, { headers, signal: controller.signal, redirect: 'follow', dispatcher: { unsafe: true } });
  assert.equal(calls[0].options.dispatcher.constructor.name, 'Agent');
  assert.equal(calls[0].options.headers, headers);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(network.snapshot().effectiveRoute, 'direct');
  assert.equal(globalThis.fetch, globalFetch);
  assert.equal(getGlobalDispatcher(), globalDispatcher);
  assert.equal(JSON.stringify(network.snapshot()).includes('private-pass'), false);
});

test('settings persist only whitelisted fields and a valid local manual proxy survives restart', async t => {
  const store = memoryStore();
  const { network, calls } = setup(t, { store });
  await network.saveSettings({ mode: 'proxy', proxyUrl: 'http://LOCALHOST:7890/', password: 'must-not-save', allowedHosts: ['evil.invalid'] });
  assert.deepEqual(store.writes, [{ mode: 'proxy', proxyUrl: 'http://localhost:7890' }]);
  assert.equal(network.snapshot().effectiveRoute, 'manual');
  await network.fetch(endpoint);
  assert.equal(calls[0].options.dispatcher.constructor.name, 'ProxyAgent');
  const restarted = new MarketNetwork({ store, env: {}, platform: 'linux', fetchImpl: async () => new Response('[]') });
  t.after(() => restarted.close());
  await restarted.prepare();
  assert.equal(restarted.snapshot().proxyUrl, 'http://localhost:7890');
  assert.equal(restarted.snapshot().effectiveRoute, 'manual');
  await restarted.saveSettings({ mode: 'proxy', proxyUrl: 'http://[::1]:80' });
  assert.equal(restarted.snapshot().proxyUrl, 'http://[::1]:80');
});

test('invalid manual proxies fail before storage or network dispatch', async t => {
  const store = memoryStore();
  const { network, calls } = setup(t, { store });
  for (const proxyUrl of ['', 'http://localhost', 'https://localhost:7890', 'socks5://localhost:7890', 'http://user:pass@localhost:7890', 'http://localhost:7890/path', 'http://localhost:7890/?x=1', 'http://localhost:7890/#secret', 'http://localhost:0', 'http://localhost:65536', 'http://localhost.evil.invalid:7890', 'http://192.168.1.1:7890', 'http://127.1:7890', 'http://2130706433:7890', 'http://localhost:7890\\evil']) {
    await assert.rejects(network.saveSettings({ mode: 'proxy', proxyUrl }), configError);
  }
  await assert.rejects(network.saveSettings({ mode: 'global' }), configError);
  assert.equal(store.writes.length, 0);
  assert.equal(calls.length, 0);
});

test('environment proxies retain lowercase precedence and never enter snapshot or storage', async t => {
  const store = memoryStore();
  const { network, calls } = setup(t, { store, env: {
    http_proxy: 'http://lower-user:lower-secret@127.0.0.1:7890',
    HTTP_PROXY: 'socks5://upper-user:upper-secret@localhost:9',
    no_proxy: '', NO_PROXY: '*',
  } });
  await network.prepare();
  await network.fetch(endpoint);
  assert.equal(calls[0].options.dispatcher.constructor.name, 'EnvHttpProxyAgent');
  assert.equal(network.snapshot().effectiveRoute, 'env');
  assert.equal(network.snapshot().proxyDetected, true);
  assert.equal(network.snapshot().proxyUrl, '');
  assert.equal(store.writes.length, 0);
  for (const value of ['lower-secret', 'upper-secret', '7890', 'lower-user']) assert.equal(JSON.stringify(network.snapshot()).includes(value), false);
});

test('unsupported or malformed environment proxy fails closed with fixed errors and no direct fallback', async t => {
  for (const env of [
    { ALL_PROXY: 'socks5://sensitive-user:sensitive-password@localhost:1080' },
    { HTTPS_PROXY: 'socks5://sensitive-user:sensitive-password@localhost:1080' },
    { HTTPS_PROXY: 'not-a-url-sensitive-password' },
    { HTTPS_PROXY: 'http://sensitive-user:sensitive-password@localhost:7890/path' },
    { HTTPS_PROXY: 'http://localhost:7890', NO_PROXY: 'sensitive-password\n' },
  ]) {
    let called = false;
    const { network } = setup(t, { env, fetchImpl: async () => { called = true; return new Response('[]'); } });
    await assert.rejects(network.fetch(endpoint), error => configError(error) && !String(error).includes('sensitive-'));
    assert.equal(called, false);
    assert.equal(JSON.stringify(network.snapshot()).includes('sensitive-'), false);
  }
});

test('automatic Windows detection selects HTTPS target entry, adds HTTP scheme and caches for sixty seconds', async t => {
  let at = 1000, reads = 0;
  const { network, calls } = setup(t, { platform: 'win32', now: () => at, readWindowsProxy: async () => { reads++; return reads === 1 ? { enabled: true, server: 'http=127.0.0.1:8888;https=127.0.0.1:7890' } : { enabled: false }; } });
  await network.prepare();
  assert.equal(network.snapshot().effectiveRoute, 'windows');
  assert.equal(network.snapshot().lastDetectedAt, 1000);
  assert.equal(network.snapshot().proxyUrl, '');
  await network.fetch(endpoint);
  assert.equal(calls[0].options.dispatcher.constructor.name, 'ProxyAgent');
  at += 59999;
  await network.prepare();
  assert.equal(reads, 1);
  at += 2;
  await network.prepare();
  assert.equal(reads, 2);
  assert.equal(network.snapshot().effectiveRoute, 'direct');
  await network.saveSettings({ mode: 'direct' });
  assert.equal(reads, 2);
});

test('environment proxy takes precedence over Windows and no PAC or guessed port is used', async t => {
  let reads = 0;
  const { network } = setup(t, { platform: 'win32', env: { HTTPS_PROXY: 'http://localhost:7890' }, readWindowsProxy: async () => { reads++; throw new Error('should not read'); } });
  await network.prepare();
  assert.equal(network.snapshot().effectiveRoute, 'env');
  assert.equal(reads, 0);
  const { network: pacOnly } = setup(t, { platform: 'win32', readWindowsProxy: async () => ({ enabled: false, pac: 'https://evil.invalid/pac.js' }) });
  await pacOnly.prepare();
  assert.equal(pacOnly.snapshot().effectiveRoute, 'direct');
  assert.equal(pacOnly.snapshot().proxyDetected, false);
});

test('enabled but unsupported Windows proxy is rejected without echoing its address', async t => {
  for (const server of ['https=proxy-secret.invalid:7890', 'socks=127.0.0.1:1080', 'https=http://private-user:private-pass@127.0.0.1:7890', 'https=127.0.0.1:7890/secret', '']) {
    const { network, calls } = setup(t, { platform: 'win32', readWindowsProxy: async () => ({ enabled: true, server }) });
    await assert.rejects(network.fetch(endpoint), configError);
    assert.equal(network.snapshot().effectiveRoute, 'windows');
    assert.equal(network.snapshot().proxyDetected, true);
    assert.equal(JSON.stringify(network.snapshot()).includes('private-'), false);
    assert.equal(JSON.stringify(network.snapshot()).includes('proxy-secret'), false);
    assert.equal(calls.length, 0);
  }
});

test('failed Windows proxy inspection requires an explicit route instead of silently falling back', async t => {
  const { network, calls } = setup(t, { platform: 'win32', readWindowsProxy: async () => ({ unavailable: true, enabled: false }) });
  await assert.rejects(network.fetch(endpoint), configError);
  assert.equal(calls.length, 0);
  await network.saveSettings({ mode: 'direct' });
  await network.fetch(endpoint);
  assert.equal(calls.length, 1);
});

test('caller abort cancels waiting for proxy detection and never dispatches the request', async t => {
  let finish, reads = 0;
  const controller = new AbortController();
  const { network, calls } = setup(t, { platform: 'win32', readWindowsProxy: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = network.fetch(endpoint, { signal: controller.signal });
  controller.abort(new Error('sensitive-abort-text'));
  await assert.rejects(pending, error => error.name === 'AbortError' && !String(error).includes('sensitive-'));
  assert.equal(calls.length, 0);
  finish({ enabled: false });
  await network.prepare();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(network.fetch(endpoint, { signal: alreadyAborted.signal }), { name: 'AbortError' });
  assert.equal(reads, 1);
});

test('obsolete Windows detection cannot overwrite a newly saved explicit direct route', async t => {
  let finish;
  const { network, calls } = setup(t, { platform: 'win32', readWindowsProxy: () => new Promise(resolve => { finish = resolve; }) });
  const first = network.prepare();
  await network.saveSettings({ mode: 'direct' });
  finish({ enabled: true, server: '127.0.0.1:7890' });
  await first;
  await network.fetch(endpoint);
  assert.equal(network.snapshot().mode, 'direct');
  assert.equal(network.snapshot().effectiveRoute, 'direct');
  assert.equal(calls[0].options.dispatcher.constructor.name, 'Agent');
});

test('transport sanitizes nested network errors while preserving diagnostic reason and safe code', async t => {
  for (const [code, expected] of [['EAI_AGAIN', 'DNS'], ['ECONNREFUSED', 'CONNECTION'], ['CERT_HAS_EXPIRED', 'TLS'], ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'], ['ERR_PROXY_CONNECTION_FAILED', 'PROXY']]) {
    const { network } = setup(t, { fetchImpl: async () => { throw new TypeError('http://private-user:private-password@127.0.0.1:7890', { cause: Object.assign(new Error('private-password'), { code }) }); } });
    await assert.rejects(network.fetch(endpoint), error => error.safe && error.code === 'MARKET_NETWORK' && error.networkReason === expected && error.cause?.code === code && !String(error).includes('private-') && !JSON.stringify(error).includes('private-'));
  }
});

test('only registered HTTPS hosts are dispatched and redirects cannot be enabled by caller', async t => {
  const { network, calls } = setup(t);
  for (const url of ['http://api.dexscreener.com/x', 'https://api.dexscreener.com.evil.invalid/x', 'https://user:pass@api.dexscreener.com/x', 'https://api.dexscreener.com/x#secret', 'https://127.0.0.1:7890/', 'file:///tmp/secret', 'bad-url', {}]) {
    await assert.rejects(network.fetch(url), { safe: true, code: 'MARKET_NETWORK_TARGET' });
  }
  assert.equal(calls.length, 0);
  for (const host of ['api.coingecko.com', 'api.dexscreener.com', 'raw.githubusercontent.com', 'prod.ave-api.com']) await network.fetch('https://' + host + '/fixed', { redirect: 'follow' });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
});

test('corrupt persisted configuration does not leak or silently activate direct fetch', async t => {
  const { network, calls } = setup(t, { store: memoryStore({ mode: 'proxy', proxyUrl: 'http://sensitive-user:sensitive-password@localhost:7890' }) });
  await assert.rejects(network.fetch(endpoint), configError);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(network.snapshot()).includes('sensitive-'), false);
  await network.saveSettings({ mode: 'direct' });
  await network.fetch(endpoint);
  assert.equal(calls.length, 1);
});

test('closed transport rejects future requests and settings changes', async t => {
  const { network } = setup(t);
  await network.prepare();
  await network.close();
  await assert.rejects(network.fetch(endpoint), { safe: true, code: 'MARKET_NETWORK_CLOSED' });
  await assert.rejects(network.saveSettings({ mode: 'direct' }), { safe: true, code: 'MARKET_NETWORK_CLOSED' });
});

// Public, disposable TLS fixture used only by the offline localhost tests below.
// NODE_EXTRA_CA_CERTS trusts this certificate in a child process; TLS validation
// remains enabled. This key is not a wallet, credential, or production identity.
const tlsFixture = {
  "key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDDHC/QeRXK63Yc\nSPVoxQktGkNAM4/tQsEpjgFAL5VPE4mR9yycR30vrN3tVijWKuc9JSkfxQSwChPh\nRoMXEe0QOqr8mw0PpPesdE9qEFfbGCGvLWNpeaNKwLvgapKyK3oy7vgTSuDKR/TK\nHgDD64C1GFvXxIj/EdktpJXPorcPkO4gs9xQ/c1GM/JspyzLBOIdG6E+Vgk9Zsc8\nonUPT/w0aCCwUQAtGQyiFY5gwoke5sJ9vj+GBG2wdOwR4qBsnilt59QY/O0yr0lU\nNyxTx4KHqrbhCsLP0Y5RZNAwOwXSX6NCTubLUoic115m8yW0RcWPj4qyAtNuk128\nMGDOQW0ZAgMBAAECggEAFzR6gVZtX5l6jimlOmU4zqrxdajMROEsHRedEXe3T9TY\nh0o4/YtJGcr7CBe3uqUWpICPcA5cHN3N+HyM6ckBg20e2fVM69/obxPUQB6afF3V\n38JLsQc9Aw6CKdIzCUq/eWBPk+fTbWt6czF3UNXpFGDFx5dB3ehPBq0s/ilxkUGr\njqLSGD6UAcvXo26Fi6bjxqK/HQRRDgKpdX3NJrgjzKcVLEs1rZGXpKxVxvtKdbJF\npZkc/ESjrBlkdd4xX0NXngafQbWWJUxSSapQqcqKcaOLqwiaeCSat4Fc0lzibVa2\nTDDv+CCp/OnaTPNn/DlGwFPlPiJuG0Hzuoy4nd+PGwKBgQD2XTXqm+EJ6e28kwsI\nQDtECp1IHZJsjVvzfYRbtAAO85bFzJ9ijwWY52Le6KrZtF2Wk7eg60AfHNo87uuD\nOLQURdEtj/pwaahVUa3BgX/reYo4YxLXKap+eQ0vDpfyRkPjkUBsVdtpYp6LLld9\nRhjrSMiqV74wRx8TZ3nTt55eewKBgQDKvcf7jvVw5OR4QD27/rpUw6sB4vRh757a\nxSLGS1tnr07Kbjt2JYwYqVdAEcQM/PpnvkDMo4xkfezfmvRhUm9/YJrFdopRNJuR\nZbA+ftEyg8orvWWmr4brtqRf1K1yB/16l3rj2iB1zQFtXOjw8ecPh3D0fBubj6Hp\nIUgTcuOYewKBgQCd7/eGpdPI5TzRbXrfGT5lSmC2QK8EBEN0f30AxQ5ch3Ca8akk\nKAgwk/XgbUxKMMTmqWBJO0dqKrcF5Sz6fLmFXZTSHsEwm6uctrYrnXeCX/JqX6lO\nYpm4ZqY7CqICYWVYWF/yk8ALeXumQlk4KF4FSC3Mdl+o149mgymovsg6TQKBgQCv\ns2EIpZAX0oYdoK7fqZYZt6kP7XwVE/D7bzT/3HbOmKMT1Aw8C7Yp+TfgEoVxLBxm\no/7MWkBlJqyN7GA1p5dxMGtxDZY5YfogO5xNzOHHgWdIGM9rcVrgFFzHoCzgUgRe\npcCejn7rGEtQV+CYT0wLrTk66AOVARk0TN+F219a2QKBgCPKXwTvB3M9pEDP2gxl\nF5F6Jz1WOBK6Y4U2nKPSv/bi+ujPw/MkB3drI6YNuA/CH0fLwTPTig2QGGCms+IX\nI77i/QTaOwikJ4H+21bP+CL4AOBe5R+vV6lmCfHq9zEtAsT81J1sXVxW2coV789A\nXNVvCfyUyRlieoOXSMd/A17q\n-----END PRIVATE KEY-----\n",
  "cert": "-----BEGIN CERTIFICATE-----\nMIIDYjCCAkqgAwIBAgIUbJ+A2uQ2rINuuDasxrORQO7cpygwDQYJKoZIhvcNAQEL\nBQAwKTEnMCUGA1UEAwweQ2hhaW5QYWlyIG9mZmxpbmUgdGVzdCBmaXh0dXJlMB4X\nDTI2MTEyMjAyMDEyOVoXDTM2MTExOTAyMDEyOVowKTEnMCUGA1UEAwweQ2hhaW5Q\nYWlyIG9mZmxpbmUgdGVzdCBmaXh0dXJlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\nMIIBCgKCAQEAwxwv0HkVyut2HEj1aMUJLRpDQDOP7ULBKY4BQC+VTxOJkfcsnEd9\nL6zd7VYo1irnPSUpH8UEsAoT4UaDFxHtEDqq/JsND6T3rHRPahBX2xghry1jaXmj\nSsC74GqSsit6Mu74E0rgykf0yh4Aw+uAtRhb18SI/xHZLaSVz6K3D5DuILPcUP3N\nRjPybKcsywTiHRuhPlYJPWbHPKJ1D0/8NGggsFEALRkMohWOYMKJHubCfb4/hgRt\nsHTsEeKgbJ4pbefUGPztMq9JVDcsU8eCh6q24QrCz9GOUWTQMDsF0l+jQk7my1KI\nnNdeZvMltEXFj4+KsgLTbpNdvDBgzkFtGQIDAQABo4GBMH8wHQYDVR0OBBYEFEno\nIiwe7vY7MFjS3fP7/lkXtaPWMB8GA1UdIwQYMBaAFEnoIiwe7vY7MFjS3fP7/lkX\ntaPWMCwGA1UdEQQlMCOCCWxvY2FsaG9zdIcEfwAAAYcQAAAAAAAAAAAAAAAAAAAA\nATAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA86YEvR3ybHepW\nooEZRmPY+R6ebkqZhFEBe9rBx10Hm79g3m8OkEDN+jEMXqYMMlj8uspvC6R+cSzR\n5zIxw+EOpPOBBusel7/07R4EZg/8bNpB0TeILFrdrEK6nsYWlUuv1oajk6ARp3Wg\nIOxddaLdDFd0dA840ebsf+cAlZ4WUgvss//3tGYSC5wm5jPJJcuc+FuxywwXs04i\nD3suokX+9c7OhtrYsGecCFN8r58ZV5S+4gZ592uI/Yo+ey2TCygx7bQA3SsOoAkV\nabMen8iway/eT34ftVUV+a3DBPOe3OiKDJHWMJTmIANhsTDJLOvCIm/GE6lGZzrR\n4G90HyM9\n-----END CERTIFICATE-----\n"
};

const wrongHostnameCert = "-----BEGIN CERTIFICATE-----\nMIIDOjCCAiKgAwIBAgIUQmdlvd2P7fLPohmKggsbEGm1UvMwDQYJKoZIhvcNAQEL\nBQAwHTEbMBkGA1UEAwwSd3JvbmctaG9zdC5pbnZhbGlkMB4XDTI2MTEyMjAyMDQ1\nMFoXDTM2MTExOTAyMDQ1MFowHTEbMBkGA1UEAwwSd3JvbmctaG9zdC5pbnZhbGlk\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwxwv0HkVyut2HEj1aMUJ\nLRpDQDOP7ULBKY4BQC+VTxOJkfcsnEd9L6zd7VYo1irnPSUpH8UEsAoT4UaDFxHt\nEDqq/JsND6T3rHRPahBX2xghry1jaXmjSsC74GqSsit6Mu74E0rgykf0yh4Aw+uA\ntRhb18SI/xHZLaSVz6K3D5DuILPcUP3NRjPybKcsywTiHRuhPlYJPWbHPKJ1D0/8\nNGggsFEALRkMohWOYMKJHubCfb4/hgRtsHTsEeKgbJ4pbefUGPztMq9JVDcsU8eC\nh6q24QrCz9GOUWTQMDsF0l+jQk7my1KInNdeZvMltEXFj4+KsgLTbpNdvDBgzkFt\nGQIDAQABo3IwcDAdBgNVHQ4EFgQUSegiLB7u9jswWNLd8/v+WRe1o9YwHwYDVR0j\nBBgwFoAUSegiLB7u9jswWNLd8/v+WRe1o9YwHQYDVR0RBBYwFIISd3JvbmctaG9z\ndC5pbnZhbGlkMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAAMg\nmE1/HdeCj3yG6A0BiC/IS6S4v0RQ4Omwuptm3TMKQJNqnUFtN+iHgwiMlndVnVfy\nRfpHL5nd2fOobQDeiU6G00hCdBemU2gQlFGoxsdFbWl11Iu2QHq/9QKWK1Su37Zy\nCQEi9JTK1sIn01kciIbQOyg+yRxotQbmBqbIqswZ7H+yEiJsyoRG5RhyO6OmUALY\nEvg3bOSCYvivaIW6NX+M/IOa5FF+oQ35GUI9vcVQcWZYLP+xQC0MREBD9s9WW47s\nbBpeAsyfi0z4Ufm8zFfeQWwPBF2QTc50SPMX/zRRVWY2EQ/x3miNTP1DEX5hXx98\npCPoeLMCH2JZyOS6bWg=\n-----END CERTIFICATE-----\n";

test('offline HTTP CONNECT preserves headers, env precedence and NO_PROXY while explicit direct overrides global proxy', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chainpair-market-network-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificatePath = path.join(directory, 'fixture-ca.pem');
  await writeFile(certificatePath, tlsFixture.cert);
  const seen = [];
  const target = httpsServer({ key: tlsFixture.key, cert: tlsFixture.cert }, (request, response) => {
    seen.push({ token: request.headers['x-fixture-header'], url: request.url });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, token: request.headers['x-fixture-header'] }));
  });
  target.on('tlsClientError', () => {});
  const sockets = new Set();
  target.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => target.close(resolve)); });
  const targetPort = target.address().port;
  const tunnelRequests = [];
  const proxySockets = new Set();
  const proxy = httpServer((_request, response) => { response.writeHead(405); response.end(); });
  proxy.on('connection', socket => { proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); });
  proxy.on('connect', (request, client, head) => {
    tunnelRequests.push({ authority: request.url, authorization: request.headers['proxy-authorization'] ?? null });
    if (request.url !== '127.0.0.1:' + targetPort) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of proxySockets) socket.destroy(); return new Promise(resolve => proxy.close(resolve)); });
  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
  const targetUrl = 'https://127.0.0.1:' + targetPort + '/fixture';
  const moduleUrl = new URL('../src/market-network.mjs', import.meta.url).href;
  const script = [
    'import { MarketNetwork } from ' + JSON.stringify(moduleUrl) + ';',
    'const targetUrl = ' + JSON.stringify(targetUrl) + ';',
    'const proxyUrl = ' + JSON.stringify(proxyUrl) + ';',
    'const outputs = [];',
    'for (const item of [',
    "  { mode: 'proxy', env: {}, token: 'manual' },",
    "  { mode: 'auto', env: { http_proxy: proxyUrl.replace('http://', 'http://unit-user:unit-secret@'), HTTP_PROXY: 'socks5://localhost:1', no_proxy: '', NO_PROXY: '*' }, token: 'env' },",
    "  { mode: 'auto', env: { HTTPS_PROXY: proxyUrl, NO_PROXY: '127.0.0.1' }, token: 'bypass' },",
    "  { mode: 'direct', env: { HTTPS_PROXY: 'http://127.0.0.1:1' }, token: 'direct' },",
    ']) {',
    " const network = new MarketNetwork({ env: item.env, platform: 'linux', allowedHosts: ['127.0.0.1'] });",
    " await network.saveSettings({ mode: item.mode, proxyUrl: item.mode === 'proxy' ? proxyUrl : '' });",
    " const response = await network.fetch(targetUrl, { headers: { 'x-fixture-header': item.token }, signal: AbortSignal.timeout(5000) });",
    ' outputs.push({ body: await response.json(), snapshot: network.snapshot() });',
    ' await network.close();',
    '}',
    'console.log(JSON.stringify(outputs));',
  ].join('\n');
  const childEnv = { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '', http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', no_proxy: '' };
  const { stdout } = await runFile(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, timeout: 15000, maxBuffer: 65536, windowsHide: true });
  const outputs = JSON.parse(stdout);
  assert.deepEqual(outputs.map(row => row.body.token), ['manual', 'env', 'bypass', 'direct']);
  assert.deepEqual(outputs.map(row => row.snapshot.effectiveRoute), ['manual', 'env', 'env', 'direct']);
  assert.equal(JSON.stringify(outputs).includes('unit-secret'), false);
  assert.equal(tunnelRequests.length, 2);
  assert.equal(tunnelRequests[0].authorization, null);
  assert.equal(tunnelRequests[1].authorization, 'Basic ' + Buffer.from('unit-user:unit-secret').toString('base64'));
  assert.deepEqual(seen.map(row => row.token), ['manual', 'env', 'bypass', 'direct']);
  // The same CA remains untrusted without the explicit fixture trust file.
  const rejectedEnv = { ...childEnv };
  delete rejectedEnv.NODE_EXTRA_CA_CERTS;
  const rejectScript = [
    'import { MarketNetwork } from ' + JSON.stringify(moduleUrl) + ';',
    "const network = new MarketNetwork({ env: {}, platform: 'linux', allowedHosts: ['127.0.0.1'] });",
    'try { await network.fetch(' + JSON.stringify(targetUrl) + ', { signal: AbortSignal.timeout(5000) }); process.exitCode = 1; }',
    "catch (error) { console.log(JSON.stringify({ safe: error.safe, reason: error.networkReason, causeCode: error.cause?.code })); }",
    'finally { await network.close(); }',
  ].join('\n');
  const rejected = await runFile(process.execPath, ['--input-type=module', '-e', rejectScript], { env: rejectedEnv, timeout: 7000, maxBuffer: 4096, windowsHide: true });
  const rejectedResult = JSON.parse(rejected.stdout);
  assert.equal(rejectedResult.safe, true);
  assert.equal(rejectedResult.reason, 'TLS');
  assert.ok(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(rejectedResult.causeCode));
  assert.equal(seen.length, 4);

  const wrongTarget = httpsServer({ key: tlsFixture.key, cert: wrongHostnameCert });
  wrongTarget.on('tlsClientError', () => {});
  await new Promise(resolve => wrongTarget.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => wrongTarget.close(resolve)));
  await writeFile(certificatePath, wrongHostnameCert);
  const wrongUrl = 'https://127.0.0.1:' + wrongTarget.address().port + '/fixture';
  const wrongScript = rejectScript.replace(JSON.stringify(targetUrl), JSON.stringify(wrongUrl));
  const wrong = await runFile(process.execPath, ['--input-type=module', '-e', wrongScript], { env: childEnv, timeout: 7000, maxBuffer: 4096, windowsHide: true });
  assert.deepEqual(JSON.parse(wrong.stdout), { safe: true, reason: 'TLS', causeCode: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});

test('a rejected configured proxy never retries through a direct connection', { timeout: 10000 }, async t => {
  let connects = 0, directConnections = 0;
  const target = netServer(socket => { directConnections++; socket.end(); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => target.close(resolve)));
  const sockets = new Set();
  const proxy = httpServer();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (_request, socket) => {
    connects++;
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 24\r\n\r\nprivate-proxy-error-text');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => proxy.close(resolve)); });
  const network = new MarketNetwork({ env: {}, platform: 'linux', allowedHosts: ['127.0.0.1'] });
  t.after(() => network.close());
  await network.saveSettings({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:' + proxy.address().port });
  await assert.rejects(network.fetch('https://127.0.0.1:' + target.address().port + '/fixture', { signal: AbortSignal.timeout(3000) }), error => error.safe && !String(error).includes('private-') && !JSON.stringify(error).includes('private-'));
  assert.equal(connects, 1);
  assert.equal(directConnections, 0);
});
