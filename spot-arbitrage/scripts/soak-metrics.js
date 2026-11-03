const names = ['public', 'private', 'orders', 'failures', 'limited', 'delayed', 'waitMs', 'latencyMs'];

function difference(before = 0, after = 0, label) {
  const value = after - before;
  if (!Number.isFinite(value) || value < 0) throw Error(`连续验证计数器重置或无效：${label}`);
  return value;
}

export function summarizeSoak({ fixture, start, end, before, after, samples, port }) {
  if (JSON.stringify(before.config.exchanges) !== JSON.stringify(after.config.exchanges) ||
      JSON.stringify(before.config.pairs) !== JSON.stringify(after.config.pairs)) throw Error('连续验证期间关注交易所或交易对发生变化');
  if (!samples.length) throw Error('连续验证没有本机 HTTP 样本');
  const counters = {};
  for (const exchange of after.config.exchanges) {
    const previous = before.rates[exchange].metrics, current = after.rates[exchange].metrics;
    const metrics = counters[exchange] = {};
    for (const name of names) metrics[name] = difference(previous[name], current[name], `${exchange}.${name}`);
    metrics.backoffReason = after.rates[exchange].reason;
    metrics.httpStatuses = {};
    for (const status of new Set([...Object.keys(previous.httpStatuses || {}), ...Object.keys(current.httpStatuses || {})])) {
      const count = difference(previous.httpStatuses?.[status], current.httpStatuses?.[status], `${exchange}.httpStatuses.${status}`);
      if (count) metrics.httpStatuses[status] = count;
    }
    const count = metrics.public + metrics.private;
    metrics.averageExchangeAttemptMs = count ? Math.round(metrics.latencyMs / count) : null;
  }
  const previousBatchIds = new Set(before.batches.map(batch => batch.id));
  const cycles = [...samples, after.engine].filter(sample => Number.isFinite(sample.cycleMs) && sample.cycleMs > 0 &&
    sample.lastCycleAt <= end && sample.lastCycleAt - sample.cycleMs >= start);
  const successfulSampledPairs = after.config.pairs.filter(id => {
    const at = after.opportunities[id]?.at;
    return Number.isFinite(at) && at >= start && at <= end && at > (before.opportunities[id]?.at || 0);
  });
  return {
    type: fixture ? 'OFFICIAL_SHAPED_LOCAL_FIXTURE_NOT_EXCHANGE' : 'CURRENT_ENVIRONMENT_REAL_NETWORK_ATTEMPTS',
    status: 'COMPLETED', startedAt: new Date(start).toISOString(), completedAt: new Date(end).toISOString(), elapsedMs: end - start,
    bindHost: '127.0.0.1', servicePort: Number(port), configuredPairs: [...after.config.pairs], localSamples: samples.length,
    localHttpAverageMs: Math.round(samples.reduce((sum, sample) => sum + sample.httpMs, 0) / samples.length),
    slotMs: after.engine.slotMs, expectedCycleMs: after.engine.estimatedCycleMs, observedCycleMs: cycles.at(-1)?.cycleMs ?? null,
    pollRounds: difference(before.engine.polls, after.engine.polls, 'engine.polls'), successfulSampledPairs,
    counters, liveTrading: after.config.autoTrading, batchesCreated: after.batches.filter(batch => !previousBatchIds.has(batch.id)).length,
    pendingQueue: Object.fromEntries(Object.entries(after.rates).map(([exchange, rate]) => [exchange, rate.queue.length])),
    limitations: fixture ? ['本地协议夹具，不能作为交易所联网或实盘验收'] : Object.values(after.opportunities).filter(value => value.error).map(value => value.error),
  };
}

export function fixtureFailures(report) {
  const failures = [];
  if (report.elapsedMs < 60000 || report.localSamples < 2) failures.push('未完成至少一分钟的连续本机 HTTP 观测');
  if (report.pollRounds < report.configuredPairs.length || report.successfulSampledPairs.length !== report.configuredPairs.length || report.observedCycleMs == null) failures.push('夹具未在本次观测中完成全部关注交易对的轮转和有效盘口采样');
  if (Object.values(report.counters).some(metrics => metrics.failures || metrics.private || metrics.orders) || report.liveTrading || report.batchesCreated) failures.push('夹具出现请求失败、私人请求或订单活动');
  return failures;
}
