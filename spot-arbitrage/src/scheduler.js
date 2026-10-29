export class ApiError extends Error {
  constructor(message, { status = 0, code = '', retryAfter = null, unknown = false } = {}) {
    super(message); Object.assign(this, { status, code, retryAfter, unknown });
  }
}
export function retryDelay(value, now = Date.now()) {
  if (value == null || value === '') return 0;
  if (/^\d+(\.\d+)?$/.test(String(value))) return Math.max(0, Number(value) * 1000);
  const at = Date.parse(value); return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}
export class Scheduler {
  constructor(store, { now = Date.now, interval = 25 } = {}) {
    this.store = store; this.now = now; this.queue = []; this.inflight = new Map(); this.active = new Set(); this.stopped = false;
    this.timer = setInterval(() => this.drain(), interval); this.timer.unref();
  }
  rate(exchange) {
    return this.store.state.rates[exchange] ||= { windows: {}, backoffUntil: 0, reason: '', streak: 0,
      metrics: { public: 0, private: 0, orders: 0, failures: 0, limited: 0, delayed: 0, merged: 0, waitMs: 0, latencyMs: 0, lastLatencyMs: 0 } };
  }
  limits(task) {
    const ex = task.exchange, budget = this.store.state.config.budgets[ex];
    if (ex === 'binance') {
      const official = this.store.state.exchangeMeta.binance?.rateLimits || [];
      const rules = official.length ? official : [
        { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 1200 },
        { rateLimitType: 'RAW_REQUESTS', interval: 'MINUTE', intervalNum: 5, limit: 61000 },
        { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50 },
        { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160000 },
      ];
      const units = { SECOND: 1000, MINUTE: 60000, HOUR: 3600000, DAY: 86400000 };
      const result = rules.filter(r => r.rateLimitType !== 'ORDERS' || task.kind === 'order').map(r => ({
        id: `${r.rateLimitType}:${r.intervalNum}:${r.interval}`, ms: units[r.interval] * r.intervalNum,
        cap: r.limit, cost: r.rateLimitType === 'REQUEST_WEIGHT' ? task.weight : 1,
        reserve: r.rateLimitType === 'REQUEST_WEIGHT' ? 50 : 0,
      }));
      result.push({ id: 'configured', ms: 60000, cap: Math.min(budget, 1200), cost: task.weight, reserve: 50 });
      result.push({ id: 'burst', ms: 1000, cap: 5, cost: 1, reserve: 0 });
      return result;
    }
    // Conservative aggregate buckets are stricter than endpoint-specific OKX limits.
    const privateRequest = task.kind !== 'public';
    return [
      { id: privateRequest ? 'private2s' : 'public2s', ms: 2000, cap: privateRequest ? 4 : 8, cost: 1, reserve: privateRequest ? 0 : 2 },
      { id: 'configured', ms: 60000, cap: Math.min(budget, 240), cost: 1, reserve: 8 },
      { id: 'endpoint:' + task.route, ms: 2000, cap: task.endpointCap || 4, cost: 1, reserve: 0 },
    ];
  }
  available(task) {
    const now = this.now(), rate = this.rate(task.exchange);
    let wait = Math.max(0, rate.backoffUntil - now), reason = wait ? rate.reason : '';
    for (const limit of this.limits(task)) {
      if (!Number.isFinite(limit.ms) || limit.cap < limit.cost) return { wait: Infinity, reason: 'API 配置额度小于单次请求成本' };
      let win = rate.windows[limit.id];
      if (!win || now >= win.resetAt) win = rate.windows[limit.id] = { used: 0, resetAt: (Math.floor(now / limit.ms) + 1) * limit.ms };
      const reserve = task.priority > 0 ? limit.reserve : 0;
      if (win.used + limit.cost > Math.max(limit.cost, limit.cap - reserve)) {
        if (win.resetAt - now > wait) { wait = win.resetAt - now; reason = `API 额度已用完或为复核预留，预计 ${Math.ceil(wait / 1000)} 秒后可复核`; }
      }
      rate.history ||= {};
      const events = rate.history[limit.id] = (rate.history[limit.id] || []).filter(e => e.at > now - limit.ms);
      let used = events.reduce((sum, e) => sum + e.cost, 0), missing = used + limit.cost - Math.max(limit.cost, limit.cap - reserve);
      if (missing > 0) {
        for (const event of events) {
          missing -= event.cost;
          if (missing <= 0) {
            const delay = event.at + limit.ms - now;
            if (delay > wait) { wait = delay; reason = `滚动窗口保护，预计 ${Math.ceil(delay / 1000)} 秒后有可用额度`; }
            break;
          }
        }
      }
    }
    return { wait, reason };
  }
  enqueue(task, run) {
    if (this.stopped) return Promise.reject(Error('API 调度器已关闭'));
    if (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 5 || !['binance', 'okx'].includes(task.exchange)) throw Error('调度任务参数错误');
    if (task.dedupe && this.inflight.has(task.dedupe)) {
      const existing = this.inflight.get(task.dedupe); existing.task.priority = Math.min(existing.task.priority, task.priority);
      this.rate(task.exchange).metrics.merged++; return existing.promise;
    }
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    const item = { task, run, resolve, reject, promise, queuedAt: this.now(), delayed: false };
    if (task.dedupe) this.inflight.set(task.dedupe, item);
    this.queue.push(item); this.drain(); return promise;
  }
  drain() {
    if (this.stopped) return;
    this.queue.sort((a, b) => a.task.priority - b.task.priority || a.queuedAt - b.queuedAt);
    for (const item of [...this.queue]) {
      const { task } = item;
      if (this.active.has(task.exchange)) continue;
      const availability = this.available(task);
      if (availability.wait === Infinity) { this.finishQueued(item, Error(availability.reason)); continue; }
      if (availability.wait > 0) {
        if (!item.delayed) { item.delayed = true; this.rate(task.exchange).metrics.delayed++; this.store.save(); }
        continue;
      }
      this.queue.splice(this.queue.indexOf(item), 1); this.active.add(task.exchange);
      const rate = this.rate(task.exchange), now = this.now();
      for (const limit of this.limits(task)) { rate.windows[limit.id].used += limit.cost; rate.history[limit.id].push({ at: now, cost: limit.cost }); }
      rate.metrics[task.kind === 'public' ? 'public' : 'private']++;
      if (task.kind === 'order') rate.metrics.orders++;
      rate.metrics.waitMs += now - item.queuedAt;
      this.store.save(); // Budget is reserved durably BEFORE touching the network.
      Promise.resolve().then(item.run).then(value => { rate.streak = 0; item.resolve(value); }, error => {
        rate.metrics.failures++; rate.streak++;
        rate.metrics.httpStatuses ||= {};
        rate.metrics.httpStatuses[String(error.status || 'NETWORK')] = (rate.metrics.httpStatuses[String(error.status || 'NETWORK')] || 0) + 1;
        const limited = [403, 418, 429].includes(error.status) || ['50011', '50061'].includes(String(error.code));
        if (limited) rate.metrics.limited++;
        const delay = Math.max(retryDelay(error.retryAfter, this.now()), limited ? Math.min(3600000, 30000 * 2 ** Math.min(rate.streak - 1, 7)) : Math.min(30000, 1000 * 2 ** Math.min(rate.streak - 1, 5)));
        rate.backoffUntil = Math.max(rate.backoffUntil, this.now() + delay);
        rate.reason = `${limited ? '限流或访问拒绝' : '请求失败短暂退避'} (${error.status || error.code || 'NETWORK'})，${Math.ceil(delay / 1000)} 秒`;
        item.reject(error); // Never retry ANY request automatically, especially mutations.
      }).finally(() => {
        rate.metrics.lastLatencyMs = this.now() - now; rate.metrics.latencyMs += this.now() - now;
        this.active.delete(task.exchange); if (task.dedupe) this.inflight.delete(task.dedupe);
        this.store.save(); this.drain();
      });
    }
  }
  finishQueued(item, error) { this.queue.splice(this.queue.indexOf(item), 1); if (item.task.dedupe) this.inflight.delete(item.task.dedupe); item.reject(error); }
  observeHeaders(exchange, headers) {
    if (exchange !== 'binance') return;
    const rate = this.rate(exchange), now = this.now();
    for (const [name, value] of Object.entries(headers)) {
      let match = name.toLowerCase().match(/^x-mbx-(used-weight|order-count)-(\d+)([smhd])$/);
      if (!match) continue;
      const [, kind, number, unit] = match;
      const type = kind === 'used-weight' ? 'REQUEST_WEIGHT' : 'ORDERS';
      const interval = { s: 'SECOND', m: 'MINUTE', h: 'HOUR', d: 'DAY' }[unit];
      const ms = Number(number) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
      const id = `${type}:${number}:${interval}`;
      const old = rate.windows[id];
      if (Number.isFinite(Number(value))) rate.windows[id] = { used: Math.max(old?.resetAt > now ? old.used : 0, Number(value)), resetAt: (Math.floor(now / ms) + 1) * ms };
    }
  }
  snapshot() {
    return Object.fromEntries(['binance', 'okx'].map(ex => [ex, { ...this.rate(ex), active: this.active.has(ex),
      queue: this.queue.filter(x => x.task.exchange === ex).map(x => ({ route: x.task.route, priority: x.task.priority, waitedMs: this.now() - x.queuedAt, ...this.available(x.task) })) }]));
  }
  close() { this.stopped = true; clearInterval(this.timer); for (const item of [...this.queue]) this.finishQueued(item, Error('服务关闭，排队请求未发送')); }
}
