const MAX_POOLS = 3000;
const FRESH_MS = 120000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const setting = (settings, key, fallback) => finite(settings?.[key]) && settings[key] >= 0 ? settings[key] : fallback;
const keyFor = (chain, address) => chain === 'bnb' ? address.toLowerCase() : address;
const metric = value => finite(value) && value >= 0 ? value : -1;
const clone = value => value ? structuredClone(value) : null;

function addressFor(chain, address) {
  if (typeof address !== 'string') return null;
  if (chain === 'bnb') return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : null;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? address : null;
}

// Only fields supplied by the normalized public-pool client participate in
// identity/conflict checks. Extraneous remote fields cannot change a choice.
function normalized(pool, chain) {
  if (!pool || typeof pool !== 'object' || Array.isArray(pool) || (pool.chain !== undefined && pool.chain !== chain)) return null;
  const poolAddress = addressFor(chain, pool.poolAddress);
  if (!poolAddress || !finite(pool.priceUsd) || pool.priceUsd <= 0) return null;
  return {
    chain, poolAddress, tokenAddress: typeof pool.tokenAddress === 'string' ? pool.tokenAddress.slice(0, 128) : '',
    quoteAddress: typeof pool.quoteAddress === 'string' ? pool.quoteAddress.slice(0, 128) : '', priceUsd: pool.priceUsd,
    priceMethod: ['provider-base-usd', 'derived-from-base-native'].includes(pool.priceMethod) ? pool.priceMethod : 'unknown',
    liquidityUsd: finite(pool.liquidityUsd) && pool.liquidityUsd >= 0 ? pool.liquidityUsd : null,
    volume24hUsd: finite(pool.volume24hUsd) && pool.volume24hUsd >= 0 ? pool.volume24hUsd : null,
    volume1hUsd: finite(pool.volume1hUsd) && pool.volume1hUsd >= 0 ? pool.volume1hUsd : null,
    trades1h: Number.isSafeInteger(pool.trades1h) && pool.trades1h >= 0 ? pool.trades1h : null,
    observedAt: Number.isSafeInteger(pool.observedAt) && pool.observedAt >= 0 ? pool.observedAt : null,
    sourceUpdatedAt: null, dexId: typeof pool.dexId === 'string' ? pool.dexId.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) : '',
    safety: 'unverified',
  };
}

function active(pool, settings, now) {
  if (!finite(now) || !Number.isSafeInteger(pool.observedAt) || pool.observedAt > now + 1000 || now - pool.observedAt > FRESH_MS) return false;
  if (pool.liquidityUsd === null || pool.liquidityUsd < setting(settings, 'minLiquidityUsd', 20000)) return false;
  for (const [field, name, fallback] of [['volume24hUsd', 'minVolume24hUsd', 10000], ['volume1hUsd', 'minVolume1hUsd', 100], ['trades1h', 'minTrades1h', 3]]) {
    const minimum = setting(settings, name, fallback);
    if (minimum > 0 && (pool[field] === null || pool[field] < minimum)) return false;
  }
  return true;
}

function byLiquidity(left, right) {
  return metric(right.liquidityUsd) - metric(left.liquidityUsd)
    || metric(right.volume1hUsd) - metric(left.volume1hUsd)
    || left.poolAddress.localeCompare(right.poolAddress);
}

/**
 * Choose an observed pool price, never a synthesized mean or profitable price.
 * Active pools are compared in bounded, non-transitive price windows. A tied
 * set of windows is usable only if all windows share a real central pool.
 * Independent pool addresses are evidence of price agreement, not of safety,
 * independent market makers, sellability, or executable profit.
 */
