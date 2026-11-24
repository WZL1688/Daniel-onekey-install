import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderReadGate } from '../src/provider-budget.mjs';

function fixture(options = {}) {
  let clock = 100000; const saved = new Map(), waits = [];
  const store = { getMeta: k => saved.get(k), setMeta: (k, v) => saved.set(k, structuredClone(v)) };
  const gate = new ProviderReadGate({ now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, ...options }).configure({ store });
  return { gate, store, waits, advance: ms => clock += ms, setTime: at => clock = at, now: () => clock };
}

test('all credentials share one serialized read budget and reserve attempts before dispatch', async () => {
  const ctx = fixture();
  await Promise.all([ctx.gate.acquire(), ctx.gate.acquire(), ctx.gate.acquire()]);
  assert.deepEqual(ctx.waits, [500, 500]); assert.equal(ctx.gate.snapshot().requestsMinute, 3);
  const restarted = new ProviderReadGate({ now: ctx.now }).configure({ store: ctx.store });
  assert.equal(restarted.snapshot().requestsDay, 3);
});

test('minute and daily limits reject rather than resetting on a new credential or recreation', async () => {
  const ctx = fixture({ maxPerMinute: 2, maxPerDay: 3 });
  await ctx.gate.acquire(); await ctx.gate.acquire();
  await assert.rejects(ctx.gate.acquire(), /共享报价请求预算/);
  ctx.advance(60001); await ctx.gate.acquire();
  ctx.advance(60001); await assert.rejects(ctx.gate.acquire(), /共享报价请求预算/);
  const restored = new ProviderReadGate({ now: ctx.now, maxPerDay: 3 }).configure({ store: ctx.store });
  await assert.rejects(restored.acquire(), /共享报价请求预算/);
});

test('429 Retry-After is honored across restart and cannot be cleared by replacing credentials', async () => {
  const ctx = fixture(); await ctx.gate.acquire();
  ctx.gate.observe({ status: 429, headers: new Headers({ 'Retry-After': '120' }) });
  ctx.gate.credentialsChanged();
  await assert.rejects(ctx.gate.acquire(), /限流冷却/);
  const restored = new ProviderReadGate({ now: ctx.now }).configure({ store: ctx.store });
  await assert.rejects(restored.acquire(), /限流冷却/);
  ctx.advance(120001); await restored.acquire();
});

test('authentication can be corrected while access denial cannot be bypassed by replacing keys', async () => {
  const ctx = fixture(); await ctx.gate.acquire();
  ctx.gate.observe({ status: 401 }); await assert.rejects(ctx.gate.acquire(), /权限或访问限制/);
  ctx.gate.credentialsChanged(); await ctx.gate.acquire();
  assert.equal(ctx.gate.snapshot().requestsDay, 2);
  ctx.gate.observe({ status: 451 }); ctx.gate.credentialsChanged();
  await assert.rejects(ctx.gate.acquire(), /权限或访问限制/);
});

test('aborted and backward-clock requests are not dispatched or counted', async () => {
  const ctx = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(ctx.gate.acquire({ signal: abort.signal }), /取消/);
  assert.equal(ctx.gate.snapshot().requestsDay, 0);
  await ctx.gate.acquire(); ctx.setTime(99999);
  await assert.rejects(ctx.gate.acquire(), /时钟回退/);
  assert.equal(ctx.gate.snapshot().requestsDay, 1);
});

test('malformed persisted budgets do not silently bypass limits or expose content', () => {
  assert.throws(() => new ProviderReadGate().configure({ store: { getMeta: () => ({ requests: ['secret'], retryAt: 0, blocked: '', lastAt: null }) } }), error => error.safe && !error.message.includes('secret'));
});
