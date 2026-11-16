import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from './store.mjs';
import { Vault } from './vault.mjs';
import { Engine } from './engine.mjs';
import { startLocalServer } from './server.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) throw new Error('请安装 Node.js 24 LTS 或更新版本');
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DUALARB_DATA_DIR || path.join(projectDir, 'data'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(dataDir);
const vault = new Vault(dataDir);
const engine = new Engine({ store, vault });
await engine.init();
const { server, url } = await startLocalServer({ engine, store, vault });
console.log(`\n双链套利工作台已启动\n本机地址：${url}\n数据目录：${dataDir}\n模式：${engine.config.mode === 'demo' ? '演示（不会广播链上交易）' : '实盘（保险库需重新解锁）'}\n按 Ctrl+C 退出。\n`);
let closing = false;
async function shutdown() {
  if (closing) return; closing = true; engine.stop();
  console.log('停止接收新请求。正在关闭本机服务；在途交易下次启动必须人工核对。');
  server.close(); server.closeIdleConnections?.();
  // A forced shutdown never retries a persisted intent when the process restarts.
  setTimeout(() => { try { vault.lock(); store.close(); } finally { process.exit(0); } }, 1000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('unhandledRejection', () => { engine.pause('后台任务发生异常，请查看本机档案'); console.error('后台任务失败，已暂停新交易。'); });
