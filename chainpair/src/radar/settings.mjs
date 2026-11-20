const fail = message => Object.assign(new Error(message), { safe: true });

export const DEFAULT_RADAR_SETTINGS = Object.freeze({
  chain: 'bnb', pollIntervalMs: 300000,
  minLiquidityUsd: 20000, minMarketCapUsd: 50000, maxMarketCapUsd: 10000000,
  minVolume5mUsd: 5000, minHolders: 100, minAgeMinutes: 30, maxAgeHours: 168,
  maxRequestsPerHour: 12, maxRequestsPerDay: 144, maxRequestsLifetime: 1000
});
const rules = {
  pollIntervalMs: [300000, 86400000, true],
  minLiquidityUsd: [0, 1e12], minMarketCapUsd: [0, 1e15], maxMarketCapUsd: [1, 1e15],
  minVolume5mUsd: [0, 1e12], minHolders: [0, 1e9, true],
  minAgeMinutes: [0, 525600], maxAgeHours: [1, 876000],
  maxRequestsPerHour: [1, 12, true], maxRequestsPerDay: [1, 288, true],
  maxRequestsLifetime: [1, 100000, true]
};
export function validateRadarSettings(patch = {}, previous = DEFAULT_RADAR_SETTINGS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('雷达设置格式无效');
  const out = { ...DEFAULT_RADAR_SETTINGS };
  for (const key of Object.keys(out)) if (Object.hasOwn(previous, key)) out[key] = previous[key];
  for (const key of Object.keys(patch)) {
    if (key === 'chain') {
      if (!['bnb', 'solana'].includes(patch.chain)) throw fail('雷达仅支持 BNB 与 Solana');
      out.chain = patch.chain;
    } else if (Object.hasOwn(rules, key)) {
      const [min, max, integer] = rules[key], value = patch[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw fail(`雷达参数 ${key} 超出允许范围`);
      out[key] = value;
    } else throw fail('雷达设置包含不支持的字段');
  }
  if (out.minMarketCapUsd > out.maxMarketCapUsd) throw fail('最小市值不能高于最大市值');
  if (out.minAgeMinutes > out.maxAgeHours * 60) throw fail('最小币龄不能高于最大币龄');
  return out;
}

// These are market observation filters. No outcome is a safety certification.
export function filterRadarToken(token, settings, now = Date.now()) {
  const excluded = [], missing = [];
  if (token.conflict) excluded.push('同一链与地址的数据冲突，已隔离');
  if (token.risk?.status === 'flagged' || token.risk?.flags?.length) excluded.push(...(token.risk.flags?.length ? token.risk.flags : ['风险报告存在警示']));
  const freshFor = 600000;
  if (!Number.isFinite(token.observedAt) || token.observedAt > now + 60000 || now - token.observedAt > freshFor) excluded.push('行情缓存已过期，等待重新扫描');
  if (!Number.isFinite(token.sourceUpdatedAt) || token.sourceUpdatedAt <= 0) missing.push('数据源更新时间未知');
  else if (now - token.sourceUpdatedAt > freshFor || token.sourceUpdatedAt > now + 60000) excluded.push('数据源更新时间异常或已过期');
  const number = (key, label, min, max = Infinity, integer = false) => {
    const value = token[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) missing.push(`${label}缺失或无效`);
    else if (value < min || value > max) excluded.push(`${label}未达到筛选范围`);
  };
  number('priceUsd', '价格', Number.MIN_VALUE);
  number('liquidityUsd', '流动性', settings.minLiquidityUsd);
  number('marketCapUsd', '市值', settings.minMarketCapUsd, settings.maxMarketCapUsd);
  number('volume5mUsd', '5分钟成交量', settings.minVolume5mUsd);
  number('holders', '持有人数', settings.minHolders, Infinity, true);
  if (!Number.isFinite(token.createdAt) || token.createdAt <= 0 || token.createdAt > now) missing.push('币龄缺失或无效');
  else {
    const ageMinutes = (now - token.createdAt) / 60000;
    if (ageMinutes < settings.minAgeMinutes || ageMinutes > settings.maxAgeHours * 60) excluded.push('币龄未达到筛选范围');
  }
  return { status: excluded.length ? 'excluded' : missing.length ? 'insufficient' : 'candidate', reasons: [...new Set([...excluded, ...missing])], safety: 'unverified' };
}
