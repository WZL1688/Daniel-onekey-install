import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseAbi, parseUnits } from 'viem';
import { Price, Token } from '@uniswap/sdk-core';
import { tickToPrice } from '@uniswap/v3-sdk';
import type { Address, EIP1193Provider, Hex } from 'viem';
import { ADDRESSES, DEFAULT_SETTINGS } from '../src/lib/config';
import { createReadClient } from '../src/lib/chain';
import { executePlan, prepareExit, prepareOpen, rangeTicks, simulateStep } from '../src/lib/transactions';
import type { Settings, Snapshot, TxPlan } from '../src/lib/types';

vi.mock('../src/lib/chain', () => ({ createReadClient: vi.fn() }));
const account = '0x1234567890123456789012345678901234567890' as Address;
const poolAddress = '0x1111111111111111111111111111111111111111' as Address;
const hash = `0x${'ab'.repeat(32)}` as Hex;
const settings: Settings = { ...DEFAULT_SETTINGS, rpcUrls: ['https://example.com'] };
const decodeAbi = parseAbi([
  'function approve(address spender,uint256 amount) returns(bool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function multicall(bytes[] data) payable returns(bytes[] results)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns(uint256 amount0,uint256 amount1)',
]);

function snapshot(): Snapshot {
  return { blockNumber: 100n, blockTime: Date.now(), fetchedAt: Date.now(), pool: { address: poolAddress, fee: 3000, tick: 0, sqrtPriceX96: 1n << 96n, liquidity: parseUnits('100', 18), tickSpacing: 60, token0: ADDRESSES.kntq, token1: ADDRESSES.whype }, balances: { kntq: '100', whype: '100', hype: '100' }, positions: [], kntqDecimals: 18, whypeDecimals: 18, rpcUrl: settings.rpcUrls[0], warnings: [] };
}
const input = { kntq: '10', whype: '10', useNative: true, lowerPrice: '0.5', upperPrice: '2' };
function plan(steps = 1): TxPlan {
  return { id: crypto.randomUUID(), kind: 'collect', account, chainId: 999, createdAt: Date.now(), expiresAt: Date.now() + 300_000, sourceBlock: 100n, summary: [], slippageBps: 50, steps: Array.from({ length: steps }, () => ({ label: 'collect', to: ADDRESSES.manager, data: '0x12345678' as Hex, value: 0n })) };
}

const client = {
  readContract: vi.fn(), getBlock: vi.fn(), call: vi.fn(), estimateGas: vi.fn(), getGasPrice: vi.fn(), getBalance: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransaction: vi.fn(),
};
function wallet(send = vi.fn().mockResolvedValue(hash)) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x3e7';
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_sendTransaction') return send();
    throw new Error(`unexpected ${method}`);
  });
  return { provider: { request } as unknown as EIP1193Provider, request, send };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createReadClient).mockReturnValue(client as unknown as ReturnType<typeof createReadClient>);
  client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'feeAmountTickSpacing' ? 60 : functionName === 'ownerOf' ? account : functionName === 'getPool' ? poolAddress : 0n);
  client.getBlock.mockImplementation(async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }));
  client.call.mockResolvedValue({ data: '0x' });
  client.estimateGas.mockResolvedValue(100_000n);
  client.getGasPrice.mockResolvedValue(1_000_000_000n);
  client.getBalance.mockResolvedValue(parseUnits('100', 18));
  client.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: hash });
  client.getTransaction.mockResolvedValue({ hash, from: account, to: ADDRESSES.manager, input: '0x12345678', value: 0n });
});

