const $ = s => document.querySelector(s);
const h = x => String(x ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = x => {
  if (x == null) return '—';
  const value = Number(x);
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', value !== 0 && Math.abs(value) < 1e-8
    ? { maximumSignificantDigits: 12, useGrouping: false } : { maximumFractionDigits: 8 });
};
const time = x => x ? new Date(x).toLocaleString('zh-CN', { hour12: false }) : '—';
const tag = (text, kind = '') => `<span class="tag ${kind}">${h(text)}</span>`;
const pnl = x => `<span class="number ${Number(x) < 0 ? 'negative' : 'positive'}">${h(n(x))}</span>`;
const names = { binance: 'Binance', okx: 'OKX' };
const statuses = { PREPARING: '最终复核中', SUBMITTING: '提交中', SUBMITTED: '已受理 · 成交未确认', UNKNOWN: '提交结果未知', INCOMPLETE: '双腿不完整', REJECTED: '未提交／已拒绝', RESOLVED: '已人工核对', ACKNOWLEDGED: '收到订单号', SENDING: '正在发送', VERIFIED: '查询已验证', CONFIGURED_NOT_QUERIED: '交易 Key 已配置 · 不查询', FAILED: '验证失败', UNVERIFIED: '未验证' };
const pages = { opportunities: ['实时机会', '穿透真实深度，以保守利润作为最后一道门槛。'], balance: ['动态平衡', '高库存端卖出、低库存端买入；不通过转账平衡。'], accounts: ['账户余额', '仅通过查询 Key 获取；更新失败保留旧值并禁止该路径。'], keys: ['API Key 状态', '凭据仅在本机加密保存，交易 Key 永不参与查询。'], records: ['提交记录', '提交、受理、成交状态严格区分，未知结果不自动重发。'], usage: ['API 调度', '统一排队、独立限速，为最终复核保留额度。'], errors: ['系统与错误', '记录具体阻塞原因，不使用模糊的“未满足条件”。'], settings: ['设置', '调整金额、费率与门槛。修改前请先停止实盘。'] };
statuses.WORKING_NOT_QUERIED = '交易请求已受理 · 未查询';
let page = 'opportunities', state, csrf, editing = false, noticeTimer, settingsPolicyBaseline;
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 12000); }
async function api(path, data) {
  const response = await fetch(path, data === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || '本机请求失败'); return result;
}
function table(heads, rows, empty = '暂无数据') { return `<div class="table-wrap"><table><thead><tr>${heads.map(x => `<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${heads.length}" class="empty">${h(empty)}</td></tr>`}</tbody></table></div>`; }
function card(title, content, action = '') { return `<div class="card"><div class="card-head"><h2>${h(title)}</h2>${action}</div>${content}</div>`; }
function stat(label, value, note) { return `<div class="stat"><span class="label">${h(label)}</span><strong>${h(value)}</strong><small>${h(note)}</small></div>`; }
function reasons(o) { return (o?.reasons || []).map(h).join('<br>') || '未发现计算阻塞；仍须后台最终复核'; }
function capitalPreview(o) {
  const c = o?.capital;
  if (!c?.enabled && !state.config.capital?.enabled) return '';
  const checked = c?.checked === true;
  const label = checked ? '缓存配额估计' : '资金未核对';
  return `<p class="help">${tag(label, checked ? '' : 'bad')} ${h(c?.error || (checked ? '按缓存余额估算可用配额。' : '余额缺失、过期或尚未完成资金核对。'))}<br>缓存预览仅供估计，不能授权下单；提交前仍须刷新余额、盘口并完成最终复核。</p>`;
}
function directionRow(id, o) {
  return `<tr><td><b>${h(id)}</b><br>${tag(o.stale ? '已过期' : o.eligible ? '利润通过' : '不满足', o.eligible && !o.stale ? 'good' : '')}<br><span class="muted">${h(time(o.sampleAt || o.at))}</span></td><td>${h(names[o.buyExchange])} → ${h(names[o.sellExchange])}<br><span class="muted">买一 ${n(o.buyBest)} / 卖一 ${n(o.sellBest)}</span></td><td class="number">${h(o.qty || '—')}<br><span class="muted">预算 ${h(o.amount)}</span></td><td class="number">${n(o.buyAvg)} → ${n(o.sellAvg)}<br><span class="muted">限价 ${n(o.buyLimit)} / ${n(o.sellLimit)}</span></td><td class="number">${n(o.buyFee)} + ${n(o.sellFee)}</td><td>${pnl(o.net)}<br><span class="muted">保守 ${pnl(o.conservative)}</span></td><td class="reason">${reasons(o)}</td><td><button data-submit="${h(id)}" data-buy="${h(o.buyExchange)}" ${!state.config.autoTrading || !o.eligible || o.stale ? 'disabled' : ''}>最终复核并提交</button></td></tr>`;
}
function opportunityDetails(id, directions) {
  const metrics = directions.map(o => `<details><summary>${h(names[o.buyExchange] || o.buyExchange)} → ${h(names[o.sellExchange] || o.sellExchange)} · 成本与流动性</summary>${capitalPreview(o)}<div class="metric-grid">${[
    ['执行净收益（已扣两侧手续费与固定缓冲）', n(o.executionNet)],
    ['库存再平衡成本估计', n(o.rebalanceCost)],
    ['合计成本（手续费、缓冲、再平衡估计）', n(o.totalCosts)],
    ['保守净收益率（买入最坏成本口径）', o.netBps == null ? '—' : n(o.netBps) + ' bp'],
    ['买入所内价差', o.buySpreadBps == null ? '—' : n(o.buySpreadBps) + ' bp'],
    ['卖出所内价差', o.sellSpreadBps == null ? '—' : n(o.sellSpreadBps) + ' bp'],
    ['两所盘口本机接收时差', o.bookSkewMs == null ? '—' : n(o.bookSkewMs) + ' ms'],
    ['买入限价内有效深度（报价资产）', n(o.buyDepthNotional)],
    ['卖出限价内有效深度（报价资产）', n(o.sellDepthNotional)]
  ].map(([label, value]) => `<div><span class="muted">${h(label)}</span><strong class="number">${h(value)}</strong></div>`).join('')}</div></details>`).join('');
  return card('成本与流动性 · ' + id, metrics + '<p>净利润与保守净利润已扣再平衡估计，不再重复扣费。收益率以单批买入最坏成本为分母，不是年化收益或全部资金回报率。时差取本机接收时间；有效深度只计最终限价内的档位。</p>');
}
function riskResetBlocked() {
  if (!state.risk?.latched) return '当前没有可复位的熔断';
  if (state.config.autoTrading) return '请先停止实盘';
  if (state.engine.busy) return '请等待正在执行的批次完成';
  if (state.batches.some(b => !['REJECTED', 'RESOLVED'].includes(b.status))) return '请先人工核对全部未处理批次';
  return '';
}
function riskPanel() {
  const r = state.risk;
  if (!r) return card('风险熔断', '<p>风险状态尚未读取。请等待本机状态更新。</p>');
  const quotes = [...new Set([...Object.keys(r.lossByQuote || {}), ...Object.keys(r.limits || {}), ...Object.keys(r.latches || {})])].sort();
  const rows = quotes.map(quote => { const latch = r.latches?.[quote]; return `<tr><td><b>${h(quote)}</b></td><td class="number">${h(n(r.lossByQuote?.[quote] ?? '0'))}</td><td>${r.limits?.[quote] == null ? '未设限额' : h(n(r.limits[quote]))}</td><td>${tag(latch ? '已熔断' : '未熔断', latch ? 'bad' : '')}${latch ? `<br><span class="muted">触发日 ${h(latch.day)} · 亏损 ${h(latch.loss)} / 限额 ${h(latch.limit)}<br>${h(time(latch.at))}</span>` : ''}</td></tr>`; });
  const blocked = riskResetBlocked();
  return card('风险熔断', `<p>${tag(r.latched ? '已锁定 · 停止新单' : '未熔断', r.latched ? 'bad' : 'good')}　统计日 ${h(r.day)}（${h(r.timeZone || 'Asia/Shanghai')}）<br>仅累计人工核对的实际亏损，盈利不抵消亏损，预计再平衡成本不重复计入。熔断停止新单，不会自动平仓；重启、跨日或提高限额均不会自动解除。</p>${table(['报价资产', '当日已核对累计亏损', '当日亏损限额', '持久化熔断'], rows, '尚无已核对亏损或限额；可在设置中按报价资产配置。')}<p>${h(blocked || '复位前须确认库存和异常；当日亏损仍达到限额时，后台将拒绝复位。')}</p>`, `<button id="risk-reset" ${blocked ? 'disabled' : ''}>人工复位熔断</button>`);
}
function scannerPoolIncludes(id) {
  const excluded = state.config.scanExcludeAssets ?? ['BTC', 'ETH', 'SOL'];
  const included = state.config.scanPairs ?? [];
  return id.endsWith('/' + state.config.scanQuote) && !excluded.includes(id.split('/')[0]) && (!included.length || included.includes(id));
}
function scannerSample(entry, direction = {}) {
  const sampledAt = direction.sampleAt ?? direction.at ?? entry.at;
  const age = state.now - sampledAt;
  const failed = Boolean(entry.failed || entry.error || entry.failedAt);
  const fresh = !failed && !entry.stale && Number.isFinite(sampledAt) && age >= 0 && age <= state.config.maxBookAgeMs;
  const hasProfit = direction.conservative != null && direction.conservative !== '' && Number.isFinite(Number(direction.conservative));
  return { direction, sampledAt, failed, fresh, hasProfit, eligible: fresh && direction.eligible === true && Boolean(direction.qty) };
}
function scannerRank(sample) { return sample.eligible ? 0 : sample.fresh && sample.hasProfit ? 1 : sample.fresh ? 2 : sample.failed ? 4 : 3; }
function scannerCompare(a, b) {
  return scannerRank(a) - scannerRank(b) || (a.hasProfit && b.hasProfit ? Number(b.direction.conservative) - Number(a.direction.conservative) : 0);
}
function scannerProfit(value, fresh) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  return fresh ? pnl(value) : `<span class="muted number">历史 ${h(n(value))}</span>`;
}
function scannerPanel() {
  const run = state.engine.scanRun, active = ['PREPARING', 'RUNNING'].includes(run?.status);
  const labels = { PREPARING: '正在准备', RUNNING: '扫描中', COMPLETED: '本轮完成', STOPPED: '已停止', INTERRUPTED: '重启后已中断', FAILED: '扫描失败' };
  const entries = Object.entries(state.scanResults || {}).filter(([id]) => scannerPoolIncludes(id)).map(([id, entry]) => {
    const directions = (entry.directions || []).map(direction => scannerSample(entry, direction)).sort(scannerCompare);
    return { id, entry, ...(directions[0] || scannerSample(entry)) };
  }).sort((a, b) => scannerCompare(a, b) || Number(b.entry.at || 0) - Number(a.entry.at || 0) || a.id.localeCompare(b.id));
  const progress = run ? `<p>${tag(labels[run.status] || run.status, active ? 'good' : '')}　已处理 ${h(run.completed ?? 0)} / ${h(run.total ?? 0)}，其中失败 ${h(run.failed ?? 0)}${run.currentPair ? ' · 当前 ' + h(run.currentPair) : ''}<br>开始 ${h(time(run.startedAt))} · 结束 ${h(time(run.endedAt))}${run.error ? '<br><span class="negative">' + h(run.error) + '</span>' : ''}${run.reason ? '<br><span class="muted">说明：' + h(run.reason) + '</span>' : ''}</p>` : '<p>尚未开始本轮筛选。点击“开始一轮筛选”后显示进度。</p>';
  const rows = entries.slice(0, 50).map(sample => {
    const { id, entry, direction: d, fresh, failed, sampledAt, eligible } = sample;
    const watched = state.config.pairs.includes(id), blocked = state.config.autoTrading || state.engine.busy || watched || state.config.pairs.length >= 30;
    const details = (entry.directions || []).map(direction => {
      const attempts = direction.attempts?.length ? direction.attempts : [direction];
      return `<div><p><b>${h(names[direction.buyExchange] || direction.buyExchange)} → ${h(names[direction.sellExchange] || direction.sellExchange)}</b></p>${capitalPreview(direction)}<p>${attempts.map(attempt => `试算金额 ${h(attempt.amount ?? direction.amount ?? '—')}：深度净利 ${h(n(attempt.net))}，保守净利 ${h(n(attempt.conservative))}<br>${reasons(attempt)}`).join('<br>')}</p></div>`;
    }).join('') || '<p>尚无有效深度计算。</p>';
    return `<tr data-scan-pair="${h(id)}"><td><b>${h(id)}</b><br>${tag(failed ? '最近失败' : fresh ? eligible ? '通过 · 待复核' : '不满足' : '已过期', failed ? 'bad' : eligible ? 'good' : '')}</td><td>${h(time(sampledAt || entry.at))}${entry.failedAt ? '<br><span class="negative">最近失败 ' + h(time(entry.failedAt)) + '</span>' : ''}</td><td>${h(names[d.buyExchange] || d.buyExchange)} → ${h(names[d.sellExchange] || d.sellExchange)}<br>金额 ${h(d.amount ?? '—')}</td><td>深度 ${scannerProfit(d.net, fresh)}<br>保守 ${scannerProfit(d.conservative, fresh)}<br><span class="muted">${fresh ? '' : '历史 '}收益率 ${h(n(d.netBps))} bp</span></td><td class="number">买侧 ${h(n(d.buyDepthNotional))}<br>卖侧 ${h(n(d.sellDepthNotional))}</td><td class="reason">${failed ? '<span class="negative">' + h(entry.error || '最近筛选失败，历史计算已失效') + '</span><br>' : ''}${!fresh ? '<span class="muted">历史数据不能视为当前机会；加入关注后重新采样。</span>' : ''}${d.capital?.enabled && !d.capital.checked ? '<span class="muted">资金未核对，当前仅为盘口估计。</span>' : ''}<details><summary>不成交原因与各金额试算</summary>${details}</details></td><td><button data-watch="${h(id)}" ${blocked ? 'disabled' : ''}>${watched ? '已关注' : '加入关注'}</button></td></tr>`;
  });
  const excluded = state.config.scanExcludeAssets ?? ['BTC', 'ETH', 'SOL'];
  const included = state.config.scanPairs ?? [];
  const note = `<p>按两所共同现货市场筛选，排除 ${h(excluded.join(', ') || '无')}；${included.length ? '限定候选 ' + h(included.length) + ' 对' : '候选范围为全部共同市场'}。可在设置中编辑名单，并使用有效深度及利润门槛过滤。这里没有真实流通市值数据；低单价或低成交额不代表小市值。同名交易对仍需核对为同一资产。<br>每次一对，间隔至少 10 秒，实时机会优先；实盘时暂停筛选。按有效且满足门槛的保守净利润优先排序，过期与失败结果仅作历史参考，最多显示前 50 项。加入关注只更新监控名单，不提交交易；关注最多 30 对，数量增加会延长轮询。</p>`;
  return card('中小币候选池（低优先级）', note + progress + table(['交易对 / 状态', '采样时间', '买入 → 卖出 / 试算金额', '扣费净收益 / 收益率', '限价内有效深度', '失败与试算原因', '操作'], rows, '当前候选池尚无扫描结果；请先保存排除与候选名单，再开始一轮筛选。'), `<div class="actions"><button id="scan" ${state.config.autoTrading || state.engine.busy || active ? 'disabled' : ''}>开始一轮筛选</button><button id="scan-stop" ${!active && !state.config.scannerAuto ? 'disabled' : ''}>停止筛选</button></div>`);
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
  html += riskPanel();
  for (const id of state.config.pairs) {
    if (state.opportunities[id]?.directions?.length) html += opportunityDetails(id, state.opportunities[id].directions);
    const books = state.config.exchanges.map(ex => {
      const book = state.books[ex]?.[id];
      if (!book) return card(names[ex] + ' · ' + id, '<p>尚未获得有效盘口。旧数据不会被错误响应覆盖。</p>');
      const rows = Array.from({ length: Math.max(book.bids.length, book.asks.length) }, (_, i) => `<tr><td class="positive number">${n(book.bids[i]?.[0])}</td><td class="number">${n(book.bids[i]?.[1])}</td><td class="negative number">${n(book.asks[i]?.[0])}</td><td class="number">${n(book.asks[i]?.[1])}</td></tr>`);
      return `<div class="card book"><div class="book-title"><b>${h(names[ex])} · ${h(id)}</b>${tag(book.stale ? '过期' : '有效', book.stale ? 'bad' : 'good')}</div>${table(['买价', '数量', '卖价', '数量'], rows)}<p>本次返回：买 ${book.receivedBidLevels} 档 / 卖 ${book.receivedAskLevels} 档；合并后 ${book.bidLevels}/${book.askLevels} 档。显示前五档；不假定返回范围外有可用深度。<br>采样：${h(time(book.at))}</p></div>`;
    });
    html += `<div class="grid2">${books.join('')}</div>`;
  }
  html += scannerPanel();
  return html;
}
function balance() {
  const rows = state.config.pairs.map(id => {
    const asset = id.split('/')[0], [a, b] = state.config.exchanges, cfg = state.config.balance[id] || { amount: '50', stopDifference: '0', maxLoss: '0', enabled: false }, d = state.balanceDirections[id];
    return `<tr><td><b>${h(asset)}</b><br>${h(id)}</td><td class="number">${n(state.balances[a]?.assets[asset]?.total)}</td><td class="number">${n(state.balances[b]?.assets[asset]?.total)}</td><td>${h(names[d.buyExchange])} ←买 / 卖→ ${h(names[d.sellExchange])}<br><span class="reason">${reasons(d)}</span>${capitalPreview(d)}</td><td>${h(cfg.amount)}<br><span class="muted">停止差额 ${h(cfg.stopDifference)}</span></td><td>${pnl('-' + cfg.maxLoss)}<br><span class="muted">单笔最大亏损</span></td><td>${tag(cfg.enabled ? '策略已启动' : '已暂停', cfg.enabled ? 'good' : '')}<br><button data-balance="${h(id)}">配置 / 启停</button></td></tr>`;
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
function errors() { return riskPanel() + card('当前安全阻塞', Object.keys(state.blocks).length ? `<ul class="list">${Object.entries(state.blocks).map(([id, why]) => `<li><b>${h(id)}</b><br>${h(why)}</li>`).join('')}</ul>` : '<p>无未处理批次阻塞。</p>') + card('系统错误', `<ul class="list">${state.errors.map(x => `<li><time>${h(time(x.at))} · ${h(x.scope)}</time><span class="negative">${h(x.message)}</span></li>`).join('') || '<li>暂无错误</li>'}</ul>`) + card('事件记录', `<ul class="list">${state.events.map(x => `<li><time>${h(time(x.at))}</time>${h(x.message)}</li>`).join('') || '<li>暂无事件</li>'}</ul>`); }
function policyCell(field, label, value, placeholder = '') {
  return `<input data-field="${field}" aria-label="${h(label)}" value="${h(value ?? '')}" placeholder="${h(placeholder)}" ${['quote', 'asset'].includes(field) ? 'autocomplete="off"' : 'inputmode="decimal"'}>`;
}
function quotePolicyRow(quote = '', cost = '0', limit = '') {
  return `<tr data-quote-policy-row><td>${policyCell('quote', '报价资产', quote, '例如 USDT')}</td><td>${policyCell('rebalance', '单批再平衡成本估计', cost, '0')}</td><td>${policyCell('loss', '当日已核对亏损限额', limit, '留空不设限额')}</td><td><button type="button" data-policy-remove>删除</button></td></tr>`;
}
function capitalPolicyRow(exchange = state.config.exchanges[0], asset = '', caps = {}) {
  return `<tr data-capital-policy-row><td><select data-field="exchange" aria-label="资金配额交易所">${state.config.exchanges.map(ex => `<option value="${h(ex)}" ${ex === exchange ? 'selected' : ''}>${h(names[ex] || ex)}</option>`).join('')}</select></td><td>${policyCell('asset', '配额资产', asset, '例如 BTC')}</td><td>${policyCell('reserve', '预留可用库存', caps.reserve ?? '0', '0')}</td><td>${policyCell('maxOrder', '单批最大支出数量', caps.maxOrder, '留空不限；0 禁止支出')}</td><td>${policyCell('maxHolding', '买入后最大总库存', caps.maxHolding, '留空不限')}</td><td><button type="button" data-policy-remove>删除</button></td></tr>`;
}
function settings() {
  const c = state.config, filters = c.filters || {}, costs = c.costs?.rebalanceByQuote || {}, limits = c.risk?.dailyLossByQuote || {}, capital = c.capital || {};
  settingsPolicyBaseline = structuredClone({ costs, limits, byExchange: capital.byExchange || {} });
  const input = (label, name, value, extra = '') => `<label>${h(label)}<input name="${name}" value="${h(value ?? '')}" ${extra}></label>`;
  const quotes = [...new Set([...c.pairs.map(id => id.split('/')[1]), ...Object.keys(costs), ...Object.keys(limits)])].sort();
  const capitalRows = Object.entries(capital.byExchange || {}).flatMap(([ex, assets]) => Object.entries(assets).map(([asset, caps]) => capitalPolicyRow(ex, asset, caps)));
  return card('交易与轮询设置', `<form id="settings-form"><div class="form-grid">${input('关注交易对（逗号分隔）', 'pairs', c.pairs.join(', '))}${input('默认金额（报价资产）', 'amount', c.amount)}${input('备用金额（依次尝试，逗号分隔）', 'fallbackAmounts', c.fallbackAmounts.join(', '))}${input('固定缓冲（报价资产；无额外固定比例滑点）', 'buffer', c.buffer)}${input('Binance taker 费率（0.001 = 0.1%）', 'binanceFee', c.fees.binance)}${input('OKX taker 费率', 'okxFee', c.fees.okx)}${input('深度净利润门槛', 'minDepthProfit', c.minDepthProfit)}${input('限价保守净利润门槛', 'minProfit', c.minProfit)}${input('盘口最大时效（毫秒）', 'maxBookAgeMs', c.maxBookAgeMs, 'type="number"')}${input('余额最大时效（毫秒）', 'maxBalanceAgeMs', c.maxBalanceAgeMs, 'type="number"')}${input('每个交易对轮次间隔（毫秒）', 'slotMs', c.slotMs, 'type="number"')}${input('后台余额刷新间隔（毫秒）', 'balanceRefreshMs', c.balanceRefreshMs, 'type="number"')}${input('Binance 权重上限 / 分钟（100–1200）', 'binanceBudget', c.budgets.binance, 'type="number"')}${input('OKX 请求上限 / 分钟（100–240）', 'okxBudget', c.budgets.okx, 'type="number"')}<label>未知提交处理<select name="unknownAction"><option value="pause" ${c.unknownAction === 'pause' ? 'selected' : ''}>暂停并保留阻塞</option><option value="archive" ${c.unknownAction === 'archive' ? 'selected' : ''}>归档并保留阻塞</option></select></label>${input('候选池报价资产', 'scanQuote', c.scanQuote)}${input('扫描排除基础币（逗号分隔）', 'scanExcludeAssets', (c.scanExcludeAssets ?? ['BTC', 'ETH', 'SOL']).join(', '))}${input('扫描候选交易对（留空为全部共同市场）', 'scanPairs', (c.scanPairs ?? []).join(', '))}</div>
    <h3>成本与流动性筛选</h3><p>再平衡成本按报价资产设置，只影响普通套利；净利润与保守净利润中各扣一次，不能另填入两侧费率。收益率门槛同样只影响普通套利；其他流动性保护适用于所有新单。留空表示不启用可选筛选，填写 0 保留零值含义。</p><div class="form-grid">${input('最低保守净收益率（bp；买入最坏成本口径）', 'filterMinNetBps', filters.minNetBps ?? '0', 'inputmode="decimal"')}${input('每所最大盘口价差（bp；留空不限）', 'filterMaxSpreadBps', filters.maxSpreadBps, 'inputmode="decimal"')}${input('每侧限价内最小有效深度（报价资产）', 'filterMinDepthNotional', filters.minDepthNotional ?? '0', 'inputmode="decimal"')}${input('两所盘口本机接收最大时差（毫秒；留空不限）', 'filterMaxBookSkewMs', filters.maxBookSkewMs, 'type="number" min="0" max="60000" step="1"')}</div>
    <h3>按报价资产配置成本与风险限额</h3><p>亏损限额按 Asia/Shanghai 自然日统计人工核对的实际亏损，盈利不抵消；空白不设限额，0 表示出现任何实际亏损即熔断。删除或提高限额不会解除已有熔断。</p><div id="quote-policies">${table(['报价资产', '单批再平衡成本估计', '当日已核对亏损限额', '操作'], quotes.map(q => quotePolicyRow(q, costs[q] ?? '0', limits[q] ?? '')))}</div><button id="add-quote-policy" type="button">增加报价资产</button>
    <h3>每所、每资产资金配额</h3><label><input type="checkbox" name="capitalEnabled" ${capital.enabled ? 'checked' : ''}>启用资金配额与预留库存</label><p>数量均以该行资产计。预留从可用余额中保留；单批最大支出作用于买入端报价资产和卖出端基础资产。买入后最大总库存仅限制买入的基础资产，不能假定另一腿成交抵消。上限留空不限，显式填写 0 禁止相应额度；未配置资产没有自定义上限。配额缩量后，后台重新计算深度、限价及利润。</p><div id="capital-policies">${table(['交易所', '资产', '预留可用库存', '单批最大支出', '买入后最大总库存', '操作'], capitalRows, '尚无自定义配额；点击“增加资产配额”配置。')}</div><button id="add-capital-policy" type="button">增加资产配额</button>
    <p><label><input name="feeConfirmed" type="checkbox" ${c.feeConfirmed ? 'checked' : ''}>已核对两所账户真实 taker 手续费（费率估算不保证最终费用币种）</label><label><input name="scannerAuto" type="checkbox" ${c.scannerAuto ? 'checked' : ''}>启用自动候选池筛选（仅实盘关闭时运行）</label></p><div class="actions"><button class="primary" type="submit">保存设置</button></div></form>`) + riskPanel();
}
function render() {
  if (!state) return;
  $('#title').textContent = pages[page][0]; $('#subtitle').textContent = pages[page][1];
  $('#nav').innerHTML = Object.entries(pages).map(([id, [title]], i) => `<button data-page="${id}" class="${id === page ? 'active' : ''}">${String(i + 1).padStart(2, '0')}　${h(title)}</button>`).join('');
  $('#live').disabled = state.config.autoTrading; $('#stop').disabled = !state.config.autoTrading;
  $('#safety').className = 'banner' + (state.config.autoTrading ? ' live' : '');
  $('#safety').textContent = state.config.autoTrading ? '实盘已开启。所有订单仍需后台最终复核；任何未核对批次会阻塞后续交易。' : '实盘关闭。' + (state.liveReasons.length ? '开启前还需：' + state.liveReasons.join('；') : '账户与规则已就绪，开启需明确确认。');
  if (state.risk?.latched) $('#safety').textContent += ' 风险熔断已锁定：停止新单，重启不会解除；现有订单及库存须人工核对。';
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
    if (button.id === 'add-quote-policy' || button.id === 'add-capital-policy') {
      const quote = button.id === 'add-quote-policy', target = $(quote ? '#quote-policies tbody' : '#capital-policies tbody');
      target.querySelector('.empty')?.closest('tr').remove();
      target.insertAdjacentHTML('beforeend', quote ? quotePolicyRow() : capitalPolicyRow()); editing = true; return;
    }
    if (button.hasAttribute('data-policy-remove')) { button.closest('tr').remove(); editing = true; return; }
    if (button.id === 'risk-reset') {
      const blocked = riskResetBlocked(); if (blocked) throw Error(blocked);
      return modal('人工复位风险熔断', '<p>复位会解除全部币种的持久化熔断，保留已核对亏损和复位记录。请先停止实盘、核对全部异常和库存；当日亏损仍达到当前限额时不能复位。复位不会开启实盘或自动处理已有仓位。</p><label>输入“确认复位风险熔断”<input name="confirm" autocomplete="off"></label>', async x => {
        const reason = riskResetBlocked(); if (reason) throw Error(reason);
        if (x.confirm !== '确认复位风险熔断') throw Error('请输入完整确认文字：确认复位风险熔断');
        await api('/api/risk/reset', { confirm: x.confirm }); notice('风险熔断已人工复位；实盘仍保持关闭。');
      });
    }
    if (button.id === 'live') return modal('确认开启真实交易', '<p>双交易所无法原子成交；第一腿受理后第二腿可能失败，IOC 也可能部分成交。提交后不会自动查询成交或补单。请先备妥两边库存。</p><label>输入“确认开启实盘并理解双腿风险”<input name="confirm" autocomplete="off"></label>', async x => { await api('/api/live', { enabled: true, confirm: x.confirm }); });
    if (button.id === 'stop') { await api('/api/live', { enabled: false }); notice('已停止实盘；已发送订单不会因此自动撤销。'); }
    if (button.id === 'scan') {
      if (state.config.autoTrading || state.engine.busy || ['PREPARING', 'RUNNING'].includes(state.engine.scanRun?.status)) throw Error('请先停止实盘或等待当前筛选完成');
      await api('/api/scan', {}); notice('候选池新一轮筛选已排队，进度将在页面显示。');
    }
    if (button.id === 'scan-stop') {
      if (!['PREPARING', 'RUNNING'].includes(state.engine.scanRun?.status) && !state.config.scannerAuto) return;
      await api('/api/scan/stop', {}); notice('已停止候选池筛选；实时行情监控继续运行。');
    }
    if (button.dataset.watch) {
      const id = button.dataset.watch;
      if (state.config.autoTrading || state.engine.busy) throw Error('请先停止实盘并等待正在执行的批次完成');
      if (state.config.pairs.includes(id)) throw Error('该交易对已经在关注列表');
      if (state.config.pairs.length >= 30) throw Error('关注交易对已达到 30 对上限，请先在设置中精简');
      if (!state.scanResults[id] || !scannerPoolIncludes(id) || !/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/.test(id)) throw Error('该交易对不在当前候选池');
      await api('/api/config', { config: { pairs: [...state.config.pairs, id] } });
      notice('已加入关注，后台将重新采样；未提交交易。');
    }
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
function policyConfig(form, f) {
  const optional = value => String(value ?? '').trim() || null;
  const symbol = value => { const asset = value.trim().toUpperCase(); if (!/^[A-Z0-9]{2,15}$/.test(asset)) throw Error('资产名称须为 2–15 位大写字母或数字'); return asset; };
  const baseline = settingsPolicyBaseline || { costs: {}, limits: {}, byExchange: {} };
  const rebalanceByQuote = Object.fromEntries(Object.keys(baseline.costs).map(quote => [quote, null]));
  const dailyLossByQuote = Object.fromEntries(Object.keys(baseline.limits).map(quote => [quote, null]));
  const byExchange = Object.fromEntries(state.config.exchanges.map(ex => [ex, Object.fromEntries(Object.keys(baseline.byExchange[ex] || {}).map(asset => [asset, null]))]));
  const seenQuotes = new Set(), seenCapital = new Set();
  for (const row of form.querySelectorAll('[data-quote-policy-row]')) {
    const value = key => row.querySelector(`[data-field="${key}"]`).value.trim();
    const quote = symbol(value('quote')); if (seenQuotes.has(quote)) throw Error('报价资产重复：' + quote); seenQuotes.add(quote);
    if (value('rebalance')) rebalanceByQuote[quote] = value('rebalance');
    if (value('loss')) dailyLossByQuote[quote] = value('loss');
  }
  for (const row of form.querySelectorAll('[data-capital-policy-row]')) {
    const value = key => row.querySelector(`[data-field="${key}"]`).value.trim();
    const exchange = value('exchange'), asset = symbol(value('asset'));
    if (!byExchange[exchange]) throw Error('资金配额交易所无效');
    const key = exchange + '/' + asset;
    if (seenCapital.has(key)) throw Error('资金配额重复：' + exchange + ' / ' + asset); seenCapital.add(key);
    byExchange[exchange][asset] = { reserve: value('reserve') || '0', maxOrder: optional(value('maxOrder')), maxHolding: optional(value('maxHolding')) };
  }
  const skewText = optional(f.get('filterMaxBookSkewMs'));
  if (skewText !== null && (!/^\d+$/.test(skewText) || Number(skewText) > 60000)) throw Error('盘口接收最大时差须为 0–60000 的整数毫秒，或留空');
  return { costs: { rebalanceByQuote }, risk: { dailyLossByQuote }, capital: { enabled: f.has('capitalEnabled'), byExchange }, filters: {
    minNetBps: optional(f.get('filterMinNetBps')) ?? '0', maxSpreadBps: optional(f.get('filterMaxSpreadBps')), minDepthNotional: optional(f.get('filterMinDepthNotional')) ?? '0', maxBookSkewMs: skewText === null ? null : Number(skewText)
  } };
}
document.addEventListener('submit', async e => {
  if (e.target.id !== 'settings-form') return;
  e.preventDefault(); const f = new FormData(e.target), get = x => f.get(x);
  const config = { pairs: get('pairs').split(',').map(x => x.trim().toUpperCase()).filter(Boolean), amount: get('amount'), fallbackAmounts: get('fallbackAmounts').split(',').map(x => x.trim()).filter(Boolean),
    fees: { binance: get('binanceFee'), okx: get('okxFee') }, buffer: get('buffer'), minProfit: get('minProfit'), minDepthProfit: get('minDepthProfit'),
    budgets: { binance: Number(get('binanceBudget')), okx: Number(get('okxBudget')) }, unknownAction: get('unknownAction'), scanQuote: get('scanQuote').toUpperCase(), scanExcludeAssets: get('scanExcludeAssets').split(',').map(x => x.trim().toUpperCase()).filter(Boolean), scanPairs: get('scanPairs').split(',').map(x => x.trim().toUpperCase()).filter(Boolean), feeConfirmed: f.has('feeConfirmed'), scannerAuto: f.has('scannerAuto') };
  for (const field of ['maxBookAgeMs', 'maxBalanceAgeMs', 'slotMs', 'balanceRefreshMs']) config[field] = Number(get(field));
  try { Object.assign(config, policyConfig(e.target, f)); await api('/api/config', { config }); editing = false; notice('设置已保存。'); await refresh(); } catch (err) { notice(err.message); }
});
try { csrf = (await api('/api/session')).csrf; await refresh(); setInterval(refresh, 2000); } catch (e) { notice(e.message); }
