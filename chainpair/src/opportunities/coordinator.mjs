import { randomUUID } from 'node:crypto';
import { Engine } from '../engine.mjs';
import { validateConfig } from '../config.mjs';
import { createPolicySnapshot, policyFingerprint } from '../policy.mjs';

const fail = message => Object.assign(new Error(message), { safe: true });
const clone = value => structuredClone(value);

/** A single parent mutex protects all per-asset immutable execution contexts. */
export class InventoryCoordinator {
  constructor({ engine, scanner, now = Date.now }) {
    this.engine = engine; this.scanner = scanner; this.now = now;
    this.worker = null; this.job = null; this.pending = null; this.authorizations = new Map();
    this.lastEvaluation = null; this.lastError = ''; this.lastAutomaticAt = 0; this.attempts = new Map();
    engine.inventoryCoordinator = this;
    const originalSnapshot = engine.snapshot.bind(engine);
    engine.snapshot = () => {
      const snapshot = originalSnapshot();
      if (this.worker?.activeTradeId) snapshot.engine.activeTradeId = this.worker.activeTradeId;
      snapshot.inventoryExecution = this.snapshot();
      return snapshot;
    };
  }
  active() { return this.engine.config.executionMode === 'inventory' && this.engine.config.inventory?.scanApprovedAssets === true; }
  snapshot() {
    return { busy: Boolean(this.worker || this.job?.status === 'preparing'), running: this.engine.running && this.active(), mode: this.engine.config.mode,
      executionMode: this.engine.config.executionMode || 'bridge', activeAssetId: this.worker ? this.job?.assetId : null,
      job: this.job ? clone(this.job) : null, lastEvaluation: this.lastEvaluation ? clone(this.lastEvaluation) : null, lastError: this.lastError };
  }
  available() {
    const e = this.engine;
    if (e.busy || e.refreshing || e.configuring || e.quoteBuilders || this.worker || this.scanner.busy) throw fail('已有交易、扫描、报价或配置任务进行中，请稍候');
    if (e.pausedReason) throw fail('存在待人工核对交易，请先核对交易档案');
    if (e.store.allTrades().some(trade => trade.status === 'NEEDS_REVIEW')) throw fail('交易档案仍有待核对记录，请先核对');
    if (e.config.executionMode !== 'inventory') throw fail('请先在设置中选择双侧库存模式');
  }
  context(asset) {
    const config = clone(this.engine.config);
    config.executionMode = 'inventory';
    config.inventory = { assetId: asset.id, mappingConfirmed: true, mappingEvidence: asset.mappingEvidence, scanApprovedAssets: false };
    for (const chain of ['bnb', 'solana']) {
      config.chains[chain] = { ...config.chains[chain], tokenAddress: asset.chains[chain].address, tokenDecimals: asset.chains[chain].decimals, poolAddress: asset.chains[chain].poolAddress };
    }
    return validateConfig(config);
  }
  authorization(id) {
    const intent = this.authorizations.get(id), asset = this.scanner.getApprovedAsset(id);
    if (!intent || intent.expiresAt <= this.now() || intent.parentRevision !== this.engine.configRevision || intent.assetRevision !== asset.revision || intent.policyFingerprint !== policyFingerprint(createPolicySnapshot(this.engine.config))) throw fail('复核报价已过期或参数已变更，请重新复核当前币对');
    return intent;
  }
  async quote(id) {
    this.available();
    const asset = this.scanner.getApprovedAsset(id);
    this.authorizations.delete(id);
    return this.launch(asset, 'quote');
  }
  execute(id) {
    this.available(); this.authorization(id);
    const asset = this.scanner.getApprovedAsset(id);
    this.authorizations.delete(id);
    // Claim synchronously, then return a trackable job. Chain results go to archives.
    const pending = this.launch(asset, 'manual');
    pending.catch(() => {});
    return { accepted: true, jobId: this.job.id, assetId: id, mode: this.engine.config.mode };
  }
  async tick() {
    if (!this.active() || !this.engine.running || !this.scanner.enabled || this.scanner.busy || this.engine.busy || this.engine.refreshing || this.engine.configuring || this.engine.quoteBuilders || this.worker || this.engine.pausedReason || this.now() - this.lastAutomaticAt < 30000) return;
    const candidate = this.scanner.executionCandidates().find(row => this.now() - (this.attempts.get(row.asset.id) || 0) >= 60000);
    if (!candidate) return;
    const asset = this.scanner.getApprovedAsset(candidate.asset.id);
    this.lastAutomaticAt = this.now(); this.attempts.set(asset.id, this.now());
    const pending = this.launch(asset, 'automatic'); pending.catch(() => {});
  }
  launch(asset, kind) {
    const parent = this.engine, revision = parent.configRevision, baseline = policyFingerprint(createPolicySnapshot(parent.config));
    const config = this.context(asset);
    const worker = new Engine({ store: parent.store, vault: parent.vault, browserWallets: parent.browserWallets, adapterFactory: parent.adapterFactory, phaseDelayMs: parent.phaseDelayMs });
    worker.config = config; worker.running = false;
    parent.busy = true; this.lastError = '';
    this.job = { id: randomUUID(), assetId: asset.id, assetRevision: asset.revision, kind, mode: parent.config.mode, status: 'preparing', startedAt: new Date(this.now()).toISOString(), tradeId: null };
    const identity = JSON.stringify(asset);
    worker.executionGuard = () => {
      if (parent.configRevision !== revision || policyFingerprint(createPolicySnapshot(parent.config)) !== baseline || parent.pausedReason || parent.store.allTrades().some(trade => trade.status === 'NEEDS_REVIEW') || JSON.stringify(this.scanner.getApprovedAsset(asset.id)) !== identity) throw fail('资产核验、钱包或风控参数已变化，停止后续步骤并核对');
    };
    this.worker = worker;
    const run = async () => {
      try {
        worker.executionGuard(); await worker.makeAdapter();
        await worker.loadMarketBalances(); await worker.buildOpportunity(); worker.executionGuard();
        const opportunity = clone(worker.opportunity || { executable: false, reasons: ['未取得完整双腿报价'] });
        opportunity.mode = parent.config.mode; opportunity.assetRevision = asset.revision;
        this.lastEvaluation = { assetId: asset.id, ...opportunity };
        this.scanner.recordEvaluation(asset.id, opportunity);
        if (!opportunity.executable) { this.job.status = 'blocked'; return opportunity; }
        if (kind === 'quote') {
          this.authorizations.set(asset.id, { parentRevision: revision, assetRevision: asset.revision, policyFingerprint: baseline, expiresAt: Date.parse(opportunity.expiresAt) });
          if (this.authorizations.size > 100) this.authorizations.delete(this.authorizations.keys().next().value);
          this.job.status = 'quoted'; return opportunity;
        }
        this.job.status = 'executing';
        const trade = await worker.execute();
        this.job.status = 'completed'; this.job.tradeId = trade.id;
        this.job.completedAt = new Date(this.now()).toISOString(); return trade;
      } catch (error) {
        this.lastError = parent.errorText(error); this.job.status = worker.pausedReason ? 'needs_review' : 'blocked';
        this.job.error = this.lastError;
        this.scanner.recordEvaluation(asset.id, { executable: false, reasons: [this.lastError], mode: parent.config.mode, assetRevision: asset.revision });
        if (worker.pausedReason) { parent.pausedReason = worker.pausedReason; parent.running = false; }
        const trade = parent.store.allTrades().find(t => t.assetId === asset.id && t.status === 'NEEDS_REVIEW');
        if (trade) this.job.tradeId = trade.id;
        throw error;
      } finally {
        worker.stop(); this.worker = null; parent.busy = false; parent.activeTradeId = null;
        this.job.finishedAt = new Date(this.now()).toISOString();
        this.pending = null;
      }
    };
    this.pending = run();
    return this.pending;
  }
}
