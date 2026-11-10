import { Token } from '@uniswap/sdk-core';
import { Pool, Position } from '@uniswap/v3-sdk';
import { createPublicClient, custom, decodeFunctionResult, encodeFunctionData, formatEther, formatUnits, getAddress, isAddressEqual, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient, Transport } from 'viem';
import { ADDRESSES, CHAIN_ID, hyperEvm } from './config';
import { erc20Abi, factoryAbi, managerAbi, poolAbi } from './abis';
import type { PoolState, PositionState, RpcHealth, Settings, Snapshot } from './types';

type HealthListener = (health: RpcHealth) => void;
type RpcArgs = { method: string; params?: unknown };
export type ReadClient = PublicClient<Transport, typeof hyperEvm> & { rpcUrl: () => string };
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBalance', 'eth_getCode', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getLogs']);

/** Read-only failover. A wallet is the only component allowed to broadcast. */
export function createReadClient(settings: Settings, onHealth?: HealthListener): ReadClient {
  const urls = [...new Set(settings.rpcUrls.map((url) => url.trim()).filter(Boolean))];
  if (!urls.length) throw new Error('请至少配置一个 RPC 地址');
  for (const url of urls) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('RPC 仅支持 HTTP(S)');
    if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('远程 RPC 必须使用 HTTPS');
  }
  let active = 0;
  let rpcId = 0;
  const verified = new Map<string, Promise<void>>();
  async function raw(url: string, args: RpcArgs): Promise<unknown> {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, ...args }),
      signal: AbortSignal.timeout(12_000), credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json() as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, data: result.error.data });
    if (!('result' in result)) throw new Error('无效的 JSON-RPC 响应');
    return result.result;
  }
  async function verify(url: string): Promise<void> {
    let pending = verified.get(url);
    if (!pending) {
      pending = raw(url, { method: 'eth_chainId', params: [] }).then((id) => {
        if (Number(id) !== CHAIN_ID) throw new Error(`RPC 链 ID 为 ${String(id)}，预期 HyperEVM 999`);
      });
      verified.set(url, pending);
      pending.catch(() => verified.delete(url));
    }
    await pending;
  }
  const provider = {
    async request(args: RpcArgs) {
      if (!READ_METHODS.has(args.method)) throw new Error(`只读 RPC 禁止方法 ${args.method}`);
      const start = active;
      const failures: string[] = [];
      for (let offset = 0; offset < urls.length; offset++) {
        const index = (start + offset) % urls.length;
        const url = urls[index];
        const began = Date.now();
        try {
          await verify(url);
          const value = args.method === 'eth_chainId' ? '0x3e7' : await raw(url, args);
          active = index;
          onHealth?.({ url, ok: true, latencyMs: Date.now() - began });
          return value;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onHealth?.({ url, ok: false, latencyMs: Date.now() - began, error: message });
          // A contract revert is a deterministic simulation result, never a failover trigger.
          if (typeof error === 'object' && error !== null && 'code' in error && (Number(error.code) === 3 || /revert|execution failed/i.test(message))) throw error;
          failures.push(`${new URL(url).hostname}: ${message}`);
        }
      }
      throw new Error(`全部 RPC 不可用：${failures.join('；')}`);
    },
  };
  return Object.assign(createPublicClient({ chain: hyperEvm, transport: custom(provider, { retryCount: 0 }) }), { rpcUrl: () => urls[active] }) as ReadClient;
}

const Q128 = 1n << 128n;
const MOD256 = 1n << 256n;
export function sub256(a: bigint, b: bigint): bigint { return (a - b + MOD256) % MOD256; }

/** Uniswap v3 core Position.update accounting, including uint256 wraparound. */
export function calculateFees(input: {
  tick: number; lower: number; upper: number; global: bigint; outsideLower: bigint; outsideUpper: bigint;
  lastInside: bigint; liquidity: bigint; owed: bigint;
}): bigint {
  const below = input.tick >= input.lower ? input.outsideLower : sub256(input.global, input.outsideLower);
  const above = input.tick < input.upper ? input.outsideUpper : sub256(input.global, input.outsideUpper);
  const inside = sub256(sub256(input.global, below), above);
  return input.owed + sub256(inside, input.lastInside) * input.liquidity / Q128;
}

