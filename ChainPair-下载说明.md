# ChainPair 本机双链工作台 v1.3.0

[下载源码 ZIP](https://raw.githubusercontent.com/WZL1688/Daniel-onekey-install/chainpair-local-20261116/downloads/ChainPair-local.zip) · [SHA256](downloads/ChainPair-local.zip.sha256) · [完整使用说明](chainpair/docs/USER-GUIDE.md)

解压，安装 Node.js 24 LTS，Windows 双击 ChainPair/start.cmd；macOS/Linux 在目录运行 ./start.sh。也可运行 npm ci 后 npm start。保留启动终端，浏览器必须打开终端显示的完整 http://127.0.0.1:端口/ 地址，不能省略端口。

新增入口：行情首页 → Meme 雷达。提供 BNB/Solana 的 AVE 只读榜单、可解释市场筛选、CA复制、AVE直达、观察收藏备注和手动开启的中英文设备本地语音。API Key 使用本机密码加密保存；已有保险库锁定时，保存Key不会解锁交易钱包。详情见 [雷达配置教程](chainpair/docs/MEME-RADAR.md)。

默认套利演示、雷达关闭。雷达需自行申请 AVE Key；第三方额度与收费以账户套餐为准。市场初筛通过不代表代币安全，雷达不触发买入，也不自动设置套利地址。API请求共享5分钟间隔及持久预算；重启后需手动开启。

保留插件钱包、本机加密钱包、顺序套利、OKX跨链及60/40再平衡、交易档案、本地复盘和分页备忘录。实盘受RPC、API权限、资产映射、允许的交易格式与实际路线约束，尚未进行真钱验收。

本版158项自动测试及四组浏览器流程通过，详见 [验证记录](chainpair/docs/TEST-RESULTS.md)。源码包没有运行数据、钱包文件、API Key、日志或node_modules；test目录只包含固定模拟凭据。

更新前停止旧进程并备份自己的data目录；本包不包含个人数据。不要把钱包、Key或data目录提交到公开仓库。
