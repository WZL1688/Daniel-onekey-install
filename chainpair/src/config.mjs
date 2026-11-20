export const DEFAULT_CONFIG = {
  mode: 'demo', executionMode: 'bridge', pollIntervalMs: 5000, quoteTtlMs: 15000,
  inventory: { assetId: '', mappingConfirmed: false, mappingEvidence: '', scanApprovedAssets: false },
  chains: {
    bnb: { tokenAddress: '', stableAddress: '0x55d398326f99059fF775485246999027B3197955', poolAddress: '', tokenDecimals: 18, stableDecimals: 18, rpcs: ['https://bsc-dataseed.binance.org'], confirmations: 3, nativeUsd: 600, routerAllowlist: [] },
    solana: { tokenAddress: '', stableAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', poolAddress: '', tokenDecimals: 9, stableDecimals: 6, rpcs: ['https://api.mainnet-beta.solana.com'], confirmations: 1, nativeUsd: 150, programAllowlist: [] },
  },
  risk: { amountUsd: 5, minProfitUsd: 0.03, maxSlippageBps: 50, maxPriceImpactBps: 100, maxBnbGas: 0.001, maxSolFee: 0.01, reserveBnb: 0.003, reserveSol: 0.03, maxExecutions: 10, maxCumulativeUsd: 50, maxQuoteAgeMs: 15000 },
  rebalance: { enabled: false, triggerUsd: 5, targetShare: 0.6, cooldownMs: 1800000, maxWearUsd: 0.3, maxWearBps: 100 },
  okx: { projectId: '' },
};

function fail(name) { const error = new Error(`配置无效：${name}`); error.safe = true; throw error; }
function num(value, lo, hi, key, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi || (integer && !Number.isInteger(value))) fail(key);
  return value;
}
function text(value, name, max = 500) { if (typeof value !== 'string' || value.length > max) fail(name); return value.trim(); }
function address(value, chain, name, empty = true) {
  value = text(value, name, 100);
  if (!value && empty) return value;
  if (chain === 'bnb' ? !/^0x[0-9a-fA-F]{40}$/.test(value) : !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail(name);
  return value;
}
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('对象');
  const config = structuredClone(DEFAULT_CONFIG);
  if (input.mode !== undefined) config.mode = input.mode;
  if (!['demo', 'live'].includes(config.mode)) fail('运行模式');
  config.executionMode = input.executionMode ?? 'bridge';
  if (!['bridge', 'inventory'].includes(config.executionMode)) fail('执行模式');
  if (input.inventory !== undefined && (!input.inventory || typeof input.inventory !== 'object' || Array.isArray(input.inventory))) fail('库存配置');
  config.inventory.assetId = text(input.inventory?.assetId ?? '', 'inventory.assetId',160);
  config.inventory.mappingEvidence = text(input.inventory?.mappingEvidence ?? '', 'inventory.mappingEvidence',1000);
  config.inventory.mappingConfirmed = input.inventory?.mappingConfirmed ?? false;
  if (typeof config.inventory.mappingConfirmed !== 'boolean') fail('inventory.mappingConfirmed');
  config.inventory.scanApprovedAssets = input.inventory?.scanApprovedAssets ?? false;
  if (typeof config.inventory.scanApprovedAssets !== 'boolean') fail('inventory.scanApprovedAssets');
  for (const [key, lo, hi] of [['pollIntervalMs',1000,300000], ['quoteTtlMs',1000,60000]]) if (input[key] !== undefined) config[key] = num(input[key],lo,hi,key,true);
  for (const chain of ['bnb','solana']) {
    const c = { ...config.chains[chain], ...(input.chains?.[chain] || {}) };
    const out = config.chains[chain];
    for (const name of ['tokenAddress','stableAddress','poolAddress']) out[name] = address(c[name],chain,`${chain}.${name}`,name !== 'stableAddress');
    for (const name of ['tokenDecimals','stableDecimals']) out[name] = num(c[name],0,36,`${chain}.${name}`,true);
    out.confirmations = num(c.confirmations,1,100,`${chain}.confirmations`,true);
    out.nativeUsd = num(c.nativeUsd,0.00001,10000000,`${chain}.nativeUsd`);
    if (!Array.isArray(c.rpcs) || c.rpcs.length < 1 || c.rpcs.length > 20) fail(`${chain}.rpcs`);
    out.rpcs = c.rpcs.map((rpc) => { const s = text(rpc,`${chain}.rpcs`,2000); let u; try { u=new URL(s); } catch { fail(`${chain}.rpcs`); } if(!['https:','http:'].includes(u.protocol) || u.username || u.password || u.hash) fail(`${chain}.rpcs`); return s; });
    const list = chain === 'bnb' ? 'routerAllowlist' : 'programAllowlist';
    if (!Array.isArray(c[list]) || c[list].length > 100) fail(`${chain}.${list}`);
    out[list] = c[list].map((s)=>address(s,chain,`${chain}.${list}`,false));
  }
  const risk={ ...config.risk,...(input.risk||{}) };
  const riskRules={amountUsd:[1,10],minProfitUsd:[0,1000000],maxSlippageBps:[0,5000],maxPriceImpactBps:[0,5000],maxBnbGas:[0.000000001,100],maxSolFee:[0.000000001,100],reserveBnb:[0.000000001,1000],reserveSol:[0.000000001,10000],maxExecutions:[1,1000000],maxCumulativeUsd:[1,1000000000],maxQuoteAgeMs:[1000,60000]};
  for(const [key,[lo,hi]] of Object.entries(riskRules)) config.risk[key]=num(risk[key],lo,hi,key,['maxExecutions','maxSlippageBps','maxPriceImpactBps','maxQuoteAgeMs'].includes(key));
  const r={...config.rebalance,...(input.rebalance||{})};
  if(typeof r.enabled!=='boolean')fail('rebalance.enabled');
  config.rebalance.enabled=r.enabled;
  // These two invariants intentionally cannot be changed from the API.
  if(r.triggerUsd!==5 || r.targetShare!==0.6)fail('再平衡阈值固定为5U，目标为60/40');
  config.rebalance.triggerUsd=5; config.rebalance.targetShare=0.6;
  config.rebalance.cooldownMs=num(r.cooldownMs,60000,604800000,'rebalance.cooldownMs',true);
  config.rebalance.maxWearUsd=num(r.maxWearUsd,0,1000000000,'rebalance.maxWearUsd');
  config.rebalance.maxWearBps=num(r.maxWearBps,0,10000,'rebalance.maxWearBps',true);
  config.okx.projectId=text(input.okx?.projectId ?? '', 'okx.projectId',200);
  return config;
}
