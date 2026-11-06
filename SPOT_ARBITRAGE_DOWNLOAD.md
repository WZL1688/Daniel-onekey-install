# 现货工具：行情故障修复下载版

[下载 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-network-fix-20261106.zip)

SHA256：`47a7f7ca710b745fe47fb5a67f0968bc4c79ad1e7f66626dfc1a591017d4f74d`。大小 280790 字节，88 个文件。

本次新增公共行情校时、明确网络错误分类、Windows 7897 代理启动入口和只读诊断。289/289 自动化测试通过；本地夹具连续运行 65.269 秒，完整轮转 9.005 秒，依赖审计 0 个已知漏洞。

先正常停服并备份 data，新版解压到单独目录，运行 1-install-windows.cmd，再按需复制完整 data。你已确认的本机 HTTP 代理为 127.0.0.1:7897 时，双击 **4-start-proxy-7897-windows.cmd** 启动，打开 http://localhost:8888/ 。诊断先停服，再双击 **3-diagnose-windows.cmd** 并回车。

[修复与验证详情](spot-arbitrage/docs/NETWORK_FIX_20261106.md) · [Windows 使用说明](spot-arbitrage/docs/WINDOWS.md)

币安 HTTP 451 地区限制仍存在；OKX 后端实盘验证锁、真实账户与成交验收边界仍保留。本包用于本地配置、公开行情及诊断，不是已完成实盘验收的自动套利机器人，不包含 data、主密钥、真实 Key 或 node_modules。原始 main 和节点安装脚本不改动。
