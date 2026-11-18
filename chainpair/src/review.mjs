import Decimal from 'decimal.js';

const TIME_ZONE = 'Asia/Shanghai';
const OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MODES = new Set(['demo', 'live']);
const TYPES = new Set(['arbitrage', 'manual', 'rebalance']);
const fail = message => Object.assign(new Error(message), { safe: true });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sum = values => values.length ? values.reduce((total, value) => total.plus(value), new Decimal(0)).toNumber() : null;
const dateOf = milliseconds => new Date(Number(milliseconds) + OFFSET_MS).toISOString().slice(0, 10);

export function reviewPeriod(day) {
  if (typeof day !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(day)) throw fail('复盘日期须为2000–2099年的 YYYY-MM-DD');
  const [year, month, date] = day.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, date);
  if (new Date(utc).toISOString().slice(0, 10) !== day) throw fail('复盘日期无效');
  return { start: utc - OFFSET_MS, end: utc - OFFSET_MS + DAY_MS };
}
function timestamp(value) { const result = Date.parse(value); return Number.isFinite(result) ? result : null; }
function completionTime(trade) {
  const completed = (trade.events || []).find(event => String(event.status || event.state).toUpperCase() === 'COMPLETED');
  return timestamp(completed?.at || completed?.createdAt || trade.completedAt || trade.updatedAt || trade.createdAt);
}
function expectedProfit(trade) {
  if (finite(trade.estimate?.netProfitUsd)) return trade.estimate.netProfitUsd;
  if (trade.type === 'arbitrage') return null;
  return finite(trade.estimate?.wearUsd) ? -trade.estimate.wearUsd : null;
}
function verifiedActual(trade) {
  const actual = trade.actual;
  if (!actual || !finite(actual.spentUsd) || actual.spentUsd < 0 || !finite(actual.receivedUsd) || actual.receivedUsd < 0 ||
      !finite(actual.gasUsd) || actual.gasUsd < 0 || !finite(actual.rentUsd) || actual.rentUsd < 0 || !finite(actual.profitUsd)) return null;
  const calculated = new Decimal(actual.receivedUsd).minus(actual.spentUsd).minus(actual.gasUsd).minus(actual.rentUsd);
  const scale = Math.max(1, actual.receivedUsd, actual.spentUsd, actual.gasUsd, actual.rentUsd, Math.abs(actual.profitUsd));
  const tolerance = Math.max(0.00000001, Number.EPSILON * scale * 4);
  if (scale > Number.MAX_SAFE_INTEGER || calculated.minus(actual.profitUsd).abs().gt(tolerance)) return null;
  return { profitUsd: actual.profitUsd, networkAndProtocolUsd: actual.gasUsd, rentUsd: actual.rentUsd };
}

