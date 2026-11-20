import { DiscoveryClient } from './sources.mjs';
import { normalizeAsset, validAddress, validId, decimals, registryConflictIds, sameAddress, publicText, opportunityError as fail } from './registry.mjs';

const DAY = 86400000, DIRECTORY_GAP = 6 * 3600000, FRESH_MS = 120000;
const clone = value => structuredClone(value);
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const DEFAULT_OPPORTUNITY_SETTINGS = Object.freeze({ pollIntervalMs: 60000, minLiquidityUsd: 20000, minSpreadBps: 50, maxAssetsPerScan: 30, maxRequestsPerDay: 5000 });

function validateSettings(patch, previous = DEFAULT_OPPORTUNITY_SETTINGS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('机会扫描设置格式无效');
  const rules = { pollIntervalMs: [30000, 3600000, true], minLiquidityUsd: [0, 1e12], minSpreadBps: [0, 1000000], maxAssetsPerScan: [1, 100, true], maxRequestsPerDay: [1, 20000, true] };
  const out = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(rules, key)) throw fail('机会扫描设置包含不支持的字段');
    const [min, max, integer] = rules[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw fail(`机会扫描参数 ${key} 超出允许范围`);
    out[key] = value;
  }
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
    if (kind === 'directory' && now < state.directoryNextAt) return { allowed: false, kind: 'directory', reason: '同币目录每6小时最多请求一次，失败也保留冷却', nextAt: state.directoryNextAt, usage };
    if (now < state.nextAt) return { allowed: false, kind: 'gap', reason: '数据源请求冷却中', nextAt: state.nextAt, usage };
    return { allowed: true, nextAt: now, usage };
  }
  reserve(settings, kind) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const gate = this.check(settings, kind);
      if (gate.allowed) {
        const state = this.read(), at = this.now();
        this.store.setMeta('opportunities.budget.v1', { total: state.total + 1, requests: [...state.requests.filter(t => t > at - DAY), at], lastClock: at, nextAt: at + 1000, directoryNextAt: kind === 'directory' ? at + DIRECTORY_GAP : state.directoryNextAt });
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
}

