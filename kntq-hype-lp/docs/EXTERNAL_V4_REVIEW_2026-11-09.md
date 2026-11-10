# Elysium KNTQ/HYPE v4 外部工具审查

日期：2026-11-09（Asia/Shanghai）。结论：可借鉴交互与协议资料，当前固定版本不宜直接用于主钱包，也不直接合并其交易执行器或收益计算代码。

## 来源与范围

用户提供原帖短链 `https://t.co/5NMyi1WUoz`，本次无法展开该短链。通过 GitHub 找到与名称、功能、币对及 PoolId 均吻合的公开仓库 [congge918/elysium-kntq-hype-lp](https://github.com/congge918/elysium-kntq-hype-lp)。尚不能把搜索匹配当成短链重定向证明。

固定审查提交：[`ca738de85e6f3f5fc9f3d514fe877de8c12ca94a`](https://github.com/congge918/elysium-kntq-hype-lp/tree/ca738de85e6f3f5fc9f3d514fe877de8c12ca94a)。获取 41 个文本文件，逐个通过 Git blob SHA1 与该提交的 tree 校验一致；未获取或渲染 `hero.png`，SVG 仅按文本检查。没有安装依赖、运行其应用/安装脚本、连接钱包或发送交易。仅以锁文件请求依赖漏洞数据库，另运行了自写独立算术检查，没有加载外部项目源码。

以下行号以该固定提交为准，不代表后续 main 分支状态。静态缺陷不等同于已在目标链上复现；真实部署代码与主网资金路径仍未验证。

## 应先修复的问题

| 优先级 | 问题与固定源码位置 | 影响与处理 |
| --- | --- | --- |
| 高 | `src/App.tsx:123` 将待领手续费乘滑点后作为 `DECREASE_LIQUIDITY(0)` 的 minimum；编码在 `src/lib/actions.ts:165` | 标准 v4 PositionManager 校验的是本金 delta，扣除 feesAccrued；减零流动性本金为零，正 minimum 会使有收益的领费回滚。按官方领费语义处理，不能把本金 minimum 当作费用 minimum，也不能自动放宽滑点重试。 |
| 高 | `src/hooks/useTxFlow.ts:36` 的预览不绑定 account/chain；`src/components/AddLiquidityForm.tsx:165` 固定 mint recipient；`useTxFlow.ts:189`、`:198` 使用确认时的最新 account | A 账户准备预览后切到 B，可出现 B 付款、NFT 仍发给 A。账户/网络变化必须作废计划；签名前核对冻结的付款人、接收人和 chain ID。不能仅凭没有显式 chain 检查就断言必然错链付款，wagmi/viem 也可能拦截未配置链。 |
| 高/中 | `useTxFlow.ts:205` 等到 receipt 后没有检查 `status`，`:207` 仍推进下一授权或关闭主交易预览 | reverted 也可能被当作完成。应验证成功状态，并核对真实交易 hash/from/to/data/value 后才继续。 |
| 中 | `useTxFlow.ts:198` 广播，直到等待回执成功后才保存 hash；`:218` 出错后原预览仍可确认 | 广播后超时会丢失可见 hash，用户再次点击可能重复建仓。没有发现应用主动循环重发；这里的问题是缺少不确定状态锁与查询入口。 |
| 中 | `usePositions.ts:233` 用两次手续费美元估值差、最低 5 秒样本估计年化 | 既有费用的价格上涨也被计作新增费用；不检查流动性变化、领取或账户样本边界。应比较原始代币手续费增量，再以同一时点价格估值并使用足够长样本。 |
| 中 | `usePositions.ts:180` 手续费读取失败保留 0；`:114` 过滤池遗漏 hooks，`:190` 却固定读取目标 PoolId | RPC 失败被显示为无收益，恢复又可虚增 APR；同币同费同 spacing 的 hooked 池会混入并引用错误价格/费用。完整比较 PoolKey 并重算 PoolId，失败显示未知。 |
| 中 | `usePositions.ts:42` 只扫描最新 120 个 NFT 与约 30,000 块日志；`:100` 先处理全部转入再处理全部转出 | 旧仓位会漏；同日志段内转出后转入、自转账可能被错删。UI 应明确不完整，按链上事件顺序重放并最终核对 ownerOf。手动 TokenId 撤池还需完整核验实际 PoolKey（`App.tsx:79` 当前忽略它）。 |
| 中 | `usePoolState.ts:40` 以收到响应的本机时间标新鲜；`rpcClient.ts:48` 仅配置 chain 对象；读取未锁同一区块 | 旧区块节点仍可显示新鲜；没有逐 endpoint 核对链 ID、区块时间、部署关联。`rotateRpc` 只更新显示索引，不改变已构造 fallback 顺序，显示节点也不可靠。 |
| 中 | `AddLiquidityForm.tsx:135` 在预计使用金额上另加滑点；`math.ts:176` 自写金额解析缺少严格校验 | 输入预算没有被用作最终硬上限，Gas 预留只用于自动填表；应显式限制金额上限和签名前可用余额。`-0.5` 会被错误解析为正数，`1.2.3` 后段被忽略，非法输入可能令 render 抛错。 |

核心协议依据：[Uniswap v4 PositionManager 的 _decrease](https://github.com/Uniswap/v4-periphery/blob/main/src/PositionManager.sol#L337-L350) 对 `(liquidityDelta - feesAccrued)` 执行 `validateMinOut`；[SlippageCheck](https://github.com/Uniswap/v4-periphery/blob/main/src/libraries/SlippageCheck.sol) 检查本金最低取回数量。该上游 main 用于核对协议语义，不是已验证的 Elysium 部署字节码。

## 独立算术检查

自写检查脚本位于开发工作区 `work/reviews/reproduce-review.mjs`，仅使用现有项目的可信 viem 依赖和自写算术，不导入外部源码：

- 重算 PoolKey（native HYPE、桥接 KNTQ、fee 10000、spacing 200、hooks 0）得到用户提供的完整 PoolId。
- `DECREASE(0)` 的本金 0 小于正的费用 minimum，符合上述回滚条件。
- 费用一直为 1 HYPE、没有任何新增，参考价由 $30 改为 $33，间隔 8 秒，本金 100 HYPE，其美元差分公式可显示 **358,363.64%** 年化。
- NFT 在同一日志段先转出、再转入，先遍历 ins 后遍历 outs 的集合算法会错删当前持仓。

这些结果不能证明当前宣传中的 1000% 年化真实或虚假；它们说明该年化实现不能用作宣传收益的可靠验证。手续费年化也不等同于包含价格变化、无常损失及 Gas 的净回报。

## 安装、密钥与部署证据

- 在所审查源码中未发现助记词/私钥输入、密钥导入、远程签名、遥测外传、任意脚本求值或危险 HTML 注入路径；钱包通过 injected provider 签名。此为有限静态观察，不能给出无恶意或无漏洞保证。
- package scripts 为 Vite、tsc、oxlint；未见仓库 preinstall/postinstall 或远程 shell 安装器。锁文件 111 个 registry.npmjs.org 包均有 integrity，唯一标记安装脚本的是可选 fsevents。`npm audit --package-lock-only --ignore-scripts` 报 0 已知漏洞；这不是应用审计，也不证明依赖供应链无风险。
- 默认 RPC 为 BOXA、Eleos、ElysiumSwap、Stockium 社区节点，且会作为添加网络参数写入钱包；没有自定义 RPC UI。对新默认 BOXA 端点的 `eth_chainId` 只读探测被云代理 CONNECT 403 拒绝，未取得实际链响应。
- 地址配置与此前研究相符，但源码中的 verified 注释不是部署证明。应从 [Kinetiq 官方合约资料](https://kinetiq.xyz/docs/contracts-and-audits) 指向的 `elysium.kinetiq.xyz/docs/contract-addresses` 核实；该目标页本次不可读。Uniswap 部署 feed 的生成时间早于主网上线，缺项不能用来断言部署为假。
- GitHub 显示该仓库于本日创建，审查时 4 次提交、版本 0.0.0，没有测试文件或 test script。未发现独立应用审计报告。
- 没有 LICENSE/SPDX；README 仅提供 as-is 本地使用说明，复制、改编及再发布范围不明确。借鉴设计和公开协议参数，独立实现；复制再发布前确认授权。

## 采用决定

可参考：±2% / ±5% / ±10% / ±20% / 全区间选择、实际 tick 与价格范围展示、原生 HYPE 的 v4 结算与退款思路、Permit2 有期限额度展示、手动 TokenId 找回入口。

不直接复用：当前交易执行器、领费 minimum 编码、美元差分 APR、持仓事件重放、RPC 新鲜度与活动节点显示。原生 HYPE 的 MINT_POSITION + SETTLE_PAIR + SWEEP、BURN_POSITION + TAKE_PAIR 仅作为官方协议流程参考，实际采用应按当前官方 ABI 独立编码并测试。

当前项目保持 **HyperEVM 999 / 官方 Uniswap v3**。Elysium 为 **99901 / v4 / 原生 HYPE + 桥接 KNTQ**，需要独立适配器及真实部署核验，不能简单换地址接入，也没有因此更换当前网络或发送交易。