describe('budget and calldata', () => {
  it('rejects another profile snapshot before constructing any approvals or calldata', async () => {
    const other = { ...snapshot(), profile: 'elysium-v4' as const, chainId: 99901, quoteSymbol: 'HYPE' as const };
    await expect(prepareOpen(settings, other, account, input)).rejects.toThrow('不属于 HyperEVM v3');
    expect(client.readContract).not.toHaveBeenCalled();
  });
  it('uses the protocol usable tick bounds for an explicit full-range position', async () => {
    const p = await prepareOpen(settings, snapshot(), account, { ...input, lowerPrice: '', upperPrice: '', rangeMode: 'full' });
    const minted = decodeFunctionData({ abi: decodeAbi, data: p.steps.at(-1)!.data });
    if (minted.functionName !== 'mint') throw new Error('mint expected');
    expect(minted.args[0].tickLower).toBe(-887220);
    expect(minted.args[0].tickUpper).toBe(887220);
    expect(minted.args[0].amount0Desired).toBeLessThanOrEqual(parseUnits('10', 18));
    expect(minted.args[0].amount1Desired).toBeLessThanOrEqual(parseUnits('10', 18));
  });
  it('rounds both human bounds outward when the floored upper tick is an exact spacing multiple', () => {
    const range = rangeTicks('0.99', '1.00001', 60, snapshot());
    expect(range.tickUpper).toBe(60);
    const k = new Token(999, ADDRESSES.kntq, 18);
    const w = new Token(999, ADDRESSES.whype, 18);
    expect(tickToPrice(k, w, range.tickLower).greaterThan(new Price(k, w, '100000', '99000'))).toBe(false);
    expect(tickToPrice(k, w, range.tickUpper).lessThan(new Price(k, w, '100000', '100001'))).toBe(false);
    expect(rangeTicks('0.99', '1', 60, snapshot()).tickUpper).toBe(0);
  });
  it('uses SDK maximum spend within budget, matching exact approvals and native wrapping', async () => {
    const p = await prepareOpen(settings, snapshot(), account, input);
    const minted = decodeFunctionData({ abi: decodeAbi, data: p.steps.at(-1)!.data });
    expect(minted.functionName).toBe('mint');
    if (minted.functionName !== 'mint') throw new Error('mint expected');
    const args = minted.args[0];
    expect(args.recipient.toLowerCase()).toBe(account.toLowerCase());
    expect(args.amount0Desired).toBeLessThanOrEqual(parseUnits('10', 18));
    expect(args.amount1Desired).toBeLessThanOrEqual(parseUnits('10', 18));
    expect(args.amount0Min).toBeGreaterThan(0n);
    expect(args.amount1Min).toBeGreaterThan(0n);
    expect(args.amount0Min).toBeLessThanOrEqual(args.amount0Desired);
    expect(args.amount1Min).toBeLessThanOrEqual(args.amount1Desired);
    expect(p.steps[0].value).toBe(args.amount1Desired);
    const approveK = decodeFunctionData({ abi: decodeAbi, data: p.steps[1].data });
    const approveW = decodeFunctionData({ abi: decodeAbi, data: p.steps[2].data });
    expect(approveK.args).toEqual([ADDRESSES.manager, args.amount0Desired]);
    expect(approveW.args).toEqual([ADDRESSES.manager, args.amount1Desired]);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.steps[0])).toBe(true);
    expect(p.expiresAt - p.createdAt).toBe(300_000);
  });

  it('combines new pool initialization with mint and explicitly previews the chosen initial price', async () => {
    const s = snapshot(); s.pool = null;
    const p = await prepareOpen(settings, s, account, input);
    const decoded = decodeFunctionData({ abi: decodeAbi, data: p.steps.at(-1)!.data });
    expect(decoded.functionName).toBe('multicall');
    if (decoded.functionName !== 'multicall') throw new Error('multicall expected');
    expect(decoded.args[0]).toHaveLength(2);
    expect(p.summary.join(' ')).toContain('初始化');
  });

  it('rejects a new pool whose chosen initial price is outside the range or has zero minimum on one side', async () => {
    const s = snapshot(); s.pool = null;
    await expect(prepareOpen(settings, s, account, { ...input, lowerPrice: '2', upperPrice: '3' })).rejects.toThrow('初始价格');
    await expect(prepareOpen({ ...settings, slippageBps: 100 }, s, account, { ...input, lowerPrice: '0.9999', upperPrice: '1.00001' })).rejects.toThrow('双边最低投入');
  });

  it('requires a new preview if another transaction initializes the new pool before wrapping or minting', async () => {
    const s = snapshot(); s.pool = null;
    const p = await prepareOpen(settings, s, account, input);
    client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'getPool' ? poolAddress : functionName === 'slot0' ? [1n << 96n, 0, 0, 0, 0, 0, true] : 0n);
    await expect(simulateStep(settings, p, p.steps[0])).rejects.toThrow('已被其他交易初始化');
    await expect(simulateStep(settings, p, p.steps.at(-1)!)).rejects.toThrow('已被其他交易初始化');
    expect(client.call).not.toHaveBeenCalled();
    expect(client.estimateGas).not.toHaveBeenCalled();
  });

  it('allows an uninitialized new pool but rejects a fee changed after preview', async () => {
    const s = snapshot(); s.pool = null;
    const p = await prepareOpen(settings, s, account, input);
    client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'getPool' ? poolAddress : functionName === 'slot0' ? [0n, 0, 0, 0, 0, 0, true] : 0n);
    await expect(simulateStep(settings, p, p.steps[0])).resolves.toEqual({ gas: 100_000n });
    await expect(simulateStep({ ...settings, fee: 10_000 }, p, p.steps[0])).rejects.toThrow('费率配置已变化');
    await expect(prepareOpen({ ...settings, fee: 10_000 }, snapshot(), account, input)).rejects.toThrow('池费率');
  });

  it('does not grant unlimited approval and resets an old nonzero allowance first', async () => {
    client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'feeAmountTickSpacing' ? 60 : 123n);
    const p = await prepareOpen(settings, snapshot(), account, { ...input, useNative: false });
    expect(decodeFunctionData({ abi: decodeAbi, data: p.steps[0].data }).args).toEqual([ADDRESSES.manager, 0n]);
    const grant = decodeFunctionData({ abi: decodeAbi, data: p.steps[1].data });
    expect(grant.functionName).toBe('approve');
    if (grant.functionName !== 'approve') throw new Error('approval expected');
    expect(grant.args[1]).toBeLessThanOrEqual(parseUnits('10', 18));
  });

  it('blocks stale snapshots, invalid range, excessive slippage and insufficient reserve', async () => {
    const stale = snapshot(); stale.blockTime -= 91_000;
    await expect(prepareOpen(settings, stale, account, input)).rejects.toThrow('过期');
    await expect(prepareOpen(settings, snapshot(), account, { ...input, lowerPrice: '3' })).rejects.toThrow('下限');
    await expect(prepareOpen({ ...settings, slippageBps: 501 }, snapshot(), account, input)).rejects.toThrow('滑点');
    const poor = snapshot(); poor.balances.hype = '10.01';
    await expect(prepareOpen(settings, poor, account, input)).rejects.toThrow('余额不足');
  });

  it('exits all liquidity atomically and encodes principal minima', async () => {
    const s = snapshot();
    const p = await prepareExit(settings, s, account, { tokenId: '42', pool: s.pool!, tickLower: -60, tickUpper: 60, liquidity: 1234n, amountKntq: '10', amountWhype: '2', feeKntq: '1', feeWhype: '0.1', inRange: true });
    const decoded = decodeFunctionData({ abi: decodeAbi, data: p.steps[0].data });
    expect(decoded.functionName).toBe('multicall');
    if (decoded.functionName !== 'multicall') throw new Error('multicall expected');
    expect(decoded.args[0]).toHaveLength(2);
    const decrease = decodeFunctionData({ abi: decodeAbi, data: decoded.args[0][0] });
    if (decrease.functionName !== 'decreaseLiquidity') throw new Error('decrease expected');
    expect(decrease.args[0].liquidity).toBe(1234n);
    expect(decrease.args[0].amount0Min).toBe(parseUnits('9.95', 18));
    expect(decrease.args[0].amount1Min).toBe(parseUnits('1.99', 18));
  });
});

