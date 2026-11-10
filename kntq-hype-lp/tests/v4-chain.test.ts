import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { zeroAddress } from 'viem';
import { ADDRESSES, DEFAULT_SETTINGS, POOL_ID, POOL_KEY } from '../src/elysium/config';
import type { PoolState } from '../src/lib/types';

const mocks = vi.hoisted(() => ({ create: vi.fn(), identity: vi.fn() }));
vi.mock('../src/lib/readTransport', () => ({ createSafeReadClient: mocks.create }));
vi.mock('../src/elysium/identity', () => ({ assertRuntimeIdentity: mocks.identity }));
import {
  computePoolId, decodeTicks, discoverOwnedIds, feesFromGrowth, isMissingToken, isTargetPool,
  loadSnapshot, readPositionAt, replayTransfers, validateDeployment,
} from '../src/elysium/chain';
import type { ReadClient, TransferRecord } from '../src/elysium/chain';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const HASH = `0x${'11'.repeat(32)}` as Hex;
const HASH2 = `0x${'22'.repeat(32)}` as Hex;
const Q128 = 1n << 128n;
const packed = (lower = -200, upper = 200) => (BigInt.asUintN(24, BigInt(lower)) << 8n) | (BigInt.asUintN(24, BigInt(upper)) << 32n);
const pool: PoolState = { address: ADDRESSES.poolManager, poolId: POOL_ID, hooks: zeroAddress, fee: 10000, tickSpacing: 200, token0: zeroAddress, token1: ADDRESSES.kntq, sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 1_000_000n };
const block = (hash = HASH, seconds = Math.floor(Date.now() / 1000)) => ({ number: 777n, hash, timestamp: BigInt(seconds) });
const missing = () => Object.assign(new Error('missing NFT'), { name: 'ContractFunctionRevertedError', reason: 'NOT_MINTED' });

function clientFixture() {
  const client = {
    getBlock: vi.fn().mockImplementation(async () => block()),
    getCode: vi.fn().mockResolvedValue('0x6000'),
    getBalance: vi.fn().mockResolvedValue(10n ** 19n),
    getLogs: vi.fn().mockResolvedValue([]),
    rpcUrl: () => 'https://verified.test',
    readContract: vi.fn().mockImplementation(async ({ functionName, address }: { functionName: string; address: Address }) => {
      switch (functionName) {
        case 'symbol': return 'KNTQ';
        case 'decimals': return 18;
        case 'poolManager': return ADDRESSES.poolManager;
        case 'permit2': return ADDRESSES.permit2;
        case 'WETH9': return ADDRESSES.whype;
        case 'getSlot0': return [1n << 96n, 0, 0, 10000];
        case 'getLiquidity': return pool.liquidity;
        case 'balanceOf': return address.toLowerCase() === ADDRESSES.manager.toLowerCase() ? 0n : 10n ** 18n;
        case 'nextTokenId': return 500n;
        case 'ownerOf': return OTHER;
        case 'getPoolAndPositionInfo': return [POOL_KEY, packed()];
        case 'getPositionLiquidity': return 10n;
        case 'getPositionInfo': return [10n, 0n, 0n];
        case 'getFeeGrowthInside': return [Q128, Q128 * 2n];
        default: throw new Error(`unhandled ${functionName}`);
      }
    }),
  };
  mocks.create.mockReturnValue(client);
  return client;
}
const asClient = (client: ReturnType<typeof clientFixture>) => client as unknown as ReadClient;

beforeEach(() => { vi.clearAllMocks(); mocks.identity.mockReturnValue({ verified: true, evidence: ['TEST FIXTURE canonical code identity'] }); });

describe('v4 pool identity and canonical accounting', () => {
  it('commits the entire PoolKey and rejects otherwise matching hooked pools', () => {
    expect(computePoolId(POOL_KEY)).toBe(POOL_ID);
    expect(isTargetPool(POOL_KEY)).toBe(true);
    expect(isTargetPool({ ...POOL_KEY, hooks: OTHER })).toBe(false);
    expect(isTargetPool({ ...POOL_KEY, currency0: OTHER })).toBe(false);
  });
  it('decodes signed ticks and rejects invalid spacing/bounds', () => {
    expect(decodeTicks(packed())).toEqual({ tickLower: -200, tickUpper: 200 });
    expect(() => decodeTicks(packed(-200, 100))).toThrow('区间');
    expect(() => decodeTicks(packed(200, -200))).toThrow('区间');
  });
  it('computes fee growth with uint256 wraparound and validates integer bounds', () => {
    expect(feesFromGrowth(10n, Q128, 0n)).toBe(10n);
    expect(feesFromGrowth(10n, 0n, (1n << 256n) - Q128)).toBe(10n);
    expect(() => feesFromGrowth(-1n, 0n, 0n)).toThrow('无效');
  });
  it('only recognizes an actual non-minted contract revert, not a network error message', () => {
    expect(isMissingToken(missing())).toBe(true);
    expect(isMissingToken(Object.assign(new Error(), { cause: missing() }))).toBe(true);
    expect(isMissingToken(new Error('RPC failed NOT_MINTED'))).toBe(false);
  });
});