export class OpportunityService {
  constructor({ store, getConfig = () => store.config, client = new DiscoveryClient(), now = Date.now, sleep = wait } = {}) {
    this.store = store; this.getConfig = getConfig; this.client = client; this.now = now; this.sleep = sleep;
    this.settings = validateSettings(store.getMeta('opportunities.settings.v1') || {});
    this.budget = new RequestBudget(store, now); this.assets = new Map(); this.markets = {}; this.evaluations = {};
    const saved = store.getMeta('opportunities.registry.v1');
    if (saved && (!Array.isArray(saved) || saved.length > 300)) throw new Error('同币清单损坏，请保留本机数据核对');
    for (const entry of saved || []) {
      try {
        const asset = normalizeAsset(entry, { previous: entry, now: this.now(), directory: entry.source === 'coingecko' });
        asset.revision = Number.isSafeInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1;
        asset.createdAt = safeTime(entry.createdAt) ? entry.createdAt : this.now();
        asset.updatedAt = safeTime(entry.updatedAt) ? entry.updatedAt : this.now();
        asset.sourceObservedAt = safeTime(entry.sourceObservedAt) ? entry.sourceObservedAt : null;
        this.assets.set(asset.id, asset);
      } catch { throw new Error('同币清单损坏，请保留本机数据核对'); }
    }
    const cached = store.getMeta('opportunities.market.v1');
    if (cached && typeof cached === 'object' && !Array.isArray(cached)) for (const [id, market] of Object.entries(cached).slice(0, 300)) if (this.assets.has(id)) {
      const cleaned = {};
      for (const chain of ['bnb', 'solana']) { const pool = this.cleanPool(market?.[chain], chain, [this.assets.get(id).chains[chain].address]); if (pool) cleaned[chain] = pool; }
      const generation = publicText(market?.generation, 80); this.markets[id] = { ...cleaned, generation };
    }
    this.directoryUpdatedAt = number(store.getMeta('opportunities.directory-updated.v1'));
    this.enabled = false; this.busy = false; this.revision = 0; this.cursor = 0; this.timer = null; this.controller = null;
    this.lastError = ''; this.notice = ''; this.lastAttemptAt = 0; this.lastScanFailed = false;
  }
  persistRegistry() { this.store.setMeta('opportunities.registry.v1', [...this.assets.values()]); }
  invalidate() { this.revision++; this.evaluations = {}; this.controller?.abort(); }
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
      return { chain, tokenAddress, poolAddress, quoteAddress, priceUsd: number(input.priceUsd), liquidityUsd: number(input.liquidityUsd), volume24hUsd: number(input.volume24hUsd), observedAt: input.observedAt, sourceUpdatedAt: null, dexId: publicText(input.dexId, 40), safety: 'unverified' };
    } catch { return null; }
  }
  row(asset) {
    const market = this.markets[asset.id] || {}, reasons = [], now = this.now();
    const bnb = market.bnb || null, solana = market.solana || null;
    if (!asset.enabled) reasons.push('条目已停用');
    if (asset.mapping.warning) reasons.push(asset.mapping.warning);
    if (registryConflictIds([...this.assets.values()]).has(asset.id)) reasons.push('同币清单链地址冲突');
    for (const chain of ['bnb', 'solana']) {
      const pool = market[chain];
      if (!pool) reasons.push(`${chain} 缺少有效池行情`);
      else {
        if (now - pool.observedAt > FRESH_MS || pool.observedAt > now + 1000) reasons.push(`${chain} 行情超过120秒或时间异常`);
        if (pool.liquidityUsd === null || pool.liquidityUsd < this.settings.minLiquidityUsd) reasons.push(`${chain} 流动性未知或不足`);
        if (asset.mapping.confirmed && !sameAddress(chain, asset.chains[chain].poolAddress, pool.poolAddress)) reasons.push(`${chain} 行情池与已确认池不一致`);
      }
    }
    if (this.lastScanFailed) reasons.push('最新扫描未完成，等待成功扫描');
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
      }
    } else reasons.push('尚无同轮双链行情');
    let stage = reasons.length ? 'blocked' : asset.mapping.confirmed ? 'candidate' : 'needs_mapping';
    if (!asset.mapping.confirmed) reasons.push('同币、精度与交易池待人工核验');
    const storedEvaluation = this.evaluations[asset.id];
    const evaluation = storedEvaluation && storedEvaluation.assetRevision === asset.revision ? clone(storedEvaluation) : null;
    if (evaluation && (!Number.isFinite(Date.parse(evaluation.expiresAt)) || Date.parse(evaluation.expiresAt) <= now || reasons.some(r => !r.includes('待人工核验')))) { evaluation.executable = false; evaluation.reasons = [...new Set([...evaluation.reasons, '复核报价已过期或参考行情不可用'])]; }
    return { asset: clone(asset), market: { bnb: clone(bnb), solana: clone(solana) }, buyChain, sellChain, spreadBps, indicativeGrossUsd,
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
    const gate = this.budget.check(this.settings), budget = this.budget.read();
    const rows = [...this.assets.values()].map(a => this.row(a)).sort((a,b) => (b.spreadBps || -1) - (a.spreadBps || -1));
    let status = this.enabled ? 'monitoring' : 'stopped', reason = this.enabled ? '只读机会扫描已开启；交易须单独启用' : '自动扫描已关闭；重启后需手动开启';
    if (this.busy) { status = 'loading'; reason = '正在读取只读同币目录或池行情'; }
    else if (this.lastError) { status = 'error'; reason = this.lastError; }
    else if (!gate.allowed) { status = 'cooldown'; reason = gate.reason; }
    return { enabled: this.enabled, busy: this.busy, revision: this.revision, settings: clone(this.settings), assets: clone([...this.assets.values()]), rows,
      status, reason, notice: this.notice, lastError: this.lastError || null, updatedAt: Math.max(0, ...rows.map(r => r.observedAt || 0)) || null,
      nextRequestAt: gate.nextAt, usage: gate.usage, directoryUpdatedAt: this.directoryUpdatedAt, directoryNextRequestAt: budget.directoryNextAt || null,
      counts: { total: rows.length, approved: rows.filter(r => r.asset.mapping.confirmed).length, candidate: rows.filter(r => r.stage === 'candidate').length }, safety: 'unverified' };
  }
  async dispatch(kind, action, { signal, revision }) {
    let gate = this.budget.reserve(this.settings, kind);
    if (!gate.allowed && gate.kind === 'gap' && gate.nextAt - this.now() <= 1000) {
      await this.sleep(Math.max(0, gate.nextAt - this.now()));
      if (signal.aborted || revision !== this.revision) return null;
      gate = this.budget.reserve(this.settings, kind);
    }
    if (!gate.allowed) { this.notice = gate.reason; return null; }
    this.lastAttemptAt = this.now();
    try {
      const result = await action(signal);
      if (signal.aborted || revision !== this.revision) return null;
      return result;
    } catch (error) {
      if (signal.aborted || revision !== this.revision) return null;
      const code = String(error?.code || '');
      if (code === 'DISCOVERY_RATE_LIMIT') { this.budget.backoff(error.retryAfterMs); this.lastError = '数据源限流，已保存请求退避时间'; }
      else if (['DISCOVERY_AUTH','DISCOVERY_REJECTED'].includes(code)) { this.enabled = false; this.lastError = '数据源拒绝或要求账户权限，自动扫描已关闭；可核对服务权限或使用手工同币清单'; }
      else this.lastError = '只读行情请求失败或格式无效，保留原缓存与预算';
      return null;
    }
  }
  async job(task) {
    if (this.busy) return this.snapshot();
    this.busy = true; this.lastError = ''; this.notice = ''; const controller = new AbortController(), revision = this.revision; this.controller = controller;
    try { await task({ signal: controller.signal, revision }); }
    finally { this.busy = false; if (this.controller === controller) this.controller = null; }
    return this.snapshot();
  }
  async discover() {
    return this.job(async context => {
      const result = await this.dispatch('directory', signal => this.client.discover({ signal }), context);
      if (!Array.isArray(result)) return;
      let count = [...this.assets.values()].filter(a => a.source === 'coingecko').length;
      const seen = new Set();
      for (const item of result.slice(0, 200)) {
        let incoming; try { incoming = normalizeAsset(item, { now: this.now(), directory: true }); } catch { continue; }
        if (seen.has(incoming.id)) continue; seen.add(incoming.id);
        const previous = this.assets.get(incoming.id);
        if (!previous) { if (count >= 200) continue; this.assets.set(incoming.id, incoming); count++; }
        else {
          const changed = ['bnb','solana'].some(chain => !sameAddress(chain, previous.chains[chain].address, incoming.chains[chain].address));
          if (changed) {
            previous.mapping.confirmed = false; previous.mapping.evidence = ''; previous.mapping.warning = '外部目录地址已变化；原地址保留，请编辑并重新核验';
            previous.sourceProposal = { bnb: incoming.chains.bnb.address, solana: incoming.chains.solana.address };
            previous.revision++; previous.updatedAt = this.now(); delete this.evaluations[previous.id];
          }
          previous.sourceObservedAt = this.now();
        }
      }
      this.directoryUpdatedAt = this.now(); this.store.setMeta('opportunities.directory-updated.v1', this.directoryUpdatedAt);
      this.revision++; this.evaluations = {}; this.persistRegistry(); this.notice = '同币目录已更新；目录关联尚不是1:1资产或安全证明';
    });
  }
  async scan() {
    return this.job(async context => {
      const enabled = [...this.assets.values()].filter(a => a.enabled);
      if (!enabled.length) { this.notice = '请先发现同币目录或新增手工同币条目'; return; }
      const take = Math.min(enabled.length, this.settings.maxAssetsPerScan), selected = [];
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
            matches.sort((a,b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1));
            if (matches[0]) nextMarkets[asset.id][chain] = matches[0];
          }
        }
      }
      if (context.signal.aborted || context.revision !== this.revision) return;
      for (const asset of selected) { this.markets[asset.id] = { ...nextMarkets[asset.id], generation }; delete this.evaluations[asset.id]; }
      this.lastScanFailed = false; this.store.setMeta('opportunities.market.v1', this.markets);
      this.notice = '扫描完成；参考价差尚未扣除真实交易费用，须再复核报价与库存';
    });
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw fail('机会扫描开关格式无效');
    this.enabled = enabled;
    if (!enabled) { this.invalidate(); return this.snapshot(); }
    if (!this.assets.size) await this.discover();
    if (this.enabled) await this.scan();
    return this.snapshot();
  }
  async tick() {
    if (!this.enabled || this.busy || this.now() - this.lastAttemptAt < this.settings.pollIntervalMs) return;
    if (!this.budget.check(this.settings).allowed) return;
    const hasDirectoryAssets = [...this.assets.values()].some(asset => asset.source === 'coingecko');
    if (!this.assets.size || (hasDirectoryAssets && (!this.directoryUpdatedAt || this.now() - this.directoryUpdatedAt >= DIRECTORY_GAP) && this.budget.check(this.settings, 'directory').allowed)) await this.discover();
    if (this.enabled) await this.scan();
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { void this.tick().catch(() => { this.enabled = false; this.lastError = '机会扫描后台异常，自动扫描已关闭'; }); }, 5000); this.timer.unref?.(); } return this; }
  stop() { clearInterval(this.timer); this.timer = null; this.enabled = false; this.invalidate(); }
}
