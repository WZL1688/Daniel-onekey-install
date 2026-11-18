import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';

const fail = message => Object.assign(new Error(`交易意图校验失败：${message}`), { safe: true });
const CHAINS = ['bnb', 'solana'];
const MAX_RAW = { bnb: (1n << 256n) - 1n, solana: (1n << 64n) - 1n };
const RISK_FIELDS = ['amountUsd', 'minProfitUsd', 'maxSlippageBps', 'maxPriceImpactBps', 'maxBnbGas', 'maxSolFee', 'reserveBnb', 'reserveSol', 'maxExecutions', 'maxCumulativeUsd', 'maxQuoteAgeMs'];
const REBALANCE_FIELDS = ['enabled', 'triggerUsd', 'targetShare', 'cooldownMs', 'maxWearUsd', 'maxWearBps'];
const CHAIN_FIELDS = ['tokenAddress', 'stableAddress', 'poolAddress', 'tokenDecimals', 'stableDecimals', 'confirmations', 'nativeUsd'];
const fields = (source, names) => Object.fromEntries(names.map(name => [name, source?.[name]]));
const sameAddress = (chain, left, right) => typeof left === 'string' && typeof right === 'string' && (chain === 'bnb' ? left.toLowerCase() === right.toLowerCase() : left === right);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

/** An allowlisted audit policy, deliberately excluding RPC/API/wallet credentials. */
export function createPolicySnapshot(config) {
  const snapshot = {
    schemaVersion: 1, mode: config.mode, quoteTtlMs: config.quoteTtlMs,
    risk: fields(config.risk, RISK_FIELDS), rebalance: fields(config.rebalance, REBALANCE_FIELDS),
    chains: Object.fromEntries(CHAINS.map(chain => [chain, {
      ...fields(config.chains?.[chain], CHAIN_FIELDS),
      [chain === 'bnb' ? 'routerAllowlist' : 'programAllowlist']: [...(config.chains?.[chain]?.[chain === 'bnb' ? 'routerAllowlist' : 'programAllowlist'] || [])],
    }])),
    valuation: { stableUsd: 1, nativeUsdSource: 'configured-reference-at-trade-creation' },
  };
  return freeze(structuredClone(snapshot));
}
export function policyFingerprint(policy) { return createHash('sha256').update(canonical(policy)).digest('hex'); }
export function policyRecord(config) { const policySnapshot = createPolicySnapshot(config); return { policySnapshot, policyFingerprint: policyFingerprint(policySnapshot) }; }
export function assertPolicyUnchanged(trade, config) {
  if (!trade?.policySnapshot || !trade.policyFingerprint || policyFingerprint(trade.policySnapshot) !== trade.policyFingerprint || policyFingerprint(createPolicySnapshot(config)) !== trade.policyFingerprint) throw fail('执行期间的风控或资产配置已变化，请人工核对');
}
export function configuredToken(policy, chain, kind = 'token') {
  if (!CHAINS.includes(chain) || !['token', 'stable'].includes(kind)) throw fail('链或资产类型无效');
  const config = policy.chains[chain];
  return { address: config[kind === 'stable' ? 'stableAddress' : 'tokenAddress'] || `demo-${chain}-${kind}`, decimals: config[kind === 'stable' ? 'stableDecimals' : 'tokenDecimals'], kind };
}
export function swapIntent(chain, fromToken, toToken, amountInRaw) { return { kind: 'swap', fromChain: chain, toChain: chain, fromToken, toToken, amountInRaw }; }
export function bridgeIntent(fromChain, toChain, fromToken, toToken, amountInRaw) { return { kind: 'bridge', fromChain, toChain, fromToken, toToken, amountInRaw }; }
export function positiveRaw(value, chain, name) {
  if (typeof value !== 'string' || value.length > 78 || !/^[1-9]\d*$/.test(value)) throw fail(`${name}必须为正整数原始单位字符串`);
  const integer = BigInt(value);
  if (!MAX_RAW[chain] || integer > MAX_RAW[chain]) throw fail(`${name}超出链上整数范围`);
  return integer;
}
export function assertQuoteIntent(quote, expected, { policy, wallets = {}, nowMs = Date.now() } = {}) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote) || !expected) throw fail('缺少完整报价');
  if (typeof quote.id !== 'string' || !quote.id || quote.id.length > 160) throw fail('报价标识无效');
  if (!CHAINS.includes(expected.fromChain) || !CHAINS.includes(expected.toChain) || !['swap', 'bridge'].includes(expected.kind)) throw fail('预期交易类型无效');
  if (quote.kind !== expected.kind || quote.fromChain !== expected.fromChain || quote.toChain !== expected.toChain) throw fail('报价类型或源链、目标链与计划不一致');
  if ((expected.kind === 'swap') !== (expected.fromChain === expected.toChain)) throw fail('同链兑换与跨链类型不匹配');
  for (const [key, chain] of [['fromToken', expected.fromChain], ['toToken', expected.toChain]]) {
    const actual = quote[key], token = expected[key];
    if (!actual || !token || !sameAddress(chain, actual.address, token.address) || !Number.isInteger(actual.decimals) || actual.decimals < 0 || actual.decimals > 36 || actual.decimals !== token.decimals || (actual.kind !== undefined && actual.kind !== token.kind)) throw fail(`${key === 'fromToken' ? '输入' : '输出'}资产地址、精度或类型与计划不一致`);
  }
  positiveRaw(expected.amountInRaw, expected.fromChain, '计划输入数量');
  positiveRaw(quote.amountInRaw, expected.fromChain, '报价输入数量');
  if (quote.amountInRaw !== expected.amountInRaw) throw fail('报价输入数量与计划或已确认实收数量不一致');
  const output = positiveRaw(quote.amountOutRaw, expected.toChain, '报价输出数量');
  const minimum = positiveRaw(quote.minOutRaw, expected.toChain, '最低到账数量');
  if (minimum > output) throw fail('最低到账高于报价输出');
  const expires = typeof quote.expiresAt === 'string' ? Date.parse(quote.expiresAt) : NaN;
  if (!Number.isFinite(expires) || expires <= nowMs) throw fail('报价已过期或缺少有效期');
  if (!Number.isFinite(policy?.quoteTtlMs) || expires > nowMs + Math.min(policy.quoteTtlMs, 60000) + 1000) throw fail('报价有效期超出配置允许范围');
  for (const key of ['feeUsd', 'bnbGas', 'solFee', 'priceImpactBps']) if (typeof quote[key] !== 'number' || !Number.isFinite(quote[key]) || quote[key] < 0) throw fail('报价缺少可核验的费用或价格冲击');
  if (quote.estimatedRentUsd !== undefined && (typeof quote.estimatedRentUsd !== 'number' || !Number.isFinite(quote.estimatedRentUsd) || quote.estimatedRentUsd < 0)) throw fail('租金估算无效');
  if (policy.mode === 'live') {
    if (!sameAddress(expected.fromChain, quote.sender, wallets[expected.fromChain]?.address) || !sameAddress(expected.toChain, quote.recipient, wallets[expected.toChain]?.address)) throw fail('报价发送方或收款人与当前钱包不一致');
  }
  return quote;
}

