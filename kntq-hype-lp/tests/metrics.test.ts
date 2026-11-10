import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADDRESSES } from '../src/lib/config';
import { clearObservations, loadSettings, positionMetrics, positionPrices, recordObservations, saveSettings } from '../src/lib/metrics';
import { PROFILES } from '../src/lib/profiles';
import { connectWallet, subscribeWallet } from '../src/lib/wallet';
import type { EIP1193Provider } from 'viem';
import type { PositionState, Snapshot } from '../src/lib/types';

const account = '0x1111111111111111111111111111111111111111';
let sequence = 0;
const store = new Map<string, string>();
function fixture(): { position: PositionState; snapshot: Snapshot } {
  const position: PositionState = {
    tokenId: String(++sequence), pool: { address: '0x2222222222222222222222222222222222222222', fee: 3000, tick: 0, sqrtPriceX96: 2n ** 96n, liquidity: 1000n, tickSpacing: 60, token0: ADDRESSES.kntq, token1: ADDRESSES.whype },
    tickLower: -60, tickUpper: 60, liquidity: 1000n, amountKntq: '100', amountWhype: '100', feeKntq: '0', feeWhype: '0', inRange: true,
  };
  const snapshot: Snapshot = { blockNumber: 1n, blockTime: 1_700_000_000_000, fetchedAt: Date.now(), pool: position.pool, balances: { kntq: '0', whype: '0', hype: '0' }, positions: [position], kntqDecimals: 18, whypeDecimals: 18, rpcUrl: '', warnings: [] };
  return { position, snapshot };
}
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
});
describe('measured fee metrics', () => {
  it('does not invent annualized returns before five minutes of fee observations', () => {
    const { position, snapshot } = fixture();
    recordObservations(account, snapshot);
    snapshot.blockTime += 299_000; position.feeKntq = '1';
    recordObservations(account, snapshot);
    expect(positionMetrics(account, position, snapshot).apr).toBeNull();
  });
  it('annualizes an actual incremental fee over the observed chain interval', () => {
    const { position, snapshot } = fixture();
    recordObservations(account, snapshot);
    snapshot.blockTime += 600_000; position.feeKntq = '1';
    recordObservations(account, snapshot);
    const result = positionMetrics(account, position, snapshot, { hype: 20, fetchedAt: Date.now(), source: 'test' });
    expect(result.principalUsd).toBe(4000);
    expect(result.feesUsd).toBe(20);
    expect(result.apr).toBeCloseTo(1 / 600 * 31_536_000 / 200 * 100);
    expect(result.perSecondUsd).toBeCloseTo(20 / 600);
  });
  it('resets the observation window after claiming fees or changing liquidity', () => {
    const { position, snapshot } = fixture();
    recordObservations(account, snapshot);
    snapshot.blockTime += 600_000; position.feeKntq = '1'; recordObservations(account, snapshot);
    snapshot.blockTime += 20_000; position.feeKntq = '0'; recordObservations(account, snapshot);
    expect(positionMetrics(account, position, snapshot).apr).toBeNull();
    snapshot.blockTime += 600_000; position.feeKntq = '1'; position.liquidity = 2000n; recordObservations(account, snapshot);
    expect(positionMetrics(account, position, snapshot).apr).toBeNull();
  });
  it('isolates fee history between wallet accounts and NFT identifiers', () => {
    const { position, snapshot } = fixture();
    recordObservations(account, snapshot);
    snapshot.blockTime += 600_000; position.feeKntq = '1'; recordObservations(account, snapshot);
    expect(positionMetrics('0x3333333333333333333333333333333333333333', position, snapshot).apr).toBeNull();
  });
  it('withholds USD values when the reference price expires', () => {
    const { position, snapshot } = fixture();
    expect(positionMetrics(account, position, snapshot, { hype: 20, fetchedAt: Date.now() - 100_000, source: 'test' }).principalUsd).toBeNull();
  });
  it('handles reversed token ordering and decimal conversion for human prices', () => {
    const { position, snapshot } = fixture();
    position.pool.token0 = ADDRESSES.whype; position.pool.token1 = ADDRESSES.kntq;
    position.pool.sqrtPriceX96 = 2n ** 97n;
    const prices = positionPrices(position, snapshot);
    expect(prices.currentPrice).toBe(0.25);
    expect(prices.lowerPrice).toBeLessThan(prices.upperPrice);
  });
  it('recovers from malformed persisted settings and unavailable storage', () => {
    store.set('kntq-lp:settings:v1', '{bad');
    expect(loadSettings().rpcUrls.length).toBeGreaterThan(0);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(loadSettings().refreshSeconds).toBeGreaterThan(0);
  });
  it('keeps Elysium settings and its fixed fee separate from the legacy v3 settings key', () => {
    const v3 = { ...loadSettings(), rpcUrls: ['https://v3.example'], slippageBps: 25 };
    saveSettings(v3);
    expect(loadSettings('elysium-v4').rpcUrls).toEqual(PROFILES['elysium-v4'].defaults.rpcUrls);
    const v4 = { ...loadSettings('elysium-v4'), fee: 500, rpcUrls: ['https://v4.example'], slippageBps: 75 };
    saveSettings(v4, 'elysium-v4');
    expect(loadSettings()).toMatchObject({ rpcUrls: ['https://v3.example'], slippageBps: 25 });
    expect(loadSettings('elysium-v4')).toMatchObject({ rpcUrls: ['https://v4.example'], fee: 10000, slippageBps: 75 });
    expect(store.has('kntq-lp:settings:v1')).toBe(true);
    expect(store.has('kntq-lp:settings:v1:elysium-v4')).toBe(true);
  });
  it('does not reuse a same-numbered NFT fee sample from a different chain or manager', () => {
    const { position, snapshot } = fixture();
    recordObservations(account, snapshot);
    snapshot.blockTime += 600_000; position.feeKntq = '1'; recordObservations(account, snapshot);
    expect(positionMetrics(account, position, snapshot).apr).not.toBeNull();
    const v4 = { ...snapshot, chainId: 99901, manager: PROFILES['elysium-v4'].manager, kntqAddress: PROFILES['elysium-v4'].kntq, quoteSymbol: 'HYPE' as const };
    expect(positionMetrics(account, position, v4).apr).toBeNull();
    const otherManager = { ...snapshot, manager: '0x4444444444444444444444444444444444444444' as const };
    expect(positionMetrics(account, position, otherManager).apr).toBeNull();
    recordObservations(account, v4);
    expect([...store.keys()].some((key) => key.includes(`:99901:${PROFILES['elysium-v4'].manager.toLowerCase()}:`))).toBe(true);
    clearObservations(account, v4);
    expect(positionMetrics(account, position, snapshot).apr).not.toBeNull();
  });
  it('uses the Elysium token address and native HYPE ordering when deriving prices', () => {
    const { position, snapshot } = fixture();
    snapshot.kntqAddress = PROFILES['elysium-v4'].kntq;
    position.pool.token0 = '0x0000000000000000000000000000000000000000';
    position.pool.token1 = snapshot.kntqAddress;
    position.pool.sqrtPriceX96 = 2n ** 97n;
    expect(positionPrices(position, snapshot).currentPrice).toBe(0.25);
    position.pool.token0 = snapshot.kntqAddress;
    position.pool.token1 = '0xffffffffffffffffffffffffffffffffffffffff';
    expect(positionPrices(position, snapshot).currentPrice).toBe(4);
  });
  it('does not count USD or pool-price appreciation of existing fees as fee income', () => {
    const { position, snapshot } = fixture();
    position.feeKntq = '1'; position.feeWhype = '1';
    recordObservations(account, snapshot);
    expect(positionMetrics(account, position, snapshot, { hype: 30, fetchedAt: Date.now(), source: 'test' }).apr).toBeNull();
    snapshot.blockTime += 600_000;
    position.pool.sqrtPriceX96 = 2n ** 97n;
    recordObservations(account, snapshot);
    const result = positionMetrics(account, position, snapshot, { hype: 33, fetchedAt: Date.now(), source: 'test' });
    expect(result.feesUsd).toBe(165);
    expect(result.apr).toBe(0);
    expect(result.perSecondUsd).toBe(0);
  });
  it('explicitly clears claimed fee history without depending on the next observed fee decrease', () => {
    const { position, snapshot } = fixture();
    recordObservations(account, snapshot);
    snapshot.blockTime += 600_000; position.feeKntq = '1'; recordObservations(account, snapshot);
    expect(positionMetrics(account, position, snapshot).apr).not.toBeNull();
    clearObservations(account, snapshot, position.tokenId);
    expect(positionMetrics(account, position, snapshot).apr).toBeNull();
  });
});