describe('v4 NFT discovery', () => {
  const transfer = (n: bigint, from: Address, to: Address, id = 42n): TransferRecord => ({ blockNumber: n, transactionIndex: 0, logIndex: 0, args: { from, to, tokenId: id } });
  it('replays out-then-in and self-transfers in real chain order', () => {
    const logs = [transfer(11n, OTHER, ACCOUNT), transfer(10n, ACCOUNT, OTHER), transfer(12n, ACCOUNT, ACCOUNT)];
    expect([...replayTransfers(logs, ACCOUNT)]).toEqual(['42']);
    expect(() => replayTransfers([{ ...logs[0], removed: true }], ACCOUNT)).toThrow('顺序');
  });
  it('keeps current ownerOf results and skips historical scans when balance proves completeness', async () => {
    const client = clientFixture();
    client.readContract.mockImplementation(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => functionName === 'nextTokenId' ? 121n : args?.[0] === 42n ? ACCOUNT : OTHER);
    const result = await discoverOwnedIds(asClient(client), ACCOUNT, 1n, [], 777n);
    expect(result).toEqual({ ids: [42n], complete: true });
    expect(client.getLogs).not.toHaveBeenCalled();
    for (const [call] of client.readContract.mock.calls) expect(call.blockNumber).toBe(777n);
  });
  it('uses ordered log replay then fixed-block ownerOf and reports partial old holdings', async () => {
    const client = clientFixture();
    client.readContract.mockImplementation(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => functionName === 'nextTokenId' ? 500n : args?.[0] === 42n ? ACCOUNT : OTHER);
    client.getLogs.mockImplementation(async ({ args }: { args: { to?: Address; from?: Address } }) => args.to ? [transfer(11n, OTHER, ACCOUNT)] : [transfer(10n, ACCOUNT, OTHER)]);
    const result = await discoverOwnedIds(asClient(client), ACCOUNT, 2n, [], 777n);
    expect(result).toEqual({ ids: [42n], complete: false });
    for (const [call] of client.getLogs.mock.calls) expect(call.toBlock <= 777n && call.toBlock - call.fromBlock < 1800n).toBe(true);
  });
  it('does not turn owner or log RPC failures into an empty successful scan', async () => {
    const client = clientFixture();
    client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => { if (functionName === 'nextTokenId') return 500n; throw new Error('owner RPC unavailable'); });
    await expect(discoverOwnedIds(asClient(client), ACCOUNT, 1n, [], 777n)).rejects.toThrow('owner RPC unavailable');
    client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'nextTokenId' ? 500n : OTHER);
    client.getLogs.mockRejectedValue(new Error('log RPC unavailable'));
    await expect(discoverOwnedIds(asClient(client), ACCOUNT, 1n, [], 777n)).rejects.toThrow('log RPC unavailable');
  });
  it('validates manual TokenIds and caps total owner scans', async () => {
    const client = clientFixture();
    await expect(discoverOwnedIds(asClient(client), ACCOUNT, 201n, [], 777n)).rejects.toThrow('200');
    await expect(discoverOwnedIds(asClient(client), ACCOUNT, 1n, ['-5'], 777n)).rejects.toThrow('TokenId');
  });
});

