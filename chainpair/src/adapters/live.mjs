import { createHmac, randomUUID, createPublicKey, verify } from 'node:crypto';
import { Interface, getAddress, keccak256 } from 'ethers';
import { VersionedTransaction, PublicKey, TransactionMessage, AddressLookupTableAccount } from '@solana/web3.js';
import bs58 from 'bs58';
import Decimal from 'decimal.js';
import { RpcPool } from './rpc.mjs';

class AdapterError extends Error { constructor(message) { super(message); this.safe = true; } }
const CHAINS = { bnb: '56', solana: '501' };
const ERC20 = new Interface(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
// ABI fragments verified against OKX's published DexRouter ABI. Unsupported
// router methods are rejected rather than interpreted from byte substrings.
const BASE = '(uint256 fromToken,address toToken,uint256 fromTokenAmount,uint256 minReturnAmount,uint256 deadLine)';
const PATH = '(address[] mixAdapters,address[] assetTo,uint256[] rawData,bytes[] extraData,uint256 fromToken)';
const PMM = '(uint256 pathIndex,address payer,address fromToken,address toToken,uint256 fromTokenAmountMax,uint256 toTokenAmountMax,uint256 salt,uint256 deadLine,bool isPushOrder,bytes extension)';
const ROUTER_ABI = new Interface([
  `function dagSwapByOrderId(uint256 orderId,${BASE} baseRequest,${PATH}[] paths) payable returns(uint256)`,
  `function dagSwapTo(uint256 orderId,address receiver,${BASE} baseRequest,${PATH}[] paths) payable returns(uint256)`,
  `function smartSwapByOrderId(uint256 orderId,${BASE} baseRequest,uint256[] batchesAmount,${PATH}[][] batches,${PMM}[] pmmRequests) payable returns(uint256)`,
  `function smartSwapTo(uint256 orderId,address receiver,${BASE} baseRequest,uint256[] batchesAmount,${PATH}[][] batches,${PMM}[] pmmRequests) payable returns(uint256)`,
  `function swapWrapToWithBaseRequest(uint256 orderId,address receiver,${BASE} baseRequest) payable`,
  `function uniswapV3SwapToWithBaseRequest(uint256 orderId,address receiver,${BASE} baseRequest,uint256[] pools) payable returns(uint256)`,
  `function unxswapToWithBaseRequest(uint256 orderId,address receiver,${BASE} baseRequest,bytes32[] pools) payable returns(uint256)`
]);
const DLN_SOURCE = '0xef4fb24ad0916217251f553c0596f8edc630eb66';
const ORDER_CREATION = '(address giveTokenAddress,uint256 giveAmount,bytes takeTokenAddress,uint256 takeAmount,uint256 takeChainId,bytes receiverDst,address givePatchAuthoritySrc,bytes orderAuthorityAddressDst,bytes allowedTakerDst,bytes externalCall,bytes allowedCancelBeneficiarySrc)';
const DLN_ABI = new Interface([
  `function createOrder(${ORDER_CREATION} order,bytes affiliateFee,uint32 referralCode,bytes permitEnvelope) payable returns(bytes32)`,
  `function createSaltedOrder(${ORDER_CREATION} order,uint64 salt,bytes affiliateFee,uint32 referralCode,bytes permitEnvelope,bytes metadata) payable returns(bytes32)`,
  'function globalFixedNativeFee() view returns(uint88)'
]);
export function validateDlnBridgeIntent(quote, tx) {
  if (!same('bnb', tx.to, DLN_SOURCE)) throw new AdapterError('UNSUPPORTED_BRIDGE_ABI：当前仅支持已核验 deBridge DLN Source 直接调用');
  let decoded; try { decoded = DLN_ABI.parseTransaction({ data: tx.data, value: tx.value ?? 0 }); } catch {}
  if (!decoded?.args?.order) throw new AdapterError('UNSUPPORTED_BRIDGE_ABI：deBridge 方法不受支持');
  const order = decoded.args.order, expectedRecipient = `0x${Buffer.from(new PublicKey(quote.recipient).toBytes()).toString('hex')}`;
  const expectedMint = `0x${Buffer.from(new PublicKey(quote.toToken.address).toBytes()).toString('hex')}`;
  if (quote.toChain !== 'solana' || !same('bnb', order.giveTokenAddress, quote.fromToken.address) || order.giveAmount !== BigInt(quote.amountInRaw) ||
      order.takeChainId !== 7565164n || order.takeTokenAddress.toLowerCase() !== expectedMint || order.receiverDst.toLowerCase() !== expectedRecipient ||
      order.takeAmount < BigInt(quote.minOutRaw) || !same('bnb', order.givePatchAuthoritySrc, quote.sender) || order.orderAuthorityAddressDst.toLowerCase() !== expectedRecipient ||
      order.externalCall !== '0x' || decoded.args.permitEnvelope !== '0x' || decoded.args.affiliateFee !== '0x' ||
      (order.allowedCancelBeneficiarySrc !== '0x' && !same('bnb', order.allowedCancelBeneficiarySrc, quote.sender))) throw new AdapterError('deBridge 已解码代币、金额、目标链、收款人、权限或附加调用与交易意图不一致');
  return { protocol: 'deBridge DLN', takeAmount: order.takeAmount.toString() };
}
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const DEFAULT_BNB = ['0x5994814f2c4040b863a0125a45de152a8c2a4dec', '0x2c34a2fb1d0b4f55de51e1d0bdefaddce6b7cdd6'];
const DEFAULT_SOL = ['11111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', ...TOKEN_PROGRAMS, 'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u'];
const raw = value => { const s = String(value ?? ''); if (!/^(0|[1-9]\d*)$/.test(s)) throw new AdapterError('代币数量必须是非负整数原始单位'); return s; };
const positive = value => { const s = raw(value); if (BigInt(s) <= 0n) throw new AdapterError('交易数量必须大于零'); return s; };
const same = (chain, a, b) => chain === 'bnb' ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b);
const decimal = value => { const d = new Decimal(value); if (!d.isFinite()) throw new AdapterError('无效数值'); return d; };
const json = value => JSON.parse(JSON.stringify(value, (_, x) => typeof x === 'bigint' ? x.toString() : x));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const unit = (amount, decimals) => decimal(amount).div(new Decimal(10).pow(decimals));
const quoteTokenRisk = token => {
  const flag = token?.isHoneyPot;
  const knownFalse = flag === false || flag === 0 || flag === 'false' || flag === '0';
  if (flag === true || flag === 1 || flag === 'true' || flag === '1') throw new AdapterError('TOKEN_RISK：报价来源标记为貔貅代币，禁止交易');
  if (flag !== undefined && flag !== null && !knownFalse) throw new AdapterError('TOKEN_RISK：报价风险标记格式不受支持，禁止交易');
  const tax = token?.taxRate;
  if (tax !== undefined && tax !== null && tax !== '') {
    if (!['string', 'number'].includes(typeof tax)) throw new AdapterError('TOKEN_RISK：转账税数据无效');
    let rate;
    try { rate = decimal(tax); } catch { throw new AdapterError('TOKEN_RISK：转账税数据无效'); }
    if (rate.lt(0)) throw new AdapterError('TOKEN_RISK：转账税数据无效');
    if (rate.gt(0)) throw new AdapterError('TOKEN_RISK：当前实盘不支持带转账税的代币');
  }
  return { honeypot: knownFalse ? 'source-not-flagged' : 'unknown', transferTax: tax !== undefined && tax !== null && tax !== '' ? 'source-zero' : 'unknown' };
};

export function verifyPublishedEvmTransaction(expected, actual, hash) {
  try {
    if (!actual || !same('bnb', actual.hash, hash) || !same('bnb', actual.from, expected.from) ||
        !same('bnb', actual.to, expected.to) || String(actual.input ?? actual.data).toLowerCase() !== expected.data.toLowerCase() ||
        BigInt(actual.value) !== BigInt(expected.value) || BigInt(actual.gas) <= 0n || BigInt(actual.gas) > BigInt(expected.gas) ||
        BigInt(actual.gasPrice) <= 0n || BigInt(actual.gasPrice) > BigInt(expected.gasPrice) ||
        (actual.chainId !== undefined && BigInt(actual.chainId) !== 56n) ||
        (actual.maxFeePerGas !== undefined && BigInt(actual.maxFeePerGas) > BigInt(expected.gasPrice))) throw new Error();
  } catch { throw new AdapterError('插件已发送的 BNB 交易与已核验意图或费用上限不一致，已暂停，请核对交易哈希'); }
  return true;
}

