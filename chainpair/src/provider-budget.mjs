const KEY = 'provider.okx.read-budget.v1';
const safe = (message, code = 'PROVIDER_BUDGET') => Object.assign(new Error(message), { safe: true, code });
const DAY = 86400000;
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(safe('读取请求已取消', 'ABORT_ERR'));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', cancel); resolve(); }
  function cancel() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(safe('读取请求已取消', 'ABORT_ERR')); }
  signal?.addEventListener('abort', cancel, { once: true });
});

/** One local read budget for every OKX credential; never a per-key rotation pool. */
export class ProviderReadGate {
  constructor({ now = Date.now, sleep = delay, minIntervalMs = 500, maxPerMinute = 90, maxPerDay = 30000 } = {}) {
    this.now = now; this.sleep = sleep; this.minIntervalMs = minIntervalMs; this.maxPerMinute = maxPerMinute; this.maxPerDay = maxPerDay;
    this.store = null; this.tail = Promise.resolve(); this.state = { requests: [], retryAt: 0, blocked: '', lastAt: null };
  }
  configure({ store } = {}) {
    this.store = store || null;
    const saved = store?.getMeta(KEY);
    if (saved) {
      if (!Array.isArray(saved.requests) || saved.requests.some(t => !Number.isSafeInteger(t) || t < 0) || !Number.isSafeInteger(saved.retryAt) || saved.retryAt < 0 || !['', 'auth_required', 'access_denied'].includes(saved.blocked) || !(saved.lastAt === null || Number.isSafeInteger(saved.lastAt))) throw safe('报价请求预算记录异常，请核对本机记录');
      this.state = structuredClone(saved);
    }
    return this;
  }
  persist() { this.store?.setMeta(KEY, structuredClone(this.state)); }
  snapshot() {
    const at = this.now();
    return { requestsDay: this.state.requests.filter(t => t > at - DAY).length, requestsMinute: this.state.requests.filter(t => t > at - 60000).length,
      retryAt: this.state.retryAt, blocked: this.state.blocked, minIntervalMs: this.minIntervalMs, maxPerMinute: this.maxPerMinute, maxPerDay: this.maxPerDay,
      scope: 'all-local-okx-read-credentials', note: '本机请求预算，不是平台额度；平台限流与访问拒绝优先。' };
  }
  acquire({ signal } = {}) {
    const operation = async () => {
      if (signal?.aborted) throw safe('读取请求已取消', 'ABORT_ERR');
      let at = this.now();
      if (this.state.lastAt !== null && at < this.state.lastAt) throw safe('系统时钟回退，报价读取暂停');
      if (this.state.blocked) throw safe('报价接口权限或访问限制未解除，请核对本机凭据与账户可用范围', 'PROVIDER_ACCESS');
      if (at < this.state.retryAt) throw safe('报价接口处于限流冷却，保留请求计数并等待重试', 'PROVIDER_COOLDOWN');
      if (this.state.lastAt !== null && at - this.state.lastAt < this.minIntervalMs) await this.sleep(this.minIntervalMs - (at - this.state.lastAt), signal);
      if (signal?.aborted) throw safe('读取请求已取消', 'ABORT_ERR');
      at = this.now();
      if (this.state.lastAt !== null && at < this.state.lastAt) throw safe('系统时钟回退，报价读取暂停');
      if (this.state.blocked || at < this.state.retryAt) throw safe('报价接口已暂停或限流冷却，未派发请求', 'PROVIDER_COOLDOWN');
      const requests = this.state.requests.filter(t => t > at - DAY);
      if (requests.length >= this.maxPerDay || requests.filter(t => t > at - 60000).length >= this.maxPerMinute) throw safe('已达本机共享报价请求预算，请等待窗口恢复', 'PROVIDER_LIMIT');
      this.state.requests = [...requests, at]; this.state.lastAt = at; this.persist();
      return { dispatchedAt: at };
    };
    const pending = this.tail.then(operation, operation); this.tail = pending.catch(() => {}); return pending;
  }
  observe(response) {
    const status = response?.status;
    if ([401, 403, 451].includes(status)) this.state.blocked = status === 401 ? 'auth_required' : 'access_denied';
    if ([418, 429].includes(status)) {
      const input = response.headers?.get?.('retry-after');
      const seconds = typeof input === 'string' && /^\d+(?:\.\d+)?$/.test(input.trim()) ? Number(input) : null;
      const timestamp = seconds === null && typeof input === 'string' ? Date.parse(input) : NaN;
      const retryAt = seconds !== null && Number.isFinite(seconds) ? this.now() + seconds * 1000 : Number.isFinite(timestamp) ? timestamp : this.now() + 60000;
      this.state.retryAt = Math.max(this.state.retryAt, this.now() + 1000, Math.ceil(retryAt));
    }
    if ([401, 403, 451, 418, 429].includes(status)) this.persist();
  }
  credentialsChanged() { if (this.state.blocked === 'auth_required') this.state.blocked = ''; this.persist(); }
}

export const sharedOkxReadGate = new ProviderReadGate();
