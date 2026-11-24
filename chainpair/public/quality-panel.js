const POLL_MS = 8000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const money = value => finite(value) ? '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '未知';
const percent = value => finite(value) && value >= 0 && value <= 1 ? (value * 100).toFixed(1) + '%' : '尚无统计';
const displayTime = value => Number.isFinite(time(value)) ? new Date(time(value)).toLocaleString('zh-CN', { hour12: false }) : '尚无';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
const labels = { attempts: '真实尝试', successes: '双边确认且扣费盈利', verifiedLosses: '已核实未盈利', failed: '执行失败', unknown: '结果待核对', pending: '尚未完成' };

/** Real read-only quotes and real archived results remain separate from demos. */
export function createQualityPanel({ api, toast = () => {}, getState = () => null, onOpenAsset = () => {} }) {
  let container = null, generation = 0, request = 0, controller = null, timer = null, pending = null;
  let quality = null, performance = null, qualityError = false, performanceError = false;
  let lastReadAt = 0, lastPerformanceMode = null, changing = false;
  const $ = selector => container?.querySelector(selector);
  const executionMode = () => getState()?.config?.executionMode === 'inventory' ? 'inventory' : 'bridge';
  const qualityAvailable = () => getState()?.features?.quality !== false;
  const performanceAvailable = () => getState()?.features?.performance !== false;
  function currentReport(report, now) {
    const app = getState();
    if (!report || report.readOnly !== true || report.executable !== false || report.mode !== 'live' || !validId(report.assetId)) return false;
    if (!Number.isSafeInteger(report.assetRevision) || report.assetRevision < 1) return false;
    if (!Number.isFinite(time(report.expiresAt)) || time(report.expiresAt) <= now || time(report.expiresAt) > now + 120000) return false;
    if (!Number.isSafeInteger(report.parentRevision) || app?.engine?.configRevision !== report.parentRevision) return false;
    if (typeof report.parentPolicyFingerprint !== 'string' || report.parentPolicyFingerprint !== app?.policyFingerprint) return false;
    if (!finite(report.amountUsd) || report.amountUsd < 1 || report.amountUsd > 10 || !finite(report.netProfitUsd) || !finite(report.stressNetProfitUsd)) return false;
    if (finite(app?.config?.risk?.amountUsd) && Math.abs(report.amountUsd - app.config.risk.amountUsd) > 1e-10) return false;
    for (const key of ['gasUsd', 'slippageUsd', 'priceImpactBps']) if (!finite(report[key]) || report[key] < 0) return false;
    if (app?.engine?.configuring || app?.engine?.pausedReason) return false;
    return true;
  }
  function validPerformance() {
    if (performanceError || !performanceAvailable() || performance?.mode !== 'live' || performance.executionMode !== executionMode() || performance.scope?.kind !== 'global') return false;
    const counts = performance.counts;
    if (!counts || Object.keys(labels).some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) return false;
    return ['successes', 'verifiedLosses', 'failed', 'unknown', 'pending'].reduce((sum, key) => sum + counts[key], 0) === counts.attempts;
  }
  function shell() {
    container.innerHTML = `<section class="card quality-panel" aria-label="真实只读报价复核"><div class="card-header scanner-board-heading"><div><h2>真实只读报价复核</h2><p class="help">与模拟演练分开 · 使用公开钱包地址及已解锁的 OKX API 凭据</p></div></div><div class="card-body"><p class="help">只请求真实行情、余额和双边报价，不签名、不下单，未进行成交模拟。报价通过不等于可成交或保证盈利。</p><button type="button" class="button secondary small" data-quality-toggle>读取复核设置…</button> <button type="button" class="button secondary small" data-quality-refresh>刷新复核结果</button><p class="help" data-quality-status role="status" aria-live="polite"></p><div data-quality-reports></div><p class="help">压力核算额外假设卖出所得下降 0.5%、网络费用上涨 25%；仍须达到利润门槛。该缓冲不是成功概率。稳定币按美元面值、Gas 按配置参考价估值，库存结果未计未来补库成本。</p></div></section><section class="card performance-panel" aria-label="实盘盈利证据"><div class="card-header"><h2>实盘盈利证据</h2></div><div class="card-body"><p class="help">口径：买卖两边确认，且扣除已核实费用后净盈利。模拟演练、只读报价通过次数均不计入。</p><div data-performance-body></div></div></section>`;
    $('[data-quality-refresh]').addEventListener('click', () => { void refresh({ force: true }); });
    $('[data-quality-toggle]').addEventListener('click', () => { void toggle(); });
    $('[data-quality-reports]').addEventListener('click', event => {
      const button = event.target.closest('[data-quality-open]');
      if (button && container?.contains(button) && validId(button.dataset.qualityOpen)) onOpenAsset(button.dataset.qualityOpen);
    });
  }
  function renderQuality() {
    const enabled = quality?.enabled === true, available = qualityAvailable();
    const button = $('[data-quality-toggle]');
    button.disabled = !available || !quality || qualityError || changing || quality.busy === true;
    button.textContent = changing ? '正在保存只读设置…' : enabled ? '停止自动只读复核' : '开启自动只读复核';
    $('[data-quality-refresh]').disabled = Boolean(pending || changing || !available);
    const status = !available ? '本机版本尚未启用真实只读复核。' : qualityError ? '复核结果读取失败，请检查本机服务。' : !quality ? '正在读取真实只读复核设置…' : quality.busy ? '正在复核真实报价；不会发起交易。' : `自动只读复核${enabled ? '已开启' : '已关闭'}；上次尝试：${displayTime(quality.lastAttemptAt)}。${quality.lastError ? '上次复核未通过，请查看条目原因并核对设置。' : ''}`;
    $('[data-quality-status]').textContent = status;
    if (!available || qualityError || !quality) { $('[data-quality-reports]').innerHTML = '<p class="help">当前没有已验证机会。</p>'; return; }
    const reports = Array.isArray(quality.reports) ? quality.reports : [], now = Date.now(), seen = new Map();
    for (const report of reports) if (validId(report?.assetId)) seen.set(report.assetId, (seen.get(report.assetId) || 0) + 1);
    const current = reports.filter(report => seen.get(report?.assetId) === 1 && currentReport(report, now));
    const minimum = finite(getState()?.config?.risk?.minProfitUsd) ? getState().config.risk.minProfitUsd : 0;
    const passes = current.filter(report => report.qualityPassed === true && report.netProfitUsd >= minimum && report.stressNetProfitUsd >= minimum)
      .sort((left, right) => right.stressNetProfitUsd - left.stressNetProfitUsd || left.assetId.localeCompare(right.assetId));
    const failed = reports.filter(report => validId(report?.assetId) && report.readOnly === true && report.executable === false && report.mode === 'live' && report.qualityPassed !== true).slice(0, 5);
    $('[data-quality-reports]').innerHTML = `${passes.length ? `<p class="help" data-quality-pass-count>当前 ${passes.length} 项通过只读报价与压力门槛；未验证成交。</p>` : '<p class="help" data-quality-empty>当前没有已验证机会。过期、参数变化或未通过复核的结果不会计入。</p>'}${passes.map(report => `<article class="opp-compact-asset quality-report" data-quality-asset="${esc(report.assetId)}"><div class="opp-compact-row"><div><strong>${esc(report.symbol || report.name || report.assetId)}</strong><p class="help">真实只读报价 · 未验证成交</p></div><div><p>金额 ${money(report.amountUsd)}</p><p>保守报价净收益 ${money(report.netProfitUsd)}</p></div><div><p>压力后估算 ${money(report.stressNetProfitUsd)}</p><p class="help">有效至 ${displayTime(report.expiresAt)}</p></div><button type="button" class="button secondary small" data-quality-open="${esc(report.assetId)}">查看同币条目</button></div></article>`).join('')}${failed.length ? `<details><summary>最近未通过的只读复核</summary>${failed.map(report => `<p class="help"><strong>${esc(report.symbol || report.name || report.assetId)}</strong>：${(Array.isArray(report.reasons) ? report.reasons : []).filter(reason => typeof reason === 'string').slice(0, 5).map(reason => esc(reason.slice(0, 180))).join('；') || '未通过完整双边报价核验'}</p>`).join('')}</details>` : ''}`;
  }
  function renderPerformance() {
    const body = $('[data-performance-body]'), inventory = executionMode() === 'inventory';
    if (!validPerformance()) { body.innerHTML = `<p class="help" data-performance-unavailable>${!performanceAvailable() ? '本机版本尚未启用实盘证据统计。' : performanceError ? '实盘统计读取失败。' : '正在读取当前执行模式的实盘档案…'}不能据此判断是否达到七成。</p>`; return; }
    const counts = performance.counts, min = Math.max(100, performance.minSamples || 100), target = finite(performance.targetRate) && performance.targetRate >= .7 ? performance.targetRate : .7;
    const evidence = performance.historicalEvidenceMet === true && counts.attempts >= min && finite(performance.wilsonLowerBound) && performance.wilsonLowerBound >= target;
    const result = evidence ? '该历史窗口达到证据门槛，不能保证未来七成。' : counts.attempts < min ? `真实样本不足：${counts.attempts} / ${min}，盈利能力尚未验证。` : '该历史窗口未达到七成证据门槛。';
    body.innerHTML = `<p class="help">统计范围：${inventory ? '双侧库存模式' : '跨链套利模式'}的全部资产；不能作为某一代币的成功率。最近最多 ${Number.isSafeInteger(performance.window?.limit) ? performance.window.limit : 200} 笔真实尝试，失败、未知及未完成均保留在分母。</p><div class="scanner-board-counts">${Object.entries(labels).map(([key, label]) => `<div><span>${label}</span><strong data-performance-count="${key}">${counts[key]}</strong></div>`).join('')}</div><p data-performance-rate>已观察盈利比例：${counts.attempts ? percent(performance.observedRate) : '尚无真实样本'}</p><p data-performance-lower>95% Wilson 区间下限：${counts.attempts ? percent(performance.wilsonLowerBound) : '尚无统计'}</p><p class="help" data-performance-evidence>${esc(result)}</p><p class="help">历史门槛：至少 ${min} 笔真实尝试且 95% Wilson 区间下限不低于 ${percent(target)}。仅核对本机归档回执，不独立联网验证；收益按稳定币面值和原生币参考汇率折算。统计区间依赖样本独立且行情稳定，不能承诺未来利润或成功率。</p>${inventory ? '<p class="help">库存模式仅统计已确认现金价差；未包含未来补库费用和风险，不代表库存闭环利润。</p>' : ''}`;
  }
  function render() { if (container) { renderQuality(); renderPerformance(); } }
  async function refresh({ force = false } = {}) {
    if (!container || pending || changing) return pending;
    const mode = executionMode();
    if (!force && lastPerformanceMode === mode && Date.now() - lastReadAt < POLL_MS) { render(); return; }
    const view = generation, ticket = ++request, requestController = new AbortController(); controller = requestController;
    const operation = (async () => {
      const results = await Promise.allSettled([
        qualityAvailable() ? Promise.resolve().then(() => api('/api/opportunities/quality', { signal: requestController.signal })) : Promise.resolve(null),
        performanceAvailable() ? Promise.resolve().then(() => api('/api/performance?executionMode=' + mode, { signal: requestController.signal })) : Promise.resolve(null)
      ]);
      if (!container || view !== generation || ticket !== request) return;
      qualityError = results[0].status !== 'fulfilled'; quality = qualityError ? null : results[0].value;
      performanceError = results[1].status !== 'fulfilled'; performance = performanceError ? null : results[1].value;
      lastPerformanceMode = mode; lastReadAt = Date.now();
    })().finally(() => {
      if (ticket === request) { pending = null; controller = null; }
      if (container && view === generation && ticket === request) render();
    });
    pending = operation; render(); return operation;
  }
  async function toggle() {
    if (!container || changing || pending || !qualityAvailable() || !quality || qualityError || quality.busy) return;
    const view = generation, enabled = quality.enabled !== true; changing = true; render();
    try {
      await Promise.resolve().then(() => api('/api/opportunities/quality/enabled', { method: 'POST', body: { enabled } }));
      if (container && view === generation) toast(enabled ? '已开启自动只读复核；不会自动交易' : '已停止自动只读复核');
    } catch { if (container && view === generation) toast('只读复核设置未能保存，请检查本机服务', true); }
    finally { changing = false; if (container && view === generation) { render(); void refresh({ force: true }); } }
  }
  function mount(next) {
    if (!next) return;
    const wasUnmounted = !container;
    if (container !== next) { generation++; controller?.abort(); pending = null; controller = null; container = next; shell(); }
    render(); if (!timer) timer = setInterval(() => { render(); void refresh(); }, 1000);
    void refresh({ force: wasUnmounted });
  }
  function unmount() { generation++; request++; controller?.abort(); controller = null; pending = null; clearInterval(timer); timer = null; container = null; }
  return { mount, unmount, refresh };
}
