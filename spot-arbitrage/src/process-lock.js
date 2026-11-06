import fs from 'node:fs';
import path from 'node:path';

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const lockError = (message, code) => Object.assign(Error(message), { code });
function statOrMissing(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Read a bounded regular file through its own descriptor, then verify that the
// path still names that file. Never follow a symlink or parse an unbounded PID.
function readLock(file) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > 32n) throw lockError('数据目录锁损坏，拒绝启动', 'LOCK_INVALID');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const identity = fs.fstatSync(fd, { bigint: true });
    if (!identity.isFile() || !sameFile(before, identity)) throw lockError('数据目录锁在检查期间已变化，拒绝覆盖', 'LOCK_CHANGED');
    const bytes = Buffer.alloc(33);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, count).toString('utf8');
    const pid = Number(text);
    if (!/^[1-9]\d{0,9}$/.test(text) || !Number.isSafeInteger(pid) || pid > 2147483647) throw lockError('数据目录锁损坏，拒绝启动', 'LOCK_INVALID');
    const after = statOrMissing(file);
    if (!after?.isFile() || !sameFile(identity, after) || after.size !== BigInt(count)) throw lockError('数据目录锁在检查期间已变化，拒绝覆盖', 'LOCK_CHANGED');
    return { identity, text, pid };
  } finally { fs.closeSync(fd); }
}

// Every acquisition and release uses one atomic directory mutex. In particular,
// two stale-PID recoverers cannot unlink a newly created, live owner's lock.
// An interrupted recovery guard deliberately requires manual investigation.
export function acquireProcessLock(dataDir) {
  const lockFile = path.join(path.resolve(dataDir), 'process.lock');
  const recoveryDir = lockFile + '.recovery';
  const pidText = String(process.pid);
  let recoveryIdentity, fd = null, identity;
  const acquireRecovery = () => {
    try { fs.mkdirSync(recoveryDir, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw lockError(`数据目录锁正在恢复，或上次恢复被中断。请确认没有实例运行后，人工检查并删除恢复目录：${recoveryDir}；程序不会自动绕过此保护`, 'LOCK_RECOVERY_BUSY');
      throw error;
    }
    recoveryIdentity = fs.lstatSync(recoveryDir, { bigint: true });
    if (!recoveryIdentity.isDirectory()) throw lockError('数据目录锁恢复互斥已变化，拒绝继续', 'LOCK_RECOVERY_CHANGED');
  };
  const releaseRecovery = () => {
    if (!recoveryIdentity) return;
    const current = statOrMissing(recoveryDir);
    if (!current?.isDirectory() || !sameFile(current, recoveryIdentity)) throw lockError('数据目录锁恢复互斥已变化，拒绝删除其他进程的恢复保护', 'LOCK_RECOVERY_CHANGED');
    fs.rmdirSync(recoveryDir);
    recoveryIdentity = undefined;
  };
  try {
    acquireRecovery();
    try { fd = fs.openSync(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = readLock(lockFile);
      try {
        process.kill(old.pid, 0);
        throw lockError('数据目录已被另一进程使用', 'LOCK_BUSY');
      } catch (probeError) {
        // EPERM and all other probe failures do not establish a dead owner.
        if (probeError.code !== 'ESRCH') throw probeError;
      }
      const current = readLock(lockFile);
      if (!sameFile(current.identity, old.identity) || current.text !== old.text) throw lockError('数据目录锁在恢复期间已变化，拒绝覆盖', 'LOCK_CHANGED');
      fs.unlinkSync(lockFile);
      fd = fs.openSync(lockFile, 'wx', 0o600);
    }
    identity = fs.fstatSync(fd, { bigint: true });
    fs.writeFileSync(fd, pidText);
    fs.fsyncSync(fd);
    releaseRecovery();
  } catch (error) {
    const cleanupErrors = [];
    if (fd !== null) {
      try {
        const owned = identity || fs.fstatSync(fd, { bigint: true });
        const current = statOrMissing(lockFile);
        if (current?.isFile() && sameFile(current, owned)) fs.unlinkSync(lockFile);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { fs.closeSync(fd); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    try { releaseRecovery(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], `${error.message}；锁清理未完成，请人工检查数据目录锁`);
    throw error;
  }

  let closed = false;
  const closeDescriptor = () => {
    // A close error leaves descriptor state unspecified; do not reuse it.
    closed = true;
    fs.closeSync(fd);
  };
  return {
    fd,
    get closed() { return closed; },
    // Fatal construction cleanup cannot return a retryable owner to its caller.
    // Close only the descriptor; leave all pathname guards for manual review.
    abandon() { if (!closed) closeDescriptor(); },
    close() {
      if (closed) return false;
      // If another process holds the guard, preserve the open handle and allow
      // an explicit retry. Never report a successful close with an orphan lock.
      try { acquireRecovery(); }
      catch (error) {
        // The data directory may have been removed during shutdown. There is
        // then no pathname to release, but the descriptor must still be closed.
        if (error.code === 'ENOENT' && !statOrMissing(lockFile)) {
          closeDescriptor();
          return false;
        }
        throw error;
      }
      let failure, released = false;
      try {
        const current = statOrMissing(lockFile);
        if (!current?.isFile() || !sameFile(current, identity)) {
          closeDescriptor();
          return false;
        }
        let record;
        try { record = readLock(lockFile); }
        catch (error) {
          if (!['LOCK_INVALID', 'LOCK_CHANGED'].includes(error.code)) throw error;
          closeDescriptor();
          return false;
        }
        if (!sameFile(record.identity, identity) || record.text !== pidText) {
          closeDescriptor();
          return false;
        }
        // On an unlink failure the handle stays open, making a close retry safe.
        fs.unlinkSync(lockFile);
        released = true;
        closeDescriptor();
        return true;
      } catch (error) { failure = error; throw error; }
      finally {
        try { releaseRecovery(); }
        catch (error) {
          if (failure) throw new AggregateError([failure, error], '释放数据目录锁失败，请人工检查数据目录锁');
          throw error;
        }
        // Defensive: a removed lock may never keep a writable Store alive.
        if (released) closed = true;
      }
    },
  };
}
