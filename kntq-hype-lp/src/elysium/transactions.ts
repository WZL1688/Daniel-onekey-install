import { Percent, Price, Token } from '@uniswap/sdk-core';
import { Pool, Position, TickMath, priceToClosestTick, tickToPrice } from '@uniswap/v3-sdk';
import { encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, isAddressEqual, parseAbi, parseUnits, toHex, zeroAddress } from 'viem';
import type { Address, EIP1193Provider, Hex } from 'viem';
import { ADDRESSES, CHAIN_ID, POOL_ID, POOL_KEY } from './config';
import { createReadClient, readPosition, validateDeployment } from './chain';
import type { ExecutionEvent, OpenInput, PositionState, Settings, Snapshot, TxPlan, TxStep } from '../lib/types';

const txAbi = parseAbi([
  'function balanceOf(address owner) view returns(uint256)',
  'function allowance(address owner,address spender) view returns(uint256)',
  'function approve(address spender,uint256 amount) returns(bool)',
  'function allowance(address owner,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
  'function modifyLiquidities(bytes unlockData,uint256 deadline) payable',
]);
const keyParam = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] } as const;
const MAX128 = (1n << 128n) - 1n;
const MIN_FULL_TICK = -887200;
const MAX_FULL_TICK = 887200;
const PLAN_MS = 300_000;
const ACTION = { mint: 0x02, decrease: 0x01, burn: 0x03, settlePair: 0x0d, takePair: 0x11, sweep: 0x14 } as const;
type PrivatePlan = { plan: TxPlan; tokenId?: string; liquidity?: bigint; policy: string; consumed: boolean; running: boolean };
const plans = new Map<string, PrivatePlan>();
const executingAccounts = new Set<string>();
type Pending = { version: 1; account: Address; planId: string; at: number; nonce: number; to: Address; data: Hex; value: string; hash?: Hex };
const pendingMemory = new Map<string, Pending>();

function amount(value: string, label: string, positive = false): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(value)) throw new Error(`${label}必须是最多 18 位小数的非负十进制数字。`);
  const result = parseUnits(value, 18);
  if (positive && result === 0n) throw new Error(`${label}必须大于零。`);
  return result;
}
function policy(settings: Settings): string {
  if (settings.fee !== POOL_KEY.fee || !Number.isInteger(settings.slippageBps) || settings.slippageBps < 0 || settings.slippageBps > 500) throw new Error('Elysium 固定使用 1% 池，滑点必须为 0–500 基点。');
  if (!Number.isFinite(settings.staleSeconds) || settings.staleSeconds < 10 || settings.staleSeconds > 300) throw new Error('行情过期阈值需为 10–300 秒。');
  const reserve = amount(settings.gasReserveHype, 'Gas 预留');
  if (!Array.isArray(settings.rpcUrls) || !settings.rpcUrls.length || settings.rpcUrls.some(url => typeof url !== 'string' || !url.trim())) throw new Error('RPC 设置不完整。');
  return JSON.stringify([settings.fee, settings.slippageBps, settings.staleSeconds, reserve.toString(), settings.rpcUrls.map(url => url.trim())]);
}
function canonicalPool(pool: PositionState['pool'] | null): asserts pool is NonNullable<PositionState['pool']> {
  if (!pool || !isAddressEqual(pool.address, ADDRESSES.poolManager) || pool.poolId?.toLowerCase() !== POOL_ID || !pool.hooks || !isAddressEqual(pool.hooks, zeroAddress) || !isAddressEqual(pool.token0, zeroAddress) || !isAddressEqual(pool.token1, ADDRESSES.kntq) || pool.fee !== POOL_KEY.fee || pool.tickSpacing !== POOL_KEY.tickSpacing || pool.sqrtPriceX96 <= 0n) throw new Error('目标池身份或完整 PoolKey 不符，禁止交易。');
}
function assertSnapshot(settings: Settings, snapshot: Snapshot) {
  policy(settings);
  const now = Date.now();
  if (!Number.isSafeInteger(snapshot.blockTime) || !Number.isSafeInteger(snapshot.fetchedAt) || typeof snapshot.blockNumber !== 'bigint' || snapshot.blockNumber < 0n) throw new Error('快照区块与时间戳无效，禁止交易。');
  if (snapshot.profile !== 'elysium-v4' || snapshot.chainId !== CHAIN_ID || snapshot.quoteSymbol !== 'HYPE' || !snapshot.manager || !isAddressEqual(snapshot.manager, ADDRESSES.manager) || !snapshot.kntqAddress || !isAddressEqual(snapshot.kntqAddress, ADDRESSES.kntq) || snapshot.kntqDecimals !== 18 || snapshot.whypeDecimals !== 18) throw new Error('快照并非已验证的 Elysium v4 原生 HYPE 池。');
  if (!snapshot.deployment?.verified || !/^0x[0-9a-fA-F]{64}$/.test(snapshot.deployment.fingerprint) || !/^0x[0-9a-fA-F]{64}$/.test(snapshot.deployment.blockHash)) throw new Error('Elysium 部署身份尚未核实，禁止签名。');
  if (now - snapshot.blockTime > settings.staleSeconds * 1000 || now - snapshot.fetchedAt > settings.staleSeconds * 1000 || snapshot.blockTime > now + 15_000 || snapshot.fetchedAt > now + 15_000) throw new Error('链上行情已过期，请刷新后重新预览。');
  canonicalPool(snapshot.pool);
}

