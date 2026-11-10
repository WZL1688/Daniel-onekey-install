import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbi, parseUnits, toHex, zeroAddress } from 'viem';
import type { Address, EIP1193Provider, Hex } from 'viem';
import { ADDRESSES, CHAIN_ID, DEFAULT_SETTINGS, POOL_ID } from '../src/elysium/config';
import { createReadClient, readPosition, validateDeployment } from '../src/elysium/chain';
import { executePlan, prepareCollect, prepareExit, prepareOpen, rangeTicks, reconcilePending, simulateStep } from '../src/elysium/transactions';
import type { ExecutionEvent, PositionState, Settings, Snapshot, TxPlan } from '../src/lib/types';

vi.mock('../src/elysium/chain', () => ({ createReadClient: vi.fn(), readPosition: vi.fn(), validateDeployment: vi.fn() }));
const settings: Settings = { ...DEFAULT_SETTINGS, rpcUrls: ['https://rpc.example'] };
const fingerprint = `0x${'ac'.repeat(32)}` as Hex;
const blockHash = `0x${'de'.repeat(32)}` as Hex;
const decodeAbi = parseAbi([
  'function modifyLiquidities(bytes unlockData,uint256 deadline) payable',
  'function approve(address spender,uint256 amount) returns(bool)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
]);
const mintParams = [
  { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
  { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' },
] as const;
const input = { kntq: '10', whype: '10', useNative: true, lowerPrice: '0.5', upperPrice: '2' };
let accountSequence = 1000;
let account: Address;
let walletAccount: Address;
let walletChain: number;
let ercAllowance: bigint;
let permitAllowance: readonly [bigint, number, number];
let nonce: number;
let receiptStatus: 'success' | 'reverted';
let txOverrides: Record<string, unknown>;
type Sent = { from: Address; to: Address; data: Hex; value: Hex; nonce: Hex };
const sent = new Map<Hex, Sent>();
afterEach(() => vi.unstubAllGlobals());
const client = { readContract: vi.fn(), getBlock: vi.fn(), call: vi.fn(), estimateGas: vi.fn(), getGasPrice: vi.fn(), getBalance: vi.fn(), getTransactionCount: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransactionReceipt: vi.fn(), getTransaction: vi.fn() };
function snapshot(): Snapshot {
  return { blockNumber: 100n, blockTime: Date.now(), fetchedAt: Date.now(),
    pool: { address: ADDRESSES.poolManager, poolId: POOL_ID, hooks: zeroAddress, token0: zeroAddress, token1: ADDRESSES.kntq, fee: 10000, tickSpacing: 200, tick: 0, sqrtPriceX96: 1n << 96n, liquidity: parseUnits('1000', 18) },
    balances: { kntq: '1000', whype: '0', hype: '1000' }, positions: [], kntqDecimals: 18, whypeDecimals: 18, rpcUrl: settings.rpcUrls[0], warnings: [],
    profile: 'elysium-v4', chainId: CHAIN_ID, manager: ADDRESSES.manager, kntqAddress: ADDRESSES.kntq, quoteSymbol: 'HYPE', positionsComplete: true,
    deployment: { verified: true, fingerprint, blockHash, evidence: ['test fixture'] } };
}
function position(): PositionState { return { tokenId: '42', pool: snapshot().pool!, tickLower: -200, tickUpper: 200, liquidity: 12345n, amountKntq: '10', amountWhype: '2', feeKntq: '1', feeWhype: '0.1', inRange: true }; }
function mainCall(plan: TxPlan) {
  const decoded = decodeFunctionData({ abi: decodeAbi, data: plan.steps.at(-1)!.data });
  if (decoded.functionName !== 'modifyLiquidities') throw new Error('expected modifyLiquidities');
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], decoded.args[0]);
  return { actions, params, deadline: decoded.args[1] };
}
function wallet(error?: unknown) {
  const send = vi.fn(async (tx: Sent) => {
    if (error) throw error;
    const hash = toHex(BigInt(sent.size + accountSequence * 100), { size: 32 });
    sent.set(hash, tx); nonce++;
    return hash;
  });
  const request = vi.fn(async ({ method, params }: { method: string; params?: Sent[] }) => {
    if (method === 'eth_chainId') return toHex(walletChain);
    if (method === 'eth_accounts') return [walletAccount];
    if (method === 'eth_sendTransaction') return send(params![0]);
    throw new Error(`Unexpected wallet method ${method}`);
  });
  return { provider: { request } as unknown as EIP1193Provider, request, send };
}
beforeEach(() => {
  vi.resetAllMocks();
  account = getAddress(toHex(BigInt(++accountSequence), { size: 20 }));
  walletAccount = account; walletChain = CHAIN_ID; ercAllowance = 0n; permitAllowance = [0n, 0, 0]; nonce = 7; receiptStatus = 'success'; txOverrides = {}; sent.clear();
  vi.mocked(createReadClient).mockReturnValue(client as unknown as ReturnType<typeof createReadClient>);
  vi.mocked(validateDeployment).mockResolvedValue({ verified: true, fingerprint, blockHash, evidence: [] });
  vi.mocked(readPosition).mockImplementation(async () => position());
  client.readContract.mockImplementation(async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (functionName === 'balanceOf') return parseUnits('1000', 18);
    if (functionName === 'allowance') return address.toLowerCase() === ADDRESSES.kntq.toLowerCase() ? ercAllowance : permitAllowance;
    throw new Error(`Unexpected read ${functionName}`);
  });
  client.getBlock.mockImplementation(async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }));
  client.call.mockResolvedValue({ data: '0x' }); client.estimateGas.mockResolvedValue(100000n); client.getGasPrice.mockResolvedValue(1000000000n); client.getBalance.mockResolvedValue(parseUnits('1000', 18));
  client.getTransactionCount.mockImplementation(async () => nonce);
  const receipt = async ({ hash }: { hash: Hex }) => ({ status: receiptStatus, transactionHash: hash });
  client.waitForTransactionReceipt.mockImplementation(receipt); client.getTransactionReceipt.mockImplementation(receipt);
  client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
    const tx = sent.get(hash); if (!tx) throw new Error('Transaction not found');
    return { hash, from: tx.from, to: tx.to, input: tx.data, value: BigInt(tx.value), nonce: Number(BigInt(tx.nonce)), ...txOverrides };
  });
});

