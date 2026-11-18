# 实盘适配器：支持范围与核验

适配器不是模拟回执的实盘包装。默认演练使用独立适配器；实盘每一腿必须经真实 RPC 确认。未配置钱包、API、池或可验证路线时展示阻止原因。

## 已实现

- BNB 主网 ID 56、Solana 主网 genesis hash 校验；多个 RPC 轮换读取。本机签名广播发生不确定失败时不自动切换重播，广播前先存确定性交易哈希。
- DexScreener 指定池行情、代币包含关系与流动性验证；它是索引行情，不代表可立即成交报价。执行使用 OKX 报价，并要求其路线元数据包含配置的池地址；无法核实池时阻止交易。
- OKX v6 同链兑换、跨链报价和交易构建。跨链报价选定的 bridgeId 在构建和状态查询中固定。
- BNB 普通兑换通过官方 Router ABI 解码输入代币、输出代币、准确输入量、最低到账、期限和收款地址。只支持 `BaseRequest` 系列已解码方法；其他方法停止并提示。
- **BNB → Solana 跨链支持 deBridge DLN Source 的直接 `createOrder` / `createSaltedOrder`**。核验给出代币与金额、DLN 目标链 7565164、Solana mint 字节、目标钱包字节、最低到账、源链修改权限、目标取消权限；拒绝外部调用、Permit 和额外推荐费用。原生币协议费必须等于合约 `globalFixedNativeFee()`，并计入 Gas 资金预留、费用上限和实际损益。OKX 是否提供这条直接路线取决于 API 权限、代币和路由，不保证总有可用报价。OKX 包装桥、其他桥 ABI 尚不支持。
- Solana 支持经典 SPL Token 与 V0/legacy base58 交易，校验付款人、唯一签名人、全部顶层程序白名单；拒绝代币授权/权限更改指令。跨链交易额外核验指令包含目标 EVM 收款地址。签名前 RPC 模拟并验证网络费与租金总原生币扣款及余额储备。模拟同时覆盖本钱包全部经典 SPL 账户和目标 ATA（最多 99 个代币账户），核验准确输入扣款、最低输出到账、其他 mint 不被扣款、mint/所有权/授权不被更改；不能核验时拒绝签名。初始报价将尚未创建的 ATA 租金纳入估算费用。Token-2022 扩展、V1、额外签名人暂不支持。
- BNB 授权必须预先通过外部钱包设置；建议只授权所需额度。程序要求现有额度至少覆盖本笔经过 ABI 解码核验的准确输入量。本程序不隐式发送授权交易，缺额度会在交易档案中给出 `APPROVAL_REQUIRED`、spender 与原始单位数量。只给核对过的 spender 授权。授权不足和不支持的 ABI 在初始三腿计划阶段即阻止买入；确认到账后每次重报价再次验证授权。实际到账可能比初始最低到账高，后续卖出须已有足够额度，否则程序会暂停并要求核对，不会擅自减少卖出数量。BNB 的 `routerAllowlist` 同时包含实际交易目标和批准 spender；Solana `programAllowlist` 包含实际路线所有顶层程序。默认空白表示禁止签名，用户需核对官方信息后配置。
- BNB 按交易 Transfer 日志计算当前钱包的净输入/净输出；Solana 按交易 pre/postTokenBalances、owner、mint 计算，不使用账户余额总差值混入其他转账。链上数量以整数原始单位保存。
- 跨链必须源链成功、OKX `SUCCESS`、目标链实际交易确认、目标 mint 与收款钱包实际净到账符合最低值且等于 OKX 声明到账值，才返回可用于卖出的 `receivedRaw`。BNB 等待配置确认数并核对区块未重组；Solana 等待 finalized。
- 源链/目标链回执、哈希在失败时附加给引擎存档。实际网络费、租金和原生币协议费分别留存，原生币风控累计这三类总支出，美元损益将网络及协议费与租金分项累加一次。目标链桥接方支付的费用已经反映在到账磨损中，不重复计为本钱包支出。

## 引擎独立意图校验与参数留档

适配器的协议校验之外，引擎根据用户配置、交易阶段和前一步已确认实收数量建立预期意图，再核对报价的类型、源链与目标链、代币地址、精度、准确输入原始数量、最低到账及有效期。实盘还核对发送方与收款钱包。初始三步计划在买入前检查，后续报价按实际回执数量重新检查；未知费用、不支持的交易结构和不一致的意图不能用模型判断放行。

新交易保存不可变的 `policySnapshot` 与 SHA-256 `policyFingerprint`，覆盖资产、风控、确认、白名单和估值依据，排除 RPC、API 凭据与钱包秘密。报价和状态事件关联相同指纹；执行期间相关配置变化会被拒绝。旧记录缺失字段保持缺失。该机制用于识别执行依据和参数版本，不构成独立安全审计认证。