describe('one-shot wallet boundary', () => {
  it('honors a stop arriving during the final asynchronous account check', async () => {
    const w = wallet(); let keepGoing = true, accountReads = 0;
    const original = w.request.getMockImplementation()!;
    w.request.mockImplementation(async (args) => {
      if (args.method === 'eth_accounts' && ++accountReads === 2) keepGoing = false;
      return original(args);
    });
    await expect(executePlan(plan(), settings, w.provider, () => {}, () => keepGoing)).rejects.toThrow('未请求钱包签名');
    expect(w.send).not.toHaveBeenCalled();
  });

  it('does not request an approval if the final wallet response arrives after preview expiry', async () => {
    const p = await prepareOpen(settings, snapshot(), account, { ...input, useNative: false });
    expect(decodeFunctionData({ abi: decodeAbi, data: p.steps[0].data }).functionName).toBe('approve');
    const w = wallet(); let accountReads = 0;
    const original = w.request.getMockImplementation()!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    w.request.mockImplementation(async (args) => {
      if (args.method === 'eth_accounts' && ++accountReads === 2) clock.mockReturnValue(p.expiresAt + 1);
      return original(args);
    });
    try { await expect(executePlan(p, settings, w.provider, () => {})).rejects.toThrow('过期'); }
    finally { clock.mockRestore(); }
    expect(w.send).not.toHaveBeenCalled();
    expect(accountReads).toBe(2);
  });

  it('simulates and estimates every step before exactly one send, awaiting confirmed receipt', async () => {
    const trace: string[] = [];
    client.call.mockImplementation(async () => { trace.push('call'); return {}; });
    client.estimateGas.mockImplementation(async () => { trace.push('estimate'); return 100_000n; });
    const w = wallet(vi.fn(async () => { trace.push('send'); return hash; }));
    await executePlan(plan(2), settings, w.provider, event => { if (event.status === 'confirmed') trace.push('confirmed'); });
    expect(trace).toEqual(['call', 'estimate', 'send', 'confirmed', 'call', 'estimate', 'send', 'confirmed']);
    expect(w.send).toHaveBeenCalledTimes(2);
  });

  it('stops before signature when simulation reverts', async () => {
    client.call.mockRejectedValue(new Error('execution reverted'));
    const w = wallet();
    await expect(executePlan(plan(2), settings, w.provider, () => {})).rejects.toThrow('reverted');
    expect(w.send).not.toHaveBeenCalled();
  });

  it('never resends an ambiguous send or permits replay of the same plan', async () => {
    const w = wallet(vi.fn().mockRejectedValue(new Error('wallet transport disconnected')));
    const p = plan(2);
    await expect(executePlan(p, settings, w.provider, () => {})).rejects.toThrow('未自动重发');
    await expect(executePlan(p, settings, w.provider, () => {})).rejects.toThrow('已经执行过');
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it('surfaces hash on uncertain receipt and does not send another step', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new Error('receipt timeout'));
    const events: string[] = [];
    const w = wallet();
    await expect(executePlan(plan(2), settings, w.provider, event => { if (event.hash) events.push(event.hash); })).rejects.toThrow(hash);
    expect(w.send).toHaveBeenCalledTimes(1);
    expect(events).toContain(hash);
  });

  it.each([
    { from: ADDRESSES.kntq }, { to: ADDRESSES.kntq }, { input: '0xffffffff' }, { value: 1n }, { hash: `0x${'cd'.repeat(32)}` },
  ])('stops after a confirmed receipt if the actual transaction differs from preview: %o', async mismatch => {
    client.getTransaction.mockResolvedValue({ hash, from: account, to: ADDRESSES.manager, input: '0x12345678', value: 0n, ...mismatch });
    const w = wallet();
    await expect(executePlan(plan(2), settings, w.provider, () => {})).rejects.toThrow('与预览不符');
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it('stops subsequent steps on wallet account change or insufficient gas reserve', async () => {
    const w = wallet();
    w.request.mockImplementation(async ({ method }) => method === 'eth_chainId' ? '0x1' : [account]);
    await expect(executePlan(plan(), settings, w.provider, () => {})).rejects.toThrow('网络或账户');
    expect(w.send).not.toHaveBeenCalled();
    client.getBalance.mockResolvedValue(parseUnits('0.02', 18));
    const w2 = wallet();
    await expect(executePlan(plan(), settings, w2.provider, () => {})).rejects.toThrow('Gas');
    expect(w2.send).not.toHaveBeenCalled();
  });

  it('rejects stale chain heads and expired plans before any send', async () => {
    client.getBlock.mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 100) });
    await expect(simulateStep(settings, plan(), plan().steps[0])).rejects.toThrow('过期');
    const p = plan(); p.expiresAt = Date.now() - 1;
    const w = wallet();
    await expect(executePlan(p, settings, w.provider, () => {})).rejects.toThrow('过期');
    expect(w.send).not.toHaveBeenCalled();
  });
});