function pendingKey(account: Address) { return `kntq-lp:pending:v4:${CHAIN_ID}:${ADDRESSES.manager.toLowerCase()}:${account.toLowerCase()}`; }
function storage(): Storage | undefined {
  try {
    const value = globalThis.localStorage;
    if (!value && typeof window !== 'undefined') throw new Error('localStorage unavailable');
    return value;
  } catch { throw new Error('无法访问持久化交易锁，已停止发送；请允许本地站点保存交易状态。'); }
}
function pendingRead(account: Address): Pending | undefined {
  const key = pendingKey(account);
  const saved = storage()?.getItem(key);
  if (saved) {
    let parsed: Pending;
    try { parsed = JSON.parse(saved) as Pending; } catch { throw new Error('本地待确认交易记录损坏，禁止盲目重发。'); }
    if (parsed.version !== 1 || parsed.account?.toLowerCase() !== account.toLowerCase() || !Number.isSafeInteger(parsed.nonce) || parsed.nonce < 0 || typeof parsed.to !== 'string' || typeof parsed.data !== 'string' || typeof parsed.value !== 'string') throw new Error('本地待确认交易记录不完整，禁止盲目重发。');
    pendingMemory.set(key, parsed);
    return parsed;
  }
  return pendingMemory.get(key);
}
function pendingSave(record: Pending) {
  const key = pendingKey(record.account);
  pendingMemory.set(key, record);
  try { storage()?.setItem(key, JSON.stringify(record)); }
  catch { throw new Error('无法保存交易状态，已停止后续步骤；已广播交易请先查询钱包活动。'); }
}
function pendingClear(account: Address) {
  try { storage()?.removeItem(pendingKey(account)); }
  catch { throw new Error('无法更新本地交易锁，请先核对已提交交易。'); }
  pendingMemory.delete(pendingKey(account));
}
function validHash(hash: unknown): hash is Hex { return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash); }
function transactionMatches(record: Pending, transaction: { hash: Hex; from: Address; to: Address | null; input: Hex; value: bigint; nonce: number }, hash: Hex) {
  return transaction.hash.toLowerCase() === hash.toLowerCase() && transaction.from.toLowerCase() === record.account.toLowerCase() && transaction.to?.toLowerCase() === record.to.toLowerCase() && transaction.input.toLowerCase() === record.data.toLowerCase() && transaction.value.toString() === record.value && transaction.nonce === record.nonce;
}

type Recovery = { blocked: boolean; hash?: Hex; reason?: string };
type LockResult<T> = { acquired: true; value: T } | { acquired: false };
/** Web Locks are shared by every same-origin tab. The durable pending record
 * survives reloads, while this lock prevents concurrent send/recovery races. */
