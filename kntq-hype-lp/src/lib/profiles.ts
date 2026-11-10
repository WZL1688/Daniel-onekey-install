import type { Chain } from 'viem';
import type { ProfileId, Settings } from './types';
import * as v3 from './config';
import * as v4 from '../elysium/config';

export interface WorkspaceProfile { id: ProfileId; name: string; chainId: number; protocol: 'v3' | 'v4'; chain: Chain; quoteSymbol: 'WHYPE' | 'HYPE'; manager: `0x${string}`; kntq: `0x${string}`; addresses: Record<string, `0x${string}`>; explorer: string; source: string; defaults: Settings; }
export const PROFILES: Record<ProfileId, WorkspaceProfile> = {
  'hyperevm-v3': { id: 'hyperevm-v3', name: 'HyperEVM', chainId: 999, protocol: 'v3', chain: v3.hyperEvm, quoteSymbol: 'WHYPE', manager: v3.ADDRESSES.manager, kntq: v3.ADDRESSES.kntq, addresses: v3.ADDRESSES, explorer: v3.EXPLORER, source: v3.SOURCES.uniswap, defaults: v3.DEFAULT_SETTINGS },
  'elysium-v4': { id: 'elysium-v4', name: 'Elysium', chainId: 99901, protocol: 'v4', chain: v4.elysium, quoteSymbol: 'HYPE', manager: v4.ADDRESSES.manager, kntq: v4.ADDRESSES.kntq, addresses: v4.ADDRESSES, explorer: v4.EXPLORER, source: v4.OFFICIAL_DEPLOYMENT_SOURCE, defaults: v4.DEFAULT_SETTINGS },
};
