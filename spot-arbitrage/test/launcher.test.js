import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));

function runFixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb runner 中文 空格! '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.copyFileSync(path.join(root, 'scripts/test.js'), path.join(dir, 'scripts/test.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'test', name), source);
  const env = { ...process.env };
  // This is an independent command-line fixture, not a nested node:test worker.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [path.join(dir, 'scripts/test.js')], {
    cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 15000,
  });
}

test('测试入口在含空格、中文和 ! 的路径下执行全部测试，忽略辅助文件', t => {
  const result = runFixture(t, {
    'a.test.js': "import test from 'node:test'; test('first explicit test', () => {});",
    'z 中文 !.test.js': "import test from 'node:test'; test('second explicit test', () => {});",
    'helper.js': "throw Error('non-test helper was executed');",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /first explicit test/);
  assert.match(result.stdout, /second explicit test/);
  assert.match(result.stdout, /\bpass 2\b/);
});

test('测试入口保留实际失败的非零退出状态', t => {
  const result = runFixture(t, {
    'failure.test.js': "import test from 'node:test'; test('expected fixture failure', () => { throw Error('fixture failed'); });",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /expected fixture failure/);
  assert.match(result.stdout, /\bfail 1\b/);
});

test('没有测试文件时测试入口明确失败', t => {
  const result = runFixture(t, { 'helper.js': '' });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No test files found/);
});

test('两个 Windows 启动入口拒绝旧版 Node，接受 20.18 及后续版本', () => {
  for (const name of ['1-install-windows.cmd', '2-start-windows.cmd']) {
    const script = fs.readFileSync(path.join(root, name), 'utf8');
    const expression = script.match(/^node -e "([^"]+)"\r?$/m)?.[1];
    assert.ok(expression, `${name} has a version check`);
    for (const [version, accepted] of [['18.20.8', false], ['20.17.0', false], ['20.18.0', true], ['22.0.0', true], ['24.1.0', true]]) {
      let exitCode;
      vm.runInNewContext(expression, {
        process: { versions: { node: version }, exit: code => { exitCode = code; } },
        console: { error() {} },
      });
      assert.equal(exitCode, accepted ? undefined : 1, `${name}: ${version}`);
    }
    assert.match(script, /^setlocal EnableExtensions DisableDelayedExpansion\r?$/m);
    assert.match(script, /^pushd "%~dp0"/m);
    assert.doesNotMatch(script, /\b(?:set|echo)\s+(?:ARB_|NODE_TLS_REJECT_UNAUTHORIZED|HOST=)|0\.0\.0\.0/i);
  }
});