async function withAccountLock<T>(account: Address, action: () => Promise<T>): Promise<LockResult<T>> {
  // Unit/server callers have process-local serialization below; the supported
  // browser application requires atomic cross-document locking.
  if (typeof window === 'undefined') return { acquired: true, value: await action() };
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) throw new Error('浏览器不支持安全的跨页面交易锁，已禁止发送。请使用新版浏览器并从本机 localhost 打开。');
  return locks.request(pendingKey(account), { mode: 'exclusive', ifAvailable: true }, async (lock): Promise<LockResult<T>> => {
    if (!lock) return { acquired: false };
    return { acquired: true, value: await action() };
  });
}

async function reconcilePendingUnlocked(settings: Settings, account: Address, knownHash?: Hex): Promise<Recovery> {
  const pending = pendingRead(account);
  if (!pending) return { blocked: false };
  const hash = knownHash ?? pending.hash;
  if (!validHash(hash)) return { blocked: true, reason: '上一笔发送状态不明确。请从钱包活动取得该笔交易哈希再核对，不能直接重新建仓。' };
  try {
    const client = createReadClient(settings);
    const [receipt, transaction] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || transaction.hash.toLowerCase() !== hash.toLowerCase()) return { blocked: true, hash, reason: '回执与交易哈希不符，交易锁保持。' };
    if (receipt.status !== 'success' && receipt.status !== 'reverted') return { blocked: true, hash, reason: '交易尚无确定执行状态。' };
    if (!transactionMatches(pending, transaction, hash)) {
      // A wallet cancellation/speed-up may deliberately replace the old call.
      // A confirmed same-account, same-nonce transaction consumes that nonce;
      // it can unlock a NEW preview, never confirm/continue the original plan.
      if (!knownHash) return { blocked: true, hash, reason: '交易内容与原预览不符，请先在钱包核对，并手动提供替换或取消交易的哈希。' };
      const sameNonce = transaction.from.toLowerCase() === account.toLowerCase() && transaction.nonce === pending.nonce;
      const confirmedNonce = sameNonce ? await client.getTransactionCount({ address: account, blockTag: 'latest' }) : -1;
      if (!sameNonce || !Number.isSafeInteger(confirmedNonce) || confirmedNonce <= pending.nonce) return { blocked: true, hash, reason: '交易与原账户、nonce、调用数据或金额不符，且尚未证明原 nonce 已被消耗，交易锁保持。' };
      pendingClear(account);
      return { blocked: false, hash, reason: '同一账户及 nonce 的替换或取消交易已确认；原计划已停止，请刷新余额并重新预览。' };
    }
    pendingClear(account);
    return { blocked: false, hash, reason: receipt.status === 'success' ? '上一笔交易已确认；继续操作需重新预览。' : '上一笔交易已回滚；继续操作需重新预览。' };
  } catch (error) {
    return { blocked: true, hash, reason: `上一笔交易尚未核对完成：${error instanceof Error ? error.message : String(error)}` };
  }
}
/** Read-only recovery holds the SAME cross-tab lock as sending, so a delayed
 * response can never remove a newer in-flight transaction's pending record. */
export async function reconcilePending(settings: Settings, account: Address, knownHash?: Hex): Promise<Recovery> {
  const locked = await withAccountLock(account, () => reconcilePendingUnlocked(settings, account, knownHash));
  return locked.acquired ? locked.value : { blocked: true, reason: '此账户已有其他标签页正在处理交易，等待该流程结束后再查询。' };
}
async function noPending(settings: Settings, account: Address, lockHeld = false) {
  const result = await (lockHeld ? reconcilePendingUnlocked(settings, account) : reconcilePending(settings, account));
  if (result.blocked) throw new Error(`${result.reason}${result.hash ? ` 哈希 ${result.hash}` : ''}`);
}

