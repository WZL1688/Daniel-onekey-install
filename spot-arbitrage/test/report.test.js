import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence } from '../scripts/report.js';

function evidence() {
  const report = { status: 'COMPLETED', startedAt: new Date(200000).toISOString(), completedAt: new Date(265000).toISOString(),
    elapsedMs: 65000, validationFailures: [], configuredPairs: ['BTC/USDT'], successfulSampledPairs: [], servicePort: 8888,
    counters: { binance: { public: 4, private: 0, orders: 0, failures: 4, limited: 0, delayed: 2 } } };
  return { network: { ...report, type: 'CURRENT_ENVIRONMENT_REAL_NETWORK_ATTEMPTS' }, fixture: { ...report, type: 'OFFICIAL_SHAPED_LOCAL_FIXTURE_NOT_EXCHANGE' },
    tests: '# tests 3\n# pass 3\n# fail 0\n# skipped 0\n# cancelled 0\n', notBefore: 100000, testModifiedAt: 270000,
    audit: { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } } };
}

test('验收生成器拒绝旧格式、未完成或早于代码的连续验证证据', () => {
  const old = evidence(); delete old.network.completedAt;
  assert.throws(() => validateEvidence(old), /格式过旧/);
  const failed = evidence(); failed.fixture.status = 'FAILED';
  assert.throws(() => validateEvidence(failed), /未确认完成/);
  const stale = evidence(); stale.notBefore = 240000;
  assert.throws(() => validateEvidence(stale), /早于当前代码/);
});

test('验收生成器拒绝零测试、取消或陈旧日志', () => {
  const zero = evidence(); zero.tests = zero.tests.replace(/3/g, '0');
  assert.throws(() => validateEvidence(zero), /非零/);
  const canceled = evidence(); canceled.tests = canceled.tests.replace('cancelled 0', 'cancelled 1');
  assert.throws(() => validateEvidence(canceled), /无取消/);
  const stale = evidence(); stale.testModifiedAt = 10;
  assert.throws(() => validateEvidence(stale), /测试日志早于/);
});

test('审计结论取实际统计，缺失或矛盾的漏洞总数会被拒绝', () => {
  assert.equal(validateEvidence(evidence()).tests, 3);
  const missing = evidence(); delete missing.audit.metadata;
  assert.throws(() => validateEvidence(missing), /审计结果/);
  const mismatch = evidence(); mismatch.audit.metadata.vulnerabilities.high = 1;
  assert.throws(() => validateEvidence(mismatch), /漏洞统计/);
  mismatch.audit.metadata.vulnerabilities.total = 1;
  assert.equal(validateEvidence(mismatch).vulnerabilities.total, 1);
});
