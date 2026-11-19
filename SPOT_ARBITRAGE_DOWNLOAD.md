# 现货量价观察下载版（2026-11-19）

已有安装：[升级补丁 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-market-watch-patch-20261119.zip)。全新安装：[完整 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-market-watch-20261119.zip)。

加入闭合现货K线放量、涨跌、72h位置、15m冲高回落观察及本机提醒冷却；默认关闭，在设置中启用后随候选扫描更新。未采用截图中的翻倍概率、合约OI/资金费/多空比或追涨下单；没有外部脚本源码，本次未修改那份程序。

正常停服、保留完整data及node_modules，把补丁内容复制到现有package.json所在目录并替换，再用4-start-proxy-7897-windows.cmd启动和刷新网页。设置启用“现货量价观察”后开始候选扫描。依赖未变，不用重新安装。

338/338完整测试通过，本次依赖审计0个已知漏洞；本地合成夹具连续65.307秒完成两轮扫描、3次K线和9条本机提醒，同柱重复0，私人/订单/失败/限流均0。合成数据不代表真实机会或成交；原实盘验证锁、利润门槛、配额与熔断保留。

[功能与取舍说明](spot-arbitrage/docs/MARKET_WATCH.md) · [本次验收](spot-arbitrage/docs/MARKET_WATCH_RELEASE_20261119.md)

补丁SHA256：`77743cd07780ec8b0cb14d5dab1aa37ea8b0f3334e69768c24512b39ee4d7ea4`（109844字节，25文件）。

完整包SHA256：`8ecea7f9632348629a044c298e9b8ac0dcd7dda8b3016c5d84bab50d16cf9e9c`（398372字节，118文件）。

仅独立交付分支，不合并main或发布云环境。不包含data、真实Key、主密钥、.env或node_modules。
