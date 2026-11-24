const POLL_MS = 8000, FRESH_MS = 120000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const number = (value, decimals = 2) => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: decimals }) : '未知';
const money = value => finite(value) ? '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '未报价';
const price = value => !finite(value) || value <= 0 ? '未知' : '$' + (value < .00000001 ? value.toExponential(6) : value.toLocaleString('en-US', { maximumFractionDigits: value < .01 ? 12 : 6 }));
const displayTime = value => { const milliseconds = timestamp(value); return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString('zh-CN', { hour12: false }) : '未知'; };
const chainName = chain => chain === 'bnb' ? 'BNB' : chain === 'solana' ? 'Solana' : '';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
const approved = asset => asset?.mapping?.confirmed === true || asset?.mappingConfirmed === true || asset?.confirmed === true;
const badStatuses = new Set(['error', 'failed', 'auth_required', 'retrying', 'unavailable']);

/** A read-only view of scanner results. Navigation is delegated to the parent. */
export function createScannerBoard({ api, toast = () => {}, getState = () => null, onOpenAsset = () => {} }) {
  let container = null, state = null, generation = 0, request = 0, timer = null, pending = null, controller = null;
  let lastReadAt = 0, readError = false, filter = 'reference';
  const $ = selector => container?.querySelector(selector);
  const currentMode = () => getState()?.config?.mode === 'live' ? 'live' : 'demo';
  const available = () => getState()?.features?.opportunities !== false;
  const snapshotBlocked = () => !available() || readError || badStatuses.has(state?.status);
  function appBlocked() {
    const app = getState();
    return Boolean(app?.engine?.pausedReason || app?.engine?.busy || app?.engine?.configuring || app?.inventoryExecution?.busy);
  }
  function validReference(row, now) {
    if (!validId(row?.asset?.id) || row.asset.enabled === false || row.opportunityQualified !== true || row.marketQualified !== true || row.universe?.eligible !== true) return false;
    if (row.anomalous === true || row.comparisonStatus === 'quarantined' || (row.comparisonStatus && row.comparisonStatus !== 'comparable')) return false;
    if (typeof row.generation !== 'string' || !row.generation) return false;
    if (row.asset.mapping?.warning || !['bnb', 'solana'].includes(row.buyChain) || !['bnb', 'solana'].includes(row.sellChain) || row.buyChain === row.sellChain) return false;
    if (!finite(row.spreadBps) || row.spreadBps < (finite(state?.settings?.minSpreadBps) ? state.settings.minSpreadBps : 50) || row.spreadBps > (finite(state?.settings?.maxSpreadBps) ? state.settings.maxSpreadBps : 3000)) return false;
    const observations = [];
    for (const chain of ['bnb', 'solana']) {
      const pool = row.market?.[chain], observed = timestamp(pool?.observedAt);
      if (!finite(pool?.priceUsd) || pool.priceUsd <= 0 || !Number.isSafeInteger(observed) || observed < now - FRESH_MS || observed > now + 1000) return false;
      if (['none', 'conflicting-pools'].includes(pool.priceConfidence)) return false;
      observations.push(observed);
    }
    const combined = timestamp(row.observedAt);
    if (!Number.isSafeInteger(combined) || combined < now - FRESH_MS || combined > now + 1000) return false;
    const maxSkew = finite(state?.settings?.maxSideSkewMs) ? state.settings.maxSideSkewMs : 30000;
    return Math.abs(observations[0] - observations[1]) <= maxSkew;
  }
  function validQuote(row, now) {
    const report = row?.evaluation;
    if (snapshotBlocked() || pending || state?.busy || state?.enabled === false || state?.execution?.busy || appBlocked() || row?.executable !== true || !approved(row?.asset) || report?.executable !== true) return false;
    const app = getState();
    if (app?.config?.executionMode && app.config.executionMode !== 'inventory') return false;
    if (state?.execution?.mode && state.execution.mode !== currentMode()) return false;
    if (report.parentPolicyFingerprint !== undefined && app?.policyFingerprint !== undefined && report.parentPolicyFingerprint !== app.policyFingerprint) return false;
    if (report.parentRevision !== undefined && app?.engine?.configRevision !== undefined && report.parentRevision !== app.engine.configRevision) return false;
    if (currentMode() === 'live' && ['bnb', 'solana'].some(chain => app?.wallets?.[chain]?.canSign !== true)) return false;
    if (report.mode !== currentMode() || report.assetRevision !== row.asset.revision || !Number.isFinite(timestamp(report.expiresAt)) || timestamp(report.expiresAt) <= now) return false;
    if (report.quotedAt !== undefined && (!Number.isFinite(timestamp(report.quotedAt)) || timestamp(report.quotedAt) > now + 1000 || timestamp(report.quotedAt) < now - FRESH_MS)) return false;
    if (!finite(report.amountUsd) || report.amountUsd < 1 || report.amountUsd > 10 || !finite(report.netProfitUsd)) return false;
    const minimumProfit = finite(app?.config?.risk?.minProfitUsd) ? app.config.risk.minProfitUsd : 0;
    if (report.netProfitUsd < minimumProfit) return false;
    for (const key of ['gasUsd', 'slippageUsd', 'priceImpactBps']) if (!finite(report[key]) || report[key] < 0) return false;
    const amount = getState()?.config?.risk?.amountUsd;
    if (finite(amount) && Math.abs(report.amountUsd - amount) > 1e-10) return false;
    if (report.buyChain && report.buyChain !== row.buyChain || report.sellChain && report.sellChain !== row.sellChain) return false;
    return true;
  }
  function references() {
    if (!state || snapshotBlocked()) return [];
    const now = Date.now(), ids = new Map();
    for (const row of Array.isArray(state.rows) ? state.rows : []) if (validId(row?.asset?.id)) ids.set(row.asset.id, (ids.get(row.asset.id) || 0) + 1);
    return (Array.isArray(state.rows) ? state.rows : []).filter(row => ids.get(row?.asset?.id) === 1 && validReference(row, now))
      .map(row => ({ row, quoted: validQuote(row, now) }))
      .sort((left, right) => Number(right.quoted) - Number(left.quoted) || right.row.spreadBps - left.row.spreadBps || left.row.asset.id.localeCompare(right.row.asset.id));
  }
  function confidence(pool) {
    if (pool?.priceConfidence === 'pool-consensus') return '多池价格一致';
    if (pool?.priceConfidence === 'single-pool') return '单池参考，须复核';
    return '参考价格，须复核';
  }
  function shell() {
    container.innerHTML = `<section class="card scanner-board" aria-label="扫描套利机会"><div class="card-header scanner-board-heading"><div><h2>扫描套利机会</h2><p class="help" data-scanner-board-description></p></div><button type="button" class="button secondary small" data-scanner-board-refresh>刷新扫描结果</button></div><div class="card-body"><div class="scanner-board-status" role="status" aria-live="polite"></div><div class="scanner-board-meta"><span data-scanner-board-mode></span><span data-scanner-board-update></span></div><div class="scanner-board-counts"><div><span>参考价差达标</span><strong data-scanner-board-reference-count>—</strong></div><div><span data-scanner-board-quote-label>流程报价</span><strong data-scanner-board-quote-count>—</strong></div><div><span>异常已隔离</span><strong data-scanner-board-quarantine-count>—</strong></div></div><div class="scanner-board-filters" role="group" aria-label="扫描机会类型"><button type="button" class="button small" data-scanner-board-filter="reference">参考价差达标</button><button type="button" class="button secondary small" data-scanner-board-filter="executable">可执行报价</button></div><div class="scanner-board-list"></div><p class="help scanner-board-note">参考价格不包含完整 Gas、滑点、税费及补库存成本。同币映射和报价核验通过后才有执行资格，提交前仍会重新检查；看板不会自动下单。</p></div></section>`;
    $('[data-scanner-board-refresh]').addEventListener('click', () => { void refresh({ force: true }); });
    for (const button of container.querySelectorAll('[data-scanner-board-filter]')) button.addEventListener('click', () => { filter = button.dataset.scannerBoardFilter === 'executable' ? 'executable' : 'reference'; render(); });
    $('.scanner-board-list').addEventListener('click', event => {
      const button = event.target.closest('[data-scanner-board-open]'); if (!button || button.disabled) return;
      const id = button.dataset.scannerBoardOpen;
      // Re-evaluate current freshness and quarantine state at the actual click.
      if (!references().some(entry => entry.row.asset.id === id)) { render(); toast('该参考结果已过期或条件变化，请刷新后复核', true); return; }
      onOpenAsset(id);
    });
  }
  function render() {
    if (!container) return;
    if (!$('.scanner-board-list')) shell();
    const entries = references(), quoted = entries.filter(entry => entry.quoted), unknown = !state || snapshotBlocked();
    const demo = currentMode() === 'demo', quoteLabel = demo ? '模拟流程报价' : '可执行报价';
    $('[data-scanner-board-description]').textContent = `BNB／Solana 真实公开行情 · 参考价差与${quoteLabel}分别展示`;
    $('[data-scanner-board-quote-label]').textContent = quoteLabel;
    $('[data-scanner-board-filter=executable]').textContent = quoteLabel;
    $('.scanner-board-note').textContent = demo
      ? '参考价格不包含完整 Gas、滑点、税费及补库存成本。模拟流程报价使用虚拟资金和模拟成交，不能当作实盘可成交报价；实盘成功率未验证。看板不会自动下单。'
      : '参考价格不包含完整 Gas、滑点、税费及补库存成本。同币映射和报价核验通过后才有执行资格，提交前仍会重新检查；看板不会自动下单。';
    const status = $('.scanner-board-status');
    let message = '正在读取扫描结果…', level = 'neutral';
    if (!available()) message = '当前本机服务未启用机会扫描；请启动包含雷达的完整新版。';
    else if (readError) { message = '扫描结果读取失败，已有结果已暂停展示；请检查本机服务后刷新。'; level = 'error'; }
    else if (state && badStatuses.has(state.status)) { message = '扫描来源或行情读取未通过，暂不展示可用机会；请到雷达查看连接与筛选原因。'; level = 'error'; }
    else if (pending && state) message = `正在更新看板结果；有效参考结果保留，${quoteLabel}暂停展示。`;
    else if (state?.busy) message = `正在扫描公开行情；有效参考结果保留，${quoteLabel}暂停展示。`;
    else if (state?.status === 'partial' || state?.lastError) { message = '部分来源有连接提示；以下仅显示仍满足条件的新鲜参考结果，请结合雷达诊断复核。'; level = 'warning'; }
    else if (state?.status === 'cooldown') { message = '扫描请求冷却中；参考结果按有效期展示，不会延长旧报价。'; level = 'warning'; }
    else if (state?.enabled === false) { message = '自动扫描已停止；尚未过期的参考结果可查看，到期后会移出看板。'; level = 'warning'; }
    else if (state) message = entries.length ? '已读取符合条件的公开参考行情；报价和实际执行仍需核验。' : '当前没有满足条件的有效参考机会；已排除异常、过期及单侧无有效行情项目。';
    status.textContent = message; status.className = `scanner-board-status scanner-board-status-${level}`;
    $('[data-scanner-board-mode]').textContent = `交易模式：${demo ? '模拟流程演练（虚拟资金）' : '实盘'} · 参考行情来源：公开行情扫描`;
    $('[data-scanner-board-update]').textContent = `参考行情采集 ${displayTime(state?.updatedAt)} · 本机结果读取 ${displayTime(lastReadAt || null)}`;
    $('[data-scanner-board-reference-count]').textContent = unknown ? '—' : number(entries.length, 0);
    $('[data-scanner-board-quote-count]').textContent = unknown ? '—' : number(quoted.length, 0);
    const quarantined = state?.counts?.quarantined ?? state?.scope?.quarantined;
    $('[data-scanner-board-quarantine-count]').textContent = unknown ? '—' : Number.isSafeInteger(quarantined) && quarantined >= 0 ? number(quarantined, 0) : number((state?.rows || []).filter(row => row?.anomalous || row?.comparisonStatus === 'quarantined').length, 0);
    $('[data-scanner-board-refresh]').disabled = Boolean(pending);
    for (const button of container.querySelectorAll('[data-scanner-board-filter]')) { const active = button.dataset.scannerBoardFilter === filter; button.classList.toggle('secondary', !active); button.setAttribute('aria-pressed', String(active)); }
    const selected = filter === 'executable' ? quoted : entries;
    const listHtml = selected.length ? selected.slice(0, 30).map(({ row, quoted: executable }) => {
      const asset = row.asset, report = executable ? row.evaluation : null, simulated = report?.mode === 'demo';
      const quality = ['bnb', 'solana'].map(chain => `${chainName(chain)}：${confidence(row.market[chain])}`).join(' · ');
      return `<article class="scanner-board-row" data-scanner-board-asset="${esc(asset.id)}"><div class="scanner-board-identity"><strong>${esc(asset.symbol || asset.name || '未命名资产')}</strong><small>${esc(asset.name || '')}</small><span class="badge ${executable ? simulated ? 'amber' : 'green' : 'neutral'}">${executable ? simulated ? '模拟流程验证通过' : '当前报价检查通过' : approved(asset) ? '参考行情，待报价' : '参考行情，映射待核验'}</span></div><div class="scanner-board-prices"><div><span>BNB</span><strong>${esc(price(row.market.bnb.priceUsd))}</strong></div><div><span>Solana</span><strong>${esc(price(row.market.solana.priceUsd))}</strong></div><small>${esc(chainName(row.buyChain))} → ${esc(chainName(row.sellChain))} · 参考价差 ${esc(number(row.spreadBps / 100, 3))}%</small><small>${esc(quality)}</small></div><div class="scanner-board-quote"><span>${simulated ? '模拟估算现金流价差' : '预计现金流价差'}</span><strong class="${report && report.netProfitUsd >= 0 ? 'positive' : report ? 'negative' : ''}">${report ? esc(money(report.netProfitUsd)) : '未报价'}</strong><small>${report ? `${simulated ? '虚拟金额' : '金额'} ${esc(money(report.amountUsd))} · ${simulated ? '模拟 Gas' : 'Gas'} ${esc(money(report.gasUsd))} · ${simulated ? '模拟滑点' : '滑点'} ${esc(money(report.slippageUsd))}` : 'Gas／滑点／税费与库存须复核'}</small><small>${report ? `${simulated ? '模拟报价' : '报价'}有效至 ${esc(displayTime(report.expiresAt))}` : '参考价差不能当作净收益'}</small></div><button type="button" class="button secondary small" data-scanner-board-open="${esc(asset.id)}">查看并复核</button></article>`;
    }).join('') : `<div class="scanner-board-empty"><strong>${unknown ? '暂无法判断是否有机会' : filter === 'executable' ? `暂无当前${quoteLabel}` : '暂无符合条件的参考机会'}</strong><p>${unknown ? '请检查本机服务或到雷达查看来源状态，读取失败不代表市场没有机会。' : filter === 'executable' ? `${demo ? '此分组仅验证模拟流程；' : ''}需要先完成同币映射和双边报价；过期、模式不符、费用不完整或执行暂停的报价不会列在这里。` : '可到雷达查看发现数量、筛选条件及未入榜原因。异常项目不会补入机会列表。'}</p></div>`;
    if ($('.scanner-board-list').innerHTML !== listHtml) $('.scanner-board-list').innerHTML = listHtml;
  }
  function refresh({ force = false } = {}) {
    if (!container) return Promise.resolve();
    if (!available()) { render(); return Promise.resolve(); }
    if (pending) return pending;
    if (!force && lastReadAt && Date.now() - lastReadAt < POLL_MS) { render(); return Promise.resolve(); }
    const view = generation, ticket = ++request;
    const requestController = new AbortController(); controller = requestController;
    const operation = (async () => {
      try {
        const result = await Promise.resolve().then(() => api('/api/opportunities', { signal: requestController.signal }));
        if (!container || view !== generation || ticket !== request) return;
        state = result; readError = false; lastReadAt = Date.now();
      } catch {
        if (!container || view !== generation || ticket !== request) return;
        readError = true; lastReadAt = Date.now();
      } finally {
        if (ticket === request) { pending = null; controller = null; }
        if (container && view === generation && ticket === request) render();
      }
    })();
    pending = operation;
    render();
    return operation;
  }
  function mount(next) {
    if (!next) return;
    const wasUnmounted = !container;
    if (container !== next) { generation++; controller?.abort(); pending = null; controller = null; container = next; shell(); }
    render();
    // Expiry is a display deadline, independent from the network polling rate.
    if (!timer) timer = setInterval(() => { render(); void refresh(); }, 1000);
    void refresh({ force: wasUnmounted });
  }
  function unmount() {
    generation++; request++; controller?.abort(); controller = null; pending = null;
    clearInterval(timer); timer = null; container = null;
  }
  return { mount, unmount, refresh };
}
