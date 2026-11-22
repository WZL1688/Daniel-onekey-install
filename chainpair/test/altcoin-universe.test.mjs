import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAsset, qualifyMarkets } from '../src/opportunities/universe.mjs';
import { bundledDirectory } from '../src/opportunities/bundled.mjs';

const now = Date.parse('2026-11-22T06:00:00Z');
const asset = patch => ({ id: 'coingecko:example-alt', source: 'coingecko', name: 'Example alt', symbol: 'EXAMPLE', chains: { bnb: { address: '0x1111111111111111111111111111111111111111' }, solana: { address: '11111111111111111111111111111112' } }, ...patch });
const pool = patch => ({ priceUsd: .01, liquidityUsd: 100000, volume24hUsd: 100000, volume1hUsd: 1000, trades1h: 10, observedAt: now, ...patch });
const markets = patch => ({ bnb: pool(), solana: pool(), ...patch });

test('default scope excludes stable and core-four wrapped assets from all historical mappings', () => {
  for (const entry of bundledDirectory()) {
    const result = classifyAsset(entry);
    const excluded = ['USDC', 'USDT', 'DAI', 'BUSD', 'WETH', 'WBTC', 'WBNB', 'SOL', 'wstETH'].includes(entry.symbol);
    assert.equal(result.eligible, !excluded, entry.symbol || entry.origin.chain);
    if (excluded) assert.equal(result.evidence, 'known-address');
  }
});

test('other native altcoins are retained, without making a claim about bridge safety or equivalence', () => {
  for (const symbol of ['SUI', 'APT', 'WPOL', 'WAVAX', 'CELO', 'WGLMR', 'wKAIA', 'PYTH']) {
    const entry = bundledDirectory().find(row => row.symbol === symbol), result = classifyAsset(entry);
    assert.equal(result.category, 'altcoin'); assert.equal(result.eligible, true);
    for (const key of ['safe', 'approved', 'sameAsset', 'mappingConfirmed']) assert.equal(Object.hasOwn(result, key), false);
  }
});

test('known stable address overrides a spoofed altcoin symbol and contradictory canonical ID', () => {
  const result = classifyAsset(asset({ id: 'coingecko:bitcoin', symbol: 'MOON', chains: { bnb: { address: '0x1111111111111111111111111111111111111111' }, solana: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } }));
  assert.equal(result.category, 'stablecoin'); assert.equal(result.eligible, false); assert.equal(result.evidence, 'known-address');
});

