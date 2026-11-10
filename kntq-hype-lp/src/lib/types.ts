import type { Address, Hex } from 'viem';

export type ProfileId = 'hyperevm-v3' | 'elysium-v4';

export interface Settings { rpcUrls: string[]; fee: number; slippageBps: number; staleSeconds: number; refreshSeconds: number; gasReserveHype: string; trackedIds: string[]; }
export interface RpcHealth { url: string; ok: boolean; latencyMs: number; error?: string; }
export interface PoolState { address: Address; fee: number; tick: number; sqrtPriceX96: bigint; liquidity: bigint; tickSpacing: number; token0: Address; token1: Address; poolId?: Hex; hooks?: Address; }
export interface PositionState { tokenId: string; pool: PoolState; tickLower: number; tickUpper: number; liquidity: bigint; amountKntq: string; amountWhype: string; feeKntq: string; feeWhype: string; inRange: boolean; }
/** Legacy *Whype fields represent the quote asset; quoteSymbol distinguishes native HYPE in v4. */
export interface Snapshot { blockNumber: bigint; blockTime: number; fetchedAt: number; pool: PoolState | null; balances: { kntq: string; whype: string; hype: string }; positions: PositionState[]; kntqDecimals: number; whypeDecimals: number; rpcUrl: string; warnings: string[]; profile?: ProfileId; chainId?: number; manager?: Address; kntqAddress?: Address; quoteSymbol?: 'WHYPE' | 'HYPE'; positionsComplete?: boolean; deployment?: { verified: boolean; fingerprint: Hex; blockHash: Hex; evidence: string[]; }; }
export interface TxStep { label: string; to: Address; data: Hex; value: bigint; }
export interface TxPlan { id: string; kind: 'mint' | 'collect' | 'exit'; account: Address; chainId: number; createdAt: number; expiresAt: number; sourceBlock: bigint; steps: TxStep[]; summary: string[]; slippageBps: number; profile?: ProfileId; deploymentFingerprint?: Hex; }
export interface OpenInput { kntq: string; whype: string; useNative: boolean; lowerPrice: string; upperPrice: string; rangeMode?: 'custom' | 'full'; }
export interface ExecutionEvent { index: number; status: 'simulating' | 'signing' | 'submitted' | 'confirmed' | 'failed'; label: string; hash?: Hex; error?: string; }
export interface FeeObservation { at: number; kntq: number; whype: number; liquidity: string; }
export interface UsdPrice { hype: number; fetchedAt: number; source: string; }
