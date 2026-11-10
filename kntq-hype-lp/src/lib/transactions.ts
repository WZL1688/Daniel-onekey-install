import { Percent, Price, Token } from '@uniswap/sdk-core';
import { Pool, Position, TickMath, encodeSqrtRatioX96, priceToClosestTick, tickToPrice } from '@uniswap/v3-sdk';
import JSBI from 'jsbi';
import { encodeFunctionData, formatUnits, getAddress, parseAbi, parseUnits, toHex } from 'viem';
import type { Address, EIP1193Provider, Hex } from 'viem';
import { ADDRESSES, CHAIN_ID } from './config';
import { createReadClient } from './chain';
import type { ExecutionEvent, OpenInput, PositionState, Settings, Snapshot, TxPlan, TxStep } from './types';

const txAbi = parseAbi([
  'function allowance(address owner,address spender) view returns(uint256)',
  'function approve(address spender,uint256 amount) returns(bool)',
  'function deposit() payable',
  'function ownerOf(uint256 tokenId) view returns(address)',
  'function getPool(address tokenA,address tokenB,uint24 fee) view returns(address)',
  'function feeAmountTickSpacing(uint24 fee) view returns(int24)',
  'function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns(address pool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns(uint256 amount0,uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns(uint256 amount0,uint256 amount1)',
  'function multicall(bytes[] data) payable returns(bytes[] results)',
]);
const MAX_UINT128 = (1n << 128n) - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';
const consumedPlans = new Set<string>();
const mintPreconditions = new Map<string, { fee: number; needsInit: boolean }>();

function validateSettings(settings: Settings) {
  if (!Number.isInteger(settings.slippageBps) || settings.slippageBps < 0 || settings.slippageBps > 500) throw new Error('滑点需为 0–500 基点（0–5%），不会自动调整。');
  if (!Number.isFinite(settings.staleSeconds) || settings.staleSeconds < 10 || settings.staleSeconds > 300) throw new Error('行情过期阈值必须为 10–300 秒。');
  if (parseUnits(settings.gasReserveHype, 18) < 0n) throw new Error('Gas 保留金额不能为负。');
}

function assertSnapshot(settings: Settings, snapshot: Snapshot) {
  validateSettings(settings);
  if ((snapshot.profile && snapshot.profile !== 'hyperevm-v3') || (snapshot.chainId !== undefined && snapshot.chainId !== CHAIN_ID)
    || (snapshot.manager && snapshot.manager.toLowerCase() !== ADDRESSES.manager.toLowerCase())
    || (snapshot.kntqAddress && snapshot.kntqAddress.toLowerCase() !== ADDRESSES.kntq.toLowerCase())
    || (snapshot.quoteSymbol && snapshot.quoteSymbol !== 'WHYPE')) throw new Error('交易快照不属于 HyperEVM v3 配置，请切换网络并重新读取');
  const now = Date.now();
  if (now - snapshot.fetchedAt > settings.staleSeconds * 1000 || now - snapshot.blockTime > settings.staleSeconds * 1000 || snapshot.blockTime > now + 15_000) throw new Error('链上行情已过期，请刷新后重新预览。');
  if (snapshot.kntqDecimals !== 18 || snapshot.whypeDecimals !== 18) throw new Error('代币精度与已验证配置不符，禁止交易。');
}

function decimal(value: string, name: string, decimals: number, positive = true) {
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || (value.split('.')[1]?.length ?? 0) > decimals) throw new Error(`${name}必须是最多 ${decimals} 位小数的十进制金额。`);
  const parsed = parseUnits(value.trim(), decimals);
  if (positive && parsed <= 0n) throw new Error(`${name}必须大于零。`);
  return parsed;
}

function newPlan(kind: TxPlan['kind'], settings: Settings, snapshot: Snapshot, account: Address): TxPlan {
  assertSnapshot(settings, snapshot);
  const createdAt = Date.now();
  return { id: crypto.randomUUID(), kind, account: getAddress(account), chainId: CHAIN_ID, createdAt, expiresAt: createdAt + 300_000, sourceBlock: snapshot.blockNumber, steps: [], summary: [], slippageBps: settings.slippageBps };
}

