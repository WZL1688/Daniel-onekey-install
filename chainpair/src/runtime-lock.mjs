import { openSync, writeFileSync, fsyncSync, closeSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const busy = () => new Error('同一数据目录已有程序运行或正在恢复。请使用已启动的命令窗口及其完整本机地址；不要重复启动交易进程。');
/** An exclusive local data-directory owner prevents duplicate trading engines. */
export function acquireRuntimeLock(dataDir) {
  const file = path.join(dataDir, 'runtime.lock'), recovery = path.join(dataDir, 'runtime.recovery.lock');
  const owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  let fd, recoveryFd;
  const create = () => { const descriptor = openSync(file, 'wx', 0o600); try { writeFileSync(descriptor, JSON.stringify(owner)); fsyncSync(descriptor); } finally { closeSync(descriptor); } };
  if (existsSync(recovery)) throw busy();
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { recoveryFd = openSync(recovery, 'wx', 0o600); }
    catch { throw busy(); }
    try {
      let previous; try { previous = JSON.parse(readFileSync(file, 'utf8')); } catch { throw busy(); }
      if (!Number.isInteger(previous.pid) || previous.pid <= 0 || typeof previous.token !== 'string') throw busy();
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      if (alive) throw busy();
      // The recovery marker serializes stale cleanup. A new owner can only win
      // the subsequent exclusive create; its lock is never removed or replaced.
      unlinkSync(file);
      try { create(); } catch (failure) { if (failure.code === 'EEXIST') throw busy(); throw failure; }
    } finally { closeSync(recoveryFd); unlinkSync(recovery); }
  }
  let released = false;
  return { release() {
    if (released) return; released = true;
    try { const current = JSON.parse(readFileSync(file, 'utf8')); if (current.token === owner.token && current.pid === process.pid) unlinkSync(file); } catch {}
  } };
}
