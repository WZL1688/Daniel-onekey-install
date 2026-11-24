import { createHash, randomUUID } from 'node:crypto';
import { Engine } from './engine.mjs';
import { LiveAdapter } from './adapters/live.mjs';
import { validateConfig } from './config.mjs';
import { createPolicySnapshot, policyFingerprint, swapIntent, convertInventoryAmount } from './policy.mjs';
import { validAddress, validId, sameAddress } from './opportunities/registry.mjs';

const META = 'live-readiness.budget.v1', INTERVAL_MS = 30000, MIN_REMAINING_MS = 3000;
const CHAINS = ['bnb', 'solana'];
const clone = value => structuredClone(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
const safe = message => Object.assign(new Error(message), { safe: true });
const refuse = () => { throw safe('实盘预检为只读操作，禁止签名、发送交易或修改交易档案'); };
const raw = value => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const positiveRaw = value => raw(value) && BigInt(value) > 0n;

/** Unsigned live checks. Reports are evidence, never an execution authorization. */
export class LiveReadinessService {
  constructor({ engine, scanner, adapterFactory, now = Date.now } = {}) {
    if (!engine) throw new Error('Live readiness requires an engine');
    this.engine = engine; this.scanner = scanner; this.adapterFactory = adapterFactory; this.now = now;
    const saved = engine.store.getMeta(META);
    this.lastAttemptAt = Number.isSafeInteger(saved?.lastAttemptAt) && saved.lastAttemptAt >= 0 ? saved.lastAttemptAt : null;
    this.busy = false; this.pending = null; this.report = null; this.binding = null; this.approvalContexts = [];
  }
  fingerprint() { return policyFingerprint(createPolicySnapshot(this.engine.config)); }
  walletFingerprint() {
    const status = this.engine.vault.publicStatus();
    return createHash('sha256').update(JSON.stringify({
      wallets: CHAINS.map(chain => {
        const wallet = status?.[chain] || {};
        return { chain, address: chain === 'bnb' ? String(wallet.address || '').toLowerCase() : String(wallet.address || ''), mode: wallet.mode || '', canSign: wallet.canSign === true, unlocked: wallet.unlocked === true };
      }), locked: status?.locked !== false, okxConfigured: status?.okxConfigured === true,
    })).digest('hex');
  }
  text(error, fallback = '预检未完成，请检查本机配置、API权限、RPC与链上余额') {
    if (!error?.safe || typeof error.message !== 'string') return fallback;
    let result = error.message;
    try { result = this.engine.vault.redact ? this.engine.vault.redact(result) : result; } catch { return fallback; }
    return String(result).replace(/https?:\/\/[^\s]+/gi, '[远程服务]')
      .replace(/\b(private[_ -]?key|secret[_ -]?key|passphrase|password|api[_ -]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[已隐藏]')
      .replace(/0x[0-9a-f]{64}\b/gi, '[已隐藏]').replace(/[1-9A-HJ-NP-Za-km-z]{64,}/g, '[已隐藏]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
  }
  nextAttemptAt() { return this.lastAttemptAt === null ? this.now() : this.lastAttemptAt + INTERVAL_MS; }
  available() {
    const parent = this.engine;
    if (this.busy || parent.busy || parent.refreshing || parent.configuring || parent.quoteBuilders || this.scanner?.busy || this.scanner?.networkChanging || this.scanner?.networkTesting) throw safe('已有交易、扫描、报价或配置任务进行中，请稍候');
    if (parent.pausedReason || parent.store.allTrades().some(trade => trade.status === 'NEEDS_REVIEW')) throw safe('存在待人工核对交易，请先核对交易档案');
    if (this.lastAttemptAt !== null && this.now() < this.nextAttemptAt()) throw safe(this.now() < this.lastAttemptAt ? '系统时钟回退，实盘预检暂停' : '实盘预检每30秒最多一次，失败也计入间隔');
  }
  asset(assetId) {
    if (assetId === undefined) return null;
    validId(assetId);
    if (!this.scanner) throw safe('同币清单服务未启用');
    this.scanner.assertComparisonUsable?.(assetId);
    const asset = this.scanner.getApprovedAsset(assetId);
    if (!asset || asset.enabled === false || !Number.isSafeInteger(asset.revision) || asset.revision < 1) throw safe('同币映射尚未核验或已停用');
    return asset;
  }
  context(asset) {
    const config = clone(this.engine.config);
    config.mode = 'live'; config.executionMode = 'inventory';
    if (asset) {
      config.inventory = { assetId: asset.id, mappingConfirmed: true, mappingEvidence: asset.mappingEvidence || asset.mapping?.evidence || '', scanApprovedAssets: false };
      for (const chain of CHAINS) config.chains[chain] = { ...config.chains[chain], tokenAddress: asset.chains[chain].address, tokenDecimals: asset.chains[chain].decimals, poolAddress: asset.chains[chain].poolAddress };
    }
    return validateConfig(config);
  }
  assertBinding(binding = this.binding) {
    if (!binding || this.engine.configRevision !== binding.parentRevision || this.fingerprint() !== binding.parentPolicyFingerprint || this.walletFingerprint() !== binding.walletFingerprint) throw safe('钱包、模式或风控参数已变化，请重新预检');
    if (this.engine.pausedReason || this.engine.store.allTrades().some(trade => trade.status === 'NEEDS_REVIEW')) throw safe('存在待人工核对交易，请先核对后重新预检');
    if (binding.assetId) {
      const current = this.asset(binding.assetId);
      if (JSON.stringify(current) !== binding.assetIdentity) throw safe('同币清单地址、精度、交易池或核验状态已变化，请重新预检');
    } else if (this.engine.config.inventory?.assetId) this.scanner?.assertComparisonUsable?.(this.engine.config.inventory.assetId);
  }
  invalidate() {
    if (!this.report || this.report.status === 'stale') return;
    let message = '';
    if (!Number.isFinite(stamp(this.report.checkedAt)) || this.now() < stamp(this.report.checkedAt)) message = '系统时钟回退，预检结果已失效，请重新预检';
    else if (!Number.isFinite(stamp(this.report.expiresAt)) || stamp(this.report.expiresAt) <= this.now()) message = '预检所用报价已过期，请重新预检';
    try { this.assertBinding(); } catch (error) { message = this.text(error); }
    if (message) {
      this.report = { ...this.report, readyForLive: false, status: 'stale', checks: [...this.report.checks, { id: 'context-stale', label: '预检有效性', status: 'blocked', message }] };
      this.approvalContexts = [];
    }
  }
  snapshot() {
    this.invalidate();
    return { busy: this.busy, readOnly: true, executable: false, lastAttemptAt: this.lastAttemptAt, nextAttemptAt: this.nextAttemptAt(), budgetIntervalMs: INTERVAL_MS, report: this.report ? clone(this.report) : null };
  }
  getReviewableApproval(reportId, index) {
    this.invalidate();
    if (!this.report || this.report.id !== reportId || this.report.status === 'stale' || !Number.isSafeInteger(index) || index < 0 || !this.report.approvals[index]) throw safe('授权审阅依据已失效，请重新预检');
    this.assertBinding();
    return { ...clone(this.report.approvals[index]), reportId, parentRevision: this.report.parentRevision, parentPolicyFingerprint: this.report.parentPolicyFingerprint,
      assetId: this.report.assetId, ...(this.report.assetRevision ? { assetRevision: this.report.assetRevision } : {}), expiresAt: this.report.expiresAt };
  }
  getApprovalContext(reportId, index) {
    const approval = this.getReviewableApproval(reportId, index), context = this.approvalContexts[index];
    if (!context) throw safe('授权上下文缺失，请重新预检');
    return { ...approval, ...clone(context), contextBinding: clone(this.binding) };
  }
  assertApprovalContextCurrent(context) {
    if (!context?.contextBinding) throw safe('授权审阅上下文缺失，请重新预检');
    this.assertBinding(context.contextBinding);
    return true;
  }
  storeFacade() {
    const store = this.engine.store;
    return Object.freeze({ get config() { return clone(store.config); }, stats: () => clone(store.stats('live')), allTrades: () => clone(store.allTrades()), getReservedInventory: input => store.getReservedInventory(input),
      saveTrade: refuse, saveQuote: refuse, appendEvent: refuse, reserveExecution: refuse, reserveInventory: refuse, setConfig: refuse, setMeta: refuse });
  }
  vaultFacade() {
    const vault = this.engine.vault;
    return Object.freeze({ publicStatus: () => clone(vault.publicStatus()), getOkxCredentials: () => vault.getOkxCredentials(), redact: text => this.text(Object.assign(new Error(text), { safe: true })), signer: refuse, getPrivateKey: refuse });
  }
  async check({ assetId } = {}) {
    this.available();
    const asset = this.asset(assetId), parent = this.engine, started = this.now();
    this.lastAttemptAt = started; parent.store.setMeta(META, { lastAttemptAt: started });
    this.busy = true; parent.busy = true; this.approvalContexts = [];
    const binding = { parentRevision: parent.configRevision, parentPolicyFingerprint: this.fingerprint(), walletFingerprint: this.walletFingerprint(), assetId: asset?.id || null, assetIdentity: asset ? JSON.stringify(asset) : null };
    this.binding = binding;
    const checks = [], add = (id, label, status, message) => checks.push({ id, label, status, message });
    const report = { id: randomUUID(), readOnly: true, executable: false, mode: 'live', parentMode: parent.config.mode, parentRevision: binding.parentRevision, parentPolicyFingerprint: binding.parentPolicyFingerprint,
      executionMode: 'inventory', assetId: asset?.id || parent.config.inventory?.assetId || '', ...(asset ? { assetRevision: asset.revision } : {}), checkedAt: new Date(started).toISOString(),
      expiresAt: new Date(started + INTERVAL_MS).toISOString(), readyForLive: false, status: 'blocked', checks, approvals: [], opportunity: null, simulationVerified: false,
      noGuarantee: '预检和未签名模拟不能保证成交或盈利；双链非原子，库存价差未计未来补库成本，美元估值仍采用稳定币面值及配置参考汇率。' };
    const quotes = [], simulationChecks = [];
    let worker, instance, config;
    const guard = () => this.assertBinding(binding);
    const finish = () => {
      report.readyForLive = checks.every(check => check.status !== 'blocked') && report.simulationVerified === true && parent.config.mode === 'live' && parent.config.executionMode === 'inventory';
      report.status = report.readyForLive ? 'ready' : 'blocked';
      this.report = clone(report); return clone(report);
    };
    const run = async () => {
      try {
        try { config = this.context(asset); } catch (error) { add('configuration', '币对与风控配置', 'blocked', this.text(error, '配置不完整，请核对两链地址、精度、池及风控后保存')); return finish(); }
        let configured = true;
        for (const chain of CHAINS) {
          try { validAddress(chain, config.chains[chain].tokenAddress); validAddress(chain, config.chains[chain].poolAddress); validAddress(chain, config.chains[chain].stableAddress); }
          catch { configured = false; }
        }
        if (!config.inventory.mappingConfirmed || !config.inventory.assetId || !config.inventory.mappingEvidence?.trim()) configured = false;
        add('configuration', '两链1:1同币映射、精度与交易池', configured ? 'passed' : 'blocked', configured ? '已保存映射核验；链上精度和路线仍须以下真实检查' : '请先配置两链地址、精度、池，并保存1:1同币核验依据');
        add('execution-mode', '实盘执行方式', parent.config.executionMode === 'inventory' ? 'passed' : 'blocked', parent.config.executionMode === 'inventory' ? '当前为双侧库存模式，本轮不跨链' : '本预检仅覆盖双侧库存；请先选择库存模式，未验证跨链执行');
        add('run-mode', '运行模式', parent.config.mode === 'live' ? 'passed' : 'blocked', parent.config.mode === 'live' ? '当前为实盘模式，预检本身仍不签名或发送交易' : '当前为模拟模式；以下预检可读取真实链上数据，切换实盘后须重新检查');
        const status = parent.vault.publicStatus();
        let publicAddresses = true;
        for (const chain of CHAINS) {
          const wallet = status?.[chain]; let valid = true;
          try { validAddress(chain, wallet?.address); } catch { valid = false; publicAddresses = false; }
          add(`wallet-address-${chain}`, `${chain}公开钱包地址`, valid ? 'passed' : 'blocked', valid ? '公开地址可用于未签名模拟' : '尚未配置有效公开地址');
          const signer = ['private', 'browser'].includes(wallet?.mode) && wallet?.unlocked === true && wallet?.canSign === true;
          add(`wallet-signing-${chain}`, `${chain}签名状态`, signer ? 'passed' : 'blocked', signer ? '签名方式已连接／解锁；本预检不会请求签名' : '只读地址或签名钱包未连接／未解锁，可继续只读检查但不能实盘发送');
        }
        const okx = status?.okxConfigured === true && status?.locked === false;
        add('okx', 'OKX API凭据', okx ? 'passed' : 'blocked', okx ? '本机凭据已解锁，实际权限将由报价请求验证' : '请在本机配置并解锁自己的OKX API凭据');
        if (!configured || !publicAddresses || !okx) return finish();
        guard();
        const adapterFactory = async args => {
          instance = await (this.adapterFactory ? this.adapterFactory(args) : new LiveAdapter(args));
          return Object.freeze({ market: (...input) => instance.market(...input), balances: (...input) => instance.balances(...input),
            quoteSwap: async input => {
              const quote = await instance.quoteSwap({ ...input, allowUnapproved: true });
              // Only a quote matching the requested token pair, sender, amount
              // and minimum-output policy may become an approval review source.
              worker.validateIntent(quote, swapIntent(input.chain, input.fromToken, input.toToken, input.amountRaw));
              quotes.push(clone(quote)); return quote;
            },
            preflightSwap: quote => instance.preflightSwap(quote), quoteTokenBridge: refuse, submit: refuse, confirm: refuse });
        };
        worker = new Engine({ store: this.storeFacade(), vault: this.vaultFacade(), browserWallets: Object.freeze({ request: refuse }), verificationOnly: true, adapterFactory, marketFetchImpl: parent.marketFetchImpl });
        worker.config = config; worker.executionGuard = guard;
        await worker.makeAdapter(); await worker.loadMarketBalances(); guard();
        for (const chain of CHAINS) {
          const balance = worker.balances[chain], market = worker.market[chain];
          const balances = finite(balance?.stableUsd) && finite(balance?.nativeBalance) && raw(balance?.tokenRaw);
          add(`rpc-balances-${chain}`, `${chain}主网RPC与余额`, balances ? 'passed' : 'blocked', balances ? '主网身份校验及链上余额读取成功' : '主网RPC或余额读取未通过，请核对连接和代币配置');
          add(`market-${chain}`, `${chain}交易池行情`, market?.connected === true ? 'passed' : 'blocked', market?.connected === true ? '已读取配置池的真实参考行情，执行仍以聚合报价为准' : '配置池行情读取失败，不能据此构造执行计划');
        }
        await worker.buildOpportunity(); guard();
        const opportunity = worker.opportunity || {};
        report.opportunity = {};
        for (const key of ['amountUsd', 'netProfitUsd', 'stressNetProfitUsd', 'gasUsd', 'slippageUsd', 'priceImpactBps', 'estimatedRentUsd']) if (finite(opportunity[key])) report.opportunity[key] = opportunity[key];
        for (const key of ['buyChain', 'sellChain']) if (CHAINS.includes(opportunity[key])) report.opportunity[key] = opportunity[key];
        const quoteExpiry = Math.min(...quotes.map(quote => stamp(quote.expiresAt)));
        if (quotes.length && Number.isFinite(quoteExpiry)) report.expiresAt = new Date(quoteExpiry).toISOString();
        const reasons = Array.isArray(opportunity.reasons) ? opportunity.reasons.map(message => this.text(Object.assign(new Error(message), { safe: true }))).filter(Boolean) : [];
        add('quotes-risk', '双边报价、库存、费用与压力门槛', opportunity.qualityPassed === true && quotes.length === 2 ? 'passed' : 'blocked', opportunity.qualityPassed === true && quotes.length === 2 ? '双腿最低到账、库存、费用与压力场景达到现有门槛' : reasons.join('；') || '未取得完整双腿真实报价和风控结果');
        for (const quote of quotes) {
          if (quote.fromChain !== 'bnb') continue;
          const side = quote.fromToken?.kind === 'stable' ? 'BUY' : 'SELL';
          let approval;
          try {
            const validateRequirement = (requirement, amountRaw, routeSpender) => {
              if (!requirement || requirement.chain !== 'bnb' || !raw(requirement.currentRaw) || !positiveRaw(requirement.requiredRaw) || !sameAddress('bnb', requirement.tokenAddress, quote.fromToken.address) || !sameAddress('bnb', requirement.owner, quote.sender) || requirement.requiredRaw !== amountRaw) throw safe('BNB授权信息不完整或与交易意图不一致');
              const spender = validAddress('bnb', requirement.spender);
              if (/^0x0{40}$/i.test(spender)) throw safe('BNB授权目标无效');
              if (!config.chains.bnb.routerAllowlist.some(address => sameAddress('bnb', address, spender))) throw safe('BNB授权目标不在已保存白名单');
              if (routeSpender && !sameAddress('bnb', spender, routeSpender)) throw safe('预期卖出预留量的授权目标与原真实路线不一致，请重新核验');
              const sufficient = BigInt(requirement.currentRaw) >= BigInt(requirement.requiredRaw);
              if (requirement.sufficient !== sufficient) throw safe('BNB授权额度信息不一致');
              return { ...requirement, spender, sufficient };
            };
            let requirement = validateRequirement(quote.approvalRequirement, quote.amountInRaw);
            let basis = 'exact-input';
            if (side === 'SELL') {
              const plan = worker.plan, reserveRaw = plan?.inventoryReserveRaw;
              if (!plan?.buy || plan.sell?.id !== quote.id || !positiveRaw(reserveRaw) || BigInt(reserveRaw) < BigInt(quote.amountInRaw)) throw safe('缺少可核验的当前预期买入到账预留量，不能准备卖出授权');
              const expected = convertInventoryAmount(plan.buy.amountOutRaw, plan.buy.toToken.decimals, quote.fromToken.decimals, 'bnb').amountRaw;
              if (reserveRaw !== expected) throw safe('预期买入到账与卖出预留数量不一致，不能准备授权');
              if (typeof instance.allowanceRequirement !== 'function') throw safe('适配器缺少预期卖出预留量授权查询，不能确认授权就绪');
              const allowanceQuote = { ...clone(quote), amountInRaw: reserveRaw };
              delete allowanceQuote.approvalRequirement;
              guard();
              const reservedRequirement = await instance.allowanceRequirement(allowanceQuote);
              guard();
              requirement = validateRequirement(reservedRequirement, reserveRaw, requirement.spender);
              basis = 'expected-buy-output';
            }
            const { spender, sufficient } = requirement;
            const message = basis === 'expected-buy-output'
              ? '按当前买入预期到账换算的卖出数量预留；实际有利成交更多时仍可能暂停核对，不授权全部钱包库存'
              : '仅核对本笔准确输入数量，不使用无限授权';
            approval = { chain: 'bnb', tokenAddress: validAddress('bnb', requirement.tokenAddress), spender, owner: validAddress('bnb', requirement.owner), requiredRaw: requirement.requiredRaw, currentRaw: requirement.currentRaw, side, basis, message };
            add(`approval-${side}`, `BNB ${side === 'BUY' ? '买入' : '卖出'}授权额度`, sufficient ? 'passed' : 'blocked', sufficient ? `当前链上授权足够本笔有限额度；${message}` : `approval_required：须先审阅代币、spender和本笔有限额度；${message}；本预检不会发送授权`);
            if (!sufficient) {
              report.approvals.push(approval);
              this.approvalContexts.push({ config: clone(config), fromToken: clone(quote.fromToken), toToken: clone(quote.toToken), amountRaw: requirement.requiredRaw, owner: approval.owner, spender: approval.spender, quoteId: quote.id, basis, message });
            }
          } catch (error) { add(`approval-${side}`, 'BNB授权额度', 'blocked', this.text(error)); }
        }
        if (!quotes.some(quote => quote.fromChain === 'bnb')) add('approval-missing', 'BNB授权额度', 'blocked', '尚未取得BNB路线，无法核验授权');
        const results = await Promise.allSettled(quotes.map(async quote => {
          guard();
          if (typeof instance.preflightSwap !== 'function') throw safe('当前适配器缺少未签名成交模拟，请更新程序');
          const result = await instance.preflightSwap(quote); guard();
          const checkedAt = stamp(result?.checkedAt), expiresAt = stamp(result?.expiresAt), at = this.now();
          if (result?.verified !== true || result.readOnly !== true || result.chain !== quote.fromChain || result.quoteId !== quote.id ||
              !Number.isFinite(checkedAt) || checkedAt < started || checkedAt > at + 1000 || !Number.isFinite(expiresAt) ||
              expiresAt <= at || expiresAt > stamp(quote.expiresAt)) throw safe('未签名模拟缺少准确交易及有效期证据');
          return result;
        }));
        for (let i = 0; i < results.length; i++) {
          const result = results[i], quote = quotes[i], side = quote.fromToken?.kind === 'stable' ? 'BUY' : 'SELL';
          const verified = result.status === 'fulfilled'; simulationChecks.push(verified);
          add(`simulation-${side}`, `${quote.fromChain} ${side === 'BUY' ? '买入' : '卖出'}未签名模拟`, verified ? 'passed' : 'blocked', verified ? 'RPC未签名执行检查通过；不是已广播交易或未来成交保证' : this.text(result.reason, '未签名模拟失败或RPC不支持，请核对库存、授权、费用和代币限制'));
          if (verified && quote.fromChain === 'bnb' && result.value.outputVerified === false) add(`simulation-output-${side}`, 'BNB模拟输出证据范围', 'warning', '路由调用模拟通过，已核对交易内最低到账参数；该方法不返回可核验输出，尚无直接的模拟输出余额证据');
        }
        report.simulationVerified = quotes.length === 2 && simulationChecks.length === 2 && simulationChecks.every(Boolean);
        add('solana-instruction-semantics', 'Solana路由指令证据范围', 'warning', '当前核验官方路由白名单与RPC模拟中的实际代币变动，尚未独立解析新路由程序的链上最小到账字段；模拟通过不保证稍后成交');
        if (quotes.length !== 2) add('simulation-incomplete', '双边未签名模拟', 'blocked', '双边模拟不完整，禁止将单侧检查当作实盘就绪');
        guard();
        if (stamp(report.expiresAt) - this.now() < MIN_REMAINING_MS) add('quote-freshness', '整套报价有效期', 'blocked', '完整计划剩余有效期不足3秒，请重新预检');
        else add('quote-freshness', '整套报价有效期', 'passed', '完整计划至少保留3秒有效期，提交前仍会重新检查');
        return finish();
      } catch (error) {
        add('precheck-error', '预检结果', 'blocked', this.text(error)); return finish();
      } finally { worker?.stop(); this.busy = false; parent.busy = false; this.pending = null; }
    };
    this.pending = run(); return this.pending;
  }
}
