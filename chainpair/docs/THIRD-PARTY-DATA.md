# 官方资产映射数据来源

`src/opportunities/data/wormhole-candidates.json` 是从 Wormhole Project Contributors 的官方仓库数据提取的 32 组 BNB/Solana 对应地址，仅用于候选发现。

- 仓库：[wormhole-foundation/wormhole-connect](https://github.com/wormhole-foundation/wormhole-connect)。
- 固定提交：`267c9a649c74097cdbf5096d1d37cb45e7695a5b`，日期 2026-04-08。
- 原始地址映射：`src/config/mainnet/wrappedTokens.ts`；名称辅助数据：`src/config/mainnet/tokens.ts`。
- 原文件版权声明见 [WORMHOLE-DATA-LICENSE.txt](WORMHOLE-DATA-LICENSE.txt)，许可证全文见 [APACHE-2.0.txt](APACHE-2.0.txt)。

数据提取按原始链和原始合约关联两条链的表示，没有按名称或符号配对。源文件由受限数据解析器处理，不执行远程 TypeScript。提取时增加了来源、日期和候选标识，未修改原始地址。没有使用原始链的精度推测目标链精度。

这些是带日期的包装资产映射快照，不是实时价格、余额、可卖出证明、可赎回保证或安全认证。程序仍需读取实际交易池；任何条目都不会因来源官方而自动批准交易。

CoinGecko 目录使用官方 coin ID 与平台地址关联，仅作为候选元数据。页面提供固定官方来源链接；需要账户权限时可配置自己的 CoinGecko Demo Key，费用和额度以账户规则为准。


## v1.6 新增候选来源

[CoinPaprika官方合约接口](https://docs.coinpaprika.com/api-reference/contracts/get-all-contract-addressess-for-a-given-platform)记录每个平台的合约地址与统一coin ID。运行时分别读取 https://api.coinpaprika.com/v1/contracts/bnb-binance-coin 和 https://api.coinpaprika.com/v1/contracts/sol-solana ，严格按ID合并并隔离歧义，不使用名称／符号相似度。API数据仅保存在使用者本机缓存，发布包不包含远程CoinPaprika目录；账户、使用条件、限额及收费以提供方规则为准。

[BabyDoge发行方透明度页](https://babydoge.com/transparency/)与[产品页](https://babydoge.com/products/)公布了BNB地址0xc748673057861a797275CD8A068AbB95A902e8de及Solana地址7dUKUopcNWW6CcU4eRxCHh1uiMh32zDrmGf6ufqhxann。本包仅记录截至2026-11-22核对的地址事实及出处，未拷贝网站文章，不带价格、税率、安全或交易批准。项目是否迁移合约、单位关系、限制及税费仍需交易前重新核实。

新增资产分类只是过滤；同一目录ID及官方地址也不是永久等价或安全认证。旧Wormhole公开数据继续按前述Apache许可保存。
