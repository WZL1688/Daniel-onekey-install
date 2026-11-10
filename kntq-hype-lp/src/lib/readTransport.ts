import { createPublicClient, custom } from 'viem';
import type { Chain, PublicClient, Transport } from 'viem';
import type { RpcHealth, Settings } from './types';

const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBalance', 'eth_getCode', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getLogs']);
export type SafeReadClient<C extends Chain = Chain> = PublicClient<Transport, C> & { rpcUrl: () => string };
type RpcArgs = { method: string; params?: unknown };
class RpcResponseError extends Error {
  constructor(message: string, public code: number, public data?: unknown) { super(message); }
}
export function validateRpcUrls(input: string[]): string[] {
  const urls = [...new Set(input.map((url) => url.trim()).filter(Boolean))];
  if (!urls.length || urls.length > 8) throw new Error('请配置 1–8 个 RPC 地址');
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash) throw new Error('RPC 地址不能含用户密码或片段');
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('远程 RPC 必须使用 HTTPS；本机节点允许 HTTP');
  }
  return urls;
}

/** Transport accepts reads only; no wallet method can enter endpoint failover. */
export function createSafeReadClient<C extends Chain>(settings: Settings, chain: C, onHealth?: (health: RpcHealth) => void): SafeReadClient<C> {
  const urls = validateRpcUrls(settings.rpcUrls);
  const verified = new Map<string, Promise<void>>();
  let active = 0;
  let requestId = 0;
  async function raw(url: string, args: RpcArgs): Promise<unknown> {
    const id = ++requestId;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, ...args }), signal: AbortSignal.timeout(12_000), credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json() as { jsonrpc?: string; id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    if (!result || result.jsonrpc !== '2.0' || result.id !== id) throw new Error('无效的 JSON-RPC 响应或请求 ID');
    if (result.error) throw new RpcResponseError(String(result.error.message), Number(result.error.code), result.error.data);
    if (!('result' in result)) throw new Error('JSON-RPC 缺少 result');
    return result.result;
  }
  async function verify(url: string) {
    let pending = verified.get(url);
    if (!pending) {
      pending = raw(url, { method: 'eth_chainId', params: [] }).catch((error) => {
        throw new Error(`RPC 链 ID 校验失败：${error instanceof Error ? error.message : String(error)}`);
      }).then((id) => {
        if (typeof id !== 'string' || !/^0x[0-9a-f]+$/i.test(id) || Number(BigInt(id)) !== chain.id) throw new Error(`RPC 链 ID 不匹配，预期 ${chain.name} ${chain.id}`);
      });
      verified.set(url, pending);
      void pending.catch(() => verified.delete(url));
    }
    await pending;
  }
  const provider = { async request(args: RpcArgs) {
    if (!READ_METHODS.has(args.method)) throw new Error(`只读 RPC 禁止方法 ${args.method}`);
    const first = active;
    const errors: string[] = [];
    for (let offset = 0; offset < urls.length; offset++) {
      const index = (first + offset) % urls.length;
      const url = urls[index];
      const started = Date.now();
      try {
        await verify(url);
        const value = args.method === 'eth_chainId' ? `0x${chain.id.toString(16)}` : await raw(url, args);
        active = index;
        onHealth?.({ url, ok: true, latencyMs: Date.now() - started });
        return value;
      } catch (error) {
        const description = error instanceof Error ? error.message : String(error);
        onHealth?.({ url, ok: false, latencyMs: Date.now() - started, error: description });
        // A simulation revert is final. Switching providers must not convert it to a pass.
        if (error instanceof RpcResponseError && (error.code === 3 || /revert|execution failed|insufficient funds|out of gas|invalid opcode|intrinsic gas|gas required exceeds/i.test(description))) throw error;
        errors.push(`${new URL(url).hostname}: ${description}`);
      }
    }
    throw new Error(`全部 RPC 不可用：${errors.join('；')}`);
  } };
  return Object.assign(createPublicClient({ chain, transport: custom(provider, { retryCount: 0 }) }), { rpcUrl: () => urls[active] }) as SafeReadClient<C>;
}
