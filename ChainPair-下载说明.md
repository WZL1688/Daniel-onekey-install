# ChainPair 本机双链套利工作台

[点击下载完整项目 ZIP](downloads/ChainPair-local.zip?raw=true)

解压后进入 `ChainPair` 文件夹，安装 Node.js 24 或更新版本，运行 `npm ci`、`npm start`，或者使用 `start.cmd` / `start.sh`。程序自动选择本机端口，终端显示访问地址。

源码目录：[chainpair](chainpair/README.md)。包含五个标签页、本机加密钱包、严格买入确认→代币跨链到账→按实收数量卖出、风控、自动再平衡及完整档案。

默认演示模式。48项自动测试及浏览器验收通过，没有使用真实资金验证；实盘受已支持ABI、API权限、白名单和链上路线限制。BNB跨出支持deBridge DLN直接路线，其他不支持路线会在买入前被阻止。请阅读[使用说明](chainpair/docs/USER-GUIDE.md)与[实盘适配范围](chainpair/docs/LIVE-ADAPTER.md)。

压缩包不含私钥、OKX凭据、运行数据、数据库或依赖目录。SHA256: `4064fde32e231b8173cac919ceccfc14b1f23e9453fb60b6bd0d30dfdc84dca6`。
