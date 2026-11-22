# ChainPair 本机双链工作台 v1.5.1

[下载源码ZIP](https://raw.githubusercontent.com/WZL1688/Daniel-onekey-install/chainpair-local-20261116/downloads/ChainPair-local.zip) · [SHA256](downloads/ChainPair-local.zip.sha256) · [使用教程](chainpair/docs/INVENTORY-OPPORTUNITIES.md)

安装Node.js24LTS。Windows解压双击ChainPair/start.cmd；macOS/Linux运行./start.sh，也可npm ci后npm start。保留终端，打开其显示的完整http://127.0.0.1:端口/地址。同一数据目录不允许重复交易进程。升级前退出旧程序并备份自己的data，覆盖程序文件时保留data。

## 修复扫描TIMEOUT：使用实际代理并分别检测

行情首页→同币机会→数据源网络／连接检测。默认自动读取启动进程HTTP_PROXY／HTTPS_PROXY／NO_PROXY；无环境代理时检测Windows当前用户启用的本机手动代理。没有代理可选择直连；使用Clash／v2ray且未自动识别时，选择本机HTTP代理并填写软件实际HTTP／mixed端口，例如http://127.0.0.1:7890。7890只是示例，请按实际配置填写，不要用SOCKS端口。保存后点“测试行情连接”，分别核对BNB、Solana、CoinGecko的HTTP状态、错误类别与时间，再开启或等待扫描。

代理只作用于同币目录、固定官方映射和DexScreener公开行情，RPC、OKX、AVE与钱包连接保持原配置。代理失败不会静默直连，不执行PAC、不扫描端口、不关闭TLS校验。页面不回显环境／系统代理地址或凭据。检测只读且共用请求预算，至少一分钟间隔，遵守服务端429；保存网络设置不会开启交易。

## 自动发现BNB／Solana同币机会

首次启动即进行只读自动发现和连续扫描，无需手工填写合约地址；用户停止后保存选择，重启延续。高级手工添加只是备用。CoinGecko多链目录与官方Wormhole映射按原始链和合约关联候选，不按币名配对。随包32组2026-04-08官方地址快照没有价格或交易批准；仍须联网取得两侧交易池，不覆盖全链全市场。需要CoinGecko权限时可加密保存自己的DemoKey。

默认模拟，自动交易单独开启。新发现条目先展示参考价差，核验同币关系、精度和池后再复核真实报价与库存。库存模式先低价链买入确认，再按实际数量换算在高价链卖出现有同币；库存不足跳过，单边失败暂停，不隐含跨链补库。1–10U、利润、滑点、费用、Gas储备及累计额度限制保留。库存现金流价差未含未来补库成本。

原跨链模式、OKX手动跨链和跨链模式60/40再平衡、插件／本机加密钱包、AVE观察雷达、交易档案复盘与备忘录均保留。

287项自动测试与七组浏览器流程通过，包含实际离线HTTP CONNECT与证书校验测试；开发环境限制行情API域名，未完成真实实时行情及真钱验收。用户TIMEOUT只表明超时，具体原因需按本机三路检测核对，不保证当前存在可成交机会。

源码ZIP不含用户运行数据、钱包、Key、日志或node_modules。src/opportunities/data仅为公开官方地址元数据；test中的一次性localhost TLS证书／公知fixture密钥仅用于离线测试，生产代码不使用它们。不要上传自己的data目录。
