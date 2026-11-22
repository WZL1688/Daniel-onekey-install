import { DiscoveryClient } from './sources.mjs';
import { normalizeAsset, validAddress, validId, decimals, registryConflictIds, sameAddress, publicText, opportunityError as fail } from './registry.mjs';
import { classifyAsset, qualifyMarkets } from './universe.mjs';
import { mergeContractCatalogs, normalizeContractCatalog } from './catalogs.mjs';

const DAY = 86400000, DIRECTORY_GAP = 6 * 3600000, FRESH_MS = 120000;
const clone = value => structuredClone(value);
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const DEFAULT_OPPORTUNITY_SETTINGS = Object.freeze({ pollIntervalMs: 60000, minLiquidityUsd: 20000, minSpreadBps: 50, maxAssetsPerScan: 30, maxRequestsPerDay: 5000,
  includeStablecoins: false, includeMajors: false, minVolume24hUsd: 10000, minVolume1hUsd: 100, minTrades1h: 3, maxSideSkewMs: 30000, maxSpreadBps: 3000 });

function validateSettings(patch, previous = DEFAULT_OPPORTUNITY_SETTINGS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('机会扫描设置格式无效');
  const rules = { pollIntervalMs: [30000, 3600000, true], minLiquidityUsd: [0, 1e12], minSpreadBps: [0, 1000000], maxAssetsPerScan: [1, 100, true], maxRequestsPerDay: [1, 20000, true],
    minVolume24hUsd: [0, 1e15], minVolume1hUsd: [0, 1e15], minTrades1h: [0, 1e9, true], maxSideSkewMs: [1000, 120000, true], maxSpreadBps: [1, 1000000] };
  const out = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (['includeStablecoins','includeMajors'].includes(key)) { if (typeof value !== 'boolean') throw fail('扫描范围开关须为布尔值'); out[key] = value; continue; }
    if (!Object.hasOwn(rules, key)) throw fail('机会扫描设置包含不支持的字段');
    const [min, max, integer] = rules[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw fail(`机会扫描参数 ${key} 超出允许范围`);
    out[key] = value;
  }
  if (out.minSpreadBps > out.maxSpreadBps) throw fail('最低价差不能高于异常价差上限');
  return out;
}

// All instances using this SQLite file share the same pre-dispatch reservations.
class RequestBudget {
  constructor(store, now) { this.store = store; this.now = now; this.read(); }
  read() {
    const state = this.store.getMeta('opportunities.budget.v1') || { total: 0, requests: [], lastClock: 0, nextAt: 0, directoryNextAt: 0 };
    if (!safeTime(state.total) || !safeTime(state.lastClock) || !safeTime(state.nextAt) || !safeTime(state.directoryNextAt) || !Array.isArray(state.requests) || state.requests.length > 20001 || !state.requests.every(safeTime)) throw new Error('机会扫描请求预算记录损坏，请保留本机数据核对');
    return state;
  }
  check(settings, kind = 'pools') {
    const state = this.read(), now = this.now(), at = Math.max(now, state.lastClock);
    const requests = state.requests.filter(t => t > at - DAY), minute = requests.filter(t => t > at - 60000);
    const usage = { day: requests.length, total: state.total };
    if (now < state.lastClock) return { allowed: false, kind: 'clock', reason: '系统时钟回退，机会扫描暂停请求', nextAt: state.lastClock, usage };
    if (requests.length >= settings.maxRequestsPerDay) return { allowed: false, kind: 'budget', reason: '达到最近24小时本机请求预算', nextAt: requests.slice().sort((a,b)=>a-b)[requests.length - settings.maxRequestsPerDay] + DAY, usage };
    if (minute.length >= 30) return { allowed: false, kind: 'rate', reason: '达到本机每分钟30次请求限制', nextAt: minute.slice().sort((a,b)=>a-b)[minute.length - 30] + 60000, usage };
    if (kind === 'directory' && now < state.directoryNextAt) return { allowed: false, kind: 'directory', reason: '同币目录请求冷却中，将按数据源状态自动重试', nextAt: state.directoryNextAt, usage };
    if (now < state.nextAt) return { allowed: false, kind: 'gap', reason: '数据源请求冷却中', nextAt: state.nextAt, usage };
    return { allowed: true, nextAt: now, usage };
  }
  reserve(settings, kind) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const gate = this.check(settings, kind);
      if (gate.allowed) {
        const state = this.read(), at = this.now();
        this.store.setMeta('opportunities.budget.v1', { total: state.total + 1, requests: [...state.requests.filter(t => t > at - DAY), at], lastClock: at, nextAt: at + 1000, directoryNextAt: kind === 'directory' ? at + 60000 : state.directoryNextAt });
      }
      this.store.db.exec('COMMIT'); return gate;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  backoff(ms) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read(), at = Math.max(this.now(), state.lastClock);
      state.nextAt = Math.max(state.nextAt, at + Math.min(DAY, Math.max(60000, Number.isFinite(ms) ? ms : 60000)));
      this.store.setMeta('opportunities.budget.v1', state); this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  directoryNext(at) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const state = this.read(); state.directoryNextAt = Math.max(0, Math.floor(at || 0)); this.store.setMeta('opportunities.budget.v1', state); this.store.db.exec('COMMIT'); }
    catch(error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}

