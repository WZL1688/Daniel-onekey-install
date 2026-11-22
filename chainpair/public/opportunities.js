const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = value => typeof value === 'number' && Number.isFinite(value) ? '$' + value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) < .01 ? 8 : 4 }) : '未知';
const num = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 3 }) : '未知';
const date = value => { if (!value) return '未知'; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '未知' : parsed.toLocaleString('zh-CN', { hour12: false }); };
const approved = asset => asset?.confirmed === true || asset?.mappingConfirmed === true || asset?.mapping?.confirmed === true;
const asMillis = value => typeof value === 'number' ? value : Date.parse(value);
const chainName = chain => chain === 'bnb' ? 'BNB Chain' : chain === 'solana' ? 'Solana' : '待扫描';
const sourceName = source => source === 'coingecko' ? 'CoinGecko' : source === 'wormhole' ? 'Wormhole 官方映射' : source === 'bundled-wormhole' ? '内置官方映射快照'  : source === 'manual' ? '手工条目' : source || '等待自动发现';
const directoryStatus = status => ({ idle: '等待自动发现', loading: '正在发现', ready: '目录已取得', retrying: '等待自动重试', auth_required: '需要数据源权限', empty: '本次未发现双链条目', error: '请求失败', failed: '请求失败', unavailable: '暂不可用', success: '读取成功', cooldown: '冷却中', stopped: '已停止' }[status] || status || '等待自动发现');
const networkSources = [
  { source: 'bnb-pools', label: 'BNB Chain 池行情', host: 'api.dexscreener.com' },
  { source: 'solana-pools', label: 'Solana 池行情', host: 'api.dexscreener.com' },
  { source: 'coingecko-directory', label: 'CoinGecko 资产目录', host: 'api.coingecko.com' }
];
const networkStatus = status => ({ ok: '连接检测通过', empty: '已连接，未发现有效池／条目', error: '连接检测失败', rate_limited: '请求受限', auth_required: '需要接口权限' }[status] || '尚未检测');
const networkHints = {
  DNS: '域名解析失败，请检查本机 DNS 和代理解析设置。',
  TIMEOUT: '连接超时，请检查网络、代理端口和代理规则后重试。',
  CONNECTION: '连接被拒绝或中断，请确认网络可用，代理程序正在运行。',
  TLS: '证书验证失败，请检查系统时间、证书和代理 HTTPS 设置；请保留证书验证。',
  PROXY: '代理连接失败，请核对本机 HTTP／mixed 端口，勿填写 SOCKS 端口。',
  NETWORK: '行情请求未完成，请检查本机网络或设置本机 HTTP 代理。'
};
const networkReasonCode = value => Object.hasOwn(networkHints, String(value || '').toUpperCase()) ? String(value).toUpperCase() : '';
const diagnosticCode = value => /^(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_CLOSED|FETCH_FAILED|HTTP_\d{3}|DISCOVERY_[A-Z_]+|NETWORK_[A-Z_]+|PROXY_[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(String(value || '')) ? String(value) : '';
const diagnosticHttp = value => Number.isInteger(value) && value >= 100 && value <= 599 ? `HTTP ${value}` : '未收到 HTTP 响应';
function validProxyUrl(value) {
  // Require an explicit local HTTP port; URL.port alone drops an explicit :80.
  const input = String(value || '').trim();
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/i.test(input)) return false;
  const port = Number(input.replace(/\/$/, '').slice(input.lastIndexOf(':') + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
const networkPanel = () => `<details class="card opp-details opp-network-config" open><summary>数据源网络／连接检测</summary><div class="card-body"><p class="help opp-network-intro">所有价格都显示“未知”时，先检测 BNB／Solana 的行情连接。这里只请求公开行情，不读取钱包、不签名，也不会启动交易。</p><form id="opp-network-form" method="post" autocomplete="off"><div class="form-grid"><label class="field"><span>行情网络方式</span><select name="mode"><option value="auto">自动检测环境／Windows 系统代理（推荐）</option><option value="direct">直连</option><option value="proxy">本机 HTTP 代理</option></select></label><label class="field" id="opp-network-proxy-field" hidden><span>本机 HTTP／mixed 代理地址</span><input name="proxyUrl" type="text" maxlength="100" placeholder="例如 http://127.0.0.1:7890" aria-describedby="opp-network-proxy-help" spellcheck="false" autocomplete="off" disabled></label></div><p class="help" id="opp-network-proxy-help">使用 Clash／v2ray 时，请填写程序里实际配置的 HTTP／mixed 端口，例如 7890；示例不会自动填入或启用。仅接受带端口的 http://127.0.0.1、localhost 或 [::1]，不接受 SOCKS、账号或密码。</p><p id="opp-network-validation" class="opp-network-validation" role="alert" hidden></p><div class="opp-actions"><button id="opp-network-test" type="button" class="button">测试行情连接</button><button id="opp-network-save" type="submit" class="button secondary">保存网络设置</button><button id="opp-network-copy" type="button" class="button secondary">复制诊断摘要</button></div><p class="help">测试使用已保存的网络设置；修改后请先保存。仅调整行情网络，不改变交易开关、风控限额或钱包配置。</p></form><div class="opp-network-status" aria-live="polite"><strong id="opp-network-route">网络方式读取中…</strong><p id="opp-network-reason" class="help">尚未检测，代理检测结果不代表行情已经连通。</p><p id="opp-network-times" class="help"></p></div><div id="opp-network-results" class="opp-network-results" aria-live="polite"></div></div></details>`;
const chainFields = (prefix, chain, value = {}, readAddress = false) => `<fieldset class="opp-chain-fields"><legend>${chainName(chain)}</legend><label class="field"><span>代币合约 / Mint</span><input name="${prefix}${chain}.address" value="${esc(value.address)}" maxlength="100" ${readAddress ? 'readonly' : 'required'} autocomplete="off"></label><label class="field"><span>代币精度</span><input name="${prefix}${chain}.decimals" type="number" min="0" max="${chain === 'solana' ? 9 : 36}" step="1" value="${value.decimals === null || value.decimals === undefined ? '' : esc(value.decimals)}" required></label><label class="field"><span>核对后的交易池</span><input name="${prefix}${chain}.poolAddress" value="${esc(value.poolAddress)}" maxlength="100" required autocomplete="off"></label></fieldset>`;
const connectionPanel = () => `<details class="card opp-details opp-source-config"><summary>数据源连接（CoinGecko Key 可选）</summary><div class="card-body"><p id="opp-key-status" class="help">读取本机凭证状态…</p><form id="opp-credentials" method="post" autocomplete="off"><div class="form-grid"><label class="field"><span>CoinGecko Demo API Key</span><input name="apiKey" type="password" maxlength="1000" autocomplete="new-password" required></label><label class="field"><span>本机保险库密码</span><input name="password" type="password" minlength="10" maxlength="1024" autocomplete="new-password" required></label></div><p class="help">Key 用密码加密保存在本机，不回显；已有保险库锁定时，保存后仍保持锁定。无需提供钱包私钥。</p><div class="opp-actions"><button type="submit" class="button secondary">加密保存数据 Key</button><button type="button" id="opp-clear-key" class="button secondary" disabled>移除数据 Key</button></div></form><p class="help">自动发现优先尝试 CoinGecko，也可使用内置官方映射快照；快照为 2026-04-08 的包装资产候选，行情仍需联网，包装资产风险未核验。公共接口权限和费用以提供方当前规则为准。</p><div class="opp-provenance"><a href="https://www.coingecko.com/en/api" target="_blank" rel="noopener noreferrer">CoinGecko 官方数据 API ↗</a><a href="https://github.com/wormhole-foundation/wormhole-connect/blob/267c9a649c74097cdbf5096d1d37cb45e7695a5b/src/config/mainnet/wrappedTokens.ts" target="_blank" rel="noopener noreferrer">Wormhole 官方映射来源 ↗</a></div></div></details>`;

export function createOpportunitiesView({ api, toast, getState = () => null }) {
  let container = null, state = null, generation = 0, requestId = 0, inFlight = false, lastRead = 0, page = 1, filter = 'all', search = '', localReadError = '', actionError = '';
  let networkBusy = '', networkDirty = false, networkDraftRevision = 0;
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
  function networkDiagnostics() {
    return networkSources.map(source => ({ ...source, result: state?.network?.diagnostics?.find(item => item.source === source.source) }));
  }
  function syncNetworkMode() {
    const form = $('#opp-network-form'); if (!form) return;
    const manual = form.elements.mode.value === 'proxy';
    $('#opp-network-proxy-field').hidden = !manual;
    form.elements.proxyUrl.disabled = !manual;
    form.elements.proxyUrl.required = manual;
  }
  function fillNetwork() {
    const form = $('#opp-network-form'); if (!form || networkDirty) return;
    const network = state?.network || {};
    form.elements.mode.value = ['auto', 'direct', 'proxy'].includes(network.mode) ? network.mode : 'auto';
    form.elements.proxyUrl.value = validProxyUrl(network.proxyUrl) ? network.proxyUrl : '';
    syncNetworkMode();
  }
  function renderNetwork() {
    if (!container || !$('#opp-network-results')) return;
    const network = state?.network || {}, testing = networkBusy === 'test' || Boolean(network.testing);
    const routes = { env: '已检测到环境代理', windows: '已检测到 Windows 系统代理', manual: '已保存本机 HTTP 代理', direct: '当前路由：直连' };
    const diagnostics = networkDiagnostics();
    const chainResults = diagnostics.filter(item => item.source !== 'coingecko-directory').map(item => item.result);
    const allConnected = chainResults.every(result => result && ['ok', 'empty'].includes(result.status));
    const anyChecked = diagnostics.some(item => item.result?.checkedAt);
    $('#opp-network-route').textContent = (routes[network.effectiveRoute] || (network.proxyDetected ? '已检测到代理配置' : '自动检测环境／Windows 系统代理')) + (anyChecked ? '' : '（尚未验证连接）');
    const reason = networkReasonCode(network.reason) || diagnostics.map(item => networkReasonCode(item.result?.networkReason)).find(Boolean);
    $('#opp-network-reason').textContent = testing ? '正在检测公开行情连接，请等待各来源结果…' : reason ? networkHints[reason] : allConnected ? '两条链的行情连接检测已通过；具体资产是否有池，仍以扫描结果为准。' : anyChecked ? '检测已完成，请查看各来源的 HTTP 状态和错误；连接成功与该代币存在有效交易池分别展示。' : '尚未进行连接测试，代理配置已识别也不代表行情已经连通。';
    $('#opp-network-times').textContent = `上次检测 ${date(network.lastTestAt)}${network.nextTestAt ? ` · 下次允许检测 ${date(network.nextTestAt)}` : ''}`;
    $('#opp-network-test').textContent = testing ? '正在测试行情连接…' : '测试行情连接';
    $('#opp-network-test').disabled = Boolean(networkBusy || network.testing || (asMillis(network.nextTestAt) > Date.now()));
    $('#opp-network-save').disabled = Boolean(networkBusy || network.testing);
    $('#opp-network-copy').disabled = !anyChecked;
    $('#opp-network-results').innerHTML = diagnostics.map(({ source, label, host, result }) => {
      const status = ['ok', 'empty', 'error', 'rate_limited', 'auth_required'].includes(result?.status) ? result.status : 'unknown';
      const code = diagnosticCode(result?.errorCode), networkReason = networkReasonCode(result?.networkReason);
      const hint = networkReason ? networkHints[networkReason] : status === 'rate_limited' ? '请求达到本机预算或接口冷却，请按下次允许时间重试。' : status === 'auth_required' ? '接口要求访问权限；CoinGecko 可在下方配置可选数据 Key。' : status === 'empty' ? '接口已返回；本次没有满足条件的有效池／条目，不能据此显示价格。' : status === 'error' ? '行情请求失败，请检查网络方式及 HTTP 状态后重试。' : status === 'ok' ? '公开行情接口已响应；不代表代币或交易已通过风险检查。' : '等待首次公开行情连接检测。';
      return `<article class="opp-network-result" data-network-source="${source}" data-network-status="${status}"><div class="opp-network-result-heading"><strong>${label}</strong><span class="badge ${status === 'ok' ? 'green' : ['error', 'auth_required', 'rate_limited'].includes(status) ? 'red' : 'neutral'}">${networkStatus(status)}</span></div><p class="mono opp-network-host">${host}</p><p class="opp-network-result-code">${result ? esc(diagnosticHttp(result.httpStatus)) : '尚无检测结果'}${code ? ` · ${esc(code)}` : ''}${networkReason ? ` · ${networkReason}` : ''}</p><p class="help">检测时间 ${date(result?.checkedAt)}${Number.isInteger(result?.records) && result.records >= 0 ? ` · 返回 ${num(result.records)} 条` : ''}</p><p class="help">${hint}</p></article>`;
    }).join('');
  }
  function networkValidation(message = '') {
    $('#opp-network-validation').textContent = message;
    $('#opp-network-validation').hidden = !message;
  }
  async function changeNetwork(path, body) {
    if (networkBusy || state?.network?.testing) return false;
    const ticket = generation, draftRevision = networkDraftRevision;
    // Invalidate older polling responses; they must not replace a newly saved route/test result.
    requestId++; inFlight = false; networkBusy = path === '/network/test' ? 'test' : 'save';
    networkValidation(); renderNetwork();
    try {
      const result = await api('/api/opportunities' + path, { method: 'POST', body });
      if (!container || generation !== ticket) return false;
      if (Array.isArray(result?.assets)) state = { ...result, execution: result.execution || state?.execution };
      else if (result?.network) state = { ...state, network: result.network };
      actionError = ''; lastRead = Date.now();
      if (path === '/network' && networkDraftRevision === draftRevision) networkDirty = false;
      fillNetwork();
      renderStatus(); renderAssets();
      toast(path === '/network/test' ? '行情连接检测已完成，请查看各来源结果' : '行情网络设置已保存；请测试连接');
      return true;
    } catch (error) {
      if (container && generation === ticket) { networkValidation(path === '/network/test' ? '连接检测请求未完成，请检查本机服务并重试。' : '网络设置未能保存，请检查本机服务并重试。'); toast(path === '/network/test' ? '行情连接检测未完成' : '行情网络设置未保存', true); }
      return false;
    } finally { if (container && generation === ticket) { networkBusy = ''; renderStatus(); } }
  }
  async function copyNetworkSummary() {
    const ticket = generation;
    const lines = ['ChainPair 行情连接诊断', ...networkDiagnostics().map(({ label, host, result }) => `${label} | ${host} | ${networkStatus(result?.status)} | ${result ? diagnosticHttp(result.httpStatus) : '尚无检测结果'}${diagnosticCode(result?.errorCode) ? ` | ${diagnosticCode(result.errorCode)}` : ''}${networkReasonCode(result?.networkReason) ? ` | ${networkReasonCode(result.networkReason)}` : ''} | ${date(result?.checkedAt)}`)];
    try { await navigator.clipboard.writeText(lines.join('\n')); if (container && generation === ticket) toast('诊断摘要已复制，不含 Key、钱包地址或代理地址'); }
    catch { if (container && generation === ticket) networkValidation('浏览器未允许复制，请选中上方诊断文字复制。'); }
  }
  function renderStatus() {
    if (!container || !state) return;
    const directory = state.directory || {}, progress = state.scanProgress || {};
    $('#opp-reason').textContent = localReadError || state.reason || '等待自动发现与扫描';
    $('#opp-updated').textContent = date(state.updatedAt);
    $('#opp-directory-time').textContent = state.directory?.source === 'bundled-wormhole' ? `快照 ${state.directory.sourceDate || '2026-04-08'}` : date(state.directoryUpdatedAt);
    $('#opp-budget').textContent = `近24小时请求 ${num(state.usage?.day)} / ${num(state.settings?.maxRequestsPerDay)} · 累计 ${num(state.usage?.total)} · 下次允许请求 ${date(state.nextRequestAt)}`;
    $('#opp-enable').textContent = state.enabled ? '停止自动扫描' : '开启自动发现与扫描';
    $('#opp-auto').textContent = automatic() ? '暂停清单自动执行' : `开启${currentMode() === 'live' ? '实盘' : '模拟'} · 已核验清单自动执行`;
    $('#opp-mode').textContent = currentMode() === 'live' ? '当前交易：实盘' : '当前交易：模拟';
    $('#opp-mode').className = `badge ${currentMode() === 'live' ? 'red' : 'amber'}`;
    $('#opp-execution').textContent = state.execution?.busy ? `正在执行 ${state.execution.activeAssetId || '库存任务'}；后续进度见交易档案。` : state.execution?.lastError || (automatic() ? '自动执行已开启，只处理用户已核验的同币清单。' : '自动交易默认关闭；目录发现和行情扫描不会启动交易。');
    $('#opp-auto').disabled = Boolean(state.execution?.busy && !automatic());
    $('#opp-scan').disabled = inFlight;
    $('#opp-discover').disabled = inFlight;
    const messages = [...new Set([localReadError, actionError, state.lastError, directory.errorMessage].filter(value => typeof value === 'string' && value))];
    $('#opp-error').textContent = messages.join('；'); $('#opp-error').hidden = !messages.length;
    $('#opp-notice').textContent = state.notice || ''; $('#opp-notice').hidden = !state.notice;
    $('#opp-directory-status').textContent = directoryStatus(directory.status);
    $('#opp-directory-source').textContent = `${sourceName(directory.source)}${directory.sourceDate ? `（${directory.sourceDate}）` : ''}`;
    $('#opp-directory-count').textContent = num(directory.foundCount ?? state.assets?.length);
    $('#opp-directory-retry').textContent = directory.nextAttemptAt ? date(directory.nextAttemptAt) : '等待任务安排';
    $('#opp-scan-progress').textContent = `已扫描 ${num(progress.scannedAssets)} / ${num(progress.totalAssets ?? state.assets?.length)} 项 · 双侧有池 ${num(progress.withBothMarkets)} 项 · 价差候选 ${num(progress.opportunities ?? state.counts?.candidate)} 项`;
    $('#opp-source-attempts').innerHTML = (Array.isArray(directory.sourceAttempts) ? directory.sourceAttempts : []).map(attempt => `<li><strong>${esc(sourceName(attempt.source))}</strong><span>${esc(directoryStatus(attempt.status))}${attempt.foundCount !== undefined ? ` · ${esc(num(attempt.foundCount))} 项` : ''}</span>${attempt.message || attempt.errorCode ? `<small>${esc(attempt.message || '')}${attempt.errorCode ? ` (${esc(attempt.errorCode)})` : ''}${attempt.nextAttemptAt ? ` · 下次尝试 ${esc(date(attempt.nextAttemptAt))}` : ''}</small>` : ''}</li>`).join('');
    const credentials = state.credentials || {};
    $('#opp-key-status').textContent = !credentials.configured ? '可选：接口要求权限时配置 CoinGecko Demo Key；也会尝试官方资产映射备用源。' : credentials.locked ? 'Key 已加密保存，保险库仍锁定。到“设置与钱包”解锁后可使用此 Key；无 Key 的备用源仍可尝试。' : 'CoinGecko Demo Key 已加密保存；保存不代表已通过数据源验收。';
    $('#opp-clear-key').disabled = !credentials.configured || credentials.locked;
    renderNetwork();
  }
  function fillSettings() {
    const form = $('#opp-settings'); if (!form || !state?.settings) return;
    for (const [key, value] of Object.entries(state.settings)) if (form.elements[key]) form.elements[key].value = value;
    if (form.elements.pollSeconds) form.elements.pollSeconds.value = Number(state.settings.pollIntervalMs || 60000) / 1000;
    if (form.elements.minSpreadPercent) form.elements.minSpreadPercent.value = Number(state.settings.minSpreadBps || 0) / 100;
  }
  function filteredAssets() {
    return (state?.assets || []).filter(asset => (!search || `${asset.name} ${asset.symbol} ${asset.chains?.bnb?.address} ${asset.chains?.solana?.address}`.toLowerCase().includes(search.toLowerCase())) && (filter === 'approved' ? approved(asset) : filter === 'candidate' ? ['candidate','needs_mapping'].includes(reportFor(asset.id)?.stage) : true));
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
      if (asset.source === 'wormhole') reasons.push('Wormhole 包装资产映射仅供发现；桥接及可赎回风险尚未核验');
      const pools = row?.market || {};
      return `<article class="opp-asset" data-asset-id="${esc(asset.id)}"><div class="opp-asset-heading"><div><h3>${esc(asset.symbol || '未命名')} <small>${esc(asset.name || '')}</small></h3><p class="help">${esc(asset.source || 'manual')} · ${asset.enabled === false ? '已停用' : '参与扫描'} · ${row?.observedAt ? date(row.observedAt) : '尚未扫描'}</p></div><span class="badge ${isApproved ? 'neutral' : 'amber'}">${isApproved ? '用户已核验映射' : '同币关系待核验'}</span></div><div class="opp-pair-grid">${['bnb', 'solana'].map(chain => `<div><strong>${chainName(chain)}</strong><div class="mono opp-address">${esc(asset.chains?.[chain]?.address || '未配置')}</div><div class="opp-quote-price">${usd(pools[chain]?.priceUsd)}</div><p class="help">池流动性 ${usd(pools[chain]?.liquidityUsd)}<br>采集 ${date(pools[chain]?.observedAt)} · 源更新时间未提供</p></div>`).join('')}</div><div class="opp-price-gap"><span>参考方向 <b>${row?.buyChain ? `${chainName(row.buyChain)} → ${chainName(row.sellChain)}` : '待扫描'}</b></span><span>参考价差 <b>${typeof row?.spreadBps === 'number' ? num(row.spreadBps / 100) + '%' : '未知'}</b></span><span>参考毛差额 <b>${usd(row?.indicativeGrossUsd)}</b></span></div><p class="help">参考价格未扣完整费用，不能据此认定可执行；用户核验映射也不等于代币安全。</p>${evaluation ? `<div class="opp-evaluation"><strong>${evaluation.executable && fresh ? '当前报价检查通过' : fresh ? '当前报价未通过' : '报价已过期，请重新复核'}</strong><div class="opp-price-gap"><span>报价金额 ${usd(evaluation.amountUsd)}</span><span>预计现金流价差 ${usd(evaluation.netProfitUsd)}</span><span>Gas / 网络费 ${usd(evaluation.gasUsd)}</span><span>滑点成本 ${usd(evaluation.slippageUsd)}</span></div><p class="help">有效至 ${date(evaluation.expiresAt)}；未含未来补库存成本，实际提交前会再次核对。</p></div>` : '<p class="help">费用与库存尚未报价核验。</p>'}${reasons.length ? `<ul class="opp-reasons">${[...new Set(reasons)].map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}<div class="opp-actions"><button class="button secondary small" data-opp-quote="${esc(asset.id)}" ${!isApproved || state.execution?.busy ? 'disabled' : ''}>复核双边报价与库存</button><button class="button small" data-opp-execute="${esc(asset.id)}" ${!executable ? 'disabled' : ''}>${currentMode() === 'live' ? '实盘执行此机会' : '模拟执行此机会'}</button>${isApproved ? `<button class="button secondary small" data-opp-revoke="${esc(asset.id)}">撤销映射确认</button>` : ''}<button class="button secondary small" data-opp-delete="${esc(asset.id)}">移除</button></div>${mappingWarning ? `<div class="error-box section-gap">${esc(mappingWarning)}<br>请独立核对后移除此条目，手工添加正确的两链地址，再重新确认。${asset.sourceProposal ? `<div class="mono opp-address">目录候选 BNB：${esc(asset.sourceProposal.bnb)}<br>目录候选 Solana：${esc(asset.sourceProposal.solana)}</div>` : ''}</div>` : ''}${!isApproved && !mappingWarning ? `<details class="opp-approval"><summary>核对并确认同币映射</summary><form data-approval="${esc(asset.id)}"><p class="help">请核对发行方、两链合约及数量换算关系。此模式仅支持明确 1:1 的同一资产；包装资产、同名币和变基资产不能按名称认定等价。</p><div class="opp-pair-grid">${['bnb', 'solana'].map(chain => chainFields('', chain, { ...asset.chains?.[chain], poolAddress: asset.chains?.[chain]?.poolAddress || pools[chain]?.poolAddress || '' }, true)).join('')}</div><label class="field"><span>核验依据（官方发行说明或已核验资产映射）</span><textarea name="evidence" maxlength="1000" required rows="2">${esc(asset.mappingEvidence || asset.evidence || '')}</textarea></label><label class="check-row"><input type="checkbox" name="confirmed" required><span>我已核对两链地址、精度和交易池，确认它们代表 1:1 的同一资产。</span></label><button type="submit" class="button secondary small">保存此映射确认</button></form></details>` : `<p class="help opp-evidence">核验依据：${esc(asset.mappingEvidence || asset.evidence || asset.mapping?.evidence || '已由用户确认')}</p>`}</article>`;
    }).join('') : `<div class="empty-state"><strong>${state.enabled ? '自动发现与扫描正在等待数据' : '等待自动发现两链同币候选'}</strong><p>无需先手工填写合约地址。开启自动扫描后会发现 BNB／Solana 候选并比较池价格；失败原因和重试时间显示在上方。</p></div>`;
    for (const form of $$('[data-approval]')) { const asset = find(form.dataset.approval); if (asset) restore(form, asset); }
    if (focusedId && focusedName) { const form = $$('[data-approval]').find(node => node.dataset.approval === focusedId), input = form?.elements[focusedName]; if (input) { form.closest('details').open = true; input.focus({ preventScroll: true }); if (selection) input.setSelectionRange(...selection); } }
    $('#opp-page').textContent = `${assets.length} 项 · 第 ${page} / ${pages} 页`;
    $('#opp-prev').disabled = page <= 1; $('#opp-next').disabled = page >= pages;
  }
  async function read({ force = false, initial = false } = {}) {
    if (!container || networkBusy || (!force && (inFlight || Date.now() - lastRead < 8000))) return;
    const ticket = generation, request = ++requestId; inFlight = true;
    try {
      const next = await api('/api/opportunities');
      if (!container || generation !== ticket || requestId !== request) return;
      state = next; localReadError = ''; lastRead = Date.now(); renderStatus(); fillNetwork(); if (initial) fillSettings(); renderAssets();
    } catch (error) { if (container && generation === ticket && requestId === request) { localReadError = `本机扫描状态读取失败：${error.message}`; $('#opp-reason').textContent = localReadError; } }
    finally { if (requestId === request) inFlight = false; if (container && generation === ticket && requestId === request) renderStatus(); }
  }
  async function mutate(button, path, body, success, method = 'POST') {
    if (button?.disabled) return false;
    const ticket = generation; if (button) button.disabled = true;
    try {
      const result = await api('/api/opportunities' + path, { method, ...(body !== undefined ? { body } : {}) });
      if (!container || generation !== ticket) return false;
      actionError = '';
      if (Array.isArray(result?.assets)) state = { ...result, execution: result.execution || state?.execution };
      const pipeline = ['/discover', '/scan', '/enabled'].includes(path) && !(path === '/enabled' && body?.enabled === false);
      const failure = pipeline && (result?.lastError || ['error', 'auth_required', 'retrying', 'cooldown'].includes(result?.status)) ? result.lastError || result.notice || result.reason || '本次扫描未完成，请查看数据源状态与重试时间' : path === '/quote' && result?.executable === false ? (result.reasons || ['报价未通过检查']).join('；') : '';
      if (failure) toast(failure, true); else if (success) toast(pipeline && result?.notice ? result.notice : success);
      await read({ force: true }); return !failure && generation === ticket;
    } catch (error) { if (container && generation === ticket) { actionError = error.message; toast(error.message, true); } return false; }
    finally { if (button?.isConnected) button.disabled = false; if (container && generation === ticket) renderStatus(); }
  }
  function bodyChains(form) {
    return Object.fromEntries(['bnb', 'solana'].map(chain => [chain, { address: form.elements[`${chain}.address`].value.trim(), decimals: Number(form.elements[`${chain}.decimals`].value), poolAddress: form.elements[`${chain}.poolAddress`].value.trim() }]));
  }
  function mount(node) {
    if (container === node && $('#opportunities-view')) { void read(); return; }
    unmount(); container = node; generation++; page = 1; filter = 'all'; search = ''; lastRead = 0; localReadError = ''; actionError = ''; networkBusy = ''; networkDirty = false; networkDraftRevision = 0;
    node.innerHTML = `<div class="market-subnav" aria-label="行情视图"><button class="button secondary small" data-market-view="arbitrage">套利看板</button><button class="button secondary small" data-market-view="radar">Meme 雷达</button><button class="button small" data-market-view="opportunities" aria-current="page">同币机会</button></div><section id="opportunities-view"><div class="page-heading"><div><div class="eyebrow">TWO-CHAIN OPPORTUNITY SCANNER</div><h1>同币机会扫描</h1><p>发现 BNB／Solana 的同币价差，按真实报价和双侧库存筛选。</p></div><span class="badge amber" id="opp-mode">读取交易模式</span></div><div class="notice blue"><span class="notice-icon">⇄</span><p><strong>双侧库存，不逐笔跨链</strong>　低价链买入确认后，在高价链卖出已有同币。两侧须准备稳定币、目标币和 Gas；库存不足或单边失败时暂停，不自动跨链补库。</p></div><section class="card opp-control"><div class="card-body"><strong id="opp-reason">读取自动发现与扫描状态…</strong><p class="help">自动发现 BNB／Solana 的同币候选，持续比较池价格，无需先填写合约地址。行情只读，交易需单独开启；停止扫描的选择会保存。</p><div id="opp-error" class="error-box opp-status-message" role="alert" hidden></div><p id="opp-notice" class="help opp-status-message" role="status" hidden></p><div class="opp-discovery-progress"><div><span>资产发现</span><strong id="opp-directory-status">等待自动发现</strong></div><div><span>已发现双链候选</span><strong id="opp-directory-count">未知</strong></div><div><span>下一次目录尝试</span><strong id="opp-directory-retry">等待任务安排</strong></div><p class="help">目录来源：<span id="opp-directory-source">等待自动发现</span>；资产映射仍待交易前核验。</p><p id="opp-scan-progress" class="help">扫描进度读取中…</p><ul id="opp-source-attempts" class="opp-source-attempts"></ul></div><div class="opp-actions"><button id="opp-enable" class="button">开启自动发现与扫描</button><button id="opp-scan" class="button secondary">立即发现并扫描</button><button id="opp-discover" class="button secondary">刷新资产目录</button><button id="opp-auto" class="button">开启模拟 · 已核验清单自动执行</button></div><div class="opp-meta"><span>目录更新 <b id="opp-directory-time">未知</b></span><span>行情更新 <b id="opp-updated">未知</b></span></div><p id="opp-budget" class="help"></p><p id="opp-execution" class="help"></p></div></section><div class="opp-config-grid"><details class="card opp-details"><summary>扫描条件与请求预算</summary><form id="opp-settings" class="card-body"><div class="form-grid"><label class="field"><span>轮询间隔（秒）</span><input type="number" name="pollSeconds" min="30" max="3600" step="1" required></label><label class="field"><span>最低双侧池流动性（USD）</span><input type="number" name="minLiquidityUsd" min="0" step="any" required></label><label class="field"><span>参考价差门槛（%）</span><input type="number" name="minSpreadPercent" min="0" step=".01" required></label><label class="field"><span>每轮最多扫描资产</span><input type="number" name="maxAssetsPerScan" min="1" max="100" step="1" required></label><label class="field"><span>近24小时请求上限</span><input type="number" name="maxRequestsPerDay" min="1" step="1" required></label></div><p class="help">目录关联仅作为候选，不覆盖全市场，不按币名识别同币。公共 API 可能要求账户或限频，以提供方当前规则为准。</p><button type="submit" class="button secondary">保存扫描设置</button></form></details><details class="card opp-details"><summary>高级备用：手工添加同币地址（非必填）</summary><form id="opp-add" class="card-body"><div class="form-grid"><label class="field"><span>资产名称</span><input name="name" maxlength="100" required></label><label class="field"><span>符号（仅作显示）</span><input name="symbol" maxlength="32"></label></div><div class="opp-pair-grid">${['bnb', 'solana'].map(chain => chainFields('', chain)).join('')}</div><p class="help">自动发现与扫描无需填写此表。仅在需要补充特定资产时使用；添加不会启动交易。</p><button type="submit" class="button secondary">添加到观察清单</button></form></details>${networkPanel()}${connectionPanel()}</div><section class="card"><div class="card-header opp-list-header"><h2>两链资产清单</h2><div class="opp-list-filters"><input id="opp-search" type="search" placeholder="搜索名称或合约地址" aria-label="搜索同币清单"><select id="opp-filter" aria-label="筛选同币清单"><option value="all">全部资产</option><option value="approved">用户已核验</option><option value="candidate">参考价差候选</option></select></div></div><div id="opp-assets"><div class="empty-state">读取清单…</div></div><div class="pager"><span id="opp-page">第1页</span><div class="pager-buttons"><button id="opp-prev" class="button secondary small" disabled>上一页</button><button id="opp-next" class="button secondary small" disabled>下一页</button></div></div></section></section>`;
    $('#opp-network-form').addEventListener('input', () => { networkDirty = true; networkDraftRevision++; networkValidation(); });
    $('#opp-network-form').addEventListener('change', () => { networkDirty = true; networkDraftRevision++; networkValidation(); syncNetworkMode(); });
    $('#opp-network-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget;
      const mode = form.elements.mode.value, proxyUrl = form.elements.proxyUrl.value.trim();
      if (!['auto', 'direct', 'proxy'].includes(mode) || (mode === 'proxy' && !validProxyUrl(proxyUrl))) {
        networkValidation('请输入本机 HTTP／mixed 代理地址和有效端口（1–65535），例如 http://127.0.0.1:7890；不接受 SOCKS、远程地址或账号密码。');
        form.elements.proxyUrl.focus(); return;
      }
      await changeNetwork('/network', { mode, proxyUrl: mode === 'proxy' ? proxyUrl : '' });
    });
    $('#opp-network-test').addEventListener('click', () => changeNetwork('/network/test', {}));
    $('#opp-network-copy').addEventListener('click', copyNetworkSummary);
    $('#opp-discover').addEventListener('click', event => mutate(event.currentTarget, '/discover', {}, '资产目录已刷新；新地址仍需核验'));
    $('#opp-scan').addEventListener('click', event => mutate(event.currentTarget, '/scan', {}, '自动发现与扫描已请求；请查看进度'));
    $('#opp-enable').addEventListener('click', event => mutate(event.currentTarget, '/enabled', { enabled: !state?.enabled }, state?.enabled ? '自动扫描已停止' : '自动发现与扫描已请求；请查看进度'));
    $('#opp-auto').addEventListener('click', event => mutate(event.currentTarget, '/automation', { enabled: !automatic(), expectedMode: currentMode() }, automatic() ? '自动执行已暂停；在途交易继续核对' : '已开启已核验清单的库存执行，请查看交易档案'));
    $('#opp-credentials').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button[type=submit]');
      const body = { apiKey: form.elements.apiKey.value.trim(), password: form.elements.password.value };
      form.reset();
      await mutate(button, '/credentials', body, '数据 Key 已加密保存；接口权限仍需由实际请求验证');
    });
    $('#opp-clear-key').addEventListener('click', event => mutate(event.currentTarget, '/credentials', undefined, 'CoinGecko 数据 Key 已移除', 'DELETE'));
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
  function unmount() { generation++; requestId++; inFlight = false; networkBusy = ''; container = null; state = null; }
  return { mount, unmount, refresh: read };
}
