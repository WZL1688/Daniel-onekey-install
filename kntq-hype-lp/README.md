# KNTQ / HYPE 本地 LP 工作台

本地浏览器工具，支持两个独立配置：HyperEVM `999` 的 Uniswap v3，以及 Elysium `99901` 的 Uniswap v4。可连接浏览器钱包、读取真实链上余额与持仓、预算建仓、领取手续费和撤出流动性。密钥始终留在钱包；本工具不索取私钥或助记词，也不会替用户签名。

## GitHub 下载与 Windows 启动

GitHub 交付使用 `WZL1688/Daniel-onekey-install` 的 `codex/kntq-hype-lp-v0.2.0` 分支。可在该分支的 `downloads/` 目录下载 `kntq-hype-lp-v0.2.0.zip`；`SHA256SUMS` 给出对应校验值。源码位于分支的 `kntq-hype-lp/` 目录，长期交接资料也随源码保存。下载工具包不会连接钱包或发送交易。

Windows 下载后右键 ZIP →“全部提取”，打开包含 `package.json` 的文件夹，在资源管理器地址栏输入 `cmd`，依次执行 `npm ci` 和 `npm run dev`。保持窗口运行，再用本机安装了钱包扩展的浏览器打开 `http://127.0.0.1:5173`。已安装 Node.js 24.x 的用户无需重新安装。

## 启动

推荐 Node.js 22.12+ 或 24 LTS；完整版本约束见 `package.json`。在源码目录运行：

```bash
npm ci
npm run dev
```

保持终端运行，在同一台电脑安装了 MetaMask、Rabby 等扩展的浏览器中打开 `http://127.0.0.1:5173`。云端的 loopback 地址与个人电脑的本地地址不同。无需 `.env` 或钱包私钥。生产构建为 `npm run build`，本地查看构建为 `npm run preview`；服务默认仅监听 `127.0.0.1`。

保留 `.npmrc` 和锁文件。`legacy-peer-deps=true` 跳过 SDK 元数据带入、应用未使用的开发 peer（如 Hardhat），使用 `npm ci` 重现安装。

## 选择网络与资产

| 页面配置 | 网络与协议 | 目标币对 | 支付和回款 |
| --- | --- | --- | --- |
| HyperEVM · v3 | chain ID `999`，官方 v3 Factory / PositionManager | HyperEVM KNTQ / WHYPE | 可显式包装原生 HYPE 后建仓；领费和撤仓返回 KNTQ / WHYPE |
| Elysium · v4 | chain ID `99901`，固定 1% 无 hook v4 池 | 桥接 KNTQ / 原生 HYPE | 原生 HYPE 直接结算，不包装；领费和撤仓返回 KNTQ / 原生 HYPE |

顶栏切换配置后需重新连接相应网络的钱包。设置、活动日志及手续费采样按配置隔离；切换网络、账户或卸载页面会使旧预览失效。不能把两条链的同名代币或 v3/v4 交易编码混用。

Elysium KNTQ 为 `0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0`，目标 PoolId 为 `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac`。完整配置见 `src/elysium/config.ts`，来源及未覆盖验证见 `docs/PROJECT_MEMORY.md`、`docs/VERIFICATION.md`。

## 操作

连接钱包后核对账户、链、余额与区块新鲜度。填写双币预算，选择 ±2%、±5%、±10%、±20%、全区间或手动价格区间，查看对齐 tick 后的实际范围、金额上限、接收人及交易步骤，再确认执行。工具不会自动购买缺少的代币。滑点固定，失败不会自动放宽或重发；每一步仍需钱包签名。

- v3 通过官方 Factory 查找所选费率池。不存在时仅按明确预览的预算隐含价格初始化，并把初始化与 mint 放在同一笔交易；竞争初始化与精确价格保证的边界见架构文档。
- v4 仅支持配置中的既有无 hook 池，不自动创建或初始化其他池。建仓的最大支付量不得突破填写预算，原生 HYPE 还须覆盖 Gas 与最低预留。
- v4 使用 KNTQ → Permit2 → PositionManager 两层精确额度，必要时清零旧额度；Permit2 到期不晚于五分钟交易计划期限，没有自动增加 0.1% 授权缓冲。
- v4 领费使用 `DECREASE_LIQUIDITY(0) + TAKE_PAIR`。减零流动性的**本金**最低量必须为零，这不是放宽兑换滑点，也不构成手续费最低到账承诺；本次不兑换代币。撤仓使用原子 `BURN_POSITION + TAKE_PAIR`。

