# 0.2.0 安全复核与验证边界

日期：2026-11-10（Asia/Shanghai）。范围：本项目双网络源码、交易编码、钱包交互、RPC、持仓指标、依赖锁文件与受控测试。保留 HyperEVM 官方 v3，独立加入 Elysium v4。社区工具固定版本的旧审查另见 `EXTERNAL_V4_REVIEW_2026-11-09.md`，没有直接合并其交易执行器。

本记录是开发与代码复核结果，不是第三方专业审计或无漏洞保证。全部浏览器交易均为模拟；当前主网代码、余额、池状态及有资金钱包路径没有完成实测。

## 1. 地址、协议与官方部署来源

Elysium chain ID 为 `99901`，原生币 HYPE。使用以下固定配置，不接收社区页面动态下发地址：

| 项目 | 固定值 |
| --- | --- |
| KNTQ | `0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0` |
| PoolManager | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` |
| PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` |
| StateView | `0x27ed73ae0652fdcf71d6793412a7525f32be9dfe` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |
| WHYPE（核对 PosM 关联用） | `0xba876237b0f021a6c6d852d6c26e107997cc5e81` |
| PoolId | `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac` |
| PoolKey | currency0 原生 HYPE / address(0)，currency1 KNTQ，fee 10000，spacing 200，hooks address(0) |

PoolId 通过完整 PoolKey 的 ABI 编码与 Keccak-256 重算；目标为原生 HYPE 池，不能以 WHYPE 替代 currency0。