function freezePlan(plan: TxPlan): TxPlan {
  for (const step of plan.steps) Object.freeze(step);
  Object.freeze(plan.steps);
  Object.freeze(plan.summary);
  return Object.freeze(plan);
}

function tokens(snapshot: Snapshot) {
  const k = new Token(CHAIN_ID, ADDRESSES.kntq, snapshot.kntqDecimals, 'KNTQ');
  const w = new Token(CHAIN_ID, ADDRESSES.whype, snapshot.whypeDecimals, 'WHYPE');
  return { k, w, kFirst: k.sortsBefore(w) };
}

/** Human price is always WHYPE per KNTQ; round the displayed bounds outwards. */
export function rangeTicks(lower: string, upper: string, spacing: number, snapshot: Snapshot) {
  const { k, w, kFirst } = tokens(snapshot);
  const low = decimal(lower, '价格下限', snapshot.whypeDecimals);
  const high = decimal(upper, '价格上限', snapshot.whypeDecimals);
  if (low >= high) throw new Error('价格下限必须小于上限。');
  if (!Number.isInteger(spacing) || spacing <= 0) throw new Error('手续费档位未在官方工厂启用。');
  const unit = parseUnits('1', snapshot.kntqDecimals).toString();
  const humanLow = new Price(k, w, unit, low.toString());
  const humanHigh = new Price(k, w, unit, high.toString());
  const rawLow = kFirst ? humanLow : humanHigh.invert();
  const rawHigh = kFirst ? humanHigh : humanLow.invert();
  let tickLower = Math.floor(priceToClosestTick(rawLow) / spacing) * spacing;
  let tickUpper = Math.ceil(priceToClosestTick(rawHigh) / spacing) * spacing;
  if (tickLower < TickMath.MIN_TICK || tickUpper > TickMath.MAX_TICK) throw new Error('价格区间超出协议允许范围。');
  // priceToClosestTick floors before tick-spacing alignment. An upper tick that
  // already is a spacing multiple can still represent a price below the input.
  if (tickToPrice(rawLow.baseCurrency, rawLow.quoteCurrency, tickLower).greaterThan(rawLow)) tickLower -= spacing;
  if (tickToPrice(rawHigh.baseCurrency, rawHigh.quoteCurrency, tickUpper).lessThan(rawHigh)) tickUpper += spacing;
  if (tickLower < TickMath.MIN_TICK || tickUpper > TickMath.MAX_TICK || tickLower >= tickUpper) throw new Error('价格区间超出协议允许范围。');
  return { tickLower, tickUpper };
}

async function approvalSteps(settings: Settings, account: Address, token: Address, amount: bigint, symbol: string): Promise<TxStep[]> {
  if (amount === 0n) return [];
  const client = createReadClient(settings);
  const allowance = await client.readContract({ address: token, abi: txAbi, functionName: 'allowance', args: [account, ADDRESSES.manager] });
  if (allowance === amount) return [];
  const steps: TxStep[] = [];
  if (allowance !== 0n) steps.push({ label: `重置 ${symbol} 旧授权为 0`, to: token, data: encodeFunctionData({ abi: txAbi, functionName: 'approve', args: [ADDRESSES.manager, 0n] }), value: 0n });
  steps.push({ label: `精确授权 ${formatUnits(amount, 18)} ${symbol}`, to: token, data: encodeFunctionData({ abi: txAbi, functionName: 'approve', args: [ADDRESSES.manager, amount] }), value: 0n });
  return steps;
}

