import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validAddress, validId } from '../opportunities/registry.mjs';

const KINDS = new Set(['quote', 'paper-trade', 'paper-event', 'equity']);
const FRESH_MS = 120000, DAY_MS = 86400000;
const SECRET = /^(?:__proto__|prototype|constructor|private[-_]?key|secret(?:[-_]?key)?|password|passphrase|api[-_]?(?:key|secret|secretkey)|ok[-_]access[-_].*|authorization|headers?|credentials?|signed.*|raw(?:[-_]?(?:tx|transaction))?(?:base64|hex|bytes)?|transaction(?:base64|hex|bytes)?|tx|payload)$/i;
const fail = message => Object.assign(new Error(message), { safe: true });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plainText = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const same = (chain, left, right) => chain === 'bnb' ? left.toLowerCase() === right.toLowerCase() : left === right;
const direction = (buy, sell) => ['bnb', 'solana'].includes(buy) && ['bnb', 'solana'].includes(sell) && buy !== sell ? `${buy}->${sell}` : null;
function scrub(value, depth = 0) {
  if (depth > 30) throw fail('研究记录嵌套层级过深');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.replace(/\b(private[_ -]?key|secret[_ -]?key|password|passphrase|api[_ -]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[已隐藏]').replace(/https?:\/\/[^\s"'<>]+/gi, '[远程服务]').replace(/0x[0-9a-f]{64}\b/gi, '[已隐藏]');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET.test(key)).map(([key, child]) => [key, scrub(child, depth + 1)]));
  return null;
}
function encoded(value, max = 5 * 1024 * 1024) {
  const text = JSON.stringify(scrub(value));
  if (Buffer.byteLength(text, 'utf8') > max) throw fail('研究记录过大，请缩小批次');
  return text;
}
function stateKey(key) { if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(key)) throw fail('研究状态标识无效'); return key; }
function kindOf(kind) { if (!KINDS.has(kind)) throw fail('研究记录类型无效'); return kind; }
function recordId(id) { if (typeof id !== 'string' || !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw fail('研究记录编号无效'); return id; }
function publicQuote(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of ['id', 'quoteId', 'kind', 'verified', 'chain', 'fromChain', 'toChain', 'amountInRaw', 'amountOutRaw', 'minOutRaw', 'feeUsd', 'rentUsd', 'estimatedRentUsd', 'estimatedRentIncludedInFees', 'bnbGas', 'solFee', 'priceImpactBps', 'quotedAt', 'expiresAt']) {
    if (['string', 'number', 'boolean'].includes(typeof input[key])) out[key] = input[key];
  }
  for (const key of ['fromToken', 'toToken']) if (input[key] && typeof input[key] === 'object') out[key] = Object.fromEntries(['address', 'decimals', 'kind'].filter(name => ['string', 'number'].includes(typeof input[key][name])).map(name => [name, input[key][name]]));
  return { ...out, readOnly: true, executable: false };
}
function pageArgs({ page = 1, pageSize = 20 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw fail('研究分页参数无效');
  return { page, pageSize };
}

/** Independent research/paper storage. It never opens or writes the live trade archive. */
export class ResearchStore {
  constructor({ dataDir, now = Date.now } = {}) {
    if (typeof dataDir !== 'string' || !dataDir || typeof now !== 'function') throw fail('研究数据目录无效');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700);
    this.now = now; this.file = path.join(dataDir, 'onchain-research.sqlite'); this.db = new DatabaseSync(this.file); chmodSync(this.file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS research_state(key TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_records(kind TEXT NOT NULL,id TEXT NOT NULL,created_at INTEGER NOT NULL,asset_id TEXT,scope_id TEXT,document TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS research_records_page ON research_records(kind,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS research_records_scope ON research_records(scope_id,kind,created_at DESC);
      CREATE TABLE IF NOT EXISTS research_scopes(scope_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,asset_revision INTEGER NOT NULL,policy TEXT NOT NULL,identity TEXT NOT NULL,name TEXT NOT NULL,symbol TEXT NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,observations INTEGER NOT NULL DEFAULT 0,valid_ms INTEGER NOT NULL DEFAULT 0,current_start INTEGER,longest_ms INTEGER NOT NULL DEFAULT 0,gaps INTEGER NOT NULL DEFAULT 0,positive_samples INTEGER NOT NULL DEFAULT 0,episodes INTEGER NOT NULL DEFAULT 0,last_positive INTEGER NOT NULL DEFAULT 0,last_direction TEXT,last_generation TEXT,max_gap INTEGER NOT NULL,quote_samples INTEGER NOT NULL DEFAULT 0,positive_quotes INTEGER NOT NULL DEFAULT 0,latest_quote TEXT);
      CREATE INDEX IF NOT EXISTS research_scope_asset ON research_scopes(asset_id,asset_revision,policy);
      CREATE TABLE IF NOT EXISTS research_latest(asset_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_directions(scope_id TEXT NOT NULL,direction TEXT NOT NULL,positive_samples INTEGER NOT NULL DEFAULT 0,episodes INTEGER NOT NULL DEFAULT 0,duration_ms INTEGER NOT NULL DEFAULT 0,last_at INTEGER,last_positive INTEGER NOT NULL DEFAULT 0,quote_samples INTEGER NOT NULL DEFAULT 0,positive_quotes INTEGER NOT NULL DEFAULT 0,quote_generations INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope_id,direction));
      CREATE TABLE IF NOT EXISTS research_seen(asset_id TEXT NOT NULL,generation TEXT NOT NULL,policy TEXT NOT NULL,fingerprint TEXT NOT NULL,scope_id TEXT,valid INTEGER NOT NULL,PRIMARY KEY(asset_id,generation,policy));
      CREATE TABLE IF NOT EXISTS research_quote_generations(scope_id TEXT NOT NULL,generation TEXT NOT NULL,direction TEXT NOT NULL,PRIMARY KEY(scope_id,generation,direction));`);
    if (!this.db.prepare('PRAGMA table_info(research_scopes)').all().some(column => column.name === 'last_generation')) this.db.exec('ALTER TABLE research_scopes ADD COLUMN last_generation TEXT');
    this.breakAllSessions();
  }
  /** A reopened process cannot claim observation continuity during its downtime. */
  breakAllSessions() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE research_scopes SET current_start=NULL,gaps=gaps+1,last_positive=0 WHERE current_start IS NOT NULL').run();
      this.db.prepare('UPDATE research_directions SET last_positive=0').run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  at() { const at = this.now(); if (!Number.isSafeInteger(at) || at < 0) throw fail('研究时钟无效'); return at; }
  getState(key, fallback = null) { const row = this.db.prepare('SELECT document FROM research_state WHERE key=?').get(stateKey(key)); return row ? JSON.parse(row.document) : structuredClone(fallback); }
  setState(key, value) { const document = encoded(value); this.db.prepare('INSERT INTO research_state(key,document) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document').run(stateKey(key), document); return JSON.parse(document); }
  commitState(key, value, event) {
    stateKey(key); const document = encoded(value);
    if (event) { kindOf(event.kind); if (!event.record || typeof event.record !== 'object') throw fail('研究事件无效'); recordId(event.record.id); }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (event && this.db.prepare('SELECT 1 FROM research_records WHERE kind=? AND id=?').get(event.kind, event.record.id)) { const current = this.getState(key, null); this.db.exec('COMMIT'); return current; }
      this.db.prepare('INSERT INTO research_state(key,document) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document').run(key, document);
      if (event) this.append(event.kind, event.record);
      this.db.exec('COMMIT'); return JSON.parse(document);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  append(kind, input) {
    kindOf(kind); if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('研究记录无效');
    const id = recordId(input.id || randomUUID()), prior = this.db.prepare('SELECT document FROM research_records WHERE kind=? AND id=?').get(kind, id);
    if (prior) return JSON.parse(prior.document);
    const record = { ...input, id, recordedAt: new Date(this.at()).toISOString() }, document = encoded(record, 1024 * 1024);
    this.db.prepare('INSERT INTO research_records(kind,id,created_at,asset_id,scope_id,document) VALUES(?,?,?,?,?,?)').run(kind, id, this.at(), typeof record.assetId === 'string' ? record.assetId : null, typeof record.scopeId === 'string' ? record.scopeId : null, document);
    return JSON.parse(document);
  }
  list(kind, options) {
    kindOf(kind); const args = pageArgs(options), total = this.db.prepare('SELECT COUNT(*) AS n FROM research_records WHERE kind=?').get(kind).n;
    const items = this.db.prepare('SELECT document FROM research_records WHERE kind=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(kind, args.pageSize, (args.page - 1) * args.pageSize).map(row => JSON.parse(row.document));
    return { ...args, total, totalPages: Math.max(1, Math.ceil(total / args.pageSize)), items };
  }
  breakScope(assetId) {
    const current = this.db.prepare('SELECT s.* FROM research_scopes s JOIN research_latest l ON l.scope_id=s.scope_id WHERE l.asset_id=?').get(assetId);
    if (!current || current.current_start === null) return;
    this.db.prepare('UPDATE research_scopes SET current_start=NULL,gaps=gaps+1,last_positive=0 WHERE scope_id=?').run(current.scope_id);
    this.db.prepare('UPDATE research_directions SET last_positive=0 WHERE scope_id=?').run(current.scope_id);
  }
  sample(row, completedAt, policy, pollIntervalMs) {
    const asset = row?.asset, assetId = validId(asset?.id);
    const generation = plainText(row?.generation, 100);
    if (!generation || generation !== row.generation) throw fail('扫描批次标识无效');
    const previous = this.db.prepare('SELECT * FROM research_seen WHERE asset_id=? AND generation=? AND policy=?').get(assetId, generation, policy);
    let identity, dir, positive, fingerprint;
    try {
      if (!Number.isSafeInteger(asset.revision) || asset.revision < 1 || asset.enabled === false || row.marketQualified !== true || row.universe?.eligible !== true || row.comparisonStatus !== 'comparable' || row.anomalous === true || asset.mapping?.warning) throw fail('扫描项目尚未通过真实行情筛选');
      dir = direction(row.buyChain, row.sellChain); if (!dir) throw fail('扫描方向无效');
      const observedAt = time(row.observedAt);
      if (!Number.isSafeInteger(observedAt) || observedAt < completedAt - FRESH_MS || observedAt > completedAt + 1000) throw fail('扫描行情已过期');
      identity = {};
      for (const chain of ['bnb', 'solana']) {
        const market = row.market?.[chain], address = validAddress(chain, asset.chains?.[chain]?.address), token = validAddress(chain, market?.tokenAddress), pool = validAddress(chain, market?.poolAddress), at = time(market?.observedAt);
        if (!same(chain, address, token) || !finite(market.priceUsd) || market.priceUsd <= 0 || !finite(market.liquidityUsd) || market.liquidityUsd < 0 || !Number.isSafeInteger(at) || at < completedAt - FRESH_MS || at > completedAt + 1000 || market.priceConflict === true || ['none', 'conflicting-pools'].includes(market.priceConfidence)) throw fail('双侧池行情身份、价格或时间不可核验');
        if (asset.mapping?.confirmed && asset.chains[chain].poolAddress && !same(chain, validAddress(chain, asset.chains[chain].poolAddress), pool)) throw fail('扫描池不符合已确认映射');
        identity[chain] = { address: chain === 'bnb' ? address.toLowerCase() : address, poolAddress: chain === 'bnb' ? pool.toLowerCase() : pool };
      }
      const sideTimes = ['bnb', 'solana'].map(chain => time(row.market[chain].observedAt));
      if (Math.abs(sideTimes[0] - sideTimes[1]) > 30000) throw fail('双侧行情时间差过大');
      if (!finite(row.spreadBps) || row.spreadBps < 0) throw fail('扫描价差不可核验');
      positive = row.opportunityQualified === true;
      fingerprint = hash([asset.revision, identity, dir, observedAt, sideTimes, row.market.bnb.priceUsd, row.market.solana.priceUsd, positive]);
    } catch (error) {
      if (!previous) this.db.prepare('INSERT INTO research_seen(asset_id,generation,policy,fingerprint,scope_id,valid) VALUES(?,?,?,?,NULL,0)').run(assetId, generation, policy, 'invalid');
      this.breakScope(assetId); return { rejected: true, reason: error?.safe ? error.message : '扫描记录不完整' };
    }
    if (previous) {
      if (previous.fingerprint !== fingerprint) { this.breakScope(assetId); return { rejected: true, reason: '同一扫描批次出现冲突记录' }; }
      return { duplicate: true };
    }
    const scopeId = hash([assetId, asset.revision, policy, identity]);
    const maxGap = Math.min(FRESH_MS, Math.max(5000, Math.floor(pollIntervalMs * 1.5 + 1000)));
    const previousScope = this.db.prepare('SELECT scope_id FROM research_latest WHERE asset_id=?').get(assetId);
    if (previousScope && previousScope.scope_id !== scopeId) this.breakScope(assetId);
    this.db.prepare('INSERT OR IGNORE INTO research_scopes(scope_id,asset_id,asset_revision,policy,identity,name,symbol,first_at,last_at,max_gap) VALUES(?,?,?,?,?,?,?,?,?,?)').run(scopeId, assetId, asset.revision, policy, JSON.stringify(identity), plainText(asset.name, 100), plainText(asset.symbol, 32), completedAt, completedAt, maxGap);
    this.db.prepare('INSERT INTO research_latest(asset_id,scope_id) VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET scope_id=excluded.scope_id').run(assetId, scopeId);
    const current = this.db.prepare('SELECT * FROM research_scopes WHERE scope_id=?').get(scopeId), delta = completedAt - current.last_at;
    const linked = current.observations > 0 && current.current_start !== null && delta > 0 && delta <= Math.min(current.max_gap, maxGap);
    const backwards = current.observations > 0 && delta <= 0;
    if (backwards) {
      this.db.prepare('INSERT INTO research_seen(asset_id,generation,policy,fingerprint,scope_id,valid) VALUES(?,?,?,?,?,0)').run(assetId, generation, policy, fingerprint, scopeId);
      this.breakScope(assetId); return { rejected: true, reason: '研究时钟回退或采样时间未递增' };
    }
    const start = linked ? current.current_start : completedAt, continuous = completedAt - start;
    const newEpisode = positive && !(linked && current.last_positive && current.last_direction === dir);
    this.db.prepare(`UPDATE research_scopes SET last_at=?,observations=observations+1,valid_ms=valid_ms+?,current_start=?,longest_ms=MAX(longest_ms,?),gaps=gaps+?,positive_samples=positive_samples+?,episodes=episodes+?,last_positive=?,last_direction=?,max_gap=?,last_generation=?,name=?,symbol=? WHERE scope_id=?`).run(completedAt, linked ? delta : 0, start, continuous, current.observations > 0 && !linked && current.current_start !== null ? 1 : 0, positive ? 1 : 0, newEpisode ? 1 : 0, positive ? 1 : 0, dir, maxGap, generation, plainText(asset.name, 100), plainText(asset.symbol, 32), scopeId);
    const ds = this.db.prepare('SELECT * FROM research_directions WHERE scope_id=? AND direction=?').get(scopeId, dir);
    const directionLinked = Boolean(ds && linked && current.last_direction === dir && ds.last_positive && positive);
    this.db.prepare(`INSERT INTO research_directions(scope_id,direction,positive_samples,episodes,duration_ms,last_at,last_positive) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_id,direction) DO UPDATE SET positive_samples=positive_samples+excluded.positive_samples,episodes=episodes+excluded.episodes,duration_ms=duration_ms+excluded.duration_ms,last_at=excluded.last_at,last_positive=excluded.last_positive`).run(scopeId, dir, positive ? 1 : 0, positive && !directionLinked ? 1 : 0, directionLinked ? delta : 0, completedAt, positive ? 1 : 0);
    this.db.prepare('UPDATE research_directions SET last_positive=0 WHERE scope_id=? AND direction<>?').run(scopeId, dir);
    this.db.prepare('INSERT INTO research_seen(asset_id,generation,policy,fingerprint,scope_id,valid) VALUES(?,?,?,?,?,1)').run(assetId, generation, policy, fingerprint, scopeId);
    return { accepted: true, scopeId };
  }
  observeScan({ rows, completedAt = this.at(), policyFingerprint, pollIntervalMs = 60000 } = {}) {
    const at = time(completedAt), now = this.at();
    if (!Array.isArray(rows) || rows.length > 1000 || !Number.isSafeInteger(at) || at < now - FRESH_MS || at > now + 1000 || !/^[a-f0-9]{64}$/i.test(policyFingerprint || '') || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 3600000) throw fail('研究扫描提交参数无效');
    const result = { accepted: 0, duplicates: 0, rejected: 0, completedAt: at, reasons: {} };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        let entry;
        try { entry = this.sample(row, at, policyFingerprint, pollIntervalMs); } catch (error) { entry = { rejected: true, reason: error?.safe ? error.message : '扫描记录不完整' }; }
        if (entry.accepted) result.accepted++; else if (entry.duplicate) result.duplicates++; else { result.rejected++; result.reasons[entry.reason] = (result.reasons[entry.reason] || 0) + 1; }
      }
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recordQuote(input) {
    if (!input || typeof input !== 'object' || input.readOnly !== true || input.executable !== false) throw fail('研究报价须为只读且不可执行');
    const assetId = validId(input.assetId), revision = input.assetRevision, policy = input.policyFingerprint || input.parentPolicyFingerprint, generation = input.referenceGeneration || input.generation;
    if (!Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/i.test(policy || '') || !direction(input.buyChain, input.sellChain) || !finite(input.amountUsd) || input.amountUsd <= 0 || input.amountUsd > 1000000) throw fail('研究报价身份或金额无效');
    const existing = input.id ? this.db.prepare('SELECT document FROM research_records WHERE kind=? AND id=?').get('quote', recordId(input.id)) : null;
    if (existing) return JSON.parse(existing.document);
    const seen = typeof generation === 'string' ? this.db.prepare('SELECT h.scope_id FROM research_seen h JOIN research_scopes s ON s.scope_id=h.scope_id WHERE h.asset_id=? AND h.generation=? AND h.policy=? AND h.valid=1 AND s.asset_revision=?').get(assetId, generation, policy, revision) : null;
    const record = { id: input.id || randomUUID(), mode: 'research', evidenceType: 'readonly-quote', readOnly: true, executable: false, executionReady: false, simulationVerified: false, closedInventory: false, includesActualRestockingCosts: false, assetId, assetRevision: revision, policyFingerprint: policy,
      referenceGeneration: typeof generation === 'string' ? plainText(generation, 100) : null, scopeId: seen?.scope_id || null,
      buyChain: input.buyChain, sellChain: input.sellChain, amountUsd: input.amountUsd, identityVerified: input.identityVerified === true, qualityPassed: input.qualityPassed === true,
      quotedAt: Number.isFinite(time(input.quotedAt)) ? new Date(time(input.quotedAt)).toISOString() : null, expiresAt: Number.isFinite(time(input.expiresAt)) ? new Date(time(input.expiresAt)).toISOString() : null,
      reasons: Array.isArray(input.reasons) ? input.reasons.filter(item => typeof item === 'string').slice(0, 30).map(item => plainText(item, 300)) : [] };
    record.generation = record.referenceGeneration;
    if (Number.isSafeInteger(input.parentRevision) && input.parentRevision >= 0) record.parentRevision = input.parentRevision;
    if (/^[a-f0-9]{64}$/i.test(input.parentPolicyFingerprint || '')) record.parentPolicyFingerprint = input.parentPolicyFingerprint;
    for (const key of ['netProfitUsd', 'stressNetProfitUsd', 'grossProfitUsd', 'gasUsd', 'feeUsd', 'buyFeeUsd', 'sellFeeUsd', 'buyRentUsd', 'sellRentUsd', 'bnbGas', 'solFee', 'slippageUsd', 'priceImpactBps', 'estimatedRentUsd', 'inventoryAdjustmentCostUsd', 'buyAveragePriceUsd', 'sellAveragePriceUsd', 'conservativeBuyAveragePriceUsd', 'conservativeSellAveragePriceUsd']) if (finite(input[key])) record[key] = input[key];
    for (const key of ['kind', 'symbol', 'name', 'valuation', 'slippageBasis', 'inventoryAdjustmentCostSource', 'buyQuoteId', 'sellQuoteId', 'buyAmountInRaw', 'buyAmountOutRaw', 'buyMinOutRaw', 'tokenAmountRaw', 'sellAmountInRaw', 'sellAmountRaw', 'sellAmountOutRaw', 'sellMinOutRaw', 'dustBuyRaw']) if (typeof input[key] === 'string') record[key] = plainText(input[key], 300);
    for (const key of ['verified', 'estimatedRentIncludedInFees']) if (typeof input[key] === 'boolean') record[key] = input[key];
    for (const key of ['tokenDecimals', 'stableDecimals']) if (input[key] && typeof input[key] === 'object') record[key] = Object.fromEntries(['bnb', 'solana'].filter(chain => Number.isInteger(input[key][chain]) && input[key][chain] >= 0 && input[key][chain] <= 36).map(chain => [chain, input[key][chain]]));
    for (const key of ['addresses', 'pools']) if (input[key] && typeof input[key] === 'object') {
      const entries = [];
      for (const chain of ['bnb', 'solana']) { try { entries.push([chain, validAddress(chain, input[key][chain])]); } catch { /* Unknown public identity is omitted, never invented. */ } }
      record[key] = Object.fromEntries(entries);
    }
    if (input.metadataSources && typeof input.metadataSources === 'object') record.metadataSources = Object.fromEntries(['bnb', 'solana'].filter(chain => input.metadataSources[chain] && typeof input.metadataSources[chain] === 'object').map(chain => [chain, { source: plainText(input.metadataSources[chain].source, 80), ...(Number.isInteger(input.metadataSources[chain].decimals) ? { decimals: input.metadataSources[chain].decimals } : {}) }]));
    record.limitations = Array.isArray(input.limitations) ? input.limitations.filter(item => typeof item === 'string').slice(0, 20).map(item => plainText(item, 300)) : [];
    for (const key of ['buyQuote', 'sellQuote']) { const summary = publicQuote(input[key]); if (summary) record[key] = summary; }
    const at = this.at(), quoted = time(record.quotedAt), expires = time(record.expiresAt);
    const positive = Boolean(seen && record.identityVerified && record.qualityPassed && finite(record.netProfitUsd) && record.netProfitUsd > 0 && finite(record.stressNetProfitUsd) && record.stressNetProfitUsd >= 0 && ['gasUsd', 'slippageUsd', 'priceImpactBps', 'estimatedRentUsd'].every(key => finite(record[key]) && record[key] >= 0) && Number.isFinite(quoted) && quoted <= at + 1000 && quoted >= at - FRESH_MS && expires > at && expires <= quoted + FRESH_MS);
    record.qualifiedAtObservation = positive;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const saved = this.append('quote', record);
      if (seen) {
        const dir = direction(record.buyChain, record.sellChain);
        this.db.prepare('UPDATE research_scopes SET quote_samples=quote_samples+1,positive_quotes=positive_quotes+?,latest_quote=? WHERE scope_id=?').run(positive ? 1 : 0, JSON.stringify(saved), seen.scope_id);
        this.db.prepare('INSERT OR IGNORE INTO research_directions(scope_id,direction) VALUES(?,?)').run(seen.scope_id, dir);
        let uniquePositive = 0;
        if (positive) uniquePositive = this.db.prepare('INSERT OR IGNORE INTO research_quote_generations(scope_id,generation,direction) VALUES(?,?,?)').run(seen.scope_id, generation, dir).changes;
        this.db.prepare('UPDATE research_directions SET quote_samples=quote_samples+1,positive_quotes=positive_quotes+?,quote_generations=quote_generations+? WHERE scope_id=? AND direction=?').run(positive ? 1 : 0, uniquePositive, seen.scope_id, dir);
      }
      this.db.exec('COMMIT'); return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  rankings({ limit = 30, scope } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail('研究排行条数无效');
    if (scope !== undefined && (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope))) throw fail('研究排行范围无效');
    const rows = this.db.prepare(`SELECT s.* FROM research_scopes s JOIN research_latest l ON l.scope_id=s.scope_id ${scope ? 'WHERE s.scope_id=?' : ''} ORDER BY s.positive_quotes DESC,s.episodes DESC,s.last_at DESC LIMIT ?`).all(...(scope ? [scope, limit] : [limit]));
    const now = this.at();
    return rows.map(row => {
      const directions = this.db.prepare('SELECT * FROM research_directions WHERE scope_id=?').all(row.scope_id);
      const active = row.current_start !== null && now >= row.last_at && now - row.last_at <= row.max_gap;
      const quote = row.latest_quote ? JSON.parse(row.latest_quote) : null;
      if (quote) { quote.fresh = time(quote.expiresAt) > now; quote.stale = !quote.fresh || !active || quote.referenceGeneration !== row.last_generation; quote.qualityPassedAtObservation = quote.qualityPassed; quote.qualityPassed = quote.qualityPassed && !quote.stale; }
      const positiveDirections = directions.filter(item => item.positive_samples > 0).map(item => item.direction);
      const realDirections = directions.filter(item => item.quote_generations > 0).map(item => item.direction);
      return { scopeId: row.scope_id, assetId: row.asset_id, assetRevision: row.asset_revision, policyFingerprint: row.policy, name: row.name, symbol: row.symbol, identity: JSON.parse(row.identity),
        observations: row.observations, refPositiveSamples: row.positive_samples, episodes: row.episodes, directions: positiveDirections, dualDirections: positiveDirections.length === 2,
        referenceDurationMs: directions.reduce((sum, item) => sum + item.duration_ms, 0), firstSeen: row.first_at, lastSeen: row.last_at, current: active,
        realQuoteSamples: row.quote_samples, positiveRealQuoteSamples: row.positive_quotes, realQuoteDirections: realDirections,
        repeatedBidirectionalQuotes: directions.filter(item => item.quote_generations >= 2).length === 2,
        directionStats: directions.map(item => ({ direction: item.direction, refPositiveSamples: item.positive_samples, episodes: item.episodes, referenceDurationMs: item.duration_ms, realQuoteSamples: item.quote_samples, positiveRealQuoteSamples: item.positive_quotes, positiveQuoteGenerations: item.quote_generations })),
        currentQuotePassed: Boolean(quote?.qualifiedAtObservation && quote.qualityPassed), latestQuote: quote };
    });
  }
  coverage({ requiredDays = 14, assetId, scope } = {}) {
    if (!finite(requiredDays) || requiredDays < 14 || requiredDays > 365) throw fail('研究连续验证至少需要14天');
    if (assetId !== undefined) validId(assetId);
    if (scope !== undefined && (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope))) throw fail('研究覆盖范围无效');
    const rows = this.db.prepare(`SELECT s.* FROM research_scopes s JOIN research_latest l ON l.scope_id=s.scope_id ${scope ? 'WHERE s.scope_id=?' : assetId ? 'WHERE s.asset_id=?' : ''}`).all(...(scope ? [scope] : assetId ? [assetId] : []));
    const at = this.at(), measured = rows.map(row => {
      const active = row.current_start !== null && at >= row.last_at && at - row.last_at <= row.max_gap;
      return { row, active, continuous: active ? row.last_at - row.current_start : 0 };
    }).sort((a, b) => b.continuous - a.continuous || b.row.longest_ms - a.row.longest_ms || b.row.last_at - a.row.last_at);
    const selected = measured[0], row = selected?.row;
    const continuous = selected?.continuous || 0;
    return { scope: 'single-asset-version-policy', basis: 'validated-adjacent-scan-intervals', requiredDays, requiredDurationMs: requiredDays * DAY_MS,
      scopeId: row?.scope_id || null, assetId: row?.asset_id || null, assetRevision: row?.asset_revision || null, policyFingerprint: row?.policy || null,
      validDurationMs: row?.valid_ms || 0, currentContinuousMs: continuous, longestContinuousMs: row?.longest_ms || 0, elapsedMs: row ? row.last_at - row.first_at : 0,
      gapCount: row ? row.gaps + (row.current_start !== null && !selected.active ? 1 : 0) : 0, observations: row?.observations || 0,
      firstAt: row?.first_at ?? null, lastAt: row?.last_at ?? null, active: selected?.active || false, validated14Days: continuous >= requiredDays * DAY_MS,
      historicalValidated14Days: (row?.longest_ms || 0) >= requiredDays * DAY_MS, scopesObserved: rows.length,
      notice: '仅表示一个资产版本、合约／池和策略范围内的有效相邻采样覆盖；不跨币拼接，不把停机、旧缓存或日期跨度当连续验证，也不保证盈利。' };
  }
  close() { this.db.close(); }
}