11 月 10 日核对 [Uniswap/contracts 官方部署记录](https://github.com/Uniswap/contracts/blob/3b872969fff4f5d807db916564f79843d722af36/deployments/json/99901.json)，关键合约地址与配置一致。记录保存在 `src/elysium/deployment-source.json`。PositionManager 构造参数明确包含上述 PoolManager、Permit2、WHYPE，通知 Gas `2000000`，descriptor `0x9f92c5297eb3b39e6804b5e03899bc66b6b77348`。这补齐了 11 月 9 日调查中的官方来源缺口，不代表已经读取真实链状态。

## 2. 完整运行时代码指纹

生产 `assertRuntimeIdentity` 对四个角色分别检查完整字节码长度和完整 Keccak-256，不能从 RPC、localStorage、用户勾选或调用参数加入白名单。任一不符会禁用交易，执行前再次读取校验。没有通用 npm masked runtime、fixture 或确认开关作为放行备选。

| 合约 | runtime 字节数 | 完整 Keccak-256 |
| --- | ---: | --- |
| PoolManager | 24009 | `0xbb5fb2091cfd38e71f56d14a2b6b5e71a22ac2b8e5881faa422ccf92b40df7a1` |
| PositionManager | 19965 | `0xad189c3ce2621a5f4953f3f3c08bc25f6bfb514b5b8b2ec427d23902342c94e7` |
| StateView | 3531 | `0x213962cb8e24945a420ab6e609f9fee79a539472c952f12b8bfcbbbead5e8eba` |
| Permit2 | 9152 | `0xecc8810a534829aab9326a3f868a21ed05f1c62b57dcc82429c8a78b3a27cfdc` |

指纹来自离线构造函数执行，不是从本次 RPC 读取的代码。复核方法如下，可据固定来源独立重现：

1. 从同一官方提交的 [broadcast 输入](https://github.com/Uniswap/contracts/blob/3b872969fff4f5d807db916564f79843d722af36/broadcast/Deploy-all.s.sol/99901/run-latest.json)及 `src/briefcase/deployers/` 读取 PoolManager、PositionManager、StateView、Permit2 的完整 creation code；路径和构造参数记录于 `code-identities.json`。
2. 对前三个合约去掉 CREATE2 工厂输入的 32 字节 salt，逐字节验证其等于官方 helper 的 creation code 加 ABI 构造参数。再使用工厂 `0x4e59b44847b379578588920cA78FbF26c0B4956C`、该 salt 与完整 creation code 重算目标地址，三者均一致。
3. 在无 RPC 的 `@ethereumjs/evm@10.1.3` 中，以 chain ID 99901、Cancun、实际合约地址、实际构造参数、value 0、gasLimit 100000000 执行构造函数，取返回的 runtime 计算完整指纹。Permit2 使用固定标准地址并计算该链的 EIP-712 缓存值。将结果与 `tests/fixtures/v4-runtime.json` 和 manifest 比较。
4. PositionManager 指纹另与固定 [Titan 集成记录](https://github.com/titan-ecosystem/Titan-Locker-Contracts/blob/d0cff66d69085c846585993a6b5b3c7095d28e5d/deployments/elysium-mainnet.release.json)一致；该记录仅为旁证，不能替代生产完整代码校验。

编译参数：PoolManager / StateView 为 solc 0.8.26、viaIR、Cancun、optimizer 44444444；PositionManager 为 solc 0.8.26、viaIR、Cancun、optimizer **500**；Permit2 为 solc 0.8.17、viaIR、London、optimizer 1000000。通用 npm PosM 产物采用不同优化参数，字节码长度不同，因此不能将其作为固定部署的替代。不能仅由大小差异断言源码版本不同。

官方 JSON 字段 `initcodeHash` 与本次完整 creation code 的 Keccak 不同；它单独保存在 manifest 的 `recordedInitcodeIdentifier`，没有误当作 runtime 指纹。manifest 的 `creationCodeHash` / `initcodeHash` 是本地计算的完整 creation code 哈希，包含构造参数、排除工厂 salt。

## 3. 交易金额、授权与到账语义

- 金额使用 bigint / SDK，严格限定十进制、uint 上限及正数；mint 的整数舍入和滑点上限必须同时落在用户的两币预算内。必要时降低流动性，不增加预算。HYPE 另外覆盖 gas 和最低预留。
- KNTQ → Permit2 与 Permit2 → PosM 两层精确授权；必要时清零旧额度，包括旧无限授权。Permit2 到期不晚于五分钟计划期限，无 0.1% 授权缓冲，无自动提高滑点。
- mint 为固定池的 MINT_POSITION + SETTLE_PAIR，并 SWEEP 原生币余款至冻结账户；不自动初始化其他 v4 池，不做隐式 swap。
- 领费为 DECREASE_LIQUIDITY(0) + TAKE_PAIR，本金 minimum 必须为零。撤仓为 BURN_POSITION + TAKE_PAIR，minimum 保护本金，费用另行结算，原子取回后销毁 NFT。

领费/撤仓语义已对照固定 [PositionManager 源码](https://github.com/Uniswap/v4-periphery/blob/3245c3cb99c48fa1dc2459c3b60abc37d4294aba/src/PositionManager.sol#L337-L350)：`_decrease` 与 `_burn` 使用 `(liquidityDelta - feesAccrued).validateMinOut(...)`。该 pin 是官方 contracts [optimizer 500 重新生成提交](https://github.com/Uniswap/contracts/commit/e59f73023f073461c0127cfcc56901a878331017)的 periphery gitlink；其中 helper creation code 与 Elysium 使用的 21339 字节 creation code 完全相同，部署提交所链接后续 pin 的 PosM 源文件也逐字节相同。没有用当前 main 的语义替代部署依据。预览明确不承诺领费最低数量，也不以失败后降低滑点解决编码错误。

## 4. 签名、停止、并发与恢复

v4 计划在私有 registry 中冻结账户、chain/profile、收款人、预算、期限、滑点、calldata、部署指纹与 RPC 设置。切账户、切链、切配置或关闭失效上下文即停止；连接钱包不代表签名授权。

v4 每一步重新读取账户和链、代码身份、NFT 归属及完整池；v3 每一步重新读取账户与链并检查计划、新池初始化前提。两者均在 `eth_call` 与 gas 估算成功后才请求钱包发送一次。最后异步钱包检查返回后，再检查停止标志和计划期限，避免等待期间停止/过期后仍弹出授权签名。receipt.status 必须成功，并核对已确认交易 hash/from/to/input/value（v4 另含 nonce）后才进入下一步。已成功的前置授权或包装不会因后续失败回滚。

v4 执行与公共恢复共用按账户的同源 **Web Lock**，不支持该 API 的浏览器禁止发送。实际双页面检查验证互斥。广播前持久化 nonce、to/data/value；返回哈希立即落盘。未知发送结果或超时保留 pending 锁、消费旧计划，拒绝新计划。慢恢复查询不能删除另一个新交易的记录。

恢复只读，不发送、不提高滑点、不重试：原交易必须内容一致且已有确定回执；如果钱包执行取消/替换，须手动提供真实哈希，验证同账户、同 nonce、确定回执和 latest 已确认 nonce 推进，才允许重新预览，不继续原步骤。没有复选框或超时自动清锁；清站点数据不是恢复办法。Web Locks 和 localStorage 的保护范围是同一浏览器 origin，不能协调另一个浏览器、不同端口/站点或其他 DApp 发起的交易，操作时仍需核对钱包 nonce 与活动。

## 5. RPC、持仓与收益数据

v4 的只读 RPC transport 校验 URL 和每个 endpoint 的链 ID，仅允许读取方法；禁止带凭据/fragment 的 URL 和非 HTTPS（loopback 除外），禁跟随重定向。网络故障可切换读取；确定性合约 revert 不换节点寻找成功结果。普通公共 RPC 无法证明诚实，代码身份检查仍依赖所返回状态。

v4 快照固定区块并核对最终 hash，使用链上块时间检测过期。NFT 从近期 ID、已跟踪 ID 和分段 Transfer 日志找回，按顺序重放，最后以 ownerOf 和总余额核对完整性。手动 TokenId 同样校验 owner 和包含 hooks 的完整 PoolKey。扫描不足明确提示，费用读取失败不显示为零。

年化比较原始代币手续费增量，至少 300 秒稳定流动性样本；领取、流动性变化或费用下降后重置。已有手续费的美元升值不算新增收入。秒级值是估算，过期时暂停；本金为当前流动性数量，不冒充成本或 PnL。没有验证帖子中的 1000% 年化。

## 6. 本地运行与验证结果

开发和 preview 仅监听 `127.0.0.1`。无远程脚本/CDN 字体、无私钥或助记词输入，无服务端托管钱包。依赖使用锁文件；本次未改变依赖树。此前依赖审计 8 low、0 moderate/high/critical 属于历史结果，不将社区仓库的 0 漏洞结果混入本项目。低级 SDK 传递依赖仍需后续维护。

当前构建与测试结果见 `VERIFICATION.md`：133 项单元、44 项受控浏览器检查（v3 17 + v4 27）。受控浏览器数据有 TEST FIXTURE 标记，代码 fixture 为官方输入离线推导；不绕过生产身份门，不连接真实钱包，主网写入 0。测试覆盖正向流程、拒签、回滚、未知状态、账户/链变化、过期、跨标签页争用、预算及代码篡改等边界。

## 7. 剩余限制

11 月 10 日本云环境请求真实 RPC 仍返回代理 CONNECT 403；没有取得 live runtime、当前初始化状态、池流动性、手续费、余额或实时行情。部署来源和离线重建已经核对，实际代码仍由运行时门逐次比较；真实响应不符将禁签。有资金钱包授权/建仓/领取/撤仓尚未验证。

依赖、代币桥与链的治理/升级、RPC 欺骗、钱包扩展、浏览器环境及行情来源都在实际资金风险范围内，现有检查不能消除这些风险。后续应在可达网络核对真实链只读数据，再由用户钱包逐步验证资金路径；不得将本报告或 fixture 通过当作保证收益或可省略签名预览的理由。
