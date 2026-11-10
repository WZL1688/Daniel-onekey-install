import { Token } from '@uniswap/sdk-core';
import { Pool, Position, TickMath } from '@uniswap/v3-sdk';
import { encodeAbiParameters, formatEther, formatUnits, getAddress, isAddressEqual, keccak256, padHex, parseAbiItem, toHex, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { createSafeReadClient } from '../lib/readTransport';
import type { PoolState, PositionState, RpcHealth, Settings, Snapshot } from '../lib/types';
import { ADDRESSES, CHAIN_ID, POOL_ID, POOL_KEY, elysium } from './config';
import { erc20Abi, managerAbi, stateViewAbi } from './abis';
import { assertRuntimeIdentity } from './identity';

export type ReadClient = ReturnType<typeof createSafeReadClient>;
type Deployment = NonNullable<Snapshot['deployment']>;
export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address; }
export interface TransferRecord { blockNumber: bigint | null; transactionIndex: number | null; logIndex: number | null; removed?: boolean; args: { from?: Address; to?: Address; tokenId?: bigint }; }
const MOD256 = 1n << 256n;
const Q128 = 1n << 128n;
const TRANSFER = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
const OWNER_LIMIT = 200n;

export function createReadClient(settings: Settings, onHealth?: (health: RpcHealth) => void): ReadClient {
  return createSafeReadClient(settings, elysium, onHealth);
}

/** PoolId commits every field, including hooks. Never match only the two currencies. */
export function computePoolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters([
    { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
  ], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}
export function isTargetPool(key: PoolKey): boolean {
  return isAddressEqual(key.currency0, POOL_KEY.currency0) && isAddressEqual(key.currency1, POOL_KEY.currency1)
    && key.fee === POOL_KEY.fee && key.tickSpacing === POOL_KEY.tickSpacing
    && isAddressEqual(key.hooks, POOL_KEY.hooks) && computePoolId(key) === POOL_ID;
}
export function decodeTicks(info: bigint): { tickLower: number; tickUpper: number } {
  const signed24 = (n: bigint) => Number(n >= 0x800000n ? n - 0x1000000n : n);
  const tickLower = signed24((info >> 8n) & 0xffffffn);
  const tickUpper = signed24((info >> 32n) & 0xffffffn);
  if (tickLower >= tickUpper || tickLower < TickMath.MIN_TICK || tickUpper > TickMath.MAX_TICK
    || tickLower % POOL_KEY.tickSpacing !== 0 || tickUpper % POOL_KEY.tickSpacing !== 0) throw new Error('仓位价格区间不符合目标 v4 池');
  return { tickLower, tickUpper };
}
export function feesFromGrowth(liquidity: bigint, current: bigint, previous: bigint): bigint {
  if (liquidity < 0n || liquidity >= 1n << 128n || current < 0n || current >= MOD256 || previous < 0n || previous >= MOD256) throw new Error('无效的 v4 手续费状态');
  return ((current - previous + MOD256) % MOD256) * liquidity / Q128;
}

/** Chronological replay; delete then add also handles a self-transfer correctly. */
export function replayTransfers(logs: readonly TransferRecord[], account: Address): Set<string> {
  const ordered = [...logs];
  if (ordered.some((log) => log.removed || log.blockNumber === null || log.transactionIndex === null || log.logIndex === null || !log.args.from || !log.args.to || log.args.tokenId === undefined)) throw new Error('Transfer 日志缺少确定的链上顺序');
  ordered.sort((a, b) => a.blockNumber! === b.blockNumber!
    ? a.transactionIndex! - b.transactionIndex! || a.logIndex! - b.logIndex!
    : a.blockNumber! < b.blockNumber! ? -1 : 1);
  const owned = new Set<string>();
  for (const log of ordered) {
    const id = log.args.tokenId!.toString();
    if (isAddressEqual(log.args.from!, account)) owned.delete(id);
    if (isAddressEqual(log.args.to!, account)) owned.add(id);
  }
  return owned;
}

/** Only a contract's recognized non-existent NFT revert may be ignored. */
export function isMissingToken(error: unknown): boolean {
  let item: unknown = error;
  for (let depth = 0; item && typeof item === 'object' && depth < 12; depth++) {
    const value = item as { name?: string; reason?: string; data?: { errorName?: string }; cause?: unknown };
    if (value.name === 'ContractFunctionRevertedError' && (value.reason === 'NOT_MINTED' || value.data?.errorName === 'ERC721NonexistentToken')) return true;
    item = value.cause;
  }
  return false;
}
async function ownerAt(client: ReadClient, id: bigint, blockNumber: bigint): Promise<Address | null> {
  try { return await client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'ownerOf', args: [id], blockNumber }); }
  catch (error) { if (isMissingToken(error)) return null; throw error; }
}
async function limitedMap<T, R>(items: readonly T[], fn: (item: T) => Promise<R>, concurrency = 8): Promise<R[]> {
  let next = 0;
  const result = new Array<R>(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await fn(items[index]); }
  }));
  return result;
}

