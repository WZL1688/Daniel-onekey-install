import { defineChain, getAddress, zeroAddress } from 'viem';
import type { Settings } from '../lib/types';
import deploymentSource from './deployment-source.json';

export const CHAIN_ID = 99901;
export const ADDRESSES = {
  kntq: getAddress('0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0'),
  whype: getAddress('0xba876237b0f021a6c6d852d6c26e107997cc5e81'),
  poolManager: getAddress('0xe2e105d3f7209a9da11f83ccf3e7398a753823f1'),
  manager: getAddress('0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518'),
  stateView: getAddress('0x27ed73ae0652fdcf71d6793412a7525f32be9dfe'),
  permit2: getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3'),
} as const;
export const POOL_KEY = { currency0: zeroAddress, currency1: ADDRESSES.kntq, fee: 10000, tickSpacing: 200, hooks: zeroAddress } as const;
export const POOL_ID = '0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac' as const;
export const EXPLORER = 'https://elysium.kinetiq.xyz/explorer';
export const OFFICIAL_DEPLOYMENT_SOURCE = deploymentSource.source;
export const DEFAULT_SETTINGS: Settings = { rpcUrls: ['https://rpc.elysium.kinetiq.xyz', 'https://node.eleos.fun', 'https://rpc-live.boxa.club'], fee: 10000, slippageBps: 50, staleSeconds: 90, refreshSeconds: 60, gasReserveHype: '0.08', trackedIds: [] };
export const elysium = defineChain({ id: CHAIN_ID, name: 'Elysium', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: DEFAULT_SETTINGS.rpcUrls } }, blockExplorers: { default: { name: 'Elysium Explorer', url: EXPLORER } } });