/** Derive the next permitted leg entirely from policy and confirmed previous receipts. */
export function intentForLeg(trade, stage) {
  const policy = trade.policySnapshot;
  if (!policy || !CHAINS.includes(trade.buyChain) || !CHAINS.includes(trade.sellChain) || trade.buyChain === trade.sellChain) throw fail('交易缺少有效资产政策或方向');
  const buy = trade.buyChain, sell = trade.sellChain, legs = trade.legs || [];
  const quantity = () => new Decimal(trade.amountUsd).mul(new Decimal(10).pow(configuredToken(policy, buy, 'stable').decimals)).floor().toFixed(0);
  if (trade.type === 'arbitrage') {
    if (stage === 'BUY' && legs.length === 0) return swapIntent(buy, configuredToken(policy, buy, 'stable'), configuredToken(policy, buy), quantity());
    if (stage === 'BRIDGE' && legs.length === 1 && legs[0].name === 'BUY' && legs[0].status === 'CONFIRMED' && legs[0].receipt?.confirmed === true) return bridgeIntent(buy, sell, configuredToken(policy, buy), configuredToken(policy, sell), legs[0].receipt.receivedRaw);
    if (stage === 'SELL' && legs.length === 2 && legs[0].name === 'BUY' && legs[0].status === 'CONFIRMED' && legs[1].name === 'BRIDGE' && legs[1].status === 'CONFIRMED' && legs[1].receipt?.confirmed === true) return swapIntent(sell, configuredToken(policy, sell), configuredToken(policy, sell, 'stable'), legs[1].receipt.receivedRaw);
  } else if (['manual', 'rebalance'].includes(trade.type) && stage === 'BRIDGE' && legs.length === 0) {
    return bridgeIntent(buy, sell, configuredToken(policy, buy, 'stable'), configuredToken(policy, sell, 'stable'), quantity());
  }
  throw fail('前置回执未确认、步骤重复或执行顺序无效');
}
