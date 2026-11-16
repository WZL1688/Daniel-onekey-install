import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { browserCommand, openBrowser } from '../src/browser.mjs';

test('Windows browser launch retains the actual bound port and avoids shell quoting', async () => {
  let captured;
  let detached = false;
  const ok = await openBrowser('http://127.0.0.1:50240', { platform: 'win32', spawnImpl: (...args) => {
    captured = args;
    const child = new EventEmitter();
    child.unref = () => { detached = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  } });
  assert.equal(ok, true);
  assert.deepEqual(captured.slice(0, 2), ['rundll32.exe', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:50240/']]);
  assert.equal(captured[2].shell, false);
  assert.equal(detached, true);
});

test('macOS and Linux use the complete local URL', () => {
  assert.deepEqual(browserCommand('http://127.0.0.1:23456/', 'darwin'), { command: 'open', args: ['http://127.0.0.1:23456/'] });
  assert.deepEqual(browserCommand('http://127.0.0.1:23456', 'linux'), { command: 'xdg-open', args: ['http://127.0.0.1:23456/'] });
});

test('browser opener rejects remote URLs, missing ports and injected command text', () => {
  for (const url of ['http://127.0.0.1/', 'https://127.0.0.1:50240/', 'http://example.com:50240/', 'http://127.0.0.1:0/', 'http://127.0.0.1:65536/', 'http://127.0.0.1:50240/ & echo invalid']) assert.throws(() => browserCommand(url, 'win32'));
});

test('missing browser command does not terminate the server startup', async () => {
  const ok = await openBrowser('http://127.0.0.1:50240', { spawnImpl: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  } });
  assert.equal(ok, false);
});
