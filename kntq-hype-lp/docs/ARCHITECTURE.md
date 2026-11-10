# 架构与资金操作边界

本地单页应用由 `profiles.ts` 定义独立网络，`adapter.ts` 选择读取与交易实现。`src/lib/chain.ts` / `transactions.ts` 负责 HyperEVM v3，`src/elysium/` 负责 Elysium v4；钱包、设置、活动日志与采样按配置隔离。共享 UI 不直接拼装跨协议 calldata。

## 配置与失效

HyperEVM 为 `999`、v3 KNTQ/WHYPE。Elysium 为 `99901`、桥接 KNTQ/原生 HYPE，固定 fee 10000、spacing 200、hooks 0 的 PoolId。共享类型中的旧字段 `amountWhype` / `feeWhype` 表示报价资产数量；v4 的 `quoteSymbol: HYPE` 使界面和指标按原生 HYPE 解释，钱包的 `balances.whype` 仍是实际 wrapped token 余额。

网络切换使用 keyed workspace，立即取消旧异步上下文与预览。账户/链变化同步失效；发送前再读取钱包账户与 chain ID。连接、签名或恢复过程中禁用配置切换。旧账户的慢请求不能覆盖新账户数据。

## 读取与完整性

RPC 逐 endpoint 核对链 ID；只读 transport 明确拒绝签名/发送方法。网络错误可切换读取，合约模拟 revert 不换节点试图找成功结果。快照锁定区块，检查真实块时间和最终块哈希，不能把收到响应的时间当作链上新鲜度。

v3 使用官方 Factory 验证池，PositionManager multicall 批量读取 NFT 索引和 positions。手续费包括 tokensOwed 与 feeGrowthInside 增量，按 uint256 回绕计算。

v4 验证完整 PoolKey（包含 hooks）并重算 PoolId；核对 PositionManager 的 PoolManager / Permit2 / WETH9、StateView 的 PoolManager、代币元数据与合约代码。生产代码身份门只接受四个固定官方部署的完整 runtime Keccak-256 指纹，不接受不同 npm 构建的泛化匹配作为放行备选。指纹由 Uniswap/contracts 固定提交的官方部署输入、构造参数、链 ID 99901 与目标地址离线执行构造函数得到；三个 CREATE2 输入与地址推导均核对一致，PositionManager 结果另与独立观察值相符。官方记录、编译参数和指纹保存在 deployment-source.json / code-identities.json。通用 npm artifact 的 immutable mask 检查仅保留为独立回归测试，生产放行依据是完整代码指纹。实际 RPC 返回代码仍需逐次比较，错误或缺失则禁止签名；来源已核实不等于当前链上状态、RPC 诚实或资金路径已验证。

v4 NFT 不使用 v3 Enumerable。先查最近 120 个 ID 和本地 trackedIds；必要时补充约 30,000 块 Transfer 日志，每段约 1,800 块，按 block / transaction / logIndex 重放，再以同一区块的最终 ownerOf 核对。已找到归属数量与 manager.balanceOf 一致才标完整；否则显示部分扫描，不报告成功空钱包。手动 TokenId 同样检查归属与完整 PoolKey。RPC 或手续费读取异常不能变成零费用。

## 交易计划

填写预算 → 验证快照、余额、范围与身份 → 冻结付款人、链、接收人、期限、滑点和 calldata → 展示预览 → 用户确认 → 每一步重新验证账户/链、合约身份、所有权及池 → eth_call → Gas 估算和可用余额检查 → 钱包单次发送 → 等待并核对真实交易与回执。

区间预设为 ±2%、±5%、±10%、±20%、全区间，也可自定义。价格范围向外对齐协议 tick spacing；展示实际范围。所有交易金额使用 bigint / SDK，严格解析十进制，不用浮点生成付款金额。

### v3

原生 HYPE 显式包装为 WHYPE，按需要清零并精确授权，随后 mint。新池初始化与 mint 原子执行，初始价格必须明确且位于确认区间内，滑点后的双币 minimum 均大于零。签名前检测到竞争初始化会停止；广播后的竞争由确认 minimum / 滑点保护，不保证精确初始化价。领取为 collect；完整撤仓为 decreaseLiquidity + collect，同笔原子执行。回款 WHYPE 不自动解包。

### v4

只操作固定的已初始化池，不创建未知池。固定流动性的 mint 支付上限经 SDK 舍入与滑点计算后仍不得超过双币预算；HYPE 另须覆盖 Gas 上限和最低预留。KNTQ → Permit2 与 Permit2 → PositionManager 按本次最大需要精确授权，旧非零额度必要时清零再授予；Permit2 期限不晚于五分钟计划期限，没有额外 0.1% buffer。

领费使用 DECREASE_LIQUIDITY(0) + TAKE_PAIR。官方 v4 对本金 delta 扣除 feesAccrued 后校验 minimum，因此零流动性的本金 minimum 为零；不能把待领手续费 minimum 编码到这里，预览不承诺手续费最低到账，不进行隐式兑换。完整撤仓为 BURN_POSITION + TAKE_PAIR，使用本金滑点 minimum、确认接收人，原子销毁 NFT 并取回费用与本金。

### 失败与恢复

模拟失败、拒签、账户/网络变化、计划过期或余额不足即停止。已确认的前置包装/授权不能因后续失败回滚。receipt 必须成功，且真实交易 hash / from / to / calldata / value 与冻结步骤相符才继续；v4 还核对 nonce。

v4 的执行与公共恢复查询使用同一 Web Lock，在同源标签页之间互斥；内部查询使用已持锁路径避免重入死锁，慢查询不能清掉新交易的记录。每次发送前持久化按链、manager、账户隔离的 pending 记录，含 nonce 和原交易内容，返回哈希后立即保存。未知发送结果或回执超时会保留锁，原计划消费后不能再次发送；新计划也被阻止。最后一次异步钱包检查返回后再次检查停止标志。reconcilePending 只读核对真实交易与确定成功/回滚回执，匹配才清锁。手动提供的取消/替换哈希可在同账户、同 nonce、确定回执及 latest 已确认 nonce 推进后解除锁，但只允许新预览，绝不确认或继续旧计划。未知哈希须从钱包活动取得，无时间解锁或确认复选框绕过。清理站点数据不是恢复方法。

## 指标与本地数据

本金是当前流动性对应代币价值，不是原始成本。KNTQ 报价取对应池价格；外部 HYPE 永续中间价独立检查时效，无有效价则美元估值缺失。

采样按 chain / PositionManager / account / tokenId 保存。比较原始代币手续费增量，再以同一时点价格估值；至少 300 秒、最长 24 小时，且流动性稳定、费用未下降才估计 APR。领取或流动性变化后重置，不把美元重估当收入。秒级估算从最后链上待领额推算，每秒重绘，过期暂停。

设置和活动日志按 profile 保存，保留旧 v3 设置键兼容已有用户。可导出 JSON，目前无导入 UI；站点数据清理丢失采样、活动与 pending 记录。

## 验证边界

单元与 fixture 浏览器检查验证实现条件，不能证明当前主网部署、RPC 诚实或钱包资金路径可用。合约未知时产品默认阻止交易，不以测试替代身份核验。实际结果、来源证据、云网络限制和未做的有资金钱包测试写入 VERIFICATION.md，不承诺固定年化或无漏洞保证。
