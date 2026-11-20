# 官方资产映射数据来源

`src/opportunities/data/wormhole-candidates.json` 是从 Wormhole Project Contributors 的官方仓库数据提取的 32 组 BNB/Solana 对应地址，仅用于候选发现。

- 仓库：[wormhole-foundation/wormhole-connect](https://github.com/wormhole-foundation/wormhole-connect)。
- 固定提交：`267c9a649c74097cdbf5096d1d37cb45e7695a5b`，日期 2026-04-08。
- 原始地址映射：`src/config/mainnet/wrappedTokens.ts`；名称辅助数据：`src/config/mainnet/tokens.ts`。
- 原文件版权声明见 [WORMHOLE-DATA-LICENSE.txt](WORMHOLE-DATA-LICENSE.txt)，许可证全文见 [APACHE-2.0.txt](APACHE-2.0.txt)。

数据提取按原始链和原始合约关联两条链的表示，没有按名称或符号配对。源文件由受限数据解析器处理，不执行远程 TypeScript。提取时增加了来源、日期和候选标识，未修改原始地址。没有使用原始链的精度推测目标链精度。

这些是带日期的包装资产映射快照，不是实时价格、余额、可卖出证明、可赎回保证或安全认证。程序仍需读取实际交易池；任何条目都不会因来源官方而自动批准交易。

CoinGecko 目录使用官方 coin ID 与平台地址关联，仅作为候选元数据。页面提供固定官方来源链接；需要账户权限时可配置自己的 CoinGecko Demo Key，费用和额度以账户规则为准。
