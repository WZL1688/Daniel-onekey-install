const POLL_MS = 8000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const ms = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const date = value => Number.isFinite(ms(value)) ? new Date(ms(value)).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
const money = value => finite(value) ? '$' + value.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '未知';
const raw = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,77})$/.test(value);
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
const sameAddress = (left,right) => address(left) && address(right) && left.toLowerCase() === right.toLowerCase();
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\u0000-\u001f\u007f]/.test(value);
const statuses = { passed: '通过', blocked: '未通过', warning: '需留意' };
const jobNames = { preparing: '准备授权', executing: '等待签名与链上确认', completed: '授权已确认，请重新预检', needs_review: '授权结果待人工核对', blocked: '授权未发送或被拦截' };

/** Local readiness and explicit finite approval, never a trading switch. */
export function createLiveReadinessPanel({ api, toast = () => {}, getState = () => null, onOpenSettings = () => {} }) {
  let container = null, generation = 0, request = 0, controller = null, timer = null, pending = null;
  let snapshot = null, approvals = null, readError = false, approvalError = false, changing = false, lastReadAt = 0;
  let intent = null, intentBinding = null, actionMessage = '', approvalRequest = null;
  const $ = selector => container?.querySelector(selector);
  const mode = () => getState()?.config?.mode === 'live' ? 'live' : 'demo';
  const feature = () => getState()?.features?.liveReadiness === true;
  const approvalFeature = () => getState()?.features?.bnbApprovals === true;
  const binding = () => {
    const state = getState();
    return JSON.stringify([mode(), state?.engine?.configRevision, state?.policyFingerprint, String(state?.wallets?.bnb?.address || '').toLowerCase(), state?.wallets?.bnb?.canSign === true, state?.engine?.pausedReason || '']);
  };
  function current(report) {
    const state = getState();
    return Boolean(report?.readOnly === true && report.executable === false && report.mode === 'live' && id(report.id) &&
      Number.isFinite(ms(report.expiresAt)) && ms(report.expiresAt) > Date.now() && report.status !== 'stale' &&
      report.parentMode === mode() && Number.isSafeInteger(report.parentRevision) && report.parentRevision === state?.engine?.configRevision &&
      typeof report.parentPolicyFingerprint === 'string' && report.parentPolicyFingerprint === state?.policyFingerprint && !state?.engine?.pausedReason);
  }
  function validIntentAmount() {
    if (!intent || !approvalRequest || !raw(intent.amountRaw) || !raw(intent.requiredRaw) || !raw(intent.currentRaw)) return false;
    const required=BigInt(intent.requiredRaw),current=BigInt(intent.currentRaw),amount=BigInt(intent.amountRaw);
    if(required<=0n || required>=(1n<<256n)-1n || required!==BigInt(approvalRequest.requiredRaw) || !sameAddress(intent.tokenAddress,approvalRequest.tokenAddress) || !sameAddress(intent.spender,approvalRequest.spender))return false;
    return current<required && (intent.action==='reset' ? current>0n && amount===0n : intent.action==='approve' && current===0n && amount===required);
  }
  function liveReady(report) {
    const app=getState(),quote=report?.opportunity;
    return current(report) && report.readyForLive===true && report.simulationVerified===true && mode()==='live' && app?.config?.executionMode==='inventory' && ['bnb','solana'].every(chain=>app?.wallets?.[chain]?.canSign===true) && Array.isArray(report.checks) && report.checks.length>0 && report.checks.every(row=>['passed','warning'].includes(row?.status)) && finite(quote?.amountUsd) && quote.amountUsd>=1 && quote.amountUsd<=10 && finite(quote.netProfitUsd) && finite(quote.stressNetProfitUsd) && quote.netProfitUsd>=Math.max(0,app?.config?.risk?.minProfitUsd||0) && quote.stressNetProfitUsd>=Math.max(0,app?.config?.risk?.minProfitUsd||0) && finite(quote.gasUsd) && quote.gasUsd>=0 && (!finite(app?.config?.risk?.amountUsd) || Math.abs(quote.amountUsd-app.config.risk.amountUsd)<1e-10);
  }
  function canSendIntent() {
    return Boolean(intent && validIntentAmount() && id(intent.id) && address(intent.tokenAddress) && address(intent.spender) && address(intent.owner) && raw(intent.amountRaw) &&
      ['approve', 'reset'].includes(intent.action) && finite(intent.feeNative) && intent.feeNative >= 0 && finite(intent.feeUsd) && intent.feeUsd >= 0 &&
      Number.isFinite(ms(intent.expiresAt)) && ms(intent.expiresAt) > Date.now() && intentBinding === binding() &&
      mode() === 'live' && sameAddress(intent.owner,getState()?.wallets?.bnb?.address) && getState()?.wallets?.bnb?.canSign === true && !getState()?.engine?.pausedReason && !getState()?.engine?.configuring && !getState()?.engine?.busy &&
      !approvals?.busy && !readError && !approvalError && approvalFeature());
  }
  function shell() {
    container.innerHTML = `<section class="card live-readiness-panel" aria-label="实盘预检与有限授权"><div class="card-header scanner-board-heading"><div><h2>实盘预检与有限授权</h2><p class="help">检查当前双侧库存配置；预检只读，不签名、不下单。</p></div></div><div class="card-body"><div class="form-actions"><button type="button" class="button secondary small" data-live-check>预检当前配置币对</button><button type="button" class="button secondary small" data-live-read>刷新预检记录</button><button type="button" class="button text small" data-live-settings>查看钱包与路线设置</button></div><p class="help" data-live-status role="status" aria-live="polite"></p><div data-live-report></div><div data-live-approval-review></div><p class="help" data-live-action role="status" aria-live="polite"></p><p class="help" data-live-approval-job></p><p class="help">预检核对真实余额、双腿报价、授权、费用和未签名交易模拟；通过只代表当前条件，不保证成交或盈利，也不是七成成功率证明。当前预检针对双侧库存模式，跨链流程需单独核验。</p></div></section>`;
    $('[data-live-check]').addEventListener('click', () => { void check(); });
    $('[data-live-read]').addEventListener('click', () => { void refresh({ force: true }); });
    $('[data-live-settings]').addEventListener('click', onOpenSettings);
    $('[data-live-report]').addEventListener('click', event => {
      const button = event.target.closest('[data-live-prepare]');
      if (button && container?.contains(button)) void prepare(Number(button.dataset.livePrepare));
    });
    $('[data-live-approval-review]').addEventListener('click', event => {
      if (event.target.closest('[data-live-approval-send]')) void executeApproval();
      if (event.target.closest('[data-live-approval-cancel]')) { intent = null; intentBinding = null; approvalRequest = null; render(); }
    });
  }
  function render() {
    if (!container) return;
    const report = snapshot?.report, fresh = current(report), state = getState();
    const busy = changing || Boolean(pending || snapshot?.busy || approvals?.busy || state?.engine?.busy || state?.engine?.configuring);
    $('[data-live-check]').disabled = !feature() || busy || Boolean(state?.engine?.busy || state?.engine?.configuring);
    $('[data-live-read]').disabled = !feature() || busy;
    $('[data-live-status]').textContent = !feature() ? '本机版本尚未启用实盘预检。' : readError ? '预检记录读取失败，请检查本机服务。' : changing ? '正在处理请求；不会自动启动套利。' : snapshot?.busy ? '正在进行只读实盘预检。' : report ? fresh ? liveReady(report) ? '当前实盘预检通过；执行时仍会重新报价和模拟。' : '当前预检未满足全部实盘条件，请查看逐项结果。' : '预检记录已过期或上下文已变化，请重新预检；下方保留原检查结果。' : '尚无实盘预检记录。配置两链钱包、RPC、同币映射及路线后点击预检。';
    if (!feature() || readError || !report) $('[data-live-report]').innerHTML = '';
    else {
      const rows = Array.isArray(report.checks) ? report.checks.filter(row=>row&&typeof row==='object') : [];
      const items = Array.isArray(report.approvals) ? report.approvals : [];
      const opportunity = report.opportunity || {};
      $('[data-live-report]').innerHTML = `<div class="opp-meta"><span>检查时间 ${date(report.checkedAt)}</span><span>有效至 ${date(report.expiresAt)}</span><span>运行模式：${mode() === 'live' ? '实盘' : '模拟；预检使用真实链上数据'}</span></div>${id(report.assetId) ? `<p class="help">预检资产：<span class="mono opp-address">${esc(report.assetId)}</span></p>` : ''}<div class="opp-price-gap"><span>本笔金额 ${money(opportunity.amountUsd)}</span><span>保守净价差 ${money(opportunity.netProfitUsd)}</span><span>压力后估算 ${money(opportunity.stressNetProfitUsd)}</span></div><ul class="opp-reasons" data-live-checks>${rows.map(row => `<li><strong>${esc(row.label || row.id || '检查项')}</strong> · ${esc(statuses[row.status] || '未知')}：${esc(typeof row.message === 'string' ? row.message.slice(0, 500) : '缺少检查结果')}</li>`).join('')}</ul>${items.length ? `<div data-live-required-approvals><h3>BNB 授权额度</h3><p class="help">只可审阅本笔准确额度，不发送无限授权。清零旧额度后须重新预检并再次审阅，不会自动连续发送。</p>${items.map((item, index) => !item || !address(item.tokenAddress) || !address(item.spender) || !raw(item.currentRaw) || !raw(item.requiredRaw) ? '' : `<article class="opp-pool-trace"><strong>${esc(item.side || 'BNB')} · ${item.action === 'reset' ? '需清零旧额度' : '额度待核对'}</strong><div class="mono opp-address">代币 ${esc(item.tokenAddress)}</div><div class="mono opp-address">Spender ${esc(item.spender)}</div><p class="help">当前额度（原始数量）${esc(item.currentRaw)}<br>本笔所需（原始数量）${esc(item.requiredRaw)}</p>${item.basis === 'expected-buy-output' ? '<p class="help">卖出额度按当前买入预期到账量预留；实际到账超出时会暂停核对，不自动扩大授权。</p>' : ''}<button type="button" class="button secondary small" data-live-prepare="${index}" ${!fresh || !approvalFeature() || busy ? 'disabled' : ''}>审阅本笔有限授权</button></article>`).join('')}</div>` : ''}`;
    }
    if (!intent) $('[data-live-approval-review]').innerHTML = '';
    else {
      const valid = canSendIntent(), reset = intent.action === 'reset';
      $('[data-live-approval-review]').innerHTML = `<section class="notice blue" data-live-intent><div><h3>${reset ? '清零旧授权审阅' : '本笔有限授权审阅'}</h3><p><strong>这一步会发送真实 BNB 授权交易并支付 Gas。</strong>不会启动套利。</p><div class="mono opp-address">钱包 ${esc(intent.owner)}</div><div class="mono opp-address">代币合约 ${esc(intent.tokenAddress)}</div><div class="mono opp-address">Spender ${esc(intent.spender)}</div><p>授权原始数量：<strong data-live-intent-raw>${esc(intent.amountRaw)}</strong>（未作精度换算）</p><p>预计 Gas：${finite(intent.feeNative) ? esc(intent.feeNative) : '未知'} BNB · ${money(intent.feeUsd)}<br>审阅有效至 ${date(intent.expiresAt)}</p>${reset ? '<p>本次仅将已有额度清零。确认后请重新预检，再审阅本笔准确额度；不会自动发送第二笔。</p>' : '<p>仅授权报告中本笔所需额度，不使用无限授权。</p>'}${typeof intent.reason === 'string' ? `<p class="help">${esc(intent.reason.slice(0, 400))}</p>` : ''}<div class="form-actions"><button type="button" class="button danger small" data-live-approval-send ${!valid || busy ? 'disabled' : ''}>${reset ? '确认清零旧额度' : '确认发送本笔有限授权'}</button><button type="button" class="button secondary small" data-live-approval-cancel ${changing ? 'disabled' : ''}>取消审阅</button></div>${!valid ? `<p class="help">${mode() !== 'live' ? '发送真实授权须在设置中明确选择实盘模式，然后重新预检和审阅。' : '审阅已过期、钱包不能签名或配置已变化，请重新预检和审阅。'}</p>` : ''}</div></section>`;
    }
    $('[data-live-action]').textContent = actionMessage;
    const job = approvals?.job;
    $('[data-live-approval-job]').textContent = approvalError ? '授权记录读取失败，请核对交易档案。' : job ? `有限授权：${jobNames[job.status] || '待核对'}${typeof job.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(job.hash) ? ` · 哈希 ${job.hash}` : ''}。不自动重试。` : '';
  }
  async function refresh({ force = false } = {}) {
    if (!container || pending || changing) return pending;
    if (!force && Date.now() - lastReadAt < POLL_MS) { render(); return; }
    const view = generation, ticket = ++request, abort = new AbortController(); controller = abort;
    const operation = (async () => {
      const values = await Promise.allSettled([
        feature() ? api('/api/live-readiness', { signal: abort.signal }) : Promise.resolve(null),
        approvalFeature() ? api('/api/bnb-approvals', { signal: abort.signal }) : Promise.resolve(null)
      ]);
      if (!container || generation !== view || ticket !== request) return;
      readError = values[0].status !== 'fulfilled'; snapshot = readError ? null : values[0].value;
      approvalError = values[1].status !== 'fulfilled'; approvals = approvalError ? null : values[1].value;
      lastReadAt = Date.now();
    })().finally(() => { if (ticket === request) { pending = null; controller = null; } if (container && view === generation) render(); });
    pending = operation; render(); return operation;
  }
  async function check({ assetId } = {}) {
    if (!container || changing || pending || !feature() || snapshot?.busy) return;
    const view = generation; changing = true; intent = null; intentBinding = null; approvalRequest = null; actionMessage = ''; render();
    try {
      const result = await api('/api/live-readiness/check', { method: 'POST', body: { expectedMode: mode(), ...(id(assetId) ? { assetId } : {}) } });
      if (!container || generation !== view) return;
      snapshot = result?.report ? result : { ...snapshot, busy: false, report: result };
      readError = false; actionMessage = '只读预检已完成；没有签名或下单。';
    } catch { if (container && generation === view) { readError = true; actionMessage = '实盘预检未完成，请核对本机连接与设置后重试。'; toast(actionMessage, true); } }
    finally { if (generation === view) changing = false; if (container && generation === view) render(); }
  }
  async function prepare(index) {
    const report = snapshot?.report;
    if (!container || changing || pending || !approvalFeature() || !current(report) || !Number.isSafeInteger(index) || index < 0 || index >= (report.approvals?.length || 0)) return;
    const item=report.approvals[index];
    if (!item || !address(item.tokenAddress) || !address(item.spender) || !raw(item.requiredRaw) || !raw(item.currentRaw)) return;
    const view = generation, before = binding(); changing = true; intent = null; approvalRequest = {tokenAddress:item.tokenAddress,spender:item.spender,requiredRaw:item.requiredRaw}; actionMessage = ''; render();
    try {
      const result = await api('/api/bnb-approvals/prepare', { method: 'POST', body: { reportId: report.id, index, expectedMode: mode() } });
      if (!container || generation !== view || binding() !== before) return;
      intent = result?.intent || result; intentBinding = before; actionMessage = '请核对授权合约、Spender、准确额度与 Gas；审阅不会自动发送。';
    } catch { if (container && generation === view) { actionMessage = '有限授权未能准备，请重新预检后核对原因。'; toast(actionMessage, true); } }
    finally { if (generation === view) changing = false; if (container && generation === view) render(); }
  }
  async function executeApproval() {
    if (!container || changing || pending || !canSendIntent()) return;
    const view = generation, intentId = intent.id; changing = true; actionMessage = ''; render();
    try {
      await api('/api/bnb-approvals/execute', { method: 'POST', body: { intentId, expectedMode: mode(), confirmed: true } });
      if (!container || generation !== view) return;
      intent = null; intentBinding = null; approvalRequest = null; actionMessage = '有限授权任务已提交；请在钱包确认并查看交易档案，不会自动套利或连续授权。';
    } catch { if (container && generation === view) { intent = null; intentBinding = null; approvalRequest = null; actionMessage = '授权请求未完成或结果待核对，请查看交易档案，禁止自动重试。'; toast(actionMessage, true); } }
    finally { if (generation === view) changing = false; if (container && generation === view) { render(); void refresh({ force: true }); } }
  }
  function mount(node) {
    if (!node) return;
    const first = !container;
    if (container !== node) { generation++; controller?.abort(); pending = null; controller = null; container = node; intent = null; intentBinding = null; approvalRequest = null; shell(); }
    render(); if (!timer) timer = setInterval(() => { render(); void refresh(); }, 1000);
    void refresh({ force: first });
  }
  function unmount() { generation++; request++; controller?.abort(); controller = null; pending = null; clearInterval(timer); timer = null; container = null; intent = null; intentBinding = null; approvalRequest = null; changing = false; }
  return { mount, unmount, refresh, check };
}
