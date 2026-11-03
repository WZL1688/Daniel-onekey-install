import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const total = (report, key) => Object.values(report.counters).reduce((sum, metrics) => sum + metrics[key], 0);

export function validateEvidence({ network, fixture, tests, audit, notBefore = 0, testModifiedAt = Infinity }) {
  const count = name => Number(tests.match(new RegExp('(?:ℹ|#)\\s+' + name + '\\s+(\\d+)\\b'))?.[1]);
  if (!Number.isInteger(count('tests')) || count('tests') <= 0 || count('pass') !== count('tests') ||
      ['fail', 'skipped', 'cancelled'].some(name => count(name) !== 0)) throw Error('没有确认非零且完整通过、无取消的本次测试结果');
  if (testModifiedAt < notBefore) throw Error('测试日志早于当前代码；请重新运行完整测试');
  for (const [report, type] of [[network, 'CURRENT_ENVIRONMENT_REAL_NETWORK_ATTEMPTS'], [fixture, 'OFFICIAL_SHAPED_LOCAL_FIXTURE_NOT_EXCHANGE']]) {
    const started = Date.parse(report.startedAt), completed = Date.parse(report.completedAt);
    if (report.type !== type || report.status !== 'COMPLETED' || !Number.isFinite(started) || !Number.isFinite(completed) ||
        completed - started < 60000 || !Number.isFinite(report.elapsedMs) || report.elapsedMs < 60000 ||
        Math.abs(completed - started - report.elapsedMs) > 5 || !Array.isArray(report.validationFailures) || report.validationFailures.length ||
        !Array.isArray(report.configuredPairs) || !report.configuredPairs.length || !Array.isArray(report.successfulSampledPairs) ||
        !Number.isInteger(report.servicePort) || report.servicePort < 1024 || report.servicePort > 65535) throw Error('连续验证报告未确认完成至少一分钟或格式过旧；请重跑 soak');
    if (started < notBefore) throw Error('连续验证早于当前代码；请重新运行 soak');
    for (const key of ['public', 'private', 'orders', 'failures', 'limited', 'delayed']) {
      if (!Object.values(report.counters || {}).length || Object.values(report.counters).some(metrics => !Number.isFinite(metrics[key]) || metrics[key] < 0)) throw Error('连续验证计数无效');
    }
  }
  const vulnerabilities = audit?.metadata?.vulnerabilities;
  if (!vulnerabilities || ['info', 'low', 'moderate', 'high', 'critical', 'total'].some(name => !Number.isInteger(vulnerabilities[name]) || vulnerabilities[name] < 0) ||
      ['info', 'low', 'moderate', 'high', 'critical'].reduce((sum, name) => sum + vulnerabilities[name], 0) !== vulnerabilities.total) throw Error('依赖审计结果缺少有效漏洞统计');
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), cancelled: count('cancelled'), vulnerabilities };
}

function newestCodeTime() {
  const times = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file !== fileURLToPath(import.meta.url)) times.push(fs.statSync(file).mtimeMs);
    }
  }
  for (const directory of ['src', 'public', 'test', 'scripts']) walk(path.join(root, directory));
  for (const file of ['package.json', 'package-lock.json', 'docs/verification.json']) times.push(fs.statSync(path.join(root, file)).mtimeMs);
  return Math.max(...times);
}

