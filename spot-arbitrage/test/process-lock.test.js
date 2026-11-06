import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { acquireProcessLock } from '../src/process-lock.js';
import { Store } from '../src/store.js';

const deadPid = '2147483647';
const fault = code => Object.assign(Error(code), { code });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-lock-'));
  const file = path.join(dir, 'process.lock'), guard = file + '.recovery';
  const owners = [];
  t.after(() => {
    t.mock.restoreAll();
    // These are isolated test directories, including simulated interrupted guards.
    fs.rmSync(guard, { recursive: true, force: true });
    for (const owner of owners) owner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, guard, acquire() { const owner = acquireProcessLock(dir); owners.push(owner); return owner; } };
}

test('process lock creates one owner, closes idempotently, and permits same-PID restart', t => {
  const f = fixture(t), first = f.acquire();
  assert.equal(fs.readFileSync(f.file, 'utf8'), String(process.pid));
  assert.equal(fs.existsSync(f.guard), false);
  assert.equal(first.close(), true);
  assert.equal(first.close(), false);
  assert.throws(() => fs.fstatSync(first.fd), { code: 'EBADF' });
  const second = f.acquire();
  assert.equal(second.closed, false);
  assert.equal(second.close(), true);
});

test('process lock refuses a live PID without changing its lock', t => {
  const f = fixture(t), owner = f.acquire(), original = fs.statSync(f.file, { bigint: true });
  assert.throws(() => acquireProcessLock(f.dir), { code: 'LOCK_BUSY' });
  assert.equal(fs.statSync(f.file, { bigint: true }).ino, original.ino);
  assert.equal(fs.readFileSync(f.file, 'utf8'), String(process.pid));
  assert.equal(owner.closed, false);
});

test('process lock refuses EPERM PID probes instead of treating them as stale', t => {
  const f = fixture(t); fs.writeFileSync(f.file, deadPid);
  t.mock.method(process, 'kill', () => { throw fault('EPERM'); });
  assert.throws(() => f.acquire(), { code: 'EPERM' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), deadPid);
  assert.equal(fs.existsSync(f.guard), false);
});

test('stale recovery is serialized even when a second starter runs inside the PID probe', t => {
  const f = fixture(t); fs.writeFileSync(f.file, deadPid);
  let probes = 0, competingError;
  const realKill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid !== Number(deadPid)) return realKill(pid, signal);
    probes++;
    try { acquireProcessLock(f.dir); } catch (error) { competingError = error; }
    assert.equal(fs.readFileSync(f.file, 'utf8'), deadPid);
    throw fault('ESRCH');
  });
  const owner = f.acquire();
  assert.equal(probes, 1);
  assert.equal(competingError?.code, 'LOCK_RECOVERY_BUSY');
  assert.equal(fs.readFileSync(f.file, 'utf8'), String(process.pid));
  assert.throws(() => acquireProcessLock(f.dir), { code: 'LOCK_BUSY' });
  assert.equal(owner.closed, false);
});

test('stale recovery refuses a replaced lock after probing the old PID', t => {
  const f = fixture(t); fs.writeFileSync(f.file, deadPid);
  t.mock.method(process, 'kill', () => {
    fs.renameSync(f.file, f.file + '.old');
    fs.writeFileSync(f.file, String(process.pid));
    throw fault('ESRCH');
  });
  assert.throws(() => f.acquire(), { code: 'LOCK_CHANGED' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), String(process.pid));
});

test('stale recovery refuses a PID changed in the same file during its probe', t => {
  const f = fixture(t); fs.writeFileSync(f.file, deadPid);
  t.mock.method(process, 'kill', () => {
    fs.writeFileSync(f.file, String(process.pid));
    throw fault('ESRCH');
  });
  assert.throws(() => f.acquire(), { code: 'LOCK_CHANGED' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), String(process.pid));
});

test('malformed PID locks fail closed without probing or deleting them', t => {
  const f = fixture(t);
  const probe = t.mock.method(process, 'kill', () => { throw Error('PID must not be probed'); });
  for (const text of ['', '0', '-1', '1.5', '1e3', 'NaN', '2147483648', '999999999999999999999999999999999999', '12\n34', ' 12 ']) {
    fs.writeFileSync(f.file, text);
    assert.throws(() => f.acquire(), { code: 'LOCK_INVALID' }, JSON.stringify(text));
    assert.equal(fs.readFileSync(f.file, 'utf8'), text);
    assert.equal(fs.existsSync(f.guard), false);
  }
  assert.equal(probe.mock.callCount(), 0);
});

test('a symlink lock is refused without touching its target', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), target = path.join(f.dir, 'target');
  fs.writeFileSync(target, deadPid); fs.symlinkSync(target, f.file);
  assert.throws(() => f.acquire(), { code: 'LOCK_INVALID' });
  assert.equal(fs.readFileSync(target, 'utf8'), deadPid);
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
});

test('an interrupted recovery guard requires manual review and is never auto-removed', t => {
  const f = fixture(t); fs.mkdirSync(f.guard); fs.writeFileSync(f.file, deadPid);
  assert.throws(() => f.acquire(), error => error.code === 'LOCK_RECOVERY_BUSY' && /人工检查/.test(error.message));
  assert.equal(fs.existsSync(f.guard), true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), deadPid);
});

test('close under a busy guard preserves its descriptor and can be retried', t => {
  const f = fixture(t), owner = f.acquire(); fs.mkdirSync(f.guard);
  assert.throws(() => owner.close(), { code: 'LOCK_RECOVERY_BUSY' });
  assert.equal(owner.closed, false);
  assert.equal(fs.fstatSync(owner.fd).isFile(), true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), String(process.pid));
  fs.rmdirSync(f.guard);
  assert.equal(owner.close(), true);
  assert.equal(f.acquire().close(), true);
});

