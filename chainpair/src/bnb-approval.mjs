import { createHash, randomUUID } from 'node:crypto';
import { Interface, getAddress, keccak256, Transaction } from 'ethers';
import Decimal from 'decimal.js';
import { LiveAdapter, verifyPublishedEvmTransaction } from './adapters/live.mjs';
import { createPolicySnapshot, policyFingerprint } from './policy.mjs';

const ERC20 = new Interface(['function approve(address spender,uint256 amount) returns(bool)']);
const LIMIT = (1n << 256n) - 1n, INTENT_MS = 90000, PREPARE_GAP_MS = 1000;
const META = 'bnb-approval.prepare.v1';
const clone = value => structuredClone(value);
const ownError = message => Object.assign(new Error(message), { safe: true, approvalSafe: true });
const fixedError = error => error?.approvalSafe ? error : ownError('BNB 有限授权检查或链上请求未完成，请检查本机配置；如已提交请核对交易档案，禁止重发');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => { try { const out = getAddress(value); if (/^0x0{40}$/i.test(out)) throw Error(); return out; } catch { throw ownError('授权地址无效或为零地址'); } };
const integer = (value, positive = false) => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,77})$/.test(value)) throw ownError('授权原始数量无效');
  const out = BigInt(value); if (out > LIMIT || positive && out === 0n) throw ownError('授权原始数量超出范围'); return out;
};
const hex = value => '0x' + BigInt(value).toString(16);
const rawRpc = value => {
  try {
    if (typeof value === 'number' ? !Number.isSafeInteger(value) : typeof value !== 'string' || !/^(?:0x[0-9a-f]+|0|[1-9]\d*)$/i.test(value) || value.length > 80) throw Error();
    const out = BigInt(value); if (out < 0n || out > LIMIT) throw Error(); return out;
  } catch { throw ownError('授权 RPC 数值无效'); }
};
const asNative = value => new Decimal(value.toString()).div('1000000000000000000');
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const validHash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const terminal = new Set(['COMPLETED', 'REVIEWED']);
const receiptEvidence = receipt => Object.fromEntries(['transactionHash', 'status', 'blockHash', 'blockNumber', 'gasUsed', 'effectiveGasPrice', 'transactionIndex', 'cumulativeGasUsed', 'from', 'to'].filter(key => typeof receipt?.[key] === 'string' || typeof receipt?.[key] === 'number').map(key => [key, receipt[key]]));