function main() {
  const read = name => JSON.parse(fs.readFileSync(path.join(root, 'reports', name), 'utf8'));
  const network = read('soak-network.json'), fixture = read('soak-fixture.json'), audit = read('dependency-audit.json');
  const testsPath = path.join(root, 'reports/tests.log');
  const evidence = validateEvidence({ network, fixture, audit, tests: fs.readFileSync(testsPath, 'utf8'),
    notBefore: newestCodeTime(), testModifiedAt: fs.statSync(testsPath).mtimeMs });
  if (fs.statSync(path.join(root, 'reports/dependency-audit.json')).mtimeMs < fs.statSync(path.join(root, 'package-lock.json')).mtimeMs) throw Error('依赖审计早于当前锁文件；请重新运行 npm audit');
  const verification = JSON.parse(fs.readFileSync(path.join(root, 'docs/verification.json'), 'utf8'));
  const locked = ['binance', 'okx'].filter(exchange => verification[exchange] !== true);
  const row = (label, report) => `| ${label} | ${(report.elapsedMs / 1000).toFixed(3)} 秒 | ${report.observedCycleMs == null ? '未完成周期' : (report.observedCycleMs / 1000).toFixed(3) + ' 秒'} | ${total(report, 'public')} | ${total(report, 'private')} | ${total(report, 'limited')} | ${total(report, 'delayed')} | ${report.localHttpAverageMs} ms |`;
  const networkSummary = network.successfulSampledPairs.length
    ? `本次观测有 ${network.successfulSampledPairs.length} 个交易对取得有效盘口（${network.successfulSampledPairs.join('、')}），仍不等于账户权限或真实订单成交验收。`
    : '本次观测没有交易对取得有效盘口；这证明了本地服务持续响应和失败后的退避，不证明真实行情接入成功。';
  const auditSummary = evidence.vulnerabilities.total === 0 ? '审计结果为 0 个已知漏洞' : `审计发现 ${evidence.vulnerabilities.total} 个已知漏洞（高危 ${evidence.vulnerabilities.high}、严重 ${evidence.vulnerabilities.critical}）`;
  const hashes = ['binance-rest-api.md', 'binance-filters.md', 'binance-errors.md'].map(name => '- `' + name + '`：`' + crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'docs/vendor', name))).digest('hex') + '`').join('\n');
  const report = `# 当前交付与验收记录

报告生成时间（上海）：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'long' }).format(new Date())}。

## 当前证据与范围

普通服务在本机 ${network.servicePort} 端口完成至少一分钟 HTTP 观测。${networkSummary}

文档核对记录中尚未通过的交易所：${locked.length ? locked.join('、') : '无'}。${locked.length ? '对应后端实盘锁仍应保留。' : '文档核对标志本身也不证明真实账户和成交验证完成。'}**本报告没有将本地夹具、订单受理或人工声明当作真实成交验证，不能据此宣称实盘已经验收完成。**

## 自动化验证

- Node.js ${process.version}。
- 本次完整日志记录：${evidence.tests} 项执行、${evidence.pass} 通过、${evidence.fail} 失败、${evidence.skipped} 跳过、${evidence.cancelled} 取消；日志为 reports/tests.log。生成器拒绝零测试、失败、跳过、取消或早于当前代码的日志。
- 生产依赖审计读取 reports/dependency-audit.json：${auditSummary}。审计文件不得早于当前 package-lock.json。
- 自动化测试包含本地 HTTP、受控交易所协议夹具及 DOM 渲染；它们不证明真实交易所可访问、真实账户权限可用或订单成交。

## 连续运行指标

请求和失败计数均为本次观测窗口的增量，公共数量含失败尝试；成功交易对与完整轮转周期只计本次观测。

| 类型 | 连续时长 | 观测完整轮转周期 | 公共请求尝试 | 私人请求 | HTTP/API 限流计数 | 延迟请求 | 本机 HTTP 平均延迟 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${row('普通服务真实网络尝试', network)}
${row('独立本地协议夹具', fixture)}

普通服务：${total(network, 'failures')} 次失败尝试、${total(network, 'orders')} 次订单请求，新增批次 ${network.batchesCreated}，结束时实盘开关为 ${network.liveTrading ? '开启' : '关闭'}。请求平均耗时按全部已发尝试计算：${Object.entries(network.counters).map(([exchange, metrics]) => `${exchange} ${metrics.averageExchangeAttemptMs ?? '无样本'} ms`).join('；')}。限流计数为 0 不代表网络可用，代理连接失败也不能冒称为交易所返回的 429。

夹具：关注 ${fixture.configuredPairs.join('、')}；本次有效采样 ${fixture.successfulSampledPairs.join('、') || '无'}。计划间隔 ${fixture.slotMs / 1000} 秒，计划完整周期 ${fixture.expectedCycleMs / 1000} 秒，完成 ${fixture.pollRounds} 轮。私人请求 ${total(fixture, 'private')}、订单请求 ${total(fixture, 'orders')}、新增批次 ${fixture.batchesCreated}。这是本地模拟行情，不具备真实流动性、账户权限或成交的证明力。

普通服务观测：${network.startedAt} 至 ${network.completedAt}；夹具观测：${fixture.startedAt} 至 ${fixture.completedAt}（UTC）。原始报告为 reports/soak-network.json 与 reports/soak-fixture.json。httpStatuses 仅是本次失败状态分类，不包括全部成功 HTTP 响应。

普通服务记录的限制：
${network.limitations.length ? network.limitations.map(message => '- ' + String(message).replace(/\n/g, ' ')).join('\n') : '- 观测报告未记录接口错误；私人 API、账户及真实成交仍需独立验收。'}

## 运行与未完成验收

启动：项目目录执行 npm ci、npm test、npm start。默认端口 8888，只绑定本机；自动交易默认关闭。配置、Key 和风险状态保存在 data 目录，迁移或备份时应正常停止后保留整个目录，不要把密钥发到聊天。完整使用和 systemd 说明见 README.md。

已受理、未知和双腿不完整批次需要人工核对成交和残余库存；程序不自动查询成交、不重发未知订单、不自动补单。两腿相同申报数量不保证相同实际成交数量，正数动态平衡亏损配置仅影响平衡模式。

若真实接口仍受网络策略限制，先在环境设置应用 api.binance.com、www.okx.com 的访问配置，再重试。正式开启前完成相关官方 API 文档与适配验证、账户查询 Key 及同账户 UID 验证、真实费率、余额和权限检查。文档验证标志不能当成用户绕过开关；真实资金下单需要用户在本机界面明确开启。

## 随项目提供的 Binance 官方文档快照校验

以下哈希只证明当前随包快照内容，不声称它等同于交易所最新文档，也不替代本次接入验证。

${hashes}
`;
  fs.writeFileSync(path.join(root, 'docs/ACCEPTANCE.md'), report);
  console.log(`验收报告已生成：${evidence.tests} tests passed；普通服务 ${network.servicePort} 端口；真实有效盘口 ${network.successfulSampledPairs.length} 个交易对。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