export async function prepareOpen(settings: Settings, snapshot: Snapshot, account: Address, input: OpenInput): Promise<TxPlan> {
  const plan = newPlan('mint', settings, snapshot, account);
  if (snapshot.pool && snapshot.pool.fee !== settings.fee) throw new Error('池费率与当前设置不符，请刷新。');
  const budgetK = decimal(input.kntq, 'KNTQ 预算', snapshot.kntqDecimals);
  const budgetW = decimal(input.whype, input.useNative ? 'HYPE 预算' : 'WHYPE 预算', snapshot.whypeDecimals);
  const reserve = parseUnits(settings.gasReserveHype, 18);
  if (budgetK > parseUnits(snapshot.balances.kntq, 18)) throw new Error('KNTQ 可用余额不足。');
  if (input.useNative ? budgetW + reserve > parseUnits(snapshot.balances.hype, 18) : budgetW > parseUnits(snapshot.balances.whype, 18)) throw new Error(input.useNative ? 'HYPE 余额不足以覆盖预算及 Gas 保留金额。' : 'WHYPE 可用余额不足。');
  if (parseUnits(snapshot.balances.hype, 18) <= reserve) throw new Error('请保留足够的原生 HYPE 支付 Gas。');
  const client = createReadClient(settings);
  const spacing = await client.readContract({ address: ADDRESSES.factory, abi: txAbi, functionName: 'feeAmountTickSpacing', args: [settings.fee] });
  const { k, w, kFirst } = tokens(snapshot);
  const { tickLower, tickUpper } = input.rangeMode === 'full'
    ? { tickLower: Math.ceil(TickMath.MIN_TICK / spacing) * spacing, tickUpper: Math.floor(TickMath.MAX_TICK / spacing) * spacing }
    : rangeTicks(input.lowerPrice, input.upperPrice, spacing, snapshot);
  const token0 = kFirst ? k : w;
  const token1 = kFirst ? w : k;
  const amount0 = kFirst ? budgetK : budgetW;
  const amount1 = kFirst ? budgetW : budgetK;
  const needsInit = !snapshot.pool || snapshot.pool.sqrtPriceX96 === 0n;
  const sqrtPrice = needsInit ? encodeSqrtRatioX96(amount1.toString(), amount0.toString()) : JSBI.BigInt(snapshot.pool!.sqrtPriceX96.toString());
  const currentTick = needsInit ? TickMath.getTickAtSqrtRatio(sqrtPrice) : snapshot.pool!.tick;
  if (needsInit && (currentTick < tickLower || currentTick >= tickUpper)) throw new Error('新池初始价格必须位于确认区间内，并同时投入两种代币。');
  const pool = new Pool(token0, token1, settings.fee, sqrtPrice, snapshot.pool?.liquidity.toString() ?? '0', currentTick);
  const position = Position.fromAmounts({ pool, tickLower, tickUpper, amount0: amount0.toString(), amount1: amount1.toString(), useFullPrecision: true });
  if (position.liquidity.toString() === '0') throw new Error('预算过小，计算出的流动性为 0。');
  const desired = position.mintAmounts;
  const usedK = BigInt((kFirst ? desired.amount0 : desired.amount1).toString());
  const usedW = BigInt((kFirst ? desired.amount1 : desired.amount0).toString());
  if (usedK > budgetK || usedW > budgetW) throw new Error('整数舍入后的投入超过确认预算，请调整金额。');
  const min = position.mintAmountsWithSlippage(new Percent(settings.slippageBps, 10_000));
  if (needsInit && (BigInt(min.amount0.toString()) === 0n || BigInt(min.amount1.toString()) === 0n)) throw new Error('新池必须在确认滑点内保留双边最低投入；请扩大区间或调整预算后重新预览。');
  if (input.useNative && usedW > 0n) plan.steps.push({ label: `包装 ${formatUnits(usedW, 18)} HYPE 为 WHYPE`, to: ADDRESSES.whype, data: encodeFunctionData({ abi: txAbi, functionName: 'deposit' }), value: usedW });
  plan.steps.push(...await approvalSteps(settings, account, ADDRESSES.kntq, usedK, 'KNTQ'));
  plan.steps.push(...await approvalSteps(settings, account, ADDRESSES.whype, usedW, 'WHYPE'));
  const mintData = encodeFunctionData({ abi: txAbi, functionName: 'mint', args: [{ token0: token0.address as Address, token1: token1.address as Address, fee: settings.fee, tickLower, tickUpper, amount0Desired: BigInt(desired.amount0.toString()), amount1Desired: BigInt(desired.amount1.toString()), amount0Min: BigInt(min.amount0.toString()), amount1Min: BigInt(min.amount1.toString()), recipient: account, deadline: BigInt(Math.floor(plan.expiresAt / 1000)) }] });
  const calls: Hex[] = [];
  if (needsInit) calls.push(encodeFunctionData({ abi: txAbi, functionName: 'createAndInitializePoolIfNecessary', args: [token0.address as Address, token1.address as Address, settings.fee, BigInt(sqrtPrice.toString())] }));
  calls.push(mintData);
  plan.steps.push({ label: needsInit ? '创建 / 初始化池并建立 LP 仓位' : '建立 LP 仓位', to: ADDRESSES.manager, data: calls.length > 1 ? encodeFunctionData({ abi: txAbi, functionName: 'multicall', args: [calls] }) : mintData, value: 0n });
  const effectiveLow = new Pool(token0, token1, settings.fee, TickMath.getSqrtRatioAtTick(tickLower), '0', tickLower).priceOf(k).toSignificant(10);
  const effectiveHigh = new Pool(token0, token1, settings.fee, TickMath.getSqrtRatioAtTick(tickUpper), '0', tickUpper).priceOf(k).toSignificant(10);
  plan.summary.push(`预算上限：${input.kntq} KNTQ + ${input.whype} ${input.useNative ? '原生 HYPE' : 'WHYPE'}`, `本次最大投入：${formatUnits(usedK, 18)} KNTQ + ${formatUnits(usedW, 18)} WHYPE`, `对齐 tick 后区间：${kFirst ? effectiveLow : effectiveHigh}–${kFirst ? effectiveHigh : effectiveLow} WHYPE / KNTQ；tick ${tickLower}–${tickUpper}`, `手续费 ${(settings.fee / 10_000).toFixed(2)}%；滑点 ${(settings.slippageBps / 100).toFixed(2)}%；有效期 5 分钟`, '每步签名前单独模拟；已完成的包装与授权不会因后续失败自动回滚。');
  if (needsInit) plan.summary.push(`重要：官方工厂尚无已初始化池，将按预算比例 ${pool.priceOf(k).toSignificant(12)} WHYPE / KNTQ 初始化；若签名前已被其他交易初始化，将停止并要求重新预览。`);
  if (usedK === 0n || usedW === 0n) plan.summary.push('当前价格在区间外，本次为单边投入，未使用的预算留在钱包。');
  mintPreconditions.set(plan.id, { fee: settings.fee, needsInit });
  return freezePlan(plan);
}

