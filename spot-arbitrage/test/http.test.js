import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server.js';
async function app(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-http-')); let requests = 0;
  const x = createApp({ dataDir: dir, startEngine: false, transport: async () => { requests++; throw Error('不应请求交易所'); } });
  await new Promise(r => x.server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + x.server.address().port;
  t.after(async () => { await x.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = await fetch(base + '/api/session'), cookie = session.headers.get('set-cookie').split(';')[0], { csrf } = await session.json();
  const post = (url, data, extra = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: cookie, ...extra }, body: JSON.stringify(data) });
  return { ...x, base, post, requests: () => requests };
}
test('页面与所有管理快照不会触发交易所请求', async t => {
  const x = await app(t);
  for (let i = 0; i < 5; i++) for (const p of ['/', '/app.js', '/style.css', '/api/state', '/api/records', '/health']) { const r = await fetch(x.base + p); assert.equal(r.status, 200); await r.text(); }
  assert.equal(x.requests(), 0);
});
test('API 未提供会话与 CSRF 时拒绝修改', async t => { const x = await app(t); const r = await fetch(x.base + '/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' }); assert.equal(r.status, 403); });
test('跨站请求即使携带令牌仍被拒绝', async t => { const x = await app(t); const r = await x.post('/api/live', { enabled: false }, { Origin: 'https://evil.example' }); assert.equal(r.status, 403); });
test('DNS 重绑定 Host 被拒绝', async t => { const x = await app(t); const code = await new Promise((resolve, reject) => { const r = http.get(x.base + '/api/state', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject); }); assert.equal(code, 403); });
test('前端不能通过提交数量价格绕过后台复核', async t => { const x = await app(t); const r = await x.post('/api/submit', { pair: 'BTC/USDT', buyExchange: 'binance', qty: '100', price: '1', confirm: '确认提交该批次' }); assert.equal(r.status, 400); assert.match((await r.json()).error, /不得指定/); });
test('保存 Key 的响应与管理快照不泄露明文凭据', async t => {
  const x = await app(t); const secret = 'never-return-secret123', apiKey = 'never-return-api-key123';
  const r = await x.post('/api/keys', { exchange: 'binance', role: 'query', apiKey, secret }); assert.equal(r.status, 201);
  const response = await r.text(), state = await (await fetch(x.base + '/api/state')).text();
  for (const value of [secret, apiKey]) { assert.ok(!response.includes(value)); assert.ok(!state.includes(value)); }
  assert.ok(!state.includes('ciphertext'));
});
test('交易 Key 验证接口禁止查询且不发任何远端请求', async t => {
  const x = await app(t); const id = x.vault.add({ exchange: 'binance', role: 'trade', apiKey: 'trade-api-key1234', secret: 'trade-secret1234', accountUid: '123', sameAccountConfirmed: true });
  const r = await x.post('/api/keys/validate', { id }); assert.equal(r.status, 400); assert.equal(x.requests(), 0);
});
test('静态文件有 CSP 且不允许路径穿越读取数据', async t => { const x = await app(t); const r = await fetch(x.base + '/'); assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'")); const stateFile = await fetch(x.base + '/data/state.json'); assert.equal(stateFile.status, 404); });
test('重启后查询记录与配置仍可用，实盘关闭', async t => {
  const x = await app(t); x.store.state.config.amount = '222'; x.store.state.config.autoTrading = true; x.store.save();
  const dir = x.store.dir; await x.close();
  const fresh = createApp({ dataDir: dir, startEngine: false }); await new Promise(r => fresh.server.listen(0, '127.0.0.1', r));
  try { const state = await (await fetch('http://127.0.0.1:' + fresh.server.address().port + '/api/state')).json(); assert.equal(state.config.amount, '222'); assert.equal(state.config.autoTrading, false); }
  finally { await fresh.close(); }
});
