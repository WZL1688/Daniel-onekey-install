# 现货套利工具下载

本分支提供已更新的 Binance / OKX 双交易所现货套利工具源码和 ZIP。未合并到 main，原有四份节点安装脚本未改动。

## 下载

- [下载独立 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-updated.zip)
- 若直接下载没有开始，打开本分支的 downloads/spot-arbitrage-updated.zip 文件页，使用 Download raw file。
- 源码目录：spot-arbitrage/。若下载整个 GitHub 分支 ZIP，请进入其中的 spot-arbitrage 文件夹。

ZIP SHA256：`91db7bd43c7eb192434957a3fc9147594d45a5a9def12268504e149ffd724cae`

## 安装

需要 Node.js >=20.18，支持 Linux、macOS 或 WSL2。解压独立 ZIP，进入 spot-arbitrage 文件夹：

```bash
npm ci
npm test
npm start
```

默认只监听本机端口8888，实盘默认关闭。详细说明见 [README](spot-arbitrage/README.md)、[需求对照](spot-arbitrage/docs/REQUIREMENTS.md)及[实际验收报告](spot-arbitrage/docs/ACCEPTANCE.md)。

## 验证范围

150项自动化测试全部通过；本地模拟行情连续65秒，三个关注交易对均成功取得盘口。本次正常服务的真实交易所访问受云环境网络策略阻拦，没有真实有效盘口，OKX官方文档及真实接入验收尚未完成，后端实盘锁保留。没有配置真实账户凭据或发送真实订单。

下载包不含 data/、node_modules/、.env、master.key 或真实账户凭据。测试及官方文档中的示例签名、示例 Key 不是真实账户密钥。请不要把本地测试通过视为已完成实盘验收，也不要通过手工改验证标志绕过未完成的接入检查。
