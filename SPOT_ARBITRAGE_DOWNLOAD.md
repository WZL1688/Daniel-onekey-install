# 中小币候选池下载版

已有安装：[升级补丁 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-candidate-patch-20261106.zip)。全新安装：[完整 ZIP](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/spot-arbitrage-delivery-20261103/downloads/spot-arbitrage-candidate-pool-20261106.zip)。

默认在扫描中排除BTC/ETH/SOL，支持可编辑排除名单与限定候选池、净收益/深度筛选、完整轮进度、过期及失败标记和手动加入关注。不使用真实市值，加入关注不提交交易。

已有用户先正常停止服务、保留完整data，将补丁内容复制到现有package.json所在目录并替换同名文件，再用4-start-proxy-7897-windows.cmd启动。进入设置编辑名单，首页下方“中小币候选池”开始一轮筛选。

310/310完整测试通过，65.250秒本地合成夹具完成3候选和22轮关注行情，完整轮询9.005秒，私人请求/订单/失败/限流均0。合成结果不代表真实小币机会或真实成交验收；原OKX后端实盘验证锁保留。

[功能说明](spot-arbitrage/docs/SCANNER_CANDIDATES.md) · [本次验收](spot-arbitrage/docs/SCANNER_RELEASE_20261106.md)

补丁SHA256：`57cbd32d8df79aa02ebabba8d6a241bbedf786fdce861e568435dcbdaad782bf`（77856字节，16文件）。

完整包SHA256：`8ad7f17a9c69205b226121a28838a5ceff319f68caafeab19a13e7c3c68f9eb1`（345668字节，104文件）。

独立交付分支；main、原节点安装脚本和云环境发布不变。包不含data、真实Key、主密钥、.env或node_modules。
