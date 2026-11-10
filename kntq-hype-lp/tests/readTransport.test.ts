import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSafeReadClient, validateRpcUrls } from '../src/lib/readTransport';
import { elysium } from '../src/elysium/config';
import { DEFAULT_SETTINGS } from '../src/lib/config';
afterEach(() => vi.unstubAllGlobals());
const settings = { ...DEFAULT_SETTINGS, rpcUrls: ['https://first.example', 'https://second.example'] };
function reply(req: { id: number }, result: unknown) { return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200 }); }
describe('profile read transport boundary', () => {
  it('rejects writes before reaching any endpoint', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const client = createSafeReadClient(settings, elysium);
    await expect(client.request({ method: 'eth_sendTransaction' as never })).rejects.toThrow('只读 RPC 禁止');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates chain per endpoint and reports the actual serving URL', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string);
      return reply(req, req.method === 'eth_chainId' ? (url.includes('first') ? '0x3e7' : '0x1863d') : '0x2a');
    }); vi.stubGlobal('fetch', fetcher);
    const client = createSafeReadClient(settings, elysium);
    expect(await client.getBlockNumber()).toBe(42n);
    expect(client.rpcUrl()).toBe(settings.rpcUrls[1]);
    expect(fetcher.mock.calls.filter(([url,init]) => String(url).includes('first') && JSON.parse(String(init.body)).method !== 'eth_chainId')).toHaveLength(0);
  });
  it('never retries a contract revert on the next provider', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string);
      return req.method === 'eth_chainId' ? reply(req, '0x1863d') : new Response(JSON.stringify({ jsonrpc:'2.0',id:req.id,error:{code:3,message:'execution reverted',data:'0x'} }));
    }); vi.stubGlobal('fetch',fetcher);
    const client=createSafeReadClient(settings,elysium);
    await expect(client.call({to:'0x0000000000000000000000000000000000000001'})).rejects.toThrow();
    expect(fetcher.mock.calls.every(([url])=>url===settings.rpcUrls[0])).toBe(true);
  });
  it('stops a deterministic insufficient-funds simulation without seeking a passing node', async () => {
    const fetcher=vi.fn(async (_url:string,init:RequestInit)=>{
      const req=JSON.parse(String(init.body));
      return req.method==='eth_chainId'?reply(req,'0x1863d'):new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32000,message:'insufficient funds for gas * price + value'}}));
    });vi.stubGlobal('fetch',fetcher);
    const client=createSafeReadClient(settings,elysium);
    await expect(client.estimateGas({to:'0x0000000000000000000000000000000000000001'})).rejects.toThrow();
    expect(fetcher.mock.calls.every(([url])=>url===settings.rpcUrls[0])).toBe(true);
  });
  it('rejects remote cleartext, embedded credentials, and malformed URLs',()=>{
    expect(()=>validateRpcUrls(['http://node.example'])).toThrow();
    expect(()=>validateRpcUrls(['https://user:password@node.example'])).toThrow();
    expect(()=>validateRpcUrls(['javascript:alert(1)'])).toThrow();
    expect(validateRpcUrls(['http://127.0.0.1:8545'])).toEqual(['http://127.0.0.1:8545']);
  });
});
