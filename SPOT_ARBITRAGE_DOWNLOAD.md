# 双所现货工具：完整整合版

**只需下载这一个完整包，已包含此前全部功能和修复：**

[下载完整整合版 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-all-in-one-20261119.zip)

文件：spot-arbitrage-all-in-one-20261119.zip，大小398372字节，118个文件。SHA256：`8ecea7f9632348629a044c298e9b8ac0dcd7dda8b3016c5d84bab50d16cf9e9c`。

## 已整合功能

- 双交易所现货深度与扣费利润计算、库存平衡、余额、Key隔离和加密、提交记录、限速调度与安全阻塞。
- 成本比较、流动性筛选、资金配额、已核对亏损持久化熔断。
- 中小币候选池、排除名单、净收益和深度筛选、扫描进度、过期/失败状态、手动加入关注。
- 可选现货量价观察、闭合K线成交额倍率、涨跌、冲高回落观察、本机提醒去重与冷却。
- Windows安装、普通启动、7897代理启动和只读诊断；包含此前盘口校时及Binance规则体积修复。

## Windows安装与迁移

1. 正常停止旧服务，保留旧目录和完整data备份。
2. 将整合包全部解压到新目录，进入包含package.json的spot-arbitrage文件夹，运行1-install-windows.cmd。
3. 需要保留旧设置/Key/记录时，把完整旧data目录复制到新项目内，再启动；不要同时运行新旧实例。
4. 本机HTTP代理为127.0.0.1:7897时，双击4-start-proxy-7897-windows.cmd；普通启动使用2-start-windows.cmd。浏览器打开http://localhost:8888/ 。
5. 在设置中选择候选池和可选“现货量价观察”，按需开始候选扫描。

## 验证与边界

整合包与b9cb0db已验收完整包内容相同，仅统一下载名称和入口，运行代码未再修改。该代码338/338自动测试通过，依赖审计0个已知漏洞，65.307秒本地合成夹具连续检查通过。此次核对全部源码校验、ZIP完整性及模块引用；没有为交付改名重复宣称新增测试。

包不含data、真实Key、主密钥、.env或node_modules。实盘和量价观察默认关闭，OKX后端实盘验证锁及原有风险阻塞保留。它是完整功能整合包，真实账户和实盘成交验收仍未完成。

[功能说明](spot-arbitrage/README.md) · [量价观察取舍](spot-arbitrage/docs/MARKET_WATCH.md) · [已有验收记录](spot-arbitrage/docs/MARKET_WATCH_RELEASE_20261119.md)

独立交付分支，不合并main或发布云环境。
