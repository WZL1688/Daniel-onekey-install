import { getAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import wrappedSnapshot from './data/wormhole-candidates.json' with { type: 'json' };

// These labels control which observations are scanned. They never establish
// that two contracts are fungible, redeemable, safe, or approved for trading.
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'USDD', 'USDP', 'FDUSD', 'PYUSD', 'USDE', 'SUSDE', 'USDS', 'SUSDS', 'GUSD', 'LUSD', 'CRVUSD', 'FRAX', 'USDC.E', 'USDT.E', 'USD0', 'USD1']);
const MAJOR_SYMBOLS = new Set(['BTC', 'WBTC', 'TBTC', 'RENBTC', 'BTCB', 'CBBTC', 'LBTC', 'ETH', 'WETH', 'STETH', 'WSTETH', 'RETH', 'CBETH', 'WEETH', 'EZETH', 'RSETH', 'WBETH', 'SWETH', 'FRXETH', 'SFRXETH', 'ANKRETH', 'OSETH', 'BNB', 'WBNB', 'SLISBNB', 'BNBX', 'SOL', 'WSOL', 'MSOL', 'JITOSOL', 'BNSOL', 'BBSOL', 'JUPSOL', 'DSOL']);
const STABLE_IDS = new Set(['usd-coin', 'tether', 'dai', 'binance-usd', 'true-usd', 'trueusd', 'frax', 'usdd', 'pax-dollar', 'first-digital-usd', 'paypal-usd', 'ethena-usde', 'ethena-staked-usde', 'usual-usd', 'usual-usd0', 'usds', 'savings-usds', 'gemini-dollar', 'liquity-usd', 'crvusd', 'usd1-wlfi', 'usdt-tether', 'usdc-usd-coin', 'dai-dai', 'busd-binance-usd', 'tusd-trueusd', 'fdusd-first-digital-usd', 'pyusd-paypal-usd', 'usdd-usdd', 'frax-frax']);
const MAJOR_IDS = new Set(['bitcoin', 'wrapped-bitcoin', 'bitcoin-bep2', 'ethereum', 'weth', 'binancecoin', 'wbnb', 'solana', 'wrapped-solana', 'staked-ether', 'wrapped-steth', 'rocket-pool-eth', 'coinbase-wrapped-staked-eth', 'wrapped-eeth', 'ether-fi-staked-eth', 'renbtc', 'tbtc', 'binance-peg-ethereum', 'binance-peg-btc', 'binance-staked-sol', 'jito-staked-sol', 'msol', 'marinade-staked-sol', 'jupiter-staked-sol', 'binance-eth', 'btc-bitcoin', 'eth-ethereum', 'bnb-binance-coin', 'sol-solana', 'weth-weth', 'wbtc-wrapped-bitcoin']);

