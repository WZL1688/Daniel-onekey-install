import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, Vault } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { Engine } from '../src/engine.js';
import { normalizeBook } from '../src/math.js';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-test-')), store = new Store(dir), vault = new Vault(store);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, vault };
}
export const rule = () => ({ enabled: true, symbol: 'BTCUSDT', step: '0.01', tick: '0.01', minQty: '0.01', maxQty: '100000', minNotional: '5' });
export const book = (id = 'BTC/USDT', bid = '99', ask = '100') => normalizeBook({ pair: id, at: Date.now(), bids: [[bid, '100']], asks: [[ask, '100']] }, id);
export function readyEngine(t, options = {}) {
  const x = setup(t), s = x.store.state;
  s.config.pairs = ['BTC/USDT']; s.config.feeConfirmed = true;
  s.accounts = { binance: '123', okx: '456' };
  for (const ex of ['binance', 'okx']) {
    x.vault.add({ exchange: ex, role: 'query', apiKey: ex + 'querykey1234', secret: 'test-query-secret-123', passphrase: 'test-passphrase' });
    const key = s.keys.at(-1); key.status = 'VERIFIED'; key.accountUid = s.accounts[ex];
    x.vault.add({ exchange: ex, role: 'trade', apiKey: ex + 'tradekey1234', secret: 'test-trade-secret-123', passphrase: 'test-passphrase', accountUid: s.accounts[ex], sameAccountConfirmed: true });
    s.exchangeMeta[ex] = { rulesAt: Date.now(), clock: { at: Date.now(), offset: 0 } };
    s.rules[ex] = { 'BTC/USDT': rule() };
    s.balances[ex] = { valid: true, at: Date.now(), assets: { BTC: { free: '10', locked: '0', total: '10' }, USDT: { free: '10000', locked: '0', total: '10000' } } };
    s.books[ex] = { 'BTC/USDT': ex === 'binance' ? book() : book('BTC/USDT', '102', '103') };
  }
  const calls = [];
  const exchange = {
    chooseTrade: ex => s.keys.find(k => k.exchange === ex && k.role === 'trade'),
    rules: async (ex, priority, force) => { calls.push(['rules', ex, priority, force]); },
    balances: async (ex, priority) => { calls.push(['balances', ex, priority]); s.balances[ex].at = Date.now(); return s.balances[ex]; },
    book: async (ex, id, priority) => { calls.push(['book', ex, priority]); s.books[ex][id].at = Date.now(); return s.books[ex][id]; },
    order: async (ex, order) => { calls.push(['order', ex, order]); return { orderId: String(calls.length), clientId: order.clientId, status: 'ACKNOWLEDGED' }; },
    assertNoOpenOrders: async ex => { calls.push(['openOrders', ex]); },
    priceContext: async () => null,
    assertPriceContext: () => {},
    ...options,
  };
  const engine = new Engine(x.store, exchange, { docsVerified: { binance: true, okx: true } });
  s.config.autoTrading = true;
  return { ...x, engine, exchange, calls };
}
export function scheduler(t, store, options) { const s = new Scheduler(store, { interval: 2, ...options }); t.after(() => s.close()); return s; }