describe('v4 budget, approvals and correct protocol semantics', () => {
  it('keeps upward-rounded mint maximums inside both typed budgets, with native refund to the frozen recipient', async () => {
    const plan = await prepareOpen(settings, snapshot(), account, input);
    const call = mainCall(plan);
    expect(call.actions).toBe('0x020d14');
    const [key, lo, hi, liquidity, maxH, maxK, recipient] = decodeAbiParameters(mintParams, call.params[0]);
    expect(key).toMatchObject({ currency0: zeroAddress, currency1: ADDRESSES.kntq, fee: 10000, tickSpacing: 200, hooks: zeroAddress });
    expect(Math.abs(lo % 200)).toBe(0); expect(Math.abs(hi % 200)).toBe(0); expect(liquidity).toBeGreaterThan(0n);
    expect(maxH).toBeLessThanOrEqual(parseUnits('10', 18)); expect(maxK).toBeLessThanOrEqual(parseUnits('10', 18));
    expect(plan.steps.at(-1)!.value).toBe(maxH); expect(recipient).toBe(account);
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'address' }], call.params[2])).toEqual([zeroAddress, account]);
    const erc = decodeFunctionData({ abi: decodeAbi, data: plan.steps[0].data });
    const permit = decodeFunctionData({ abi: decodeAbi, data: plan.steps[1].data });
    expect(erc.args).toEqual([ADDRESSES.permit2, maxK]);
    expect(permit.args).toEqual([ADDRESSES.kntq, ADDRESSES.manager, maxK, Number(call.deadline)]);
    expect(Number(call.deadline)).toBeLessThanOrEqual(Math.floor(plan.expiresAt / 1000));
    expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.steps[0])).toBe(true);
  });

  it('reduces liquidity rather than expanding a hard budget under maximum allowed slippage', async () => {
    const plan = await prepareOpen({ ...settings, slippageBps: 500 }, snapshot(), account, { ...input, kntq: '1.000000000000000001', whype: '0.999999999999999999', rangeMode: 'full' });
    const [, lo, hi, liquidity, maxH, maxK] = decodeAbiParameters(mintParams, mainCall(plan).params[0]);
    expect(lo).toBe(-887200); expect(hi).toBe(887200); expect(liquidity).toBeGreaterThan(0n);
    expect(maxH).toBeLessThanOrEqual(parseUnits('0.999999999999999999', 18)); expect(maxK).toBeLessThanOrEqual(parseUnits('1.000000000000000001', 18));
  });

  it('clears old unlimited allowances before replacing both layers with exact expiring amounts', async () => {
    ercAllowance = (1n << 256n) - 1n; permitAllowance = [(1n << 160n) - 1n, Math.floor(Date.now() / 1000) + 86400, 0];
    const plan = await prepareOpen(settings, snapshot(), account, input);
    expect(plan.steps).toHaveLength(5);
    expect(decodeFunctionData({ abi: decodeAbi, data: plan.steps[0].data }).args).toEqual([ADDRESSES.permit2, 0n]);
    expect(decodeFunctionData({ abi: decodeAbi, data: plan.steps[2].data }).args).toEqual([ADDRESSES.kntq, ADDRESSES.manager, 0n, 0]);
    const replacement = decodeFunctionData({ abi: decodeAbi, data: plan.steps[3].data });
    expect(replacement.args?.[2]).toBeLessThanOrEqual(parseUnits('10', 18));
  });

  it.each(['-0.5', '1.2.3', '1e3', ' 1', '.5', '1.0000000000000000001'])('rejects malformed or overprecise budget %s', async bad => {
    await expect(prepareOpen(settings, snapshot(), account, { ...input, kntq: bad })).rejects.toThrow('十进制');
  });

  it('requires verified fresh metadata and the full target PoolKey', async () => {
    const unverified = snapshot(); unverified.deployment!.verified = false;
    await expect(prepareOpen(settings, unverified, account, input)).rejects.toThrow('尚未核实');
    const wrong = snapshot(); wrong.pool!.hooks = ADDRESSES.kntq;
    await expect(prepareOpen(settings, wrong, account, input)).rejects.toThrow('PoolKey');
    const stale = snapshot(); stale.blockTime -= 100000;
    await expect(prepareOpen(settings, stale, account, input)).rejects.toThrow('过期');
    await expect(prepareOpen(settings, snapshot(), account, { ...input, useNative: false })).rejects.toThrow('原生 HYPE');
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite snapshot time %s rather than bypassing the stale check', async time => {
    const invalid = snapshot(); invalid.blockTime = time;
    await expect(prepareCollect(settings, invalid, account, position())).rejects.toThrow('时间戳无效');
  });

  it('uses zero PRINCIPAL minima for collecting positive v4 fees', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    const call = mainCall(plan);
    expect(call.actions).toBe('0x0111');
    expect(decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], call.params[0])).toEqual([42n, 0n, 0n, 0n, '0x']);
    expect(plan.summary.join(' ')).toContain('不承诺手续费最低到账量');
    await expect(simulateStep(settings, plan, plan.steps[0])).resolves.toEqual({ gas: 100000n });
  });

  it('burns the entire fresh position and takes both native HYPE and KNTQ atomically', async () => {
    const plan = await prepareExit(settings, snapshot(), account, position());
    const call = mainCall(plan);
    expect(call.actions).toBe('0x0311');
    expect(decodeAbiParameters([{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], call.params[0])).toEqual([42n, parseUnits('1.99', 18), parseUnits('9.95', 18), '0x']);
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], call.params[1])).toEqual([zeroAddress, ADDRESSES.kntq, account]);
  });

  it('rejects a manually loaded position from another pool, including another hook', async () => {
    const hooked = position(); hooked.pool.hooks = ADDRESSES.kntq;
    vi.mocked(readPosition).mockResolvedValue(hooked);
    await expect(prepareCollect(settings, snapshot(), account, position())).rejects.toThrow('PoolKey');
  });

  it('orients human HYPE/KNTQ bounds outward and supports exact full range', () => {
    const range = rangeTicks({ lowerPrice: '0.99', upperPrice: '1.00001' });
    expect(range.tickLower).toBe(-200); expect(range.tickUpper).toBe(200);
    expect(rangeTicks({ lowerPrice: '', upperPrice: '', rangeMode: 'full' })).toEqual({ tickLower: -887200, tickUpper: 887200 });
  });
});

