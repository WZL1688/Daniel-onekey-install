import { createRadarVoice } from './radar-voice.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const usd = value => Number.isFinite(value) ? '$' + value.toLocaleString('en-US', { maximumFractionDigits: value < .01 ? 8 : 2 }) : '—';
const number = value => Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
const date = value => value && Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '未知';
const chainName = chain => chain === 'bnb' ? 'BNB Chain' : 'Solana';
export function trustedAveUrl(token) {
  if (token.chain === 'bnb' && /^0x[0-9a-f]{40}$/i.test(token.address) && !/^0x0{40}$/i.test(token.address)) return `https://ave.ai/token/${token.address}-bsc`;
  if (token.chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.address)) {
    try { if (!globalThis.solanaWeb3 || new globalThis.solanaWeb3.PublicKey(token.address).toBase58() !== token.address) return null; } catch { return null; }
    return `https://ave.ai/token/${token.address}-solana`;
  }
  return null;
}
const fields = [
  ['最低流动性（USD）', 'minLiquidityUsd', 0], ['最低市值（USD）', 'minMarketCapUsd', 0], ['最高市值（USD）', 'maxMarketCapUsd', 1],
  ['最低5分钟成交额（USD）', 'minVolume5mUsd', 0], ['最低持币人数', 'minHolders', 0], ['最低币龄（分钟）', 'minAgeMinutes', 0],
  ['最高币龄（小时）', 'maxAgeHours', 1], ['本机近1小时请求上限', 'maxRequestsPerHour', 1], ['本机近24小时请求上限', 'maxRequestsPerDay', 1], ['本机累计请求上限', 'maxRequestsLifetime', 1],
];
export function createRadarView({ api, toast }) {
  let container = null, state = null, mounted = 0, requestSequence = 0, inFlight = false, lastGet = 0, filter = 'candidate', page = 1, highlighted = null, highlightTimer = null;
  const noteDrafts = new Map();
  const $ = selector => container?.querySelector(selector);
  const voice = createRadarVoice({
    onStart(id) {
      if (!container || !state?.tokens?.some(token => token.id === id && token.decision?.status === 'candidate')) return;
      highlighted = id; page = 1; renderTokens(); clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => { highlighted = null; renderTokens(); }, 6000);
    }, onChange: renderVoice
  });
  function renderVoice() {
    const status = voice.status();
    const button = $('#radar-voice'); if (!button) return;
    button.disabled = !status.available; button.textContent = status.enabled ? '关闭语音' : '开启本地语音'; button.setAttribute('aria-pressed', String(status.enabled));
    $('#radar-voice-status').textContent = status.reason;
  }
  function renderStatus() {
    if (!state || !container) return;
    $('#radar-status').textContent = state.enabled ? '只读扫描已开启' : '只读扫描已关闭';
    $('#radar-status').className = `badge ${state.enabled ? 'green' : 'neutral'}`;
    $('#radar-enable').textContent = state.enabled ? '停止扫描' : '开启只读扫描';
    $('#radar-enable').disabled = !state.enabled && (!state.configured || state.locked);
    $('#radar-reason').textContent = state.reason || '等待手动开启。';
    $('#radar-key-status').textContent = !state.configured ? '尚未配置 AVE Key' : state.locked ? '已加密保存，保险库锁定；请到“设置与钱包”解锁。' : '已加密保存；保存不代表 API 已验证。';
    $('#radar-clear-key').disabled = !state.configured || state.locked;
    $('#radar-updated').textContent = date(state.updatedAt);
    $('#radar-next').textContent = date(state.nextRequestAt);
    const usage = state.usage || {}, settings = state.settings || {};
    $('#radar-usage').textContent = `近1小时 ${number(usage.hour)} / ${number(settings.maxRequestsPerHour)} · 近24小时 ${number(usage.day)} / ${number(settings.maxRequestsPerDay)} · 累计 ${number(usage.lifetime)} / ${number(settings.maxRequestsLifetime)}`;
    $('#radar-error').textContent = state.lastError || ''; $('#radar-error').hidden = !state.lastError;
    const disabled = !state.configured || state.locked || inFlight || (state.nextRequestAt && Date.now() < state.nextRequestAt);
    $('#radar-refresh').disabled = Boolean(disabled);
    for (const button of container.querySelectorAll('[data-radar-filter]')) {
      const kind = button.dataset.radarFilter, count = kind === 'watch' ? (state.tokens || []).filter(token => token.watched).length : kind === 'filtered' ? (state.counts?.excluded || 0) + (state.counts?.insufficient || 0) : state.counts?.candidate || 0;
      button.textContent = `${kind === 'watch' ? '收藏观察' : kind === 'filtered' ? '已筛除／资料不足' : '市场观察'} ${count}`;
      button.classList.toggle('active', filter === kind); button.setAttribute('aria-pressed', String(filter === kind));
    }
  }
  function renderTokens() {
    const node = $('#radar-tokens'); if (!node || !state) return;
    const activeNote = document.activeElement?.matches('.radar-note-form textarea') ? document.activeElement : null;
    const focusedId = activeNote?.closest('[data-radar-note]')?.dataset.radarNote;
    const selection = activeNote ? [activeNote.selectionStart, activeNote.selectionEnd, activeNote.selectionDirection] : null;
    const tokens = (state.tokens || []).filter(token => filter === 'watch' ? token.watched : filter === 'filtered' ? token.decision?.status !== 'candidate' : token.decision?.status === 'candidate').sort((a, b) => a.id === highlighted ? -1 : b.id === highlighted ? 1 : 0);
    const pages = Math.max(1, Math.ceil(tokens.length / 10)); page = Math.min(page, pages);
    const visible = tokens.slice((page - 1) * 10, page * 10);
    // Keep the note being edited present if a new spoken card changes page order.
    if (focusedId && !visible.some(token => token.id === focusedId)) {
      const focused = tokens.find(token => token.id === focusedId); if (focused) visible.push(focused);
    }
    node.innerHTML = tokens.length ? visible.map(token => {
      const flagged = token.risk?.status === 'flagged', url = trustedAveUrl(token), reasons = [...(token.decision?.reasons || []), ...(token.risk?.flags || [])];
      return `<article class="radar-token ${highlighted === token.id ? 'radar-alert' : ''}" data-radar-id="${esc(token.id)}"><div class="radar-token-heading"><div><h3>${esc(token.symbol || '未命名')} <small>${esc(token.name || '')}</small></h3><span class="muted small-text">${chainName(token.chain)} · ${token.decision?.status === 'candidate' ? '市场条件初筛通过' : token.decision?.status === 'insufficient' ? '资料不足' : '未通过筛选'}</span></div><span class="badge ${flagged ? 'red' : 'amber'}">${flagged ? '检测到风险标志' : '安全待核验'}</span></div><div class="address radar-address">${esc(token.address)}</div><div class="radar-metrics">${[['价格', usd(token.priceUsd)], ['流动性', usd(token.liquidityUsd)], ['市值', usd(token.marketCapUsd)], ['5分钟成交额', usd(token.volume5mUsd)], ['持币人数', number(token.holders)], ['创建时间', date(token.createdAt)]].map(([label, value]) => `<div><span class="stat-label">${label}</span><strong>${esc(value)}</strong></div>`).join('')}</div><div class="radar-provenance">AVE 采集：${date(token.observedAt)} · 源更新时间：${date(token.sourceUpdatedAt)}<br>风险检查：${token.risk?.checkedAt ? date(token.risk.checkedAt) : '尚未查询'}；未检出已知标志也不能认定安全。</div>${reasons.length ? `<ul class="radar-reasons">${reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}<div class="radar-token-actions"><button class="button secondary small" data-radar-copy="${esc(token.id)}">复制 CA</button>${url ? `<a class="button secondary small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">在 AVE 查看 ↗</a>` : ''}<button class="button secondary small" data-radar-risk="${esc(token.id)}" ${!state.configured || state.locked || (state.nextRequestAt && Date.now() < state.nextRequestAt) ? 'disabled' : ''}>查询风险资料</button><button class="button secondary small" data-radar-watch="${esc(token.id)}">${token.watched ? '取消收藏' : '收藏观察'}</button></div>${token.watched ? `<form class="radar-note-form" data-radar-note="${esc(token.id)}"><label class="field"><span>本地观察备注</span><textarea name="note" maxlength="1000" rows="2">${esc(noteDrafts.has(token.id) ? noteDrafts.get(token.id) : token.note || '')}</textarea></label><button type="submit" class="button secondary small">保存备注</button></form>` : ''}</article>`;
    }).join('') : `<div class="empty-state"><span class="empty-icon">◉</span><strong>${!state.configured ? '先配置 AVE 数据 Key' : !state.tokens?.length ? '尚无真实雷达数据' : '当前分类暂无记录'}</strong><p>${!state.configured ? '加密保存后，手动开启只读扫描。无需导入钱包。' : '行情筛选不保证代币安全，也不证明同名代币为跨链同币。'}</p></div>`;
    if (focusedId && selection) {
      const editor = [...node.querySelectorAll('[data-radar-note]')].find(form => form.dataset.radarNote === focusedId)?.querySelector('textarea');
      if (editor) { editor.focus({ preventScroll: true }); editor.setSelectionRange(...selection); }
    }
    $('#radar-page-label').textContent = `${tokens.length} 条 · 第 ${page} / ${pages} 页`;
    $('#radar-prev').disabled = page <= 1; $('#radar-next-page').disabled = page >= pages;
  }
  async function getState({ initial = false, force = false } = {}) {
    if (!container || (!force && inFlight) || (!force && Date.now() - lastGet < 8000)) return;
    const ticket = mounted, sequence = ++requestSequence; inFlight = true;
    try {
      const next = await api('/api/radar');
      if (!container || ticket !== mounted || sequence !== requestSequence) return;
      if (state?.settings?.chain && next.settings?.chain !== state.settings.chain) voice.reset();
      state = next; lastGet = Date.now();
      if (initial) fillSettings();
      renderStatus();
      // Preserve a focused local note editor; no network data overwrites unsaved text.
      if (!document.activeElement?.closest('.radar-note-form')) renderTokens();
      await voice.observe(state.tokens || []);
    } catch (error) { if (container && ticket === mounted && sequence === requestSequence) { $('#radar-reason').textContent = error.message; } }
    finally { if (sequence === requestSequence) inFlight = false; if (container && ticket === mounted && sequence === requestSequence) renderStatus(); }
  }
  function fillSettings() {
    const form = $('#radar-settings'); if (!form || !state?.settings) return;
    for (const [name, value] of Object.entries(state.settings)) if (form.elements[name]) form.elements[name].value = value;
    form.elements.pollMinutes.value = Number(state.settings.pollIntervalMs) / 60000;
  }
  async function mutate(button, path, body, success) {
    if (button?.disabled) return false;
    if (button) button.disabled = true;
    const ticket = mounted;
    try {
      await api(path, { method: 'POST', body });
      if (!container || ticket !== mounted) return false;
      if (success) toast(success); await getState({ force: true }); return ticket === mounted;
    } catch (error) { if (container && ticket === mounted) toast(error.message, true); return false; }
    finally { if (button?.isConnected) button.disabled = false; if (container && ticket === mounted) renderStatus(); }
  }
  function find(id) { return state?.tokens?.find(token => token.id === id); }
  function mount(node) {
    if (container === node && $('#radar-view')) { void getState(); return; }
    unmount(); container = node; mounted++; filter = 'candidate'; page = 1; lastGet = 0; voice.reset();
    node.innerHTML = `<div class="market-subnav" aria-label="行情视图"><button class="button secondary small" data-market-view="arbitrage">套利看板</button><button class="button small" data-market-view="radar" aria-current="page">Meme 雷达</button></div><section id="radar-view"><div class="page-heading"><div><div class="eyebrow">READ-ONLY MEME RADAR</div><h1>Meme 观察雷达</h1><p>BNB／Solana 市场发现与本地提醒，数据来自 AVE。</p></div><span id="radar-status" class="badge neutral">读取状态</span></div><div class="notice blue"><span class="notice-icon">◉</span><p><strong>独立只读行情</strong>　即使套利处于模拟模式，雷达开启后也会请求真实 AVE 数据。市场初筛不等于安全检查，不保证排除貔貅或诈骗盘；结果不会写入套利配置或触发买入。</p></div><section class="card radar-controls"><div class="card-body"><div class="radar-control-row"><div><strong id="radar-reason">读取本机雷达配置…</strong><p class="help">默认关闭；程序重启后需手动开启。所有 AVE 请求共享至少5分钟间隔，手动刷新与风险查询也受限。</p></div><div class="radar-buttons"><button id="radar-enable" class="button" disabled>开启只读扫描</button><button id="radar-refresh" class="button secondary" disabled>请求最新行情</button></div></div><div id="radar-error" class="error-box" hidden></div><div class="radar-scan-meta"><span>最新采集 <b id="radar-updated">未知</b></span><span>下一次允许请求 <b id="radar-next">未知</b></span></div><div class="radar-budget" id="radar-usage">本机请求计数读取中</div><p class="help">这是本机请求数预算，不是 AVE CU 账单。第三方免费额度、付费规则及可用性以 AVE 官方为准。</p></div></section><div class="radar-config-grid"><details class="card radar-details"><summary>筛选与请求预算</summary><form id="radar-settings" class="card-body"><div class="form-grid"><label class="field"><span>当前扫描链（每次一条链）</span><select name="chain"><option value="bnb">BNB Chain</option><option value="solana">Solana</option></select></label><label class="field"><span>轮询间隔（分钟，至少5）</span><input type="number" name="pollMinutes" min="5" max="1440" step="1" required></label>${fields.map(([label, name, min]) => `<label class="field"><span>${label}</span><input type="number" name="${name}" min="${min}" step="${['minHolders','maxRequestsPerHour','maxRequestsPerDay','maxRequestsLifetime'].includes(name) ? '1' : 'any'}" required></label>`).join('')}</div><p class="help">资料缺失会标为不足；已知风险会被筛除。行情超过10分钟即过期，延长轮询不会延长有效期。只比较行情，不按名称推断跨链同币。</p><button type="submit" class="button secondary">保存雷达设置</button></form></details><details class="card radar-details"><summary>AVE Key 与本地语音</summary><div class="card-body"><p id="radar-key-status" class="help">读取保险库状态…</p><form id="radar-credentials" autocomplete="off" class="wallet-form"><label class="field"><span>AVE API Key</span><input name="apiKey" type="password" autocomplete="new-password" maxlength="1000" required></label><label class="field"><span>本机保险库密码</span><input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="1024" required></label><p class="help">与钱包共用本机加密保险库；只保存数据 API Key，不需要钱包私钥。保存不会验证 API 或请求外网。</p><div class="radar-buttons"><button type="submit" class="button secondary">加密保存 Key</button><button type="button" id="radar-clear-key" class="button secondary" disabled>移除 AVE Key</button></div></form><div class="separator"></div><div class="field"><label for="radar-language">提醒语言</label><select id="radar-language"><option value="zh">中文</option><option value="en">English</option></select></div><button id="radar-voice" class="button secondary section-gap" type="button" disabled>开启本地语音</button><p id="radar-voice-status" class="help"></p><p class="help">只读出“新观察线索，尚未安全核验”。真正开始播报后将卡片移到当前列表首位并高亮；首次加载与重新开启不会补播旧记录。</p><a class="small-text" href="https://cloud.ave.ai/register" target="_blank" rel="noopener noreferrer">AVE 官方 API 注册 ↗</a></div></details></div><section class="card radar-results"><div class="card-header"><h2>市场线索</h2><div class="radar-result-filters"><button class="button secondary small active" data-radar-filter="candidate">市场观察 0</button><button class="button secondary small" data-radar-filter="filtered">已筛除／资料不足 0</button><button class="button secondary small" data-radar-filter="watch">收藏观察 0</button></div></div><div id="radar-tokens"><div class="empty-state">读取本机数据…</div></div><div class="pager"><span id="radar-page-label">第1页</span><div class="pager-buttons"><button id="radar-prev" class="button secondary small" disabled>上一页</button><button id="radar-next-page" class="button secondary small" disabled>下一页</button></div></div></section></section>`;
    $('#radar-settings').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget, settings = { chain: form.elements.chain.value, pollIntervalMs: Number(form.elements.pollMinutes.value) * 60000 };
      for (const [, name] of fields) settings[name] = Number(form.elements[name].value);
      if (await mutate(form.querySelector('button[type=submit]'), '/api/radar/settings', { settings }, '雷达设置已保存')) fillSettings();
    });
    $('#radar-credentials').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button[type=submit]');
      try { await mutate(button, '/api/radar/credentials', { apiKey: form.elements.apiKey.value, password: form.elements.password.value }, 'AVE Key 已加密保存；尚未验证 API'); }
      finally { form.elements.apiKey.value = ''; form.elements.password.value = ''; }
    });
    $('#radar-clear-key').addEventListener('click', async event => {
      const button = event.currentTarget, ticket = mounted; button.disabled = true;
      try {
        await api('/api/radar/credentials', { method: 'DELETE', body: {} });
        if (container && ticket === mounted) { toast('AVE Key 已移除'); await getState({ force: true }); }
      } catch (error) { if (container && ticket === mounted) toast(error.message, true); }
      finally { if (container && ticket === mounted) renderStatus(); }
    });
    $('#radar-enable').addEventListener('click', event => mutate(event.currentTarget, '/api/radar/enabled', { enabled: !state?.enabled }));
    $('#radar-refresh').addEventListener('click', event => mutate(event.currentTarget, '/api/radar/refresh', {}));
    $('#radar-language').addEventListener('change', event => voice.configure({ enable: voice.status().enabled, lang: event.currentTarget.value }));
    $('#radar-voice').addEventListener('click', () => voice.configure({ enable: !voice.status().enabled }));
    node.querySelectorAll('[data-radar-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.radarFilter; page = 1; renderStatus(); renderTokens(); }));
    $('#radar-prev').addEventListener('click', () => { page--; renderTokens(); });
    $('#radar-next-page').addEventListener('click', () => { page++; renderTokens(); });
    $('#radar-tokens').addEventListener('click', async event => {
      const copy = event.target.closest('[data-radar-copy]'), risk = event.target.closest('[data-radar-risk]'), watch = event.target.closest('[data-radar-watch]');
      if (copy) { const token = find(copy.dataset.radarCopy); if (!token || !trustedAveUrl(token)) return; try { await navigator.clipboard.writeText(token.address); toast('CA 已复制'); } catch { toast('浏览器不允许复制，请手动选中地址。', true); } }
      if (risk) { const token = find(risk.dataset.radarRisk); if (token) await mutate(risk, '/api/radar/risk', { chain: token.chain, address: token.address }, '风险查询请求已处理，请核对报告时间与请求状态'); }
      if (watch) { const token = find(watch.dataset.radarWatch); if (token) await mutate(watch, '/api/radar/watch', { chain: token.chain, address: token.address }); }
    });
    $('#radar-tokens').addEventListener('input', event => {
      const form = event.target.closest('[data-radar-note]');
      if (form && event.target.name === 'note') noteDrafts.set(form.dataset.radarNote, event.target.value);
    });
    $('#radar-tokens').addEventListener('submit', async event => {
      const form = event.target.closest('[data-radar-note]'); if (!form) return; event.preventDefault(); const token = find(form.dataset.radarNote); if (!token) return;
      const submitted = form.elements.note.value;
      if (await mutate(form.querySelector('button'), '/api/radar/watch', { chain: token.chain, address: token.address, note: submitted }, '观察备注已保存')) {
        if (noteDrafts.get(token.id) === submitted) noteDrafts.delete(token.id);
        renderTokens();
      }
    });
    renderVoice(); void getState({ initial: true, force: true });
  }
  function unmount() { mounted++; requestSequence++; inFlight = false; container = null; voice.stop(); clearTimeout(highlightTimer); highlighted = null; }
  return { mount, unmount, refresh: () => getState() };
}
