import { getAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';

// CoinPaprika contract-platform identifiers, not EVM chain IDs or symbols.
export const PAPRIKA_PLATFORMS = Object.freeze({ bnb: 'bnb-binance-coin', solana: 'sol-solana' });
const MAX_ROWS = 50000;
const COIN_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const formatError = () => Object.assign(new Error('同币合约目录格式无效'), { safe: true, code: 'DISCOVERY_FORMAT' });
const validTime = value => Number.isSafeInteger(value) && value >= Date.UTC(2009, 0, 1);
const addressKey = (chain, address) => chain === 'bnb' ? address.toLowerCase() : address;

function addressFor(chain, value) {
  if (!Object.hasOwn(PAPRIKA_PLATFORMS, chain) || typeof value !== 'string' || value.length > 128) return null;
  try {
    const address = chain === 'bnb' ? getAddress(value.trim()) : new PublicKey(value.trim()).toBase58();
    return chain === 'bnb' && /^0x0{40}$/i.test(address) ? null : address;
  } catch { return null; }
}

function cleanCatalog(rows, chain, normalized = false) {
  if (!Object.hasOwn(PAPRIKA_PLATFORMS, chain) || !Array.isArray(rows) || rows.length > MAX_ROWS) throw formatError();
  const unique = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.active === false) continue;
    // HTTP responses are normalized from `id` only. The join also accepts our
    // already-normalized { coinId, address } entries, without trusting symbols.
    const coinId = Object.hasOwn(row, 'id') ? row.id : normalized ? row.coinId : undefined;
    if (typeof coinId !== 'string' || !COIN_ID.test(coinId)) continue;
    const address = addressFor(chain, row.address);
    if (!address) continue;
    unique.set(`${coinId}:${addressKey(chain, address)}`, { coinId, address });
  }
  return [...unique.values()];
}

/** Strip remote fields; no ticker, URL, approval, fee or safety claim survives. */
export function normalizeContractCatalog(rows, { chain } = {}) {
  return cleanCatalog(rows, chain);
}

/**
 * Join only the provider's canonical coin ID. All conflicts in both complete
 * bounded inputs are quarantined before selecting the first result page.
 */
export function mergeContractCatalogs({ bnb, solana, observedAt = Date.now(), limit = 300 } = {}) {
  if (!validTime(observedAt) || !Number.isInteger(limit) || limit < 1 || limit > 300) throw formatError();
  const byChain = { bnb: new Map(), solana: new Map() }, conflicts = new Set();
  for (const chain of ['bnb', 'solana']) {
    const addresses = new Map();
    for (const { coinId, address } of cleanCatalog(chain === 'bnb' ? bnb : solana, chain, true)) {
      const key = addressKey(chain, address), previous = byChain[chain].get(coinId);
      if (previous && addressKey(chain, previous) !== key) conflicts.add(coinId);
      else byChain[chain].set(coinId, address);
      const owner = addresses.get(key);
      if (owner && owner !== coinId) { conflicts.add(owner); conflicts.add(coinId); }
      else addresses.set(key, coinId);
    }
  }
  return [...byChain.bnb.entries()]
    .filter(([coinId]) => byChain.solana.has(coinId) && !conflicts.has(coinId))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, limit)
    .map(([coinId, address]) => ({
      id: `coinpaprika:${coinId}`, name: coinId, symbol: coinId.split('-')[0].toUpperCase().slice(0, 32),
      source: 'coinpaprika', sourceKind: 'remote', sourceRef: `https://coinpaprika.com/coin/${coinId}`,
      evidenceKind: 'provider-coin-id',
      chains: { bnb: { address }, solana: { address: byChain.solana.get(coinId) } }, observedAt,
    }));
}

/** Issuer-published address facts only; not a price or execution approval. */
export function projectDirectory({ observedAt = Date.now() } = {}) {
  if (!validTime(observedAt)) throw formatError();
  return [{
    id: 'project:babydoge', name: 'BabyDoge', symbol: 'BABYDOGE', source: 'project', sourceKind: 'issuer',
    sourceRef: 'https://babydoge.com/transparency/', sourceDate: '2026-11-22', evidenceKind: 'issuer-published-addresses',
    chains: {
      bnb: { address: '0xc748673057861a797275CD8A068AbB95A902e8de' },
      solana: { address: '7dUKUopcNWW6CcU4eRxCHh1uiMh32zDrmGf6ufqhxann' },
    }, observedAt,
  }];
}
