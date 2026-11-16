# ChainPair 本机双链套利工作台

[点击下载完整项目 ZIP](downloads/ChainPair-local.zip?raw=true)

解压后进入 `ChainPair` 文件夹，安装 Node.js 24 或更新版本，运行 `npm ci`、`npm start`，或者使用 `start.cmd` / `start.sh`。启动后会请求默认浏览器自动打开实际分配的完整地址。

**地址必须带端口**，例如 `http://127.0.0.1:50240/`；具体端口以启动窗口为准。仅打开 `http://127.0.0.1/` 会访问默认端口，无法连接到其他端口上的本程序。运行期间保留命令窗口。无需自动打开浏览器时运行 `npm run start:server`。

源码目录：[chainpair](chainpair/README.md)。默认演示模式。52项自动测试及浏览器验收通过，没有使用真实资金验证；实盘受已支持ABI、API权限、白名单和链上路线限制。BNB跨出支持deBridge DLN直接路线，其他不支持路线会在买入前被阻止。请阅读[使用说明](chainpair/docs/USER-GUIDE.md)与[实盘适配范围](chainpair/docs/LIVE-ADAPTER.md)。

压缩包不含私钥、OKX凭据、运行数据、数据库或依赖目录。SHA256: `51412e3dbf3b031d2491d4585cd3d43a01956fb1367549fc399a4aa409a7851e`。
