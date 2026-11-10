import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, zeroAddress } from 'viem';
import { calculateFees, createReadClient, readOwnedPositions, readPool, sub256 } from '../src/lib/chain';
import type { ReadClient } from '../src/lib/chain';
import { ADDRESSES, DEFAULT_SETTINGS } from '../src/lib/config';
import { managerAbi } from '../src/lib/abis';

const Q128 = 1n << 128n;
afterEach(() => vi.unstubAllGlobals());
describe('Uniswap fee growth accounting', () => {
  it('adds unpoked fee growth to tokensOwed', () => {
    expect(calculateFees({ tick: 10, lower: 0, upper: 20, global: 10n * Q128, outsideLower: 2n * Q128, outsideUpper: Q128, lastInside: 4n * Q128, liquidity: 7n, owed: 5n })).toBe(26n);
  });
  it('handles a position below the range without accruing global growth', () => {
    expect(calculateFees({ tick: -1, lower: 0, upper: 20, global: 20n * Q128, outsideLower: 8n * Q128, outsideUpper: 2n * Q128, lastInside: 5n * Q128, liquidity: 3n, owed: 1n })).toBe(4n);
  });
  it('handles uint256 wraparound', () => {
    expect(sub256(2n, (1n << 256n) - 3n)).toBe(5n);
    expect(calculateFees({ tick: 0, lower: -10, upper: 10, global: Q128, outsideLower: 0n, outsideUpper: 0n, lastInside: (1n << 256n) - Q128, liquidity: 2n, owed: 0n })).toBe(4n);
  });
  it('uses the outside fee growth at the upper boundary', () => {
    expect(calculateFees({ tick: 20, lower: 0, upper: 20, global: 20n * Q128, outsideLower: 2n * Q128, outsideUpper: 8n * Q128, lastInside: 5n * Q128, liquidity: 3n, owed: 1n })).toBe(4n);
  });
});
describe('read-only RPC failover', () => {
  it('rejects the wrong chain and moves to the next RPC', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const args = JSON.parse(init.body as string);
      calls.push(`${url}:${args.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: args.id, result: args.method === 'eth_chainId' ? (url.includes('wrong') ? '0x1' : '0x3e7') : '0x2a' }));
    }));
    const client = createReadClient({ ...DEFAULT_SETTINGS, rpcUrls: ['https://wrong.example', 'https://right.example'] });
    expect(await client.getBlockNumber()).toBe(42n);
    expect(client.rpcUrl()).toBe('https://right.example');
    expect(calls).toEqual(['https://wrong.example:eth_chainId', 'https://right.example:eth_chainId', 'https://right.example:eth_blockNumber']);
  });
  it('blocks every broadcast method before issuing a request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const client = createReadClient(DEFAULT_SETTINGS);
    await expect(client.request({ method: 'eth_sendRawTransaction', params: ['0x00'] } as never)).rejects.toThrow('只读 RPC');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not retry a deterministic EVM revert on another RPC', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const args = JSON.parse(init.body as string);
      calls.push(`${url}:${args.method}`);
      return new Response(JSON.stringify(args.method === 'eth_chainId'
        ? { jsonrpc: '2.0', id: args.id, result: '0x3e7' }
        : { jsonrpc: '2.0', id: args.id, error: { code: 3, message: 'execution reverted', data: '0x' } }));
    }));
    const client = createReadClient({ ...DEFAULT_SETTINGS, rpcUrls: ['https://first.example', 'https://second.example'] });
    await expect(client.call({ to: ADDRESSES.kntq, data: '0x00' })).rejects.toThrow('reverted');
    expect(calls).toEqual(['https://first.example:eth_chainId', 'https://first.example:eth_call']);
  });
});
describe('pool identity verification', () => {
  it('rejects a pool with the wrong token identity', async () => {
    const client = { readContract: vi.fn(async ({ functionName }: { functionName: string }) => ({
      getPool: '0x1111111111111111111111111111111111111111', factory: ADDRESSES.factory,
      token0: ADDRESSES.whype, token1: ADDRESSES.kntq, fee: 3000, tickSpacing: 60,
      liquidity: 1n, slot0: [1n << 96n, 0, 0, 1, 1, 0, true],
    }[functionName])) } as unknown as ReadClient;
    await expect(readPool(client, 3000, 100n)).rejects.toThrow('池身份校验失败');
  });
});

describe('NPM view multicall reads', () => {
  const account = '0x1234567890123456789012345678901234567890' as const;
  const blockNumber = 12_345n;
  const info1 = [0n, zeroAddress, ADDRESSES.kntq, ADDRESSES.whype, 3000, -60, 60, 700n, 111n, 222n, 3n, 4n] as const;
  const info2 = [1n, zeroAddress, ADDRESSES.kntq, ADDRESSES.whype, 500, -10, 10, 900n, 333n, 444n, 5n, 6n] as const;
  const indexResult = (id: bigint) => encodeFunctionResult({ abi: managerAbi, functionName: 'tokenOfOwnerByIndex', result: id });
  const batchResult = (results: readonly `0x${string}`[]) => ({ data: encodeFunctionResult({ abi: managerAbi, functionName: 'multicall', result: results }) });

  it('decodes NFT IDs and exact position tuples in two eth_calls pinned to one block', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(batchResult([indexResult(42n), indexResult(99n)]))
      .mockResolvedValueOnce(batchResult([
        encodeFunctionResult({ abi: managerAbi, functionName: 'positions', result: info1 }),
        encodeFunctionResult({ abi: managerAbi, functionName: 'positions', result: info2 }),
      ]));
    const results = await readOwnedPositions({ call } as unknown as ReadClient, account, 2n, blockNumber);
    expect(results).toEqual([{ id: 42n, info: info1 }, { id: 99n, info: info2 }]);
    expect(call).toHaveBeenCalledTimes(2);
    const encodedBatches = call.mock.calls.map(([args]) => {
      expect(args.to).toBe(ADDRESSES.manager);
      expect(args.blockNumber).toBe(blockNumber);
      const decoded = decodeFunctionData({ abi: managerAbi, data: args.data });
      if (decoded.functionName !== 'multicall') throw new Error('expected NPM multicall');
      return decoded.args[0].map((data) => decodeFunctionData({ abi: managerAbi, data }));
    });
    expect(encodedBatches[0].map((result) => [result.functionName, result.args])).toEqual([
      ['tokenOfOwnerByIndex', [account, 0n]], ['tokenOfOwnerByIndex', [account, 1n]],
    ]);
    expect(encodedBatches[1].map((result) => [result.functionName, result.args])).toEqual([
      ['positions', [42n]], ['positions', [99n]],
    ]);
  });

  it('does not issue calls for an empty wallet and fails closed above the NFT cap', async () => {
    const call = vi.fn();
    const client = { call } as unknown as ReadClient;
    expect(await readOwnedPositions(client, account, 0n, blockNumber)).toEqual([]);
    await expect(readOwnedPositions(client, account, 201n, blockNumber)).rejects.toThrow('200');
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects truncated batches and duplicate NFT IDs rather than showing partial holdings', async () => {
    const call = vi.fn().mockResolvedValueOnce(batchResult([indexResult(42n)]));
    await expect(readOwnedPositions({ call } as unknown as ReadClient, account, 2n, blockNumber)).rejects.toThrow('不完整');
    call.mockResolvedValueOnce(batchResult([indexResult(42n), indexResult(42n)]));
    await expect(readOwnedPositions({ call } as unknown as ReadClient, account, 2n, blockNumber)).rejects.toThrow('重复');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('rejects missing return data from the manager', async () => {
    const call = vi.fn().mockResolvedValue({ data: '0x' });
    await expect(readOwnedPositions({ call } as unknown as ReadClient, account, 1n, blockNumber)).rejects.toThrow('未返回');
  });
});