export async function readPool(client: ReadClient, fee: number, blockNumber: bigint): Promise<PoolState | null> {
  const address = await client.readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: 'getPool', args: [ADDRESSES.kntq, ADDRESSES.whype, fee], blockNumber });
  if (isAddressEqual(address, zeroAddress)) return null;
  const [factory, token0, token1, actualFee, tickSpacing, liquidity, slot0] = await Promise.all([
    client.readContract({ address, abi: poolAbi, functionName: 'factory', blockNumber }),
    client.readContract({ address, abi: poolAbi, functionName: 'token0', blockNumber }),
    client.readContract({ address, abi: poolAbi, functionName: 'token1', blockNumber }),
    client.readContract({ address, abi: poolAbi, functionName: 'fee', blockNumber }),
    client.readContract({ address, abi: poolAbi, functionName: 'tickSpacing', blockNumber }),
    client.readContract({ address, abi: poolAbi, functionName: 'liquidity', blockNumber }),
    client.readContract({ address, abi: poolAbi, functionName: 'slot0', blockNumber }),
  ]);
  if (!isAddressEqual(factory, ADDRESSES.factory) || !isAddressEqual(token0, ADDRESSES.kntq) || !isAddressEqual(token1, ADDRESSES.whype) || actualFee !== fee || tickSpacing <= 0) throw new Error('池身份校验失败');
  return { address: getAddress(address), fee, tick: slot0[1], sqrtPriceX96: slot0[0], liquidity, tickSpacing, token0, token1 };
}

export async function getPool(settings: Settings, fee: number, blockNumber?: bigint): Promise<PoolState | null> {
  const client = createReadClient(settings);
  return readPool(client, fee, blockNumber ?? await client.getBlockNumber());
}

/** NPM's own multicall batches only encoded view functions under eth_call.
 * No third-party aggregator and no wallet/broadcast are involved. All results
 * are pinned to the snapshot block; any missing/malformed result fails closed.
 */
async function readManagerBatch(client: ReadClient, calls: readonly Hex[], blockNumber: bigint): Promise<readonly Hex[]> {
  const { data } = await client.call({
    to: ADDRESSES.manager,
    data: encodeFunctionData({ abi: managerAbi, functionName: 'multicall', args: [calls] }),
    blockNumber,
  });
  if (!data || data === '0x') throw new Error('仓位管理器未返回批量读取结果');
  const results = decodeFunctionResult({ abi: managerAbi, functionName: 'multicall', data });
  if (results.length !== calls.length) throw new Error('仓位管理器批量结果不完整，已停止同步');
  return results;
}

export async function readOwnedPositions(client: ReadClient, account: Address, count: bigint, blockNumber: bigint) {
  if (count < 0n || count > 200n) throw new Error('钱包持有超过 200 个 V3 NFT，完整扫描超出本地工具单次上限；请使用专用钱包，避免显示不完整持仓');
  if (count === 0n) return [];
  const indexCalls = Array.from({ length: Number(count) }, (_, index) => encodeFunctionData({ abi: managerAbi, functionName: 'tokenOfOwnerByIndex', args: [account, BigInt(index)] }));
  const indexResults = await readManagerBatch(client, indexCalls, blockNumber);
  const ids = indexResults.map((data) => decodeFunctionResult({ abi: managerAbi, functionName: 'tokenOfOwnerByIndex', data }));
  if (new Set(ids.map(String)).size !== ids.length) throw new Error('仓位枚举包含重复 NFT，已停止同步');
  const positionCalls = ids.map((id) => encodeFunctionData({ abi: managerAbi, functionName: 'positions', args: [id] }));
  const positionResults = await readManagerBatch(client, positionCalls, blockNumber);
  return positionResults.map((data, index) => ({ id: ids[index], info: decodeFunctionResult({ abi: managerAbi, functionName: 'positions', data }) }));
}

