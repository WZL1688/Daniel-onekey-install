import { normalizeWalletAddress } from '../vault.mjs';
import { AveClient } from './ave.mjs';
import { DEFAULT_RADAR_SETTINGS, validateRadarSettings, filterRadarToken } from './settings.mjs';
import { RadarBudget } from './budget.mjs';

const fail = message => Object.assign(new Error(message), { safe: true });
const clone = value => structuredClone(value);
const safeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
const unknownRisk = () => ({ status: 'unknown', flags: [], checkedAt: null, source: '尚未查询合约风险报告', unknowns: ['貔貅、卖出限制、权限及持仓风险未完成核验'] });

export class RadarService {
  constructor({ store, vault, client = new AveClient(), now = Date.now } = {}) {
    this.store = store; this.vault = vault; this.client = client; this.now = now;
    this.settings = validateRadarSettings(store.getMeta('radar.settings.v1') || {}, DEFAULT_RADAR_SETTINGS);
    this.budget = new RadarBudget({ store, now });
    this.cache = { bnb: [], solana: [] }; this.watches = {}; this.firstSeen = {}; this.riskLedger = {};
    const ledger = store.getMeta('radar.risk-warnings.v1');
    if (ledger && (typeof ledger !== 'object' || Array.isArray(ledger) || Object.keys(ledger).length > 1000)) throw new Error('雷达风险记录损坏，请保留本机数据核对');
    for (const [id, value] of Object.entries(ledger || {})) {
      const split = id.indexOf(':'); let identity;
      try { identity = this.identity(id.slice(0, split), id.slice(split + 1)); } catch { throw new Error('雷达风险记录损坏，请保留本机数据核对'); }
      const risk = this.cleanRisk(value);
      if (identity.id !== id || !risk.flags.length) throw new Error('雷达风险记录损坏，请保留本机数据核对');
      this.riskLedger[id] = risk;
    }
    const cache = store.getMeta('radar.cache.v1');
    for (const chain of ['bnb', 'solana']) this.cache[chain] = (Array.isArray(cache?.[chain]) ? cache[chain] : []).slice(0, 30).map(t => this.cleanToken(t, chain)).filter(Boolean);
    const watches = store.getMeta('radar.watch.v1');
    for (const entry of Object.values(watches || {}).slice(0, 100)) {
      const token = this.cleanToken(entry?.token, entry?.token?.chain);
      if (token) this.watches[token.id] = { token, note: this.publicText(entry.note, 1000), addedAt: safeNumber(entry.addedAt) || this.now() };
    }
    const seen = store.getMeta('radar.seen.v1');
    for (const [id, at] of Object.entries(seen || {}).slice(-1000)) if (typeof id === 'string' && id.length < 100 && safeNumber(at)) this.firstSeen[id] = at;
    // Migrate warnings from cache created before the separate exclusion ledger.
    for (const token of [...this.cache.bnb, ...this.cache.solana, ...Object.values(this.watches).map(w => w.token)]) {
      if (token.risk.flags.length) {
        if (!this.riskLedger[token.id] && Object.keys(this.riskLedger).length >= 1000) throw new Error('雷达风险记录已满，请保留本机数据核对');
        this.riskLedger[token.id] = this.cleanRisk({ ...token.risk, flags: [...new Set([...(this.riskLedger[token.id]?.flags || []), ...token.risk.flags])] });
      }
      if (this.riskLedger[token.id]) token.risk = clone(this.riskLedger[token.id]);
    }
    if (Object.keys(this.riskLedger).length) this.store.setMeta('radar.risk-warnings.v1', this.riskLedger);
    // Restart shows timestamped cache only. Unlocking the vault never starts scanning.
    this.enabled = false; this.busy = false; this.revision = 0; this.controller = null;
    this.lastError = null; this.lastAttemptAt = 0; this.timer = null; this.notice = '';
  }
  publicText(value, length) { return text(this.vault.redact ? this.vault.redact(text(value, length)) : value, length); }
  identity(chain, address) {
    if (!['bnb', 'solana'].includes(chain)) throw fail('雷达链名称无效');
    const normalized = normalizeWalletAddress(chain, address);
    return { chain, address: normalized, id: `${chain}:${normalized}` };
  }
  cleanRisk(risk) {
    const flags = Array.isArray(risk?.flags) ? risk.flags.slice(0, 20).map(s => this.publicText(s, 160)).filter(Boolean) : [];
    return { status: flags.length ? 'flagged' : 'unknown', flags,
      checkedAt: safeNumber(risk?.checkedAt), source: this.publicText(risk?.source || '尚未查询合约风险报告', 100),
      unknowns: Array.isArray(risk?.unknowns) ? risk.unknowns.slice(0, 20).map(s => this.publicText(s, 160)).filter(Boolean) : unknownRisk().unknowns };
  }
  cleanToken(token, chain) {
    if (!token || typeof token !== 'object' || token.chain !== chain) return null;
    let identity; try { identity = this.identity(chain, token.address); } catch { return null; }
    return { ...identity, name: this.publicText(token.name, 100), symbol: this.publicText(token.symbol, 32),
      priceUsd: safeNumber(token.priceUsd), liquidityUsd: safeNumber(token.liquidityUsd), marketCapUsd: safeNumber(token.marketCapUsd),
      volume5mUsd: safeNumber(token.volume5mUsd), holders: Number.isSafeInteger(token.holders) && token.holders >= 0 ? token.holders : null,
      createdAt: safeNumber(token.createdAt), sourceUpdatedAt: safeNumber(token.sourceUpdatedAt), observedAt: safeNumber(token.observedAt),
      poolAddress: this.publicText(token.poolAddress, 100), aveUrl: `https://ave.ai/token/${identity.address}-${chain === 'bnb' ? 'bsc' : 'solana'}`,
      risk: this.cleanRisk(token.risk || unknownRisk()), conflict: token.conflict === true };
  }
  persistCache() { this.store.setMeta('radar.cache.v1', this.cache); this.store.setMeta('radar.seen.v1', this.firstSeen); }
  persistWatches() { this.store.setMeta('radar.watch.v1', this.watches); }
  snapshot() {
    const walletStatus = this.vault.publicStatus(), configured = Boolean(walletStatus.aveConfigured);
    const locked = configured && !this.vault.getAveCredentials();
    const gate = this.budget.check(this.settings), now = this.now(), chain = this.settings.chain;
    const tokens = this.cache[chain].map(token => ({ ...clone(token),
      decision: filterRadarToken(token, this.settings, now), watched: Boolean(this.watches[token.id]),
      note: this.watches[token.id]?.note || '', eventId: `${token.id}:${this.firstSeen[token.id] || token.observedAt || 0}` }));
    // Watched rows no longer present in the top30 remain visible as timestamped cache.
    for (const watch of Object.values(this.watches)) if (watch.token.chain === chain && !tokens.some(t => t.id === watch.token.id)) {
      tokens.push({ ...clone(watch.token), decision: filterRadarToken(watch.token, this.settings, now), watched: true, note: watch.note,
        eventId: `${watch.token.id}:${this.firstSeen[watch.token.id] || watch.token.observedAt || 0}` });
    }
    const counts = { candidate: 0, excluded: 0, insufficient: 0 };
    for (const token of tokens) counts[token.decision.status]++;
    let status = this.enabled ? 'monitoring' : 'stopped', reason = this.enabled ? '已开启只读轮询' : '自动扫描已关闭；重启后需手动开启';
    if (!configured) { status = 'unconfigured'; reason = '请先配置 AVE API Key；没有生成模拟代币'; }
    else if (locked) { status = 'locked'; reason = 'AVE Key 已加密保存，请先解锁本机保险库'; }
    else if (this.busy) { status = 'loading'; reason = '正在读取 AVE 数据'; }
    else if (this.lastError) { status = 'error'; reason = this.lastError; }
    else if (!gate.allowed) { status = 'cooldown'; reason = gate.reason; }
    return { settings: clone(this.settings), enabled: this.enabled, configured, locked, status, reason,
      notice: this.notice, updatedAt: Math.max(0, ...this.cache[chain].map(t => t.observedAt || 0)) || null,
      nextRequestAt: gate.nextAt, usage: this.budget.usage(), budgetWindow: 'rolling-hour-and-24h', tokens, counts, lastError: this.lastError };
  }
  saveSettings(patch) {
    const next = validateRadarSettings(patch, this.settings);
    this.settings = next; this.revision++; this.controller?.abort(); this.lastError = null;
    this.store.setMeta('radar.settings.v1', next);
    return this.snapshot();
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw fail('雷达开关格式无效');
    if (!enabled) { this.enabled = false; this.revision++; this.controller?.abort(); return this.snapshot(); }
    if (!this.vault.getAveCredentials()) throw fail('请先保存并解锁 AVE API Key');
    this.enabled = true; this.notice = '';
    return this.refresh({ automatic: true });
  }
  credentialsChanged() {
    this.enabled = false; this.revision++; this.controller?.abort(); this.lastError = null;
    this.notice = '凭证已变更或保险库已锁定；自动扫描已关闭，预算及冷却保留';
    return this.snapshot();
  }
  async request(action, { automatic = false } = {}) {
    if (this.busy || (automatic && !this.enabled)) return false;
    const credentials = this.vault.getAveCredentials();
    if (!credentials) throw fail('AVE Key 尚未配置或保险库未解锁');
    const gate = this.budget.reserve(this.settings);
    if (!gate.allowed) { this.notice = gate.reason; return false; }
    const revision = this.revision, controller = new AbortController();
    this.controller = controller; this.busy = true; this.lastError = null; this.lastAttemptAt = this.now();
    try {
      const result = await action({ apiKey: credentials.apiKey, signal: controller.signal });
      if (revision !== this.revision || controller.signal.aborted || !this.vault.getAveCredentials()) return false;
      return result;
    } catch (error) {
      if (revision !== this.revision || controller.signal.aborted) return false;
      // Do not publish provider bodies, arbitrary exception text or request credentials.
      const code = String(error?.code || '');
      if (['RATE_LIMIT', 'AVE_RATE_LIMIT', '429'].includes(code) || error?.status === 429) {
        this.budget.backoff(error.retryAfterMs); this.lastError = 'AVE 限流，已持久保存退避时间';
      } else if (['AUTH', 'AVE_AUTH', 'UNAUTHORIZED', 'FORBIDDEN'].includes(code) || [401, 403].includes(error?.status)) {
        this.enabled = false; this.lastError = 'AVE 鉴权或套餐权限失败，自动扫描已关闭，请核对账户';
      } else if (code === 'AVE_REJECTED') {
        this.enabled = false; this.lastError = 'AVE 明确拒绝请求，自动扫描已关闭，请核对接口、凭证及套餐';
      } else { this.lastError = 'AVE 数据请求失败或格式无效；保留原缓存与冷却，请稍后核对'; }
      return false;
    } finally { this.busy = false; if (this.controller === controller) this.controller = null; }
  }
  async refresh({ automatic = false } = {}) {
    const chain = this.settings.chain;
    const result = await this.request(args => this.client.ranks({ ...args, chain }), { automatic });
    if (Array.isArray(result)) {
      const unique = new Map();
      for (const item of result.slice(0, 300)) {
        const token = this.cleanToken(item, chain); if (!token) continue;
        const prior = unique.get(token.id);
        if (prior) {
          const marketFields = value => { const { risk, conflict, ...market } = value; return market; };
          if (JSON.stringify(marketFields(prior)) !== JSON.stringify(marketFields(token))) prior.conflict = true;
          continue;
        }
        if (unique.size >= 30) continue;
        // Rank data never overwrites a separately obtained contract-risk warning.
        const previous = this.cache[chain].find(t => t.id === token.id) || this.watches[token.id]?.token;
        token.risk = this.riskLedger[token.id] ? clone(this.riskLedger[token.id]) : previous?.risk ? clone(previous.risk) : unknownRisk();
        if (!this.firstSeen[token.id]) this.firstSeen[token.id] = this.now();
        unique.set(token.id, token);
      }
      this.cache[chain] = [...unique.values()];
      for (const token of this.cache[chain]) if (this.watches[token.id]) this.watches[token.id].token = clone(token);
      this.firstSeen = Object.fromEntries(Object.entries(this.firstSeen).sort((a,b) => a[1]-b[1]).slice(-1000));
      this.persistCache(); this.persistWatches(); this.notice = result.length ? '行情已更新；通过行情筛选仍不代表安全' : 'AVE 本次返回空榜单';
    }
    return this.snapshot();
  }
  findToken(chain, address) {
    const identity = this.identity(chain, address);
    const token = this.cache[chain].find(t => t.id === identity.id) || this.watches[identity.id]?.token;
    if (!token) throw fail('请只查询已扫描或已收藏的代币');
    return token;
  }
  async checkRisk({ chain, address } = {}) {
    const token = this.findToken(chain, address);
    if (!this.riskLedger[token.id] && Object.keys(this.riskLedger).length >= 1000) throw fail('本机风险记录已满，已停止新增查询；请保留数据核对');
    const result = await this.request(args => this.client.contracts({ ...args, chain, address: token.address }));
    if (result && typeof result === 'object') {
      const risk = this.cleanRisk(result);
      // An unknown/unsupported response cannot erase an earlier explicit warning.
      risk.flags = [...new Set([...(this.riskLedger[token.id]?.flags || []), ...token.risk.flags, ...risk.flags])]; risk.status = risk.flags.length ? 'flagged' : 'unknown';
      if (token.risk.flags.length && !result.flags?.length) risk.unknowns.push('历史风险警示保留，当前报告未证明已解除');
      token.risk = risk;
      if (risk.flags.length) { this.riskLedger[token.id] = clone(risk); this.store.setMeta('radar.risk-warnings.v1', this.riskLedger); }
      for (const candidate of this.cache[chain]) if (candidate.id === token.id) candidate.risk = clone(risk);
      if (this.watches[token.id]) this.watches[token.id].token.risk = clone(risk);
      this.persistCache(); this.persistWatches(); this.notice = '合约报告已读取；无已知警示仍不是安全认证';
    }
    return this.snapshot();
  }
  toggleWatch({ chain, address, note } = {}) {
    const token = this.findToken(chain, address);
    if (note !== undefined && (typeof note !== 'string' || note.length > 1000)) throw fail('观察备注最多1000字');
    if (note === undefined && this.watches[token.id]) delete this.watches[token.id];
    else {
      if (!this.watches[token.id] && Object.keys(this.watches).length >= 100) throw fail('最多收藏100个观察代币');
      this.watches[token.id] = { token: clone(token), note: note === undefined ? '' : this.publicText(note, 1000), addedAt: this.watches[token.id]?.addedAt || this.now() };
    }
    this.persistWatches(); return this.snapshot();
  }
  async tick() {
    if (!this.enabled || this.busy || this.now() - this.lastAttemptAt < this.settings.pollIntervalMs) return;
    if (!this.vault.getAveCredentials() || !this.budget.check(this.settings).allowed) return;
    await this.refresh({ automatic: true });
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { void this.tick().catch(() => { this.enabled = false; this.lastError = '雷达后台读取异常，自动扫描已关闭'; }); }, 10000); this.timer.unref?.(); } return this; }
  stop() { clearInterval(this.timer); this.timer = null; this.enabled = false; this.revision++; this.controller?.abort(); }
}
