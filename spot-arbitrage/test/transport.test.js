import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent } from 'undici';
import { transport } from '../src/exchanges.js';
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
  await assert.rejects(send(), e => e.unknown === true); assert.equal(count, 1);
});
test('真实 HTTP 畸形应答不能当作失败后自动补单', async t => {
  let count = 0; const send = await upstream(t, (req, res) => { count++; res.end('<html>upstream failed</html>'); });
  await assert.rejects(send(), e => e.unknown === true); assert.equal(count, 1);
});
test('真实 HTTP Retry-After 透传给统一调度器', async t => {
  const send = await upstream(t, (req, res) => { res.writeHead(429, { 'Retry-After': '120' }); res.end('{"code":-1003}'); });
  const response = await send(); assert.equal(response.status, 429); assert.equal(response.headers['retry-after'], '120');
});
test('实际 10 秒超时保持未知且不重发', async t => {
  let count = 0; const send = await upstream(t, (req, res) => { count++; });
  const start = Date.now(); await assert.rejects(send(), e => e.unknown === true);
  assert.ok(Date.now() - start >= 9500); assert.equal(count, 1);
});