async function latestBlock(client: ReadClient, settings: Settings, requireFresh: boolean) {
  if (!Number.isFinite(settings.staleSeconds) || settings.staleSeconds < 10 || settings.staleSeconds > 300) throw new Error('链上过期阈值必须为 10–300 秒');
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number === null || !block.hash) throw new Error('RPC 没有返回确定的最新区块');
  const time = Number(block.timestamp) * 1000;
  if (!Number.isSafeInteger(time) || time > Date.now() + 15_000) throw new Error('RPC 区块时间异常');
  if (requireFresh && Date.now() - time > settings.staleSeconds * 1000) throw new Error('Elysium 区块已过期，请刷新后重做预览');
  return { number: block.number, hash: block.hash, time };
}
async function consistentBlock(client: ReadClient, number: bigint, hash: Hex) {
  const again = await client.getBlock({ blockNumber: number });
  if (!again.hash || again.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC 区块哈希不一致，请重新同步');
}

async function inspectDeployment(client: ReadClient, blockNumber: bigint, blockHash: Hex): Promise<Deployment> {
  if (computePoolId(POOL_KEY) !== POOL_ID) throw new Error('本地 Elysium PoolKey 与 PoolId 不一致');
  const [codeResults, metadata] = await Promise.all([
    Promise.all([ADDRESSES.manager, ADDRESSES.poolManager, ADDRESSES.stateView, ADDRESSES.permit2, ADDRESSES.kntq, ADDRESSES.whype].map((address) => client.getCode({ address, blockNumber }))),
    Promise.all([
      client.readContract({ address: ADDRESSES.kntq, abi: erc20Abi, functionName: 'symbol', blockNumber }),
      client.readContract({ address: ADDRESSES.kntq, abi: erc20Abi, functionName: 'decimals', blockNumber }),
      client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'poolManager', blockNumber }),
      client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'permit2', blockNumber }),
      client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'WETH9', blockNumber }),
      client.readContract({ address: ADDRESSES.stateView, abi: stateViewAbi, functionName: 'poolManager', blockNumber }),
    ]),
  ]);
  const [manager, poolManager, stateView, permit2, tokenCode, wrappedCode] = codeResults;
  const [kntqSymbol, kntqDecimals, managerPool, managerPermit, managerWrapped, viewPool] = metadata;
  const codes = { manager, poolManager, stateView, permit2 };
  if ([...Object.values(codes), tokenCode, wrappedCode].some((code) => !code || code === '0x')) throw new Error('Elysium 目标合约缺少链上代码');
  if (kntqSymbol !== 'KNTQ' || kntqDecimals !== 18) throw new Error('Elysium KNTQ 代币元数据不符');
  if (!isAddressEqual(managerPool as Address, ADDRESSES.poolManager) || !isAddressEqual(viewPool as Address, ADDRESSES.poolManager)
    || !isAddressEqual(managerPermit as Address, ADDRESSES.permit2) || !isAddressEqual(managerWrapped as Address, ADDRESSES.whype)) throw new Error('Elysium 管理合约关联校验失败');
  const identity = assertRuntimeIdentity(codes as Record<keyof typeof codes, Hex>);
  // Identity is stable across blocks. The block attestation is carried separately.
  const fingerprint = keccak256(encodeAbiParameters([
    { type: 'uint256' }, { type: 'bytes32' }, ...Array.from({ length: 4 }, () => ({ type: 'address' as const })),
    ...Array.from({ length: 4 }, () => ({ type: 'bytes32' as const })),
  ], [BigInt(CHAIN_ID), POOL_ID, ADDRESSES.manager, ADDRESSES.poolManager, ADDRESSES.stateView, ADDRESSES.permit2,
    keccak256(manager!), keccak256(poolManager!), keccak256(stateView!), keccak256(permit2!)]));
  return { verified: identity.verified, fingerprint, blockHash, evidence: [...identity.evidence, '链 ID、KNTQ 元数据及 PositionManager / StateView 关联已校验'] };
}