async function assertPositionOwner(settings: Settings, account: Address, position: PositionState) {
  const client = createReadClient(settings);
  const owner = await client.readContract({ address: ADDRESSES.manager, abi: txAbi, functionName: 'ownerOf', args: [BigInt(position.tokenId)] });
  if (owner.toLowerCase() !== account.toLowerCase()) throw new Error('该 NFT 仓位当前不属于已连接钱包。');
  const pool = await client.readContract({ address: ADDRESSES.factory, abi: txAbi, functionName: 'getPool', args: [ADDRESSES.kntq, ADDRESSES.whype, position.pool.fee] });
  if (pool === ZERO || pool.toLowerCase() !== position.pool.address.toLowerCase()) throw new Error('仓位不属于官方 Uniswap 工厂的 KNTQ / WHYPE 池。');
}

function collectData(account: Address, tokenId: string): Hex {
  return encodeFunctionData({ abi: txAbi, functionName: 'collect', args: [{ tokenId: BigInt(tokenId), recipient: account, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }] });
}

export async function prepareCollect(settings: Settings, snapshot: Snapshot, account: Address, position: PositionState): Promise<TxPlan> {
  const plan = newPlan('collect', settings, snapshot, account);
  await assertPositionOwner(settings, account, position);
  plan.steps.push({ label: `领取 #${position.tokenId} 手续费`, to: ADDRESSES.manager, data: collectData(account, position.tokenId), value: 0n });
  plan.summary.push(`仓位 #${position.tokenId}；收款地址 ${account}`, `快照待领：${position.feeKntq} KNTQ + ${position.feeWhype} WHYPE`, '按签名前模拟结果领取全部可领取金额；返回 WHYPE，不自动转换为原生 HYPE。');
  return freezePlan(plan);
}

