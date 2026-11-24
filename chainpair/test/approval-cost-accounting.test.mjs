import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { buildDailyReview } from '../src/review.mjs';
import { buildPerformanceEvidence } from '../src/performance.mjs';

const now = Date.parse('2026-11-24T03:00:00Z');
const approval = { id: 'approval-cost', type: 'approval', mode: 'live', executionMode: 'approval', status: 'COMPLETED', amountUsd: 0,
  createdAt: '2026-11-24T02:00:00Z', updatedAt: '2026-11-24T02:01:00Z',
  actual: { spentUsd: 0, receivedUsd: 0, gasUsd: .03, rentUsd: 0, profitUsd: -.03, approvalCostUsd: .03 }, estimate: { netProfitUsd: -.04 } };

test('finite approval costs remain visible without consuming arbitrage capital or counts', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'approval-cost-')), store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveTrade(approval);
  const stats = store.stats('live');
  assert.equal(stats.executions, 0); assert.equal(stats.cumulativeUsd, 0); assert.equal(stats.completed, 0);
  assert.equal(stats.approvalCompleted, 1); assert.equal(stats.approvalGasUsd, .03); assert.equal(stats.profitUsd, 0);
});

test('daily accounting includes authorization cost as a negative setup expense with its own type', () => {
  const report = buildDailyReview([approval], { day: '2026-11-24', mode: 'live', now });
  assert.equal(report.pnl.actualProfitUsd, -.03);
  assert.equal(report.pnl.networkAndProtocolUsd, .03);
  assert.equal(report.byType.find(row => row.type === 'approval').profitUsd, -.03);
  assert(report.observations.some(row => row.code === 'APPROVAL_COST'));
});

test('authorization expenses cannot become live arbitrage success-rate samples', () => {
  for (const executionMode of ['inventory', 'bridge']) {
    const report = buildPerformanceEvidence([approval], { executionMode, now });
    assert.equal(report.counts.attempts, 0); assert.equal(report.observedRate, null); assert.equal(report.historicalEvidenceMet, false);
  }
});
