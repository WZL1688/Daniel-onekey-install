import type { Address, EIP1193Provider, Hex } from 'viem';
import type { ExecutionEvent, OpenInput, PositionState, ProfileId, RpcHealth, Settings, Snapshot, TxPlan, TxStep } from './types';
import * as v3Read from './chain';
import * as v3Tx from './transactions';
import * as v4Read from '../elysium/chain';
import * as v4Tx from '../elysium/transactions';
import { PROFILES } from './profiles';

export interface ProtocolAdapter {
  loadSnapshot(settings: Settings, account?: Address, onHealth?: (health: RpcHealth) => void): Promise<Snapshot>;
  prepareOpen(settings: Settings, snapshot: Snapshot, account: Address, input: OpenInput): Promise<TxPlan>;
  prepareCollect(settings: Settings, snapshot: Snapshot, account: Address, position: PositionState): Promise<TxPlan>;
  prepareExit(settings: Settings, snapshot: Snapshot, account: Address, position: PositionState): Promise<TxPlan>;
  simulateStep(settings: Settings, plan: TxPlan, step: TxStep): Promise<{ gas: bigint }>;
  executePlan(plan: TxPlan, settings: Settings, provider: EIP1193Provider, onEvent: (event: ExecutionEvent) => void, shouldContinue?: () => boolean): Promise<void>;
  readPosition?: (settings: Settings, account: Address, tokenId: string) => Promise<PositionState>;
  reconcilePending?: (settings: Settings, account: Address, knownHash?: Hex) => Promise<{ blocked: boolean; hash?: Hex; reason?: string }>;
}
const v3: ProtocolAdapter = {
  ...v3Tx,
  async loadSnapshot(settings, account, onHealth) {
    const snapshot = await v3Read.loadSnapshot(settings, account, onHealth);
    return { ...snapshot, profile: 'hyperevm-v3', chainId: 999, manager: PROFILES['hyperevm-v3'].manager, kntqAddress: PROFILES['hyperevm-v3'].kntq, quoteSymbol: 'WHYPE', positionsComplete: true };
  },
};
const v4: ProtocolAdapter = {
  ...v4Tx,
  loadSnapshot: v4Read.loadSnapshot,
  async readPosition(settings, account, tokenId) {
    if (!/^[1-9]\d{0,77}$/.test(tokenId) || BigInt(tokenId) > (1n << 256n) - 1n) throw new Error('TokenId 必须是有效的正整数');
    return v4Read.readPosition(settings, account, tokenId);
  },
};
export function getAdapter(profile: ProfileId): ProtocolAdapter {
  if (profile === 'hyperevm-v3') return v3;
  if (profile === 'elysium-v4') return v4;
  throw new Error('未知网络与协议配置');
}