export async function prepareExit(settings: Settings, snapshot: Snapshot, account: Address, position: PositionState): Promise<TxPlan> {
  const plan = newPlan('exit', settings, snapshot, account);
  await assertPositionOwner(settings, account, position);
  if (position.liquidity <= 0n) return prepareCollect(settings, snapshot, account, position);
  const kFirst = ADDRESSES.kntq.toLowerCase() < ADDRESSES.whype.toLowerCase();
  const k = parseUnits(position.amountKntq, snapshot.kntqDecimals);
  const w = parseUnits(position.amountWhype, snapshot.whypeDecimals);
  const basis = BigInt(10_000 - settings.slippageBps);
  const min0 = (kFirst ? k : w) * basis / 10_000n;
  const min1 = (kFirst ? w : k) * basis / 10_000n;
  const decrease = encodeFunctionData({ abi: txAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: BigInt(position.tokenId), liquidity: position.liquidity, amount0Min: min0, amount1Min: min1, deadline: BigInt(Math.floor(plan.expiresAt / 1000)) }] });
  plan.steps.push({ label: `撤出 #${position.tokenId} 全部流动性并领取`, to: ADDRESSES.manager, data: encodeFunctionData({ abi: txAbi, functionName: 'multicall', args: [[decrease, collectData(account, position.tokenId)]] }), value: 0n });
  plan.summary.push(`撤出仓位 #${position.tokenId} 的 100% 流动性，并在同一笔交易领取本金与手续费`, `快照本金：${position.amountKntq} KNTQ + ${position.amountWhype} WHYPE`, `最低本金到账：${formatUnits(kFirst ? min0 : min1, 18)} KNTQ + ${formatUnits(kFirst ? min1 : min0, 18)} WHYPE`, `滑点 ${(settings.slippageBps / 100).toFixed(2)}%；返回 WHYPE；保留空 NFT，余额归零后自动隐藏。`);
  return freezePlan(plan);
}

function assertPlan(plan: TxPlan) {
  if (plan.chainId !== CHAIN_ID || !plan.steps.length || plan.steps.length > 8) throw new Error('交易计划格式不符。');
  if (Date.now() > plan.expiresAt || plan.expiresAt - plan.createdAt > 300_000 || Date.now() < plan.createdAt - 15_000) throw new Error('交易预览已过期，请重新预览。');
  const allowed = [ADDRESSES.kntq, ADDRESSES.whype, ADDRESSES.manager].map(x => x.toLowerCase());
  if (plan.steps.some(x => !allowed.includes(x.to.toLowerCase()) || x.value < 0n)) throw new Error('发现未授权的目标合约或金额。');
}

export async function simulateStep(settings: Settings, plan: TxPlan, step: TxStep): Promise<{ gas: bigint }> {
  validateSettings(settings);
  assertPlan(plan);
  const client = createReadClient(settings);
  const block = await client.getBlock();
  if (Date.now() / 1000 - Number(block.timestamp) > settings.staleSeconds || Number(block.timestamp) > Date.now() / 1000 + 15) throw new Error('RPC 最新区块已过期，停止签名。');
  if (plan.kind === 'mint') {
    const precondition = mintPreconditions.get(plan.id);
    if (!precondition || precondition.fee !== settings.fee) throw new Error('建仓计划或费率配置已变化，请重新预览。');
    if (precondition.needsInit) {
      const pool = await client.readContract({ address: ADDRESSES.factory, abi: txAbi, functionName: 'getPool', args: [ADDRESSES.kntq, ADDRESSES.whype, precondition.fee] });
      if (pool.toLowerCase() !== ZERO) {
        const state = await client.readContract({ address: pool, abi: txAbi, functionName: 'slot0' });
        if (state[0] !== 0n) throw new Error('目标新池已被其他交易初始化，请刷新行情并重新预览。');
      }
    }
  }
  const args = { account: plan.account, to: step.to, data: step.data, value: step.value };
  await client.call(args);
  const gas = await client.estimateGas(args);
  return { gas };
}