export async function loadSnapshot(settings: Settings, account?: Address, onHealth?: HealthListener): Promise<Snapshot> {
  const client = createReadClient(settings, onHealth);
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number === null || !block.hash) throw new Error('最新区块尚未确认');
  const blockNumber = block.number;
  const blockTime = Number(block.timestamp) * 1000;
  if (blockTime > Date.now() + 60_000) throw new Error('RPC 区块时间异常');
  const [kntqCode, whypeCode, factoryCode, managerCode, kntqSymbol, whypeSymbol, kntqDecimals, whypeDecimals, managerFactory, managerWhype] = await Promise.all([
    ...[ADDRESSES.kntq, ADDRESSES.whype, ADDRESSES.factory, ADDRESSES.manager].map((address) => client.getCode({ address, blockNumber })),
    client.readContract({ address: ADDRESSES.kntq, abi: erc20Abi, functionName: 'symbol', blockNumber }),
    client.readContract({ address: ADDRESSES.whype, abi: erc20Abi, functionName: 'symbol', blockNumber }),
    client.readContract({ address: ADDRESSES.kntq, abi: erc20Abi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: ADDRESSES.whype, abi: erc20Abi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'factory', blockNumber }),
    client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'WETH9', blockNumber }),
  ]);
  if ([kntqCode, whypeCode, factoryCode, managerCode].some((code) => !code || code === '0x')) throw new Error('目标合约没有链上代码');
  if (kntqSymbol !== 'KNTQ' || whypeSymbol !== 'WHYPE' || kntqDecimals !== 18 || whypeDecimals !== 18 || !isAddressEqual(managerFactory as Address, ADDRESSES.factory) || !isAddressEqual(managerWhype as Address, ADDRESSES.whype)) throw new Error('代币或仓位管理器身份校验失败');
  const pools = new Map<number, Promise<PoolState | null>>();
  const poolFor = (fee: number) => {
    let found = pools.get(fee);
    if (!found) { found = readPool(client, fee, blockNumber); pools.set(fee, found); }
    return found;
  };
  const pool = await poolFor(settings.fee);
  const warnings: string[] = [];
  if (!pool) warnings.push('所选费率的 Uniswap V3 池尚未创建');
  else if (pool.sqrtPriceX96 === 0n) warnings.push('所选池尚未初始化');
  let balances = { kntq: '0', whype: '0', hype: '0' };
  let positions: PositionState[] = [];
  if (account) {
    const [kntqBalance, whypeBalance, nativeBalance, count] = await Promise.all([
      client.readContract({ address: ADDRESSES.kntq, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber }),
      client.readContract({ address: ADDRESSES.whype, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber }),
      client.getBalance({ address: account, blockNumber }),
      client.readContract({ address: ADDRESSES.manager, abi: managerAbi, functionName: 'balanceOf', args: [account], blockNumber }),
    ]);
    balances = { kntq: formatUnits(kntqBalance, Number(kntqDecimals)), whype: formatUnits(whypeBalance, Number(whypeDecimals)), hype: formatEther(nativeBalance) };
    const owned = await readOwnedPositions(client, account, count, blockNumber);
    const feeGlobals = new Map<Address, Promise<readonly [bigint, bigint]>>();
    const tickCache = new Map<string, Promise<readonly [bigint, bigint]>>();
    const readGlobals = (address: Address) => {
      let pending = feeGlobals.get(address);
      if (!pending) {
        pending = Promise.all([
          client.readContract({ address, abi: poolAbi, functionName: 'feeGrowthGlobal0X128', blockNumber }),
          client.readContract({ address, abi: poolAbi, functionName: 'feeGrowthGlobal1X128', blockNumber }),
        ]);
        feeGlobals.set(address, pending);
      }
      return pending;
    };
    const readTick = (address: Address, tick: number) => {
      const key = `${address}:${tick}`;
      let pending = tickCache.get(key);
      if (!pending) {
        pending = client.readContract({ address, abi: poolAbi, functionName: 'ticks', args: [tick], blockNumber }).then((result) => [result[2], result[3]] as const);
        tickCache.set(key, pending);
      }
      return pending;
    };
    const found = await Promise.all(owned.map(async ({ id, info }): Promise<PositionState | null> => {
      if (!isAddressEqual(info[2], ADDRESSES.kntq) || !isAddressEqual(info[3], ADDRESSES.whype)) return null;
      const p = await poolFor(info[4]);
      if (!p || p.sqrtPriceX96 === 0n) throw new Error(`NFT #${id} 对应的池无效`);
      const [global, lowerOutside, upperOutside] = await Promise.all([readGlobals(p.address), readTick(p.address, info[5]), readTick(p.address, info[6])]);
      const common = { tick: p.tick, lower: info[5], upper: info[6], liquidity: info[7] };
      const fees0 = calculateFees({ ...common, global: global[0], outsideLower: lowerOutside[0], outsideUpper: upperOutside[0], lastInside: info[8], owed: info[10] });
      const fees1 = calculateFees({ ...common, global: global[1], outsideLower: lowerOutside[1], outsideUpper: upperOutside[1], lastInside: info[9], owed: info[11] });
      const sdkPool = new Pool(new Token(CHAIN_ID, p.token0, Number(kntqDecimals), 'KNTQ'), new Token(CHAIN_ID, p.token1, Number(whypeDecimals), 'WHYPE'), p.fee, p.sqrtPriceX96.toString(), p.liquidity.toString(), p.tick);
      const sdkPosition = new Position({ pool: sdkPool, liquidity: info[7].toString(), tickLower: info[5], tickUpper: info[6] });
      return {
        tokenId: id.toString(), pool: p, tickLower: info[5], tickUpper: info[6], liquidity: info[7],
        amountKntq: formatUnits(BigInt(sdkPosition.amount0.quotient.toString()), Number(kntqDecimals)),
        amountWhype: formatUnits(BigInt(sdkPosition.amount1.quotient.toString()), Number(whypeDecimals)),
        feeKntq: formatUnits(fees0, Number(kntqDecimals)), feeWhype: formatUnits(fees1, Number(whypeDecimals)),
        inRange: info[7] > 0n && p.tick >= info[5] && p.tick < info[6],
      };
    }));
    positions = found.filter((position): position is PositionState => position !== null);
    if (count > 12n) warnings.push('持仓 NFT 较多，公共 RPC 可能触发限流；建议配置专用 RPC 并延长刷新间隔');
  }
  const finalBlock = await client.getBlock({ blockNumber });
  if (finalBlock.hash !== block.hash) throw new Error('RPC 返回了不一致的区块，请刷新后重试');
  return { blockNumber, blockTime, fetchedAt: Date.now(), pool, balances, positions, kntqDecimals: Number(kntqDecimals), whypeDecimals: Number(whypeDecimals), rpcUrl: client.rpcUrl(), warnings };
}
