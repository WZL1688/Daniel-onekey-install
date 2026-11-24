import Decimal from 'decimal.js';
import bs58 from 'bs58';

const Money = Decimal.clone({ precision: 40 });
const TOLERANCE = new Money('0.00000001');
const Z95 = 1.9599639845;
const CHAINS = new Set(['bnb', 'solana']);
const FAILED = new Set(['FAILED', 'REJECTED', 'REVERTED', 'CANCELLED', 'ABORTED']);
const fail = message => Object.assign(new Error(message), { safe: true });
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const nonnegative = value => finite(value) && value >= 0;
const equalMoney = (left, right) => new Money(left).minus(right).abs().lte(TOLERANCE);

function timestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) && Math.abs(result) <= 8.64e15 ? result : null;
}
function startedAt(trade) { return timestamp(trade.startedAt) ?? timestamp(trade.createdAt); }
function completionAfter(trade, now) {
  const event = Array.isArray(trade.events) ? trade.events.find(row => row && String(row.status || row.state).toUpperCase() === 'COMPLETED') : null;
  const time = timestamp(trade.completedAt) ?? timestamp(event?.at || event?.createdAt) ?? timestamp(trade.updatedAt);
  return time !== null && time > now;
}
function validHash(hash, chain) {
  if (typeof hash !== 'string' || hash.length > 90) return false;
  if (chain === 'bnb') return /^0x[0-9a-fA-F]{64}$/.test(hash);
  if (chain !== 'solana' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(hash)) return false;
  try { return bs58.decode(hash).length === 64; } catch { return false; }
}
function positiveRaw(value) {
  return typeof value === 'string' && /^[0-9]{1,100}$/.test(value) && BigInt(value) > 0n;
}

/** This verifies the local archive's evidence, without contacting either chain. */
function verifiedResult(trade, executionMode, reusedHashes) {
  const actual = trade.actual;
  if (!actual || !finite(actual.spentUsd) || actual.spentUsd <= 0 || !nonnegative(actual.receivedUsd) ||
      !nonnegative(actual.gasUsd) || !nonnegative(actual.rentUsd) || !finite(actual.profitUsd)) return null;
  const calculated = new Money(actual.receivedUsd).minus(actual.spentUsd).minus(actual.gasUsd).minus(actual.rentUsd);
  if (!equalMoney(calculated, actual.profitUsd)) return null;
  if (executionMode === 'inventory') {
    if (actual.closedInventory !== false || !finite(actual.cashSpreadProfitUsd) || !equalMoney(actual.cashSpreadProfitUsd, actual.profitUsd)) return null;
  } else if (actual.closedInventory === false) return null;

  if (!CHAINS.has(trade.buyChain) || !CHAINS.has(trade.sellChain) || trade.buyChain === trade.sellChain || !Array.isArray(trade.legs)) return null;
  const names = executionMode === 'inventory' ? ['BUY', 'SELL'] : ['BUY', 'BRIDGE', 'SELL'];
  // Duplicate, extra or partially archived legs cannot be silently ignored.
  if (trade.legs.length !== names.length) return null;
  let gasUsd = new Money(0), rentUsd = new Money(0);
  const hashes = new Set();
  for (const name of names) {
    const matches = trade.legs.filter(leg => leg && leg.name === name);
    if (matches.length !== 1) return null;
    const leg = matches[0], receipt = leg.receipt;
    const chain = name === 'SELL' ? trade.sellChain : trade.buyChain;
    if (leg.status !== 'CONFIRMED' || !receipt || receipt.confirmed !== true || !validHash(leg.hash, chain) ||
        leg.hash !== receipt.hash || hashes.has(leg.hash) || reusedHashes.has(transactionKey(leg.hash)) || !positiveRaw(receipt.spentRaw) || !positiveRaw(receipt.receivedRaw) ||
        !nonnegative(receipt.feeUsd) || !nonnegative(receipt.rentUsd)) return null;
    if (leg.quote?.fromChain !== undefined && leg.quote.fromChain !== chain) return null;
    hashes.add(leg.hash);
    gasUsd = gasUsd.plus(receipt.feeUsd); rentUsd = rentUsd.plus(receipt.rentUsd);
  }
  if (!equalMoney(gasUsd, actual.gasUsd) || !equalMoney(rentUsd, actual.rentUsd)) return null;
  // Use the recomputed amount; a tiny positive field cannot turn an exactly zero result into a win.
  return calculated.gt(0) && actual.profitUsd > 0 ? 'successes' : 'verifiedLosses';
}