export async function readPool(client: ReadClient, blockNumber: bigint): Promise<PoolState> {
  const [slot, liquidity] = await Promise.all([
    client.readContract({ address: ADDRESSES.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [POOL_ID], blockNumber }),
    client.readContract({ address: ADDRESSES.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [POOL_ID], blockNumber }),
  ]);
  if (slot[0] === 0n) throw new Error('目标 Elysium v4 池尚未初始化，当前版本不会自动初始化其他池');
  if (slot[3] !== POOL_KEY.fee) throw new Error('目标 v4 池的 LP 费率不符');
  // The SDK validates the sqrt-price / tick pair using canonical concentrated-liquidity math.
  new Pool(new Token(CHAIN_ID, zeroAddress, 18, 'HYPE'), new Token(CHAIN_ID, ADDRESSES.kntq, 18, 'KNTQ'), POOL_KEY.fee, slot[0].toString(), liquidity.toString(), slot[1]);
  return { address: ADDRESSES.poolManager, poolId: POOL_ID, hooks: POOL_KEY.hooks, fee: POOL_KEY.fee, tickSpacing: POOL_KEY.tickSpacing, token0: zeroAddress, token1: ADDRESSES.kntq, sqrtPriceX96: slot[0], tick: slot[1], liquidity };
}

export async function validateDeployment(settings: Settings): Promise<Deployment> {
  if (settings.fee !== POOL_KEY.fee) throw new Error('Elysium v4 当前只支持指定的 1% 池');
  const client = createReadClient(settings);
  const block = await latestBlock(client, settings, true);
  const [deployment] = await Promise.all([inspectDeployment(client, block.number, block.hash), readPool(client, block.number)]);
  await consistentBlock(client, block.number, block.hash);
  return deployment;
}