async function startPlan(kind: TxPlan['kind'], settings: Settings, snapshot: Snapshot, account: Address): Promise<TxPlan> {
  assertSnapshot(settings, snapshot);
  await noPending(settings, account);
  const deployment = await validateDeployment(settings);
  if (!deployment.verified || deployment.fingerprint !== snapshot.deployment!.fingerprint) throw new Error('部署身份核验未通过或指纹已变化，禁止签名。');
  const createdAt = Date.now();
  return { id: crypto.randomUUID(), kind, account: getAddress(account), chainId: CHAIN_ID, profile: 'elysium-v4', deploymentFingerprint: deployment.fingerprint, createdAt, expiresAt: createdAt + PLAN_MS, sourceBlock: snapshot.blockNumber, steps: [], summary: [], slippageBps: settings.slippageBps };
}
function register(plan: TxPlan, settings: Settings, position?: PositionState): TxPlan {
  plan.steps.forEach(Object.freeze); Object.freeze(plan.steps); Object.freeze(plan.summary); Object.freeze(plan);
  plans.set(plan.id, { plan, policy: policy(settings), tokenId: position?.tokenId, liquidity: position?.liquidity, consumed: false, running: false });
  return plan;
}
function assertPlan(plan: TxPlan, settings: Settings): PrivatePlan {
  const entry = plans.get(plan.id);
  if (!entry || entry.plan !== plan || plan.chainId !== CHAIN_ID || plan.profile !== 'elysium-v4' || !Object.isFrozen(plan) || !plan.steps.length || plan.steps.length > 6 || entry.policy !== policy(settings)) throw new Error('交易计划或策略已变化，请重新预览。');
  if (entry.consumed && !entry.running) throw new Error('此交易计划已执行过，不会重新发送；请先核对链上记录。');
  if (Date.now() >= plan.expiresAt || plan.expiresAt - plan.createdAt !== PLAN_MS || Date.now() < plan.createdAt - 15_000) throw new Error('交易预览已过期，请重新预览。');
  return entry;
}
function quoteToken() { return new Token(CHAIN_ID, zeroAddress, 18, 'HYPE'); }
function kntqToken() { return new Token(CHAIN_ID, ADDRESSES.kntq, 18, 'KNTQ'); }

/** Input is human HYPE per KNTQ; pool ordering is native HYPE / KNTQ. */
export function rangeTicks(input: Pick<OpenInput, 'lowerPrice' | 'upperPrice' | 'rangeMode'>) {
  if (input.rangeMode === 'full') return { tickLower: MIN_FULL_TICK, tickUpper: MAX_FULL_TICK };
  const low = amount(input.lowerPrice, '价格下限', true);
  const high = amount(input.upperPrice, '价格上限', true);
  if (low >= high) throw new Error('价格下限必须小于上限。');
  const k = kntqToken(), h = quoteToken(), unit = 10n ** 18n;
  const rawLow = new Price(k, h, unit.toString(), high.toString()).invert();
  const rawHigh = new Price(k, h, unit.toString(), low.toString()).invert();
  let tickLower = Math.floor(priceToClosestTick(rawLow) / POOL_KEY.tickSpacing) * POOL_KEY.tickSpacing;
  let tickUpper = Math.ceil(priceToClosestTick(rawHigh) / POOL_KEY.tickSpacing) * POOL_KEY.tickSpacing;
  if (tickLower < MIN_FULL_TICK || tickUpper > MAX_FULL_TICK) throw new Error('价格区间超出协议允许范围。');
  if (tickToPrice(h, k, tickLower).greaterThan(rawLow)) tickLower -= POOL_KEY.tickSpacing;
  if (tickToPrice(h, k, tickUpper).lessThan(rawHigh)) tickUpper += POOL_KEY.tickSpacing;
  if (tickLower < MIN_FULL_TICK || tickUpper > MAX_FULL_TICK || tickLower >= tickUpper) throw new Error('价格区间不符合协议 tick 范围。');
  return { tickLower, tickUpper };
}
function unlock(actions: number[], params: Hex[]): Hex {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [toHex(new Uint8Array(actions)), params]);
}
function modify(unlockData: Hex, plan: TxPlan): Hex {
  return encodeFunctionData({ abi: txAbi, functionName: 'modifyLiquidities', args: [unlockData, BigInt(Math.floor(plan.expiresAt / 1000))] });
}
function takePair(account: Address): Hex { return encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [zeroAddress, ADDRESSES.kntq, account]); }

