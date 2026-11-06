import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent } from 'undici';
import { Exchanges, transport } from '../src/exchanges.js';
async function upstream(t, handler) {
  const server = http.createServer(handler), dispatcher = new Agent();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await dispatcher.close(); await new Promise(r => server.close(r)); });
  return params => transport({ url: 'http://127.0.0.1:' + server.address().port, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', mutation: true, dispatcher, ...params });
}
test('真实 HTTP 传输无损解析大订单号', async t => {
  const send = await upstream(t, (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"orderId":123456789012345678901}'); });
  const result = await send(); assert.equal(result.data.orderId, '123456789012345678901');
});
test('真实连接中断产生未知结果且只发送一次', async t => {
  let count = 0; const send = await upstream(t, (req, res) => { count++; req.socket.destroy(); });
  await assert.rejects(send(), e => e.unknown === true && e.code === 'REQUEST_FAILED' && e.status === 0 && /已接收 0 字节/.test(e.message)); assert.equal(count, 1);
});
test('真实 HTTP 畸形应答不能当作失败后自动补单', async t => {
  const privateMarker = 'PRIVATE-RESPONSE-MUST-NOT-APPEAR';
  let count = 0; const send = await upstream(t, (req, res) => { count++; res.end('<html>' + privateMarker + '</html>'); });
  await assert.rejects(send({ body: '{"secret":"PRIVATE-REQUEST-MUST-NOT-APPEAR"}' }), e => {
    assert.equal(e.unknown, true); assert.equal(e.status, 200); assert.equal(e.code, 'BAD_JSON');
    assert.match(e.message, /响应体不是有效 JSON/); assert.match(e.message, /已接收 \d+ 字节/);
    assert.doesNotMatch(e.message, /PRIVATE-|<html>|http:\/\//); return true;
  }); assert.equal(count, 1);
});
test('真实 HTTP 200 响应头后的正文断流明确标记读取中断而非畸形 JSON', async t => {
  let count = 0; const send = await upstream(t, (req, res) => {
    count++; res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    res.write('{"pending":'); setTimeout(() => res.destroy(), 50);
  });
  await assert.rejects(send(), e => {
    assert.equal(e.unknown, true); assert.equal(e.status, 200); assert.equal(e.code, 'BODY_READ_ERROR');
    assert.match(e.message, /响应体读取中断/); assert.match(e.message, /已接收 11 字节/);
    assert.doesNotMatch(e.message, /不是有效 JSON|过大数据|pending/); return true;
  }); assert.equal(count, 1);
});
test('真实 HTTP 超过 15000000 字节时明确拒绝且不重发', async t => {
  let count = 0; const send = await upstream(t, (req, res) => {
    count++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(Buffer.alloc(15000001, 0x20));
  });
  await assert.rejects(send(), e => {
    assert.equal(e.unknown, true); assert.equal(e.status, 200); assert.equal(e.code, 'RESPONSE_TOO_LARGE');
    assert.match(e.message, /超过 15000000 字节上限/); assert.match(e.message, /已接收 15000001 字节/); return true;
  }); assert.equal(count, 1);
});
test('真实 HTTP 公共查询失败不会标为未知交易提交', async t => {
  const send = await upstream(t, (req, res) => res.end('not-json'));
  await assert.rejects(send({ method: 'GET', body: undefined, mutation: false }), e => e.code === 'BAD_JSON' && e.unknown === false && !/提交结果未知/.test(e.message));
});
test('真实 HTTP Retry-After 透传给统一调度器', async t => {
  const send = await upstream(t, (req, res) => { res.writeHead(429, { 'Retry-After': '120' }); res.end('{"code":-1003}'); });
  const response = await send(); assert.equal(response.status, 429); assert.equal(response.headers['retry-after'], '120');
});
test('实际 10 秒超时保持未知且不重发', async t => {
  let count = 0; const send = await upstream(t, (req, res) => { count++; });
  const start = Date.now(); await assert.rejects(send(), e => e.unknown === true && e.code === 'HEADERS_TIMEOUT' && e.status === 0 && /等待响应头/.test(e.message));
  assert.ok(Date.now() - start >= 9500); assert.equal(count, 1);
});
test('实际 10 秒总时限在 HTTP 200 正文阶段触发时保持未知且不重发', async t => {
  let count = 0; const send = await upstream(t, (req, res) => {
    count++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"pending":');
  });
  const start = Date.now();
  await assert.rejects(send(), e => {
    assert.equal(e.unknown, true); assert.equal(e.status, 200); assert.equal(e.code, 'BODY_TIMEOUT');
    assert.match(e.message, /请求总时限 10000 毫秒/); assert.match(e.message, /已接收 11 字节/);
    assert.match(e.message, /提交结果未知，禁止自动重发/); assert.doesNotMatch(e.message, /不是有效 JSON|过大数据/); return true;
  });
  assert.ok(Date.now() - start >= 9500); assert.equal(count, 1);
});
test('本机时间回拨后不使用来自未来的服务器时间缓存', async () => {
  const store = { state: { exchangeMeta: { okx: { clock: { at: Date.now() + 60000, offset: 123 } } } }, save() {} };
  const exchanges = new Exchanges(store, null, null); let count = 0;
  exchanges.request = async (_exchange, { onSend }) => { onSend(); count++; return { data: [{ ts: String(Date.now()) }] }; };
  await exchanges.syncClock('okx'); assert.equal(count, 1);
  assert.ok(store.state.exchangeMeta.okx.clock.at <= Date.now());
  assert.ok(Number.isFinite(store.state.exchangeMeta.okx.clock.offset));
  assert.ok(Number.isFinite(store.state.exchangeMeta.okx.clock.rtt));
  await exchanges.syncClock('okx'); assert.equal(count, 1);
});
test('时间同步拒绝复用时间或偏差字段无效的缓存', async t => {
  const now = 1793950000000; t.mock.method(Date, 'now', () => now);
  for (const cached of [{ at: now, offset: NaN }, { at: now, offset: Infinity }, { at: now, offset: '0' }, { at: now, offset: 30001 },
    { at: NaN, offset: 0 }, { at: Infinity, offset: 0 }, { at: String(now), offset: 0 }, { at: 0, offset: 0 }, { offset: 0 }]) {
    const store = { state: { exchangeMeta: { okx: { clock: cached } } }, save() {} };
    const exchanges = new Exchanges(store, null, null); let count = 0;
    exchanges.request = async (_exchange, { onSend }) => { count++; onSend(); return { data: [{ ts: String(now) }] }; };
    await exchanges.syncClock('okx'); assert.equal(count, 1);
    assert.deepEqual(store.state.exchangeMeta.okx.clock, { at: now, offset: 0, rtt: 0 });
  }
});
test('时间同步缺失发送时间、本机中途回拨或往返超时均不得保存校准结果', async t => {
  const base = 1793950000000; let now = base; t.mock.method(Date, 'now', () => now);
  for (const { send, elapsed } of [{ send: false, elapsed: 0 }, { send: true, elapsed: -1 }, { send: true, elapsed: 2001 }, { send: true, elapsed: Infinity }]) {
    now = base; let saves = 0; const store = { state: { exchangeMeta: {} }, save() { saves++; } };
    const exchanges = new Exchanges(store, null, null);
    exchanges.request = async (_exchange, { onSend }) => { if (send) onSend(); now = base + elapsed; return { data: [{ ts: String(base) }] }; };
    await assert.rejects(exchanges.syncClock('okx'), /时间同步往返延迟无效/);
    assert.equal(saves, 0); assert.equal(store.state.exchangeMeta.okx, undefined);
  }
});
test('时间同步拒绝非正安全整数的交易所时间', async t => {
  const now = 1793950000000; t.mock.method(Date, 'now', () => now);
  for (const ts of [undefined, '', '0', '-1', 'NaN', 'Infinity', '1793950000000.5', '9007199254740992']) {
    let saves = 0; const store = { state: { exchangeMeta: {} }, save() { saves++; } };
    const exchanges = new Exchanges(store, null, null);
    exchanges.request = async (_exchange, { onSend }) => { onSend(); return { data: [{ ts }] }; };
    await assert.rejects(exchanges.syncClock('okx'), /服务器时间无效/);
    assert.equal(saves, 0); assert.equal(store.state.exchangeMeta.okx, undefined);
  }
});
test('时间同步保留 0 至 2000 毫秒往返和正负 30000 毫秒偏差的原边界', async t => {
  const base = 1793950000000; let now = base; t.mock.method(Date, 'now', () => now);
  for (const rtt of [0, 2000]) for (const offset of [-30001, -30000, 0, 30000, 30001]) {
    now = base; let saves = 0; const store = { state: { exchangeMeta: {} }, save() { saves++; } };
    const exchanges = new Exchanges(store, null, null);
    exchanges.request = async (_exchange, { onSend }) => { onSend(); now = base + rtt; return { data: [{ ts: String(base + rtt / 2 + offset) }] }; };
    if (Math.abs(offset) > 30000) {
      await assert.rejects(exchanges.syncClock('okx'), e => e.message.includes(`本机与交易所时间偏差 ${offset.toFixed(1)} 毫秒`) && /请同步系统时钟/.test(e.message));
      assert.equal(saves, 0); assert.equal(store.state.exchangeMeta.okx, undefined);
    } else {
      await exchanges.syncClock('okx'); assert.equal(saves, 1);
      assert.deepEqual(store.state.exchangeMeta.okx.clock, { at: base + rtt, offset, rtt });
    }
  }
});
test('OKX 盘口时间错误明确显示实际时差、门槛和时钟校准状态并保持拒绝', async () => {
  for (const calibrated of [false, true]) {
    const previous = { retained: true };
    const store = { state: { config: { maxBookAgeMs: 5000 }, rules: { okx: { 'BTC/USDT': { enabled: true, symbol: 'BTC-USDT' } } },
      exchangeMeta: { okx: calibrated ? { clock: { at: Date.now(), offset: 0 } } : {} }, books: { okx: { 'BTC/USDT': previous } } }, save() {} };
    const exchanges = new Exchanges(store, null, null);
    exchanges.request = async () => ({ data: [{ ts: String(Date.now() - 60000), bids: [['99', '1']], asks: [['100', '1']] }] });
    await assert.rejects(exchanges.book('okx', 'BTC/USDT'), e => {
      assert.match(e.message, /实际时差 600\d\d\.\d 毫秒/); assert.match(e.message, /允许 -1000 至 5000 毫秒/);
      assert.ok(e.message.includes(calibrated ? '时钟已校准' : '时钟未校准')); return true;
    });
    assert.equal(store.state.books.okx['BTC/USDT'], previous);
  }
});
