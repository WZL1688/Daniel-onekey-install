# 2026-11-06 币安全市场规则体积修复

生成时间（上海）：2026-11-06T16:35:57+08:00。

## 当前故障与修复

用户最新诊断显示：Binance time HTTP 200、650 ms；exchangeInfo HTTP 200，但累计读取到 15007744 字节时触发 15000000 字节保护。这个数字是越过边界时的已读字节数，不是完整响应大小。OKX 时间、1210 条规则及 400 档盘口均通过。此时用户的币安失败原因是响应体积，不是先前的 HTTP 451。

应用与独立诊断统一使用 `GET /api/v3/exchangeInfo?showPermissionSets=false`。依据 [币安官方 exchangeInfo 文档](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#exchange-information)，该布尔参数只控制 permissionSets 的内容，默认 true。本程序未使用该字段，因此关闭内容不会去掉实际使用的过滤器、精度、isSpotTradingAllowed 或 rateLimits。仍然读取全市场，不额外加 symbol、symbols 或 permissions 过滤，权重仍为 20。

15 MB 读取上限、单次 10 秒总时限、统一调度、私人 Key 隔离、订单未知状态及禁止重发全部保留。没有通过增大或取消响应边界来掩盖问题，没有更换 API 主机、代理地区或放松交易所访问规则。缓存规则结构不变，无需数据迁移；超大失败本来不会写入新的有效规则时间。

## 验证

- 完整自动化测试实际退出 0：291/291 通过，失败/取消/跳过均 0，见 `reports/rules-fix-tests.log`。
- 新增真实本地 HTTP 回归：未带参数的合成大型权限集合响应被 15 MB 上限拒绝，带官方参数后成功；真实 Scheduler 记录 20 权重公共请求，未发送 Key；4 个交易对（含未关注的 ADA）及各过滤器、限速逐值保留。独立诊断也验证同参数和固定公开 GET。合成数据不能作为真实币安响应体积证明。
- 四项增强同时开启的本地协议夹具连续运行 65.275 秒、22 轮，完整轮询 9.005 秒；Binance 公共 23 次、OKX 公共 25 次，私人/订单/失败/限流/延迟请求均 0。见 `reports/rules-fix-soak.json` 和 `.log`。真实交易所网络请求 0。
- 依赖及锁文件未变，沿用同日 `reports/network-fix-audit.json` 的全依赖 0 个已知漏洞结果；本次没有重复把未运行的审计声称为新审计。
- 云端真实只读诊断仍为 Binance time HTTP 451，因此停止该所，没有取得精简后的真实币安规则；OKX 三项 HTTP 200。见 `reports/rules-fix-public-diagnostic.json`。不能以云端地区限制推断用户这次线路，用户更新后仍需重新运行诊断核实实际规则响应。

## 已有修复版的两文件补丁

此补丁适用于刚下载的 `6fcf028` 网络修复版。内容只有 `src/exchanges.js`、`scripts/diagnose-network.js` 和补丁说明，不包含 data、凭据、依赖或运行配置。

1. 在原服务窗口按 Ctrl+C 正常停止；若询问是否终止批处理，输入 Y 回车。
2. 解压小补丁，把里面的 `src` 和 `scripts` 两个文件夹复制到现有项目根目录（`package.json` 所在文件夹），选择替换其中两个同名文件。保留现有项目、完整 data 与 node_modules；依赖不变，不需要重新安装。
3. 先双击 `3-diagnose-windows.cmd`，按回车采用已确认的本机 HTTP 7897 代理，观察 Binance exchangeInfo 是否变成 code OK，再继续检查盘口。
4. 诊断结束后，通过 `4-start-proxy-7897-windows.cmd` 启动服务，打开 `http://localhost:8888/`。

## 边界

修复规则读取不等于完成实盘验收。OKX 后端验证锁、非 USD 限额换算保护、真实账户及成交验收边界仍保留。本次没有使用真实账户 Key 或下单，也没有原生 Windows 执行器；CMD 入口此前的静态检查不等于本次用户机器联网复测。源码与包仍仅交付到已授权独立分支，main 和节点安装脚本不变。
