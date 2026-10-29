import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, Vault } from './store.js';
import { Scheduler } from './scheduler.js';
import { Exchanges } from './exchanges.js';
import { Engine } from './engine.js';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const publicDir = path.join(ROOT, 'public');
const verification = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/verification.json'), 'utf8'));
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '', done = false;
    req.on('data', chunk => { if (done) return; text += chunk; if (Buffer.byteLength(text) > 65536) { done = true; reject(Error('请求内容超过 64 KiB')); } });
    req.on('end', () => { if (done) return; try { resolve(text ? JSON.parse(text) : {}); } catch { reject(Error('JSON 请求格式错误')); } });
    req.on('error', reject);
  });
}
export function createApp({ dataDir = process.env.ARB_DATA_DIR || path.join(ROOT, 'data'), transport, docsVerified = verification, startEngine = true } = {}) {
  const store = new Store(dataDir), vault = new Vault(store), scheduler = new Scheduler(store);
  const exchanges = new Exchanges(store, vault, scheduler, transport), engine = new Engine(store, exchanges, { docsVerified });
  const token = crypto.randomBytes(32).toString('hex'), sessions = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const addr = server.address(), expected = `127.0.0.1:${addr?.port}`, localhost = `localhost:${addr?.port}`;
      if (![expected, localhost].includes(req.headers.host)) return json(res, 403, { error: 'Host 校验失败；此工具仅限本机访问' });
      if (req.headers.origin && ![`http://${expected}`, `http://${localhost}`].includes(req.headers.origin)) return json(res, 403, { error: '拒绝跨站请求' });
      const url = new URL(req.url, 'http://' + expected);
      if (url.pathname === '/api/session' && req.method === 'GET') {
        // A cross-site page cannot read this token (no CORS); mutations also require a same-site cookie.
        const id = crypto.randomBytes(24).toString('hex'); sessions.set(id, Date.now() + 86400000);
        for (const [sid, expiry] of sessions) if (expiry < Date.now()) sessions.delete(sid);
        if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
        res.setHeader('Set-Cookie', `arb_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
        return json(res, 200, { csrf: token });
      }
      if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
        const cookie = req.headers.cookie?.match(/(?:^|;\s*)arb_session=([a-f0-9]+)/)?.[1];
        if (!cookie || !(sessions.get(cookie) > Date.now()) || req.headers['x-csrf-token'] !== token || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '会话或 CSRF 校验失败，请重新打开页面' });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = store.state, now = Date.now();
        const books = Object.fromEntries(Object.entries(state.books).map(([ex, entries]) => [ex, Object.fromEntries(Object.entries(entries).filter(([id]) => state.config.pairs.includes(id)).map(([id, b]) => [id, { ...b, bids: b.bids.slice(0, 5), asks: b.asks.slice(0, 5), stale: now - b.at > state.config.maxBookAgeMs }]))]));
        const opportunities = Object.fromEntries(Object.entries(state.opportunities).map(([id, x]) => [id, { ...x, stale: !x.at || now - x.at > state.config.maxBookAgeMs }]));
        return json(res, 200, { now, config: state.config, keys: vault.publicKeys(), accounts: state.accounts, balances: state.balances,
          books, opportunities, scanResults: state.scanResults, batches: state.batches.slice(0, 200), blocks: state.blocks,
          engine: { ...state.engine, running: engine.running, busy: engine.busy, slotMs: engine.slotMs(), estimatedCycleMs: engine.slotMs() * state.config.pairs.length, scannerRunning: engine.scanRequested },
          rates: scheduler.snapshot(), errors: state.errors.slice(0, 60), events: state.events.slice(0, 60), liveReasons: engine.liveReasons(), docsVerified: engine.docsVerified,
          balanceDirections: Object.fromEntries(state.config.pairs.map(id => [id, engine.balanceDirection(id)])) });
      }
      if (req.method === 'GET' && url.pathname === '/api/records') {
        const from = Number(url.searchParams.get('from') || Date.now() - 10 * 86400000);
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0)), limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        if (![from, offset, limit].every(Number.isFinite)) throw Error('分页参数错误');
        const records = store.state.batches.filter(x => x.at >= from && (!url.searchParams.get('mode') || x.mode === url.searchParams.get('mode')));
        return json(res, 200, { total: records.length, records: records.slice(offset, offset + limit) });
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', live: store.state.config.autoTrading, blocked: engine.unresolved().length, uptime: process.uptime() });
      if (req.method === 'POST') {
        const data = await readBody(req);
        if (url.pathname === '/api/config') return json(res, 200, { config: engine.updateConfig(data.config, data.confirm) });
        if (url.pathname === '/api/live') { if (typeof data.enabled !== 'boolean') throw Error('实盘开关必须为布尔值'); engine.setLive(data.enabled, data.confirm); return json(res, 200, { enabled: store.state.config.autoTrading }); }
        if (url.pathname === '/api/keys') {
          if (store.state.config.autoTrading || engine.busy || engine.unresolved().length) throw Error('配置 Key 前请停止实盘并核对未处理批次');
          return json(res, 201, { id: vault.add(data) });
        }
        if (url.pathname === '/api/keys/validate') {
          const key = store.state.keys.find(k => k.id === data.id);
          if (!key || key.role !== 'query') throw Error('只能验证查询 Key；交易 Key 禁止查询');
          if (engine.pendingValidations.has(key.id)) throw Error('该 Key 正在验证');
          engine.pendingValidations.add(key.id);
          exchanges.validateKey(key.id).then(() => exchanges.balances(key.exchange)).catch(e => store.error('key-validation', e.message)).finally(() => engine.pendingValidations.delete(key.id));
          return json(res, 202, { queued: true });
        }
        if (url.pathname === '/api/keys/toggle') {
          if (store.state.config.autoTrading || engine.busy || engine.unresolved().length) throw Error('切换 Key 前请停止实盘并核对未处理批次');
          const key = store.state.keys.find(k => k.id === data.id); if (!key) throw Error('Key 不存在');
          if (typeof data.enabled !== 'boolean') throw Error('Key 开关格式错误');
          key.enabled = data.enabled; store.save(); return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/balances/refresh') { if (engine.balanceBusy) throw Error('余额刷新已排队或执行中'); store.state.engine.lastBalanceAt = 0; return json(res, 202, { queued: true }); }
        if (url.pathname === '/api/scan') { engine.scanRequested = true; return json(res, 202, { queued: true, note: '实盘时扫描暂停；每次仅筛选一个交易对' }); }
        if (url.pathname === '/api/submit') {
          if (data.confirm !== '确认提交该批次') throw Error('手动提交必须确认');
          if (Object.keys(data).some(k => !['pair', 'buyExchange', 'mode', 'confirm'].includes(k))) throw Error('前端不得指定数量、价格或授权计算结果');
          const promise = engine.submit(data.pair, data.buyExchange, data.mode);
          promise.catch(e => store.error('manual-submit', e.message));
          return json(res, 202, { queued: true, note: '后台将重新复核；请查看提交记录' });
        }
        if (url.pathname === '/api/resolve') { engine.resolve(data.id, data); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/cancel') {
          const batch = store.state.batches.find(b => b.id === data.batchId), leg = batch?.legs?.[data.legIndex];
          if (!leg?.orderId || data.confirm !== '确认撤销此订单' || engine.busy) throw Error('只能明确确认后撤销已记录订单号的订单');
          if (leg.cancelStatus) throw Error('此撤单请求已发送，不会重发；请到交易所核对');
          leg.cancelStatus = 'SENDING'; store.save();
          exchanges.cancel(leg.exchange, batch.pair, leg.orderId).then(x => { leg.cancelStatus = x.status; store.save(); }).catch(e => { leg.cancelStatus = 'UNKNOWN'; store.error('cancel', e.message); });
          return json(res, 202, { note: '撤单不代表未成交；仍需人工核对两腿' });
        }
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.writeHead(200, { 'Content-Type': { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' }[file.split('.').pop()], 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(path.join(publicDir, file)));
      }
      json(res, 404, { error: '接口不存在' });
    } catch (e) { json(res, 400, { error: e.message }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  if (startEngine) engine.start();
  let closePromise;
  return { server, store, vault, scheduler, exchanges, engine,
    close() { return closePromise ||= (async () => { engine.stop(); scheduler.close(); await new Promise(resolve => server.close(resolve));
      const deadline = Date.now() + 12000; while (scheduler.active.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      store.save(); store.close(); })(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8888);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('PORT 必须为 1024–65535');
  const app = createApp();
  app.server.listen(port, '127.0.0.1', () => console.log(`现货套利工具已启动，端口 ${port}，仅绑定本机；默认关闭实盘。`));
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
  process.on('uncaughtException', () => { app.store.state.config.autoTrading = false; try { app.store.save(); } finally { console.error('致命异常，实盘已关闭；请检查数据与服务状态。'); process.exit(1); } });
}
