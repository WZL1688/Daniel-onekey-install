# Elysium 后续接入调查

初始调查日期：2026-11-09（Asia/Shanghai）；更新：2026-11-10。下方保留初始调查时的事实与缺口。用户随后已授权接入，当前版本同时支持两个独立网络；最新结论如下。

## 2026-11-10 更新：已接入，官方来源缺口已补齐

固定 [Uniswap/contracts 官方部署记录](https://github.com/Uniswap/contracts/blob/3b872969fff4f5d807db916564f79843d722af36/deployments/json/99901.json)已列出 Elysium，确认本项目 PoolManager、PositionManager、StateView、Permit2 与 WHYPE 地址。PosM 构造参数中的通知 Gas 为 2,000,000，descriptor 为 `0x9f92c5297eb3b39e6804b5e03899bc66b6b77348`。官方部署输入离线重建四个完整 runtime，生产身份门使用完整指纹，没有通用 npm 产物替代放行。详细来源、编译参数、源代码语义和限制见 `SAFETY_REVIEW_2026-11-10.md`。

已独立实现 v4 读取、预算建仓、精确授权、领费和撤仓；当前进度与测试以 `PROGRESS.md`、`VERIFICATION.md` 为准。默认 RPC 为 `https://rpc.elysium.kinetiq.xyz`，浏览器为 `https://elysium.kinetiq.xyz/explorer`。本云环境重试 RPC 仍为 CONNECT 403，当前主网字节码、池状态和有资金交易未验证。下面“未列出 Elysium”等表述仅描述 11 月 9 日取得的资料，不覆盖此更新。

## 用户提供的目标

- Elysium KNTQ：`0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0`。
- Elysium WHYPE：`0xbA876237B0F021A6c6D852d6c26E107997cC5E81`。
- 目标池 ID：`0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac`。
- 用户提供的浏览器：<https://elysiumexplore.com>。

## 已获取的资料证据

[浏览器 API 文档](https://elysiumexplore.com/api-docs)给出 Elysium 主网 chain ID `99901`、原生 HYPE（18 位）、RPC `https://node.eleos.fun`。它还记录了读取接口限制：每批最多 50 项，`eth_getLogs` 最多 10,000 个区块，每 IP 每分钟 1,200 次请求。这里的资料来自浏览器运营者，尚未完成直接 RPC 探测；不能据此声称当前可用。

[KNTQ 池列表](https://elysiumexplore.com/token/0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0?tab=pools)标注该 KNTQ 为来自 HyperEVM 的桥接代币，并把目标池列为原生 HYPE / KNTQ、v4、1% 费率。WHYPE 的[代币页](https://elysiumexplore.com/token/0xba876237b0f021a6c6d852d6c26e107997cc5e81)对应用户提供的 WHYPE 地址。

目标不是 v3 的 20 字节池合约地址，而是 v4 的 32 字节 PoolId。以下 PoolKey 通过本地 viem 的 `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))` 计算，结果与用户提供的完整 PoolId 一致：

```text
currency0: 0x0000000000000000000000000000000000000000  # 原生 HYPE
currency1: 0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0  # 桥接 KNTQ
fee:       10000                                      # 1%
tickSpacing: 200
hooks:     0x0000000000000000000000000000000000000000
```

此哈希校验确认参数与 ID 的对应关系，不能证明指定 PoolManager 中该池已初始化、仍有流动性，或其状态可信。[Volta 集成文档](https://www.volta.family/docs)也记载了同一 KNTQ 路由的 1% / spacing 200 / 无 hook 参数。

## 部署候选，尚未通过 RPC 核验

[ElysPump 项目文档](https://docs.elyspump.com/?real=1)提供以下 Elysium v4 地址；浏览器 PoolManager 的[合约页](https://elysiumexplore.com/address/0xe2e105d3f7209a9da11f83ccf3e7398a753823f1?tab=contract)标注其运行代码与一个已验证合约一致。

| 合约 | 候选地址 |
| --- | --- |
| PoolManager | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` |
| v4 NFT PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` |
| StateView | `0x27ed73ae0652fdcf71d6793412a7525f32be9dfe` |
| V4Quoter | `0x379f556c5a748bd7cc9baf0f7a344094ac1814f5` |
| UniversalRouter | `0x1b341fdd55d56f8e08409a2c25ddfad93eb03c1a` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` |

ElysPump 和 Volta 称该 PoolManager 为官方部署；截至此次调查，[Uniswap 官方统一部署资料](https://developers.uniswap.org/deployments.json)未列出 Elysium。项目方表述、浏览器标签和相同运行代码不足以单独证明官方部署身份，应保留此核验缺口。不要使用同一文档中其他旧 PoolManager / PositionManager 的地址作为上述部署的替代。

备用 RPC 候选 `https://rpc.volta.family` 来自 Volta 项目文档。它声称通过 HyperEVM Inbox 提交交易；这不应直接加入现有 HyperEVM 读取或签名流程，也未验证其 RPC 方法覆盖与状态一致性。

## 后续启用前必须解决的缺口

1. 直接读取 `eth_chainId`、最新区块时间、合约字节码，验证 KNTQ / WHYPE 的 `symbol`、`decimals` 及桥接对应关系。
2. 核对 PositionManager、StateView、Quoter 的 PoolManager 关联；读取初始化事件和目标池当前状态，与上述 PoolKey 对照。
3. 核实部署来源、所有权及文档是否因 11 月 9 日主网开放而发生变化。检索到的浏览器缓存页存在软启动提示和落后的索引高度，不能当作当前链状态。
4. 独立实现 v4 NFT 枚举、feeGrowth 读取、Permit2、有期限的 action 编码、原生 HYPE 结算和原子撤仓。现有 v3 NFPM ABI 与交易编码不能复用到 v4。
5. 在受控钱包中验证预览、每步签名前模拟、账户/链变化中止、一次提交及 receipt 核对。继续保留不自动放宽滑点、不自动重发约束。

本次未执行 Elysium RPC 端到端或钱包交易；云环境直接访问浏览器 JSON 接口返回 HTTP 403。没有发送任何交易，没有修改当前 HyperEVM 功能。