describe('v4 one-shot execution and ambiguity locks', () => {
  it('does not persist a pending record or request approval after a delayed final wallet response expires the preview', async () => {
    const plan = await prepareOpen(settings, snapshot(), account, input);
    expect(decodeFunctionData({ abi: decodeAbi, data: plan.steps[0].data }).functionName).toBe('approve');
    const w = wallet(); let accountReads = 0;
    const original = w.request.getMockImplementation()!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    w.request.mockImplementation(async (args) => {
      if (args.method === 'eth_accounts' && ++accountReads === 2) clock.mockReturnValue(plan.expiresAt + 1);
      return original(args);
    });
    try { await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('过期'); }
    finally { clock.mockRestore(); }
    expect(w.send).not.toHaveBeenCalled();
    expect(accountReads).toBe(2);
    expect((await reconcilePending(settings, account)).blocked).toBe(false);
  });

  it('calls and estimates before one send and verifies the actual receipt and transaction', async () => {
    const trace: string[] = [];
    const plan = await prepareCollect(settings, snapshot(), account, position());
    client.call.mockImplementation(async () => { trace.push('call'); return {}; });
    client.estimateGas.mockImplementation(async () => { trace.push('estimate'); return 100000n; });
    const w = wallet();
    w.send.mockImplementation(async tx => { trace.push('send'); const hash = toHex(9876n, { size: 32 }); sent.set(hash, tx); return hash; });
    await executePlan(plan, settings, w.provider, e => { if (e.status === 'confirmed') trace.push('confirmed'); });
    expect(trace).toEqual(['call', 'estimate', 'send', 'confirmed']); expect(w.send).toHaveBeenCalledTimes(1);
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('执行过');
  });

  it('blocks changed account and chain before signing, including a change after simulation', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    const w = wallet(); walletAccount = ADDRESSES.kntq;
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('账户或网络'); expect(w.send).not.toHaveBeenCalled();
    walletAccount = account;
    const next = await prepareCollect(settings, snapshot(), account, position());
    client.estimateGas.mockImplementation(async () => { walletChain = 1; return 100000n; });
    await expect(executePlan(next, settings, w.provider, () => {})).rejects.toThrow('账户或网络'); expect(w.send).not.toHaveBeenCalled();
  });

  it('stops if deployment identity or position liquidity changes before signature', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    vi.mocked(validateDeployment).mockResolvedValue({ verified: false, fingerprint, blockHash, evidence: [] });
    const w = wallet(); await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('部署身份'); expect(w.send).not.toHaveBeenCalled();
    vi.mocked(validateDeployment).mockResolvedValue({ verified: true, fingerprint, blockHash, evidence: [] });
    const next = await prepareExit(settings, snapshot(), account, position());
    vi.mocked(readPosition).mockResolvedValue({ ...position(), liquidity: 1n });
    await expect(executePlan(next, settings, w.provider, () => {})).rejects.toThrow('流动性已变化'); expect(w.send).not.toHaveBeenCalled();
  });

  it('does not advance an approval after a reverted receipt', async () => {
    const plan = await prepareOpen(settings, snapshot(), account, input);
    receiptStatus = 'reverted'; const w = wallet(); const events: ExecutionEvent[] = [];
    await expect(executePlan(plan, settings, w.provider, e => events.push(e))).rejects.toThrow('回滚');
    expect(w.send).toHaveBeenCalledTimes(1); expect(events.some(e => e.status === 'confirmed')).toBe(false);
    expect((await reconcilePending(settings, account)).blocked).toBe(false);
  });

  it('preserves a submitted hash and blocks new plans while a receipt is unknown', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    client.waitForTransactionReceipt.mockRejectedValue(new Error('receipt timeout')); client.getTransactionReceipt.mockRejectedValue(new Error('not mined'));
    const w = wallet(); const hashes: Hex[] = [];
    await expect(executePlan(plan, settings, w.provider, e => { if (e.hash) hashes.push(e.hash); })).rejects.toThrow('receipt timeout');
    expect(hashes.length).toBeGreaterThan(0); expect(w.send).toHaveBeenCalledTimes(1);
    await expect(prepareCollect(settings, snapshot(), account, position())).rejects.toThrow('尚未核对完成');
    client.getTransactionReceipt.mockImplementation(async ({ hash }) => ({ status: 'success', transactionHash: hash }));
    expect((await reconcilePending(settings, account)).blocked).toBe(false);
    await expect(prepareCollect(settings, snapshot(), account, position())).resolves.toBeTruthy();
  });

  it('locks an ambiguous send without a hash and only accepts a matching nonce/data hash for recovery', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    const w = wallet(new Error('wallet disconnected during send'));
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('未自动重发');
    await expect(prepareCollect(settings, snapshot(), account, position())).rejects.toThrow('状态不明确');
    expect(w.send).toHaveBeenCalledTimes(1);
    const hash = toHex(99999n, { size: 32 }); sent.set(hash, w.send.mock.calls[0][0]);
    txOverrides = { nonce: 999 };
    expect((await reconcilePending(settings, account, hash)).blocked).toBe(true);
    txOverrides = {};
    expect((await reconcilePending(settings, account, hash)).blocked).toBe(false);
  });

  it('allows a new preview after explicit user rejection but never resends the rejected plan', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    const w = wallet(Object.assign(new Error('User rejected'), { code: 4001 }));
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('User rejected');
    expect((await reconcilePending(settings, account)).blocked).toBe(false);
    await expect(prepareCollect(settings, snapshot(), account, position())).resolves.toBeTruthy();
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('执行过'); expect(w.send).toHaveBeenCalledTimes(1);
  });

  it.each([{ to: ADDRESSES.kntq }, { from: ADDRESSES.kntq }, { input: '0x1234' }, { value: 1n }, { nonce: 9 }])('blocks continuation and keeps the lock if actual transaction differs: %o', async mismatch => {
    const plan = await prepareCollect(settings, snapshot(), account, position()); txOverrides = mismatch; const w = wallet();
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('与预览不符'); expect(w.send).toHaveBeenCalledTimes(1);
    expect((await reconcilePending(settings, account)).blocked).toBe(true);
  });

  it('serializes different plans for the same account even while simulation awaits', async () => {
    const a = await prepareCollect(settings, snapshot(), account, position()), b = await prepareCollect(settings, snapshot(), account, position());
    let release!: () => void, announce!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { announce = resolve; });
    client.call.mockImplementation(async () => { announce(); await gate; return {}; });
    const w = wallet(); const running = executePlan(a, settings, w.provider, () => {}); await started;
    await expect(executePlan(b, settings, w.provider, () => {})).rejects.toThrow('已有正在执行');
    release(); await running; expect(w.send).toHaveBeenCalledTimes(1);
  });

  it('uses one cross-document lock for sending and recovery, before any pending record exists', async () => {
    const saved = new Map<string, string>(); let held = false;
    const request = vi.fn(async (_key, _options, callback) => {
      if (held) return callback(null);
      held = true;
      try { return await callback({ name: _key, mode: 'exclusive' }); }
      finally { held = false; }
    });
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
    const a = await prepareCollect(settings, snapshot(), account, position()), b = await prepareCollect(settings, snapshot(), account, position());
    let release!: () => void, announce!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { announce = resolve; });
    client.call.mockImplementation(async () => { announce(); await gate; return {}; });
    const w = wallet(), running = executePlan(a, settings, w.provider, () => {});
    await started;
    expect(saved.size).toBe(0);
    await expect(executePlan(b, settings, w.provider, () => {})).rejects.toThrow('其他标签页');
    expect((await reconcilePending(settings, account)).blocked).toBe(true);
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
    release(); await running;
    expect(w.send).toHaveBeenCalledTimes(1);
    expect((await reconcilePending(settings, account)).blocked).toBe(false);
    expect(request.mock.calls.every(([key]) => key.includes(`:${CHAIN_ID}:`) && key.endsWith(account.toLowerCase()))).toBe(true);
  });

  it('fails closed if a browser cannot provide atomic cross-document locking', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    const w = wallet(); vi.stubGlobal('window', {}); vi.stubGlobal('navigator', {});
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('跨页面交易锁');
    expect(w.send).not.toHaveBeenCalled();
  });

  it('honors a stop arriving during the final asynchronous account check', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    const w = wallet(); let keepGoing = true, accountReads = 0;
    const original = w.request.getMockImplementation()!;
    w.request.mockImplementation(async (args) => {
      if (args.method === 'eth_accounts' && ++accountReads === 2) keepGoing = false;
      return original(args);
    });
    await expect(executePlan(plan, settings, w.provider, () => {}, () => keepGoing)).rejects.toThrow('未请求钱包签名');
    expect(w.send).not.toHaveBeenCalled();
    expect((await reconcilePending(settings, account)).blocked).toBe(false);
  });

  it('recovers a confirmed wallet cancellation only after explicit hash and nonce-consumption checks', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position());
    client.waitForTransactionReceipt.mockRejectedValue(new Error('receipt timeout'));
    const w = wallet(); await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('timeout');
    const originalHash = [...sent.keys()][0], replacementHash = toHex(1234567n, { size: 32 });
    const original = sent.get(originalHash)!;
    sent.set(replacementHash, { ...original, to: account, value: '0x0', data: '0x' });
    client.getTransactionCount.mockResolvedValue(Number(BigInt(original.nonce)));
    expect((await reconcilePending(settings, account, replacementHash)).blocked).toBe(true);
    client.getTransactionCount.mockResolvedValue(Number(BigInt(original.nonce)) + 1);
    const result = await reconcilePending(settings, account, replacementHash);
    expect(result.blocked).toBe(false); expect(result.reason).toContain('替换或取消');
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('执行过');
    await expect(prepareCollect(settings, snapshot(), account, position())).resolves.toBeTruthy();
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it('rejects forged plans and cloned steps, and stops for insufficient gas reserve', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position()); const w = wallet();
    await expect(executePlan({ ...plan }, settings, w.provider, () => {})).rejects.toThrow('计划或策略');
    await expect(simulateStep(settings, plan, { ...plan.steps[0] })).rejects.toThrow('不属于');
    client.getBalance.mockResolvedValue(parseUnits('0.08', 18));
    await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('Gas'); expect(w.send).not.toHaveBeenCalled();
  });

  it('invalidates the frozen plan when RPC settings change after preview', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position()); const w = wallet();
    await expect(executePlan(plan, { ...settings, rpcUrls: ['https://different.example'] }, w.provider, () => {})).rejects.toThrow('计划或策略');
    expect(w.send).not.toHaveBeenCalled();
  });

  it('rejects expired plans and non-finite chain timestamps before any signature', async () => {
    const plan = await prepareCollect(settings, snapshot(), account, position()); const w = wallet();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(plan.expiresAt + 1);
    try { await expect(executePlan(plan, settings, w.provider, () => {})).rejects.toThrow('过期'); }
    finally { clock.mockRestore(); }
    client.getBlock.mockResolvedValue({ timestamp: NaN });
    await expect(simulateStep(settings, plan, plan.steps[0])).rejects.toThrow('时间无效');
    expect(w.send).not.toHaveBeenCalled();
  });
});
