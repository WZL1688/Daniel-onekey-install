import fs from 'node:fs';
import crypto from 'node:crypto';
const read = name => JSON.parse(fs.readFileSync(new URL('../reports/' + name, import.meta.url), 'utf8'));
const network = read('soak-network.json'), fixture = read('soak-fixture.json');
const tests = fs.readFileSync(new URL('../reports/tests.log', import.meta.url), 'utf8');
const count = name => Number(tests.match(new RegExp('(?:ℹ|#) ' + name + ' (\\d+)'))?.[1]);
if (!Number.isInteger(count('tests')) || count('pass') !== count('tests') || count('fail') !== 0 || count('skipped') !== 0) throw Error('没有确认完整通过的测试结果');
const total = (r, k) => Object.values(r.counters).reduce((sum, x) => sum + x[k], 0);
const row = (label, r) => `| ${label} | ${(r.elapsedMs / 1000).toFixed(3)} 秒 | ${r.observedCycleMs == null ? '未完成周期' : (r.observedCycleMs / 1000).toFixed(3) + ' 秒'} | ${total(r, 'public')} | ${total(r, 'private')} | ${total(r, 'limited')} | ${total(r, 'delayed')} | ${r.localHttpAverageMs} ms |`;
const hashes = ['binance-rest-api.md', 'binance-filters.md', 'binance-errors.md'].map(name => {
  const file = new URL('../docs/vendor/' + name, import.meta.url);
  return '- `' + name + '`：`' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '`';
}).join('\n');
const report = `# 当前交付与验收记录

报告生成时间（上海）：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'long' }).format(new Date())}。

## 结论

本地工具已实现并启动于本机 8888 端口。**未完成真实交易所接入和实盘验收，不能宣称已可安全投入真实资金。** 主要外部阻塞是当前运行环境未应用交易所域名网络访问配置；OKX 官方文档仍无法读取。后端实盘锁定，未配置真实 Key，未发出任何真实订单。

## 自动化验证

- Node.js ${process.version}。
- ${count('tests')} 项测试执行，${count('pass')} 通过，${count('fail')} 失败，${count('skipped')} 跳过，${count('cancelled')} 取消。
- 包括真实 HTTP 连接中断、实际 10 秒超时、畸形响应、Retry-After 和大订单号；其余交易所响应及订单故障由本地受控夹具注入。
- 测试命令退出状态已确认 0，日志为 reports/tests.log。没有用零测试运行替代验证。
- npm ci 从锁文件成功复现安装；生产依赖 npm audit 未发现已知漏洞。
- 八个页面已执行浏览器侧 JavaScript 的 DOM 渲染检查，覆盖全部导航及 XSS 转义；没有图形浏览器截图或真机视觉验收。
- 原 Daniel-onekey-install 仓库 git status 和 git diff 均为空。

## 连续运行指标

以下请求数为观测窗口前后计数差；公共数量包含失败的网络尝试，不能当作成功 API 响应。

| 类型 | 连续时长 | 观测完整轮转周期 | 公共请求尝试 | 私人请求 | HTTP/API 限流计数 | 延迟请求 | 本机 HTTP 平均延迟 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${row('当前环境真实网络', network)}
${row('独立本地协议夹具', fixture)}

当前环境真实网络：${network.successfulSampledPairs.length} 个交易对取得有效盘口；${total(network, 'failures')} 次请求失败；因网络退避使轮转变慢。curl 对交易所返回代理 CONNECT 403，Node HTTP 客户端表现为网络 TypeError，并非交易所返回的 429，因此限流计数为 0 不代表网络可用。观测期没有订单、没有私人 API 请求。每所请求尝试平均延迟分别为 Binance ${network.counters.binance.averageExchangeAttemptMs ?? '无样本'} ms / OKX ${network.counters.okx.averageExchangeAttemptMs ?? '无样本'} ms，均为失败尝试的返回耗时。

夹具：三个交易对 BTC/USDT、ETH/USDT、SOL/USDT 均取得有效结构化盘口并完成双向利润计算。每轮仅一个交易对，计划间隔 ${fixture.slotMs / 1000} 秒，完整周期约 ${fixture.expectedCycleMs / 1000} 秒；${fixture.pollRounds} 轮完成，未下单。本地夹具不具备真实交易所行为、真实流动性、账户权限或实际成交的证明力。

网络观测启动 UTC：${network.startedAt}；夹具观测启动 UTC：${fixture.startedAt}。原始数据见 reports/soak-network.json 和 reports/soak-fixture.json。其中 httpStatuses 字段为服务累计计数，其他表内计数取窗口差，不能混用。

## 安全与可用性范围

密钥在本机 AES-256-GCM 加密，主密钥和数据文件为 0600，目录 0700。公开状态不返回密文或完整凭据。默认仅绑定 127.0.0.1，并校验 Host、Origin、会话和 CSRF。页面和状态快照不会请求交易所。

订单意图、限额与冷却在发送前持久化。最终复核包括规则、余额、开放订单、价格过滤与新盘口；任务在 API 队列实际执行前会再次检查实盘开关、盘口时效、余额及价格上下文。任意已受理／未知批次都会阻止所有新批次。单纯归档或重启不解除阻塞，收到订单号不会标记已成交。自动交易每次启动关闭。

两所 IOC 不保证原子成交，已受理批次需要人工核对并处理部分成交／残余敞口。正数平衡亏损需要明确确认，不能降低普通套利门槛。

## 配置草稿与下一步

已保存 install_script（保留旧工具安装并新增本项目 npm ci）和 start_skill（保留旧工作流并新增本项目启动、验证、数据保留及限制），以及所需域名网络配置。保存仅持久化草稿；**没有发布环境或应用运行中的网络变更**。

继续完成实盘验收必须：

1. 用户在环境设置审核、保存并发布网络变更，使 api.binance.com 和 www.okx.com 可访问；文档需要 www.okx.com/docs-v5/en/。
2. 重新实际测试域名连通性，阅读并核对 OKX 完整相关官方认证、账户模式、现货交易、精度、限速和错误规则，修正适配代码并补充契约测试。不能只改 verification.json 标志。
3. 用户在本机 UI 配置查询与交易 Key，验证同账户 UID、余额及实际权限。Key 不在聊天输入。
4. 完成真实公共行情一分钟以上验证及私人只读接口验证；实际资金订单需用户之后明确开启实盘并承担两腿风险。本次没有尝试真实资金下单。

## Binance 官方文档快照校验

已阅读本工具所涉及的官方 REST、过滤器和错误章节；不是声称实现所有 Binance API。

${hashes}
`;
fs.writeFileSync(new URL('../docs/ACCEPTANCE.md', import.meta.url), report);
console.log(`验收报告已生成：${count('tests')} tests passed；真实交易所验收仍阻塞。`);