export function validateBrowserSolanaSignature(encoded, original, expectedSender) {
  try {
    if (typeof encoded !== 'string' || encoded.length > 1800 || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length > 1232) throw new Error();
    const signed = VersionedTransaction.deserialize(bytes);
    const message = Buffer.from(signed.message.serialize());
    const keys = signed.message.staticAccountKeys ?? signed.message.accountKeys;
    if (!message.equals(Buffer.from(original.message.serialize())) || signed.message.header.numRequiredSignatures !== 1 ||
        signed.signatures.length !== 1 || keys[0].toBase58() !== expectedSender) throw new Error();
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(expectedSender).toBuffer()]), format: 'der', type: 'spki' });
    if (!verify(null, message, publicKey, signed.signatures[0])) throw new Error();
    return signed;
  } catch { throw new AdapterError('插件返回的 Solana 签名、付款人或交易内容无效，未广播交易'); }
}

export function tokenNetFromEvmReceipt(receipt, token, owner) {
  let net = 0n;
  for (const log of receipt.logs ?? []) {
    if (!same('bnb', log.address, token)) continue;
    let parsed; try { parsed = ERC20.parseLog(log); } catch { continue; }
    if (!parsed || parsed.name !== 'Transfer') continue;
    const [from, to, amount] = parsed.args;
    if (same('bnb', from, owner)) net -= amount;
    if (same('bnb', to, owner)) net += amount;
  }
  return net;
}
export function tokenNetFromSolanaReceipt(transaction, mint, owner) {
  if (!transaction?.meta || transaction.meta.err) throw new AdapterError('Solana 交易缺少有效回执或链上执行失败');
  let before = 0n, after = 0n;
  for (const row of transaction.meta.preTokenBalances ?? []) if (row.mint === mint && row.owner === owner) before += BigInt(row.uiTokenAmount.amount);
  for (const row of transaction.meta.postTokenBalances ?? []) if (row.mint === mint && row.owner === owner) after += BigInt(row.uiTokenAmount.amount);
  return after - before;
}
export function decodeSplAccount(account) {
  if (!account || account.owner !== TOKEN_PROGRAMS[0] || !Array.isArray(account.data) || account.data[1] !== 'base64') throw new AdapterError('Solana 模拟代币账户格式不支持');
  const bytes = Buffer.from(account.data[0], 'base64');
  if (bytes.length !== 165) throw new AdapterError('仅支持 165 字节经典 SPL Token 账户');
  return { mint: new PublicKey(bytes.subarray(0, 32)).toBase58(), owner: new PublicKey(bytes.subarray(32, 64)).toBase58(), amount: bytes.readBigUInt64LE(64),
    // All non-balance control fields must remain unchanged: delegate, state,
    // wrapped-native reserve, delegated amount and close authority.
    authority: bytes.subarray(72, 165).toString('hex'), delegateOption: bytes.readUInt32LE(72), closeAuthorityOption: bytes.readUInt32LE(129), state: bytes[108] };
}
export function validateSolanaSimulationTokens({ quote, beforeAccounts, afterAccounts }) {
  if (beforeAccounts.length !== afterAccounts.length) throw new AdapterError('Solana 模拟账户数量不一致');
  const net = new Map();
  for (let i = 0; i < beforeAccounts.length; i++) {
    const before = beforeAccounts[i] ? decodeSplAccount(beforeAccounts[i]) : null, after = afterAccounts[i] ? decodeSplAccount(afterAccounts[i]) : null;
    if (!before && !after) continue;
    if ((before && before.owner !== quote.sender) || (after && after.owner !== quote.sender) || (before && after && (before.mint !== after.mint || before.authority !== after.authority))) throw new AdapterError('Solana 模拟修改了代币账户所有权、mint 或授权');
    if (before && !after) throw new AdapterError('Solana 模拟关闭了已有代币账户');
    if (!before && after && (after.delegateOption !== 0 || after.closeAuthorityOption !== 0 || after.state !== 1)) throw new AdapterError('Solana 模拟新建账户含额外授权、关闭权限或无效状态');
    const mint = after?.mint ?? before.mint;
    net.set(mint, (net.get(mint) ?? 0n) + (after?.amount ?? 0n) - (before?.amount ?? 0n));
  }
  if ((net.get(quote.fromToken.address) ?? 0n) !== -BigInt(quote.amountInRaw)) throw new AdapterError('Solana 模拟输入代币实际扣款与本笔准确输入不一致');
  for (const [mint, delta] of net) if (mint !== quote.fromToken.address && delta < 0n) throw new AdapterError('Solana 模拟扣除了本笔报价之外的代币');
  if (quote.kind === 'swap' && (net.get(quote.toToken.address) ?? 0n) < BigInt(quote.minOutRaw)) throw new AdapterError('Solana 模拟实际输出低于最低到账');
}

