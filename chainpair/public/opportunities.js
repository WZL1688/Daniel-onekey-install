const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = value => typeof value === 'number' && Number.isFinite(value) ? '$' + value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) < .01 ? 8 : 4 }) : '未知';
const num = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 3 }) : '未知';
const date = value => { if (!value) return '未知'; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '未知' : parsed.toLocaleString('zh-CN', { hour12: false }); };
const approved = asset => asset?.confirmed === true || asset?.mappingConfirmed === true || asset?.mapping?.confirmed === true;
const asMillis = value => typeof value === 'number' ? value : Date.parse(value);
const chainName = chain => chain === 'bnb' ? 'BNB Chain' : chain === 'solana' ? 'Solana' : '待扫描';
const chainFields = (prefix, chain, value = {}, readAddress = false) => `<fieldset class="opp-chain-fields"><legend>${chainName(chain)}</legend><label class="field"><span>代币合约 / Mint</span><input name="${prefix}${chain}.address" value="${esc(value.address)}" maxlength="100" ${readAddress ? 'readonly' : 'required'} autocomplete="off"></label><label class="field"><span>代币精度</span><input name="${prefix}${chain}.decimals" type="number" min="0" max="${chain === 'solana' ? 9 : 36}" step="1" value="${value.decimals === null || value.decimals === undefined ? '' : esc(value.decimals)}" required></label><label class="field"><span>核对后的交易池</span><input name="${prefix}${chain}.poolAddress" value="${esc(value.poolAddress)}" maxlength="100" required autocomplete="off"></label></fieldset>`;

