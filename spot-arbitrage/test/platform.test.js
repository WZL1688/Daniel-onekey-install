import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncDirectory } from '../src/platform.js';
import { Store, Vault } from '../src/store.js';

function windowsBranch(run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try { return run(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}

test('POSIX 原子替换后同步目录并关闭句柄', () => {
  const calls = [];
  const fileSystem = {
    openSync: (...args) => { calls.push(['open', ...args]); return 17; },
    fsyncSync: fd => calls.push(['sync', fd]),
    closeSync: fd => calls.push(['close', fd]),
  };
  assert.equal(syncDirectory('/local-data', { platform: 'linux', fileSystem }), true);
  assert.deepEqual(calls, [['open', '/local-data', 'r'], ['sync', 17], ['close', 17]]);
});

test('POSIX 目录同步 I/O 错误必须传播且关闭句柄', () => {
  const failure = Object.assign(Error('disk I/O failure'), { code: 'EIO' });
  let closed = false;
  assert.throws(() => syncDirectory('/local-data', { platform: 'darwin', fileSystem: {
    openSync: () => 17,
    fsyncSync: () => { throw failure; },
    closeSync: fd => { assert.equal(fd, 17); closed = true; },
  } }), error => error === failure);
  assert.equal(closed, true);
});

test('POSIX 无法打开目录不能伪称为 Windows 不支持而跳过', () => {
  for (const code of ['EACCES', 'EINVAL', 'ENOTSUP']) {
    const failure = Object.assign(Error(code), { code });
    assert.throws(() => syncDirectory('/local-data', { platform: 'linux', fileSystem: {
      openSync: () => { throw failure; },
    } }), error => error === failure);
  }
});

test('Windows 分支明确跳过 Node 不支持的目录同步', () => {
  const fileSystem = new Proxy({}, { get: () => { throw Error('directory I/O must not be attempted'); } });
  assert.equal(syncDirectory('C:\\local-data', { platform: 'win32', fileSystem }), false);
});

test('模拟 Windows：仍同步文件、原子替换并恢复未知订单与进程锁', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-windows-path 空格! '));
  const originalOpen = fs.openSync, originalSync = fs.fsyncSync;
  let fileSyncs = 0, store, fresh;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (path.resolve(String(file)) === dir && args[0] === 'r') throw Object.assign(Error('directory handles unsupported'), { code: 'EISDIR' });
    return originalOpen(file, ...args);
  });
  t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isFile()) fileSyncs++; return originalSync(fd); });
  try {
    windowsBranch(() => {
      store = new Store(dir); const vault = new Vault(store);
      assert.equal(vault.master.length, 32);
      assert.throws(() => new Store(dir), /另一进程|另一个进程|已被|锁/);
      store.state.config.amount = '321'; store.state.config.autoTrading = true;
      store.state.batches = [{ id: 'interrupted', pair: 'BTC/USDT', status: 'SUBMITTING', legs: [{ status: 'SENDING' }] }];
      store.state.cooldowns.test = 123456789;
      store.save(); store.close();
      fresh = new Store(dir);
      assert.equal(fresh.state.config.amount, '321');
      assert.equal(fresh.state.config.autoTrading, false);
      assert.equal(fresh.state.batches[0].status, 'UNKNOWN');
      assert.ok(fresh.state.blocks['BTC/USDT']);
      assert.equal(fresh.state.cooldowns.test, 123456789);
      assert.ok(fileSyncs >= 5, `file fsync count was ${fileSyncs}`);
    });
  } finally { fresh?.close(); store?.close(); t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('模拟 Windows：文件 fsync 失败必须中止，不覆盖上一份有效状态', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-win-fsync-'));
  let store;
  try {
    windowsBranch(() => {
      store = new Store(dir);
      const previous = fs.readFileSync(store.file, 'utf8');
      const failure = Object.assign(Error('file fsync failure'), { code: 'EIO' });
      t.mock.method(fs, 'fsyncSync', () => { throw failure; });
      store.state.config.amount = '999';
      assert.throws(() => store.save(), error => error === failure);
      assert.equal(fs.readFileSync(store.file, 'utf8'), previous);
    });
  } finally { t.mock.restoreAll(); store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
