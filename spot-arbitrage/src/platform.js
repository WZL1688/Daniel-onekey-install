import fs from 'node:fs';

// Node's Windows filesystem API cannot fsync a directory handle. Keep file
// fsync and same-directory rename in Store on every platform; only POSIX can
// additionally flush the directory entry after that rename. Do not catch I/O
// failures here: on supported platforms they must stop the caller's write.
export function syncDirectory(directory, { platform = process.platform, fileSystem = fs } = {}) {
  if (platform === 'win32') return false;
  const fd = fileSystem.openSync(directory, 'r');
  try { fileSystem.fsyncSync(fd); } finally { fileSystem.closeSync(fd); }
  return true;
}