test('known wrapped-native address cannot be made an altcoin through an invented name', () => {
  const result = classifyAsset(asset({ name: 'Small Cap Coin', chains: { bnb: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' }, solana: { address: '11111111111111111111111111111112' } } }));
  assert.equal(result.category, 'major'); assert.equal(result.eligible, false); assert.equal(result.evidence, 'known-address');
});

test('canonical provider IDs classify stablecoins and staking representations without relying on ticker', () => {
  for (const id of ['coingecko:usd-coin', 'coinpaprika:usdt-tether']) {
    const result = classifyAsset(asset({ id, symbol: 'ALT' }));
    assert.equal(result.category, 'stablecoin'); assert.equal(result.eligible, false); assert.equal(result.evidence, 'canonical-id');
  }
  for (const id of ['coingecko:jito-staked-sol', 'coinpaprika:btc-bitcoin']) assert.equal(classifyAsset(asset({ id, symbol: 'ALT' })).category, 'major');
});

test('symbol and name heuristics only filter; explicit inclusion never grants trade approval', () => {
  const result = classifyAsset(asset({ id: 'manual:fixture', symbol: 'WSTETH', name: 'Not relevant' }));
  assert.equal(result.category, 'major'); assert.equal(result.evidence, 'name-heuristic'); assert.equal(result.eligible, false);
  const included = classifyAsset(asset({ id: 'manual:fixture', symbol: 'USDC' }), { includeStablecoins: true });
  assert.equal(included.eligible, true); assert.equal(included.category, 'stablecoin'); assert.equal(included.approved, undefined);
  assert.equal(classifyAsset(asset({ symbol: 'USDC' }), { includeMajors: true }).eligible, false);
  assert.equal(classifyAsset(asset({ symbol: 'BTC' }), { includeStablecoins: true }).eligible, false);
});

test('unknown sources, missing contracts and invalid addresses cannot enter eligible universe', () => {
  for (const input of [{}, asset({ id: 'anything' }), asset({ chains: {} }), asset({ chains: { bnb: { address: '0x0' }, solana: { address: 'invalid' } } })]) assert.equal(classifyAsset(input).eligible, false);
  assert.equal(classifyAsset({}).category, 'unknown');
  assert.equal(classifyAsset(asset({ id: '', symbol: 'USDC' }), { includeStablecoins: true }).eligible, false);
});

test('conflicting known categories on two sides remain blocked even when both categories are included', () => {
  const result = classifyAsset(asset({ chains: { bnb: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' }, solana: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } }), { includeStablecoins: true, includeMajors: true });
  assert.equal(result.category, 'unknown'); assert.equal(result.eligible, false); assert(result.reasons.some(reason => reason.includes('冲突')));
});

test('fresh active indexed pools pass without claiming an exact provider last-trade timestamp', () => {
  const result = qualifyMarkets(markets(), {}, now, true);
  assert.deepEqual(result, { qualified: true, reasons: [] });
  assert.equal(result.lastTradeAt, undefined); assert.equal(result.safe, undefined);
});

test('one-sided pools, invalid prices and absent same-scan generation are rejected', () => {
  assert.equal(qualifyMarkets(markets({ solana: null }), {}, now).qualified, false);
  for (const priceUsd of [0, -1, NaN, Infinity, null, '.01']) assert.equal(qualifyMarkets(markets({ bnb: pool({ priceUsd }) }), {}, now).qualified, false);
  assert(qualifyMarkets(markets(), {}, now, false).reasons.includes('尚无同轮双链行情'));
});

test('unknown or insufficient liquidity and recent activity cannot masquerade as active markets', () => {
  for (const [field, value] of [['liquidityUsd', null], ['liquidityUsd', 19999], ['volume24hUsd', null], ['volume24hUsd', 9999], ['volume1hUsd', null], ['volume1hUsd', 99], ['trades1h', null], ['trades1h', 2], ['trades1h', 3.5]]) {
    assert.equal(qualifyMarkets(markets({ solana: pool({ [field]: value }) }), {}, now).qualified, false, field + ':' + value);
  }
});

test('explicit zero activity thresholds disable those filters while preserving price and liquidity requirements', () => {
  const options = { minVolume24hUsd: 0, minVolume1hUsd: 0, minTrades1h: 0 };
  const unknown = markets({ bnb: pool({ volume24hUsd: null, volume1hUsd: null, trades1h: null }) });
  assert.equal(qualifyMarkets(unknown, options, now).qualified, true);
  assert.equal(qualifyMarkets(markets({ bnb: pool({ liquidityUsd: null }) }), { ...options, minLiquidityUsd: 0 }, now).qualified, false);
});

test('old, future or noninteger observation times and excessive side skew remain blocked', () => {
  for (const observedAt of [now - 120001, now + 1001, null, NaN, now + .5]) assert.equal(qualifyMarkets(markets({ bnb: pool({ observedAt }) }), {}, now).qualified, false);
  const skewed = markets({ bnb: pool({ observedAt: now - 30001 }) });
  assert(qualifyMarkets(skewed, {}, now).reasons.some(reason => reason.includes('时间差')));
  assert.equal(qualifyMarkets(skewed, { maxSideSkewMs: 45000 }, now).qualified, true);
  assert.equal(qualifyMarkets(markets({ bnb: pool({ observedAt: now - 120000 }), solana: pool({ observedAt: now - 120000 }) }), {}, now).qualified, true);
});
