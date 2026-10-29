import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { createApp } from '../src/server.js';
import { book, rule } from './helpers.js';
test('Web 管理页面实际运行脚本并渲染八个页面，恶意标签被转义', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-ui-'));
  const app = createApp({ dataDir: dir, startEngine: false });
  const s = app.store.state;
  s.books.binance = { 'BTC/USDT': book() }; s.books.okx = { 'BTC/USDT': book('BTC/USDT', '102', '103') };
  s.rules.binance = { 'BTC/USDT': rule() }; s.rules.okx = { 'BTC/USDT': rule() };
  s.errors.push({ at: Date.now(), scope: 'test', message: '<img src=x onerror=alert(1)>' });
  s.keys.push({ id: 'ui-key', label: '<script>bad()</script>', exchange: 'binance', role: 'query', status: 'UNVERIFIED', hint: '••••1234', enabled: true, requests: 0, failures: 0 });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const { document, window } = parseHTML(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  const previous = { document: globalThis.document, fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  try {
    globalThis.document = document;
    globalThis.fetch = (url, options) => previous.fetch(new URL(url, base), options);
    globalThis.setInterval = () => 0;
    await import('../public/app.js?test=' + Date.now());
    assert.equal(document.querySelector('#connection').textContent, '本机在线');
    assert.ok(document.querySelector('#content').textContent.includes('BTC/USDT'));
    for (const id of ['balance', 'accounts', 'keys', 'records', 'usage', 'errors', 'settings', 'opportunities']) {
      document.querySelector(`[data-page="${id}"]`).dispatchEvent(new window.Event('click', { bubbles: true }));
      assert.ok(document.querySelector('#content').innerHTML.length > 50, id);
      assert.equal(document.querySelector('#content script'), null);
      assert.equal(document.querySelector('#content img'), null);
    }
  } finally {
    globalThis.document = previous.document; globalThis.fetch = previous.fetch; globalThis.setInterval = previous.setInterval;
    await app.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