async function approvals(settings: Settings, account: Address, needed: bigint, expiresAt: number): Promise<TxStep[]> {
  const client = createReadClient(settings);
  const [ercAmount, permit] = await Promise.all([
    client.readContract({ address: ADDRESSES.kntq, abi: txAbi, functionName: 'allowance', args: [account, ADDRESSES.permit2] }),
    client.readContract({ address: ADDRESSES.permit2, abi: txAbi, functionName: 'allowance', args: [account, ADDRESSES.kntq, ADDRESSES.manager] }),
  ]);
  const steps: TxStep[] = [];
  const erc = (value: bigint): TxStep => ({ label: value === 0n ? '清零 KNTQ → Permit2 旧授权' : `精确授权 ${formatUnits(value, 18)} KNTQ → Permit2`, to: ADDRESSES.kntq, data: encodeFunctionData({ abi: txAbi, functionName: 'approve', args: [ADDRESSES.permit2, value] }), value: 0n });
  if (ercAmount !== needed) { if (ercAmount > 0n) steps.push(erc(0n)); if (needed > 0n) steps.push(erc(needed)); }
  const expiry = Math.floor(expiresAt / 1000);
  const grant = (value: bigint, expiration: number): TxStep => ({ label: value === 0n ? '清零 Permit2 → PositionManager 旧授权' : `限时精确授权 ${formatUnits(value, 18)} KNTQ → PositionManager`, to: ADDRESSES.permit2, data: encodeFunctionData({ abi: txAbi, functionName: 'approve', args: [ADDRESSES.kntq, ADDRESSES.manager, value, expiration] }), value: 0n });
  if (permit[0] !== needed || Number(permit[1]) !== (needed > 0n ? expiry : 0)) {
    if (permit[0] > 0n) steps.push(grant(0n, 0));
    if (needed > 0n) steps.push(grant(needed, expiry));
  }
  return steps;
}

