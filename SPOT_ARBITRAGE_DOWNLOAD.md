# 现货工具：币安规则体积修复

已有上一网络修复版的用户使用：[两文件补丁 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-rules-patch-20261106.zip)。
全新安装使用：[完整 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-rules-fix-20261106.zip)。

先正常停服，将补丁里的 src 和 scripts 文件夹复制到现有项目根目录（package.json 所在文件夹），选择替换两个同名文件，保留 data 和 node_modules。先运行 3-diagnose-windows.cmd 并回车验证本机7897 HTTP代理，再用 4-start-proxy-7897-windows.cmd 启动，打开 http://localhost:8888/ 。

291/291 测试通过，本地协议夹具连续运行65.275秒，完整轮转9.005秒。正式请求和诊断统一使用官方 showPermissionSets=false，保留全市场与15MB大小保护。用户最新币安失败为HTTP200规则体积超限；云端仍451，未实际取得精简后的真实币安响应，需本机复测。

[修复与验证详情](spot-arbitrage/docs/BINANCE_RULES_FIX_20261106.md) · [Windows说明](spot-arbitrage/docs/WINDOWS.md)

补丁SHA256：`b3e13548137fd5e1d1c6c61b6b7fa5d4c82346de6cd113425cc4f77042573177`（13660字节，3文件）。

完整包SHA256：`d9e670915d364132222f0d2a11088044133aabfe85b7f306cb373ab43cf6e88d`（305038字节，95文件）。

真实账户及实盘验收仍未完成，OKX后端验证锁和原有资金安全阻塞保留。独立交付分支，不合并main，不含data、真实Key、主密钥或node_modules。