const categoryForSymbol = symbol => STABLE_SYMBOLS.has(symbol) ? 'stablecoin' : MAJOR_SYMBOLS.has(symbol) ? 'major' : null;
const validIdentity = asset => typeof asset?.id === 'string' && /^(?:manual:[A-Za-z0-9_-]{1,100}|coingecko:[a-z0-9-]{1,100}|coinpaprika:[a-z0-9-]{1,100}|wormhole:[a-f0-9]{40}|project:[a-z0-9-]{1,100})$/.test(asset.id);
const addressKey = (chain, address) => `${chain}:${chain === 'bnb' || /^0x/i.test(address) ? address.toLowerCase() : address}`;
const knownAddresses = new Map(), knownOrigins = new Map();
for (const row of wrappedSnapshot.candidates) {
  const category = categoryForSymbol(String(row.symbol || '').toUpperCase());
  if (!category) continue;
  for (const chain of ['bnb', 'solana']) if (row.chains?.[chain]?.address) knownAddresses.set(addressKey(chain, row.chains[chain].address), category);
  if (row.origin?.chain && row.origin?.address) knownOrigins.set(addressKey(row.origin.chain.toLowerCase(), row.origin.address), category);
}
// Native USDC and Binance-pegged stable/native addresses supplement the
// historical Wormhole mapping. Exact addresses take priority over display text.
for (const [chain, address, category] of [
  ['bnb', '0x55d398326f99059ff775485246999027b3197955', 'stablecoin'],
  ['bnb', '0xe9e7cea3dedca5984780bafc599bd69add087d56', 'stablecoin'],
  ['bnb', '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', 'stablecoin'],
  ['bnb', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', 'major'],
]) knownAddresses.set(addressKey(chain, address), category);

function validContracts(asset) {
  try {
    const bnb = asset?.chains?.bnb?.address, solana = asset?.chains?.solana?.address;
    if (typeof bnb !== 'string' || typeof solana !== 'string' || bnb.length > 100 || solana.length > 100 || /^0x0{40}$/i.test(bnb)) return false;
    getAddress(bnb); new PublicKey(solana); return true;
  } catch { return false; }
}

export function classifyAsset(asset, settings = {}) {
  let category = 'unknown', evidence = 'none';
  const matches = new Set();
  for (const chain of ['bnb', 'solana']) {
    const address = asset?.chains?.[chain]?.address;
    if (typeof address === 'string') {
      const match = knownAddresses.get(addressKey(chain, address)); if (match) matches.add(match);
    }
  }
  if (typeof asset?.origin?.chain === 'string' && typeof asset.origin.address === 'string') {
    const match = knownOrigins.get(addressKey(asset.origin.chain.toLowerCase(), asset.origin.address)); if (match) matches.add(match);
  }
  if (matches.size > 1) return { category: 'unknown', eligible: false, reasons: ['两链已知资产类别冲突，需核对同币关系'], evidence: 'known-address' };
  if (matches.size) { category = [...matches][0]; evidence = 'known-address'; }
  else {
    const id = typeof asset?.id === 'string' ? asset.id : '';
    const canonical = /^(?:coingecko|coinpaprika):([a-z0-9-]{1,100})$/.exec(id)?.[1];
    if (canonical && (STABLE_IDS.has(canonical) || MAJOR_IDS.has(canonical))) { category = STABLE_IDS.has(canonical) ? 'stablecoin' : 'major'; evidence = 'canonical-id'; }
    else {
      const symbol = typeof asset?.symbol === 'string' ? asset.symbol.trim().toUpperCase() : '';
      const name = typeof asset?.name === 'string' ? asset.name.trim().toLowerCase() : '';
      const bySymbol = categoryForSymbol(symbol);
      const byName = ['usd coin', 'tether', 'binance usd', 'dai stablecoin', 'paypal usd'].includes(name) ? 'stablecoin' : ['bitcoin', 'wrapped bitcoin', 'ethereum', 'wrapped ether', 'wrapped ethereum', 'bnb', 'wrapped bnb', 'solana', 'wrapped solana', 'staked ether', 'wrapped staked ether'].includes(name) ? 'major' : null;
      if (bySymbol || byName) { category = bySymbol || byName; evidence = 'name-heuristic'; }
      else if (validContracts(asset) && validIdentity(asset)) { category = 'altcoin'; evidence = id.startsWith('manual:') ? 'manual' : 'directory'; }
    }
  }
  const reasons = [];
  if (!validContracts(asset)) reasons.push('两链合约地址不完整或无效');
  if (!validIdentity(asset)) reasons.push('缺少可追溯资产身份');
  if (category === 'unknown') reasons.push('资产类别或同币来源尚未核验');
  if (category === 'stablecoin' && settings?.includeStablecoins !== true) reasons.push('默认排除稳定币');
  if (category === 'major' && settings?.includeMajors !== true) reasons.push('默认排除 BTC／ETH／BNB／SOL 及其包装或质押表示');
  return { category, eligible: reasons.length === 0, reasons, evidence };
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const setting = (settings, key, fallback) => finite(settings?.[key]) && settings[key] >= 0 ? settings[key] : fallback;

/** Tests indexed pool observations, not chain execution or exact last-trade time. */
export function qualifyMarkets(markets, settings = {}, now = Date.now(), generationValid = true) {
  const reasons = [], present = [];
  if (!generationValid) reasons.push('尚无同轮双链行情');
  const minimums = [
    ['liquidityUsd', 'minLiquidityUsd', 20000, '流动性'],
    ['volume24hUsd', 'minVolume24hUsd', 10000, '24小时成交额'],
    ['volume1hUsd', 'minVolume1hUsd', 100, '1小时成交额'],
    ['trades1h', 'minTrades1h', 3, '1小时成交笔数'],
  ];
  for (const chain of ['bnb', 'solana']) {
    const pool = markets?.[chain], label = chain === 'bnb' ? 'BNB' : 'Solana';
    if (!pool) { reasons.push(`${label} 缺少有效池行情`); continue; }
    present.push(pool);
    if (!finite(pool.priceUsd) || pool.priceUsd <= 0) reasons.push(`${label} 价格未知或无效`);
    if (!finite(now) || !Number.isSafeInteger(pool.observedAt) || pool.observedAt < 0 || now - pool.observedAt > 120000 || pool.observedAt > now + 1000) reasons.push(`${label} 行情超过120秒或时间异常`);
    for (const [field, key, fallback, description] of minimums) {
      const min = setting(settings, key, fallback), value = pool[field];
      // An explicit zero disables that activity filter for diagnostics/legacy
      // fixtures; omitted/unknown metrics never satisfy a positive threshold.
      if (min === 0 && field !== 'liquidityUsd') continue;
      if (!finite(value) || value < 0 || (field === 'trades1h' && !Number.isSafeInteger(value)) || value < min) reasons.push(`${label} ${description}未知或不足`);
    }
  }
  if (present.length === 2 && present.every(pool => Number.isSafeInteger(pool.observedAt)) && Math.abs(present[0].observedAt - present[1].observedAt) > setting(settings, 'maxSideSkewMs', 30000)) reasons.push('两侧行情采样时间差过大');
  return { qualified: reasons.length === 0, reasons: [...new Set(reasons)] };
}
