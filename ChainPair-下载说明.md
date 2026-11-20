# ChainPair 本机双链工作台 v1.4.0

[下载源码 ZIP](https://raw.githubusercontent.com/WZL1688/Daniel-onekey-install/chainpair-local-20261116/downloads/ChainPair-local.zip) · [SHA256](downloads/ChainPair-local.zip.sha256) · [使用说明](chainpair/docs/USER-GUIDE.md)

解压并安装 Node.js 24 LTS。Windows 双击 ChainPair/start.cmd；macOS/Linux 在目录运行 ./start.sh，也可运行 npm ci 后 npm start。保留启动终端，浏览器必须打开终端显示的完整 http://127.0.0.1:端口/ 地址，不能省略端口。同一数据目录只允许一个交易进程。

## 新增：同币机会与库存套利

入口：行情首页 → 同币机会。可读取 CoinGecko 双链地址候选，按精确CA扫描BNB/Solana交易池价差；支持手工清单。名称和符号不能确认同币，目录不覆盖全市场。

核对1:1资产关系、两链地址、精度、交易池并保存映射确认后，可复核双边报价和库存，手动提交或单独开启已核验清单自动执行。扫描与交易分别控制，自动交易仍遵守1–10U、利润、滑点、费用、Gas储备、次数和累计金额。

库存模式固定低价侧买入确认后，在高价侧卖出预先持有的同币，卖量来自实际到账换算。高价侧必须有目标币，两边只有稳定币无法这样套利；库存不足跳过，单边失败暂停并留档，不隐含跨链补库或自动再平衡。库存现金流价差单列，未含未来补库存成本。

配置步骤见 [库存与机会扫描教程](chainpair/docs/INVENTORY-OPPORTUNITIES.md)。多资产使用独立执行上下文，不自动改写全局代币地址；目录变化或已确认参数修改会撤销旧核验。插件钱包仍需逐笔确认；本机私钥密码加密保存。

## 保留的功能

原跨链套利模式、OKX手动跨链及60/40再平衡（跨链模式）、MetaMask/OKX/Phantom、AVE只读Meme雷达、交易档案、本地复盘和分页备忘录均保留。默认演示模式，所有新扫描重启后关闭。

本版215项自动测试、五组浏览器流程通过。公开数据源联通尝试在开发环境未成功，未完成真实行情或真钱验收；实际使用受网络、API权限、RPC、库存、授权及支持的交易格式约束，不保证盈利。公共接口是否免费以提供方当前规则为准。

源码包不包含运行数据、钱包文件、用户Key、日志或node_modules；test目录只有固定模拟凭据。升级前停止旧进程并备份自己的data目录，再替换程序文件；不要上传自己的data目录。