function markConsumed(id: string) {
  const key = `kntq-lp-executed:${id}`;
  if (consumedPlans.has(id) || (typeof localStorage !== 'undefined' && localStorage.getItem(key))) throw new Error('该交易计划已经执行过。请核对链上状态后重新预览，不会自动重发。');
  consumedPlans.add(id);
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(Date.now()));
}

async function checkWallet(provider: EIP1193Provider, account: Address) {
  const chainId = await provider.request({ method: 'eth_chainId' });
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (Number(BigInt(chainId)) !== CHAIN_ID || !accounts.length || accounts[0].toLowerCase() !== account.toLowerCase()) throw new Error('钱包网络或账户已变化，已停止执行，请重新预览。');
}

/** The only write boundary: one provider send per step, never RPC transport retries. */
export async function executePlan(plan: TxPlan, settings: Settings, provider: EIP1193Provider, onEvent: (event: ExecutionEvent) => void, shouldContinue: () => boolean = () => true): Promise<void> {
  assertPlan(plan);
  validateSettings(settings);
  markConsumed(plan.id);
  const client = createReadClient(settings);
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    let hash: Hex | undefined;
    try {
      if (!shouldContinue()) throw new Error('已停止后续步骤；已广播的交易仍需在链上确认。');
      assertPlan(plan);
      await checkWallet(provider, plan.account);
      onEvent({ index, status: 'simulating', label: step.label });
      const { gas: estimated } = await simulateStep(settings, plan, step);
      const gas = (estimated * 120n + 99n) / 100n;
      const gasPrice = await client.getGasPrice();
      const balance = await client.getBalance({ address: plan.account });
      if (balance < step.value + gas * gasPrice + parseUnits(settings.gasReserveHype, 18)) throw new Error('原生 HYPE 余额不足以覆盖本步骤金额、Gas 上限和保留金额。');
      if (!shouldContinue()) throw new Error('已停止后续步骤。');
      assertPlan(plan);
      await checkWallet(provider, plan.account);
      if (!shouldContinue()) throw new Error('已停止后续步骤，未请求钱包签名。');
      assertPlan(plan);
      onEvent({ index, status: 'signing', label: step.label });
      // A rejected/uncertain request exits the plan. It is never sent a second time.
      const submittedHash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: plan.account, to: step.to, data: step.data, value: toHex(step.value), gas: toHex(gas), gasPrice: toHex(gasPrice), chainId: toHex(CHAIN_ID) }] });
      hash = submittedHash;
      onEvent({ index, status: 'submitted', label: step.label, hash });
      const receipt = await client.waitForTransactionReceipt({ hash: submittedHash, confirmations: 1, pollingInterval: 3000, timeout: 120_000 });
      if (receipt.status !== 'success') throw new Error('交易已上链但执行回滚；已停止后续步骤。');
      if (receipt.transactionHash.toLowerCase() !== submittedHash.toLowerCase()) throw new Error('交易被钱包或其他程序替换，请手动核对链上结果后重新预览。');
      const confirmed = await client.getTransaction({ hash: submittedHash });
      if (confirmed.hash.toLowerCase() !== submittedHash.toLowerCase() || confirmed.from.toLowerCase() !== plan.account.toLowerCase() || confirmed.to?.toLowerCase() !== step.to.toLowerCase() || confirmed.input.toLowerCase() !== step.data.toLowerCase() || confirmed.value !== step.value) throw new Error('已确认交易的发送人、合约、调用数据或金额与预览不符；已停止后续步骤，请手动核对钱包活动。');
      onEvent({ index, status: 'confirmed', label: step.label, hash });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = hash ? `${raw} 已广播 ${hash}；如确认状态未知，请先检查浏览器，禁止盲目重发。` : `${raw} 未自动重发；若钱包返回状态不明确，请先检查钱包活动和链上记录。`;
      onEvent({ index, status: 'failed', label: step.label, hash, error: message });
      throw new Error(message);
    }
  }
}
