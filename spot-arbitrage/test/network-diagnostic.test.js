import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseNetwork, parseArgs, validateProxyUrl } from '../scripts/diagnose-network.js';

function publicFixture(url) {
  const u = new URL(url), okx = u.hostname === 'www.okx.com';
  let data;
  if (u.pathname.endsWith('/time')) data = okx ? { code: '0', data: [{ ts: String(Date.now()) }] } : { serverTime: Date.now() };
  else if (u.pathname.endsWith('exchangeInfo')) data = { symbols: [{}] };
  else if (u.pathname.endsWith('instruments')) data = { code: '0', data: [{}] };
  else {
    const book = { bids: [['10', '1']], asks: [['11', '1']], ts: String(Date.now()) };
    data = okx ? { code: '0', data: [book] } : book;
  }
  return new Response(JSON.stringify(data), { status: 200 });
}
test('诊断仅请求固定公开GET、各所顺序检查且不发送账户头或请求体', async () => {
  const calls = [];
  const report = await diagnoseNetwork({ fetchFn: async (url, options) => {
    calls.push({ url, options }); return publicFixture(url);
  } });
  assert.equal(report.publicRequests, 6); assert.equal(report.privateRequests, 0); assert.equal(report.orderRequests, 0);
  for (const { url, options } of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.ok(['api.binance.com', 'www.okx.com'].includes(new URL(url).hostname));
  }
  for (const entry of Object.values(report.exchanges)) {
    assert.equal(entry.requests.length, 3); assert.ok(entry.requests[0].route.endsWith('/time'));
    assert.equal(entry.clockRttWithin2000Ms, true); assert.equal(entry.clockOffsetWithin30000Ms, true);
  }
  assert.equal(report.exchanges.okx.bookTimeWithinDefaultWindow, true);
  assert.equal(report.diagnosticsPassed, true);
});
test('HTTP451立即停止该交易所后续检查，不泄漏返回正文，另一交易所仍可完成', async () => {
  let binance = 0;
  const report = await diagnoseNetwork({ fetchFn: async url => {
    if (url.includes('api.binance.com')) { binance++; return new Response('remote-secret-marker', { status: 451 }); }
    return publicFixture(url);
  } });
  assert.equal(binance, 1); assert.equal(report.publicRequests, 4);
  assert.equal(report.exchanges.binance.requests[0].code, 'HTTP_451_RESTRICTED_LOCATION');
  assert.equal(report.exchanges.okx.requests.length, 3);
  assert.equal(report.diagnosticsPassed, false);
  assert.doesNotMatch(JSON.stringify(report), /remote-secret-marker/);
});
test('429、403和418均停止后续诊断，不重发或切换接口', async () => {
  for (const status of [429, 403, 418]) {
    let calls = 0;
    const report = await diagnoseNetwork({ fetchFn: async () => { calls++; return new Response('limited', { status }); } });
    assert.equal(calls, 2); assert.equal(report.publicRequests, 2);
    assert.ok(Object.values(report.exchanges).every(entry => entry.stoppedAfterFailure));
  }
});
test('响应头后中断与畸形JSON分开，错误原文和正文不进入报告', async () => {
  const report = await diagnoseNetwork({ fetchFn: async url => {
    if (url.includes('api.binance.com')) return { status: 200, body: (async function* () { yield Buffer.from('private-marker'); throw Error('credential-marker'); })() };
    return new Response('body-secret-marker', { status: 200 });
  } });
  assert.equal(report.exchanges.binance.requests[0].code, 'BODY_READ_ERROR');
  assert.equal(report.exchanges.binance.requests[0].bytes, 14);
  assert.equal(report.exchanges.okx.requests[0].code, 'INVALID_JSON');
  assert.doesNotMatch(JSON.stringify(report), /private-marker|credential-marker|body-secret-marker/);
});
test('超过15MB边界立即停止，不作为合法时间或重复请求', async () => {
  let calls = 0;
  const report = await diagnoseNetwork({ fetchFn: async () => {
    calls++; return { status: 200, body: (async function* () { yield Buffer.alloc(15000001); })() };
  } });
  assert.equal(calls, 2); assert.ok(Object.values(report.exchanges).every(entry => entry.requests[0].code === 'RESPONSE_TOO_LARGE'));
});
test('代理参数拒绝账号密码、非HTTP协议和附带路径，不将输入带入错误', () => {
  assert.equal(validateProxyUrl('http://127.0.0.1:7897'), 'http://127.0.0.1:7897/');
  for (const value of ['http://user:secret@127.0.0.1:7897', 'file:///secret', 'socks5://127.0.0.1:1080', 'http://127.0.0.1/path', 'http://127.0.0.1/?secret', 'bad-secret']) {
    assert.throws(() => validateProxyUrl(value), error => error.message === 'INVALID_PROXY_URL');
  }
  assert.deepEqual(parseArgs([]), { mode: 'environment' });
  assert.deepEqual(parseArgs(['--direct']), { mode: 'direct' });
  assert.throws(() => parseArgs(['--proxy', 'http://127.0.0.1:7897', '--direct']), /INVALID_ARGUMENTS/);
});
test('本机偏差超过应用限额时即使估计盘口新鲜也明确标记时钟不可信', async () => {
  const report = await diagnoseNetwork({ now: () => Date.now() - 45000, fetchFn: async url => publicFixture(url) });
  for (const entry of Object.values(report.exchanges)) {
    assert.ok(entry.clockOffsetMs > 44000);
    assert.equal(entry.clockOffsetWithin30000Ms, false);
    assert.equal(entry.clockTrustedForApp, false);
  }
  assert.equal(report.exchanges.okx.bookAgeEstimateTrusted, false);
  assert.equal(report.exchanges.okx.bookTimeWithinDefaultWindow, null);
  assert.equal(report.diagnosticsPassed, false);
});
test('请求期间本机时钟回拨时不把估计盘口年龄标为可信', async () => {
  let clockReads = 0;
  const report = await diagnoseNetwork({ now: () => ++clockReads <= 2 ? 100000 : 90000, fetchFn: async url => {
    if (new URL(url).pathname.endsWith('/time')) {
      return new Response(JSON.stringify(url.includes('www.okx.com') ? { code: '0', data: [{ ts: '95000' }] } : { serverTime: 95000 }));
    }
    return publicFixture(url);
  } });
  for (const entry of Object.values(report.exchanges)) {
    assert.equal(entry.clockOffsetWithin30000Ms, true);
    assert.equal(entry.localClockStable, false);
    assert.equal(entry.clockTrustedForApp, false);
  }
  assert.equal(report.exchanges.okx.bookAgeEstimateTrusted, false);
  assert.equal(report.exchanges.okx.bookTimeWithinDefaultWindow, null);
  assert.equal(report.diagnosticsPassed, false);
});
test('正文超时即使只抛AbortError也按总超时信号识别且不泄漏原因', async () => {
  const controllers = [];
  const report = await diagnoseNetwork({ timeoutSignal: () => {
    const controller = new AbortController(); controllers.push(controller); return controller.signal;
  }, fetchFn: async (url, options) => ({ status: 200, body: (async function* () {
    yield Buffer.from('{');
    controllers.find(controller => controller.signal === options.signal).abort(new DOMException('private-marker', 'TimeoutError'));
    throw new DOMException('remote-secret-marker', 'AbortError');
  })() }) });
  assert.ok(Object.values(report.exchanges).every(entry => entry.requests[0].code === 'BODY_TIMEOUT'));
  assert.equal(report.publicRequests, 2);
  assert.doesNotMatch(JSON.stringify(report), /private-marker|remote-secret-marker/);
});