export async function discoverOwnedIds(client: ReadClient, account: Address, expectedCount: bigint, trackedIds: readonly string[], blockNumber: bigint): Promise<{ ids: bigint[]; complete: boolean }> {
  if (expectedCount < 0n || expectedCount > OWNER_LIMIT) throw new Error('Elysium 钱包持有超过 200 个 NFT，已停止扫描以免误报不完整持仓');
  if (trackedIds.length > 200) throw new Error('手动追踪 TokenId 超过 200 个上限');
  if (expectedCount === 0n) return { ids: [], complete: true };
  const next = await client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'nextTokenId', blockNumber });
  if (next < 1n || next >= 1n << 256n) throw new Error('v4 NFT 索引状态无效');
  const candidates = new Set<string>();
  for (const id of trackedIds) {
    if (!/^\d+$/.test(id) || BigInt(id) <= 0n || BigInt(id) >= next) throw new Error('手动追踪 TokenId 无效');
    candidates.add(BigInt(id).toString());
  }
  const start = next > 120n ? next - 120n : 1n;
  const recent = Array.from({ length: Number(next - start) }, (_, index) => start + BigInt(index));
  const recentOwners = await limitedMap(recent, (id) => ownerAt(client, id, blockNumber));
  for (let index = 0; index < recent.length; index++) if (recentOwners[index] && isAddressEqual(recentOwners[index]!, account)) candidates.add(recent[index].toString());

  const finalOwned = async () => {
    const ids = [...candidates].map(BigInt);
    const owners = await limitedMap(ids, (id) => ownerAt(client, id, blockNumber));
    return ids.filter((_, index) => owners[index] && isAddressEqual(owners[index]!, account));
  };
  let owned = await finalOwned();
  if (BigInt(owned.length) > expectedCount) throw new Error('NFT 归属与钱包余额不一致');
  if (BigInt(owned.length) === expectedCount) return { ids: owned.sort((a, b) => a < b ? -1 : 1), complete: true };

  const logs: TransferRecord[] = [];
  const from0 = blockNumber > 30_000n ? blockNumber - 30_000n : 0n;
  for (let fromBlock = from0; fromBlock <= blockNumber; fromBlock += 1800n) {
    const toBlock = fromBlock + 1799n < blockNumber ? fromBlock + 1799n : blockNumber;
    const [ins, outs] = await Promise.all([
      client.getLogs({ address: ADDRESSES.manager, event: TRANSFER, args: { to: account }, fromBlock, toBlock, strict: true }),
      client.getLogs({ address: ADDRESSES.manager, event: TRANSFER, args: { from: account }, fromBlock, toBlock, strict: true }),
    ]);
    logs.push(...ins as TransferRecord[], ...outs as TransferRecord[]);
  }
  for (const id of replayTransfers(logs, account)) candidates.add(id);
  // A current ownerOf observation is never deleted by older transfer history.
  owned = await finalOwned();
  if (BigInt(owned.length) > expectedCount) throw new Error('日志重放与 NFT 钱包余额不一致');
  return { ids: owned.sort((a, b) => a < b ? -1 : 1), complete: BigInt(owned.length) === expectedCount };
}

export async function readPositionAt(client: ReadClient, account: Address, tokenId: bigint, pool: PoolState, blockNumber: bigint): Promise<PositionState | null> {
  const [owner, result, liquidity] = await Promise.all([
    ownerAt(client, tokenId, blockNumber),
    client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'getPoolAndPositionInfo', args: [tokenId], blockNumber }),
    client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'getPositionLiquidity', args: [tokenId], blockNumber }),
  ]);
  if (!owner || !isAddressEqual(owner, account)) throw new Error(`NFT #${tokenId} 不属于当前账户`);
  const [key, packed] = result;
  if (!isTargetPool(key)) return null;
  const { tickLower, tickUpper } = decodeTicks(packed);
  const salt = padHex(toHex(tokenId), { size: 32 });
  const [corePosition, growth] = await Promise.all([
    client.readContract({ address: ADDRESSES.stateView, abi: stateViewAbi, functionName: 'getPositionInfo', args: [POOL_ID, ADDRESSES.manager, tickLower, tickUpper, salt], blockNumber }),
    client.readContract({ address: ADDRESSES.stateView, abi: stateViewAbi, functionName: 'getFeeGrowthInside', args: [POOL_ID, tickLower, tickUpper], blockNumber }),
  ]);
  if (corePosition[0] !== liquidity) throw new Error('v4 NFT 与核心池的流动性状态不一致');
  const hypeFee = feesFromGrowth(liquidity, growth[0], corePosition[1]);
  const kntqFee = feesFromGrowth(liquidity, growth[1], corePosition[2]);
  const sdkPool = new Pool(new Token(CHAIN_ID, zeroAddress, 18, 'HYPE'), new Token(CHAIN_ID, ADDRESSES.kntq, 18, 'KNTQ'), pool.fee, pool.sqrtPriceX96.toString(), pool.liquidity.toString(), pool.tick);
  const position = new Position({ pool: sdkPool, tickLower, tickUpper, liquidity: liquidity.toString() });
  return { tokenId: tokenId.toString(), pool, tickLower, tickUpper, liquidity,
    amountKntq: formatUnits(BigInt(position.amount1.quotient.toString()), 18),
    amountWhype: formatEther(BigInt(position.amount0.quotient.toString())),
    feeKntq: formatUnits(kntqFee, 18), feeWhype: formatEther(hypeFee),
    inRange: liquidity > 0n && pool.tick >= tickLower && pool.tick < tickUpper };
}

