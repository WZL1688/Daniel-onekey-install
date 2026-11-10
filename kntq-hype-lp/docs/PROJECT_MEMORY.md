# 项目长期记忆

更新日期：2026-11-10（Asia/Shanghai）。只记录可复用事实与已接受约束，进行中的工作见 `PROGRESS.md`。

## 用户目标

开发 KNTQ/HYPE 本地 Uniswap LP 工具：连接浏览器钱包、查询余额、确认预算后建仓；组池、提取手续费与撤仓；三列动态持仓卡片；本金、待领收益、近期年化、秒级估算与美元价值；排序、过期提示、RPC 故障切换及隐藏撤空仓。交易预览确认、每次签名前模拟，不自动放宽滑点或重发。建立可由后续 AI 读取的长期记忆、开发进度与维护日志。

## HyperEVM v3 已确认的部署资料

| 项目 | 值 |
| --- | --- |
| 网络 | HyperEVM 主网，chain ID `999` |
| KNTQ | `0x000000000000780555bD0BCA3791f89f9542c2d6`，18 decimals |
| WHYPE | `0x5555555555555555555555555555555555555555`，18 decimals |
| Uniswap v3 Factory | `0xf0db7b58379503491d857dB50AC9ece64c653918` |
| NonfungiblePositionManager | `0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377` |
| 官方 RPC | `https://rpc.hyperliquid.xyz/evm` |
| 备用 RPC 资料 | `https://hyperliquid-json-rpc.stakely.io`，上线可用性仍须实际探测 |