describe('v4 position reads', () => {
  it('uses the tokenId salt and maps native HYPE / KNTQ fees without swallowing failures', async () => {
    const client = clientFixture();
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (call) => call.functionName === 'ownerOf' ? ACCOUNT : original(call));
    const position = await readPositionAt(asClient(client), ACCOUNT, 42n, pool, 777n);
    expect(position?.feeWhype).toBe('0.00000000000000001');
    expect(position?.feeKntq).toBe('0.00000000000000002');
    const coreCall = client.readContract.mock.calls.find(([call]) => call.functionName === 'getPositionInfo')![0];
    expect(coreCall.args).toEqual([POOL_ID, ADDRESSES.manager, -200, 200, `0x${'0'.repeat(62)}2a`]);
    for (const [call] of client.readContract.mock.calls) expect(call.blockNumber).toBe(777n);
    client.readContract.mockImplementation(async (call) => { if (call.functionName === 'getFeeGrowthInside') throw new Error('fee read failed'); return call.functionName === 'ownerOf' ? ACCOUNT : original(call); });
    await expect(readPositionAt(asClient(client), ACCOUNT, 42n, pool, 777n)).rejects.toThrow('fee read failed');
  });
  it('rejects another owner and does not treat a hooked position as the target pool', async () => {
    const client = clientFixture();
    await expect(readPositionAt(asClient(client), ACCOUNT, 42n, pool, 777n)).rejects.toThrow('不属于');
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (call) => call.functionName === 'ownerOf' ? ACCOUNT : call.functionName === 'getPoolAndPositionInfo' ? [{ ...POOL_KEY, hooks: OTHER }, packed()] : original(call));
    await expect(readPositionAt(asClient(client), ACCOUNT, 42n, pool, 777n)).resolves.toBeNull();
    expect(client.readContract.mock.calls.some(([call]) => call.functionName === 'getFeeGrowthInside')).toBe(false);
  });
});

describe('v4 deployment and snapshot', () => {
  it('keeps unverified code gated while exposing genuine read results and stable fingerprints', async () => {
    const client = clientFixture();
    mocks.identity.mockReturnValue({ verified: false, evidence: ['untrusted code'] });
    const a = await loadSnapshot(DEFAULT_SETTINGS);
    expect(a.deployment?.verified).toBe(false);
    expect(a.warnings.join('')).toContain('交易保持禁用');
    expect(a.quoteSymbol).toBe('HYPE');
    expect(a.chainId).toBe(99901);
    client.getBlock.mockImplementation(async () => block(HASH2));
    const b = await loadSnapshot(DEFAULT_SETTINGS);
    expect(a.deployment?.fingerprint).toBe(b.deployment?.fingerprint);
    expect(a.deployment?.blockHash).not.toBe(b.deployment?.blockHash);
  });
  it('locks reads to one block and records actual native and wrapped balances separately', async () => {
    const client = clientFixture();
    const snapshot = await loadSnapshot(DEFAULT_SETTINGS, ACCOUNT);
    expect(snapshot.balances).toEqual({ kntq: '1', whype: '1', hype: '10' });
    expect(snapshot.positionsComplete).toBe(true);
    expect(snapshot.positions).toEqual([]);
    for (const [call] of client.readContract.mock.calls) expect(call.blockNumber).toBe(777n);
    for (const [call] of client.getCode.mock.calls) expect(call.blockNumber).toBe(777n);
  });
  it('does not label an incomplete older-wallet scan as an empty wallet', async () => {
    const client = clientFixture();
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (call) => {
      if (call.functionName === 'balanceOf' && call.address.toLowerCase() === ADDRESSES.manager.toLowerCase()) return 2n;
      if (call.functionName === 'ownerOf') return OTHER;
      return original(call);
    });
    const snapshot = await loadSnapshot(DEFAULT_SETTINGS, ACCOUNT);
    expect(snapshot.positionsComplete).toBe(false);
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.warnings.join('')).toContain('不代表钱包没有持仓');
  });
  it('rejects wrong manager wiring and block-hash disagreement', async () => {
    const client = clientFixture();
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (call) => call.functionName === 'permit2' ? OTHER : original(call));
    await expect(loadSnapshot(DEFAULT_SETTINGS)).rejects.toThrow('关联');
    client.readContract.mockImplementation(original);
    client.getBlock.mockImplementation(async (call) => call.blockTag ? block() : block(HASH2));
    await expect(loadSnapshot(DEFAULT_SETTINGS)).rejects.toThrow('哈希');
  });
  it('uses block time rather than response time to reject stale signing checks', async () => {
    const client = clientFixture();
    client.getBlock.mockImplementation(async () => block(HASH, Math.floor(Date.now() / 1000) - 200));
    const snapshot = await loadSnapshot(DEFAULT_SETTINGS);
    expect(snapshot.warnings.join('')).toContain('已过期');
    await expect(validateDeployment(DEFAULT_SETTINGS)).rejects.toThrow('区块已过期');
  });
});