本地复盘模块只读取归档交易、保存每日统计及固定检查提示。脱敏导出使用字段白名单，不携带原始报价、外部描述、用户笔记、地址、哈希或凭据；没有模型能通过报告接口修改交易策略或取得签名能力。本版未增加外部预测模型、按置信度配置仓位或夜间自动发布策略的流程。实际边界及后续开发约束见 [SAFE-DEVELOPMENT.md](SAFE-DEVELOPMENT.md)。

## 插件钱包签名路径

“设置与钱包”提供 BNB MetaMask / OKX Wallet、Solana Phantom / OKX Wallet 连接。公开账户与插件类型保存在本机元数据中；插件私钥不经过页面接口或服务端。连接会话由当前网页心跳维护，重载后重新连接。插件模式仍执行相同的池、ABI、授权、费用、储备与回执检查。

- BNB 使用插件 `eth_sendTransaction` 广播。请求交给插件前已保存提交意图，插件返回哈希后立即归档，再核验 RPC 上的发送方、目标、calldata、原生币金额与费用边界；本机服务不对这笔交易二次广播。
- Solana 使用插件 `signTransaction`，服务端核验签名者与 Ed25519 签名、完整序列化消息和原报价一致，重新读取余额并执行现有模拟检查，记录确定哈希后仅广播一次。
- 每个请求只分发一次；传输失败可重传结果，不能重新调用插件发送交易。取消、超时、账户切换或结果不一致会停止后续步骤。较晚返回的 EVM 广播哈希仍追加到档案并要求核对；过期的 Solana 签名丢弃且不由服务端广播。人工核对前先取消插件残留的确认弹窗。

插件需要逐笔人工确认，保持网页打开；无需人在场的自动执行使用本机加密私钥模式。连接插件不替代 OKX API 凭据与其他实盘配置。模拟模式保持模拟行情、余额和回执，不向插件请求交易签名。原本机钱包配置可通过“恢复本机钱包”切回，私钥加密与解锁规则不变。

## 使用前核对

`nativeUsd` 是用户设置的原生币美元参考估值，不是实时汇率。稳定币可用金额按面值 1U 显示。未知价格冲击、缺失 Gas、过期报价、API 返回无法解析的 payload 和不支持的桥均阻止执行。对于不同桥、不同 DEX 的完整指令语义，本项目没有声称经过外部审计。必须使用可信 RPC、官方 API 和已核对的程序/合约白名单。现有测试使用固定回执、模拟网络及插件接口替身；未在用户安装的真实钱包插件或真实资金上验收，也未导入用户私钥或发送真钱交易。

买入、链上确认和跨链到账之间存在时间与单边敞口。利润门槛、最小到账和停机阈值不能保证最终盈利或实际损失绝不越线。每日复盘也只覆盖本工具记录；外部钱包手动授权等支出需要单独核对。

## 核验来源（2026-11-16）

- [OKX v6 同链 Swap](https://web3.okx.com/onchainos/dev-docs/trade/dex-swap)、[报价字段](https://web3.okx.com/onchainos/dev-docs/trade/dex-get-quote)、[授权字段](https://web3.okx.com/onchainos/dev-docs/trade/dex-approve-transaction)、[官方路由地址与 ABI](https://web3.okx.com/onchainos/dev-docs/trade/dex-smart-contract)。
- [OKX 官方 v6 跨链 HTTP 实现](https://github.com/okx/onchainos-skills/blob/main/cli/src/commands/cross_chain.rs)、[响应字段](https://github.com/okx/onchainos-skills/blob/main/skills/okx-agentic-wallet/references/bridge-cli-reference.md)，核验提交 `30cc6915d7dacc06d497ecafb51a4fc7c1ebd251`。当前实现使用 `/api/v6/dex/cross-chain/{quote,swap,approve-tx,status}`，不是旧 v5 `build-tx`。跨链滑点为比例 `0.005=0.5%`，同链 `slippagePercent=0.5`。Solana tx.data 为 base58。状态参数为 `hash,chainIndex,bridgeId`；只有 `SUCCESS` 后读取目标 `toTxHash,toChainIndex,toTokenAddress,toAmount`，仍必须链上复核。
- [OKX Router 官方 ABI](https://github.com/okxlabs/DEX-Router-EVM-V1/blob/main/DexRouterabi/DexRouter.json)，核验提交 `6b1ade747e025eff8235260813097a8ae4af6424`。
- [deBridge 官方 Source](https://github.com/debridge-finance/dln-contracts/blob/main/contracts/DLN/DlnSource.sol)、[OrderCreation 结构](https://github.com/debridge-finance/dln-contracts/blob/main/contracts/libraries/DlnOrderLib.sol)、[接口](https://github.com/debridge-finance/dln-contracts/blob/main/contracts/interfaces/IDlnSource.sol)、[部署地址](https://github.com/debridge-finance/dln-contracts)，核验提交 `d54e94f2b5102bff89a4df506404bb77f3edc148`。Source 地址为 `0xeF4fB24aD0916217251F553c0596F8Edc630EB66`。DLN Solana 链 ID 从官方测试 `test/DLN_Pipeline.test.ts` 交叉核验。
