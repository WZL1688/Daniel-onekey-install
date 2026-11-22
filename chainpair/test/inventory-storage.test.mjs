import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.mjs';
import { acquireRuntimeLock } from '../src/runtime-lock.mjs';
import { buildDailyReview } from '../src/review.mjs';

test('inventory reservations are atomic across instances, resize conservatively and persist through restart', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'inventory-reservation-')), first = new Store(dir), second = new Store(dir);
  const key = { mode: 'live', chain: 'bnb', address: '0x1111111111111111111111111111111111111111' };
  try {
    first.reserveInventory({ ...key, tradeId: 'one', amountRaw: '70', availableRaw: '100' });
    assert.throws(() => second.reserveInventory({ ...key, tradeId: 'two', amountRaw: '31', availableRaw: '100' }), /库存不足/);
    second.reserveInventory({ ...key, tradeId: 'two', amountRaw: '30', availableRaw: '100' });
    assert.equal(first.getReservedInventory(key), '100');
    assert.throws(() => first.reserveInventory({ ...key, tradeId: 'one', amountRaw: '71', availableRaw: '100' }), /库存不足/);
    first.reserveInventory({ ...key, tradeId: 'one', amountRaw: '60', availableRaw: '100' });
    assert.equal(second.getReservedInventory(key), '90');
    assert.equal(second.getReservedInventory({ ...key, mode: 'demo' }), '0');
    const restarted = new Store(dir); assert.equal(restarted.getReservedInventory(key), '90'); restarted.close();
    first.releaseInventory('one'); assert.equal(second.getReservedInventory(key), '30');
    assert.throws(() => first.reserveInventory({ ...key, tradeId: 'two', address: '0x2222222222222222222222222222222222222222', amountRaw: '1', availableRaw: '100' }), /身份不一致/);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('runtime lock rejects duplicate engines, releases normally and recovers a dead owner', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'inventory-runtime-lock-'));
  try {
    const first = acquireRuntimeLock(dir); assert.throws(() => acquireRuntimeLock(dir), /已有程序/);
    first.release(); assert.equal(existsSync(path.join(dir, 'runtime.lock')), false);
    writeFileSync(path.join(dir, 'runtime.lock'), JSON.stringify({ pid: 2147483647, token: 'dead-test-owner' }));
    const next = acquireRuntimeLock(dir); assert.throws(() => acquireRuntimeLock(dir), /已有程序/); next.release();
    writeFileSync(path.join(dir, 'runtime.lock'), 'incomplete-owner'); assert.throws(() => acquireRuntimeLock(dir), /已有程序/);
    assert.equal(existsSync(path.join(dir, 'runtime.lock')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inventory cash spread remains separate from closed profit in stats and daily review', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'inventory-review-')), store = new Store(dir), now = Date.parse('2026-11-20T06:00:00Z');
  const base = { type: 'arbitrage', mode: 'demo', status: 'COMPLETED', createdAt: '2026-11-20T01:00:00Z', completedAt: '2026-11-20T01:01:00Z', updatedAt: '2026-11-20T01:01:00Z', estimate: { netProfitUsd: .2 }, actual: { spentUsd: 5, receivedUsd: 5.3, gasUsd: .02, rentUsd: .01, profitUsd: .27 } };
  try {
    store.saveTrade({ ...base, id: 'closed' }); store.saveTrade({ ...base, id: 'stock', executionMode: 'inventory', actual: { ...base.actual, closedInventory: false, inventoryDelta: { address: 'must-not-enter-summary' } } });
    assert.equal(store.stats().profitUsd, .27); assert.equal(store.stats().inventoryCashSpreadUsd, .27);
    const review = buildDailyReview(store.allTrades(), { day: '2026-11-20', mode: 'demo', now });
    assert.equal(review.pnl.actualProfitUsd, .27); assert.equal(review.inventory.cashSpreadProfitUsd, .27); assert.equal(review.inventory.closedInventory, false);
    assert.equal(review.counts.closed, 1); assert.equal(review.counts.inventory, 1); assert.equal(review.counts.verified, 2);
    assert.equal(JSON.stringify(review).includes('must-not-enter-summary'), false); assert(review.observations.some(row => row.code === 'INVENTORY_CASH_SPREAD'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