export async function prepareOpen(settings: Settings, snapshot: Snapshot, account: Address, input: OpenInput): Promise<TxPlan> {
  const plan = await startPlan('mint', settings, snapshot, account);
  if (!input.useNative) throw new Error('Elysium 此池使用原生 HYPE，不使用 WHYPE 包装余额。');
  const budgetK = amount(input.kntq, 'KNTQ 预算', true), budgetH = amount(input.whype, 'HYPE 预算', true);
  if (budgetK > MAX128 || budgetH > MAX128) throw new Error('预算超过 v4 单币金额上限。');
  const client = createReadClient(settings);
  const [balanceK, balanceH] = await Promise.all([
    client.readContract({ address: ADDRESSES.kntq, abi: txAbi, functionName: 'balanceOf', args: [account] }), client.getBalance({ address: account }),
  ]);
  if (budgetK > balanceK || budgetH + amount(settings.gasReserveHype, 'Gas 预留') > balanceH) throw new Error('钱包余额不足以覆盖确认预算和 HYPE Gas 预留。');
  const { tickLower, tickUpper } = rangeTicks(input);
  const pool = new Pool(quoteToken(), kntqToken(), POOL_KEY.fee, snapshot.pool!.sqrtPriceX96.toString(), snapshot.pool!.liquidity.toString(), snapshot.pool!.tick);
  const candidate = Position.fromAmounts({ pool, tickLower, tickUpper, amount0: budgetH.toString(), amount1: budgetK.toString(), useFullPrecision: true });
  const requirements = (liquidity: bigint) => {
    const position = new Position({ pool, tickLower, tickUpper, liquidity: liquidity.toString() });
    const current = position.mintAmounts;
    const maximum = position.mintAmountsWithSlippage(new Percent(settings.slippageBps, 10000));
    const h = BigInt(maximum.amount0.toString()), k = BigInt(maximum.amount1.toString());
    const ch = BigInt(current.amount0.toString()), ck = BigInt(current.amount1.toString());
    return { h: h > ch ? h : ch, k: k > ck ? k : ck };
  };
  // Binary search a fixed liquidity whose upward-rounded cost, including the
  // confirmed price tolerance, is inside BOTH original budgets. Slippage never
  // expands the budget; the liquidity amount is reduced instead.
  let low = 0n, high = BigInt(candidate.liquidity.toString());
  if (high > MAX128) high = MAX128;
  while (low < high) {
    const mid = (low + high + 1n) / 2n, cost = requirements(mid);
    if (cost.h <= budgetH && cost.k <= budgetK) low = mid; else high = mid - 1n;
  }
  if (low === 0n) throw new Error('预算过小，无法在已确认预算与滑点内建立正流动性。');
  const max = requirements(low);
  plan.steps.push(...await approvals(settings, account, max.k, plan.expiresAt));
  const mint = encodeAbiParameters([keyParam, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }], [POOL_KEY, tickLower, tickUpper, low, max.h, max.k, account, '0x']);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [zeroAddress, ADDRESSES.kntq]);
  const sweep = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [zeroAddress, account]);
  plan.steps.push({ label: '建立 Elysium v4 LP 仓位并退回多余原生 HYPE', to: ADDRESSES.manager, data: modify(unlock([ACTION.mint, ACTION.settlePair, ACTION.sweep], [mint, settle, sweep]), plan), value: max.h });
  const h = quoteToken(), k = kntqToken();
  plan.summary.push(`Elysium 主网 ${CHAIN_ID}；付款与 NFT 接收账户：${account}`, `原始硬预算：${input.whype} 原生 HYPE + ${input.kntq} KNTQ`, `链上最高扣款：${formatUnits(max.h, 18)} HYPE + ${formatUnits(max.k, 18)} KNTQ（已含 ${settings.slippageBps / 100}% 滑点，仍不超过预算）`, `实际区间：${tickToPrice(h, k, tickUpper).invert().toSignificant(12)}–${tickToPrice(h, k, tickLower).invert().toSignificant(12)} HYPE / KNTQ；tick ${tickLower}–${tickUpper}`, `固定流动性 ${low}；手续费 1%；有效期 5 分钟`, '两层 KNTQ 授权均为本次最高扣款；Permit2 有效期不晚于本计划期限。未使用原生 HYPE 在同笔交易退回。', '每次签名前重新核验部署、账户、网络并模拟；已确认授权不会因后续失败自动回滚。');
  return register(plan, settings);
}

async function currentPosition(settings: Settings, account: Address, position: PositionState): Promise<PositionState> {
  if (!/^\d+$/.test(position.tokenId)) throw new Error('无效 TokenId。');
  canonicalPool(position.pool);
  const fresh = await readPosition(settings, account, position.tokenId);
  canonicalPool(fresh.pool);
  if (fresh.tokenId !== position.tokenId) throw new Error('持仓 TokenId 校验失败。');
  return fresh;
}
export async function prepareCollect(settings: Settings, snapshot: Snapshot, account: Address, position: PositionState): Promise<TxPlan> {
  const plan = await startPlan('collect', settings, snapshot, account);
  const fresh = await currentPosition(settings, account, position);
  // In canonical v4 _decrease, minima apply to principal delta AFTER fees are
  // subtracted. Decrease(0) therefore requires zero PRINCIPAL minima.
  const decrease = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], [BigInt(fresh.tokenId), 0n, 0n, 0n, '0x']);
  plan.steps.push({ label: `领取 #${fresh.tokenId} 手续费`, to: ADDRESSES.manager, data: modify(unlock([ACTION.decrease, ACTION.takePair], [decrease, takePair(account)]), plan), value: 0n });
  plan.summary.push(`Elysium v4 仓位 #${fresh.tokenId}；付款与收款账户：${account}`, `当前待领：${fresh.feeWhype} 原生 HYPE + ${fresh.feeKntq} KNTQ`, '不减少本金流动性，不兑换代币。DECREASE(0) 的本金最低量为 0；该参数不承诺手续费最低到账量，实际领取量以执行时链上结算为准。', `原定滑点 ${settings.slippageBps / 100}% 保持不变；领费没有兑换价格滑点。签名前模拟，失败停止。`);
  return register(plan, settings, fresh);
}
export async function prepareExit(settings: Settings, snapshot: Snapshot, account: Address, position: PositionState): Promise<TxPlan> {
  const plan = await startPlan('exit', settings, snapshot, account);
  const fresh = await currentPosition(settings, account, position);
  if (fresh.liquidity === 0n) throw new Error('该仓位没有可撤出的流动性。');
  const bps = BigInt(10000 - settings.slippageBps);
  const minH = amount(fresh.amountWhype, 'HYPE 本金') * bps / 10000n, minK = amount(fresh.amountKntq, 'KNTQ 本金') * bps / 10000n;
  const burn = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], [BigInt(fresh.tokenId), minH, minK, '0x']);
  plan.steps.push({ label: `撤出 #${fresh.tokenId} 全部流动性、领回代币并销毁 NFT`, to: ADDRESSES.manager, data: modify(unlock([ACTION.burn, ACTION.takePair], [burn, takePair(account)]), plan), value: 0n });
  plan.summary.push(`Elysium v4 仓位 #${fresh.tokenId}；收款账户：${account}`, `一次撤出 100% 流动性 ${fresh.liquidity}，领取本金及手续费并销毁该 NFT`, `最低本金到账：${formatUnits(minH, 18)} 原生 HYPE + ${formatUnits(minK, 18)} KNTQ`, `固定滑点 ${settings.slippageBps / 100}%；BURN_POSITION + TAKE_PAIR 在同一笔交易执行；有效期 5 分钟。`);
  return register(plan, settings, fresh);
}

