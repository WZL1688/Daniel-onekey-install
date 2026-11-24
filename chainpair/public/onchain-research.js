const POLL_MS = 8000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const numeric = value => finite(value) ? value : typeof value === 'string' && /^-?\d{1,60}(?:\.\d{1,36})?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const money = value => numeric(value) === null ? '未知' : '$' + numeric(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const price = value => numeric(value) === null || numeric(value) <= 0 ? '未知' : '$' + (numeric(value) < 1e-8 ? numeric(value).toExponential(6) : numeric(value).toLocaleString('en-US', { maximumFractionDigits: 12 }));
const number = value => numeric(value) === null ? '未知' : numeric(value).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const date = value => Number.isFinite(stamp(value)) ? new Date(stamp(value)).toLocaleString('zh-CN', { hour12: false }) : '尚无';
const duration = value => finite(value) && value >= 0 ? (value / 86400000).toFixed(3) + ' 天' : '尚无';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
const chain = value => value === 'bnb' ? 'BNB' : value === 'solana' ? 'Solana' : '未知';
const allowedAmounts = [1, 2, 5, 10, 20, 50];
const list = value => Array.isArray(value) ? value : [];
const riskFields = [
  ['minProfitUsd', '最低模拟净价差（U）', 0, '.001'], ['maxDailyLossUsd', '模拟单日亏损上限（U）', 0, '.01'],
  ['maxInventoryLossUsd', '模拟库存亏损上限（U）', 0, '.01'], ['maxExposureUsd', '模拟单边敞口上限（U）', 0, '.01'],
  ['maxTokenExposureUsd', '模拟目标币价值上限（U）', 0, '.01'], ['inventoryPenaltyBps', '库存偏离成本预留（bps）', 0, '1']
];

/** A read-only research queue and explicitly virtual ledger, isolated from live trading. */
export function createOnchainResearchView({ api, toast = () => {}, getState = () => null, onOpenAsset = () => {} }) {
  let container = null, state = null, generation = 0, request = 0, timer = null, controller = null, pending = null;
  let lastReadAt = 0, readError = false, changing = false, settingsDirty = false, riskDirty = false, settingsFilled = false, riskSession = null;
  let selectedAsset = '', historyKind = 'quote', historyPage = 1, history = null, historyError = false, historyRead = 0, clearStopArmed = false;
  const $ = selector => container?.querySelector(selector);
  const feature = () => getState()?.features?.onchainResearch === true;
  const appBusy = () => Boolean(getState()?.engine?.busy || getState()?.engine?.configuring || getState()?.engine?.pausedReason);
  const isBusy = () => changing || readError || state?.busy === true || state?.globalStop === true || appBusy();

  function currentQuote(report, assetRevision) {
    const app = getState(), expiry = stamp(report?.expiresAt), now = Date.now();
    if (state?.globalStop === true || app?.engine?.pausedReason || app?.engine?.configuring) return false;
    if (!report || report.mode !== 'research' || report.readOnly !== true || report.executable !== false || report.identityVerified !== true || report.qualityPassed !== true || report.stale === true) return false;
    if (!validId(report.assetId) || !Number.isSafeInteger(report.assetRevision) || report.assetRevision < 1 || assetRevision !== undefined && report.assetRevision !== assetRevision) return false;
    const assets = list(state?.assets).filter(asset => asset?.id === report.assetId);
    if (assets.length && (assets.length !== 1 || assets[0].revision !== report.assetRevision || assets[0].enabled === false)) return false;
    if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 120000 || !Number.isFinite(stamp(report.quotedAt)) || stamp(report.quotedAt) > now + 1000 || stamp(report.quotedAt) < now - 120000) return false;
    const fingerprint = report.parentPolicyFingerprint ?? report.policyFingerprint;
    if (typeof fingerprint !== 'string' || fingerprint !== app?.policyFingerprint || report.parentRevision !== app?.engine?.configRevision) return false;
    if (!['bnb', 'solana'].includes(report.buyChain) || !['bnb', 'solana'].includes(report.sellChain) || report.buyChain === report.sellChain || !allowedAmounts.includes(report.amountUsd)) return false;
    const minimum = finite(app?.config?.risk?.minProfitUsd) ? app.config.risk.minProfitUsd : 0;
    if (!finite(report.netProfitUsd) || !finite(report.stressNetProfitUsd) || report.netProfitUsd < minimum || report.stressNetProfitUsd < minimum) return false;
    return ['gasUsd', 'slippageUsd', 'priceImpactBps', 'estimatedRentUsd'].every(key => finite(report[key]) && report[key] >= 0);
  }
  function rankedAssets() {
    const unique = new Map();
    for (const asset of list(state?.assets)) if (validId(asset?.id) && Number.isSafeInteger(asset.revision) && asset.enabled !== false) unique.set(asset.id, { assetId: asset.id, assetRevision: asset.revision, symbol: asset.symbol, name: asset.name });
    for (const row of list(state?.rankings)) if (validId(row?.assetId) && Number.isSafeInteger(row.assetRevision)) {
      const previous = unique.get(row.assetId);
      if (list(state?.assets).length && !previous) continue;
      if (previous && previous.assetRevision > row.assetRevision) continue;
      if (!previous || row.assetRevision > previous.assetRevision || row.assetRevision === previous.assetRevision && stamp(row.lastSeen) > stamp(previous.lastSeen)) unique.set(row.assetId, row);
      else if (previous?.lastSeen === undefined && row.assetRevision === previous.assetRevision) unique.set(row.assetId, { ...row, symbol: previous.symbol || row.symbol });
    }
    return [...unique.values()].sort((left, right) => Number(currentQuote(right.latestQuote, right.assetRevision)) - Number(currentQuote(left.latestQuote, left.assetRevision)) || (numeric(right.positiveRealQuoteSamples) ?? 0) - (numeric(left.positiveRealQuoteSamples) ?? 0) || String(left.assetId).localeCompare(right.assetId));
  }
  function selected() { return rankedAssets().find(asset => asset.assetId === ($('[data-research-asset]')?.value || selectedAsset)); }
  function shell() {
    container.innerHTML = `<div class="market-subnav" aria-label="行情视图"><button class="button secondary small" data-market-view="arbitrage">套利看板</button><button class="button secondary small" data-market-view="radar">Meme 雷达</button><button class="button secondary small" data-market-view="opportunities">同币机会</button><button class="button small" data-market-view="research" aria-current="page">链上研究</button></div><section id="onchain-research-view" style="min-width:0;overflow-wrap:anywhere"><div class="page-heading"><div><div class="eyebrow">ONCHAIN OPPORTUNITY RESEARCH</div><h1>链上机会研究</h1><p>BNB／Solana 同币候选 · 双向真实报价 · 独立 paper 账本</p></div><span class="badge neutral">研究与 paper · 不自动实盘</span></div><div class="notice blue"><span class="notice-icon">⇄</span><p>AMM 使用真实金额梯度的兑换报价与执行均价评估，不把池流动性当作订单簿深度。20U／50U仅用于研究和 paper，原实盘1–10U限制保留。</p></div><section class="card"><div class="card-header"><h2>研究控制</h2><button type="button" class="button secondary small" data-research-refresh>刷新本机记录</button></div><div class="card-body"><p class="help" data-research-status role="status" aria-live="polite"></p><form data-research-settings><div class="form-grid"><div class="field full"><label>观察金额（U）</label><div class="form-actions">${allowedAmounts.map(amount => `<label class="check-row"><input type="checkbox" name="amount" value="${amount}"><span>${amount}U</span></label>`).join('')}</div></div><label class="field"><span>报价任务间隔（秒）</span><input name="quoteSeconds" type="number" min="15" max="3600" step="1" value="15" required></label><label class="field"><span>每日研究任务上限</span><input name="maxJobsPerDay" type="number" min="1" max="5000" step="1" value="500" required></label></div><label class="check-row"><input name="enabled" type="checkbox"><span>自动读取只读报价；不签名、不授权、不下单</span></label><button type="submit" class="button secondary small">保存研究设置</button></form><p class="help" data-research-queue></p><p class="help">真实报价需要公开钱包地址及已解锁的自己的 OKX API；身份未核验的条目保持候选，不授予交易资格。实盘仍需单独预检和人工启用。</p></div></section><section class="card"><div class="card-header"><h2>14 天观察覆盖</h2></div><div class="card-body" data-research-coverage></div></section><section class="card"><div class="card-header"><h2>候选与重复机会排行</h2></div><div class="card-body"><div class="form-grid"><label class="field full"><span>选择精确资产条目</span><select data-research-asset aria-label="选择研究资产"><option value="">等待真实扫描记录</option></select></label><label class="field"><span>单档金额（U）</span><select data-research-amount>${allowedAmounts.map(amount => `<option value="${amount}">${amount}U</option>`).join('')}</select></label><label class="field"><span>买入链（另一链卖出）</span><select data-research-buy><option value="bnb">BNB 买入 → Solana 卖出</option><option value="solana">Solana 买入 → BNB 卖出</option></select></label></div><div class="form-actions"><button type="button" class="button secondary small" data-research-quote>排队单档真实报价</button><button type="button" class="button secondary small" data-research-matrix>复核双向金额梯度</button><button type="button" class="button text small" data-research-open>查看资产与池证据</button></div><div data-research-rankings></div></div></section><section class="card"><div class="card-header"><h2>双向金额报价记录</h2></div><div class="card-body"><div data-research-quotes></div><p class="help">合格只读报价不是成交。稳定币按美元面值、Gas按配置参考价估值；未来补库成本与未解析的路由约束需另行核对。缺报价时不以参考价差填充净收益。</p></div></section><section class="card"><div class="card-header"><h2>真实行情 paper 账本</h2><span class="badge amber">虚拟资金 · 无链上成交哈希</span></div><div class="card-body"><p class="help">每链明确分配50%虚拟现金与50%目标代币。延迟后重新取真实报价模拟成交；不是固定 DEMO 行情，也不是实盘收益或成功率证据。</p><label class="field"><span>每链虚拟初始资本（U）</span><input data-paper-capital type="number" min="1" max="1000000" step="1" value="100"></label><div class="form-actions"><button type="button" class="button secondary small" data-paper-start>为所选币创建 paper</button><button type="button" class="button secondary small" data-paper-run>模拟一笔当前机会</button><button type="button" class="button secondary small" data-paper-resume>人工恢复 paper</button><button type="button" class="button secondary small" data-paper-pause>暂停 paper</button></div><p class="help" data-paper-status role="status"></p><div data-paper-positions></div><div data-paper-stats></div><details><summary>paper 风控设置</summary><form data-paper-risk><div class="form-grid">${riskFields.map(([key, label, min, step]) => `<label class="field"><span>${label}</span><input name="${key}" type="number" min="${min}" step="${step}" required></label>`).join('')}</div><button type="submit" class="button secondary small">保存 paper 风控</button></form></details><p class="help">亏损再平衡默认暂停待人工处理，不自动跨链划转；AMM单笔原子成交，不虚构任意部分成交。单边模拟敞口、断网或重启未完成状态会保留核对。</p></div></section><details class="card" data-research-history><summary>分页查看独立研究历史</summary><div class="card-body"><label class="field"><span>记录类型</span><select data-history-kind><option value="quote">真实只读报价</option><option value="paper-trade">paper 交易</option><option value="paper-event">paper 状态事件</option></select></label><div data-history-content></div><div class="pager"><span data-history-page></span><div class="pager-buttons"><button type="button" class="button secondary small" data-history-prev>上一页</button><button type="button" class="button secondary small" data-history-next>下一页</button></div></div></div></details></section>`;
    $('[data-research-refresh]').addEventListener('click', () => { void refresh({ force: true }); });
    const controls = $('[data-research-refresh]').parentElement; controls.style.flexWrap = 'wrap';
    controls.insertAdjacentHTML('beforeend', '<button type="button" class="button danger small" data-research-stop>全局停止新执行</button><button type="button" class="button secondary small" data-research-clear-stop hidden>解除全局停止</button>');
    $('[data-research-stop]').addEventListener('click', () => { void post('/stop', {}, '全局停止已请求；在途交易与敞口仍须核对'); });
    $('[data-research-clear-stop]').addEventListener('click', () => {
      if (!clearStopArmed) { clearStopArmed = true; renderActions(); const view = generation; setTimeout(() => { if (view === generation && container) { clearStopArmed = false; renderActions(); } }, 5000); return; }
      void post('/clear-stop', { confirmed: true }, '已解除停止；没有启动自动交易或 paper', () => { clearStopArmed = false; });
    });
    $('[data-research-settings]').addEventListener('input', () => { settingsDirty = true; });
    $('[data-research-settings]').addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget;
      const amounts = [...form.querySelectorAll('[name=amount]:checked')].map(input => Number(input.value));
      if (!amounts.length) { toast('请至少选择一个研究金额', true); return; }
      void post('/settings', { settings: { enabled: form.elements.enabled.checked, amounts, quoteIntervalMs: Number(form.elements.quoteSeconds.value) * 1000, maxJobsPerDay: Number(form.elements.maxJobsPerDay.value) } }, '研究设置已保存；实盘模式和自动交易保持独立', () => { settingsDirty = false; settingsFilled = false; });
    });
    $('[data-research-asset]').addEventListener('change', event => { selectedAsset = event.target.value; renderActions(); });
    $('[data-research-quote]').addEventListener('click', () => { const asset = selected(); if (asset) void post('/quote', { assetId: asset.assetId, revision: asset.assetRevision, amountUsd: Number($('[data-research-amount]').value), buyChain: $('[data-research-buy]').value }, '只读报价已排队；不会发送交易'); });
    $('[data-research-matrix]').addEventListener('click', () => { const asset = selected(); if (asset) void post('/matrix', { assetId: asset.assetId, revision: asset.assetRevision }, '双向金额梯度已排队；每档独立核验有效期'); });
    $('[data-research-open]').addEventListener('click', () => { const asset = selected(); if (asset) onOpenAsset(asset.assetId); });
    $('[data-research-rankings]').addEventListener('click', event => {
      const button = event.target.closest('[data-research-select]');
      if (button && validId(button.dataset.researchSelect)) { selectedAsset = button.dataset.researchSelect; $('[data-research-asset]').value = selectedAsset; renderActions(); }
    });
    $('[data-paper-start]').addEventListener('click', () => { const asset = selected(); if (asset) void post('/paper/start', { assetId: asset.assetId, revision: asset.assetRevision, capitalPerChainUsd: Number($('[data-paper-capital]').value) }, '已创建独立虚拟 paper 资本；没有链上交易'); });
    for (const [action, message] of [['run', 'paper 模拟任务已请求'], ['pause', 'paper 已暂停'], ['resume', '已请求人工恢复 paper']]) $(`[data-paper-${action}]`).addEventListener('click', () => { void post('/paper/' + action, {}, message); });
    $('[data-paper-risk]').addEventListener('input', () => { riskDirty = true; });
    $('[data-paper-risk]').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; const risk = Object.fromEntries(riskFields.map(([key]) => [key, Number(form.elements[key].value)])); void post('/paper/settings', { risk }, 'paper 风控已保存；不会改变实盘风控', () => { riskDirty = false; riskSession = null; }); });
    $('[data-research-history]').addEventListener('toggle', () => { if ($('[data-research-history]')?.open) void readHistory(); });
    $('[data-history-kind]').addEventListener('change', event => { historyKind = event.target.value; historyPage = 1; void readHistory(); });
    $('[data-history-prev]').addEventListener('click', () => { historyPage = Math.max(1, historyPage - 1); void readHistory(); });
    $('[data-history-next]').addEventListener('click', () => { if (historyPage < (history?.totalPages || 1)) { historyPage++; void readHistory(); } });
  }
  function renderSettings() {
    const form = $('[data-research-settings]');
    if (!settingsDirty && !settingsFilled && state?.settings) {
      for (const input of form.querySelectorAll('[name=amount]')) input.checked = list(state.settings.amounts).includes(Number(input.value));
      form.elements.enabled.checked = state.settings.enabled === true;
      if (finite(state.settings.quoteIntervalMs)) form.elements.quoteSeconds.value = state.settings.quoteIntervalMs / 1000;
      if (Number.isSafeInteger(state.settings.maxJobsPerDay)) form.elements.maxJobsPerDay.value = state.settings.maxJobsPerDay;
      settingsFilled = true;
    }
    for (const control of form.querySelectorAll('input,button')) control.disabled = !feature() || changing || readError || !state;
  }
  function renderCoverage() {
    const coverage = state?.coverage;
    if (readError || !coverage || !feature()) { $('[data-research-coverage]').innerHTML = '<p class="help">尚无可验证的观察覆盖；不会用日期跨度代替14天记录。</p>'; return; }
    const sufficient = coverage.validated14Days === true && finite(coverage.currentContinuousMs) && coverage.currentContinuousMs >= 14 * 86400000 && Number.isSafeInteger(coverage.observations) && coverage.observations > 1 && coverage.scope === 'single-asset-version-policy';
    $('[data-research-coverage]').innerHTML = `<p data-research-validation>${sufficient ? '当前单一资产／版本／策略的连续观察已达到14天记录条件；不代表盈利或未来成功率。' : '14天验证尚未完成；按实际有效采样累计，不预填历史。'}</p><div class="scanner-board-counts"><div><span>有效相邻采样时长</span><strong>${duration(coverage.validDurationMs)}</strong></div><div><span>当前连续观察</span><strong>${duration(coverage.currentContinuousMs)}</strong></div><div><span>真实观察次数</span><strong>${number(coverage.observations)}</strong></div><div><span>断档次数</span><strong>${number(coverage.gapCount)}</strong></div></div><p class="help">首次 ${date(coverage.firstAt)} · 最近 ${date(coverage.lastAt)}。这里只是参考行情采样覆盖，不是14天paper绩效验收，也不解锁实盘。覆盖按单一资产、版本与策略统计；停机、陈旧缓存、异常和采样断档不算连续验证，也不把不同币的数据拼成14天。</p>`;
  }
  function renderRanks() {
    const assets = readError || !feature() ? [] : rankedAssets(), select = $('[data-research-asset]');
    if (document.activeElement !== select) {
      selectedAsset = select.value || selectedAsset;
      if (!assets.some(asset => asset.assetId === selectedAsset)) selectedAsset = assets[0]?.assetId || '';
      select.innerHTML = assets.length ? assets.map(asset => `<option value="${esc(asset.assetId)}">${esc(asset.symbol || asset.assetId)} · 版本 ${asset.assetRevision}</option>`).join('') : '<option value="">等待真实扫描记录</option>';
      select.value = selectedAsset;
    }
    $('[data-research-rankings]').innerHTML = assets.length ? assets.slice(0, 30).map(asset => {
      const quote = asset.latestQuote, qualified = currentQuote(quote, asset.assetRevision);
      return `<article class="opp-pool-trace" data-research-rank="${esc(asset.assetId)}"><strong>${esc(asset.symbol || asset.assetId)}</strong> <span class="badge ${qualified ? 'green' : 'neutral'}">${qualified ? '当前合格只读报价' : quote?.identityVerified === false ? '同币身份待核验' : '参考／历史观察'}</span><div class="opp-price-gap"><span>参考达标采样 ${number(asset.refPositiveSamples)}</span><span>出现段 ${number(asset.episodes)}</span><span>合格报价采样 ${number(asset.positiveRealQuoteSamples)}</span><span>双向出现 ${asset.dualDirections === true ? '已有两方向记录' : '尚未形成两方向证据'}</span></div><p class="help">参考连续累计 ${duration(asset.referenceDurationMs)} · 最近 ${date(asset.lastSeen)}${qualified ? ` · 当前压力后估算 ${money(quote.stressNetProfitUsd)}` : ''}。历史采样不代表当前仍可执行。</p><button type="button" class="button text small" data-research-select="${esc(asset.assetId)}">选择此条目</button></article>`;
    }).join('') : '<div class="empty-state">当前没有新扫描生成的研究排行。先在“同币机会”核对行情连接与扫描状态；不以稳定币或未知价格填满机会。</div>';
  }
  function renderQuotes() {
    const quotes = readError || !feature() ? [] : list(state?.recentQuotes).filter(report => validId(report?.assetId)).slice(0, 20);
    $('[data-research-quotes]').innerHTML = quotes.length ? quotes.map(report => {
      const current = currentQuote(report);
      return `<article class="opp-pool-trace" data-research-quote-id="${esc(report.id || '')}"><strong>${esc(report.symbol || report.assetId)} · ${chain(report.buyChain)} → ${chain(report.sellChain)} · ${money(report.amountUsd)}</strong> <span class="badge ${current ? 'green' : 'neutral'}">${current ? '当前只读报价通过' : report.identityVerified === false ? '候选报价：身份待核验' : stamp(report.expiresAt) <= Date.now() ? '历史报价／已过期' : '未通过完整研究检查'}</span><div class="opp-price-gap"><span>保守报价净值 ${money(report.netProfitUsd)}</span><span>压力后 ${money(report.stressNetProfitUsd)}</span><span>Gas／网络费 ${money(report.gasUsd)}</span><span>滑点预留 ${money(report.slippageUsd)}</span><span>库存调整成本预留 ${money(report.inventoryAdjustmentCostUsd)}</span></div><p class="help">买入执行均价 ${price(report.buyAveragePriceUsd)} · 卖出执行均价 ${price(report.sellAveragePriceUsd)}，均来自该金额的真实兑换报价，未承诺未来成交价。</p><p class="help">报价 ${date(report.quotedAt)} · 有效至 ${date(report.expiresAt)}。身份未确认、陈旧或未通过项不计为合格机会。</p>${list(report.reasons).length ? `<ul class="opp-reasons">${list(report.reasons).filter(value => typeof value === 'string').slice(0, 6).map(reason => `<li>${esc(reason.slice(0, 240))}</li>`).join('')}</ul>` : ''}</article>`;
    }).join('') : '<p class="help">尚无真实报价记录。费用与净收益未验证，不用参考差价推算成交收益。</p>';
  }
  function renderPaper() {
    const paper = state?.paper, session = paper?.sessionId;
    $('[data-paper-status]').textContent = readError ? 'paper 状态读取失败，无法核验当前账本。' : !session ? '尚无 paper 账本；虚拟资本仅在你明确创建时分配，不计作利润。' : paper.needsReview ? '存在单边模拟敞口或未完成状态，paper 已暂停，须核对；不会重播。' : `paper ${paper.running ? '运行中' : '已暂停'} · 资产 ${validId(paper.asset?.id) ? paper.asset.id : '身份记录缺失'}${paper.busy ? ' · 模拟任务处理中' : ''}；${typeof paper.pausedReason === 'string' && paper.pausedReason ? '暂停原因见账本记录。' : '每腿均使用延迟后的真实报价。'}`;
    const positions = !readError && session ? paper.positions : null;
    $('[data-paper-positions]').innerHTML = positions ? `<div class="opp-pair-grid">${['bnb', 'solana'].map(key => `<div class="opp-pool-trace"><strong>${chain(key)} · 虚拟资产</strong><p>现金 ${money(positions[key]?.cashUsd)}</p><p class="mono opp-address">目标币原始数量 ${esc(positions[key]?.tokenRaw ?? '未知')} · 精度 ${esc(positions[key]?.tokenDecimals ?? '未知')}</p><p class="help">预占现金 ${money(paper.reservations?.cashUsd?.[key])} · 预占代币原始数量 ${esc(paper.reservations?.tokenRaw?.[key] ?? '未知')}</p></div>`).join('')}</div>` : '';
    const stats = !readError && session ? paper.stats || {} : {};
    const metrics = [['contributedCapitalUsd', '明确分配的虚拟资本'], ['realizedCashSpreadUsd', '已完成paper现金价差'], ['grossSpreadUsd', 'paper毛价差'], ['quotedNetworkFeesUsd', 'paper报价费用（Gas／租金）'], ['explicitDexTradingFeesUsd', '独立DEX交易费明细'], ['executionSlippageUsd', '执行滑点差异'], ['inventoryRebalanceLossUsd', '库存平衡损耗'], ['singleSidedLossUsd', '单边模拟损失'], ['unrealizedPnlUsd', '持币浮动盈亏'], ['unhedgedExposureUsd', '单边敞口'], ['netEquityUsd', '虚拟账户净值'], ['netEquityPnlUsd', '相对虚拟出资盈亏']];
    $('[data-paper-stats]').innerHTML = `<div class="scanner-board-counts">${metrics.map(([key, label]) => `<div><span>${label}</span><strong data-paper-stat="${key}">${money(stats[key])}</strong></div>`).join('')}<div><span>最大回撤</span><strong>${numeric(stats.maxDrawdownPct) === null ? '未知' : number(stats.maxDrawdownPct) + '%'}</strong></div><div><span>paper双腿完成比例</span><strong>${numeric(stats.successfulBothLegsRate) === null ? '尚无统计' : (numeric(stats.successfulBothLegsRate) * 100).toFixed(1) + '%'}</strong></div></div><p class="help">DEX交易费已反映在兑换输出，未单独取得明细，不重复扣除。以上全部为虚拟账本结果，不能当作实盘已实现收益。陈旧估值和未平仓损失保持未知；未来补库成本另计。</p>`;
    if (!riskDirty && riskSession !== session && paper?.risk) {
      const form = $('[data-paper-risk]'); for (const [key] of riskFields) form.elements[key].value = numeric(paper.risk[key]) ?? '';
      riskSession = session;
    }
    for (const control of $('[data-paper-risk]').querySelectorAll('input,button')) control.disabled = !feature() || isBusy() || !session;
  }
  function renderActions() {
    const asset = selected(), blocked = !feature() || !state || isBusy();
    for (const key of ['quote', 'matrix']) $(`[data-research-${key}]`).disabled = blocked || !asset;
    $('[data-research-open]').disabled = !asset;
    $('[data-research-refresh]').disabled = Boolean(pending || changing || !feature());
    $('[data-research-stop]').disabled = !feature() || changing;
    $('[data-research-clear-stop]').hidden = state?.globalStop !== true;
    $('[data-research-clear-stop]').disabled = changing || !feature();
    $('[data-research-clear-stop]').textContent = clearStopArmed ? '再次点击确认解除（不自动恢复）' : '解除全局停止';
    $('[data-paper-start]').disabled = blocked || !asset || Boolean(state?.paper?.sessionId);
    $('[data-paper-run]').disabled = blocked || !state?.paper?.sessionId || state.paper.running !== true || state.paper.needsReview === true || state.paper.busy === true;
    $('[data-paper-pause]').disabled = !feature() || changing || !state?.paper?.sessionId;
    $('[data-paper-resume]').disabled = blocked || !state?.paper?.sessionId || state.paper.running === true || state.paper.needsReview === true;
    $('[data-research-asset]').disabled = blocked;
  }
  function render() {
    if (!container) return;
    $('[data-research-status]').textContent = !feature() ? '本机尚未启用链上研究模块，请运行完整新版。' : readError ? '研究状态读取失败，请检查本机服务；不继续沿用旧的合格状态。' : !state ? '正在读取独立研究记录…' : changing ? '正在提交研究／paper请求；不会触发实盘交易。' : state.globalStop ? '全局停止已生效；研究／paper和新实盘执行暂停，在途交易与敞口仍须核对。解除不会自动恢复。' : `自动只读报价${state.settings?.enabled ? '已开启' : '已关闭'} · 上次报价 ${date(state.lastQuoteAt)} · 下次可用 ${date(state.nextQuoteAt)}${state.lastError ? ' · 上次任务未完成，请查看报价未通过原因。' : ''}`;
    $('[data-research-queue]').textContent = `待处理任务 ${list(state?.queue).length}${state?.busy ? ' · 当前任务进行中' : ''}；各金额与方向独立完成、独立过期。`;
    renderSettings(); renderCoverage(); renderRanks(); renderQuotes(); renderPaper(); renderActions(); renderHistory();
  }
  function renderHistory() {
    if (!container) return;
    $('[data-history-content]').innerHTML = historyError ? '<p class="help">历史记录读取失败。</p>' : !history ? '<p class="help">展开后按页读取独立研究记录。</p>' : list(history.items).length ? list(history.items).map(record => `<article class="opp-pool-trace"><strong>${esc(record.assetId || record.asset?.id || record.type || record.state || record.status || '研究记录')}</strong><p class="help">${date(record.quotedAt || record.createdAt || record.at)} · ${esc(record.status || record.state || '只读记录')} · paper／研究不代表实盘成交</p>${record.netProfitUsd !== undefined ? `<p>报价净值 ${money(record.netProfitUsd)}</p>` : ''}</article>`).join('') : '<p class="help">此页没有记录。</p>';
    $('[data-history-page]').textContent = `第 ${historyPage} / ${Number.isSafeInteger(history?.totalPages) ? history.totalPages : 1} 页`;
    $('[data-history-prev]').disabled = historyPage <= 1 || !feature();
    $('[data-history-next]').disabled = historyPage >= (history?.totalPages || 1) || !feature();
  }
  async function readHistory() {
    if (!container || !feature()) return;
    const view = generation, ticket = ++historyRead;
    try {
      const next = await api('/api/onchain-research/history?kind=' + historyKind + '&page=' + historyPage);
      if (container && view === generation && ticket === historyRead) { history = next; historyError = false; renderHistory(); }
    } catch { if (container && view === generation && ticket === historyRead) { historyError = true; renderHistory(); } }
  }
  async function refresh({ force = false } = {}) {
    if (!container || !feature()) { render(); return; }
    if (pending || changing) return pending;
    if (!force && Date.now() - lastReadAt < POLL_MS) { render(); return; }
    const view = generation, ticket = ++request, readController = new AbortController(); controller = readController;
    const operation = (async () => {
      try {
        const next = await api('/api/onchain-research', { signal: readController.signal });
        if (container && view === generation && ticket === request) { state = next; readError = false; lastReadAt = Date.now(); }
      } catch { if (container && view === generation && ticket === request) { readError = true; state = null; } }
    })().finally(() => { if (ticket === request) { pending = null; controller = null; } if (container && view === generation && ticket === request) render(); });
    pending = operation; render(); return operation;
  }
  async function post(path, body, success, onSuccess = () => {}) {
    if (!container || !feature() || changing) return;
    const view = generation; controller?.abort(); request++; pending = null; controller = null; changing = true; render();
    try {
      await api('/api/onchain-research' + path, { method: 'POST', body });
      if (container && view === generation) { onSuccess(); toast(success); }
    } catch { if (container && view === generation) toast('研究／paper请求未完成，请检查本机状态与参数；未请求实盘执行', true); }
    finally { if (view === generation) { changing = false; if (container) { render(); void refresh({ force: true }); } } }
  }
  function mount(node) {
    if (!node) return;
    if (container !== node) { unmount(); container = node; generation++; shell(); }
    render(); if (!timer) timer = setInterval(() => { render(); void refresh(); }, 1000);
    void refresh();
  }
  function unmount() { generation++; request++; historyRead++; controller?.abort(); controller = null; pending = null; changing = false; clearStopArmed = false; clearInterval(timer); timer = null; container = null; }
  return { mount, unmount, refresh };
}