export async function readPosition(settings: Settings, account: Address, tokenId: string): Promise<PositionState> {
  if (!/^\d+$/.test(tokenId) || BigInt(tokenId) <= 0n || BigInt(tokenId) >= 1n << 256n) throw new Error('请输入有效的 NFT TokenId');
  const client = createReadClient(settings);
  const block = await latestBlock(client, settings, true);
  await inspectDeployment(client, block.number, block.hash);
  const pool = await readPool(client, block.number);
  const position = await readPositionAt(client, getAddress(account), BigInt(tokenId), pool, block.number);
  if (!position) throw new Error('该 NFT 不属于指定的无 hook Elysium KNTQ/HYPE 池');
  await consistentBlock(client, block.number, block.hash);
  return position;
}

export async function loadSnapshot(settings: Settings, account?: Address, onHealth?: (health: RpcHealth) => void): Promise<Snapshot> {
  if (settings.fee !== POOL_KEY.fee) throw new Error('Elysium v4 当前只支持指定的 1% 池');
  const client = createReadClient(settings, onHealth);
  const block = await latestBlock(client, settings, false);
  const [deployment, pool] = await Promise.all([inspectDeployment(client, block.number, block.hash), readPool(client, block.number)]);
  const warnings: string[] = [];
  if (!deployment.verified) warnings.push('Elysium 合约代码身份尚未通过全部校验，交易保持禁用；链上读取不代表部署认证。');
  if (Date.now() - block.time > settings.staleSeconds * 1000) warnings.push('Elysium 当前区块已过期，交易暂停。');
  let balances = { kntq: '0', whype: '0', hype: '0' };
  let positions: PositionState[] = [];
  let positionsComplete = true;
  if (account) {
    const [kntq, wrapped, hype, count] = await Promise.all([
      client.readContract({ address: ADDRESSES.kntq, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber: block.number }),
      client.readContract({ address: ADDRESSES.whype, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber: block.number }),
      client.getBalance({ address: account, blockNumber: block.number }),
      client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'balanceOf', args: [account], blockNumber: block.number }),
    ]);
    balances = { kntq: formatUnits(kntq, 18), whype: formatUnits(wrapped, 18), hype: formatEther(hype) };
    const scan = await discoverOwnedIds(client, account, count, settings.trackedIds, block.number);
    positionsComplete = scan.complete;
    if (!scan.complete) warnings.push(`持仓扫描不完整：已找到 ${scan.ids.length} / ${count} 个 v4 NFT。较早仓位可能未显示，请在设置中添加 TokenId；当前空列表不代表钱包没有持仓。`);
    positions = (await limitedMap(scan.ids, (id) => readPositionAt(client, account, id, pool, block.number))).filter((position): position is PositionState => position !== null);
  }
  await consistentBlock(client, block.number, block.hash);
  return { blockNumber: block.number, blockTime: block.time, fetchedAt: Date.now(), pool, balances, positions,
    kntqDecimals: 18, whypeDecimals: 18, rpcUrl: client.rpcUrl(), warnings,
    profile: 'elysium-v4', chainId: CHAIN_ID, manager: ADDRESSES.manager, kntqAddress: ADDRESSES.kntq,
    quoteSymbol: 'HYPE', positionsComplete, deployment };
}