export async function simulateStep(settings: Settings, plan: TxPlan, step: TxStep): Promise<{ gas: bigint }> {
  const entry = assertPlan(plan, settings);
  if (!plan.steps.includes(step)) throw new Error('模拟步骤不属于冻结的交易计划。');
  const deployment = await validateDeployment(settings);
  if (!deployment.verified || deployment.fingerprint !== plan.deploymentFingerprint) throw new Error('部署身份尚未核实或已变化，停止签名。');
  const client = createReadClient(settings), block = await client.getBlock();
  const headTime = Number(block.timestamp);
  if (!Number.isSafeInteger(headTime) || headTime < 0 || Date.now() / 1000 - headTime > settings.staleSeconds || headTime > Date.now() / 1000 + 15) throw new Error('RPC 最新区块已过期或时间无效，停止签名。');
  if (entry.tokenId) {
    const position = await readPosition(settings, plan.account, entry.tokenId);
    canonicalPool(position.pool);
    if (position.tokenId !== entry.tokenId || position.liquidity !== entry.liquidity) throw new Error('仓位所有权、池或流动性已变化，请重新预览。');
  }
  const args = { account: plan.account, to: step.to, data: step.data, value: step.value };
  await client.call(args);
  const gas = await client.estimateGas(args);
  return { gas };
}
async function checkWallet(provider: EIP1193Provider, account: Address) {
  const chain = await provider.request({ method: 'eth_chainId' });
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (Number(chain) !== CHAIN_ID || accounts[0]?.toLowerCase() !== account.toLowerCase()) throw new Error('钱包账户或网络已变化，请重新预览；收款人不会随账户切换而隐式修改。');
}
function userRejected(error: unknown): boolean {
  const e = error as { code?: number; data?: { originalError?: { code?: number } } } | null;
  return e?.code === 4001 || e?.data?.originalError?.code === 4001;
}

