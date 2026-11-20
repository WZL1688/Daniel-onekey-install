export const AVE_MIN_GAP_MS = 300000;
const HOUR = 3600000, DAY = 86400000;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;

// Reservations are persisted before dispatch. A failed call still consumes a request.
export class RadarBudget {
  constructor({ store, now = Date.now }) {
    this.store = store; this.now = now;
    this.reload();
  }
  reload() {
    const saved = this.store.getMeta('radar.budget.v1');
    if (saved && (!safeInteger(saved.lifetime) || !Array.isArray(saved.requests) || !saved.requests.every(safeInteger) || !safeInteger(saved.lastClock) || !safeInteger(saved.nextAt))) throw new Error('雷达请求预算记录损坏，请保留本机数据核对');
    this.state = saved || { lifetime: 0, requests: [], lastClock: 0, nextAt: 0 };
    return this.state;
  }
  usage() {
    this.reload();
    const at = Math.max(this.now(), this.state.lastClock);
    return { hour: this.state.requests.filter(t => t > at - HOUR).length, day: this.state.requests.filter(t => t > at - DAY).length, lifetime: this.state.lifetime };
  }
  check(settings) {
    this.reload();
    const at = this.now(), usage = this.usage();
    if (at < this.state.lastClock) return { allowed: false, reason: '系统时间回退，请核对时钟；请求预算不会重置', nextAt: this.state.lastClock };
    if (usage.lifetime >= settings.maxRequestsLifetime) return { allowed: false, reason: '已达到本机累计请求预算', nextAt: null };
    if (usage.day >= settings.maxRequestsPerDay) return { allowed: false, reason: '已达到本机最近24小时请求预算', nextAt: this.state.requests.filter(t => t > at - DAY).sort((a,b)=>a-b)[0] + DAY };
    if (usage.hour >= settings.maxRequestsPerHour) return { allowed: false, reason: '已达到本机最近1小时请求预算', nextAt: this.state.requests.filter(t => t > at - HOUR).sort((a,b)=>a-b)[0] + HOUR };
    if (at < this.state.nextAt) return { allowed: false, reason: 'AVE 请求冷却中，手动刷新也须等待', nextAt: this.state.nextAt };
    return { allowed: true, reason: '', nextAt: at };
  }
  reserve(settings) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const gate = this.check(settings);
      if (!gate.allowed) { this.store.db.exec('COMMIT'); return gate; }
      const at = this.now();
      this.state = { ...this.state, lifetime: this.state.lifetime + 1, requests: [...this.state.requests.filter(t => t > at - DAY), at], lastClock: at, nextAt: at + AVE_MIN_GAP_MS };
      this.store.setMeta('radar.budget.v1', this.state);
      this.store.db.exec('COMMIT');
      return { allowed: true, reason: '', nextAt: this.state.nextAt };
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  backoff(delay) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.reload();
      const at = Math.max(this.now(), this.state.lastClock);
      this.state.nextAt = Math.max(this.state.nextAt, at + Math.min(DAY, Math.max(AVE_MIN_GAP_MS, Number.isFinite(delay) ? delay : 1800000)));
      this.store.setMeta('radar.budget.v1', this.state);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}