export function createOpportunitiesView({ api, toast, getState = () => null }) {
  let container = null, state = null, generation = 0, requestId = 0, inFlight = false, lastRead = 0, page = 1, filter = 'all', search = '';
  const drafts = new Map();
  const $ = selector => container?.querySelector(selector);
  const $$ = selector => [...(container?.querySelectorAll(selector) || [])];
  const currentMode = () => state?.execution?.mode || getState()?.config?.mode || 'demo';
  const automatic = () => Boolean(state?.execution?.running && state?.execution?.executionMode === 'inventory' && (state?.execution?.scanApprovedAssets ?? true));
  function find(id) { return state?.assets?.find(asset => asset.id === id); }
  function reportFor(id) { return state?.rows?.find(row => row.asset?.id === id || row.assetId === id || row.id === id); }
  function remember(form) {
    const id = form.dataset.approval, asset = find(id); if (!asset) return;
    drafts.set(id, { revision: asset.revision, values: Object.fromEntries([...form.elements].filter(e => e.name).map(e => [e.name, e.type === 'checkbox' ? e.checked : e.value])) });
  }
  function restore(form, asset) {
    const draft = drafts.get(asset.id); if (!draft) return;
    if (draft.revision !== asset.revision) { drafts.delete(asset.id); return; }
    for (const [name, value] of Object.entries(draft.values)) if (form.elements[name]) {
      if (form.elements[name].type === 'checkbox') form.elements[name].checked = Boolean(value);
      else form.elements[name].value = value;
    }
  }
  function renderStatus() {
    if (!container || !state) return;
    $('#opp-reason').textContent = state.reason || '等待扫描';
    $('#opp-updated').textContent = date(state.updatedAt);
    $('#opp-directory-time').textContent = date(state.directoryUpdatedAt);
    $('#opp-budget').textContent = `近24小时请求 ${num(state.usage?.day)} / ${num(state.settings?.maxRequestsPerDay)} · 累计 ${num(state.usage?.total)} · 下次允许请求 ${date(state.nextRequestAt)}`;
    $('#opp-enable').textContent = state.enabled ? '停止行情扫描' : '开启行情扫描';
    $('#opp-auto').textContent = automatic() ? '暂停清单自动执行' : `开启${currentMode() === 'live' ? '实盘' : '模拟'} · 已核验清单自动执行`;
    $('#opp-mode').textContent = currentMode() === 'live' ? '当前交易：实盘' : '当前交易：模拟';
    $('#opp-mode').className = `badge ${currentMode() === 'live' ? 'red' : 'amber'}`;
    $('#opp-execution').textContent = state.execution?.busy ? `正在执行 ${state.execution.activeAssetId || '库存任务'}；后续进度见交易档案。` : state.execution?.lastError || (automatic() ? '自动执行已开启，只处理用户已核验的同币清单。' : '自动交易默认关闭；目录发现和行情扫描不会启动交易。');
    $('#opp-auto').disabled = Boolean(state.execution?.busy && !automatic());
    $('#opp-scan').disabled = inFlight;
    $('#opp-discover').disabled = inFlight;
  }
  function fillSettings() {
    const form = $('#opp-settings'); if (!form || !state?.settings) return;
    for (const [key, value] of Object.entries(state.settings)) if (form.elements[key]) form.elements[key].value = value;
    if (form.elements.pollSeconds) form.elements.pollSeconds.value = Number(state.settings.pollIntervalMs || 60000) / 1000;
    if (form.elements.minSpreadPercent) form.elements.minSpreadPercent.value = Number(state.settings.minSpreadBps || 0) / 100;
  }
  function filteredAssets() {
    return (state?.assets || []).filter(asset => (!search || `${asset.name} ${asset.symbol} ${asset.chains?.bnb?.address} ${asset.chains?.solana?.address}`.toLowerCase().includes(search.toLowerCase())) && (filter === 'approved' ? approved(asset) : filter === 'candidate' ? reportFor(asset.id)?.stage === 'candidate' : true));
  }
  function renderAssets() {
    if (!state || !container) return;
    const editor = document.activeElement?.closest('[data-approval]');
    if (editor) remember(editor);
    const focusedName = editor && document.activeElement?.name;
    const focusedId = editor?.dataset.approval;
    const selection = editor && typeof document.activeElement.selectionStart === 'number' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const assets = filteredAssets(), pages = Math.max(1, Math.ceil(assets.length / 10)); page = Math.min(page, pages);
    $('#opp-assets').innerHTML = assets.length ? assets.slice((page - 1) * 10, page * 10).map(asset => {
      const row = reportFor(asset.id), evaluation = row?.evaluation, isApproved = approved(asset), mappingWarning = asset.mapping?.warning || asset.mappingWarning || ''; 
      const fresh = evaluation?.mode === currentMode() && evaluation?.assetRevision === asset.revision && Number.isFinite(asMillis(evaluation?.expiresAt)) && asMillis(evaluation.expiresAt) > Date.now();
      const executable = isApproved && asset.enabled !== false && evaluation?.executable === true && fresh && !state.execution?.busy;
      const reasons = [...(row?.reasons || []), ...(evaluation?.reasons || [])];
      const pools = row?.market || {};
      return `<article class="opp-asset" data-asset-id="${esc(asset.id)}"><div class="opp-asset-heading"><div><h3>${esc(asset.symbol || '未命名')} <small>${esc(asset.name || '')}</small></h3><p class="help">${esc(asset.source || 'manual')} · ${asset.enabled === false ? '已停用' : '参与扫描'} · ${row?.observedAt ? date(row.observedAt) : '尚未扫描'}</p></div><span class="badge ${isApproved ? 'neutral' : 'amber'}">${isApproved ? '用户已核验映射' : '同币关系待核验'}</span></div><div class="opp-pair-grid">${['bnb', 'solana'].map(chain => `<div><strong>${chainName(chain)}</strong><div class="mono opp-address">${esc(asset.chains?.[chain]?.address || '未配置')}</div><div class="opp-quote-price">${usd(pools[chain]?.priceUsd)}</div><p class="help">池流动性 ${usd(pools[chain]?.liquidityUsd)}<br>采集 ${date(pools[chain]?.observedAt)} · 源更新时间未提供</p></div>`).join('')}</div><div class="opp-price-gap"><span>参考方向 <b>${row?.buyChain ? `${chainName(row.buyChain)} → ${chainName(row.sellChain)}` : '待扫描'}</b></span><span>参考价差 <b>${typeof row?.spreadBps === 'number' ? num(row.spreadBps / 100) + '%' : '未知'}</b></span><span>参考毛差额 <b>${usd(row?.indicativeGrossUsd)}</b></span></div><p class="help">参考价格未扣完整费用，不能据此认定可执行；用户核验映射也不等于代币安全。</p>${evaluation ? `<div class="opp-evaluation"><strong>${evaluation.executable && fresh ? '当前报价检查通过' : fresh ? '当前报价未通过' : '报价已过期，请重新复核'}</strong><div class="opp-price-gap"><span>报价金额 ${usd(evaluation.amountUsd)}</span><span>预计现金流价差 ${usd(evaluation.netProfitUsd)}</span><span>Gas / 网络费 ${usd(evaluation.gasUsd)}</span><span>滑点成本 ${usd(evaluation.slippageUsd)}</span></div><p class="help">有效至 ${date(evaluation.expiresAt)}；未含未来补库存成本，实际提交前会再次核对。</p></div>` : '<p class="help">费用与库存尚未报价核验。</p>'}${reasons.length ? `<ul class="opp-reasons">${[...new Set(reasons)].map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}<div class="opp-actions"><button class="button secondary small" data-opp-quote="${esc(asset.id)}" ${!isApproved || state.execution?.busy ? 'disabled' : ''}>复核双边报价与库存</button><button class="button small" data-opp-execute="${esc(asset.id)}" ${!executable ? 'disabled' : ''}>${currentMode() === 'live' ? '实盘执行此机会' : '模拟执行此机会'}</button>${isApproved ? `<button class="button secondary small" data-opp-revoke="${esc(asset.id)}">撤销映射确认</button>` : ''}<button class="button secondary small" data-opp-delete="${esc(asset.id)}">移除</button></div>${mappingWarning ? `<div class="error-box section-gap">${esc(mappingWarning)}<br>请独立核对后移除此条目，手工添加正确的两链地址，再重新确认。${asset.sourceProposal ? `<div class="mono opp-address">目录候选 BNB：${esc(asset.sourceProposal.bnb)}<br>目录候选 Solana：${esc(asset.sourceProposal.solana)}</div>` : ''}</div>` : ''}${!isApproved && !mappingWarning ? `<details class="opp-approval"><summary>核对并确认同币映射</summary><form data-approval="${esc(asset.id)}"><p class="help">请核对发行方、两链合约及数量换算关系。此模式仅支持明确 1:1 的同一资产；包装资产、同名币和变基资产不能按名称认定等价。</p><div class="opp-pair-grid">${['bnb', 'solana'].map(chain => chainFields('', chain, { ...asset.chains?.[chain], poolAddress: asset.chains?.[chain]?.poolAddress || pools[chain]?.poolAddress || '' }, true)).join('')}</div><label class="field"><span>核验依据（官方发行说明或已核验资产映射）</span><textarea name="evidence" maxlength="1000" required rows="2">${esc(asset.mappingEvidence || asset.evidence || '')}</textarea></label><label class="check-row"><input type="checkbox" name="confirmed" required><span>我已核对两链地址、精度和交易池，确认它们代表 1:1 的同一资产。</span></label><button type="submit" class="button secondary small">保存此映射确认</button></form></details>` : `<p class="help opp-evidence">核验依据：${esc(asset.mappingEvidence || asset.evidence || asset.mapping?.evidence || '已由用户确认')}</p>`}</article>`;
    }).join('') : '<div class="empty-state"><strong>当前没有同币机会记录</strong><p>先读取同币目录，或手工添加已核对的两链地址；目录记录不会自动获得交易资格。</p></div>';
    for (const form of $$('[data-approval]')) { const asset = find(form.dataset.approval); if (asset) restore(form, asset); }
    if (focusedId && focusedName) { const form = $$('[data-approval]').find(node => node.dataset.approval === focusedId), input = form?.elements[focusedName]; if (input) { form.closest('details').open = true; input.focus({ preventScroll: true }); if (selection) input.setSelectionRange(...selection); } }
    $('#opp-page').textContent = `${assets.length} 项 · 第 ${page} / ${pages} 页`;
    $('#opp-prev').disabled = page <= 1; $('#opp-next').disabled = page >= pages;
  }
  async function read({ force = false, initial = false } = {}) {
    if (!container || (!force && (inFlight || Date.now() - lastRead < 8000))) return;
    const ticket = generation, request = ++requestId; inFlight = true;
    try {
      const next = await api('/api/opportunities');
      if (!container || generation !== ticket || requestId !== request) return;
      state = next; lastRead = Date.now(); renderStatus(); if (initial) fillSettings(); renderAssets();
    } catch (error) { if (container && generation === ticket && requestId === request) $('#opp-reason').textContent = error.message; }
    finally { if (requestId === request) inFlight = false; if (container && generation === ticket && requestId === request) renderStatus(); }
  }
  async function mutate(button, path, body, success, method = 'POST') {
    if (button?.disabled) return false;
    const ticket = generation; if (button) button.disabled = true;
    try {
      await api('/api/opportunities' + path, { method, ...(body !== undefined ? { body } : {}) });
      if (!container || generation !== ticket) return false;
      if (success) toast(success); await read({ force: true }); return generation === ticket;
    } catch (error) { if (container && generation === ticket) toast(error.message, true); return false; }
    finally { if (button?.isConnected) button.disabled = false; if (container && generation === ticket) renderStatus(); }
  }
  function bodyChains(form) {
    return Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { address: form.elements[`${chain}.address`].value.trim(), decimals: Number(form.elements[`${chain}.decimals`].value), poolAddress: form.elements[`${chain}.poolAddress`].value.trim() }]));
  }
  function mount(node) {
    if (container === node && $('#opportunities-view')) { void read(); return; }
    unmount(); container = node; generation++; page = 1; filter = 'all'; search = ''; lastRead = 0;
    node.innerHTML = `<div class="market-subnav" aria-label="行情视图"><button class="button secondary small" data-market-view="arbitrage">套利看板</button><button class="button secondary small" data-market-view="radar">Meme 雷达</button><button class="button small" data-market-view="opportunities" aria-current="page">同币机会</button></div><section id="opportunities-view"><div class="page-heading"><div><div class="eyebrow">TWO-CHAIN OPPORTUNITY SCANNER</div><h1>同币机会扫描</h1><p>发现 BNB／Solana 的同币价差，按真实报价和双侧库存筛选。</p></div><span class="badge amber" id="opp-mode">读取交易模式</span></div><div class="notice blue"><span class="notice-icon">⇄</span><p><strong>双侧库存，不逐笔跨链</strong>　低价链买入确认后，在高价链卖出已有同币。两侧须准备稳定币、目标币和 Gas；库存不足或单边失败时暂停，不自动跨链补库。</p></div><section class="card opp-control"><div class="card-body"><strong id="opp-reason">读取本机扫描状态…</strong><p class="help">发现与行情扫描只读，自动交易需单独开启。扫描真实外部行情，与套利模拟／实盘模式分别控制。</p><div class="opp-actions"><button id="opp-discover" class="button secondary">读取同币目录</button><button id="opp-scan" class="button secondary">扫描当前清单</button><button id="opp-enable" class="button secondary">开启行情扫描</button><button id="opp-auto" class="button">开启模拟 · 已核验清单自动执行</button></div><div class="opp-meta"><span>目录更新 <b id="opp-directory-time">未知</b></span><span>行情更新 <b id="opp-updated">未知</b></span></div><p id="opp-budget" class="help"></p><p id="opp-execution" class="help"></p></div></section><div class="opp-config-grid"><details class="card opp-details"><summary>扫描条件与请求预算</summary><form id="opp-settings" class="card-body"><div class="form-grid"><label class="field"><span>轮询间隔（秒）</span><input type="number" name="pollSeconds" min="30" max="3600" step="1" required></label><label class="field"><span>最低双侧池流动性（USD）</span><input type="number" name="minLiquidityUsd" min="0" step="any" required></label><label class="field"><span>参考价差门槛（%）</span><input type="number" name="minSpreadPercent" min="0" step=".01" required></label><label class="field"><span>每轮最多扫描资产</span><input type="number" name="maxAssetsPerScan" min="1" max="100" step="1" required></label><label class="field"><span>近24小时请求上限</span><input type="number" name="maxRequestsPerDay" min="1" step="1" required></label></div><p class="help">目录关联仅作为候选，不覆盖全市场，不按币名识别同币。公共 API 可能要求账户或限频，以提供方当前规则为准。</p><button type="submit" class="button secondary">保存扫描设置</button></form></details><details class="card opp-details"><summary>手工添加同币地址</summary><form id="opp-add" class="card-body"><div class="form-grid"><label class="field"><span>资产名称</span><input name="name" maxlength="100" required></label><label class="field"><span>符号（仅作显示）</span><input name="symbol" maxlength="32"></label></div><div class="opp-pair-grid">${['bnb', 'solana'].map(chain => chainFields('', chain)).join('')}</div><p class="help">手工添加也需在下方逐项核验 1:1 映射；添加和确认不会启动交易。</p><button type="submit" class="button secondary">添加到观察清单</button></form></details></div><section class="card"><div class="card-header opp-list-header"><h2>两链资产清单</h2><div class="opp-list-filters"><input id="opp-search" type="search" placeholder="搜索名称或合约地址" aria-label="搜索同币清单"><select id="opp-filter" aria-label="筛选同币清单"><option value="all">全部资产</option><option value="approved">用户已核验</option><option value="candidate">参考价差候选</option></select></div></div><div id="opp-assets"><div class="empty-state">读取清单…</div></div><div class="pager"><span id="opp-page">第1页</span><div class="pager-buttons"><button id="opp-prev" class="button secondary small" disabled>上一页</button><button id="opp-next" class="button secondary small" disabled>下一页</button></div></div></section></section>`;
    $('#opp-discover').addEventListener('click', event => mutate(event.currentTarget, '/discover', {}, '同币目录读取完成；新地址仍需核验'));
    $('#opp-scan').addEventListener('click', event => mutate(event.currentTarget, '/scan', {}, '行情扫描已请求；参考价差需复核交易报价'));
    $('#opp-enable').addEventListener('click', event => mutate(event.currentTarget, '/enabled', { enabled: !state?.enabled }, state?.enabled ? '行情扫描已停止' : '行情扫描已开启'));
    $('#opp-auto').addEventListener('click', event => mutate(event.currentTarget, '/automation', { enabled: !automatic(), expectedMode: currentMode() }, automatic() ? '自动执行已暂停；在途交易继续核对' : '已开启已核验清单的库存执行，请查看交易档案'));
    $('#opp-settings').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget;
      const settings = { pollIntervalMs: Number(form.elements.pollSeconds.value) * 1000, minLiquidityUsd: Number(form.elements.minLiquidityUsd.value), minSpreadBps: Number(form.elements.minSpreadPercent.value) * 100, maxAssetsPerScan: Number(form.elements.maxAssetsPerScan.value), maxRequestsPerDay: Number(form.elements.maxRequestsPerDay.value) };
      await mutate(form.querySelector('button[type=submit]'), '/settings', { settings }, '扫描设置已保存');
    });
    $('#opp-add').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget;
      const asset = { name: form.elements.name.value.trim(), symbol: form.elements.symbol.value.trim(), enabled: true, chains: bodyChains(form) };
      if (await mutate(form.querySelector('button[type=submit]'), '/assets', { asset }, '地址已加入观察清单，尚未确认映射')) form.reset();
    });
    $('#opp-assets').addEventListener('input', event => { const form = event.target.closest('[data-approval]'); if (form) remember(form); });
    $('#opp-assets').addEventListener('submit', async event => {
      const form = event.target.closest('[data-approval]'); if (!form) return; event.preventDefault();
      if (!form.elements.confirmed.checked || !form.elements.evidence.value.trim()) return;
      const asset = find(form.dataset.approval); if (!asset) return;
      const body = { id: asset.id, revision: asset.revision, confirmed: true, evidence: form.elements.evidence.value.trim(), chains: bodyChains(form) };
      if (await mutate(form.querySelector('button[type=submit]'), '/approve', body, '同币映射已由你确认；尚未开启交易')) drafts.delete(asset.id);
    });
    $('#opp-assets').addEventListener('click', async event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.oppQuote) await mutate(button, '/quote', { id: button.dataset.oppQuote, revision: find(button.dataset.oppQuote)?.revision, expectedMode: currentMode() }, '双边报价和库存已复核');
      if (button.dataset.oppExecute) await mutate(button, '/execute', { id: button.dataset.oppExecute, revision: find(button.dataset.oppExecute)?.revision, expectedMode: currentMode() }, '库存任务已提交；请在交易档案查看确认结果');
      if (button.dataset.oppRevoke) { const asset = find(button.dataset.oppRevoke); if (asset) await mutate(button, '/approve', { id: asset.id, revision: asset.revision, confirmed: false }, '映射确认已撤销'); }
      if (button.dataset.oppDelete) {
        if (button.dataset.confirm !== 'true') { button.dataset.confirm = 'true'; button.textContent = '确认移除'; setTimeout(() => { if (button.isConnected) { delete button.dataset.confirm; button.textContent = '移除'; } }, 5000); return; }
        const id = button.dataset.oppDelete; if (await mutate(button, '/assets/' + encodeURIComponent(id), undefined, '资产已移出清单', 'DELETE')) drafts.delete(id);
      }
    });
    $('#opp-search').addEventListener('input', event => { search = event.target.value; page = 1; renderAssets(); });
    $('#opp-filter').addEventListener('change', event => { filter = event.target.value; page = 1; renderAssets(); });
    $('#opp-prev').addEventListener('click', () => { page = Math.max(1, page - 1); renderAssets(); });
    $('#opp-next').addEventListener('click', () => { page++; renderAssets(); });
    void read({ force: true, initial: true });
  }
  function unmount() { generation++; requestId++; inFlight = false; container = null; state = null; }
  return { mount, unmount, refresh: read };
}