/** Only write boundary. Every step has a durable ambiguity lock and one wallet send. */
async function executePlanUnlocked(plan: TxPlan, settings: Settings, provider: EIP1193Provider, onEvent: (event: ExecutionEvent) => void, shouldContinue: () => boolean): Promise<void> {
  const entry = assertPlan(plan, settings);
  if (entry.consumed || entry.running) throw new Error('此交易计划已执行过，不会重新发送。');
  const accountKey = pendingKey(plan.account);
  if (executingAccounts.has(accountKey)) throw new Error('此账户已有正在执行的交易流程。');
  // Reserve the account synchronously: two different plans must not race while
  // their asynchronous identity / simulation checks are still in flight.
  executingAccounts.add(accountKey);
  try {
    await noPending(settings, plan.account, true);
    if (entry.consumed || entry.running) throw new Error('此交易计划正在执行。');
    entry.consumed = true; entry.running = true;
    const client = createReadClient(settings);
    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index]; let hash: Hex | undefined; let awaitingWallet = false;
      try {
        if (!shouldContinue()) throw new Error('已停止后续步骤，已广播交易仍需查询链上结果。');
        assertPlan(plan, settings); await checkWallet(provider, plan.account);
        onEvent({ index, status: 'simulating', label: step.label });
        const { gas: estimated } = await simulateStep(settings, plan, step);
        const gas = (estimated * 120n + 99n) / 100n;
        const [gasPrice, balance, nonce] = await Promise.all([client.getGasPrice(), client.getBalance({ address: plan.account }), client.getTransactionCount({ address: plan.account, blockTag: 'pending' })]);
        if (!Number.isSafeInteger(nonce) || nonce < 0 || gas <= 0n || gasPrice <= 0n) throw new Error('RPC 返回无效的 nonce 或 Gas 参数，停止签名。');
        if (balance < step.value + gas * gasPrice + amount(settings.gasReserveHype, 'Gas 预留')) throw new Error('HYPE 余额不足以支付本步骤、Gas 上限及确认的最低预留。');
        if (!shouldContinue()) throw new Error('已停止后续步骤。');
        assertPlan(plan, settings); await checkWallet(provider, plan.account);
        if (!shouldContinue()) throw new Error('已停止后续步骤，未请求钱包签名。');
        assertPlan(plan, settings);
        const record: Pending = { version: 1, account: plan.account, planId: plan.id, at: Date.now(), nonce, to: step.to, data: step.data, value: step.value.toString() };
        pendingSave(record);
        onEvent({ index, status: 'signing', label: step.label });
        awaitingWallet = true;
        const submitted = await provider.request({ method: 'eth_sendTransaction', params: [{ from: plan.account, to: step.to, data: step.data, value: toHex(step.value), nonce: toHex(nonce), gas: toHex(gas), gasPrice: toHex(gasPrice), chainId: toHex(CHAIN_ID) }] });
        if (!validHash(submitted)) throw new Error('钱包返回的交易哈希无效，发送状态不明确。');
        hash = submitted; awaitingWallet = false;
        pendingSave({ ...record, hash });
        onEvent({ index, status: 'submitted', label: step.label, hash });
        const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, pollingInterval: 3000, timeout: 120_000 });
        if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('交易被替换，必须先核对原 nonce 的实际交易。');
        const transaction = await client.getTransaction({ hash });
        if (!transactionMatches(record, transaction, hash)) throw new Error('链上交易账户、nonce、合约、调用数据或金额与预览不符。');
        if (receipt.status !== 'success' && receipt.status !== 'reverted') throw new Error('回执没有确定执行状态。');
        pendingClear(plan.account);
        if (receipt.status === 'reverted') throw new Error('交易已回滚，停止后续步骤。');
        onEvent({ index, status: 'confirmed', label: step.label, hash });
      } catch (error) {
        if (awaitingWallet && userRejected(error)) pendingClear(plan.account);
        const raw = error instanceof Error ? error.message : String(error);
        const reason = `${raw}${hash ? ` 已广播 ${hash}；请先核对该交易。` : ''} 未自动重发，原计划不可再次发送。`;
        onEvent({ index, status: 'failed', label: step.label, hash, error: reason });
        throw new Error(reason);
      }
    }
  } finally { entry.running = false; executingAccounts.delete(accountKey); }
}

export async function executePlan(plan: TxPlan, settings: Settings, provider: EIP1193Provider, onEvent: (event: ExecutionEvent) => void, shouldContinue: () => boolean = () => true): Promise<void> {
  assertPlan(plan, settings);
  const locked = await withAccountLock(plan.account, () => executePlanUnlocked(plan, settings, provider, onEvent, shouldContinue));
  if (!locked.acquired) throw new Error('此账户已有其他标签页正在执行交易，禁止并发发送。');
}