function wilson(successes, attempts) {
  if (!attempts) return { lower: null, upper: null };
  const rate = successes / attempts, z2 = Z95 * Z95;
  const denominator = 1 + z2 / attempts;
  const center = (rate + z2 / (2 * attempts)) / denominator;
  const width = Z95 * Math.sqrt((rate * (1 - rate) + z2 / (4 * attempts)) / attempts) / denominator;
  return { lower: successes === 0 ? 0 : Math.max(0, center - width), upper: successes === attempts ? 1 : Math.min(1, center + width) };
}
const transactionKey = hash => hash.startsWith('0x') ? hash.toLowerCase() : hash;
function reusedTransactions(rows) {
  const seen = new Set(), reused = new Set();
  for (const { trade } of rows) {
    const hashes = new Set((Array.isArray(trade.legs) ? trade.legs : []).map(leg => leg?.hash)
      .filter(hash => typeof hash === 'string' && hash.length <= 90).map(transactionKey));
    for (const hash of hashes) { if (seen.has(hash)) reused.add(hash); seen.add(hash); }
  }
  return reused;
}

/**
 * A conservative retrospective summary of real attempts, never a trading hook.
 * Counts are mutually exclusive and sum to attempts. Incomplete, unsuccessful,
 * and unresolved attempts remain in the success-rate denominator.
 */
