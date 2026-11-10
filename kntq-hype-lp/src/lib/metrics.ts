import type { Address } from 'viem';
import { ADDRESSES, CHAIN_ID } from './config';
import { PROFILES } from './profiles';
import type { FeeObservation, PositionState, ProfileId, Settings, Snapshot, UsdPrice } from './types';

const SETTINGS_KEY = 'kntq-lp:settings:v1';
const WINDOW_MS = 24 * 60 * 60 * 1_000;
const MIN_SAMPLE_MS = 300_000;
const PRICE_MAX_AGE_MS = 90_000;
const historyMemory = new Map<string, FeeObservation[]>();

function storageRead(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function storageWrite(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* Private mode/full disk: session memory still works. */ }
}
function settingsKey(profileId: ProfileId): string { return profileId === 'hyperevm-v3' ? SETTINGS_KEY : `kntq-lp:settings:v1:${profileId}`; }
function defaults(profileId: ProfileId): Settings {
  const value = PROFILES[profileId].defaults;
  return { ...value, rpcUrls: [...value.rpcUrls], trackedIds: [...value.trackedIds] };
}
function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
export function loadSettings(profileId: ProfileId = 'hyperevm-v3'): Settings {
  const fallback = defaults(profileId);
  try {
    const raw = JSON.parse(storageRead(settingsKey(profileId)) ?? 'null') as Partial<Settings> | null;
    if (!raw || typeof raw !== 'object') return fallback;
    const rpcUrls = Array.isArray(raw.rpcUrls) ? raw.rpcUrls.filter((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url)).slice(0, 8) : [];
    return {
      rpcUrls: rpcUrls.length ? rpcUrls : fallback.rpcUrls,
      fee: profileId === 'elysium-v4' ? fallback.fee : [100, 500, 3000, 10000].includes(Number(raw.fee)) ? Number(raw.fee) : fallback.fee,
      slippageBps: Math.round(boundedNumber(raw.slippageBps, fallback.slippageBps, 1, 500)),
      staleSeconds: boundedNumber(raw.staleSeconds, fallback.staleSeconds, 15, 300),
      refreshSeconds: boundedNumber(raw.refreshSeconds, fallback.refreshSeconds, 10, 300),
      gasReserveHype: typeof raw.gasReserveHype === 'string' && /^\d+(\.\d{1,18})?$/.test(raw.gasReserveHype) ? raw.gasReserveHype : fallback.gasReserveHype,
      trackedIds: Array.isArray(raw.trackedIds) ? [...new Set(raw.trackedIds.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id)))].slice(0, 200) : [],
    };
  } catch { return fallback; }
}
export function saveSettings(settings: Settings, profileId: ProfileId = 'hyperevm-v3'): void {
  storageWrite(settingsKey(profileId), JSON.stringify(profileId === 'elysium-v4' ? { ...settings, fee: PROFILES[profileId].defaults.fee } : settings));
}

function historyPrefix(account: Address, snapshot: Snapshot): string {
  return `kntq-lp:fees:v1:${snapshot.chainId ?? CHAIN_ID}:${(snapshot.manager ?? ADDRESSES.manager).toLowerCase()}:${account.toLowerCase()}:`;
}
function historyKey(account: Address, tokenId: string, snapshot: Snapshot): string {
  return historyPrefix(account, snapshot) + tokenId;
}
function validObservation(value: unknown): value is FeeObservation {
  const item = value as FeeObservation | null;
  return !!item && typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0
    && typeof item.kntq === 'number' && Number.isFinite(item.kntq) && item.kntq >= 0
    && typeof item.whype === 'number' && Number.isFinite(item.whype) && item.whype >= 0
    && typeof item.liquidity === 'string' && /^\d+$/.test(item.liquidity);
}
function readHistory(key: string): FeeObservation[] {
  if (historyMemory.has(key)) return historyMemory.get(key)!;
  try {
    const parsed = JSON.parse(storageRead(key) ?? '[]') as unknown;
    const valid = Array.isArray(parsed) ? parsed.filter(validObservation).sort((a, b) => a.at - b.at).slice(-500) : [];
    historyMemory.set(key, valid);
    return valid;
  } catch { historyMemory.set(key, []); return []; }
}
function observation(position: PositionState, snapshot: Snapshot): FeeObservation {
  return { at: snapshot.blockTime, kntq: Number(position.feeKntq), whype: Number(position.feeWhype), liquidity: position.liquidity.toString() };
}
function sameAccrualSegment(previous: FeeObservation, next: FeeObservation): boolean {
  return previous.liquidity === next.liquidity && next.kntq >= previous.kntq && next.whype >= previous.whype;
}
export function recordObservations(account: Address, snapshot: Snapshot): void {
  for (const position of snapshot.positions) {
    const next = observation(position, snapshot);
    if (!validObservation(next) || position.liquidity === 0n) continue;
    const key = historyKey(account, position.tokenId, snapshot);
    let history = readHistory(key);
    const previous = history.at(-1);
    if (previous && next.at <= previous.at) continue;
    if (previous && !sameAccrualSegment(previous, next)) history = [];
    history = [...history.filter((point) => point.at >= next.at - WINDOW_MS), next].slice(-500);
    historyMemory.set(key, history);
    storageWrite(key, JSON.stringify(history));
  }
}