/** All text is authored here. No scraped content, user notes or raw receipts enter the report. */
export function buildDailyReview(trades, { day, mode = 'demo', now = Date.now() } = {}) {
  now = Number(now);
  if (!Number.isFinite(now)) throw fail('复盘时间无效');
  if (!MODES.has(mode)) throw fail('复盘模式无效');
  day ||= dateOf(now);
  const period = reviewPeriod(day);
  if (day > dateOf(now)) throw fail('不能生成未来日期的复盘');
  const inPeriod = time => time !== null && time >= period.start && time < period.end && time <= now;
  const scoped = trades.filter(trade => (trade.mode || 'demo') === mode);
  const initiated = scoped.filter(trade => inPeriod(timestamp(trade.createdAt)));
  const completed = scoped.filter(trade => String(trade.status).toUpperCase() === 'COMPLETED' && inPeriod(completionTime(trade)));
  const pending = scoped.filter(trade => String(trade.status).toUpperCase() === 'NEEDS_REVIEW');
  const valid = completed.map(trade => ({ trade, actual: verifiedActual(trade), expected: expectedProfit(trade) })).filter(row => row.actual);
  const paired = valid.filter(row => row.expected !== null);
  const actualProfitUsd = sum(valid.map(row => row.actual.profitUsd));
  const estimatedProfitUsd = sum(paired.map(row => row.expected));
  const pairedActualProfitUsd = sum(paired.map(row => row.actual.profitUsd));
  const differenceUsd = paired.length ? new Decimal(pairedActualProfitUsd).minus(estimatedProfitUsd).toNumber() : null;
  const observations = [{ code: 'READ_ONLY', text: '本地复盘只生成统计与检查建议，不修改风控、发布策略或触发交易。' }];
  if (!valid.length) observations.push({ code: 'NO_VERIFIED_RESULTS', text: '该日期没有通过完整收支字段核对的完成记录，实际净收益尚未验证。' });
  if (pending.length) observations.push({ code: 'MANUAL_REVIEW_REQUIRED', text: `当前仍有 ${pending.length} 笔该模式的交易待人工核对，请检查链上回执与实际余额。` });
  if (completed.length > valid.length) observations.push({ code: 'INCOMPLETE_ACCOUNTING', text: `${completed.length - valid.length} 笔完成记录存在费用缺失或收支不一致，未计入已复核净收益。` });
  if (valid.length > paired.length) observations.push({ code: 'MISSING_ESTIMATE', text: `${valid.length - paired.length} 笔已复核记录缺少对应估算，未计入估实差异比较。` });
  if (differenceUsd !== null && differenceUsd < -0.00000001) observations.push({ code: 'ESTIMATE_OVERSTATED', text: '实际净收益低于对应估算，请离线检查报价时效、跨链到账折损及费用；报告不会自动调整参数。' });
  if (actualProfitUsd !== null && actualProfitUsd < 0) observations.push({ code: 'NEGATIVE_REALIZED_RESULT', text: '该日期已复核净收益为负，请先核查成交与成本记录，再由用户决定后续操作。' });
  observations.push({ code: 'COST_COVERAGE', text: '费用仅覆盖本工具归档的交易；外部钱包手动授权、充值等额外支出需另行核对。' });
  const byType = ['arbitrage', 'manual', 'rebalance', 'unknown'].map(type => {
    const rows = valid.filter(row => (TYPES.has(row.trade.type) ? row.trade.type : 'unknown') === type);
    return { type, count: rows.length, profitUsd: sum(rows.map(row => row.actual.profitUsd)) };
  });
  return {
    id: `${mode}:${day}`, schemaVersion: 1, day, mode, timeZone: TIME_ZONE, generatedAt: new Date(now).toISOString(),
    period: { start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString() },
    counts: { initiated: initiated.length, completed: completed.length, needsReview: pending.length, incomplete: completed.length - valid.length, verified: valid.length, compared: paired.length },
    pnl: { actualProfitUsd, estimatedProfitUsd, pairedActualProfitUsd, differenceUsd, networkAndProtocolUsd: sum(valid.map(row => row.actual.networkAndProtocolUsd)), rentUsd: sum(valid.map(row => row.actual.rentUsd)) },
    byType, observations,
    policyVersions: new Set(initiated.map(trade => trade.policyFingerprint).filter(value => typeof value === 'string')).size,
    valuation: '稳定币按1美元面值、原生币按交易归档参考汇率折算；这是本工具记录的收支统计，不是实时法币估值。',
    coverage: { basis: 'completed-receipts', purpose: 'retrospective-accounting-only', includesExternalWalletActions: false, pendingReviewScope: 'all-current-records-in-mode', estimateComparison: 'matched-verified-records' }
  };
}

export class ReviewService {
  constructor({ store, getConfig = () => store.config, clock = Date.now, intervalMs = 60000 }) {
    this.store = store; this.getConfig = getConfig; this.clock = clock; this.intervalMs = intervalMs; this.timer = null; this.lastError = '';
  }
  current({ day, mode = this.getConfig().mode } = {}) {
    const report = buildDailyReview(this.store.allTrades(), { day, mode, now: this.clock() });
    return this.store.saveReview(report);
  }
  export(input = {}) {
    const report = this.current(input);
    // Explicit allowlist: future archive fields cannot silently enter exported research data.
    return { format: 'chainpair.read-only-review.v1', schemaVersion: report.schemaVersion, day: report.day, mode: report.mode, timeZone: report.timeZone,
      generatedAt: report.generatedAt, period: report.period, counts: report.counts, pnl: report.pnl, byType: report.byType,
      observations: report.observations, policyVersions: report.policyVersions, valuation: report.valuation, coverage: report.coverage };
  }
  tick() {
    const now = Number(this.clock()); const today = dateOf(now);
    if (now < reviewPeriod(today).start + 5 * 60 * 1000) return;
    const yesterday = dateOf(now - DAY_MS);
    for (const mode of MODES) if (!this.store.getReview(yesterday, mode)) this.current({ day: yesterday, mode });
  }
  start() {
    this.stop();
    const run = () => { try { this.tick(); this.lastError = ''; } catch { this.lastError = '本地复盘暂不可用，请查看交易档案；交易参数未被修改'; } };
    run(); this.timer = setInterval(run, this.intervalMs); this.timer.unref?.(); return this;
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