export class LiveAdapter {
  constructor({ getConfig, vault, browserWallets, onRpcStatus = () => {}, fetchImpl = globalThis.fetch, marketFetchImpl = fetchImpl, confirmationTimeoutMs = 180000, bridgeTimeoutMs = 1800000, browserTransactionTimeoutMs = 15000 }) {
    this.getConfig = getConfig; this.vault = vault; this.fetch = fetchImpl;
    this.marketFetch = marketFetchImpl;
    this.browserWallets = browserWallets; this.browserTransactionTimeoutMs = browserTransactionTimeoutMs;
    this.confirmationTimeoutMs = confirmationTimeoutMs; this.bridgeTimeoutMs = bridgeTimeoutMs;
    this.quotes = new Map(); this.used = new Set(); this.rpc = {};
    for (const chain of Object.keys(CHAINS)) this.rpc[chain] = new RpcPool({ chain, getUrls: () => this.getConfig().chains[chain].rpcs, fetchImpl, onStatus: onRpcStatus });
  }
  config(chain) { const c = this.getConfig().chains[chain]; if (!c) throw new AdapterError('不支持的链'); return c; }
  wallet(chain) { const w = this.vault.publicStatus()[chain]; if (!w?.address) throw new AdapterError(`${chain} 未导入钱包或只读地址`); return w.address; }
  async okx(path, params = {}) {
    const credentials = await this.vault.getOkxCredentials();
    const apiKey = credentials?.apiKey, secret = credentials?.secretKey ?? credentials?.apiSecret, passphrase = credentials?.passphrase;
    if (!apiKey || !secret || !passphrase) throw new AdapterError('请先配置并解锁 OKX API 凭据');
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const requestPath = path + (query.size ? `?${query}` : ''), timestamp = new Date().toISOString();
    const headers = { 'OK-ACCESS-KEY': apiKey, 'OK-ACCESS-PASSPHRASE': passphrase, 'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-SIGN': createHmac('sha256', secret).update(timestamp + 'GET' + requestPath).digest('base64') };
    if (this.getConfig().okx?.projectId) headers['OK-ACCESS-PROJECT'] = this.getConfig().okx.projectId;
    const response = await this.fetch(`https://web3.okx.com${requestPath}`, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new AdapterError(`OKX HTTP ${response.status}：请检查权限、限流或网络`);
    const body = await response.json();
    if (String(body.code) !== '0') throw new AdapterError(`OKX ${String(body.code).replace(/[^0-9A-Za-z_-]/g, '').slice(0, 30)}：报价服务拒绝请求，请检查 API 权限、代币、额度及路线支持`);
    if (!Array.isArray(body.data) || !body.data.length) throw new AdapterError('OKX 未返回可用路线');
    return body.data[0];
  }
  async market(chain) {
    const config = this.config(chain);
    if (!config.poolAddress || !config.tokenAddress) throw new AdapterError(`${chain} 请配置代币和交易池地址`);
    const [response, height] = await Promise.all([
      this.marketFetch(`https://api.dexscreener.com/latest/dex/pairs/${chain === 'bnb' ? 'bsc' : 'solana'}/${encodeURIComponent(config.poolAddress)}`, { signal: AbortSignal.timeout(12000), redirect: 'error' }),
      this.rpc[chain].call(chain === 'bnb' ? 'eth_blockNumber' : 'getSlot', chain === 'bnb' ? [] : [{ commitment: 'confirmed' }])
    ]);
    if (!response.ok) throw new AdapterError(`行情 HTTP ${response.status}`);
    const pair = (await response.json()).pairs?.find(p => p.chainId === (chain === 'bnb' ? 'bsc' : 'solana') && same(chain, p.pairAddress, config.poolAddress));
    if (!pair) throw new AdapterError('指定交易池无可用行情');
    let price;
    if (same(chain, pair.baseToken?.address, config.tokenAddress)) price = decimal(pair.priceUsd);
    else if (same(chain, pair.quoteToken?.address, config.tokenAddress) && decimal(pair.priceNative).gt(0)) price = decimal(pair.priceUsd).div(pair.priceNative);
    else throw new AdapterError('交易池不包含配置的代币');
    if (!price.gt(0) || !decimal(pair.liquidity?.usd ?? 0).gt(0)) throw new AdapterError('行情价格或流动性无效');
    return { chain, priceUsd: price.toNumber(), liquidityUsd: Number(pair.liquidity.usd), updatedAt: new Date().toISOString(), connected: true,
      source: 'DexScreener（索引行情，执行另行报价）', block: chain === 'bnb' ? Number(BigInt(height)) : height,
      symbol: same(chain, pair.baseToken?.address, config.tokenAddress) ? pair.baseToken.symbol : pair.quoteToken.symbol,
      poolAddress: config.poolAddress, raw: pair };
  }
  async validateToken(chain, token) {
    const { address, decimals } = token;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new AdapterError('代币 decimals 无效');
    if (chain === 'bnb') {
      getAddress(address);
      const data = await this.rpc.bnb.call('eth_call', [{ to: address, data: ERC20.encodeFunctionData('decimals') }, 'latest']);
      if (Number(ERC20.decodeFunctionResult('decimals', data)[0]) !== decimals) throw new AdapterError('配置 decimals 与 BNB 链上代币不一致');
    } else {
      new PublicKey(address);
      const value = (await this.rpc.solana.call('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value;
      if (!value || !TOKEN_PROGRAMS.includes(value.owner) || value.data?.parsed?.type !== 'mint' || value.data.parsed.info.decimals !== decimals) throw new AdapterError('配置 decimals 与 Solana 链上 mint 不一致');
      if (value.owner !== TOKEN_PROGRAMS[0]) throw new AdapterError('当前实盘仅支持经典 SPL Token，Token-2022 扩展须单独审核');
    }
  }
  async balanceRaw(chain, token, owner = this.wallet(chain)) {
    if (chain === 'bnb') {
      const result = await this.rpc.bnb.call('eth_call', [{ to: token.address, data: ERC20.encodeFunctionData('balanceOf', [owner]) }, 'latest']);
      return ERC20.decodeFunctionResult('balanceOf', result)[0].toString();
    }
    const result = await this.rpc.solana.call('getTokenAccountsByOwner', [owner, { mint: token.address }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return (result.value ?? []).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n).toString();
  }
  async balances(chain) {
    const c = this.config(chain), address = this.wallet(chain);
    const stable = { address: c.stableAddress, decimals: c.stableDecimals }, token = { address: c.tokenAddress, decimals: c.tokenDecimals };
    const [nativeResult, stableRaw, tokenRaw] = await Promise.all([
      this.rpc[chain].call(chain === 'bnb' ? 'eth_getBalance' : 'getBalance', chain === 'bnb' ? [address, 'latest'] : [address, { commitment: 'confirmed' }]),
      this.balanceRaw(chain, stable, address), c.tokenAddress ? this.balanceRaw(chain, token, address) : Promise.resolve(null)
    ]);
    const nativeRaw = chain === 'bnb' ? BigInt(nativeResult).toString() : raw(nativeResult.value);
    return { chain, address, stableRaw, tokenRaw, nativeRaw, stableUsd: unit(stableRaw, stable.decimals).toNumber(), availableUsd: unit(stableRaw, stable.decimals).toNumber(),
      tokenBalance: tokenRaw === null ? null : unit(tokenRaw, token.decimals).toNumber(), native: unit(nativeRaw, chain === 'bnb' ? 18 : 9).toNumber(), nativeBalance: unit(nativeRaw, chain === 'bnb' ? 18 : 9).toNumber(), updatedAt: new Date().toISOString(), valuation: '稳定币余额按 1U 计；成交报价按 API 美元价格复核' };
  }
  checkPool(chain, route) {
    const c = this.config(chain);
    // Aggregator mode is explicitly selected by the user. Its execution route
    // is validated by token/amount/recipient intent, reviewed ABI/programs and
    // transaction simulation; the scanner's reference pool is not its route.
    if (c.routingMode === 'aggregator') return;
    if (c.poolAddress && c.requirePoolMatch !== false && !JSON.stringify(route).toLowerCase().includes(c.poolAddress.toLowerCase())) throw new AdapterError('POOL_ROUTE_UNVERIFIED：OKX 路线未返回指定池地址，无法验证按配置池执行');
  }
  remember(quote) {
    for (const [id, q] of this.quotes) if (Date.parse(q.expiresAt) < Date.now()) this.quotes.delete(id);
    this.quotes.set(quote.id, structuredClone(quote)); return quote;
  }
  assertQuoteFresh(quote) {
    if (!Number.isFinite(Date.parse(quote?.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) throw new AdapterError('报价已过期，未签名或广播新的交易，请重新报价');
  }
  async quoteSwap({ chain, fromToken, toToken, amountRaw, allowUnapproved = false }) {
    if (typeof allowUnapproved !== 'boolean') throw new AdapterError('授权查询选项无效');
    positive(amountRaw); const c = this.getConfig(), wallet = this.wallet(chain);
    await Promise.all([this.validateToken(chain, fromToken), this.validateToken(chain, toToken)]);
    const requestedAt = new Date().toISOString();
    const result = await this.okx('/api/v6/dex/aggregator/swap', { chainIndex: CHAINS[chain], fromTokenAddress: fromToken.address, toTokenAddress: toToken.address, amount: amountRaw,
      userWalletAddress: wallet, swapReceiverAddress: wallet, swapMode: 'exactIn', slippagePercent: decimal(c.risk.maxSlippageBps).div(100).toString(),
      autoSlippage: 'false', priceImpactProtectionPercent: decimal(c.risk.maxPriceImpactBps).div(100).toString(), solanaTransactionVersion: chain === 'solana' ? 'V0' : undefined });
    const receivedAt = new Date().toISOString();
    const route = result.routerResult;
    if (!route || !result.tx) throw new AdapterError('OKX swap 响应结构不受支持');
    if (result.tx.signatureData !== undefined && result.tx.signatureData !== null && result.tx.signatureData !== '') throw new AdapterError('UNSUPPORTED_SIGNATURE_DATA：该路线要求额外签名，当前不支持');
    if (String(route.chainIndex) !== CHAINS[chain] || !same(chain, route.fromToken?.tokenContractAddress, fromToken.address) || !same(chain, route.toToken?.tokenContractAddress, toToken.address) || raw(route.fromTokenAmount) !== amountRaw) throw new AdapterError('OKX 报价链、代币或数量不匹配');
    this.checkPool(chain, route);
    const tokenRisk = { from: quoteTokenRisk(route.fromToken), to: quoteTokenRisk(route.toToken) };
    if (route.priceImpactPercent === null || route.priceImpactPercent === undefined || route.priceImpactPercent === '') throw new AdapterError('报价缺少可验证价格冲击');
    const impact = decimal(route.priceImpactPercent).abs().mul(100).toNumber();
    if (impact > c.risk.maxPriceImpactBps) throw new AdapterError('价格冲击超过限制');
    const out = positive(route.toTokenAmount), minimum = decimal(out).mul(new Decimal(1).minus(decimal(c.risk.maxSlippageBps).div(10000))).floor().toFixed(0);
    const fee = await this.estimateFee(chain, result.tx);
    const quote = { id: randomUUID(), kind: 'swap', fromChain: chain, toChain: chain, fromToken, toToken, sender: wallet, recipient: wallet,
      amountInRaw: amountRaw, amountOutRaw: out, minOutRaw: minimum, feeUsd: fee.feeUsd, estimatedRentUsd: fee.estimatedRentUsd, bnbGas: fee.bnbGas, solFee: fee.solFee,
      priceImpactBps: impact, tokenRisk, requestedAt, receivedAt, expiresAt: new Date(Date.parse(requestedAt) + (c.quoteTtlMs ?? 20000)).toISOString(), raw: result, tx: result.tx, fromUnitUsd: route.fromToken.tokenUnitPrice, toUnitUsd: route.toToken.tokenUnitPrice };
    if (chain === 'bnb') {
      await this.validateEvmTx(quote, quote.tx);
      if (allowUnapproved) quote.approvalRequirement = await this.allowanceRequirement(quote);
      else await this.assertAllowance(quote);
    } else await this.validateSolanaTx(quote, this.decodeSolana(quote.tx.data));
    quote.validatedAt = new Date().toISOString(); this.assertQuoteFresh(quote);
    return this.remember(quote);
  }
  async quoteTokenBridge({ fromChain, toChain, fromToken, toToken, amountRaw }) {
    positive(amountRaw); if (fromChain === toChain) throw new AdapterError('跨链来源和目标必须不同');
    const c = this.getConfig(), sender = this.wallet(fromChain), recipient = this.wallet(toChain);
    await Promise.all([this.validateToken(fromChain, fromToken), this.validateToken(toChain, toToken)]);
    const params = { fromChainIndex: CHAINS[fromChain], toChainIndex: CHAINS[toChain], fromTokenAddress: fromToken.address, toTokenAddress: toToken.address,
      amount: amountRaw, slippage: decimal(c.risk.maxSlippageBps).div(10000).toString(), userWalletAddress: sender, receiveAddress: recipient };
    const requestedAt = new Date().toISOString();
    const info = await this.okx('/api/v6/dex/cross-chain/quote', { ...params, checkApprove: 'true' });
    if (String(info.fromChainIndex) !== CHAINS[fromChain] || String(info.toChainIndex) !== CHAINS[toChain] || raw(info.fromTokenAmount) !== amountRaw ||
      !same(fromChain, info.fromToken?.tokenContractAddress, fromToken.address) || !same(toChain, info.toToken?.tokenContractAddress, toToken.address)) throw new AdapterError('跨链报价链、代币或数量不匹配');
    const route = (info.routerList ?? []).filter(r => r.bridgeId !== undefined && BigInt(raw(r.toTokenAmount)) > 0n).sort((a, b) => {
      if (fromChain === 'bnb') {
        const preferA = /debridge|dln/i.test(a.bridgeName ?? '') ? 1 : 0, preferB = /debridge|dln/i.test(b.bridgeName ?? '') ? 1 : 0;
        if (preferA !== preferB) return preferB - preferA;
      }
      return decimal(b.toTokenAmount).cmp(a.toTokenAmount);
    })[0];
    if (!route) throw new AdapterError('OKX 不支持这两个代币之间的跨链路线');
    if (route.priceImpactPercentage === undefined || route.priceImpactPercentage === null || route.priceImpactPercentage === '') throw new AdapterError('跨链路线价格冲击未知，禁止执行');
    const impact = decimal(route.priceImpactPercentage).abs().mul(100).toNumber();
    if (impact > c.risk.maxPriceImpactBps) throw new AdapterError('跨链价格冲击超过限制');
    const built = await this.okx('/api/v6/dex/cross-chain/swap', { ...params, bridgeId: route.bridgeId });
    const receivedAt = new Date().toISOString();
    if (!built.tx || String(built.router?.bridgeId) !== String(route.bridgeId) || raw(built.fromTokenAmount) !== amountRaw) throw new AdapterError('跨链构建路线与报价不匹配');
    const out = positive(built.toTokenAmount), minimum = positive(built.minimumReceived);
    const localMinimum = decimal(out).mul(new Decimal(1).minus(decimal(c.risk.maxSlippageBps).div(10000))).floor();
    if (BigInt(minimum) > BigInt(out) || decimal(minimum).lt(localMinimum)) throw new AdapterError('跨链最低到账无效或低于本地滑点限制');
    const fee = await this.estimateFee(fromChain, built.tx);
    // Token loss is already reflected in output. Network fee is source gas only;
    // destination rent is measured at settlement, and missing fee information blocks submit.
    const quote = { id: randomUUID(), kind: 'bridge', fromChain, toChain, fromToken, toToken, sender, recipient,
      amountInRaw: amountRaw, amountOutRaw: out, minOutRaw: minimum, feeUsd: fee.feeUsd, estimatedRentUsd: fee.estimatedRentUsd, bnbGas: fee.bnbGas, solFee: fee.solFee,
      priceImpactBps: impact, bridgeId: String(route.bridgeId), bridgeName: route.bridgeName, requestedAt, receivedAt, expiresAt: new Date(Date.parse(requestedAt) + (c.quoteTtlMs ?? 20000)).toISOString(), raw: { quote: info, swap: built }, tx: built.tx };
    if (fromChain === 'bnb') { await this.validateEvmTx(quote, quote.tx); await this.assertAllowance(quote); } else await this.validateSolanaTx(quote, this.decodeSolana(quote.tx.data));
    quote.validatedAt = new Date().toISOString(); this.assertQuoteFresh(quote);
    return this.remember(quote);
  }
  async estimateFee(chain, tx) {
    const c = this.getConfig(); let native, rentNative = new Decimal(0);
    if (chain === 'bnb') {
      const gas = tx.gas ?? tx.gasLimit, gasPrice = tx.gasPrice ?? tx.maxFeePerGas;
      if (!gas || !gasPrice) throw new AdapterError('BNB 报价缺少 Gas 上限或 Gas 价格');
      native = unit(BigInt(gas) * BigInt(gasPrice) + BigInt(tx.value ?? 0), 18);
    } else {
      const unsigned = this.decodeSolana(tx.data);
      const message = Buffer.from(unsigned.message.serialize()).toString('base64');
      const estimate = await this.rpc.solana.call('getFeeForMessage', [message, { commitment: 'confirmed' }]);
      if (estimate.value === null || estimate.value === undefined) throw new AdapterError('Solana 报价区块哈希过期，无法估算网络费');
      native = unit(estimate.value, 9);
      // ATA rent must be estimated before the initial buy even when a later
      // leg cannot yet be simulated because its input tokens have not arrived.
      const decoded = await this.solanaKeys(unsigned), rentAccounts = new Set();
      for (const instruction of decoded.instructions) {
        if (instruction.programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' && instruction.keys[0]?.pubkey.toBase58() === decoded.payerKey.toBase58()) {
          const address = instruction.keys[1]?.pubkey.toBase58(); if (address) rentAccounts.add(address);
        }
      }
      if (rentAccounts.size) {
        const rent = await this.rpc.solana.call('getMinimumBalanceForRentExemption', [165, { commitment: 'confirmed' }]);
        for (const address of rentAccounts) {
          const account = await this.rpc.solana.call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
          if (!account.value) rentNative = rentNative.plus(unit(rent, 9));
        }
      }
    }
    const nativeUsd = decimal(this.config(chain).nativeUsd);
    if (!nativeUsd.gt(0)) throw new AdapterError('请设置有效的原生币美元估值用于费用风控');
    return { feeUsd: native.plus(rentNative).mul(nativeUsd).toNumber(), estimatedRentUsd: rentNative.mul(nativeUsd).toNumber(), bnbGas: chain === 'bnb' ? native.toNumber() : 0, solFee: chain === 'solana' ? native.plus(rentNative).toNumber() : 0 };
  }
  decodeSolana(encoded) {
    if (typeof encoded !== 'string' || !encoded.length) throw new AdapterError('缺少 Solana 序列化交易');
    let bytes; try { bytes = bs58.decode(encoded); } catch { throw new AdapterError('仅支持 OKX V0 base58 Solana 交易格式'); }
    let transaction; try { transaction = VersionedTransaction.deserialize(bytes); } catch { throw new AdapterError('无法解码 Solana V0 交易'); }
    if (transaction.version !== 0 && transaction.version !== 'legacy') throw new AdapterError('Solana 交易版本不受支持');
    return transaction;
  }
  async validateEvmTx(quote, tx) {
    if (tx.from && !same('bnb', tx.from, quote.sender)) throw new AdapterError('交易发送者不匹配');
    if (tx.chainId && BigInt(tx.chainId) !== 56n) throw new AdapterError('交易链 ID 错误');
    const allowed = this.config('bnb').routerAllowlist ?? DEFAULT_BNB;
    if (!allowed.some(address => same('bnb', address, tx.to))) throw new AdapterError('BNB 交易目标不在 routerAllowlist，需审核后加入');
    if (quote.kind === 'swap' && BigInt(tx.value ?? 0) !== 0n) throw new AdapterError('当前实盘普通兑换仅支持 ERC20 输入且 tx.value=0');
    if (!/^0x[0-9a-fA-F]+$/.test(tx.data ?? '')) throw new AdapterError('交易 calldata 无效');
    if (quote.kind === 'swap') {
      let decoded; try { decoded = ROUTER_ABI.parseTransaction({ data: tx.data, value: tx.value ?? 0 }); } catch {}
      const base = decoded?.args?.baseRequest;
      if (!base) throw new AdapterError('UNSUPPORTED_ROUTER_METHOD：无法通过已核验 ABI 验证代币、数量、最低到账与收款人');
      const encodedFromToken = `0x${(base.fromToken & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`;
      const receiver = decoded.args.receiver ?? quote.sender;
      if (!same('bnb', encodedFromToken, quote.fromToken.address) || !same('bnb', base.toToken, quote.toToken.address) ||
        base.fromTokenAmount !== BigInt(quote.amountInRaw) || base.minReturnAmount < BigInt(quote.minOutRaw) ||
        base.deadLine < BigInt(Math.floor(Date.now() / 1000)) || !same('bnb', receiver, quote.recipient)) throw new AdapterError('EVM 已解码交易参数与报价意图不一致');
    } else {
      validateDlnBridgeIntent(quote, tx);
      const encodedFee = await this.rpc.bnb.call('eth_call', [{ to: tx.to, data: DLN_ABI.encodeFunctionData('globalFixedNativeFee') }, 'latest']);
      const nativeProtocolFee = DLN_ABI.decodeFunctionResult('globalFixedNativeFee', encodedFee)[0];
      if (BigInt(tx.value ?? 0) !== nativeProtocolFee) throw new AdapterError('deBridge 原生币协议费与链上 globalFixedNativeFee 不一致');
    }
    const fee = await this.estimateFee('bnb', tx);
    if (fee.bnbGas > this.getConfig().risk.maxBnbGas) throw new AdapterError('BNB Gas 超过上限');
    return fee;
  }
  async solanaKeys(transaction) {
    const tables = [];
    for (const lookup of transaction.message.addressTableLookups ?? []) {
      const account = (await this.rpc.solana.call('getAccountInfo', [lookup.accountKey.toBase58(), { encoding: 'base64', commitment: 'confirmed' }])).value;
      if (!account) throw new AdapterError('Solana 地址查找表不存在');
      tables.push(new AddressLookupTableAccount({ key: lookup.accountKey, state: AddressLookupTableAccount.deserialize(Buffer.from(account.data[0], 'base64')) }));
    }
    return TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: tables });
  }
  async validateSolanaTx(quote, transaction) {
    const decoded = await this.solanaKeys(transaction);
    if (decoded.payerKey.toBase58() !== quote.sender || transaction.message.header.numRequiredSignatures !== 1) throw new AdapterError('Solana 交易付款人或签名人不匹配');
    const allowed = this.config('solana').programAllowlist ?? DEFAULT_SOL;
    for (const instruction of decoded.instructions) {
      const program = instruction.programId.toBase58();
      if (!allowed.includes(program)) throw new AdapterError(`Solana 程序 ${program} 未在 programAllowlist，需审核后加入`);
      if (TOKEN_PROGRAMS.includes(program) && [4, 6, 13].includes(instruction.data[0])) throw new AdapterError('禁止 Solana 代币授权或更改权限指令');
    }
    if (!decoded.instructions.some(i => i.keys.some(k => k.pubkey.toBase58() === quote.sender))) throw new AdapterError('Solana 交易未引用预期钱包');
    if (quote.kind === 'bridge') {
      const expected = Buffer.from(quote.recipient.slice(2), 'hex');
      if (!decoded.instructions.some(i => Buffer.from(i.data).includes(expected))) throw new AdapterError('Solana 跨链指令无法验证目标 EVM 收款地址');
    }
    const fee = await this.estimateFee('solana', quote.tx);
    if (fee.solFee > this.getConfig().risk.maxSolFee) throw new AdapterError('Solana 网络费超过限制');
    return fee;
  }
  cachedQuote(externalQuote) {
    const quote = this.quotes.get(externalQuote?.id);
    if (!quote || JSON.stringify(quote) !== JSON.stringify(externalQuote)) throw new AdapterError('报价未知或已被修改，请重新报价');
    this.assertQuoteFresh(quote);
    if (this.used.has(quote.id)) throw new AdapterError('报价已提交，禁止复用预检结果');
    if (!same(quote.fromChain, this.wallet(quote.fromChain), quote.sender) || !same(quote.toChain, this.wallet(quote.toChain), quote.recipient)) throw new AdapterError('钱包已变更，必须重新报价');
    return quote;
  }
  async simulateEvmTransaction(quote) {
    this.assertQuoteFresh(quote);
    const tx = quote.tx, gas = BigInt(tx.gas ?? tx.gasLimit), gasPrice = BigInt(tx.gasPrice ?? tx.maxFeePerGas);
    if (gas <= 0n || gasPrice <= 0n) throw new AdapterError('BNB 交易 Gas 参数无效');
    const request = { from: quote.sender, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value ?? 0).toString(16)}`, gas: `0x${gas.toString(16)}`, gasPrice: `0x${gasPrice.toString(16)}` };
    let result, estimated;
    try {
      result = await this.rpc.bnb.call('eth_call', [request, 'pending']);
      this.assertQuoteFresh(quote);
      estimated = await this.rpc.bnb.call('eth_estimateGas', [request, 'pending']);
    } catch (error) {
      if (error?.safe) throw error;
      throw new AdapterError('BNB 未签名交易模拟失败；请核对余额、授权、Gas 上限、路线和 RPC 支持');
    }
    let estimate;
    try { estimate = BigInt(estimated); } catch { throw new AdapterError('BNB 模拟缺少可核验 Gas 估算'); }
    if (estimate <= 0n || estimate > gas) throw new AdapterError('BNB 模拟 Gas 需求超过冻结报价的 Gas 上限，禁止执行');
    let outputVerified = false, simulatedOutRaw = null;
    if (quote.kind === 'swap') {
      let decoded;
      try { decoded = ROUTER_ABI.parseTransaction({ data: tx.data, value: tx.value ?? 0 }); } catch {}
      if (!decoded?.fragment) throw new AdapterError('BNB 模拟无法解码已核验交易方法');
      if (decoded.fragment.outputs?.length) {
        let values;
        try { values = ROUTER_ABI.decodeFunctionResult(decoded.fragment, result); } catch { throw new AdapterError('BNB 模拟未返回已核验 ABI 要求的到账数量'); }
        if (values.length !== 1 || typeof values[0] !== 'bigint') throw new AdapterError('BNB 模拟返回数量格式不受支持');
        if (values[0] < BigInt(quote.minOutRaw)) throw new AdapterError('BNB 模拟输出低于最低到账，禁止执行');
        simulatedOutRaw = values[0].toString(); outputVerified = true;
      }
    }
    this.assertQuoteFresh(quote);
    return { outputVerified, simulatedOutRaw, estimatedGas: estimate.toString(), gasLimit: gas.toString() };
  }
  /** Read-only simulation over this exact cached quote; never obtains a signer. */
  async preflightSwap(externalQuote) {
    const quote = this.cachedQuote(externalQuote);
    if (quote.kind !== 'swap' || quote.fromChain !== quote.toChain || !['bnb', 'solana'].includes(quote.fromChain)) throw new AdapterError('未签名成交预检仅支持同链兑换');
    const chain = quote.fromChain, c = this.getConfig();
    const balances = await this.balances(chain);
    const fee = chain === 'bnb' ? await this.validateEvmTx(quote, quote.tx) : await this.validateSolanaTx(quote, this.decodeSolana(quote.tx.data));
    const reserve = chain === 'bnb' ? c.risk.reserveBnb : c.risk.reserveSol, nativeFee = chain === 'bnb' ? fee.bnbGas : fee.solFee;
    if (!Number.isFinite(nativeFee) || nativeFee < 0 || !Number.isFinite(balances.native) || decimal(balances.native).minus(nativeFee).lt(reserve)) throw new AdapterError('预检原生币不足以支付费用并保留 Gas 资金');
    if (BigInt(await this.balanceRaw(chain, quote.fromToken)) < BigInt(quote.amountInRaw)) throw new AdapterError('预检输入代币余额不足，禁止模拟为可执行');
    const checks = ['cached-quote-immutable', 'wallet-identity', 'token-amount-recipient-intent', 'native-reserve', 'input-balance'];
    let evidence;
    if (chain === 'bnb') {
      await this.assertAllowance(quote);
      evidence = await this.simulateEvmTransaction(quote);
      checks.push('allowance', 'pending-eth-call-with-frozen-gas', 'gas-estimate-within-quote');
      if (evidence.outputVerified) checks.push('simulated-output-at-least-minimum');
    } else {
      const transaction = this.decodeSolana(quote.tx.data);
      if (transaction.signatures.length !== 1 || transaction.signatures.some(signature => signature.some(byte => byte !== 0))) throw new AdapterError('未签名预检要求单一钱包的空签名交易');
      const owned = (await this.rpc.solana.call('getTokenAccountsByOwner', [quote.sender, { programId: TOKEN_PROGRAMS[0] }, { encoding: 'base64', commitment: 'confirmed' }])).value;
      if (!Array.isArray(owned)) throw new AdapterError('Solana 未返回可核验的代币账户列表');
      const addresses = [], beforeAccounts = [];
      for (const account of owned) {
        let address; try { address = new PublicKey(account?.pubkey).toBase58(); } catch { throw new AdapterError('Solana 自有代币账户地址无效'); }
        if (addresses.includes(address)) throw new AdapterError('Solana 自有代币账户重复，无法核对实际变动');
        addresses.push(address); beforeAccounts.push(account.account);
      }
      const [ata] = PublicKey.findProgramAddressSync([new PublicKey(quote.sender).toBuffer(), new PublicKey(TOKEN_PROGRAMS[0]).toBuffer(), new PublicKey(quote.toToken.address).toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
      if (!addresses.includes(ata.toBase58())) {
        const account = (await this.rpc.solana.call('getAccountInfo', [ata.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]))?.value;
        addresses.push(ata.toBase58()); beforeAccounts.push(account ?? null);
      }
      if (addresses.length > 99) throw new AdapterError('Solana 自有代币账户超过模拟核验上限 99');
      let simulation;
      try { simulation = await this.rpc.solana.call('simulateTransaction', [Buffer.from(transaction.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [quote.sender, ...addresses] } }]); }
      catch { throw new AdapterError('Solana 未签名交易模拟失败；请核对区块哈希、余额、路线和 RPC 支持'); }
      if (!simulation?.value || simulation.value.err !== null || !Array.isArray(simulation.value.accounts) || simulation.value.accounts.length !== addresses.length + 1) throw new AdapterError('Solana 未签名模拟失败或缺少完整账户回执');
      const postLamports = simulation.value.accounts[0]?.lamports;
      if (!Number.isSafeInteger(postLamports) || postLamports < 0 || !/^\d+$/.test(String(balances.nativeRaw))) throw new AdapterError('Solana 模拟未返回可核验钱包余额');
      const debitRaw = BigInt(balances.nativeRaw) - BigInt(postLamports), debit = unit(debitRaw > 0n ? debitRaw : 0n, 9);
      if (debit.gt(c.risk.maxSolFee) || unit(postLamports, 9).lt(reserve)) throw new AdapterError('Solana 模拟费用或租金超过限制，或 Gas 储备不足');
      if (debit.gt(new Decimal(fee.solFee).plus('0.000000001'))) throw new AdapterError('Solana 模拟实际扣款高于冻结报价费用估算，禁止执行');
      validateSolanaSimulationTokens({ quote, beforeAccounts, afterAccounts: simulation.value.accounts.slice(1) });
      evidence = { outputVerified: true, feeNative: debit.toNumber() };
      checks.push('unsigned-simulate-transaction', 'exact-input-debit', 'simulated-output-at-least-minimum', 'unchanged-unrelated-tokens-and-authority', 'simulated-native-fee-and-reserve');
    }
    this.cachedQuote(quote);
    return { verified: true, readOnly: true, chain, quoteId: quote.id, checkedAt: new Date().toISOString(), expiresAt: quote.expiresAt, checks, ...evidence,
      onChainMinimumDecoded: chain === 'bnb',
      limitations: chain === 'solana' ? ['当前 Solana 路由程序的指令最小到账字段尚未独立解码；本结果仅验证当前状态模拟，不保证上链时的最小到账或成交。'] : evidence.outputVerified ? [] : ['该方法 ABI 不返回到账数量；已验证调用和已解码最小到账参数，未取得模拟余额变动证据。'] };
  }
  async submit(externalQuote, { onSubmitted = async () => {}, beforeBroadcast = () => {} } = {}) {
    const quote = this.quotes.get(externalQuote.id);
    if (!quote || JSON.stringify(quote) !== JSON.stringify(externalQuote)) throw new AdapterError('报价未知或已被修改，请重新报价');
    this.assertQuoteFresh(quote);
    const assertReady = () => { this.assertQuoteFresh(quote); beforeBroadcast(); this.assertQuoteFresh(quote); };
    if (this.used.has(quote.id)) throw new AdapterError('报价已提交，禁止重复发送');
    if (!same(quote.fromChain, this.wallet(quote.fromChain), quote.sender) || !same(quote.toChain, this.wallet(quote.toChain), quote.recipient)) throw new AdapterError('钱包已变更，必须重新报价');
    const wallet = this.vault.publicStatus()[quote.fromChain], browser = wallet?.mode === 'browser';
    if (browser && (!wallet.canSign || !this.browserWallets)) throw new AdapterError('插件钱包未连接，请保持本机页面打开并重新连接');
    let signer;
    let balances = await this.balances(quote.fromChain);
    const c = this.getConfig();
    const fee = quote.fromChain === 'bnb' ? await this.validateEvmTx(quote, quote.tx) : await this.validateSolanaTx(quote, this.decodeSolana(quote.tx.data));
    const reserve = quote.fromChain === 'bnb' ? c.risk.reserveBnb : c.risk.reserveSol;
    if (decimal(balances.native).minus(quote.fromChain === 'bnb' ? fee.bnbGas : fee.solFee).lt(reserve)) throw new AdapterError('原生币不足以支付费用并保留 Gas 资金');
    if (BigInt(await this.balanceRaw(quote.fromChain, quote.fromToken)) < BigInt(quote.amountInRaw)) throw new AdapterError('输入代币余额不足');
    // Approval is explicit and audited as a separate submission. Automatic approval
    // here would hide an additional irreversible transaction from the journal.
    if (quote.fromChain === 'bnb') await this.assertAllowance(quote);
    let signed, hash, blockhash;
    if (quote.fromChain === 'bnb') {
      const tx = quote.tx;
      const request = { to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), chainId: 56, gasLimit: BigInt(tx.gas ?? tx.gasLimit), gasPrice: BigInt(tx.gasPrice ?? tx.maxFeePerGas) };
      await this.simulateEvmTransaction(quote);
      assertReady();
      if (browser) return this.submitBrowserEvm(quote, request, onSubmitted, assertReady);
      const nonce = await this.rpc.bnb.call('eth_getTransactionCount', [quote.sender, 'pending']);
      request.nonce = Number(BigInt(nonce));
      assertReady();
      signer = await this.vault.signer(quote.fromChain); assertReady();
      signed = await signer.signTransaction(request); hash = keccak256(signed);
    } else {
      let transaction = this.decodeSolana(quote.tx.data);
      blockhash = transaction.message.recentBlockhash;
      if (browser) {
        // A quote is consumed before asking the extension. A rejected, lost or
        // timed-out popup must never cause an automatic signing retry.
        assertReady(); this.used.add(quote.id);
        const result = await this.browserWallets.request('solana', { kind: 'solSign', quoteId: quote.id, expiresAt: quote.expiresAt,
          payload: { transactionBase64: Buffer.from(transaction.serialize()).toString('base64'), sender: quote.sender },
          summary: { kind: quote.kind, amountInRaw: quote.amountInRaw, fromToken: quote.fromToken.address, toToken: quote.toToken.address } });
        transaction = validateBrowserSolanaSignature(result?.signedTransactionBase64, transaction, quote.sender);
        if (Date.parse(quote.expiresAt) <= Date.now()) throw new AdapterError('插件签名期间报价已过期，未广播交易，请重新报价');
        balances = await this.balances('solana');
        if (decimal(balances.native).minus(fee.solFee).lt(reserve)) throw new AdapterError('签名后原生币余额变化，Gas 储备不足，未广播交易');
      } else { assertReady(); signer = await this.vault.signer(quote.fromChain); assertReady(); transaction.sign([signer]); }
      signed = Buffer.from(transaction.serialize()).toString('base64'); hash = bs58.encode(transaction.signatures[0]);
      const owned = (await this.rpc.solana.call('getTokenAccountsByOwner', [quote.sender, { programId: TOKEN_PROGRAMS[0] }, { encoding: 'base64', commitment: 'confirmed' }])).value ?? [];
      const addresses = owned.map(a => a.pubkey), beforeAccounts = owned.map(a => a.account);
      if (quote.kind === 'swap') {
        const [ata] = PublicKey.findProgramAddressSync([new PublicKey(quote.sender).toBuffer(), new PublicKey(TOKEN_PROGRAMS[0]).toBuffer(), new PublicKey(quote.toToken.address).toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
        if (!addresses.includes(ata.toBase58())) { addresses.push(ata.toBase58()); beforeAccounts.push(null); }
      }
      if (addresses.length > 99) throw new AdapterError('Solana 自有代币账户超过模拟核验上限 99，禁止签名');
      const simulation = await this.rpc.solana.call('simulateTransaction', [signed, { encoding: 'base64', sigVerify: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [quote.sender, ...addresses] } }]);
      if (!simulation?.value || simulation.value.err !== null || !Array.isArray(simulation.value.accounts) || simulation.value.accounts.length !== addresses.length + 1) throw new AdapterError('Solana 已签名模拟失败或缺少完整账户回执，未广播交易');
      const postLamports = simulation.value?.accounts?.[0]?.lamports;
      if (!Number.isSafeInteger(postLamports) || postLamports < 0 || !/^\d+$/.test(String(balances.nativeRaw))) throw new AdapterError('Solana 模拟未返回可核验钱包余额，无法验证原生币扣款');
      const debitRaw = BigInt(balances.nativeRaw) - BigInt(postLamports), debit = unit(debitRaw > 0n ? debitRaw : 0n, 9);
      if (debit.gt(c.risk.maxSolFee) || unit(postLamports, 9).lt(c.risk.reserveSol)) throw new AdapterError('Solana 模拟网络费与租金总扣款超过限制或 Gas 储备不足');
      if (debit.gt(new Decimal(fee.solFee).plus('0.000000001'))) throw new AdapterError('Solana 模拟实际扣款高于冻结报价费用估算，禁止执行');
      validateSolanaSimulationTokens({ quote, beforeAccounts, afterAccounts: simulation.value.accounts.slice(1) });
      assertReady();
    }
    assertReady();
    const submission = { id: randomUUID(), quote, chain: quote.fromChain, hash, blockhash, submittedAt: new Date().toISOString(), broadcastState: 'prepared' };
    this.used.add(quote.id);
    // Persist the deterministic hash BEFORE broadcasting: a lost RPC response
    // cannot cause an automatic replay. Never expose signed bytes in API output.
    await onSubmitted(json(submission));
    assertReady();
    if (quote.fromChain === 'bnb') {
      const returned = await this.rpc.bnb.call('eth_sendRawTransaction', [signed], { broadcast: true });
      if (String(returned).toLowerCase() !== hash.toLowerCase()) throw new AdapterError('RPC 返回哈希与本地签名不一致，必须人工核对');
    } else {
      const returned = await this.rpc.solana.call('sendTransaction', [signed, { encoding: 'base64', skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' }], { broadcast: true });
      if (returned !== hash) throw new AdapterError('Solana RPC 返回签名不一致，必须人工核对');
    }
    submission.broadcastState = 'sent'; return submission;
  }
  async submitBrowserEvm(quote, request, onSubmitted, assertReady = () => this.assertQuoteFresh(quote)) {
    const transaction = { from: quote.sender, to: request.to, data: request.data,
      value: `0x${request.value.toString(16)}`, gas: `0x${request.gasLimit.toString(16)}`, gasPrice: `0x${request.gasPrice.toString(16)}`, chainId: '0x38' };
    assertReady(); this.used.add(quote.id);
    const result = await this.browserWallets.request('bnb', { kind: 'evmSend', quoteId: quote.id, expiresAt: quote.expiresAt, payload: { transaction },
      summary: { kind: quote.kind, amountInRaw: quote.amountInRaw, fromToken: quote.fromToken.address, toToken: quote.toToken.address } });
    if (!/^0x[0-9a-fA-F]{64}$/.test(result?.hash ?? '')) throw new AdapterError('插件未返回有效交易哈希，交易结果不确定，请人工核对');
    const hash = result.hash;
    const submission = { id: randomUUID(), quote, chain: 'bnb', hash, submittedAt: new Date().toISOString(), broadcastState: 'sent', signer: 'browser' };
    // eth_sendTransaction broadcasts in the extension. Persist its returned
    // hash immediately, and never broadcast the same transaction server-side.
    try {
      await onSubmitted(json(submission));
      const deadline = Date.now() + this.browserTransactionTimeoutMs;
      while (Date.now() < deadline) {
        const published = await this.rpc.bnb.call('eth_getTransactionByHash', [hash]);
        if (published) { verifyPublishedEvmTransaction(transaction, published, hash); return submission; }
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      }
      throw new AdapterError('RPC 暂未找到插件已发送的 BNB 交易，结果不确定，请核对哈希，禁止重发');
    } catch (error) { error.hash = hash; error.sourceHash = hash; throw error; }
  }
  async allowanceRequirement(quote) {
    if (quote.fromChain !== 'bnb') throw new AdapterError('ERC20 授权查询仅支持 BNB Chain');
    getAddress(quote.fromToken.address); getAddress(quote.sender); positive(quote.amountInRaw);
    let spender;
    if (quote.kind === 'bridge') {
      const response = await this.okx('/api/v6/dex/cross-chain/approve-tx', { chainIndex: '56', tokenContractAddress: quote.fromToken.address, userWalletAddress: quote.sender, bridgeId: quote.bridgeId, approveAmount: quote.amountInRaw, checkAllowance: 'true' });
      spender = response.approveAddress;
    } else {
      const response = await this.okx('/api/v6/dex/aggregator/approve-transaction', { chainIndex: '56', tokenContractAddress: quote.fromToken.address, approveAmount: quote.amountInRaw });
      spender = response.dexContractAddress;
    }
    let normalized;
    try { normalized = getAddress(spender); if (/^0x0{40}$/i.test(normalized)) throw new Error(); } catch { throw new AdapterError('授权 spender 地址无效'); }
    if (!(this.config('bnb').routerAllowlist ?? DEFAULT_BNB).some(a => same('bnb', a, normalized))) throw new AdapterError('授权 spender 不在白名单');
    const encoded = await this.rpc.bnb.call('eth_call', [{ to: quote.fromToken.address, data: ERC20.encodeFunctionData('allowance', [quote.sender, spender]) }, 'latest']);
    const allowance = ERC20.decodeFunctionResult('allowance', encoded)[0];
    return { chain: 'bnb', tokenAddress: getAddress(quote.fromToken.address), spender: normalized, owner: getAddress(quote.sender), requiredRaw: quote.amountInRaw, currentRaw: allowance.toString(), sufficient: allowance >= BigInt(quote.amountInRaw) };
  }
  async assertAllowance(quote) {
    const requirement = await this.allowanceRequirement(quote);
    if (!requirement.sufficient) throw new AdapterError(`APPROVAL_REQUIRED：请先通过钱包向已核对的 spender ${requirement.spender} 授权至少本笔数量 ${quote.amountInRaw}（建议仅授权所需额度）；本程序不会隐式发送授权交易`);
    return requirement;
  }
  async receipt(chain, hash, { owner, token, direction = 'in', minRaw = '1' } = {}) {
    const deadline = Date.now() + this.confirmationTimeoutMs;
    let evidence;
    try {
    while (Date.now() < deadline) {
      if (chain === 'bnb') {
        const receipt = await this.rpc.bnb.call('eth_getTransactionReceipt', [hash]);
        if (receipt) {
          evidence = receipt;
          if (BigInt(receipt.status) !== 1n) throw new AdapterError('BNB 链上交易已失败');
          const height = BigInt(await this.rpc.bnb.call('eth_blockNumber'));
          if (height - BigInt(receipt.blockNumber) + 1n < BigInt(this.config(chain).confirmations ?? 3)) { await sleep(1500); continue; }
          const canonical = await this.rpc.bnb.call('eth_getBlockByNumber', [receipt.blockNumber, false]);
          if (canonical?.hash !== receipt.blockHash) throw new AdapterError('BNB 回执所在区块已重组，暂停核对');
          const net = token ? tokenNetFromEvmReceipt(receipt, token.address, owner) : 0n;
          if (token && (direction === 'in' ? net : -net) < BigInt(minRaw)) throw new AdapterError('BNB 回执实际到账或扣款不符合预期');
          const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? 0);
          if (!receipt.effectiveGasPrice) throw new AdapterError('BNB 回执缺少实际 Gas 价格');
          return { receipt, netRaw: net.toString(), feesNative: unit(fee, 18).toNumber(), rentNative: 0 };
        }
      } else {
        const status = (await this.rpc.solana.call('getSignatureStatuses', [[hash], { searchTransactionHistory: true }])).value?.[0];
        if (status?.err) { evidence = status; throw new AdapterError('Solana 链上交易已失败'); }
        if (status?.confirmationStatus === 'finalized') {
          const transaction = await this.rpc.solana.call('getTransaction', [hash, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
          if (transaction) {
            evidence = transaction;
            const net = token ? tokenNetFromSolanaReceipt(transaction, token.address, owner) : 0n;
            if (token && (direction === 'in' ? net : -net) < BigInt(minRaw)) throw new AdapterError('Solana 回执实际到账或扣款不符合预期');
            const keys = transaction.transaction.message.accountKeys, index = keys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === owner);
            const debit = index < 0 ? 0 : Number(transaction.meta.preBalances[index]) - Number(transaction.meta.postBalances[index]);
            const fee = transaction.meta.fee;
            return { receipt: transaction, netRaw: net.toString(), feesNative: fee / 1e9, rentNative: Math.max(0, debit - fee) / 1e9 };
          }
        }
      }
      await sleep(1500);
    }
    throw new AdapterError('链上确认超时，交易可能仍在处理中，禁止自动重发或卖出');
    } catch (error) { if (evidence) error.receipt = json(evidence); error.hash = hash; throw error; }
  }
  async confirm(submission) {
    let source, destination, destinationHash;
    try {
    const q = submission.quote;
    if (!q || !submission.hash) throw new AdapterError('缺少待确认交易记录');
    source = await this.receipt(q.fromChain, submission.hash, { owner: q.sender, token: q.kind === 'bridge' ? q.fromToken : q.toToken, direction: q.kind === 'bridge' ? 'out' : 'in', minRaw: q.kind === 'bridge' ? '1' : q.minOutRaw });
    destination = source; destinationHash = submission.hash;
    if (q.kind === 'bridge') {
      const spent = -BigInt(source.netRaw);
      if (spent <= 0n || spent > BigInt(q.amountInRaw)) throw new AdapterError('跨链源链实际扣款超出报价输入');
      const deadline = Date.now() + this.bridgeTimeoutMs;
      let status;
      while (Date.now() < deadline) {
        status = await this.okx('/api/v6/dex/cross-chain/status', { hash: submission.hash, chainIndex: CHAINS[q.fromChain], bridgeId: q.bridgeId });
        if (status.status === 'SUCCESS') break;
        if (!['PENDING', 'NOT_FOUND'].includes(status.status)) throw new AdapterError(`跨链状态异常 ${String(status.status)}，暂停核对`);
        await sleep(5000);
      }
      if (status?.status !== 'SUCCESS') throw new AdapterError('跨链目标到账超时，禁止卖出并暂停核对');
      if (!status.toTxHash || String(status.toChainIndex) !== CHAINS[q.toChain] || !same(q.toChain, status.toTokenAddress, q.toToken.address)) throw new AdapterError('跨链目标链、代币或哈希无法核实');
      destinationHash = status.toTxHash;
      destination = await this.receipt(q.toChain, destinationHash, { owner: q.recipient, token: q.toToken, minRaw: q.minOutRaw });
      if (BigInt(destination.netRaw) < BigInt(q.minOutRaw) || raw(status.toAmount) !== destination.netRaw) throw new AdapterError('跨链服务到账数量与目标链回执不一致，暂停核对');
    }
    const spentRaw = q.kind === 'bridge' ? (-BigInt(source.netRaw)).toString() : (-BigInt(q.fromChain === 'bnb' ? tokenNetFromEvmReceipt(source.receipt, q.fromToken.address, q.sender) : tokenNetFromSolanaReceipt(source.receipt, q.fromToken.address, q.sender))).toString();
    if (BigInt(spentRaw) <= 0n || BigInt(spentRaw) > BigInt(q.amountInRaw)) throw new AdapterError('交易实际输入扣款不符合预期');
    const protocolFeeNative = q.fromChain === 'bnb' ? unit(BigInt(q.tx?.value ?? 0), 18).toNumber() : 0;
    const totalFeeNative = source.feesNative + protocolFeeNative + source.rentNative;
    const feeUsd = (source.feesNative + protocolFeeNative) * Number(this.config(q.fromChain).nativeUsd), rentUsd = source.rentNative * Number(this.config(q.fromChain).nativeUsd);
    return { confirmed: true, receivedRaw: destination.netRaw, spentRaw, hash: submission.hash, destinationHash,
      feesNative: { [q.fromChain]: totalFeeNative }, networkFeeNative: source.feesNative, protocolFeeNative, rentNative: source.rentNative, feeUsd, rentUsd, bnbGas: q.fromChain === 'bnb' ? totalFeeNative : 0, solFee: q.fromChain === 'solana' ? totalFeeNative : 0,
      receipt: json(source.receipt), destinationReceipt: q.kind === 'bridge' ? json(destination.receipt) : undefined,
      actualSlippageBps: decimal(q.amountOutRaw).minus(destination.netRaw).div(q.amountOutRaw).mul(10000).toNumber(),
      reconciliation: q.kind === 'bridge' ? '目标链费用由桥接方承担，计入跨链到账折损；只扣本钱包源链实际网络费及租金' : '按本交易回执中的本钱包净代币变动核算' };
    } catch (error) {
      if (source) error.sourceReceipt = json(source.receipt);
      if (destination && destination !== source) error.destinationReceipt = json(destination.receipt);
      if (submission.hash) error.sourceHash = submission.hash;
      if (destinationHash && destinationHash !== submission.hash) error.destinationHash = destinationHash;
      throw error;
    }
  }
}