依据：[Uniswap 官方 HyperEVM 部署](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-hyperevm-deployments)、[Kinetiq 官方合约与审计](https://kinetiq.xyz/docs/contracts-and-audits)（用户补充，地址一致）、[Chainlink 官方 KNTQ 目录](https://docs.chain.link/ccip/directory/mainnet/token/KNTQ)、[官方 WHYPE 说明](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/wrapped-hype)、[官方 RPC 工具](https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hyperevm-tools)。

未确认任何固定费率下已有官方 Uniswap KNTQ/WHYPE 池。必须用官方 Factory `getPool` 实时查找。搜索出现的 Nest / Project X 池不得代入。合约地址资料确认不等于当前 RPC 集成测试通过；还需核验链 ID、部署字节码、代币元数据及合约关联。

## 产品和技术决策

- 本地 Vite + React + TypeScript 应用；不部署到公网。链上整数使用 bigint / SDK，不用浮点数生成交易金额。
- 钱包通过 EIP-1193 / EIP-6963 接入，私钥始终留在钱包。读取 RPC 可以切换；交易提交只调用一次钱包。
- 默认刷新为 60 秒，链上快照 / 美元价格过期阈值分别为 90 秒 / 90 秒。PositionManager 固定区块 multicall 合并 NFT 索引与仓位读取；10 仓请求数由约 67 降至约 49，仍需考虑 RPC 限频。
- 交易计划固定账户、链、预算、滑点、范围、deadline 和 calldata。余额与 gas 预算不足、过期、账户变化或模拟失败则停止。
- 价格范围向外对齐 tick spacing。新池初始化只允许确认区间内的双币投入，滑点后的两边最低金额均须大于零；签名前检测竞争初始化并要求重新预览。签名后的竞争仍由原子 mint 最低金额保护，不能声称精确锁定新池初始化价。
- v3 的原生 HYPE 必须包装成 WHYPE 才能参与 ERC20 池；v4 的报价资产为原生 HYPE，直接结算。不能把它们的余额与回款混写。授权精确金额，必要时清零再授权。
- receipt 成功后，还核对交易 hash、发送人、目标合约、calldata 和 value 与原预览一致，才继续后续步骤。已成功包装或授权不会被后续失败回滚。
- 本金是当前流动性的代币数量，不是历史成本；没有已验证成本账本时不展示 PnL。
- 手续费要包含尚未 poke 的 feeGrowthInside 增量；只有 tokensOwed 会漏算。读取应尽量锁定同一区块。
- 年化使用本地至少 300 秒的连续手续费观测。流动性变化、手续费下降或无有效样本时重置。秒级值是估算，不是链上结算频率。
- 美元估值：Hyperliquid HYPE 永续中间价 × 池内 KNTQ/WHYPE 价格。外部价格有独立时间戳；失效则不标成实时美元价值。
- 持仓 liquidity 与待领费用均为零时才可隐藏；零流动性但仍有费用的 NFT 应保留。
- 秒级估算待领每秒重绘，使用最近链上费用加观测速率；过期时暂停。实际待领数量保持链上口径。
- `.npmrc` 使用 `legacy-peer-deps=true` 排除 SDK 中不使用的开发 peer（Hardhat 等），保留锁文件重现安装。最终验证结果见 `VERIFICATION.md`。

## 已接受的范围决策

用户明确确认第一版采用 HyperEVM 主网官方 Uniswap v3。用户另给 Elysium 桥接 KNTQ、WHYPE 与一个 32 字节池 ID，已调查并保存到 `ELYSIUM_RESEARCH.md`。当时 Elysium chain ID `99901`、RPC `https://node.eleos.fun` 与 v4 原生 HYPE 池留作后续；现已按下节授权独立接入，不能混入当前 chain `999` 的钱包、RPC 或 v3 交易编码。

## 原 v3 版本的历史验证边界

最终依赖状态下类型检查、生产构建、39 项单元测试与 17 项受控浏览器 QA 通过，详见 `VERIFICATION.md`。浏览器 fixture 与测试截图显式标为测试数据，没有主网写入。真实 Hyperliquid RPC 与 API 的云端 curl 探测被代理 `CONNECT 403` 阻断，因此主网快照与有资金钱包端到端尚未完成；不得据此声称余额为零或池不存在。

## 已授权的双网络扩展

用户在外部工具审查后明确要求“添加进去，详细检查下要安全”，随后要求继续。因此 Elysium 已由延期调查升级为授权实施；保留原 HyperEVM v3，不能用新协议替换旧配置或混用链。

| Elysium v4 项目 | 配置值 / 状态 |
| --- | --- |
| profile / chain ID | `elysium-v4` / `99901` |
| 桥接 KNTQ | `0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0` |
| PoolManager | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` |
| PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` |
| StateView | `0x27ed73ae0652fdcf71d6793412a7525f32be9dfe` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |
| PoolId | `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac` |
| 完整 PoolKey | currency0 原生 HYPE / zero address；currency1 桥接 KNTQ；fee 10000；spacing 200；hooks zero address |
| RPC 配置 | 官方域候选 `https://rpc.elysium.kinetiq.xyz`，另列 Eleos 与 BOXA 只读备选；可用性和真实链响应未验证 |
| 部署证据 | 2026-11-10 已从 Uniswap/contracts 固定提交 3b872969 的官方部署记录核对关键地址与构造参数；实际链上响应仍未取得 |

扩展采用官方 v4 ABI 和协议语义独立实现，没有直接复制缺乏明确再发布许可的社区工具执行器。区间预设为 ±2%、±5%、±10%、±20%、全区间；v4 仅操作指定既有无 hook 池，不自动初始化其他池。

冻结计划按账户、链、接收人、预算、期限、滑点和部署指纹绑定，切换账户/链立即失效。v4 预算上限包括整数舍入和滑点，不通过扩大输入预算容纳价格变化。Permit2 两层精确额度、到期不晚于五分钟计划期限，无额外 0.1% buffer；旧额度必要时清零。

v4 领费为 DECREASE(0) + TAKE_PAIR，本金 minimum 为零且不承诺费用 minimum；100% 撤仓使用 BURN_POSITION + TAKE_PAIR，原子取回原生 HYPE / KNTQ。receipt.status、实际 hash/from/to/data/value/nonce 必须匹配；广播前落盘 pending 信息、返回后立即存哈希，未知状态锁住新计划，恢复只读查实，无页面绕过。

UI、设置、日志与采样按 profile 隔离。共享旧字段 amountWhype/feeWhype 在 v4 表示原生 HYPE 报价数量，必须根据 quoteSymbol 正确展示；balances.whype 仍为实际 WHYPE 钱包余额。v4 NFT 扫描不完整时明确显示已扫描范围，手动 TokenId 也验证 owner 与完整 PoolKey。年化比较原始代币手续费增量，至少 300 秒，不能把价格变动计作收入。

本次双网络版本构建、133 项单元和 44 项受控浏览器检查（v3 17 + v4 27）通过，详见 VERIFICATION.md；原 v3 的历史 39/17 单独保留。真实 RPC 和有资金钱包测试仍未完成。生产身份门使用官方部署输入离线推导的四个完整 runtime 指纹，PositionManager 哈希 ad189c…94e7 与独立观察相符；不同优化参数的 npm runtime 不能替代。通知 Gas 参数精确固定 2,000,000。执行/恢复使用跨标签页 Web Lock；停止后最后一次钱包检查不能继续签名。已确认的同 nonce 取消/替换只解锁新预览，不复活旧计划。

## GitHub 交付位置

2026-11-10 用户在聊天附件多次下载失败后要求沿用 GitHub，并强调安全与可下载。交付使用当前工作区关联的 `WZL1688/Daniel-onekey-install` 独立分支 `codex/kntq-hype-lp-v0.2.0`，新增 `kntq-hype-lp/` 源码目录和 `downloads/` 工具包、校验值与下载说明。该仓库为公开仓库；仅交付审核后的源码与构建，排除工作记录、凭据、依赖目录和测试截图。既有 main 的节点安装脚本不属于此 LP 工具。代码交付不是公网运行或钱包交易授权。将来修改时先核对远程实际分支与下载包校验值，不能把本地提交当作已经推送。

## 记忆边界

2026-11-09 后续请求：用户提供 Elysium KNTQ/HYPE v4 社区工具链接，要求评估能否借鉴并注意安全。本次审查候选公开仓库 `congge918/elysium-kntq-hype-lp` 的固定提交 `ca738de85e6f3f5fc9f3d514fe877de8c12ca94a`；原帖短链未能展开，仓库与描述匹配但对应关系未完全验证。发现标准 v4 领费 minimum 语义错误、账户切换未作废预览、未检查 receipt.status、美元重估虚增 APR 等，记录在 `EXTERNAL_V4_REVIEW_2026-11-09.md`。仅借鉴设计与公开协议流程，不直接合并其交易代码，不变更当前 HyperEVM v3 网络；复制再发布须先澄清未明确的许可证。未安装或运行该工具、未连接钱包，主网写入为零。

这些文件是版本化的交接资料，不是跨产品自动同步的 AI 记忆服务。后续会话需提供源码并让 AI 从 `AGENTS.md` 开始阅读。本地浏览器观测数据与仓库文档分开保存；两者均不应含私钥或助记词。