test('close never unlinks a replacement owner lock', t => {
  const f = fixture(t), owner = f.acquire();
  fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, '123456');
  assert.equal(owner.close(), false);
  assert.equal(owner.closed, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '123456');
  assert.throws(() => fs.fstatSync(owner.fd), { code: 'EBADF' });
});

test('close never unlinks its original inode if the recorded PID was changed', t => {
  const f = fixture(t), owner = f.acquire(); fs.writeFileSync(f.file, '123456');
  assert.equal(owner.close(), false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '123456');
});

test('close releases its descriptor if the data directory was externally removed', t => {
  const f = fixture(t), owner = f.acquire();
  fs.rmSync(f.dir, { recursive: true });
  assert.equal(owner.close(), false);
  assert.equal(owner.closed, true);
  assert.throws(() => fs.fstatSync(owner.fd), { code: 'EBADF' });
});

test('failed initialization closes its descriptor and removes only its own partial lock', t => {
  const f = fixture(t), realOpen = fs.openSync; let opened;
  t.mock.method(fs, 'openSync', (...args) => { const fd = realOpen(...args); if (args[1] === 'wx') opened = fd; return fd; });
  t.mock.method(fs, 'fsyncSync', () => { throw fault('EIO'); });
  assert.throws(() => f.acquire(), { code: 'EIO' });
  assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(f.guard), false);
});

test('initialization cleanup preserves an externally replaced lock and closes its descriptor', t => {
  const f = fixture(t), realOpen = fs.openSync; let opened;
  t.mock.method(fs, 'openSync', (...args) => { const fd = realOpen(...args); if (args[1] === 'wx') opened = fd; return fd; });
  t.mock.method(fs, 'fsyncSync', () => {
    fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, '123456'); throw fault('EIO');
  });
  assert.throws(() => f.acquire(), { code: 'EIO' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), '123456');
  assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
});

test('close unlink I/O failures keep ownership open for an explicit retry', t => {
  const f = fixture(t), owner = f.acquire();
  const unlink = t.mock.method(fs, 'unlinkSync', () => { throw fault('EIO'); });
  assert.throws(() => owner.close(), { code: 'EIO' });
  assert.equal(owner.closed, false);
  assert.equal(fs.fstatSync(owner.fd).isFile(), true);
  assert.equal(fs.existsSync(f.guard), false);
  unlink.mock.restore();
  assert.equal(owner.close(), true);
});

test('Store preserves lock state on a blocked close and restores persisted state after retry', t => {
  const f = fixture(t), store = new Store(f.dir); t.after(() => store.close());
  store.state.config.amount = '456'; store.save(); fs.mkdirSync(f.guard);
  assert.throws(() => store.close(), { code: 'LOCK_RECOVERY_BUSY' });
  assert.equal(typeof store.lockFd, 'number');
  fs.rmdirSync(f.guard); store.close();
  assert.equal(store.lockFd, null);
  assert.throws(() => store.save(), /存储已关闭/);
  const fresh = new Store(f.dir); t.after(() => fresh.close());
  assert.equal(fresh.state.config.amount, '456');
});

test('failed Store initialization closes its unreachable descriptor even if recovery blocks cleanup', t => {
  const f = fixture(t), stateFile = path.join(f.dir, 'state.json');
  fs.writeFileSync(stateFile, '{broken');
  const realOpen = fs.openSync, realRead = fs.readFileSync; let opened;
  t.mock.method(fs, 'openSync', (...args) => { const fd = realOpen(...args); if (args[0] === f.file && args[1] === 'wx') opened = fd; return fd; });
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (args[0] === stateFile) fs.mkdirSync(f.guard);
    return realRead(...args);
  });
  assert.throws(() => new Store(f.dir), error => error instanceof AggregateError && /人工检查/.test(error.message));
  assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
  assert.equal(fs.existsSync(f.guard), true);
  assert.equal(realRead(f.file, 'utf8'), String(process.pid));
  assert.equal(realRead(stateFile, 'utf8'), '{broken');
});

test('two real child processes recovering one stale PID produce exactly one owner', { timeout: 15000 }, async t => {
  const f = fixture(t), exited = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
  assert.equal(exited.status, 0); fs.writeFileSync(f.file, String(exited.pid));
  const moduleUrl = new URL('../src/process-lock.js', import.meta.url).href;
  const source = `import { acquireProcessLock } from ${JSON.stringify(moduleUrl)};
    let owner;
    process.on('message', message => {
      if (message === 'go') {
        try { owner = acquireProcessLock(${JSON.stringify(f.dir)}); process.send({ status: 'acquired', pid: process.pid }); }
        catch (error) { process.send({ status: 'denied', code: error.code }); }
      } else if (message === 'finish') {
        if (owner) owner.close(); process.disconnect();
      }
    });
    process.send({ status: 'ready' });`;
  const children = Array.from({ length: 2 }, () => spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  await Promise.all(children.map(child => once(child, 'message')));
  const outcomes = children.map(child => once(child, 'message'));
  for (const child of children) child.send('go');
  const results = (await Promise.all(outcomes)).map(([result]) => result);
  const winners = results.filter(result => result.status === 'acquired');
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(fs.readFileSync(f.file, 'utf8'), String(winners[0].pid));
  assert.ok(results.some(result => result.status === 'denied' && ['LOCK_BUSY', 'LOCK_RECOVERY_BUSY'].includes(result.code)));
  const exits = children.map(child => once(child, 'exit'));
  for (const child of children) child.send('finish');
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
  assert.equal(fs.existsSync(f.file), false);
});