/** Explicit, limited ERC20 approvals. No scheduler or arbitrage path invokes this service. */
export class BnbApprovalService {
  constructor({ engine, readiness, adapterFactory, now = Date.now, publishedTimeoutMs = 15000, publishedPollMs = 250 } = {}) {
    if (!engine || !readiness) throw new Error('BNB approval service requires engine and readiness');
    this.engine = engine; this.readiness = readiness; this.adapterFactory = adapterFactory; this.now = now;
    if (!Number.isFinite(publishedTimeoutMs) || publishedTimeoutMs < 0 || publishedTimeoutMs > 60000 || !Number.isFinite(publishedPollMs) || publishedPollMs < 1 || publishedPollMs > 1000) throw new Error('Invalid approval transaction lookup timing');
    this.publishedTimeoutMs = publishedTimeoutMs; this.publishedPollMs = publishedPollMs;
    this.intents = new Map(); this.busy = false; this.pending = null; this.job = null; this.lastError = '';
    const budget = engine.store.getMeta(META);
    this.lastPrepareAt = Number.isSafeInteger(budget?.lastAt) && budget.lastAt >= 0 ? budget.lastAt : null;
  }
  fingerprint() { return policyFingerprint(createPolicySnapshot(this.engine.config)); }
  walletBinding() {
    const all = this.engine.vault.publicStatus(), bnb = all?.bnb || {};
    return createHash('sha256').update(JSON.stringify({ address: typeof bnb.address === 'string' ? bnb.address.toLowerCase() : null, mode: bnb.mode, canSign: bnb.canSign === true, unlocked: bnb.unlocked === true, provider: bnb.provider || null, vaultLocked: all?.locked === true })).digest('hex');
  }
  available() {
    const e = this.engine;
    if (e.store.getMeta?.('execution.global-stop.v1')?.enabled === true) throw ownError('全局停止已启用，禁止准备或发送真实授权');
    if (this.busy || e.busy || e.refreshing || e.configuring || e.quoteBuilders) throw ownError('已有交易、报价或配置任务，请稍候再操作授权');
    if (e.pausedReason || e.store.allTrades().some(trade => !terminal.has(trade.status))) throw ownError('交易档案仍有未完成或待核对记录，禁止发送新的授权');
  }
  contextCurrent(intent, { signing = false, tradeId } = {}) {
    const e = this.engine;
    if (e.store.getMeta?.('execution.global-stop.v1')?.enabled === true) throw ownError('全局停止已启用，有限授权已停止');
    if (intent.expiresAtMs <= this.now() || this.now() < intent.createdAtMs) throw ownError('有限授权审阅已过期，请重新预检后生成');
    if (intent.parentRevision !== e.configRevision || intent.parentFingerprint !== this.fingerprint() || intent.walletBinding !== this.walletBinding()) throw ownError('钱包或配置已变化，有限授权审阅已失效');
    if (e.pausedReason || e.store.allTrades().some(trade => trade.id !== tradeId && !terminal.has(trade.status))) throw ownError('存在未完成或待核对交易，有限授权已停止');
    if (typeof this.readiness.assertApprovalContextCurrent !== 'function') throw ownError('授权上下文校验未启用，请更新程序');
    this.readiness.assertApprovalContextCurrent(intent.context);
    const wallet = e.vault.publicStatus()?.bnb;
    if (!same(wallet?.address, intent.owner)) throw ownError('授权钱包地址已变化');
    if (signing && (e.config.mode !== 'live' || !['private', 'browser'].includes(wallet?.mode) || wallet.canSign !== true || wallet.unlocked !== true)) throw ownError('有限授权发送须为实盘模式且 BNB 钱包已连接或解锁');
    // A configured pair may have a local label that is not a scanner registry ID.
    // Only scanner-backed readiness contexts require a registry identity lookup.
    const scannerAssetId = intent.context?.contextBinding?.assetId;
    if (scannerAssetId && this.readiness.scanner) {
      const asset = this.readiness.scanner.getApprovedAsset(scannerAssetId);
      this.readiness.scanner.assertComparisonUsable?.(scannerAssetId);
      if (asset.revision !== intent.assetRevision || intent.assetIdentity && JSON.stringify(asset) !== intent.assetIdentity) throw ownError('同币映射已变化，授权审阅已失效');
    }
    return true;
  }
  publicIntent(intent) {
    return { id: intent.id, chain: 'bnb', tokenAddress: intent.tokenAddress, spender: intent.spender, owner: intent.owner,
      amountRaw: intent.amountRaw, requiredRaw: intent.requiredRaw, currentRaw: intent.currentRaw, action: intent.action,
      feeNative: intent.feeNative, feeUsd: intent.feeUsd, gasLimit: intent.gasLimit, gasPrice: intent.gasPrice,
      expiresAt: new Date(intent.expiresAtMs).toISOString(), preparedAt: new Date(intent.createdAtMs).toISOString(),
      reportId: intent.reportId, assetId: intent.assetId || '', parentRevision: intent.parentRevision,
      readOnly: true, realTransaction: true, basis: intent.context?.basis === 'expected-buy-output' ? 'expected-buy-output' : 'exact-stable-input',
      reason: intent.action === 'reset' ? '已有非零但不足的额度；本次仅清零，确认后重新预检，再单独审阅所需额度' : intent.context?.basis === 'expected-buy-output' ? '按当前买入预期到账量预留本笔卖出额度，不发送无限授权；实际到账超出时暂停核对' : '仅批准本笔所需准确数量，不发送无限授权',
      valuation: 'Gas 按配置的 BNB 参考汇率估值；授权支出单独归档，不计为套利盈利' };
  }
  snapshot() {
    const prepared = [];
    for (const [id, intent] of this.intents) {
      try { this.contextCurrent(intent); prepared.push(this.publicIntent(intent)); }
      catch { this.intents.delete(id); }
    }
    return { busy: this.busy, prepared, job: this.job ? clone(this.job) : null, lastError: this.lastError, requiresExplicitConfirmation: true, automatic: false };
  }
  async makeAdapter(config) {
    const args = { getConfig: () => config, vault: this.engine.vault, browserWallets: this.engine.browserWallets, marketFetchImpl: this.engine.marketFetchImpl };
    return this.adapterFactory ? this.adapterFactory(args) : new LiveAdapter(args);
  }
  async verifyPublished(adapter, transaction, hash) {
    const deadline = Date.now() + this.publishedTimeoutMs;
    // Browser broadcasts may need a short propagation delay before this RPC
    // sees their hash. A missing result never causes signing or broadcast again.
    do {
      const published = await adapter.rpc.bnb.call('eth_getTransactionByHash', [hash]);
      if (published) return verifyPublishedEvmTransaction(transaction, published, hash);
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(this.publishedPollMs, Math.max(1, deadline - Date.now()))));
    } while (Date.now() <= deadline);
    throw ownError('RPC 暂未找到已发送的授权交易，请核对已保存哈希，禁止重新发送');
  }
  quoteFor(context) {
    return { kind: 'swap', fromChain: 'bnb', toChain: 'bnb', fromToken: clone(context.fromToken), toToken: clone(context.toToken),
      amountInRaw: context.amountRaw, sender: context.owner, recipient: context.owner };
  }
  checkRequirement(requirement, intent) {
    if (!requirement || requirement.chain !== 'bnb' || !same(requirement.tokenAddress, intent.tokenAddress) || !same(requirement.spender, intent.spender) || !same(requirement.owner, intent.owner) || requirement.requiredRaw !== intent.requiredRaw) throw ownError('授权需求已变化，禁止使用旧的代币、spender 或数量');
    integer(requirement.currentRaw); integer(requirement.requiredRaw, true);
    const sufficient = BigInt(requirement.currentRaw) >= BigInt(requirement.requiredRaw);
    if (requirement.sufficient !== sufficient) throw ownError('授权额度查询不一致');
    return requirement;
  }
  async feeCheck(adapter, intent, { refreshPrice = false } = {}) {
    const config = intent.config, rpc = adapter.rpc?.bnb;
    if (!rpc?.call) throw ownError('BNB RPC 服务未启用');
    const request = { from: intent.owner, to: intent.tokenAddress, data: intent.data, value: '0x0' };
    if (refreshPrice) {
      const [gas, price, codeToken, codeSpender] = await Promise.all([
        rpc.call('eth_estimateGas', [request, 'pending']), rpc.call('eth_gasPrice'),
        rpc.call('eth_getCode', [intent.tokenAddress, 'latest']), rpc.call('eth_getCode', [intent.spender, 'latest']),
      ]);
      if ([codeToken, codeSpender].some(code => typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || /^0x0*$/i.test(code))) throw ownError('授权代币或 spender 没有可验证的链上合约代码');
      const estimated = rawRpc(gas), gasPrice = rawRpc(price);
      if (!estimated || !gasPrice) throw ownError('授权 Gas 估算无效');
      // The margin is frozen into the reviewed transaction and its fee limit.
      intent.gasLimit = ((estimated * 120n + 99n) / 100n).toString(); intent.gasPrice = gasPrice.toString();
    }
    request.gas = hex(intent.gasLimit); request.gasPrice = hex(intent.gasPrice);
    const [balance, estimated, result] = await Promise.all([
      rpc.call('eth_getBalance', [intent.owner, 'pending']), rpc.call('eth_estimateGas', [request, 'pending']), rpc.call('eth_call', [request, 'pending']),
    ]);
    const currentEstimate = rawRpc(estimated);
    if (currentEstimate === 0n) throw ownError('授权 Gas 估算无效，禁止发送');
    if (currentEstimate > BigInt(intent.gasLimit)) throw ownError('授权 Gas 需求已超过审阅上限，请重新准备');
    if (result !== '0x') {
      try { if (!ERC20.decodeFunctionResult('approve', result)[0]) throw Error(); }
      catch { throw ownError('代币授权模拟未返回成功，禁止发送'); }
    }
    const feeWei = BigInt(intent.gasLimit) * BigInt(intent.gasPrice), feeNative = asNative(feeWei);
    if (!finitePositive(config.risk.maxBnbGas) || !finitePositive(config.risk.reserveBnb) || !finitePositive(config.chains.bnb.nativeUsd)) throw ownError('授权费用或 Gas 储备配置不可用');
    if (feeNative.gt(config.risk.maxBnbGas)) throw ownError('有限授权 Gas 超过 BNB 费用上限');
    if (asNative(rawRpc(balance)).minus(feeNative).lt(config.risk.reserveBnb)) throw ownError('BNB 不足以支付授权费用并保留 Gas 储备');
    intent.feeNative = feeNative.toNumber(); intent.feeUsd = feeNative.mul(config.chains.bnb.nativeUsd).toNumber();
    if (!Number.isFinite(intent.feeUsd)) throw ownError('授权费用估值无效');
    return request;
  }
  async prepare({ reportId, index } = {}) {
    this.available();
    if (typeof reportId !== 'string' || !reportId || !Number.isInteger(index) || index < 0 || index > 1) throw ownError('请选择当前预检报告中的授权需求');
    const at = this.now();
    if (this.lastPrepareAt !== null && (at < this.lastPrepareAt || at - this.lastPrepareAt < PREPARE_GAP_MS)) throw ownError('授权准备请求过于频繁或系统时钟回退，请稍候');
    this.lastPrepareAt = at; this.engine.store.setMeta(META, { lastAt: at });
    this.busy = true; this.engine.busy = true; this.lastError = '';
    try {
      const publicRequirement = this.readiness.getReviewableApproval(reportId, index), context = this.readiness.getApprovalContext(reportId, index);
      const owner = address(context.owner ?? publicRequirement.owner), tokenAddress = address(context.fromToken?.address ?? publicRequirement.tokenAddress), spender = address(context.spender ?? publicRequirement.spender);
      const requiredRaw = String(context.amountRaw ?? publicRequirement.requiredRaw);
      if (integer(requiredRaw, true) === LIMIT) throw ownError('有限授权禁止使用无限额度');
      if (!same(owner, publicRequirement.owner) || !same(tokenAddress, publicRequirement.tokenAddress) || !same(spender, publicRequirement.spender) || publicRequirement.requiredRaw !== requiredRaw) throw ownError('预检授权上下文与报告不一致');
      const config = clone(context.config);
      if (config?.mode !== 'live' || config.executionMode !== 'inventory' || !config.chains?.bnb || !config.risk) throw ownError('有限授权仅支持已核验的实盘库存上下文');
      if (!config.chains.bnb.routerAllowlist?.some(value => same(value, spender))) throw ownError('授权 spender 不在已审阅白名单中');
      const intent = { id: randomUUID(), reportId, owner, tokenAddress, spender, requiredRaw, config,
        parentRevision: this.engine.configRevision, parentFingerprint: this.fingerprint(), walletBinding: this.walletBinding(),
        assetId: context.assetId || publicRequirement.assetId || '', assetRevision: context.assetRevision ?? publicRequirement.assetRevision,
        createdAtMs: at, expiresAtMs: at + INTENT_MS, context: { ...clone(context), owner, amountRaw: requiredRaw },
      };
      if (context.contextBinding?.assetId && this.readiness.scanner) intent.assetIdentity = JSON.stringify(this.readiness.scanner.getApprovedAsset(context.contextBinding.assetId));
      this.contextCurrent(intent);
      const adapter = await this.makeAdapter(config), requirement = this.checkRequirement(await adapter.allowanceRequirement(this.quoteFor(intent.context)), intent);
      if (requirement.sufficient) throw ownError('当前授权额度已经足够，无须再次发送授权');
      intent.currentRaw = requirement.currentRaw; intent.action = BigInt(requirement.currentRaw) > 0n ? 'reset' : 'approve';
      intent.amountRaw = intent.action === 'reset' ? '0' : requiredRaw;
      intent.data = ERC20.encodeFunctionData('approve', [spender, intent.amountRaw]);
      await this.feeCheck(adapter, intent, { refreshPrice: true }); this.contextCurrent(intent);
      this.intents.set(intent.id, intent);
      while (this.intents.size > 20) this.intents.delete(this.intents.keys().next().value);
      return this.publicIntent(intent);
    } catch (error) { const failure = fixedError(error); this.lastError = failure.message; throw failure; }
    finally { this.busy = false; this.engine.busy = false; }
  }
  execute({ intentId, expectedMode, confirmed } = {}) {
    this.available();
    if (confirmed !== true || expectedMode !== 'live' || this.engine.config.mode !== 'live') throw ownError('有限授权需要在实盘模式明确确认发送真实交易');
    const intent = this.intents.get(intentId);
    if (!intent) throw ownError('有限授权审阅不存在或已使用，请重新预检');
    this.contextCurrent(intent, { signing: true });
    this.intents.delete(intentId); // consumed before any asynchronous work; never replay
    this.busy = true; this.engine.busy = true; this.lastError = '';
    this.job = { id: randomUUID(), intentId, status: 'preparing', tradeId: null, startedAt: new Date(this.now()).toISOString() };
    const job = this.job;
    this.pending = this.run(intent, job); this.pending.catch(() => {});
    return { accepted: true, jobId: job.id, intentId, mode: 'live' };
  }
  async run(intent, job) {
    const e = this.engine; let trade, adapter, hash;
    try {
      adapter = await this.makeAdapter(intent.config);
      const guard = () => this.contextCurrent(intent, { signing: true, tradeId: trade?.id });
      guard();
      const requirement = this.checkRequirement(await adapter.allowanceRequirement(this.quoteFor(intent.context)), intent);
      if (requirement.sufficient || requirement.currentRaw !== intent.currentRaw) throw ownError('链上授权额度已变化，请重新预检和审阅，未发送新交易');
      const request = await this.feeCheck(adapter, intent); guard();
      const transaction = { ...request, chainId: '0x38' };
      // All persisted fields are public intent/transaction metadata, never signed bytes.
      trade = e.newTrade('approval', { mode: 'live', amountUsd: 0, executionMode: 'approval', assetId: intent.assetId || '',
        approval: this.publicIntent(intent), estimate: { feeUsd: intent.feeUsd, gasUsd: intent.feeUsd, netProfitUsd: -intent.feeUsd } });
      job.tradeId = trade.id; e.activeTradeId = trade.id;
      const quote = { id: intent.id, tradeId: trade.id, leg: 'APPROVAL', kind: 'approval', fromChain: 'bnb', toChain: 'bnb', sender: intent.owner, recipient: intent.owner,
        tokenAddress: intent.tokenAddress, spender: intent.spender, amountRaw: intent.amountRaw, tx: transaction, expiresAt: new Date(intent.expiresAtMs).toISOString(), policyFingerprint: trade.policyFingerprint };
      e.store.saveQuote(quote); e.event(trade, 'APPROVAL_SUBMITTING', { pendingQuoteId: quote.id }); job.status = 'executing';
      const wallet = e.vault.publicStatus().bnb;
      const journal = sentHash => {
        if (!validHash(sentHash)) throw ownError('授权交易未返回有效哈希，须核对钱包');
        hash = sentHash; job.hash = sentHash;
        trade.legs = [{ name: 'APPROVAL', quoteId: quote.id, hash, status: 'SUBMITTED', quote }];
        e.event(trade, 'APPROVAL_SUBMITTED', { legs: trade.legs });
      };
      if (wallet.mode === 'browser') {
        guard();
        const result = await e.browserWallets.request('bnb', { kind: 'evmSend', quoteId: quote.id, expiresAt: quote.expiresAt, payload: { transaction },
          summary: { kind: 'approval', action: intent.action, tokenAddress: intent.tokenAddress, spender: intent.spender, amountRaw: intent.amountRaw, feeNative: intent.feeNative } });
        journal(result?.hash); // immediately record even when later verification fails
      } else {
        const nonce = rawRpc(await adapter.rpc.bnb.call('eth_getTransactionCount', [intent.owner, 'pending']));
        if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw ownError('授权交易 nonce 超出支持范围');
        guard(); const signer = await e.vault.signer('bnb');
        const signerAddress = signer.address || await signer.getAddress?.();
        if (!same(signerAddress, intent.owner)) throw ownError('授权签名钱包与审阅账户不一致');
        guard();
        const signed = await signer.signTransaction({ to: intent.tokenAddress, data: intent.data, value: 0n, chainId: 56, gasLimit: BigInt(intent.gasLimit), gasPrice: BigInt(intent.gasPrice), nonce: Number(nonce) });
        const decoded = Transaction.from(signed);
        if (!same(decoded.from, intent.owner) || !same(decoded.to, intent.tokenAddress) || decoded.data !== intent.data || decoded.value !== 0n || decoded.chainId !== 56n || decoded.gasLimit !== BigInt(intent.gasLimit) || decoded.gasPrice !== BigInt(intent.gasPrice) || decoded.nonce !== Number(nonce)) throw ownError('授权签名内容与审阅意图不一致，未广播');
        hash = keccak256(signed); journal(hash); guard();
        const returned = await adapter.rpc.bnb.call('eth_sendRawTransaction', [signed], { broadcast: true });
        if (!same(returned, hash)) throw ownError('授权 RPC 返回哈希与本地签名不一致，请人工核对');
      }
      await this.verifyPublished(adapter, transaction, hash);
      const confirmed = await adapter.receipt('bnb', hash);
      const receipt = confirmed?.receipt;
      if (!receipt || !same(receipt.transactionHash, hash) || rawRpc(receipt.status) !== 1n || !Number.isFinite(confirmed.feesNative) || confirmed.feesNative < 0) throw ownError('授权确认回执或实际费用不可核验');
      const evidence = receiptEvidence(receipt);
      Object.assign(trade.legs[0], { status: 'RECEIPT_RECEIVED', receipt: { confirmed: true, hash, feesNative: { bnb: confirmed.feesNative, solana: 0 }, feeUsd: new Decimal(confirmed.feesNative).mul(intent.config.chains.bnb.nativeUsd).toNumber(), rentUsd: 0, raw: evidence } });
      e.event(trade, 'APPROVAL_RECEIPT', { legs: trade.legs });
      const post = this.checkRequirement(await adapter.allowanceRequirement(this.quoteFor(intent.context)), intent);
      e.event(trade, 'APPROVAL_ALLOWANCE_RECHECK', { approvalAllowance: { tokenAddress: intent.tokenAddress, spender: intent.spender, owner: intent.owner, action: intent.action, requiredRaw: intent.requiredRaw, currentRaw: post.currentRaw } });
      if (intent.action === 'reset' ? BigInt(post.currentRaw) !== 0n : post.currentRaw !== intent.requiredRaw) throw ownError('授权交易已确认，但实际额度不符合本次准确限额，暂停核对');
      if (confirmed.feesNative > intent.config.risk.maxBnbGas || confirmed.feesNative > intent.feeNative + 1e-15) throw ownError('授权实际费用超过审阅上限，暂停核对');
      trade.legs[0].status = 'CONFIRMED';
      const feeUsd = trade.legs[0].receipt.feeUsd;
      e.event(trade, 'COMPLETED', { legs: trade.legs, actual: { spentUsd: 0, receivedUsd: 0, gasUsd: feeUsd, rentUsd: 0, profitUsd: -feeUsd, approvalCostUsd: feeUsd,
        feesNative: { bnb: confirmed.feesNative, solana: 0 }, allowanceRaw: post.currentRaw, valuation: '授权独立支出；BNB 按配置参考价折算，不是套利盈利' } });
      job.status = 'completed'; job.completedAt = new Date(this.now()).toISOString();
      e.walletChanged?.('bnb');
      return e.store.getTrade(trade.id);
    } catch (error) {
      const failure = fixedError(error); this.lastError = failure.message;
      if (trade) {
        e.running = false; e.pausedReason = '授权交易失败或结果不确定，须人工核对，禁止重发';
        const failureEvidence = { ...(hash ? { hash } : {}), ...(error?.receipt ? { receipt: receiptEvidence(error.receipt) } : {}) };
        e.event(trade, 'NEEDS_REVIEW', { failureReason: failure.message, ...(Object.keys(failureEvidence).length ? { failureEvidence } : {}) });
        job.status = 'needs_review';
      } else job.status = 'blocked';
      job.error = failure.message; throw failure;
    } finally {
      this.busy = false; e.busy = false; e.activeTradeId = null; job.finishedAt = new Date(this.now()).toISOString(); this.pending = null;
    }
  }
}
