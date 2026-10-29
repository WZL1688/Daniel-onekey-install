import crypto from 'node:crypto';
import { D, decimal, evaluate, pair } from './math.js';
export const LIVE_CONFIRM = '确认开启实盘并理解双腿风险';
export const LOSS_CONFIRM = '确认允许动态平衡亏损';
export const RESOLVE_CONFIRM = '已在交易所核对两腿及库存';
export function validateConfig(input, previous, confirmation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('设置格式错误');
  const allowed = ['exchanges', 'pairs', 'amount', 'fallbackAmounts', 'fees', 'feeConfirmed', 'buffer', 'minProfit', 'minDepthProfit',
    'maxBookAgeMs', 'maxBalanceAgeMs', 'slotMs', 'balanceRefreshMs', 'budgets', 'unknownAction', 'scannerAuto', 'scanQuote', 'balance'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw Error('设置包含未允许的字段；实盘必须单独确认');
  const next = structuredClone({ ...previous, ...input });
  if (!Array.isArray(next.exchanges) || next.exchanges.length !== 2 || new Set(next.exchanges).size !== 2 || next.exchanges.some(x => !['binance', 'okx'].includes(x))) throw Error('请选择 Binance 和 OKX 两个不同现货交易所');
  if (!Array.isArray(next.pairs) || next.pairs.length < 1 || next.pairs.length > 30 || new Set(next.pairs).size !== next.pairs.length) throw Error('关注交易对数量应为 1–30 且不可重复');
  next.pairs.forEach(pair);
  decimal(next.amount, '默认金额');
  if (!Array.isArray(next.fallbackAmounts) || next.fallbackAmounts.length > 10) throw Error('备用金额格式错误');
  next.fallbackAmounts.forEach(x => { if (decimal(x, '备用金额').gt(next.amount)) throw Error('备用金额不得大于默认金额'); });
  for (const x of ['buffer', 'minProfit', 'minDepthProfit']) decimal(next[x], x, { zero: true });
  for (const ex of ['binance', 'okx']) {
    if (decimal(next.fees?.[ex], '手续费', { zero: true }).gt('0.05')) throw Error('费率必须在 0–0.05 之间');
    if (!Number.isInteger(next.budgets?.[ex]) || next.budgets[ex] < 100 || next.budgets[ex] > (ex === 'binance' ? 1200 : 240)) throw Error('API 额度超出保守硬上限：Binance 100–1200 权重/分钟，OKX 100–240 请求/分钟');
  }
  for (const [k, min, max] of [['maxBookAgeMs', 500, 30000], ['maxBalanceAgeMs', 1000, 60000], ['slotMs', 1000, 60000], ['balanceRefreshMs', 30000, 3600000]]) {
    if (!Number.isInteger(next[k]) || next[k] < min || next[k] > max) throw Error(`${k} 应在 ${min}–${max} 毫秒之间`);
  }
  if (!['pause', 'archive'].includes(next.unknownAction) || typeof next.scannerAuto !== 'boolean' || typeof next.feeConfirmed !== 'boolean' || !/^[A-Z0-9]{2,15}$/.test(next.scanQuote)) throw Error('设置值错误');
  if (!next.balance || typeof next.balance !== 'object' || Array.isArray(next.balance) || Object.keys(next.balance).length > 30) throw Error('平衡配置格式错误');
  for (const [id, cfg] of Object.entries(next.balance)) {
    pair(id);
    if (!next.pairs.includes(id)) throw Error('动态平衡交易对必须先加入关注列表');
    if (!cfg || typeof cfg.enabled !== 'boolean') throw Error('平衡开关格式错误');
    decimal(cfg.amount, '平衡金额'); decimal(cfg.stopDifference, '停止库存差额', { zero: true });
    const loss = decimal(cfg.maxLoss, '最大亏损', { zero: true });
    if (loss.gt(cfg.amount)) throw Error('每笔最大亏损不得超过交易金额');
    if (loss.gt(0) && !loss.eq(previous.balance?.[id]?.maxLoss || 0) && confirmation !== LOSS_CONFIRM) throw Error('设置正数最大亏损必须再次确认');
  }
  return next;
}
export class Engine {
  constructor(store, exchanges, { docsVerified = { binance: true, okx: false } } = {}) {
    this.store = store; this.exchanges = exchanges; this.docsVerified = docsVerified;
    this.busy = false; this.polling = false; this.balanceBusy = false; this.scanBusy = false;
    this.pendingValidations = new Set(); this.running = false; this.scanRequested = false;
  }
  start() { this.running = true; this.timer = setInterval(() => this.tick().catch(e => this.store.error('engine', e.message)), 250); this.timer.unref(); this.tick().catch(e => this.store.error('engine', e.message)); }
  stop() { this.running = false; clearInterval(this.timer); this.store.state.config.autoTrading = false; this.store.save(); }
  updateConfig(input, confirmation) {
    if (this.busy || this.store.state.config.autoTrading) throw Error('请先停止实盘并等待正在执行的批次完成后修改设置');
    const next = validateConfig(input, this.store.state.config, confirmation);
    this.store.state.config = next; this.store.event('已更新设置'); return next;
  }
  unresolved() { return this.store.state.batches.filter(x => !['REJECTED', 'RESOLVED'].includes(x.status)); }
  liveReasons() {
    const state = this.store.state, reasons = [];
    if (!state.config.feeConfirmed) reasons.push('请按两所账户实际 taker 费率设置手续费并确认');
    for (const ex of state.config.exchanges) {
      if (!this.docsVerified[ex]) reasons.push(`${ex} 官方 API 文档核对尚未完成，实盘接入锁定`);
      if (!state.accounts[ex]) reasons.push(`${ex} 尚未验证查询 Key 的账户 UID`);
      if (!state.keys.some(k => k.exchange === ex && k.role === 'query' && k.enabled && k.status === 'VERIFIED')) reasons.push(`${ex} 无已验证查询 Key`);
      try { this.exchanges.chooseTrade(ex); } catch (e) { reasons.push(e.message); }
      if (!state.exchangeMeta[ex]?.rulesAt || Date.now() - state.exchangeMeta[ex].rulesAt > 3600000) reasons.push(`${ex} 现货规则尚未成功加载或已过期`);
      if (!state.balances[ex]?.valid) reasons.push(state.balances[ex]?.error || `${ex} 无有效余额`);
    }
    if (this.unresolved().length) reasons.push('存在未核对批次，必须先核对两腿与库存');
    return reasons;
  }
  setLive(enabled, confirm) {
    if (enabled) {
      if (confirm !== LIVE_CONFIRM) throw Error('开启实盘必须输入完整确认文字');
      const reasons = this.liveReasons(); if (reasons.length) throw Error(reasons.join('；'));
    }
    this.store.state.config.autoTrading = Boolean(enabled); this.store.event(enabled ? '实盘已开启：存在两腿不同时成交的风险' : '实盘已停止');
  }
  slotMs() {
    const c = this.store.state.config;
    return Math.max(c.slotMs, Math.ceil(60000 * 5 / Math.max(1, c.budgets.binance - 50)), Math.ceil(60000 / Math.max(1, c.budgets.okx - 8)));
  }
  async tick() {
    if (!this.running) return;
    const state = this.store.state, now = Date.now();
    if (!this.polling && !this.busy && now - state.engine.lastPollAt >= this.slotMs()) {
      this.polling = true; state.engine.lastPollAt = now;
      const index = state.engine.cursor % state.config.pairs.length, id = state.config.pairs[index];
      state.engine.cursor = (index + 1) % state.config.pairs.length;
      if (index === 0) { if (state.engine.lastCycleAt) state.engine.cycleMs = now - state.engine.lastCycleAt; state.engine.lastCycleAt = now; }
      state.engine.polls++; this.store.save();
      this.poll(id).catch(e => this.store.error(id, e.message)).finally(() => { this.polling = false; });
    }
    if (!this.busy && !this.balanceBusy && now - state.engine.lastBalanceAt >= state.config.balanceRefreshMs) {
      state.engine.lastBalanceAt = now; this.balanceBusy = true;
      Promise.allSettled(state.config.exchanges.filter(ex => state.keys.some(k => k.exchange === ex && k.role === 'query' && k.status === 'VERIFIED' && k.enabled)).map(ex => this.exchanges.balances(ex, 3)))
        .then(results => { for (const r of results) if (r.status === 'rejected') this.store.error('balance', r.reason.message); })
        .finally(() => { this.balanceBusy = false; });
    }
    if (!state.config.autoTrading && !this.busy && !this.polling && !this.scanBusy && (this.scanRequested || state.config.scannerAuto) && now - (this.lastScanAt || 0) >= 10000) {
      this.lastScanAt = now; this.scanBusy = true; this.scanOne().catch(e => this.store.error('scanner', e.message)).finally(() => { this.scanBusy = false; });
    }
  }
  async poll(id) {
    const state = this.store.state, exchanges = state.config.exchanges;
    const results = await Promise.allSettled(exchanges.map(async ex => { await this.exchanges.rules(ex); return this.exchanges.book(ex, id); }));
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    if (errors.length) {
      const old = state.opportunities[id] ||= { pair: id, directions: [] }; old.error = errors.join('；'); old.failedAt = Date.now(); this.store.save(); return;
    }
    const directions = exchanges.map((buyExchange, index) => {
      const sellExchange = exchanges[1 - index];
      return evaluate({ buy: state.books[buyExchange][id], sell: state.books[sellExchange][id], buyRule: state.rules[buyExchange][id], sellRule: state.rules[sellExchange][id], buyExchange, sellExchange, settings: state.config });
    });
    state.opportunities[id] = { pair: id, at: Date.now(), directions }; this.store.save();
    if (state.config.autoTrading && !this.busy && !this.unresolved().length) {
      const opportunity = directions.filter(x => x.eligible).sort((a, b) => D(b.conservative).cmp(a.conservative))[0];
      if (opportunity) { await this.submit(id, opportunity.buyExchange, 'arbitrage'); return; }
      const balanceConfig = state.config.balance[id];
      if (balanceConfig?.enabled) {
        const direction = this.balanceDirection(id);
        if (direction.eligible) await this.submit(id, direction.buyExchange, 'balance');
      }
    }
  }
  balanceDirection(id) {
    try {
      const state = this.store.state, cfg = state.config.balance[id];
      if (!cfg?.enabled) throw Error('该资产动态平衡已暂停');
      const { base } = pair(id), [a, b] = state.config.exchanges;
      for (const ex of [a, b]) if (!state.balances[ex]?.valid || Date.now() - state.balances[ex].at > state.config.maxBalanceAgeMs) throw Error(`${ex} 余额过期或更新失败`);
      const av = D(state.balances[a].assets[base]?.total || 0), bv = D(state.balances[b].assets[base]?.total || 0), diff = av.minus(bv);
      if (diff.abs().lte(cfg.stopDifference)) throw Error(`库存差额 ${diff.abs()} / 停止差额 ${cfg.stopDifference}`);
      const buyExchange = diff.gt(0) ? b : a, sellExchange = diff.gt(0) ? a : b;
      const maxQty = diff.abs().minus(cfg.stopDifference).div(2);
      const result = evaluate({ buy: state.books[buyExchange]?.[id], sell: state.books[sellExchange]?.[id], buyRule: state.rules[buyExchange]?.[id], sellRule: state.rules[sellExchange]?.[id], buyExchange, sellExchange, settings: state.config, mode: 'balance', balanceConfig: cfg, maxQty });
      return { ...result, difference: diff.abs().toString(), maxQty: maxQty.toString() };
    } catch (e) { return { pair: id, eligible: false, reasons: [e.message] }; }
  }
  assertBalances(opportunity) {
    const state = this.store.state, { base, quote } = pair(opportunity.pair);
    for (const ex of [opportunity.buyExchange, opportunity.sellExchange]) {
      const balance = state.balances[ex];
      if (!balance?.valid || Date.now() - balance.at > state.config.maxBalanceAgeMs) throw Error(`${ex} 余额已失效，暂停该路径`);
    }
    const buyer = state.balances[opportunity.buyExchange].assets, seller = state.balances[opportunity.sellExchange].assets;
    if (D(buyer[quote]?.free || 0).lt(opportunity.buyWorstCost)) throw Error(`买侧 ${quote} 可用余额 ${buyer[quote]?.free || 0} / 所需 ${opportunity.buyWorstCost}`);
    if (D(seller[base]?.free || 0).lt(opportunity.sellBaseRequired)) throw Error(`卖侧 ${base} 可用库存 ${seller[base]?.free || 0} / 所需 ${opportunity.sellBaseRequired}`);
  }
  async preflight(id, buyExchange, mode) {
    const state = this.store.state, [a, b] = state.config.exchanges;
    if (![a, b].includes(buyExchange)) throw Error('买侧交易所错误');
    await Promise.all([a, b].map(ex => this.exchanges.rules(ex, 0, true)));
    await Promise.all([a, b].map(ex => this.exchanges.balances(ex, 0)));
    await Promise.all([a, b].map(ex => this.exchanges.assertNoOpenOrders(ex, id)));
    const contexts = Object.fromEntries(await Promise.all([a, b].map(async ex => [ex, await this.exchanges.priceContext(ex, id)])));
    // Full fresh depth is acquired AFTER rules and balances, never from the browser.
    await Promise.all([a, b].map(ex => this.exchanges.book(ex, id, 0)));
    let opportunity;
    if (mode === 'balance') {
      opportunity = this.balanceDirection(id);
      if (opportunity.buyExchange !== buyExchange) throw Error('最新库存平衡方向已变化，取消本批次');
    } else {
      const sellExchange = buyExchange === a ? b : a;
      opportunity = evaluate({ buy: state.books[buyExchange][id], sell: state.books[sellExchange][id], buyRule: state.rules[buyExchange][id], sellRule: state.rules[sellExchange][id], buyExchange, sellExchange, settings: state.config });
    }
    if (!opportunity.eligible) throw Error(opportunity.reasons.join('；'));
    this.assertBalances(opportunity);
    this.exchanges.assertPriceContext(opportunity.buyExchange, id, 'BUY', opportunity.qty, opportunity.buyLimit, contexts[opportunity.buyExchange]);
    this.exchanges.assertPriceContext(opportunity.sellExchange, id, 'SELL', opportunity.qty, opportunity.sellLimit, contexts[opportunity.sellExchange]);
    opportunity.priceContexts = contexts;
    return opportunity;
  }
  async submit(id, buyExchange, mode = 'arbitrage') {
    pair(id);
    const state = this.store.state;
    if (!state.config.pairs.includes(id) || !['arbitrage', 'balance'].includes(mode)) throw Error('未关注的交易对或交易模式错误');
    if (!state.config.autoTrading) throw Error('实盘开关关闭，拒绝下单');
    if (this.busy || this.unresolved().length || Object.keys(state.blocks).length) throw Error('存在未处理订单、异常阻塞或执行中的批次');
    const reasons = this.liveReasons(); if (reasons.length) throw Error(reasons.join('；'));
    this.busy = true;
    const batch = { id: crypto.randomUUID(), pair: id, mode, at: Date.now(), status: 'PREPARING', legs: [], expectedNet: null, realizedNet: null };
    state.batches.unshift(batch); state.blocks[id] = `正在处理批次 ${batch.id}`; this.store.save();
    try {
      const opportunity = await this.preflight(id, buyExchange, mode);
      if (!state.config.autoTrading) throw Error('复核期间已停止实盘');
      batch.opportunity = opportunity; batch.expectedNet = opportunity.net;
      const legs = [
        { exchange: opportunity.buyExchange, side: 'BUY', price: opportunity.buyLimit },
        { exchange: opportunity.sellExchange, side: 'SELL', price: opportunity.sellLimit },
      ];
      for (const intent of legs) {
        if (!state.config.autoTrading) throw Error('两腿提交期间已停止实盘，后续腿未发送');
        if (Date.now() - opportunity.sampleAt > state.config.maxBookAgeMs) throw Error('最终复核盘口已过期，后续腿未发送');
        this.assertBalances(opportunity);
        const leg = { ...intent, qty: opportunity.qty, clientId: 'sa' + crypto.randomBytes(14).toString('hex'), status: 'SENDING', at: Date.now() };
        batch.legs.push(leg); batch.status = 'SUBMITTING'; this.store.save();
        try {
          const ack = await this.exchanges.order(leg.exchange, { pair: id, ...leg, guard: () => {
            if (!state.config.autoTrading) throw Error('排队期间已停止实盘，订单未发送');
            if (Date.now() - opportunity.sampleAt > state.config.maxBookAgeMs) throw Error('排队期间最终复核盘口已过期，订单未发送');
            this.assertBalances(opportunity);
            this.exchanges.assertPriceContext(leg.exchange, id, leg.side, leg.qty, leg.price, opportunity.priceContexts[leg.exchange]);
          } });
          Object.assign(leg, ack); this.store.save(); // Persist first ACK before second request.
        } catch (e) {
          leg.status = e.unknown === false ? 'REJECTED' : 'UNKNOWN'; leg.error = e.message;
          batch.status = leg.status === 'UNKNOWN' ? 'UNKNOWN' : batch.legs.length === 1 ? 'REJECTED' : 'INCOMPLETE';
          throw e;
        }
      }
      batch.status = 'SUBMITTED'; batch.note = '两腿已受理；未查询成交状态，不代表成交或已锁定收益';
      state.blocks[id] = `批次 ${batch.id} 已提交，等待人工核对成交及库存`;
      this.store.event(`批次 ${batch.id} 两腿已受理，成交未确认`);
    } catch (e) {
      if (batch.legs.length === 0) batch.status = 'REJECTED';
      else if (batch.status === 'SUBMITTING') batch.status = 'INCOMPLETE';
      batch.error = e.message;
      if (batch.status === 'REJECTED') delete state.blocks[id];
      else state.blocks[id] = `批次 ${batch.id} ${batch.status}：${e.message}`;
      if (state.config.unknownAction === 'archive') batch.archived = true;
      state.config.autoTrading = false;
      this.store.error(id, `批次 ${batch.id}：${e.message}；无自动重发、无自动补单`);
    } finally { this.busy = false; this.store.save(); }
    return batch;
  }
  resolve(id, data) {
    if (this.busy || this.store.state.config.autoTrading) throw Error('核对前必须停止实盘');
    const batch = this.store.state.batches.find(x => x.id === id);
    if (!batch || ['RESOLVED', 'REJECTED'].includes(batch.status)) throw Error('没有待核对批次');
    if (data.confirm !== RESOLVE_CONFIRM || typeof data.reference !== 'string' || data.reference.length < 8 || data.reference.length > 500) throw Error('必须确认已在交易所核对两腿和库存，并填写核对依据');
    if (!Array.isArray(data.legs) || data.legs.length !== batch.legs.length) throw Error('必须逐腿填写交易所核对结果');
    for (let i = 0; i < data.legs.length; i++) {
      const leg = data.legs[i];
      if (!['FILLED', 'PARTIAL_CLOSED', 'CANCELED', 'REJECTED', 'NOT_FOUND_CONFIRMED'].includes(leg.outcome) || leg.openQty !== '0') throw Error('仍有未关闭订单时不能解除安全阻塞');
      if (decimal(leg.executedQty, '已成交数量', { zero: true }).gt(batch.legs[i].qty)) throw Error('已成交数量大于提交数量');
    }
    if (!/^-?\d+(\.\d+)?$/.test(String(data.realizedNet))) throw Error('实际净收益格式错误');
    batch.resolution = { at: Date.now(), reference: data.reference, legs: data.legs };
    batch.realizedNet = D(data.realizedNet).toString(); batch.status = 'RESOLVED';
    delete this.store.state.blocks[batch.pair];
    for (const ex of this.store.state.config.exchanges) if (this.store.state.balances[ex]) this.store.state.balances[ex].valid = false;
    this.store.event(`批次 ${id} 已人工核对；重新刷新余额后方可开启实盘`);
  }
  async scanOne() {
    const state = this.store.state;
    if (state.config.autoTrading) return;
    const priority = this.scanRequested ? 4 : 5;
    await Promise.all(state.config.exchanges.map(ex => this.exchanges.rules(ex, priority)));
    const [a, b] = state.config.exchanges;
    const ids = Object.keys(state.rules[a]).filter(id => id.endsWith('/' + state.config.scanQuote) && state.rules[a][id].enabled && state.rules[b]?.[id]?.enabled).sort();
    if (!ids.length) throw Error('两所没有共同的可交易现货交易对');
    const index = state.engine.scanCursor % ids.length, id = ids[index];
    state.engine.scanCursor = (index + 1) % ids.length;
    const books = Object.fromEntries(await Promise.all([a, b].map(async ex => [ex, await this.exchanges.book(ex, id, priority, { persist: state.config.pairs.includes(id) })])));
    state.scanResults[id] = { at: Date.now(), directions: [a, b].map((buyExchange, i) => {
      const sellExchange = [a, b][1 - i];
      return evaluate({ buy: books[buyExchange], sell: books[sellExchange], buyRule: state.rules[buyExchange][id], sellRule: state.rules[sellExchange][id], buyExchange, sellExchange, settings: state.config });
    }) };
    const entries = Object.entries(state.scanResults).sort((a, b) => b[1].at - a[1].at); state.scanResults = Object.fromEntries(entries.slice(0, 300));
    if (index === ids.length - 1) this.scanRequested = false;
    this.store.save();
  }
}
