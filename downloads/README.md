# KNTQ/HYPE LP 工具下载

版本 0.2.0，2026-11-10。

[直接下载工具包](https://github.com/WZL1688/Daniel-onekey-install/raw/refs/heads/codex/kntq-hype-lp-v0.2.0/downloads/kntq-hype-lp-v0.2.0.zip)

如果浏览器显示 ZIP 文件页面，点击 Download raw file。源码在本分支的 `kntq-hype-lp/`，此工具在你的电脑本地运行。

## Windows 启动

1. 下载 ZIP，右键“全部提取”。
2. 打开包含 package.json 的文件夹，在资源管理器地址栏输入 cmd，回车。
3. 依次运行：

```bat
npm ci
npm run dev
```

保持命令窗口打开，使用安装了 MetaMask/Rabby 的本机浏览器访问 http://127.0.0.1:5173 。Node.js 24.x 可直接使用。无需输入私钥或助记词。

## 核对文件

SHA-256：`4e12ee5fafb8a099d03e00258fb14dd406dae73d15da47a02a186a081e34fb57`

Windows 命令提示符中可执行：

```bat
certutil -hashfile "%USERPROFILE%\Downloads\kntq-hype-lp-v0.2.0.zip" SHA256
```

也可核对同目录 SHA256SUMS。校验值用于确认文件一致性，不等同于安全审计。

## 验证边界

133 项单元测试、44 项模拟钱包/RPC浏览器检查和生产构建已通过。未广播真实主网交易；云端 RPC 受 CONNECT 403 限制，真实主网快照和有资金钱包路径未验证，不保证无漏洞或任何年化。使用前阅读源码 docs/SAFETY_REVIEW_2026-11-10.md。交易保持预览、签名前模拟、精确授权、固定滑点与单次提交，不自动重发。
