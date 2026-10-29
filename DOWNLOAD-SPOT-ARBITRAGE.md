# 下载双交易所现货工具源码

[点击下载 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-download-20261029/downloads/spot-arbitrage.zip)

也可在此分支点击 Code → Download ZIP。此分支保留原仓库文件，新增 spot-arbitrage/ 源码和 downloads/ 下载包。

下载包包含应用、122 项自动化测试、说明及验收报告，不含 API Key、私人运行数据、主加密密钥或 node_modules。

解压后进入 spot-arbitrage，安装 Node.js 20.18+，依次运行 npm ci、npm test、npm start。默认本机 8888 端口，支持 Linux、macOS、Windows WSL2。

**这是源码包，不是免安装程序。真实交易所接入尚未验收，OKX 实盘仍被后端保护锁定。不要将本地夹具测试当作实盘验证。**

详见 spot-arbitrage/README.md 和 spot-arbitrage/docs/ACCEPTANCE.md。此上传未发布云环境、未发出真实订单。