export class OpportunityService {
  constructor({ store, getConfig = () => store.config, client = new DiscoveryClient(), network = null, vault = null, bundledCandidates = [], now = Date.now, sleep = wait } = {}) {
    this.store = store; this.getConfig = getConfig; this.client = client; this.vault = vault; this.bundledCandidates = bundledCandidates; this.now = now; this.sleep = sleep;
    this.network = network; this.networkTesting = false; this.networkChanging = false;
    this.networkDiagnostics = []; this.lastNetworkTestAt = null;
    const networkCooldown = store.getMeta('opportunities.network-test.v1')?.nextAt;
    this.nextNetworkTestAt = safeTime(networkCooldown) ? networkCooldown : null;
    this.settings = validateSettings(store.getMeta('opportunities.settings.v1') || {});
    this.budget = new RequestBudget(store, now); this.assets = new Map(); this.markets = {}; this.evaluations = {}; this.contractCatalogs = {};
    const savedCatalogs = store.getMeta('opportunities.contract-catalogs.v1');
    for (const chain of ['bnb','solana']) {
      const cache = savedCatalogs?.[chain];
      if (safeTime(cache?.observedAt) && Array.isArray(cache.entries) && cache.entries.length <= 50000) try {
        this.contractCatalogs[chain] = { observedAt: cache.observedAt, entries: normalizeContractCatalog(cache.entries.map(row => ({ id: row?.coinId, address: row?.address })), { chain }) };
      } catch { /* A damaged reference cache is re-read; request accounting is retained. */ }
    }
    const saved = store.getMeta('opportunities.registry.v1');
    if (saved && (!Array.isArray(saved) || saved.length > 400)) throw new Error('同币清单损坏，请保留本机数据核对');
    for (const entry of saved || []) {
      try {
        const asset = normalizeAsset(entry, { previous: entry, now: this.now(), directory: entry.source !== 'manual' });
        asset.revision = Number.isSafeInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1;
        asset.createdAt = safeTime(entry.createdAt) ? entry.createdAt : this.now();
        asset.updatedAt = safeTime(entry.updatedAt) ? entry.updatedAt : this.now();
        asset.sourceObservedAt = safeTime(entry.sourceObservedAt) ? entry.sourceObservedAt : null;
        this.assets.set(asset.id, asset);
      } catch { throw new Error('同币清单损坏，请保留本机数据核对'); }
    }
    const cached = store.getMeta('opportunities.market.v1');
    if (cached && typeof cached === 'object' && !Array.isArray(cached)) for (const [id, market] of Object.entries(cached).slice(0, 400)) if (this.assets.has(id)) {
      const cleaned = {};
      for (const chain of ['bnb', 'solana']) { const pool = this.cleanPool(market?.[chain], chain, [this.assets.get(id).chains[chain].address]); if (pool) cleaned[chain] = pool; }
      const generation = publicText(market?.generation, 80); this.markets[id] = { ...cleaned, generation };
    }
    this.directoryUpdatedAt = number(store.getMeta('opportunities.directory-updated.v1'));
    this.enabled = false; this.busy = false; this.revision = 0; this.cursor = 0; this.timer = null; this.controller = null;
    this.lastError = ''; this.notice = ''; this.lastAttemptAt = 0; this.lastScanFailed = false;
    this.directoryState = store.getMeta('opportunities.directory-state.v2') || { sources: {}, lastSuccessAt: this.directoryUpdatedAt, source: null, foundCount: 0 };
    if (!this.directoryState || typeof this.directoryState !== 'object' || !this.directoryState.sources || typeof this.directoryState.sources !== 'object') throw new Error('目录连接状态损坏，请保留本机数据核对');
    this.poolError = null; this.directoryError = null; this.syncErrors();
    this.autoScanPreferred = store.getMeta('opportunities.auto-scan.v2')?.enabled !== false;
    this.scanProgress = store.getMeta('opportunities.scan-progress.v2') || { totalAssets: 0, scannedAssets: 0, withBothMarkets: 0, opportunities: 0, lastScanAt: null };
    // v1.4 reserved six hours even for failed requests. Migrate that local
    // failure cooldown without touching the request ledger or provider backoff.
    const previousBudget = this.budget.read();
    if (!store.getMeta('opportunities.directory-state.v2') && !this.directoryUpdatedAt && previousBudget.directoryNextAt > this.now() + 300000) this.budget.directoryNext(this.now());
    if (typeof client.contracts === 'function' && !store.getMeta('opportunities.altcoin-catalog.v1')) {
      // Existing source-specific Retry-After and the shared request ledger remain
      // binding. Only release the old success-cache gate for the new provider.
      this.budget.directoryNext(this.now()); store.setMeta('opportunities.altcoin-catalog.v1', { enabled: true });
    }
  }
  persistRegistry() { this.store.setMeta('opportunities.registry.v1', [...this.assets.values()]); }
  persistDirectory() { this.store.setMeta('opportunities.directory-state.v2', this.directoryState); }
  refreshDirectoryGate({ fallback = true } = {}) {
    const required = ['coingecko', ...(typeof this.client.contracts === 'function' ? ['coinpaprika-bnb','coinpaprika-solana'] : []), ...(fallback && typeof this.client.discoverWrapped === 'function' ? ['wormhole'] : [])];
    const paprikaRetry = Math.max(0, ...Object.entries(this.directoryState.sources).filter(([source,state]) => source.startsWith('coinpaprika-') && state?.errorCode === 'DISCOVERY_RATE_LIMIT').map(([,state]) => state.nextAttemptAt || 0));
    const next = required.map(source => Math.max(this.now(), this.directoryState.sources[source]?.nextAttemptAt || 0, source.startsWith('coinpaprika-') ? paprikaRetry : 0));
    this.budget.directoryNext(next.length ? Math.min(...next) : this.now());
  }
  syncErrors() {
    const sources = this.directoryState.sources;
    this.directoryError = sources.coingecko?.status === 'ready' && !Object.values(sources).some(source => source?.errorCode) ? null : Object.values(sources).filter(source => source?.errorCode).sort((a,b)=>(b.lastAttemptAt || 0)-(a.lastAttemptAt || 0))[0] || null;
    this.lastError = this.poolError?.message || this.directoryError?.message || '';
  }
  directorySnapshot() {
    const sources = ['coingecko','coinpaprika-bnb','coinpaprika-solana','coinpaprika','wormhole','project'].map(source => ({ source, ...(this.directoryState.sources[source] || { status: 'idle', nextAttemptAt: 0, foundCount: 0 }) }));
    const active = sources.filter(source => source.status !== 'idle'), attempts = active.map(source => source.lastAttemptAt || 0);
    const error = this.directoryError;
    const foundCount = [...this.assets.values()].filter(asset => asset.source !== 'manual').length;
    return { status: this.currentStage === 'directory' ? 'loading' : foundCount ? 'ready' : error ? error.status === 'auth_required' ? 'auth_required' : 'retrying' : this.directoryUpdatedAt ? 'empty' : 'idle',
      lastAttemptAt: Math.max(0, ...attempts) || null, lastSuccessAt: this.directoryUpdatedAt, nextAttemptAt: this.budget.read().directoryNextAt || null,
      errorCode: error?.errorCode || null, errorMessage: error?.message || '', source: this.directoryState.source,
      sourceDate: this.directoryState.source?.includes('wormhole') ? '2026-04-08' : this.directoryState.source === 'project' ? '2026-11-22' : null,
      foundCount, sourceAttempts: sources };
  }
  importCandidates(candidates, { bundled = false } = {}) {
    let changed = false, metadataChanged = false;
    const prioritized = candidates.slice().sort((a,b) => Number(classifyAsset(b, this.settings).eligible) - Number(classifyAsset(a, this.settings).eligible));
    for (const item of prioritized.slice(0, bundled ? 100 : 300)) {
      let incoming;
      try {
        const clean = { ...item, name: this.vault?.redact ? this.vault.redact(item.name || '') : item.name, symbol: this.vault?.redact ? this.vault.redact(item.symbol || '') : item.symbol };
        incoming = normalizeAsset(clean, { now: this.now(), directory: true });
        if (safeTime(item.observedAt) && item.observedAt <= this.now() + 1000) incoming.sourceObservedAt = item.observedAt;
      } catch { continue; }
      const previous = this.assets.get(incoming.id);
      if (!previous) {
        const duplicate = [...this.assets.values()].find(asset => ['bnb','solana'].every(chain => sameAddress(chain, asset.chains[chain].address, incoming.chains[chain].address)));
        if (duplicate) continue;
        const cap = ['coingecko','coinpaprika'].includes(incoming.source) ? 200 : 100;
        if ([...this.assets.values()].filter(asset => asset.source === incoming.source).length >= cap || this.assets.size >= 400) continue;
        this.assets.set(incoming.id, incoming); changed = true;
      } else if (!bundled) {
        const addressesChanged = ['bnb','solana'].some(chain => !sameAddress(chain, previous.chains[chain].address, incoming.chains[chain].address));
        if (addressesChanged) {
          previous.mapping.confirmed = false; previous.mapping.evidence = ''; previous.mapping.warning = '外部目录地址已变化；原地址保留，请编辑并重新核验';
          previous.sourceProposal = { bnb: incoming.chains.bnb.address, solana: incoming.chains.solana.address };
          previous.revision++; previous.updatedAt = this.now(); delete this.evaluations[previous.id]; changed = true;
        }
        if (previous.sourceObservedAt !== incoming.sourceObservedAt) { previous.sourceObservedAt = incoming.sourceObservedAt; metadataChanged = true; }
      }
    }
    if (changed) { this.revision++; this.evaluations = {}; this.persistRegistry(); }
    else if (metadataChanged) this.persistRegistry();
    return changed;
  }
  seedBundled({ augment = false } = {}) {
    if ((!this.assets.size || augment) && this.bundledCandidates.length) {
      const before = this.assets.size;
      this.importCandidates(this.bundledCandidates, { bundled: true });
      if (!this.directoryState.source && this.assets.size > before) this.directoryState.source = this.bundledCandidates.some(row => row.source === 'project') ? 'project' : 'bundled-wormhole';
      const projectCount = [...this.assets.values()].filter(row => row.source === 'project').length;
      if (projectCount) this.directoryState.sources.project = { source: 'project', status: 'ready', foundCount: projectCount, lastSuccessAt: this.now(), nextAttemptAt: 0 };
      this.directoryState.foundCount = [...this.assets.values()].filter(asset => asset.source !== 'manual').length;
      this.persistDirectory();
      if (this.assets.size > before) this.notice = `已载入 ${this.assets.size - before} 组官方映射快照候选；行情仍需联网，交易映射尚未核验`;
    }
  }
  credentialsChanged() {
    this.invalidate();
    const previous = this.directoryState.sources.coingecko;
    const preserveRate = previous?.errorCode === 'DISCOVERY_RATE_LIMIT' && previous.nextAttemptAt > this.now();
    if (!preserveRate) delete this.directoryState.sources.coingecko;
    this.directoryError = null; this.syncErrors();
    const times = Object.values(this.directoryState.sources).map(source => source.nextAttemptAt).filter(at => Number.isFinite(at) && at > this.now());
    this.budget.directoryNext(preserveRate && times.length ? Math.min(...times) : this.now()); this.persistDirectory();
    this.notice = '数据源凭证已更新；请求计数和限流退避保留，交易开关未改变';
    return this.snapshot();
  }
  networkSnapshot() {
    return { ...(this.network?.snapshot?.() || { mode: 'auto', proxyUrl: '', effectiveRoute: 'direct', proxyDetected: false, routeLabel: '默认连接' }),
      diagnostics: clone(this.networkDiagnostics), testing: this.networkTesting, lastTestAt: this.lastNetworkTestAt, nextTestAt: this.nextNetworkTestAt };
  }
  async saveNetworkSettings(patch) {
    if (!this.network?.saveSettings) throw fail('网络设置服务未启用，请更新并重启程序');
    if (this.networkChanging) throw fail('网络设置正在保存，请稍候');
    this.networkChanging = true;
    try {
      this.invalidate(); await this.pendingJob;
      this.networkDiagnostics = []; this.lastNetworkTestAt = null;
      await this.network.saveSettings(patch);
      const transportError = value => ['DISCOVERY_NETWORK','DISCOVERY_TIMEOUT','DISCOVERY_ABORTED'].includes(value?.errorCode);
      if (transportError(this.poolError)) this.poolError = null;
      for (const [source, state] of Object.entries(this.directoryState.sources)) if (transportError(state)) delete this.directoryState.sources[source];
      this.refreshDirectoryGate();
      this.persistDirectory(); this.syncErrors(); this.networkDiagnostics = []; this.lastNetworkTestAt = null; this.lastAttemptAt = 0;
      this.notice = '数据源网络设置已保存；自动扫描将使用新连接，请求计数和限流冷却保留';
      return this.snapshot();
    } finally { this.networkChanging = false; }
  }
  async testNetwork() {
    if (this.networkChanging) throw fail('网络设置正在保存，请稍候检测');
    if (this.networkTesting) return this.snapshot();
    if (this.nextNetworkTestAt > this.now()) throw fail('连接检测冷却中，请等待一分钟后重试');
    this.networkTesting = true;
    try {
      this.revision++; this.cancelGeneration = (this.cancelGeneration || 0) + 1; this.controller?.abort();
      const revision = this.revision;
      await this.pendingJob;
      if (revision !== this.revision || this.networkChanging) return this.snapshot();
      await this.job(async context => {
        this.networkDiagnostics = [];
        const targets = [
          { source: 'bnb-pools', run: signal => this.client.pools({ chain: 'bnb', addresses: ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'], signal }) },
          { source: 'solana-pools', run: signal => this.client.pools({ chain: 'solana', addresses: ['So11111111111111111111111111111111111111112'], signal }) },
          { source: 'coingecko-directory', run: signal => this.client.discover({ signal, apiKey: this.vault?.getCoinGeckoCredentials?.()?.apiKey }) }
        ];
        for (const target of targets) {
          if (context.signal.aborted || context.revision !== this.revision) return;
          const sourceState = target.source === 'coingecko-directory' ? this.directoryState.sources.coingecko : null;
          const retry = sourceState?.errorCode === 'DISCOVERY_RATE_LIMIT' && sourceState.nextAttemptAt > this.now();
          let gate = retry ? { allowed: false, reason: 'CoinGecko 限流冷却中', nextAt: sourceState.nextAttemptAt } : this.budget.reserve(this.settings, 'pools');
          if (!gate.allowed && gate.kind === 'gap' && gate.nextAt - this.now() <= 1000) {
            await this.sleep(Math.max(0, gate.nextAt - this.now()));
            if (context.signal.aborted || context.revision !== this.revision) return;
            gate = this.budget.reserve(this.settings, 'pools');
          }
          const diagnostic = { source: target.source, status: 'error', httpStatus: null, errorCode: null, networkReason: null, message: '', records: null, checkedAt: this.now() };
          if (!gate.allowed) {
            diagnostic.status = 'rate_limited'; diagnostic.errorCode = 'DISCOVERY_RATE_LIMIT'; diagnostic.message = gate.reason;
            this.networkDiagnostics.push(diagnostic); continue;
          }
          this.nextNetworkTestAt = this.now() + 60000;
          this.store.setMeta('opportunities.network-test.v1', { nextAt: this.nextNetworkTestAt });
          this.lastAttemptAt = this.now();
          try {
            const result = await target.run(context.signal);
            if (context.signal.aborted || context.revision !== this.revision) return;
            diagnostic.status = Array.isArray(result) && result.length ? 'ok' : 'empty'; diagnostic.httpStatus = 200;
            diagnostic.records = Array.isArray(result) ? result.length : 0;
            diagnostic.message = diagnostic.status === 'ok' ? '接口已响应并返回有效记录' : '接口已响应，但没有符合条件的记录';
          } catch (error) {
            if (context.signal.aborted || context.revision !== this.revision) return;
            const code = ['DISCOVERY_RATE_LIMIT','DISCOVERY_AUTH','DISCOVERY_REJECTED','DISCOVERY_TIMEOUT','DISCOVERY_UNAVAILABLE','DISCOVERY_FORMAT','DISCOVERY_CREDENTIALS','DISCOVERY_ABORTED','DISCOVERY_NETWORK'].includes(error?.code) ? error.code : 'DISCOVERY_NETWORK';
            diagnostic.errorCode = code;
            diagnostic.httpStatus = Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null;
            diagnostic.networkReason = ['DNS','TIMEOUT','CONNECTION','TLS','PROXY','NETWORK'].includes(error?.networkReason) ? error.networkReason : code === 'DISCOVERY_TIMEOUT' ? 'TIMEOUT' : null;
            diagnostic.status = code === 'DISCOVERY_RATE_LIMIT' ? 'rate_limited' : ['DISCOVERY_AUTH','DISCOVERY_REJECTED'].includes(code) ? 'auth_required' : 'error';
            diagnostic.message = ({ DISCOVERY_RATE_LIMIT: '接口限流，请等待冷却', DISCOVERY_AUTH: '接口要求有效凭证或权限', DISCOVERY_REJECTED: '接口拒绝请求', DISCOVERY_TIMEOUT: '连接超时', DISCOVERY_UNAVAILABLE: '数据源暂时不可用', DISCOVERY_FORMAT: '响应格式无效' })[code] || '数据源连接失败';
            if (code === 'DISCOVERY_RATE_LIMIT') {
              if (target.source === 'coingecko-directory') {
                const previous = this.directoryState.sources.coingecko || {};
                this.directoryState.sources.coingecko = { ...previous, source: 'coingecko', status: 'retrying', errorCode: code, message: diagnostic.message,
                  lastAttemptAt: this.now(), nextAttemptAt: Math.max(previous.nextAttemptAt || 0, this.now() + Math.min(DAY, Math.max(60000, error.retryAfterMs || 60000))) };
                this.persistDirectory();
              } else this.budget.backoff(error.retryAfterMs);
            }
          }
          diagnostic.checkedAt = this.now(); this.networkDiagnostics.push(diagnostic);
        }
        this.lastNetworkTestAt = this.now();
        this.notice = '只读连接检测完成；检测不会导入代币、核验映射或执行交易';
      }, 'network');
    } finally { this.networkTesting = false; }
    return this.snapshot();
  }
  invalidate() {
    this.revision++; this.cancelGeneration = (this.cancelGeneration || 0) + 1; this.evaluations = {}; this.controller?.abort();
    for (const source of Object.values(this.directoryState.sources)) if (source.status === 'loading') source.status = source.errorCode ? 'retrying' : 'idle';
    this.persistDirectory(); this.syncErrors();
  }
  saveSettings(patch) { this.settings = validateSettings(patch, this.settings); this.store.setMeta('opportunities.settings.v1', this.settings); this.invalidate(); return this.snapshot(); }
  saveAsset(input) {
    const previous = input?.id ? this.assets.get(validId(input.id)) : undefined;
    if (input?.id && !previous && !input.id.startsWith('manual:')) throw fail('请先发现目录条目或创建手工条目');
    if (previous && input.revision !== undefined && input.revision !== previous.revision) throw fail('同币条目已变化，请刷新后再编辑');
    const next = normalizeAsset(input, { previous, now: this.now() });
    if (!previous && [...this.assets.values()].filter(a => a.source === 'manual').length >= 100) throw fail('最多保存100个手工同币条目');
    this.assets.set(next.id, next); delete this.markets[next.id]; this.invalidate(); this.persistRegistry(); return this.snapshot();
  }
  removeAsset(id) { validId(id); if (!this.assets.delete(id)) throw fail('同币条目不存在'); delete this.markets[id]; this.invalidate(); this.persistRegistry(); this.store.setMeta('opportunities.market.v1', this.markets); return this.snapshot(); }
  approveAsset({ id, revision, confirmed, evidence, chains } = {}) {
    const asset = this.assets.get(validId(id)); if (!asset) throw fail('同币条目不存在');
    if (confirmed === false) { asset.mapping.confirmed = false; asset.mapping.evidence = ''; asset.revision++; asset.updatedAt = this.now(); this.invalidate(); this.persistRegistry(); return this.snapshot(); }
    if (!Number.isSafeInteger(revision) || revision !== asset.revision) throw fail('同币条目已变化，请刷新后重新核验');
    if (confirmed !== true || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 1000) throw fail('请明确确认同币关系并填写1–1000字核验依据');
    if (!asset.enabled) throw fail('请先启用这个同币条目');
    if (asset.mapping.warning) throw fail('目录地址已变化，请先编辑并重新核对条目');
    if (registryConflictIds([...this.assets.values()]).has(id)) throw fail('同币清单存在重复链地址，请先处理冲突');
    const verified = {};
    for (const chain of ['bnb', 'solana']) {
      const supplied = chains?.[chain] || {};
      if (supplied.address !== undefined && !sameAddress(chain, validAddress(chain, supplied.address), asset.chains[chain].address)) throw fail('确认地址须与条目一致，请先编辑条目');
      verified[chain] = { address: asset.chains[chain].address, decimals: decimals(chain, supplied.decimals ?? asset.chains[chain].decimals), poolAddress: validAddress(chain, supplied.poolAddress ?? asset.chains[chain].poolAddress) };
    }
    asset.chains = verified; asset.mapping = { confirmed: true, evidence: publicText(evidence, 1000), warning: '' }; asset.sourceProposal = null;
    asset.revision++; asset.updatedAt = this.now(); this.invalidate(); this.persistRegistry(); return this.snapshot();
  }
  getApprovedAsset(id) {
    const asset = this.assets.get(validId(id));
    if (!asset || !asset.enabled || !asset.mapping.confirmed || !asset.mapping.evidence || asset.mapping.warning || registryConflictIds([...this.assets.values()]).has(id)) throw fail('该同币条目尚未完成核验、已停用或存在冲突');
    for (const chain of ['bnb', 'solana']) { decimals(chain, asset.chains[chain].decimals); validAddress(chain, asset.chains[chain].poolAddress); }
    return freeze(clone({ id: asset.id, name: asset.name, symbol: asset.symbol, revision: asset.revision, chains: asset.chains, mappingEvidence: asset.mapping.evidence }));
  }
  cleanPool(input, chain, requested) {
    if (!input || input.chain !== chain) return null;
    try {
      const tokenAddress = validAddress(chain, input.tokenAddress), poolAddress = validAddress(chain, input.poolAddress), quoteAddress = validAddress(chain, input.quoteAddress);
      if (!requested.some(a => sameAddress(chain, a, tokenAddress)) || !number(input.priceUsd) || !safeTime(input.observedAt) || input.observedAt > this.now() + 1000) return null;
      return { chain, tokenAddress, poolAddress, quoteAddress, priceUsd: number(input.priceUsd), liquidityUsd: number(input.liquidityUsd), volume24hUsd: number(input.volume24hUsd), volume1hUsd: number(input.volume1hUsd), trades1h: Number.isSafeInteger(input.trades1h) && input.trades1h >= 0 ? input.trades1h : null, observedAt: input.observedAt, sourceUpdatedAt: null, dexId: publicText(input.dexId, 40), safety: 'unverified' };
    } catch { return null; }
  }
  row(asset) {
    const market = this.markets[asset.id] || {}, reasons = [], now = this.now();
    const bnb = market.bnb || null, solana = market.solana || null;
    const universe = classifyAsset(asset, this.settings), quality = qualifyMarkets({ bnb, solana }, this.settings, now, Boolean(market.generation));
    if (!asset.enabled) reasons.push('条目已停用');
    if (asset.mapping.warning) reasons.push(asset.mapping.warning);
    if (registryConflictIds([...this.assets.values()]).has(asset.id)) reasons.push('同币清单链地址冲突');
    for (const chain of ['bnb','solana']) if (asset.mapping.confirmed && market[chain] && !sameAddress(chain, asset.chains[chain].poolAddress, market[chain].poolAddress)) reasons.push(`${chain} 行情池与已确认池不一致`);
    if (this.lastScanFailed) reasons.push('最新扫描未完成，等待成功扫描');
    const marketQualified = quality.qualified && reasons.length === 0;
    reasons.push(...universe.reasons, ...quality.reasons);
    let buyChain = null, sellChain = null, spreadBps = null, indicativeGrossUsd = null;
    if (bnb && solana && market.generation) {
      buyChain = bnb.priceUsd <= solana.priceUsd ? 'bnb' : 'solana'; sellChain = buyChain === 'bnb' ? 'solana' : 'bnb';
      spreadBps = (market[sellChain].priceUsd / market[buyChain].priceUsd - 1) * 10000;
      if (!Number.isFinite(spreadBps) || spreadBps < 0) { spreadBps = null; reasons.push('价差数值不可核验'); }
      else {
        const amount = this.getConfig()?.risk?.amountUsd;
        indicativeGrossUsd = typeof amount === 'number' && Number.isFinite(amount) ? amount * spreadBps / 10000 : null;
        if (!Number.isFinite(indicativeGrossUsd)) { indicativeGrossUsd = null; reasons.push('参考金额收益不可核验'); }
        if (spreadBps < this.settings.minSpreadBps) reasons.push('参考价差未达到扫描门槛');
        if (spreadBps > this.settings.maxSpreadBps) reasons.push('价差异常过大，须核对池、单位关系和可卖出性');
      }
    } else reasons.push('尚无同轮双链行情');
    const opportunityQualified = marketQualified && universe.eligible && spreadBps !== null && spreadBps >= this.settings.minSpreadBps && spreadBps <= this.settings.maxSpreadBps && indicativeGrossUsd !== null;
    const stage = opportunityQualified ? asset.mapping.confirmed ? 'candidate' : 'needs_mapping' : 'blocked';
    if (!asset.mapping.confirmed) reasons.push('同币、精度与交易池待人工核验');
    const storedEvaluation = this.evaluations[asset.id];
    const evaluation = storedEvaluation && storedEvaluation.assetRevision === asset.revision ? clone(storedEvaluation) : null;
    if (evaluation && (stage !== 'candidate' || !Number.isFinite(Date.parse(evaluation.expiresAt)) || Date.parse(evaluation.expiresAt) <= now)) {
      evaluation.executable = false; evaluation.reasons = [...new Set([...evaluation.reasons, '复核报价已过期或参考行情不可用'])];
    }
    return { asset: clone(asset), universe, marketQualified, opportunityQualified, market: { bnb: clone(bnb), solana: clone(solana) }, buyChain, sellChain, spreadBps, indicativeGrossUsd,
      stage, reasons: [...new Set(reasons)], evaluation, executable: evaluation?.executable === true && stage === 'candidate', observedAt: bnb && solana ? Math.min(bnb.observedAt, solana.observedAt) : null,
      feeStatus: evaluation ? 'quoted' : 'unknown', safety: 'unverified', sourceUpdateStatus: 'provider-timestamp-unavailable', generation: market.generation || null };
  }
  executionCandidates() {
    if (!this.enabled || this.busy || this.lastScanFailed) return [];
    return [...this.assets.values()].map(a => this.row(a)).filter(row => row.stage === 'candidate' && row.observedAt !== null && this.now() - row.observedAt <= FRESH_MS)
      .sort((a,b) => (b.indicativeGrossUsd || 0) - (a.indicativeGrossUsd || 0)).map(clone);
  }
  recordEvaluation(id, report) {
    const asset = this.assets.get(validId(id)); if (!asset) throw fail('同币条目不存在');
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw fail('报价复核结果无效');
    if (report.assetRevision !== undefined && report.assetRevision !== asset.revision) return this.snapshot();
    const out = { assetRevision: asset.revision, executable: report.executable === true, reasons: Array.isArray(report.reasons) ? report.reasons.slice(0,30).map(s => publicText(s, 200)).filter(Boolean) : [],
      mode: ['demo','live'].includes(report.mode) ? report.mode : this.getConfig()?.mode || 'demo', executionMode: 'inventory',
      buyChain: ['bnb','solana'].includes(report.buyChain) ? report.buyChain : null, sellChain: ['bnb','solana'].includes(report.sellChain) ? report.sellChain : null,
      quotedAt: typeof report.quotedAt === 'string' && Number.isFinite(Date.parse(report.quotedAt)) ? report.quotedAt : new Date(this.now()).toISOString(),
      expiresAt: typeof report.expiresAt === 'string' && Number.isFinite(Date.parse(report.expiresAt)) ? report.expiresAt : null };
    for (const key of ['amountUsd','netProfitUsd','grossProfitUsd','gasUsd','slippageUsd','priceImpactBps','spreadBps','bnbGas','solFee','estimatedRentUsd']) out[key] = typeof report[key] === 'number' && Number.isFinite(report[key]) ? report[key] : null;
    if (out.buyChain === out.sellChain || !out.buyChain || !out.sellChain || !out.expiresAt || Date.parse(out.expiresAt) <= this.now() || !['amountUsd','gasUsd','slippageUsd','priceImpactBps','netProfitUsd'].every(key => out[key] !== null) || ['amountUsd','gasUsd','slippageUsd','priceImpactBps'].some(key => out[key] < 0)) {
      out.executable = false; out.reasons.push('复核报价缺少完整费用、方向或有效期');
    }
    this.evaluations[id] = out; return this.snapshot();
  }
  snapshot() {
    const gate = this.budget.check(this.settings, this.assets.size ? 'pools' : 'directory'), budget = this.budget.read();
    const rows = [...this.assets.values()].map(a => this.row(a)).sort((a,b) => Number(b.opportunityQualified) - Number(a.opportunityQualified) || Number(b.marketQualified && b.universe.eligible) - Number(a.marketQualified && a.universe.eligible) || (b.spreadBps ?? -1) - (a.spreadBps ?? -1));
    let status = this.enabled ? 'monitoring' : 'stopped', reason = this.enabled ? '只读机会扫描已开启；交易须单独启用' : '自动扫描当前未运行；点击“开启自动发现与扫描”开始';
    if (this.busy) { status = 'loading'; reason = '正在读取只读同币目录或池行情'; }
    else if (!gate.allowed && ['clock','budget'].includes(gate.kind)) { status = 'cooldown'; reason = gate.reason; }
    else if (this.lastError) { status = 'error'; reason = this.lastError; }
    else if (!gate.allowed) { status = 'cooldown'; reason = gate.reason; }
    else if (!this.assets.size) { status = 'empty'; reason = this.enabled ? '尚未取得同币目录；自动发现将按重试时间继续，不需要手工添加地址' : '扫描已停止；重新开启后会自动发现候选，不需要手工添加地址'; }
    else if (this.enabled && !this.scanProgress.lastScanAt) { status = 'waiting'; reason = '已取得候选地址，等待两链池行情；尚未完成有效扫描'; }
    else if (this.enabled && this.notice) reason = this.notice;
    if (this.lastError && !this.poolError && this.scanProgress.lastScanAt && this.assets.size && status === 'error') { status = 'partial'; reason = `备用目录扫描可继续；${this.lastError}`; }
    const configured = Boolean(this.vault?.publicStatus?.().coingeckoConfigured);
    const eligible = rows.filter(row => row.asset.enabled && row.universe.eligible).length, rejectionCounts = new Map();
    for (const row of rows.filter(row => !row.universe.eligible || !row.marketQualified)) for (const reason of row.reasons.filter(reason => !reason.includes('人工核验'))) rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + 1);
    return { enabled: this.enabled, busy: this.busy, revision: this.revision, settings: clone(this.settings), assets: clone([...this.assets.values()]), rows,
      status, reason, notice: this.notice, lastError: this.lastError || null, updatedAt: Math.max(0, ...rows.map(r => r.observedAt || 0)) || null,
      nextRequestAt: gate.nextAt, usage: gate.usage, directoryUpdatedAt: this.directoryUpdatedAt, directoryNextRequestAt: budget.directoryNextAt || null,
      directory: this.directorySnapshot(), credentials: { configured, locked: configured && !this.vault?.getCoinGeckoCredentials?.() },
      scanProgress: clone(this.scanProgress), autoScanPreferred: this.autoScanPreferred, network: this.networkSnapshot(),
      scope: { kind: 'altcoins', label: '山寨币同币双链', eligible, excluded: rows.length - eligible, reasonCounts: [...rejectionCounts].map(([reason,count]) => ({ reason, count })),
        identityNotice: '默认扫描非稳定币、非 BTC／ETH／BNB／SOL 的同币候选；共享目录 ID 和发行方地址只作身份依据，真实套利仍须核验映射、报价、税费和库存。' },
      counts: { total: rows.length, approved: rows.filter(r => r.asset.mapping.confirmed).length, candidate: rows.filter(r => ['candidate','needs_mapping'].includes(r.stage)).length,
        eligible, excluded: rows.length - eligible, dualActive: rows.filter(r => r.marketQualified && r.universe.eligible).length, opportunities: rows.filter(r => r.opportunityQualified).length, executable: rows.filter(r => r.executable).length }, safety: 'unverified' };
  }
  async dispatch(kind, action, { signal, revision }, source = null) {
    if (signal.aborted || revision !== this.revision) return null;
    let gate = this.budget.reserve(this.settings, kind);
    if (!gate.allowed && gate.kind === 'gap' && gate.nextAt - this.now() <= 1000) {
      await this.sleep(Math.max(0, gate.nextAt - this.now()));
      if (signal.aborted || revision !== this.revision) return null;
      gate = this.budget.reserve(this.settings, kind);
    }
    if (!gate.allowed) { this.notice = gate.reason; return null; }
    this.lastAttemptAt = this.now();
    if (source) {
      const previous = this.directoryState.sources[source] || {};
      this.directoryState.sources[source] = { ...previous, status: 'loading', lastAttemptAt: this.now() };
      this.persistDirectory();
    }
    try {
      const result = await action(signal);
      if (signal.aborted || revision !== this.revision) return null;
      return result;
    } catch (error) {
      if (signal.aborted || revision !== this.revision) return null;
      const code = String(error?.code || '');
      const provider = source === 'coingecko' ? 'CoinGecko 同币目录' : source === 'wormhole' ? 'Wormhole 官方映射' : source?.startsWith('coinpaprika') ? 'CoinPaprika 合约目录' : '两链交易池行情';
      const auth = ['DISCOVERY_AUTH','DISCOVERY_REJECTED'].includes(code);
      const messages = { DISCOVERY_RATE_LIMIT: '接口限流，按服务端冷却重试', DISCOVERY_AUTH: '要求有效凭证或账户权限', DISCOVERY_REJECTED: '接口拒绝请求，请核对服务权限', DISCOVERY_TIMEOUT: '请求超时', DISCOVERY_UNAVAILABLE: '服务暂时不可用', DISCOVERY_FORMAT: '返回格式无效' };
      const detail = ['DNS','TIMEOUT','CONNECTION','TLS','PROXY','NETWORK'].includes(error?.networkReason) ? `（${error.networkReason}）` : '';
      const message = `${provider}${messages[code] || '网络连接失败'}${detail}；保留原缓存和请求计数`;
      // A directory provider's Retry-After binds that provider. Independent
      // official mappings and pool reads still obey the shared local budget.
      if (code === 'DISCOVERY_RATE_LIMIT' && !source) this.budget.backoff(error.retryAfterMs);
      if (source) {
        const previous = this.directoryState.sources[source], failures = Math.min(10, (previous?.failures || 0) + 1);
        const exponential = Math.min(900000, 60000 * 2 ** (failures - 1));
        const delay = code === 'DISCOVERY_RATE_LIMIT' ? Math.min(DAY, Math.max(exponential, error.retryAfterMs || 60000)) : auth ? 900000 : exponential;
        this.directoryState.sources[source] = { source, status: auth ? 'auth_required' : 'retrying', lastAttemptAt: this.now(), lastSuccessAt: previous?.lastSuccessAt || null,
          nextAttemptAt: this.now() + delay, errorCode: /^DISCOVERY_[A-Z_]+$/.test(code) ? code : 'DISCOVERY_NETWORK', message, failures, foundCount: previous?.foundCount || 0,
          httpStatus: Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : null };
        this.persistDirectory();
      } else {
        this.poolError = { message, errorCode: code };
        if (auth) this.enabled = false;
      }
      this.syncErrors();
      return null;
    }
  }
  async job(task, stage = 'pools') {
    if (this.busy) return this.snapshot();
    this.busy = true; this.currentStage = stage; this.notice = ''; const controller = new AbortController(), revision = this.revision; this.controller = controller;
    let finish; this.pendingJob = new Promise(resolve => { finish = resolve; });
    try { await task({ signal: controller.signal, revision }); }
    finally { this.busy = false; this.currentStage = null; if (this.controller === controller) this.controller = null; this.syncErrors(); finish(); }
    return this.snapshot();
  }
  async discover() {
    if (this.networkTesting || this.networkChanging) return this.snapshot();
    return this.job(async context => {
      let attempted = false, primaryReady = false;
      const success = (source, result, observedAt = this.now()) => {
        this.directoryState.sources[source] = { source, status: result.length ? 'ready' : 'empty', lastAttemptAt: observedAt, lastSuccessAt: observedAt,
          nextAttemptAt: observedAt + (result.length ? DIRECTORY_GAP : 900000), errorCode: null, message: result.length ? '' : '接口已响应，但没有符合两链地址要求的候选', failures: 0, foundCount: result.length };
        this.importCandidates(result);
        context.revision = this.revision;
        this.directoryUpdatedAt = Math.max(this.directoryUpdatedAt || 0, observedAt); this.directoryState.lastSuccessAt = this.directoryUpdatedAt;
        this.store.setMeta('opportunities.directory-updated.v1', this.directoryUpdatedAt);
        if (result.length) this.directoryState.source = source;
      };
      const primary = this.directoryState.sources.coingecko;
      if (!primary || this.now() >= primary.nextAttemptAt) {
        const result = await this.dispatch('directory', signal => { attempted = true; return this.client.discover({ signal, apiKey: this.vault?.getCoinGeckoCredentials?.()?.apiKey }); }, context, 'coingecko');
        if (context.signal.aborted || context.revision !== this.revision) return;
        if (Array.isArray(result)) { success('coingecko', result); primaryReady = result.some(asset => classifyAsset(asset, this.settings).eligible); }
      } else primaryReady = primary.status === 'ready' && [...this.assets.values()].some(asset => asset.source === 'coingecko' && classifyAsset(asset, this.settings).eligible);
      if (typeof this.client.contracts === 'function') {
        const rateLimitedUntil = Math.max(0, ...['bnb','solana'].map(chain => {
          const previous = this.directoryState.sources[`coinpaprika-${chain}`];
          return previous?.errorCode === 'DISCOVERY_RATE_LIMIT' ? previous.nextAttemptAt || 0 : 0;
        }));
        if (rateLimitedUntil <= this.now()) for (const chain of ['bnb','solana']) {
          const source = `coinpaprika-${chain}`, previous = this.directoryState.sources[source];
          if (previous?.nextAttemptAt > this.now()) continue;
          const result = await this.dispatch('contractCatalog', signal => { attempted = true; return this.client.contracts({ chain, signal }); }, context, source);
          if (context.signal.aborted || context.revision !== this.revision) return;
          if (Array.isArray(result)) {
            this.contractCatalogs[chain] = { observedAt: this.now(), entries: result };
            this.store.setMeta('opportunities.contract-catalogs.v1', this.contractCatalogs);
            this.directoryState.sources[source] = { source, status: result.length ? 'ready' : 'empty', foundCount: result.length,
              lastAttemptAt: this.now(), lastSuccessAt: this.now(), nextAttemptAt: this.now() + DIRECTORY_GAP, failures: 0, errorCode: null };
          } else if (this.directoryState.sources[source]?.errorCode === 'DISCOVERY_RATE_LIMIT') break;
        }
        const caches = ['bnb','solana'].map(chain => this.contractCatalogs[chain]);
        if (caches.every(cache => cache && cache.observedAt <= this.now() + 1000 && this.now() - cache.observedAt <= DIRECTORY_GAP)) {
          const result = mergeContractCatalogs({ bnb: caches[0].entries, solana: caches[1].entries, observedAt: Math.min(...caches.map(cache => cache.observedAt)) });
          success('coinpaprika', result, Math.min(...caches.map(cache => cache.observedAt)));
          primaryReady ||= result.some(asset => classifyAsset(asset, this.settings).eligible);
        }
      }
      if (!primaryReady && typeof this.client.discoverWrapped === 'function') {
        const fallback = this.directoryState.sources.wormhole;
        if (!fallback || this.now() >= fallback.nextAttemptAt) {
          const result = await this.dispatch('wrappedDirectory', signal => { attempted = true; return this.client.discoverWrapped({ signal }); }, context, 'wormhole');
          if (context.signal.aborted || context.revision !== this.revision) return;
          if (Array.isArray(result)) success('wormhole', result);
        }
      }
      if (!this.assets.size) this.seedBundled();
      if (attempted) {
        this.refreshDirectoryGate({ fallback: !primaryReady });
        this.persistDirectory();
      }
      this.syncErrors();
      this.notice = this.assets.size ? `已有 ${this.assets.size} 组候选地址；自动比较两链交易池，交易核验状态未改变` : '同币目录尚未取得；将按显示时间自动重试，不要求手工添加';
    }, 'directory');
  }
  async scan({ refreshDirectory = false } = {}) {
    if (this.busy || this.networkTesting || this.networkChanging) return this.snapshot();
    const cancellation = this.cancelGeneration || 0;
    if (refreshDirectory) {
      this.seedBundled({ augment: true });
      if (this.budget.check(this.settings, 'directory').allowed) await this.discover();
      if ((this.cancelGeneration || 0) !== cancellation) return this.snapshot();
    }
    if (!this.assets.size) { await this.discover(); if (!this.assets.size) return this.snapshot(); }
    if ((this.cancelGeneration || 0) !== cancellation) return this.snapshot();
    return this.job(async context => {
      const enabled = [...this.assets.values()].filter(a => a.enabled && classifyAsset(a, this.settings).eligible);
      if (!enabled.length) {
        this.scanProgress = { ...this.scanProgress, totalAssets: 0, scannedAssets: 0, withBothMarkets: 0, withActiveMarkets: 0, opportunities: 0, eligibleAssets: 0, excludedAssets: this.assets.size, lastScanAt: this.now() };
        this.store.setMeta('opportunities.scan-progress.v2', this.scanProgress);
        this.notice = '当前没有范围内的山寨币同币候选；自动发现将继续，不用稳定币或未知价格填充机会'; return;
      }
      const take = Math.min(enabled.length, this.settings.maxAssetsPerScan), selected = [];
      this.scanProgress = { ...this.scanProgress, totalAssets: take, scannedAssets: 0, withBothMarkets: 0, withActiveMarkets: 0, opportunities: 0, eligibleAssets: enabled.length, excludedAssets: this.assets.size - enabled.length };
      for (let i = 0; i < take; i++) selected.push(enabled[(this.cursor + i) % enabled.length]);
      this.cursor = (this.cursor + take) % enabled.length;
      const nextMarkets = Object.fromEntries(selected.map(asset => [asset.id, {}])), generation = `${this.now()}:${this.revision}:${this.cursor}`;
      for (let i = 0; i < selected.length; i += 30) {
        const batch = selected.slice(i, i + 30);
        for (const chain of ['bnb','solana']) {
          const addresses = [...new Set(batch.map(a => a.chains[chain].address))];
          const response = await this.dispatch('pools', signal => this.client.pools({ chain, addresses, signal }), context);
          if (!Array.isArray(response)) { this.lastScanFailed = true; return; }
          const pools = response.slice(0, 3000).map(pool => this.cleanPool(pool, chain, addresses)).filter(Boolean);
          for (const asset of batch) {
            const matches = pools.filter(pool => sameAddress(chain, pool.tokenAddress, asset.chains[chain].address) && (!asset.mapping.confirmed || sameAddress(chain, pool.poolAddress, asset.chains[chain].poolAddress)));
            const active = pool => pool.liquidityUsd !== null && pool.liquidityUsd >= this.settings.minLiquidityUsd &&
              (this.settings.minVolume24hUsd === 0 || pool.volume24hUsd !== null && pool.volume24hUsd >= this.settings.minVolume24hUsd) &&
              (this.settings.minVolume1hUsd === 0 || pool.volume1hUsd !== null && pool.volume1hUsd >= this.settings.minVolume1hUsd) &&
              (this.settings.minTrades1h === 0 || pool.trades1h !== null && pool.trades1h >= this.settings.minTrades1h);
            matches.sort((a,b) => Number(active(b)) - Number(active(a)) || (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1));
            if (matches[0]) nextMarkets[asset.id][chain] = matches[0];
          }
        }
        this.scanProgress.scannedAssets += batch.length;
      }
      if (context.signal.aborted || context.revision !== this.revision) return;
      for (const asset of selected) { this.markets[asset.id] = { ...nextMarkets[asset.id], generation }; delete this.evaluations[asset.id]; }
      this.lastScanFailed = false; this.store.setMeta('opportunities.market.v1', this.markets);
      this.poolError = null; this.syncErrors();
      const rows = selected.map(asset => this.row(asset));
      this.scanProgress.withBothMarkets = rows.filter(row => row.market.bnb && row.market.solana).length;
      this.scanProgress.withActiveMarkets = rows.filter(row => row.marketQualified).length;
      this.scanProgress.opportunities = rows.filter(row => row.opportunityQualified).length;
      this.scanProgress.lastScanAt = this.now(); this.store.setMeta('opportunities.scan-progress.v2', this.scanProgress);
      this.notice = `已扫描 ${take} 组候选，${this.scanProgress.withBothMarkets} 组有两侧交易池，${this.scanProgress.withActiveMarkets} 组双侧成交活跃，${this.scanProgress.opportunities} 组达到参考价差门槛；真实费用及库存仍须复核`;
    });
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw fail('机会扫描开关格式无效');
    this.enabled = enabled; this.autoScanPreferred = enabled; this.store.setMeta('opportunities.auto-scan.v2', { enabled });
    if (!enabled) { this.invalidate(); return this.snapshot(); }
    this.seedBundled({ augment: true });
    const hasDirectoryAssets = !this.assets.size || [...this.assets.values()].some(asset => asset.source !== 'manual');
    if (hasDirectoryAssets && this.budget.check(this.settings, 'directory').allowed) await this.discover();
    if (this.enabled) await this.scan();
    return this.snapshot();
  }
  async tick() {
    if (!this.enabled || this.busy || this.networkTesting || this.networkChanging || this.now() - this.lastAttemptAt < this.settings.pollIntervalMs) return;
    if (!this.budget.check(this.settings).allowed) return;
    const hasDirectoryAssets = !this.assets.size || [...this.assets.values()].some(asset => asset.source !== 'manual');
    if (hasDirectoryAssets && this.budget.check(this.settings, 'directory').allowed) await this.discover();
    if (this.enabled && this.assets.size) await this.scan();
  }
  start({ autoStart = true } = {}) {
    if (!this.timer) {
      const run = () => { void this.tick().catch(() => { this.enabled = false; this.lastError = '机会扫描后台异常，自动扫描已关闭'; }); };
      this.timer = setInterval(run, 5000); this.timer.unref?.();
      if (autoStart && this.autoScanPreferred) { this.seedBundled({ augment: true }); this.enabled = true; queueMicrotask(run); }
    }
    return this;
  }
  stop() { clearInterval(this.timer); this.timer = null; this.enabled = false; this.invalidate(); }
}