export function selectReferencePool(pools, { settings = {}, now = Date.now(), pinnedPoolAddress, chain } = {}) {
  const totalPools = Array.isArray(pools) ? pools.length : 0;
  const diagnostics = { totalPools, validPools: 0, uniquePools: 0, eligiblePools: 0, agreementPools: 0, rejectedOutliers: 0, rejectedInactive: 0, conflictingDuplicates: 0, maximalWindows: 0, consensusCandidates: 0, pinnedMissing: 0 };
  const result = (pool, confidence, quarantined, reasons = []) => ({ pool: clone(pool), confidence, quarantined, reasons, diagnostics: { ...diagnostics } });
  if (!Array.isArray(pools) || totalPools > MAX_POOLS) return result(null, 'conflicting-pools', true, ['交易池数据超过范围或格式无效，停止选择参考池']);
  chain ??= pools.find(pool => ['bnb', 'solana'].includes(pool?.chain))?.chain;
  if (!['bnb', 'solana'].includes(chain)) return result(null, 'none', false, ['缺少可核对的交易池链标识']);

  const unique = new Map(), conflicts = new Set();
  const valid = pools.map(pool => normalized(pool, chain)).filter(Boolean);
  diagnostics.validPools = valid.length;
  for (const pool of valid) {
    const key = keyFor(chain, pool.poolAddress), previous = unique.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(pool)) conflicts.add(key);
    else if (!previous) unique.set(key, pool);
  }
  diagnostics.uniquePools = unique.size;
  diagnostics.conflictingDuplicates = conflicts.size;
  const candidates = [...unique.values()], pinnedKey = pinnedPoolAddress ? addressFor(chain, pinnedPoolAddress) : null;
  const pinned = pinnedKey ? unique.get(keyFor(chain, pinnedKey)) : null;
  const fallback = pinned || (pinnedPoolAddress ? null : candidates.slice().sort(byLiquidity)[0]);
  const eligible = candidates.filter(pool => !conflicts.has(keyFor(chain, pool.poolAddress)) && active(pool, settings, now));
  diagnostics.eligiblePools = eligible.length;
  diagnostics.rejectedInactive = candidates.length - eligible.length - conflicts.size;
  if (pinnedPoolAddress && !pinned) diagnostics.pinnedMissing = 1;
  if (conflicts.size) return result(fallback, 'conflicting-pools', true, ['同一交易池返回互相冲突的数据，已隔离参考价格']);
  if (pinnedPoolAddress && !pinned) return result(null, 'none', false, ['已核验交易池未返回有效价格，不能自动替换为另一池']);
  if (!eligible.length) return result(fallback, 'none', false, ['没有满足新鲜度、流动性和近期成交要求的参考池']);
  if (eligible.length === 1) {
    if (pinned && pinned !== eligible[0]) return result(pinned, 'none', false, ['已核验交易池未通过活跃度检查，不能自动替换']);
    diagnostics.agreementPools = 1; diagnostics.consensusCandidates = 1;
    return result(pinned || eligible[0], 'single-pool', false, ['仅有一个活跃池，尚无其他池价格交叉验证']);
  }

  const sorted = eligible.slice().sort((left, right) => left.priceUsd - right.priceUsd || left.poolAddress.localeCompare(right.poolAddress));
  const factor = 1 + setting(settings, 'maxPoolDeviationBps', 1500) / 10000;
  const tolerance = Number.EPSILON * 8 * Math.max(1, factor);
  let start = 0, largest = 0, windows = [];
  for (let end = 0; end < sorted.length; end++) {
    while (start < end && sorted[end].priceUsd / sorted[start].priceUsd > factor + tolerance) start++;
    const count = end - start + 1;
    if (count > largest) { largest = count; windows = [{ start, end }]; }
    else if (count === largest) windows.push({ start, end });
  }
  diagnostics.agreementPools = largest;
  diagnostics.maximalWindows = windows.length;
  if (largest < 2) {
    diagnostics.rejectedOutliers = eligible.length;
    return result(fallback, 'conflicting-pools', true, ['同一币种的活跃池价格分歧过大，无法确认参考价格']);
  }
  const commonStart = Math.max(...windows.map(window => window.start));
  const commonEnd = Math.min(...windows.map(window => window.end));
  if (commonStart > commonEnd) {
    diagnostics.rejectedOutliers = eligible.length;
    return result(fallback, 'conflicting-pools', true, ['多组活跃池价格支持数量相同且没有共同中心池，参考价格已隔离']);
  }
  // A common center means all maximum windows overlap; their union is one
  // interval. Avoid quadratic work when many equally sized windows overlap.
  const unionStart = Math.min(...windows.map(window => window.start));
  const unionEnd = Math.max(...windows.map(window => window.end));
  const consensus = new Set(sorted.slice(unionStart, unionEnd + 1));
  diagnostics.consensusCandidates = consensus.size;
  diagnostics.rejectedOutliers = eligible.length - consensus.size;
  if (pinned && active(pinned, settings, now) && !consensus.has(pinned)) return result(pinned, 'conflicting-pools', true, ['已核验池价格偏离其他活跃池的一致价格，保留原池并隔离']);
  if (pinned && !active(pinned, settings, now)) return result(pinned, 'none', false, ['已核验交易池未通过活跃度检查，不能自动替换']);
  const selected = pinned || sorted.slice(commonStart, commonEnd + 1).sort(byLiquidity)[0];
  const reasons = diagnostics.rejectedOutliers ? ['已排除偏离一致价格的活跃池；一致价格仍不代表可成交或安全'] : [];
  return result(selected, 'pool-consensus', false, reasons);
}
