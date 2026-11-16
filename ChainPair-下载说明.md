# ChainPair v1.1.0 · 本机双链套利工作台

[点击下载完整项目 ZIP](downloads/ChainPair-local.zip?raw=true)

解压后进入 `ChainPair` 文件夹，安装 Node.js 24 或更新版本，Windows 双击 `start.cmd`，macOS / Linux 运行 `./start.sh`。启动后会请求默认浏览器打开实际分配的本机地址。地址必须带端口，例如 `http://127.0.0.1:50240/`，以启动窗口显示的完整地址为准，并保持窗口运行。

## 直接连接插件钱包

用安装了相应钱包插件的浏览器打开本机网页，进入“设置与钱包”→“钱包管理”。

- BNB Chain：点击“连接 MetaMask”或“连接 OKX Wallet”。
- Solana：点击“连接 Phantom”或“连接 OKX Wallet”。

在插件弹窗允许连接账户即可，连接时不需要向本程序输入私钥。实盘链上步骤仍需逐笔在插件确认，页面应保持打开；无人值守执行可使用原有本机加密私钥模式。原本机钱包可通过“恢复本机钱包”切回。

默认演示模式；即使连接插件，也继续显示模拟余额且不请求真实交易签名。实盘还需配置并解锁 OKX API 凭据、交易池、代币和白名单，并满足余额、授权、费用和路线检查。BNB 跨出支持已核验的 deBridge DLN 直接路线，未知 ABI 在买入前阻止。

[源码与启动说明](chainpair/README.md) · [详细使用说明](chainpair/docs/USER-GUIDE.md) · [实盘支持范围](chainpair/docs/LIVE-ADAPTER.md) · [测试记录](chainpair/docs/TEST-RESULTS.md)

88 项自动测试、原页面浏览器验收及模拟插件浏览器验收通过。没有使用真实钱包插件账户或真实资金完成验收。

压缩包不含私钥、API 凭据、钱包运行数据、数据库或依赖目录。SHA256：`f85a50d0fff2f60f687d52088c31f6fc835ec45b58e869699da6fa9dbd1f0cee`。
