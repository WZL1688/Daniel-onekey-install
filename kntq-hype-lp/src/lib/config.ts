import { defineChain, getAddress } from 'viem';
import type { Settings } from './types';

export const CHAIN_ID = 999;
export const ADDRESSES = {
  kntq: getAddress('0x000000000000780555bd0bca3791f89f9542c2d6'),
  whype: getAddress('0x5555555555555555555555555555555555555555'),
  factory: getAddress('0xf0db7b58379503491d857db50ac9ece64c653918'),
  manager: getAddress('0x39654a85a4c05127f5fd6ed22caec077a0fb1377'),
} as const;
export const hyperEvm = defineChain({
  id: CHAIN_ID, name: 'HyperEVM', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.hyperliquid.xyz/evm'] } },
  blockExplorers: { default: { name: 'Hypurrscan', url: 'https://hypurrscan.io' } },
});
export const DEFAULT_SETTINGS: Settings = {
  rpcUrls: ['https://rpc.hyperliquid.xyz/evm', 'https://hyperliquid-json-rpc.stakely.io'],
  fee: 3000, slippageBps: 50, staleSeconds: 90, refreshSeconds: 60,
  gasReserveHype: '0.02', trackedIds: [],
};
export const EXPLORER = 'https://hypurrscan.io';
export const SOURCES = {
  uniswap: 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-hyperevm-deployments',
  kntq: 'https://docs.chain.link/ccip/directory/mainnet/token/KNTQ',
  whype: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/wrapped-hype',
};
