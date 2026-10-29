const $ = s => document.querySelector(s);
const h = x => String(x ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = x => x == null ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: 8 });
const time = x => x ? new Date(x).toLocaleString('zh-CN', { hour12: false }) : '—';
const tag = (text, kind = '') => `<span class="tag ${kind}">${h(text)}</span>`;
const pnl = x => `<span class="number ${Number(x) < 0 ? 'negative' : 'positive'}">${h(n(x))}</span>`;
const names = { binance: 'Binance', okx: 'OKX' };
const statuses = { PREPARING: '最终复核中', SUBMITTING: '提交中', SUBMITTED: '已受理 · 成交未确认', UNKNOWN: '提交结果未知', INCOMPLETE: '双腿不完整', REJECTED: '未提交／已拒绝', RESOLVED: '已人工核对', ACKNOWLEDGED: '收到订单号', SENDING: '正在发送', VERIFIED: '查询已验证', CONFIGURED_NOT_QUERIED: '交易 Key 已配置 · 不查询', FAILED: '验证失败', UNVERIFIED: '未验证' };
const pages = { opportunities: ['实时机会', '穿透真实深度，以保守利润作为最后一道门槛。'], balance: ['动态平衡', '高库存端卖出、低库存端买入；不通过转账平衡。'], accounts: ['账户余额', '仅通过查询 Key 获取；更新失败保留旧值并禁止该路径。'], keys: ['API Key 状态', '凭据仅在本机加密保存，交易 Key 永不参与查询。'], records: ['提交记录', '提交、受理、成交状态严格区分，未知结果不自动重发。'], usage: ['API 调度', '统一排队、独立限速，为最终复核保留额度。'], errors: ['系统与错误', '记录具体阻塞原因，不使用模糊的“未满足条件”。'], settings: ['设置', '调整金额、费率与门槛。修改前请先停止实盘。'] };
statuses.WORKING_NOT_QUERIED = '交易请求已受理 · 未查询';
let page = 'opportunities', state, csrf, editing = false, noticeTimer;
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 12000); }
async function api(path, data) {
  const response = await fetch(path, data === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || '本机请求失败'); return result;
}
function table(heads, rows, empty = '暂无数据') { return `<div class="table-wrap"><table><thead><tr>${heads.map(x => `<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${heads.length}" class="empty">${h(empty)}</td></tr>`}</tbody></table></div>`; }
function card(title, content, action = '') { return `<div class="card"><div class="card-head"><h2>${h(title)}</h2>${action}</div>${content}</div>`; }
function stat(label, value, note) { return `<div class="stat"><span class="label">${h(label)}</span><strong>${h(value)}</strong><small>${h(note)}</small></div>`; }
function reasons(o) { return (o?.reasons || []).map(h).join('<br>') || '未发现计算阻塞；仍须后台最终复核'; }
function directionRow(id, o) {
  return `<tr><td><b>${h(id)}</b><br>${tag(o.stale ? '已过期' : o.eligible ? '利润通过' : '不满足', o.eligible && !o.stale ? 'good' : '')}<br><span class="muted">${h(time(o.sampleAt || o.at))}</span></td><td>${h(names[o.buyExchange])} → ${h(names[o.sellExchange])}<br><span class="muted">买一 ${n(o.buyBest)} / 卖一 ${n(o.sellBest)}</span></td><td class="number">${h(o.qty || '—')}<br><span class="muted">预算 ${h(o.amount)}</span></td><td class="number">${n(o.buyAvg)} → ${n(o.sellAvg)}<br><span class="muted">限价 ${n(o.buyLimit)} / ${n(o.sellLimit)}</span></td><td class="number">${n(o.buyFee)} + ${n(o.sellFee)}</td><td>${pnl(o.net)}<br><span class="muted">保守 ${pnl(o.conservative)}</span></td><td class="reason">${reasons(o)}</td><td><button data-submit="${h(id)}" data-buy="${h(o.buyExchange)}" ${!state.config.autoTrading || !o.eligible || o.stale ? 'disabled' : ''}>最终复核并提交</button></td></tr>`;
}
function opportunities() {
  const opportunities = Object.values(state.opportunities), rates = Object.values(state.rates);
  const eligible = opportunities.flatMap(x => x.directions || []).filter(x => x.eligible && state.now - (x.sampleAt || 0) <= state.config.maxBookAgeMs).length;
  let html = `<div class="stats">${stat('关注交易对', state.config.pairs.length, '每轮一个，公平轮转')}${stat('完整轮询周期', (state.engine.cycleMs ? (state.engine.cycleMs / 1000).toFixed(1) : '—') + ' 秒', '计划约 ' + (state.engine.estimatedCycleMs / 1000).toFixed(1) + ' 秒')}${stat('利润通过方向', eligible, '不等于可直接下单')}${stat('累计公共请求', rates.reduce((s, r) => s + r.metrics.public, 0), '页面刷新只读取本机缓存')}</div>`;
  const rows = state.config.pairs.flatMap(id => {
    const x = state.opportunities[id];
    if (!x?.directions?.length) return [`<tr><td><b>${h(id)}</b></td><td colspan="7" class="reason">${h(x?.error || '正在排队获取两所有效盘口')}</td></tr>`];
    return x.directions.map(o => directionRow(id, { ...o, stale: x.stale, reasons: x.error ? [x.error, ...o.reasons] : o.reasons }));
  });
  html += card('双向深度与利润', table(['交易对 / 采样时间', '买入 → 卖出', '共同数量', '深度均价 / 限价', '两侧手续费', '净利润', '不成交原因', '操作'], rows));
  for (const id of state.config.pairs) {
    const books = state.config.exchanges.map(ex => {
      const book = state.books[ex]?.[id];
      if (!book) return card(names[ex] + ' · ' + id, '<p>尚未获得有效盘口。旧数据不会被错误响应覆盖。</p>');
      const rows = Array.from({ length: Math.max(book.bids.length, book.asks.length) }, (_, i) => `<tr><td class="positive number">${n(book.bids[i]?.[0])}</td><td class="number">${n(book.bids[i]?.[1])}</td><td class="negative number">${n(book.asks[i]?.[0])}</td><td class="number">${n(book.asks[i]?.[1])}</td></tr>`);
      return `<div class="card book"><div class="book-title"><b>${h(names[ex])} · ${h(id)}</b>${tag(book.stale ? '过期' : '有效', book.stale ? 'bad' : 'good')}</div>${table(['买价', '数量', '卖价', '数量'], rows)}<p>本次返回：买 ${book.receivedBidLevels} 档 / 卖 ${book.receivedAskLevels} 档；合并后 ${book.bidLevels}/${book.askLevels} 档。显示前五档；不假定返回范围外有可用深度。<br>采样：${h(time(book.at))}</p></div>`;
    });
    html += `<div class="grid2">${books.join('')}</div>`;
  }
  html += card('全市场筛选（低优先级）', `<p>只筛选双方共同现货市场，每次一个交易对。实盘运行时暂停全市场扫描，避免占用最终复核和机会额度。</p>${table(['交易对', '最近采样', '买入 → 卖出', '保守利润'], Object.entries(state.scanResults).sort((a, b) => b[1].at - a[1].at).slice(0, 15).map(([id, x]) => { const best = x.directions.filter(y => y.conservative).sort((a, b) => Number(b.conservative) - Number(a.conservative))[0]; return `<tr><td>${h(id)}</td><td>${h(time(x.at))}</td><td>${h(names[best?.buyExchange])} → ${h(names[best?.sellExchange])}</td><td>${pnl(best?.conservative)}</td></tr>`; }))}`, '<button id="scan">开始一轮筛选</button>');
  return html;
}
function balance() {
  const rows = state.config.pairs.map(id => {
    const asset = id.split('/')[0], [a, b] = state.config.exchanges, cfg = state.config.balance[id] || { amount: '50', stopDifference: '0', maxLoss: '0', enabled: false }, d = state.balanceDirections[id];
    return `<tr><td><b>${h(asset)}</b><br>${h(id)}</td><td class="number">${n(state.balances[a]?.assets[asset]?.total)}</td><td class="number">${n(state.balances[b]?.assets[asset]?.total)}</td><td>${h(names[d.buyExchange])} ←买 / 卖→ ${h(names[d.sellExchange])}<br><span class="reason">${reasons(d)}</span></td><td>${h(cfg.amount)}<br><span class="muted">停止差额 ${h(cfg.stopDifference)}</span></td><td>${pnl('-' + cfg.maxLoss)}<br><span class="muted">单笔最大亏损</span></td><td>${tag(cfg.enabled ? '策略已启动' : '已暂停', cfg.enabled ? 'good' : '')}<br><button data-balance="${h(id)}">配置 / 启停</button></td></tr>`;
  });
  return card('按资产独立平衡', `<p>优先复用实时盘口；实际下单仍统一刷新两所规则、余额和完整深度。开启资产策略后，只有全局实盘开启才会发送订单。最大亏损仅影响动态平衡，不影响普通套利门槛。</p>${table(['资产', 'A 库存', 'B 库存', '最新方向 / 原因', '金额 / 差额', '亏损保护', '状态'], rows)}`) + card('最近 10 天动态平衡记录', recordsTable(state.batches.filter(x => x.mode === 'balance' && x.at >= state.now - 10 * 86400000)), '<button id="balance-history">读取完整 10 天记录</button>');
}
function accounts() {
  const assets = [...new Set(Object.values(state.balances).flatMap(b => Object.keys(b.assets)))].sort();
  let html = card('余额健康状态', state.config.exchanges.map(ex => { const b = state.balances[ex]; return `<p><b>${h(names[ex])}</b> ${tag(b?.valid && state.now - b.at <= state.config.maxBalanceAgeMs ? '有效' : '过期或不可用', b?.valid ? '' : 'bad')}　${h(time(b?.at))}<br>${h(b?.error || (b ? '可用余额及冻结余额；最终下单前强制刷新。' : '请先添加并验证查询 Key。'))}</p>`; }).join(''), '<button id="refresh-balances">排队刷新余额</button>');
  html += card('账户资产', table(['资产', 'Binance 可用', 'Binance 冻结', 'OKX 可用', 'OKX 冻结'], assets.map(asset => `<tr><td><b>${h(asset)}</b></td>${['binance', 'okx'].flatMap(ex => ['free', 'locked'].map(k => `<td class="number">${n(state.balances[ex]?.assets[asset]?.[k])}</td>`)).join('')}</tr>`)));
  return html;
}
function keys() {
  const rows = state.keys.map(k => `<tr><td><b>${h(k.label)}</b><br>${h(names[k.exchange])}</td><td>${tag(k.role === 'trade' ? '交易专用' : '查询轮换')}<br><span class="mono">${h(k.hint)}</span></td><td>${h(statuses[k.status] || k.status)}<br><span class="reason">${h(k.lastError || (k.role === 'trade' ? '归属由用户声明；禁止查询验证' : '以交易所返回 UID 验证同账户'))}</span></td><td class="number">${h(k.accountUid || '待验证')}</td><td>${k.requests} / <span class="negative">${k.failures}</span><br>${h(time(k.lastAt))}</td><td>${k.role === 'query' ? `<button data-validate="${h(k.id)}">验证查询 Key</button>` : ''}<button data-toggle="${h(k.id)}" data-enabled="${!k.enabled}">${k.enabled ? '停用' : '启用'}</button></td></tr>`);
  return card('角色隔离与账户归属', '<p>两所各自支持多组 Key。同所查询 Key 必须返回相同账户 UID 才能轮换。交易 Key 从不被查询，必须填写与已验证查询账户一致的 UID 并由你确认归属。请在交易所关闭提现权限并限制 IP；本工具无法在“禁止查询交易 Key”的约束下验证其远端权限。</p>' + table(['名称 / 交易所', '用途 / 脱敏', '验证与工作状态', '账户 UID', '请求 / 失败', '操作'], rows), '<button id="add-key" class="primary">添加 Key</button>');
}
function recordsTable(batches) {
  return table(['时间 / 批次', '类型 / 交易对', '提交状态', '两腿记录', '预计 / 实际净收益', '原因与核对'], batches.map(b => `<tr><td>${h(time(b.at))}<br><span class="mono">${h(b.id)}</span></td><td>${b.mode === 'balance' ? '动态平衡' : '普通套利'}<br><b>${h(b.pair)}</b>${b.archived ? '<br>已归档，阻塞仍保留' : ''}</td><td>${tag(statuses[b.status] || b.status, ['UNKNOWN', 'INCOMPLETE'].includes(b.status) ? 'bad' : '')}<br>${h(b.note || '')}</td><td>${b.legs.map((l, i) => `${h(names[l.exchange])} ${h(l.side)} ${h(l.qty)} @ ${h(l.price)}<br>${h(statuses[l.status] || l.status)} · 订单 ${h(l.orderId || '未知')}<br><span class="mono">${h(l.clientId)}</span>${l.orderId && !l.cancelStatus ? `<br><button data-cancel="${h(b.id)}" data-leg="${i}">申请撤单</button>` : ''}<br>${h(l.cancelStatus || '')}`).join('<hr>') || '尚未发送任何订单'}</td><td>预计 ${pnl(b.expectedNet)}<br>实际 ${b.realizedNet === null ? '<span class="muted">未知，未计入收益</span>' : pnl(b.realizedNet)}</td><td class="reason">${h(b.error || '')}${!['REJECTED', 'RESOLVED'].includes(b.status) ? `<br><button data-resolve="${h(b.id)}">人工核对</button>` : ''}${b.resolution ? `<br>${h(b.resolution.reference)}` : ''}</td></tr>`));
}
function usage() {
  let html = '<div class="grid2">';
  for (const ex of state.config.exchanges) {
    const r = state.rates[ex], m = r.metrics;
    html += card(names[ex] + ' · API 调度', `<div class="stats">${stat('公共 / 私人', m.public + ' / ' + m.private, '私人包含下单')}${stat('订单请求', m.orders, '没有自动重发')}${stat('限流 / 延迟请求', m.limited + ' / ' + m.delayed, '延迟包含预留额度等待')}${stat('最近请求延迟', m.lastLatencyMs + ' ms', '累计排队 ' + n(m.waitMs / 1000) + ' 秒')}</div><p>退避截止：${h(time(r.backoffUntil))}<br><span class="reason">${h(r.reason || '无退避')}</span></p>${table(['额度桶', '已使用', '窗口重置'], Object.entries(r.windows).map(([id, w]) => `<tr><td>${h(id)}</td><td>${w.used}</td><td>${h(time(w.resetAt))}</td></tr>`))}${table(['排队接口', '优先级', '等待 / 预计'], r.queue.map(q => `<tr><td>${h(q.route)}</td><td>${q.priority}</td><td>${n(q.waitedMs / 1000)} 秒 / ${n(q.wait / 1000)} 秒<br>${h(q.reason)}</td></tr>`))}`);
  }
  return html + '</div>' + card('优先级顺序', '<p>0 最终复核及下单 → 1 实时盘口 → 2 动态平衡 → 3 余额刷新及查询验证 → 4 手动扫描 → 5 自动扫描。相同在途盘口请求合并；同一账户限额不会因换 Key 增加。Binance 同时遵守官方返回的所有权重、订单和原始请求窗口及响应头；OKX 使用更严格的聚合限额和接口桶。</p>');
}
function errors() { return card('当前安全阻塞', Object.keys(state.blocks).length ? `<ul class="list">${Object.entries(state.blocks).map(([id, why]) => `<li><b>${h(id)}</b><br>${h(why)}</li>`).join('')}</ul>` : '<p>无未处理批次阻塞。</p>') + card('系统错误', `<ul class="list">${state.errors.map(x => `<li><time>${h(time(x.at))} · ${h(x.scope)}</time><span class="negative">${h(x.message)}</span></li>`).join('') || '<li>暂无错误</li>'}</ul>`) + card('事件记录', `<ul class="list">${state.events.map(x => `<li><time>${h(time(x.at))}</time>${h(x.message)}</li>`).join('') || '<li>暂无事件</li>'}</ul>`); }
function settings() {
  const c = state.config;
  const input = (label, name, value, extra = '') => `<label>${h(label)}<input name="${name}" value="${h(value)}" ${extra}></label>`;
  return card('交易与轮询设置', `<form id="settings-form"><div class="form-grid">${input('关注交易对（逗号分隔）', 'pairs', c.pairs.join(', '))}${input('默认金额（报价资产）', 'amount', c.amount)}${input('备用金额（依次尝试，逗号分隔）', 'fallbackAmounts', c.fallbackAmounts.join(', '))}${input('固定缓冲（报价资产；无额外固定比例滑点）', 'buffer', c.buffer)}${input('Binance taker 费率（0.001 = 0.1%）', 'binanceFee', c.fees.binance)}${input('OKX taker 费率', 'okxFee', c.fees.okx)}${input('深度净利润门槛', 'minDepthProfit', c.minDepthProfit)}${input('限价保守净利润门槛', 'minProfit', c.minProfit)}${input('盘口最大时效（毫秒）', 'maxBookAgeMs', c.maxBookAgeMs, 'type="number"')}${input('余额最大时效（毫秒）', 'maxBalanceAgeMs', c.maxBalanceAgeMs, 'type="number"')}${input('每个交易对轮次间隔（毫秒）', 'slotMs', c.slotMs, 'type="number"')}${input('后台余额刷新间隔（毫秒）', 'balanceRefreshMs', c.balanceRefreshMs, 'type="number"')}${input('Binance 权重上限 / 分钟（100–1200）', 'binanceBudget', c.budgets.binance, 'type="number"')}${input('OKX 请求上限 / 分钟（100–240）', 'okxBudget', c.budgets.okx, 'type="number"')}<label>未知提交处理<select name="unknownAction"><option value="pause" ${c.unknownAction === 'pause' ? 'selected' : ''}>暂停并保留阻塞</option><option value="archive" ${c.unknownAction === 'archive' ? 'selected' : ''}>归档并保留阻塞</option></select></label>${input('全市场扫描报价资产', 'scanQuote', c.scanQuote)}</div><p><label><input name="feeConfirmed" type="checkbox" ${c.feeConfirmed ? 'checked' : ''}>已核对两所账户真实 taker 手续费（费率估算不保证最终费用币种）</label><label><input name="scannerAuto" type="checkbox" ${c.scannerAuto ? 'checked' : ''}>启用自动全市场筛选（仅实盘关闭时运行）</label></p><div class="actions"><button class="primary" type="submit">保存设置</button></div></form>`);
}
function render() {
  if (!state) return;
  $('#title').textContent = pages[page][0]; $('#subtitle').textContent = pages[page][1];
  $('#nav').innerHTML = Object.entries(pages).map(([id, [title]], i) => `<button data-page="${id}" class="${id === page ? 'active' : ''}">${String(i + 1).padStart(2, '0')}　${h(title)}</button>`).join('');
  $('#live').disabled = state.config.autoTrading; $('#stop').disabled = !state.config.autoTrading;
  $('#safety').className = 'banner' + (state.config.autoTrading ? ' live' : '');
  $('#safety').textContent = state.config.autoTrading ? '实盘已开启。所有订单仍需后台最终复核；任何未核对批次会阻塞后续交易。' : '实盘关闭。' + (state.liveReasons.length ? '开启前还需：' + state.liveReasons.join('；') : '账户与规则已就绪，开启需明确确认。');
  $('#updated').textContent = '本机缓存更新 ' + time(state.now);
  if (!editing) $('#content').innerHTML = ({ opportunities, balance, accounts, keys, records: () => card('持久化提交批次', recordsTable(state.batches), '<button id="all-history">读取最近 10 天完整记录</button>'), usage, errors, settings })[page]();
}
async function refresh() { try { state = await api('/api/state'); $('#connection').textContent = '本机在线'; $('#connection').className = 'tag good'; render(); } catch (e) { $('#connection').textContent = '连接中断'; $('#connection').className = 'tag bad'; notice(e.message); } }
function modal(title, html, callback) {
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; $('#modal').showModal();
  const form = $('#modal form'); form.onsubmit = async event => {
    if (event.submitter?.value !== 'ok') return;
    event.preventDefault(); const values = Object.fromEntries(new FormData(form));
    try { await callback(values); $('#modal').close(); await refresh(); } catch (e) { notice(e.message); }
  };
}
document.addEventListener('focusin', e => { if (e.target.closest('#settings-form')) editing = true; });
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.page) { page = button.dataset.page; editing = false; render(); return; }
    if (button.id === 'live') return modal('确认开启真实交易', '<p>双交易所无法原子成交；第一腿受理后第二腿可能失败，IOC 也可能部分成交。提交后不会自动查询成交或补单。请先备妥两边库存。</p><label>输入“确认开启实盘并理解双腿风险”<input name="confirm" autocomplete="off"></label>', async x => { await api('/api/live', { enabled: true, confirm: x.confirm }); });
    if (button.id === 'stop') { await api('/api/live', { enabled: false }); notice('已停止实盘；已发送订单不会因此自动撤销。'); }
    if (button.id === 'scan') { await api('/api/scan', {}); notice('筛选已排队，实盘运行时暂停扫描。'); }
    if (button.id === 'refresh-balances') { await api('/api/balances/refresh', {}); notice('余额刷新已排队。'); }
    if (button.dataset.validate) { await api('/api/keys/validate', { id: button.dataset.validate }); notice('查询 Key 验证已排队。'); }
    if (button.dataset.toggle) await api('/api/keys/toggle', { id: button.dataset.toggle, enabled: button.dataset.enabled === 'true' });
    if (button.id === 'add-key') return modal('添加本地加密 Key', '<div class="form-grid"><label>交易所<select name="exchange"><option value="binance">Binance</option><option value="okx">OKX</option></select></label><label>用途<select name="role"><option value="query">查询专用</option><option value="trade">交易专用（禁止查询）</option></select></label><label>名称<input name="label" maxlength="40" autocomplete="off"></label><label>账户 UID（交易 Key 必填）<input name="accountUid" autocomplete="off"></label><label>API Key<input name="apiKey" type="password" autocomplete="new-password" required></label><label>Secret<input name="secret" type="password" autocomplete="new-password" required></label><label>OKX Passphrase<input name="passphrase" type="password" autocomplete="new-password"></label></div><p><label><input type="checkbox" name="sameAccountConfirmed">我确认交易 Key 属于该 UID 的同一账户，并在交易所禁用提现权限</label></p><p>保存后不会返回完整 Key；查询 Key 需再单独验证。不要在聊天或日志中粘贴密钥。</p>', async x => { await api('/api/keys', { ...x, sameAccountConfirmed: x.sameAccountConfirmed === 'on' }); $('#modal form').reset(); notice('已加密保存。'); });
    if (button.dataset.balance) {
      const id = button.dataset.balance, c = state.config.balance[id] || { amount: '50', stopDifference: '0', maxLoss: '0', enabled: false };
      return modal('动态平衡 · ' + id, `<label>每笔金额<input name="amount" value="${h(c.amount)}"></label><label>停止差额（代币数量）<input name="stopDifference" value="${h(c.stopDifference)}"></label><label>每笔最大亏损（报价资产，默认 0）<input name="maxLoss" value="${h(c.maxLoss)}"></label><label><input name="enabled" type="checkbox" ${c.enabled ? 'checked' : ''}>启动此资产平衡策略</label><label>若设置正数亏损，输入“确认允许动态平衡亏损”<input name="confirm" autocomplete="off"></label>`, async x => { const config = { balance: { ...state.config.balance, [id]: { amount: x.amount, stopDifference: x.stopDifference, maxLoss: x.maxLoss, enabled: x.enabled === 'on' } } }; await api('/api/config', { config, confirm: x.confirm }); });
    }
    if (button.dataset.submit) return modal('后台最终复核并提交', '<p>前端价格和数量不会用于授权交易，后台将重新检查。输入“确认提交该批次”。</p><input name="confirm" autocomplete="off">', async x => { await api('/api/submit', { pair: button.dataset.submit, buyExchange: button.dataset.buy, mode: 'arbitrage', confirm: x.confirm }); });
    if (button.dataset.cancel) return modal('撤销已记录订单', '<p>不自动重试。收到撤单受理不代表没有成交，仍需核对两腿。输入“确认撤销此订单”。</p><input name="confirm" autocomplete="off">', async x => { await api('/api/cancel', { batchId: button.dataset.cancel, legIndex: Number(button.dataset.leg), confirm: x.confirm }); });
    if (button.dataset.resolve) {
      const batch = state.batches.find(x => x.id === button.dataset.resolve);
      return modal('人工核对批次', `<p>请先停止实盘，并在交易所用订单号或 Client ID 核对每一腿、关闭挂单、处理残余敞口。不能把未知订单直接当成失败。</p>${batch.legs.map((l, i) => `<h3>${h(names[l.exchange])} ${h(l.side)}</h3><label>交易所核对结果<select name="outcome${i}"><option value="FILLED">完全成交</option><option value="PARTIAL_CLOSED">部分成交且余量已关闭</option><option value="CANCELED">已撤销</option><option value="REJECTED">确认拒绝</option><option value="NOT_FOUND_CONFIRMED">已在交易所确认未受理</option></select></label><label>实际成交数量<input name="qty${i}" required></label>`).join('')}<label>核对依据及残余库存处理说明（至少 8 字符）<textarea name="reference" required></textarea></label><label>实际两腿总净收益（含所有费用）<input name="realizedNet" required></label><label>输入“已在交易所核对两腿及库存”<input name="confirm" autocomplete="off"></label>`, async x => { await api('/api/resolve', { id: batch.id, confirm: x.confirm, reference: x.reference, realizedNet: x.realizedNet, legs: batch.legs.map((l, i) => ({ outcome: x['outcome' + i], executedQty: x['qty' + i], openQty: '0' })) }); });
    }
    if (['balance-history', 'all-history'].includes(button.id)) {
      const mode = button.id === 'balance-history' ? '&mode=balance' : ''; let offset = 0, records = [], result;
      do { result = await api(`/api/records?limit=1000&offset=${offset}${mode}`); records.push(...result.records); offset += result.records.length; } while (offset < result.total && result.records.length);
      $('#content').innerHTML = card('最近 10 天完整记录 · ' + records.length + ' 批次', recordsTable(records)); editing = true;
    }
    await refresh();
  } catch (err) { notice(err.message); }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'settings-form') return;
  e.preventDefault(); const f = new FormData(e.target), get = x => f.get(x);
  const config = { pairs: get('pairs').split(',').map(x => x.trim().toUpperCase()).filter(Boolean), amount: get('amount'), fallbackAmounts: get('fallbackAmounts').split(',').map(x => x.trim()).filter(Boolean),
    fees: { binance: get('binanceFee'), okx: get('okxFee') }, buffer: get('buffer'), minProfit: get('minProfit'), minDepthProfit: get('minDepthProfit'),
    budgets: { binance: Number(get('binanceBudget')), okx: Number(get('okxBudget')) }, unknownAction: get('unknownAction'), scanQuote: get('scanQuote').toUpperCase(), feeConfirmed: f.has('feeConfirmed'), scannerAuto: f.has('scannerAuto') };
  for (const field of ['maxBookAgeMs', 'maxBalanceAgeMs', 'slotMs', 'balanceRefreshMs']) config[field] = Number(get(field));
  try { await api('/api/config', { config }); editing = false; notice('设置已保存。'); await refresh(); } catch (err) { notice(err.message); }
});
try { csrf = (await api('/api/session')).csrf; await refresh(); setInterval(refresh, 2000); } catch (e) { notice(e.message); }
