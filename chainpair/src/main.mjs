import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from './store.mjs';
import { Vault } from './vault.mjs';
import { Engine } from './engine.mjs';
import { startLocalServer } from './server.mjs';
import { openBrowser } from './browser.mjs';
import { BrowserWalletBridge } from './browser-wallets.mjs';
import { ReviewService } from './review.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) throw new Error('请安装 Node.js 24 LTS 或更新版本');
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DUALARB_DATA_DIR || path.join(projectDir, 'data'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(dataDir);
const browserWallets = new BrowserWalletBridge({ store });
const vault = new Vault(dataDir, { browserWallets });
const engine = new Engine({ store, vault, browserWallets });
browserWallets.onUncertain = ({ tradeId, hash, requestId, reason }) => {
  engine.running = false; engine.pausedReason = reason;
  const trade = tradeId ? store.getTrade(tradeId) : null;
  if (trade) engine.event(trade, 'NEEDS_REVIEW', { failureReason: reason, browserLateResult: { hash, requestId } });
};
await engine.init();
const reviewService = new ReviewService({ store, getConfig: () => engine.config }).start();
const { server, url } = await startLocalServer({ engine, store, vault, browserWallets, reviewService });
console.log(`\n双链套利工作台已启动\n本机地址：${url}\n数据目录：${dataDir}\n模式：${engine.config.mode === 'demo' ? '演示（不会广播链上交易）' : '实盘（本机保险库需解锁；插件钱包需连接）'}\n按 Ctrl+C 退出。\n`);
console.log('浏览器地址必须包含端口号；请使用上面显示的完整本机地址。');
if (process.argv.includes('--open') && !process.argv.includes('--no-open')) {
  const requested = await openBrowser(url);
  console.log(requested ? `已请求默认浏览器打开：${url}/` : `无法自动打开浏览器，请手动打开：${url}/`);
}
let closing = false;
async function shutdown() {
  if (closing) return; closing = true; engine.stop(); browserWallets.close(); reviewService.stop();
  console.log('停止接收新请求。正在关闭本机服务；在途交易下次启动必须人工核对。');
  server.close(); server.closeIdleConnections?.();
  // A forced shutdown never retries a persisted intent when the process restarts.
  setTimeout(() => { try { vault.lock(); store.close(); } finally { process.exit(0); } }, 1000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('unhandledRejection', () => { engine.pause('后台任务发生异常，请查看本机档案'); console.error('后台任务失败，已暂停新交易。'); });