export function buildPerformanceEvidence(trades, {
  mode = 'live', executionMode = 'inventory', assetId, minSamples = 100,
  targetRate = .7, confidence = .95, now = Date.now(), limit = 200
} = {}) {
  if (!Array.isArray(trades)) throw fail('绩效记录须为数组');
  if (mode !== 'live') throw fail('成功率证据仅支持实盘模式，模拟记录不能作为盈利证据');
  if (!['inventory', 'bridge'].includes(executionMode)) throw fail('绩效执行模式无效');
  if (assetId !== undefined && (typeof assetId !== 'string' || !assetId.trim() || assetId.length > 160)) throw fail('绩效资产筛选标识无效');
  if (!Number.isInteger(minSamples) || minSamples < 100 || minSamples > 1000) throw fail('历史证据至少需要100笔，最多1000笔样本');
  if (!finite(targetRate) || targetRate < .7 || targetRate > 1) throw fail('历史目标比例须为70%至100%');
  if (confidence !== .95) throw fail('历史证据仅支持95% Wilson区间');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail('绩效窗口须为1至1000笔');
  if (timestamp(now) === null || typeof now !== 'number') throw fail('绩效统计时间无效');

  const scoped = trades.filter(trade => trade && typeof trade === 'object' && trade.type === 'arbitrage' && trade.mode === 'live' &&
    (trade.executionMode ?? 'bridge') === executionMode && (assetId === undefined || trade.assetId === assetId));
  const candidates = scoped.map((trade, index) => ({ trade, index, time: startedAt(trade) }));
  const eligible = candidates.filter(row => row.time === null || row.time <= now);
  const reusedHashes = reusedTransactions(eligible);
  const selected = eligible.sort((left, right) => (right.time ?? -Infinity) - (left.time ?? -Infinity) || left.index - right.index).slice(0, limit);
  const counts = { attempts: selected.length, successes: 0, verifiedLosses: 0, unknown: 0, failed: 0, pending: 0 };
  for (const { trade, time } of selected) {
    const status = typeof trade.status === 'string' ? trade.status.toUpperCase() : '';
    let classification = 'unknown';
    if (status === 'COMPLETED' && time !== null && !completionAfter(trade, now)) classification = verifiedResult(trade, executionMode, reusedHashes) || 'unknown';
    else if (FAILED.has(status)) classification = 'failed';
    else if (status === 'QUOTED' || status === 'RECONCILING' || /^(?:BUY|BRIDGE|SELL)_(?:SUBMITTING|SUBMITTED|RECEIPT|RECEIPT_RECEIVED|CONFIRMED|QUOTED)$/.test(status)) classification = 'pending';
    counts[classification]++;
  }
  const interval = wilson(counts.successes, counts.attempts);
  const historicalEvidenceMet = counts.attempts >= minSamples && interval.lower >= targetRate;
  const dated = selected.filter(row => row.time !== null).map(row => row.time);
  const inventory = executionMode === 'inventory';
  return {
    schemaVersion: 1, generatedAt: new Date(now).toISOString(), mode: 'live', executionMode,
    scope: { kind: assetId === undefined ? 'global' : 'asset', exactAssetIdFilter: assetId !== undefined,
      assetCount: new Set(selected.map(row => row.trade.assetId).filter(id => typeof id === 'string' && id.length > 0)).size,
      unattributedAttempts: selected.filter(row => typeof row.trade.assetId !== 'string' || !row.trade.assetId).length },
    window: { limit, eligibleAttempts: eligible.length, omittedOlderAttempts: Math.max(0, eligible.length - limit),
      undatedAttempts: selected.length - dated.length, excludedFutureAttempts: candidates.length - eligible.length,
      oldestAttemptAt: dated.length ? new Date(Math.min(...dated)).toISOString() : null,
      newestAttemptAt: dated.length ? new Date(Math.max(...dated)).toISOString() : null,
      ordering: 'startedAt-or-createdAt-descending-undated-last' },
    counts, observedRate: counts.attempts ? counts.successes / counts.attempts : null,
    confidence, intervalMethod: 'wilson-score-two-sided', wilsonLowerBound: interval.lower, wilsonUpperBound: interval.upper,
    minSamples, targetRate, historicalEvidenceMet,
    status: historicalEvidenceMet ? 'historical-target-met' : counts.attempts < minSamples ? 'unverified' : 'historical-target-not-met',
    basis: { metric: inventory ? 'positive-two-leg-cash-spread' : 'positive-closed-arbitrage-profit',
      label: inventory ? '已复核双腿现金流价差为正；库存未回补' : '已复核买入、跨链、卖出后的净收益为正',
      closedInventory: !inventory, includesRestockingCosts: false },
    coverage: { source: 'local-trade-archive', chainVerification: 'archived-receipts-only', denominator: 'all-selected-real-attempts',
      categoriesAreExclusive: true, includesDemo: false, includesExternalWalletActions: false, guaranteesFutureResults: false,
      requiresUniqueArchivedTransactions: true, assumesIndependentStableObservations: true },
    observations: [
      { code: 'NO_PROFIT_GUARANTEE', text: '历史结果和统计区间不能保证下一笔盈利或未来成功率；行情和执行条件会变化。' },
      { code: 'LOCAL_ARCHIVE_ONLY', text: '仅核对本机档案中的确认回执、哈希格式和完整收支，不独立联网验证链上真实性。' },
      { code: 'VALUATION_ASSUMPTIONS', text: '净收益按档案中的稳定币面值与原生币参考汇率折算；不是已独立验证的实时美元损益。' },
      { code: 'SAMPLING_LIMIT', text: 'Wilson区间依赖独立且稳定的样本假设；滚动窗口、相关成交和市场变化会限制其解释。' },
      { code: assetId === undefined ? 'GLOBAL_SCOPE' : 'EXACT_ASSET_SCOPE', text: assetId === undefined ? '统计包含该执行模式的全部资产，不能作为某一代币的成功率。' : '仅统计精确匹配当前资产标识的尝试，不使用其他代币补充样本。' },
      ...(inventory ? [{ code: 'RESTOCKING_EXCLUDED', text: '库存模式的正价差未包含后续回补库存的费用和风险，不代表库存闭环利润。' }] : []),
      ...(counts.attempts < minSamples ? [{ code: 'INSUFFICIENT_EVIDENCE', text: '真实尝试样本不足，盈利能力尚未验证。' }] : [])
    ]
  };
}