describe('profile-specific wallet connection', () => {
  it('adds and verifies the selected network without signing or sending any transaction', async () => {
    const calls: Array<{method:string;params?:unknown}> = [];
    let chain = '0x3e7'; let unknownChain = true;
    const provider = { async request(args: {method:string;params?:unknown}) {
      calls.push(args);
      if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') return [account];
      if (args.method === 'eth_chainId') return chain;
      if (args.method === 'wallet_switchEthereumChain') {
        if (unknownChain) { unknownChain = false; throw Object.assign(new Error('unknown chain'), {code:4902}); }
        chain = '0x1863d'; return null;
      }
      if (args.method === 'wallet_addEthereumChain') return null;
      throw new Error(`Unexpected method ${args.method}`);
    } } as unknown as EIP1193Provider;
    expect(await connectWallet(provider, PROFILES['elysium-v4'])).toBe(account);
    expect(calls.find((call) => call.method === 'wallet_addEthereumChain')?.params).toEqual([expect.objectContaining({
      chainId:'0x1863d', chainName:'Elysium', rpcUrls: PROFILES['elysium-v4'].chain.rpcUrls.default.http,
      blockExplorerUrls:[PROFILES['elysium-v4'].explorer], nativeCurrency:{name:'HYPE',symbol:'HYPE',decimals:18},
    })]);
    expect(calls.some((call) => /sign|sendTransaction/.test(call.method))).toBe(false);
  });
  it('rejects a network change during the final account query', async () => {
    let chain = '0x1863d';
    const provider = { async request({method}: {method:string}) {
      if (method === 'eth_requestAccounts') return [account];
      if (method === 'eth_chainId') return chain;
      if (method === 'eth_accounts') { chain = '0x3e7'; return [account]; }
      throw new Error('Unexpected request');
    } } as unknown as EIP1193Provider;
    await expect(connectWallet(provider, PROFILES['elysium-v4'])).rejects.toThrow('网络已变化');
  });
  it('invalidates the caller synchronously on an account or chain event', () => {
    const listeners = new Map<string, () => void>();
    const changed = vi.fn();
    const provider = { request: vi.fn(), on: (event:string, listener:()=>void) => listeners.set(event, listener), removeListener: (event:string) => listeners.delete(event) } as unknown as EIP1193Provider;
    const unsubscribe = subscribeWallet(provider, changed);
    listeners.get('accountsChanged')?.(); expect(changed).toHaveBeenCalledTimes(1);
    listeners.get('chainChanged')?.(); expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe(); expect(listeners.size).toBe(0);
  });
});
