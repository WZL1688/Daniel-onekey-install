import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Windows cmd.exe does not expand globs. Supply the same explicit test list on
// every OS, including Node 20.18 where Node's runner has no glob expansion.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js')).sort();
if (!files.length) throw Error('No test files found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => path.join('test', name))], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.signal) {
  console.error(`Test runner terminated by ${result.signal}`);
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
