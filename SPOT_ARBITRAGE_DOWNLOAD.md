# 更新版下载：本地功能验证版

**可安装启动本地界面和四项功能；真实账户与实盘尚未验收，不能直接作为实盘套利机器人。** 本分支不合并到 main。

- [直接下载最新 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-updated.zip)
- [GitHub 文件页](downloads/spot-arbitrage-updated.zip)：未自动下载时点击 Download raw file。
- ZIP SHA256：`ff7106c385f103b2cacb6e639204fe2c621242ef155c49f350b5a1a8a7e96877`

## Windows 怎么打开

1. 从 https://nodejs.org/ 安装 Windows LTS（要求 Node.js >=20.18）。
2. ZIP全部解压，双击 **1-install-windows.cmd** 安装依赖。
3. 安装完成后双击 **2-start-windows.cmd**，保持窗口打开。
4. 出现启动提示后，在浏览器打开 **http://127.0.0.1:8888**。

不需要Ubuntu，不要双击package.json。详见 [Windows说明](spot-arbitrage/docs/WINDOWS.md)。原生Windows完整实机验收尚未进行；兼容分支和启动逻辑已测试。

## 本次检查

- 四项增强：成本比较、流动性、资金配额、持久化亏损熔断。
- 修复崩溃后并发启动取得同一进程锁的风险，保留未知订单保护。
- 完整自动化测试265/265通过，依赖审计0个已知漏洞。
- Linux默认8888启动及HTTP访问通过；独立本地夹具连续65秒通过。
- 不含data、.env、主密钥、真实凭据或node_modules。

## 当前实际限制

OKX公共接口可访问，Binance云端探测返回地域限制451。OKX私人账户和实盘验收未完成；非USD报价的美元限额换算未验证时拒绝下单，实盘验证锁保留。审计和测试不保证没有未知漏洞或能够套利获利，不要改验证标志绕过限制。

[完整安全复查与验收](spot-arbitrage/docs/RELEASE_REVIEW.md) · [配置说明](spot-arbitrage/docs/FOUR_FEATURES.md)