Elysium 合约代码身份与关联校验未通过时，页面禁用交易。生产校验固定官方部署记录中四个合约的**完整运行时指纹**：使用官方发布的部署输入，在离线 EVM 中按真实链 ID、合约地址及构造参数重建，再与 RPC 返回代码逐次比较。来源与指纹见 `src/elysium/deployment-source.json`、`code-identities.json`。PositionManager 的通知 Gas 参数固定为官方记录的 2,000,000；通用 npm 产物的不同编译结果不会作为放行备选。代码匹配、官方地址来源与实际链上状态是不同证据；未知字节码没有页面绕过开关。

## 持仓完整性与交易恢复

v3 批量读取 Enumerable NFT。v4 没有相同的枚举接口，先查近期 NFT，再补充 Transfer 日志，并以固定区块的最终 `ownerOf` 和钱包 NFT 余额核对完整性。若扫描不完整，页面明确显示“已扫描”与告警；空列表不代表钱包没有仓位。可输入 TokenId，核对归属及完整 PoolKey 后加入本配置跟踪列表。手续费读取失败不会伪装成零收益。

v4 使用同源跨标签页 Web Locks 互斥执行与恢复查询；不支持该原子锁的浏览器会禁止发送。广播前保存账户、nonce 与调用信息，返回哈希后立即记录；等待超时或结果未知会锁住该链该账户的新计划。使用设置中的“查询待确认交易”只读核对；哈希未知时，从钱包活动粘贴真实交易哈希。原交易须匹配账户、nonce、目标、数据、金额及确定回执；钱包取消/替换交易则必须手动提供真实哈希，核实同账户、同 nonce、确定回执及已确认 nonce 推进，才允许重新预览，绝不自动继续旧计划。没有“确认没有交易”复选框或按时间自动解锁；切勿通过清除站点数据绕过未知交易状态。

## 指标与记录

本金表示当前持仓代币数量与估值，不是历史投入成本或 PnL。年化来自原始代币手续费增量，至少需要 300 秒、最长 24 小时的连续样本；流动性变化、领取、费用下降后重置。已有费用的美元重估不算新增收入，不保证任何年化。

秒级估算待领从最近链上费用和实测速率推算，每秒重绘；数据过期或样本不足即暂停。实际待领数量仍以链上区块为准。美元估值使用 Hyperliquid HYPE 永续中间价和对应池的 KNTQ/报价币比价，是指示性参考。

设置、采样和活动日志保存在浏览器本地，可用“导出本地记录”下载 JSON；当前没有导入恢复 UI。清理站点数据会丢失记录，尤其不能用它规避未确认交易锁。

跨 AI 维护入口为 `AGENTS.md`、`docs/PROJECT_MEMORY.md`、`docs/PROGRESS.md`、`docs/MAINTENANCE_LOG.md`。后续 AI 必须主动读取这些文件；不同产品或聊天不会自动同步记忆。社区 v4 工具的旧审查保留在 `docs/EXTERNAL_V4_REVIEW_2026-11-09.md`，本次按官方协议独立实现，没有直接合并其交易代码。

## 验证

```bash
npm run check
npm test
npm run build
```

先在另一个终端运行 `npm run dev`，再执行受控浏览器测试：

```bash
npx playwright install chromium
npm run test:browser
npm run test:browser:v4
```

测试使用明确标注的模拟 RPC / 钱包 / TEST FIXTURE；截图不代表真实持仓。双网络版本的最终结果及安全复核见 `docs/VERIFICATION.md` 和 `docs/SAFETY_REVIEW_2026-11-10.md`。v4 测试运行时代码由固定官方部署输入离线生成，仅用作测试，不能冒充已读取的主网代码。

2026-11-10 云端重查 RPC 仍返回代理 `CONNECT 403`，此前行情请求也被同一网络策略阻断。真实部署、当前快照及有资金钱包端到端仍需可达网络验证；未向主网写入交易。用户本地浏览器网络独立，也可能受 RPC CORS、限频或地区网络影响。
