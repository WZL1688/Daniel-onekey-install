import { randomUUID, createHash } from 'node:crypto';
import { createPolicySnapshot, policyFingerprint } from '../policy.mjs';
import { validId } from '../opportunities/registry.mjs';
import { sharedOkxReadGate } from '../provider-budget.mjs';

const KEY = 'research.settings.v1', BUDGET = 'research.jobs.v1', STOP = 'execution.global-stop.v1';
const TIERS = [1, 2, 5, 10, 20, 50], DAY = 86400000;
const safe = message => Object.assign(new Error(message), { safe: true });
const clone = value => structuredClone(value);
const time = value => typeof value === 'number' ? value : Date.parse(value);
const defaults = { enabled: false, amounts: TIERS, quoteIntervalMs: 15000, maxJobsPerDay: 500 };

export class OnchainResearchService {
  constructor({ engine, scanner, store, quoteClient, paper, now = Date.now }) {
    this.engine = engine; this.scanner = scanner; this.store = store; this.quoteClient = quoteClient; this.paper = paper; this.now = now;
    this.settings = this.validateSettings(store.getState(KEY, defaults));
    this.queue = []; this.busy = false; this.pending = null; this.timer = null; this.stopping = false;
    this.lastError = ''; this.lastJob = null; this.rotation = 0; this.lastCapture = null;
    const budget = store.getState(BUDGET, { times: [], lastAt: null });
    this.times = Array.isArray(budget.times) ? budget.times.filter(Number.isSafeInteger) : [];
    this.lastQuoteAt = Number.isSafeInteger(budget.lastAt) ? budget.lastAt : null;
    if (engine.store.getMeta(STOP)?.enabled) { engine.running = false; engine.pausedReason ||= '全局停止已启用；核对后可解除，不会自动恢复执行'; }
  }
  validateSettings(input) {
    const out = { ...defaults, ...input };
    if (typeof out.enabled !== 'boolean' || !Array.isArray(out.amounts) || !out.amounts.length || out.amounts.length > 6 || out.amounts.some(n => !TIERS.includes(n)) || new Set(out.amounts).size !== out.amounts.length || !Number.isSafeInteger(out.quoteIntervalMs) || out.quoteIntervalMs < 15000 || out.quoteIntervalMs > 3600000 || !Number.isSafeInteger(out.maxJobsPerDay) || out.maxJobsPerDay < 1 || out.maxJobsPerDay > 10000) throw safe('研究设置无效；金额仅支持1/2/5/10/20/50U，报价间隔至少15秒');
    return { enabled: out.enabled, amounts: [...out.amounts].sort((a, b) => a - b), quoteIntervalMs: out.quoteIntervalMs, maxJobsPerDay: out.maxJobsPerDay };
  }
  paperState() { const state = this.paper.snapshot(); return { ...state, assetId: state.assetId || state.asset?.id || state.session?.assetId || null }; }
  policy() { return createHash('sha256').update(JSON.stringify([policyFingerprint(createPolicySnapshot(this.engine.config)), this.scanner.settings || {}])).digest('hex'); }
  globallyStopped() { return this.engine.store.getMeta(STOP)?.enabled === true; }
  row(assetId) {
    validId(assetId);
    if (this.scanner.busy || this.scanner.lastScanFailed) throw safe('真实行情扫描尚未完成或最新扫描失败');
    const snapshot = this.scanner.snapshot(), rows = (snapshot.rows || []).filter(row => row.asset?.id === assetId);
    if (rows.length !== 1) throw safe('尚无该资产唯一的真实双链行情，请先自动扫描');
    const row = rows[0], at = this.now();
    if (row.asset.enabled === false || row.anomalous || row.comparisonStatus !== 'comparable' || row.marketQualified !== true || row.universe?.eligible !== true || !row.generation || !Number.isFinite(time(row.observedAt)) || time(row.observedAt) < at - 120000 || time(row.observedAt) > at + 1000) throw safe('该资产的身份、双侧池或行情新鲜度尚未通过观察条件');
    this.scanner.assertComparisonUsable?.(assetId);
    return clone(row);
  }
  saveSettings(input) {
    if (this.busy) throw safe('研究报价或paper正在处理，请稍候保存设置');
    this.settings = this.validateSettings({ ...this.settings, ...input });
    this.store.setState(KEY, this.settings);
    if (!this.settings.enabled) { this.queue = []; this.paper.pause('已停止研究报价；paper保持暂停'); }
    return this.snapshot();
  }
  requestQuote({ assetId, revision, amountUsd, buyChain }) {
    if (this.globallyStopped()) throw safe('全局停止已启用，请先人工核对后解除');
    if (!TIERS.includes(amountUsd) || !['bnb', 'solana'].includes(buyChain)) throw safe('报价金额或方向无效');
    const row = this.row(assetId);
    if (!Number.isSafeInteger(revision) || row.asset.revision !== revision) throw safe('资产版本已变化，请刷新后重新选择');
    if (this.queue.length >= 100) throw safe('研究队列已满，请等待或停止队列');
    const existing = this.queue.find(job => job.assetId === assetId && job.revision === revision && job.amountUsd === amountUsd && job.buyChain === buyChain);
    if (existing) return { accepted: true, jobId: existing.id, duplicate: true };
    if (this.lastJob?.status === 'quoting' && this.lastJob.assetId === assetId && this.lastJob.revision === revision && this.lastJob.amountUsd === amountUsd && this.lastJob.buyChain === buyChain) return { accepted: true, jobId: this.lastJob.id, duplicate: true };
    const job = { id: randomUUID(), assetId, revision, amountUsd, buyChain, parentRevision: this.engine.configRevision, status: 'queued', queuedAt: this.now() };
    this.queue.push(job); this.kick(); return { accepted: true, jobId: job.id, readOnly: true, executable: false };
  }
  requestMatrix({ assetId, revision }) {
    if (this.queue.length + this.settings.amounts.length * 2 > 100) throw safe('研究队列空间不足，未加入部分矩阵');
    const jobs = [];
    for (const amountUsd of this.settings.amounts) for (const buyChain of ['bnb', 'solana']) jobs.push(this.requestQuote({ assetId, revision, amountUsd, buyChain }));
    return { accepted: true, jobs, readOnly: true, executable: false };
  }
  capture() {
    if (this.scanner.busy || this.scanner.lastScanFailed) return;
    const snapshot = this.scanner.snapshot(), completedAt = time(snapshot.updatedAt);
    if (!Number.isFinite(completedAt) || completedAt > this.now() + 1000 || completedAt === this.lastCapture || !Array.isArray(snapshot.rows)) return;
    this.store.observeScan({ rows: snapshot.rows, completedAt, policyFingerprint: this.policy(), pollIntervalMs: this.scanner.settings?.pollIntervalMs || 60000 });
    this.lastCapture = completedAt;
    const session = this.paperState();
    const id = session.assetId || session.session?.assetId;
    if (id) { try { const row = this.row(id); this.paper.mark({ asset: row.asset, row }); } catch { /* A missing mark is not a fabricated zero price. */ } }
  }
  available() {
    const e = this.engine;
    return !this.stopping && !this.busy && !this.globallyStopped() && !e.busy && !e.refreshing && !e.configuring && !e.quoteBuilders && !e.pausedReason && !this.scanner.busy;
  }
  claimBudget() {
    const at = this.now();
    if (this.lastQuoteAt !== null && at < this.lastQuoteAt) throw safe('系统时钟回退，研究报价暂停');
    if (this.lastQuoteAt !== null && at - this.lastQuoteAt < this.settings.quoteIntervalMs) return false;
    this.times = this.times.filter(t => t > at - DAY);
    if (this.times.length >= this.settings.maxJobsPerDay) throw safe('研究已达滚动日任务预算；失败也计数，不通过轮换密钥重试');
    this.times.push(at); this.lastQuoteAt = at; this.store.setState(BUDGET, { times: this.times, lastAt: at }); return true;
  }
  autoJob() {
    const session = this.paperState(), paperAsset = session.assetId || session.session?.assetId;
    const rows = (this.scanner.snapshot().rows || []).filter(row => row.marketQualified && row.opportunityQualified && row.universe?.eligible && row.comparisonStatus === 'comparable' && !row.anomalous && (!paperAsset || row.asset.id === paperAsset));
    if (!rows.length) return null;
    const index = this.rotation++, row = rows[Math.floor(index / (this.settings.amounts.length * 2)) % rows.length];
    return { id: randomUUID(), assetId: row.asset.id, revision: row.asset.revision, amountUsd: this.settings.amounts[Math.floor(index / 2) % this.settings.amounts.length], buyChain: index % 2 ? 'solana' : 'bnb', parentRevision: this.engine.configRevision, status: 'queued' };
  }
  async tick() {
    if (this.stopping) return;
    try { this.capture(); } catch { this.lastError = '真实扫描历史记录暂不可用，请检查本机研究数据库'; }
    if (!this.available() || (!this.queue.length && !this.settings.enabled)) return;
    const job = this.queue[0] || this.autoJob(); if (!job) return;
    try { if (!this.claimBudget()) return; } catch (error) { this.lastError = this.text(error); return; }
    if (this.queue[0] === job) this.queue.shift();
    this.busy = true; this.engine.busy = true; this.lastJob = { ...job, status: 'quoting', startedAt: this.now() }; this.lastError = '';
    const pending = (async () => {
      try {
        if (job.parentRevision !== this.engine.configRevision) throw safe('排队期间钱包或风控参数已变化，已取消旧任务');
        const row = this.row(job.assetId);
        if (row.asset.revision !== job.revision) throw safe('排队期间资产映射已变化，已取消旧任务');
        const report = await this.quoteClient.quote({ asset: row.asset, row, amountUsd: job.amountUsd, buyChain: job.buyChain });
        if (this.stopping) return;
        report.policyFingerprint = this.policy();
        try {
          const latest = this.row(job.assetId);
          if (latest.generation !== row.generation || latest.asset.revision !== row.asset.revision) throw safe('真实报价期间扫描已换轮，旧代次报告仅保留历史');
        } catch (error) { report.qualityPassed = false; report.stale = true; report.reasons = [...(report.reasons || []), this.text(error)]; }
        if (job.parentRevision !== this.engine.configRevision || this.globallyStopped()) { report.qualityPassed = false; report.reasons = [...(report.reasons || []), '报价期间配置变化或全局停止，不能沿用该报告']; }
        this.store.recordQuote(report); this.lastJob.status = report.qualityPassed ? 'quoted' : 'blocked';
        const paper = this.paperState();
        if ((paper.running === true || paper.session?.running === true) && (paper.assetId || paper.session?.assetId) === job.assetId && report.qualityPassed === true && !this.globallyStopped()) await this.paper.execute({ asset: row.asset, row, quote: report, assertCurrent: () => this.assertPaperContext(row, job.parentRevision) });
      } catch (error) { this.lastError = this.text(error); this.lastJob.status = 'blocked'; this.lastJob.error = this.lastError; }
      finally { this.busy = false; this.engine.busy = false; this.lastJob.finishedAt = this.now(); this.pending = null; }
    })();
    this.pending = pending; await pending;
  }
  text(error) { return error?.safe ? String(error.message).replace(/https?:\/\/[^\s]+/g, '[远程服务]').slice(0, 240) : '研究任务未完成，请核对本机配置、行情连接与真实报价证据'; }
  kick() { if (!this.stopping) void this.tick().catch(() => { this.lastError = '研究任务暂不可用'; }); }
  start() { this.stopping = false; if (!this.timer) this.timer = setInterval(() => this.kick(), 2000); this.timer.unref?.(); this.kick(); return this; }
  stop() { this.stopping = true; clearInterval(this.timer); this.timer = null; this.queue = []; }
  paperStart({ assetId, revision, capitalPerChainUsd = 100, risk } = {}) {
    if (!this.available()) throw safe('已有任务、全局停止或待核对状态，请稍候再启动paper');
    const row = this.row(assetId); if (row.asset.revision !== revision) throw safe('资产已变化，请重新选择');
    const quote = this.store.list('quote', { pageSize: 100 }).items.find(q => q.assetId === assetId && q.assetRevision === revision && (q.generation || q.referenceGeneration) === row.generation && q.verified === true && q.identityVerified === true && q.parentRevision === this.engine.configRevision && q.parentPolicyFingerprint === policyFingerprint(createPolicySnapshot(this.engine.config)) && q.policyFingerprint === this.policy() && ['bnb','solana'].every(chain => Number.isInteger(q.tokenDecimals?.[chain])) && time(q.expiresAt) > this.now());
    if (!quote) throw safe('请先取得当前扫描批次的真实只读报价与链上精度证据，再创建paper账户');
    this.paper.start({ asset: row.asset, row, quote, capitalPerChainUsd, risk });
    this.settings.enabled = true; this.store.setState(KEY, this.settings); this.kick(); return this.snapshot();
  }
  paperPause() { this.paper.pause('用户暂停paper；未触发实盘'); return this.snapshot(); }
  paperResume() { if (!this.available()) throw safe('已有任务或待核对状态，请先核对'); const session = this.paperState(), row = this.row(session.assetId || session.session?.assetId); this.paper.resume({ asset: row.asset, row }); return this.snapshot(); }
  paperRun() {
    if (!this.available()) throw safe('已有任务或待核对状态，请稍候');
    const paper = this.paperState(), assetId = paper.assetId || paper.session?.assetId, row = this.row(assetId);
    const quotes = this.store.list('quote', { pageSize: 100 }).items.filter(q => q.assetId === assetId && q.assetRevision === row.asset.revision && (q.generation || q.referenceGeneration) === row.generation && q.parentRevision === this.engine.configRevision && q.parentPolicyFingerprint === policyFingerprint(createPolicySnapshot(this.engine.config)) && q.qualityPassed && q.identityVerified && time(q.expiresAt) > this.now()).sort((a, b) => b.stressNetProfitUsd - a.stressNetProfitUsd);
    if (!quotes.length) throw safe('尚无当前资产的新鲜合格真实报价，请先复核双向金额梯度');
    this.busy = true; this.engine.busy = true;
    const revision = this.engine.configRevision;
    this.pending = this.paper.execute({ asset: row.asset, row, quote: quotes[0], assertCurrent: () => this.assertPaperContext(row, revision) }).catch(error => { this.lastError = this.text(error); }).finally(() => { this.busy = false; this.engine.busy = false; this.pending = null; });
    return { accepted: true, mode: 'paper', executable: false };
  }
  assertPaperContext(original, revision) {
    const current = this.row(original.asset.id);
    if (this.globallyStopped() || this.stopping || this.engine.configRevision !== revision || current.asset.revision !== original.asset.revision || current.generation !== original.generation) throw safe('paper期间配置、资产或扫描批次变化，停止并保留已产生的虚拟敞口');
  }
  globalStop() {
    this.settings.enabled = false; this.store.setState(KEY, this.settings); this.queue = []; this.paper.pause('全局停止；在途paper敞口须核对');
    this.engine.store.setMeta(STOP, { enabled: true, at: this.now() }); this.engine.pause('用户全局停止新执行；在途交易仍须核对');
    this.engine.pausedReason = '全局停止已启用；核对后可解除，不会自动恢复执行'; return this.snapshot();
  }
  clearStop({ confirmed } = {}) {
    if (confirmed !== true || this.busy || this.engine.busy || this.engine.store.allTrades().some(t => t.status === 'NEEDS_REVIEW')) throw safe('请先核对未完成交易，再明确确认解除全局停止');
    this.engine.store.setMeta(STOP, { enabled: false, at: this.now() });
    if (this.engine.pausedReason.startsWith('全局停止')) this.engine.pausedReason = '';
    return this.snapshot();
  }
  currentQuote(input) {
    const quote = clone(input);
    try {
      const row = this.row(quote.assetId);
      if (this.globallyStopped() || quote.policyFingerprint !== this.policy() || quote.parentRevision !== this.engine.configRevision || quote.parentPolicyFingerprint !== policyFingerprint(createPolicySnapshot(this.engine.config)) || quote.assetRevision !== row.asset.revision || (quote.generation || quote.referenceGeneration) !== row.generation || time(quote.expiresAt) <= this.now()) throw safe('报价已过期或行情、资产、钱包、策略已变化');
    } catch { quote.qualityPassed = false; quote.stale = true; }
    return quote;
  }
  snapshot() {
    return { mode: 'research-paper', liveEnabled: false, settings: clone(this.settings), busy: this.busy, lastError: this.lastError, lastQuoteAt: this.lastQuoteAt,
      nextQuoteAt: this.lastQuoteAt === null ? this.now() : this.lastQuoteAt + this.settings.quoteIntervalMs, queue: clone(this.queue), lastJob: this.lastJob ? clone(this.lastJob) : null,
      rankings: this.store.rankings({ limit: 30 }).map(row => { const quote = row.latestQuote ? this.currentQuote(row.latestQuote) : null; return { ...row, currentQuotePassed: Boolean(row.current && quote?.qualifiedAtObservation && quote.qualityPassed && !quote.stale), latestQuote: quote }; }), coverage: { ...this.store.coverage({ requiredDays: 14 }), kind: 'reference-scan-only', paperValidated: false, liveAuthorization: false }, recentQuotes: this.store.list('quote', { pageSize: 30 }).items.map(quote => this.currentQuote(quote)),
      paper: this.paperState(), globalStop: this.globallyStopped(), provider: sharedOkxReadGate.snapshot(), assets: (this.scanner.snapshot().assets || []).map(clone),
      notice: '真实行情研究与虚拟paper独立；历史报价不是下单授权，20/50U仅供观察，原实盘1–10U限制不变。' };
  }
}