/** A confirmed claim or withdrawal starts a new accrual segment, scoped to its chain and manager. */
export function clearObservations(account: Address, snapshot: Snapshot, tokenId?: string): void {
  const prefix = historyPrefix(account, snapshot);
  const keys = new Set(tokenId ? [prefix + tokenId] : [
    ...[...historyMemory.keys()].filter((key) => key.startsWith(prefix)),
    ...snapshot.positions.map((position) => prefix + position.tokenId),
  ]);
  if (!tokenId) {
    try {
      const storage = globalThis.localStorage;
      for (let index = 0; storage && index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) keys.add(key);
      }
    } catch { /* A storage failure cannot erase the session's independent reset. */ }
  }
  for (const key of keys) { historyMemory.set(key, []); storageWrite(key, '[]'); }
}

export interface PositionMetrics {
  principalUsd: number | null; feesUsd: number | null; apr: number | null; perSecondUsd: number | null;
  sampleSeconds: number; lowerPrice: number; upperPrice: number; currentPrice: number;
}
/** Human price is quote per KNTQ: WHYPE on v3, native HYPE on Elysium v4. */
export function positionPrices(position: PositionState, snapshot: Pick<Snapshot, 'kntqDecimals' | 'whypeDecimals' | 'kntqAddress'>): { lowerPrice: number; upperPrice: number; currentPrice: number } {
  const kntqIsToken0 = position.pool.token0.toLowerCase() === (snapshot.kntqAddress ?? ADDRESSES.kntq).toLowerCase();
  const decimalFactor = 10 ** (kntqIsToken0 ? snapshot.kntqDecimals - snapshot.whypeDecimals : snapshot.whypeDecimals - snapshot.kntqDecimals);
  const orient = (ratio: number) => kntqIsToken0 ? ratio * decimalFactor : 1 / (ratio * decimalFactor);
  const priceA = orient(1.0001 ** position.tickLower);
  const priceB = orient(1.0001 ** position.tickUpper);
  const sqrtRatio = Number(position.pool.sqrtPriceX96) / 2 ** 96;
  return { lowerPrice: Math.min(priceA, priceB), upperPrice: Math.max(priceA, priceB), currentPrice: orient(sqrtRatio ** 2) };
}

export function positionMetrics(account: Address, position: PositionState, snapshot: Snapshot, usdPrice?: UsdPrice): PositionMetrics {
  const prices = positionPrices(position, snapshot);
  const principalHype = Number(position.amountKntq) * prices.currentPrice + Number(position.amountWhype);
  const feesHype = Number(position.feeKntq) * prices.currentPrice + Number(position.feeWhype);
  const priceAge = usdPrice ? Date.now() - usdPrice.fetchedAt : Infinity;
  const usd = usdPrice && priceAge >= -5_000 && priceAge <= PRICE_MAX_AGE_MS && usdPrice.hype > 0 && Number.isFinite(usdPrice.hype) ? usdPrice.hype : null;
  const current = observation(position, snapshot);
  let sampleSeconds = 0;
  let apr: number | null = null;
  let perSecondHype: number | null = null;
  const history = readHistory(historyKey(account, position.tokenId, snapshot)).filter((point) => point.at <= current.at && point.at >= current.at - WINDOW_MS);
  const recent = history.at(-1);
  if (validObservation(current) && recent && sameAccrualSegment(recent, current) && position.liquidity > 0n) {
    // Work backwards so an imported/corrupt discontinuous history never spans a claim or liquidity change.
    let baseline = current;
    for (let index = history.length - 1; index >= 0; index--) {
      const point = history[index];
      if (!sameAccrualSegment(point, baseline)) break;
      baseline = point;
    }
    sampleSeconds = Math.max(0, (current.at - baseline.at) / 1_000);
    if (current.at - baseline.at >= MIN_SAMPLE_MS && Number.isFinite(principalHype) && principalHype > 0 && Number.isFinite(prices.currentPrice) && prices.currentPrice > 0) {
      const delta = (current.kntq - baseline.kntq) * prices.currentPrice + current.whype - baseline.whype;
      if (Number.isFinite(delta) && delta >= 0) {
        perSecondHype = delta / sampleSeconds;
        apr = perSecondHype * 365 * 24 * 60 * 60 / principalHype * 100;
      }
    }
  }
  return {
    ...prices, sampleSeconds,
    principalUsd: usd !== null && Number.isFinite(principalHype) && prices.currentPrice > 0 ? principalHype * usd : null,
    feesUsd: usd !== null && Number.isFinite(feesHype) && prices.currentPrice > 0 ? feesHype * usd : null,
    apr, perSecondUsd: usd !== null && perSecondHype !== null ? perSecondHype * usd : null,
  };
}

/** Hyperliquid perpetual order-book mid, an indicative USD reference rather than a redemption oracle. */
export async function loadUsdPrice(): Promise<UsdPrice> {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }), signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`HYPE 美元参考价请求失败（HTTP ${response.status}）。`);
  const mids = await response.json() as Record<string, unknown>;
  const hype = Number(mids.HYPE);
  if (!Number.isFinite(hype) || hype <= 0) throw new Error('Hyperliquid 未返回有效的 HYPE 中间价。');
  return { hype, fetchedAt: Date.now(), source: 'Hyperliquid HYPE 永续中间价（USD 参考）' };
}
