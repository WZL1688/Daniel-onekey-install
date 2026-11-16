const CHAIN_ID = '0x38';
const PROVIDER_NAMES = { metamask: 'MetaMask', okx: 'OKX Wallet', phantom: 'Phantom' };
const sameAddress = (chain, left, right) => chain === 'bnb' ? String(left).toLowerCase() === String(right).toLowerCase() : String(left) === String(right);
const bytesToBase64 = bytes => {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const base64ToBytes = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
function safeProviderError(error) {
  const code = error?.code === 4001 || error?.code === 'ACTION_REJECTED' ? 4001 : error?.code === 4902 ? 4902 : 'WALLET_ERROR';
  return { code, message: code === 4001 ? '已在插件钱包中取消操作' : code === 4902 ? '请先在插件钱包中添加并选择 BNB Chain 主网（56）' : '插件钱包操作失败，请检查钱包是否解锁、网络及当前账户' };
}

export function createWalletConnector({ api, onNotice = () => {}, onChange = () => {}, onSigning = () => {} }) {
  let clientId;
  const clientKey = 'chainpair-wallet-client';
  const handledKey = 'chainpair-wallet-dispatched';
  try { clientId = sessionStorage.getItem(clientKey); } catch {}
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId || '')) clientId = crypto.randomUUID();
  try { sessionStorage.setItem(clientKey, clientId); } catch {}
  let restoredIds = [];
  try { restoredIds = JSON.parse(sessionStorage.getItem(handledKey) || '[]'); } catch {}
  const handled = new Set(Array.isArray(restoredIds) ? restoredIds.filter(id => typeof id === 'string') : []);
  const announced = new Map();
  const connected = new Map();
  const connecting = new Set();
  const deliveries = new Map();
  const signingQueue = [];
  let started = false, polling = false, heartbeating = false, signing = false, lastTransportWarning = 0;
  let pollTimer, heartbeatTimer;
  const announce = event => {
    const detail = event.detail;
    if (detail?.provider?.request && detail.info?.uuid) announced.set(detail.info.uuid, detail);
  };
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  function evmProvider(name) {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const candidates = [...announced.values()];
    if (name === 'metamask') {
      const exact = candidates.find(row => row.info.rdns === 'io.metamask');
      if (exact) return exact.provider;
      const all = Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : [window.ethereum];
      return all.find(provider => provider?.isMetaMask && !provider.isOkxWallet && !provider.isOKExWallet && !provider.isPhantom) || null;
    }
    const exact = candidates.find(row => /(^|\.)(okx|okex)(\.|$)/i.test(row.info.rdns || ''));
    return exact?.provider || window.okxwallet?.ethereum || (window.okxwallet?.request ? window.okxwallet : null) || (Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : [window.ethereum]).find(provider => provider?.isOkxWallet || provider?.isOKExWallet) || null;
  }
  function solanaProvider(name) {
    if (name === 'okx') return window.okxwallet?.solana || null;
    return window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
  }
  function markHandled(id) {
    handled.add(id);
    // IDs contain no wallet secrets or transaction signatures; retain enough to block reload replays.
    try { sessionStorage.setItem(handledKey, JSON.stringify([...handled].slice(-1000))); } catch {}
  }
  function forget(chain) {
    const row = connected.get(chain);
    if (!row) return;
    for (const [event, handler] of row.listeners) row.provider.removeListener?.(event, handler);
    connected.delete(chain);
  }
  async function invalidate(chain, message) {
    if (!connected.has(chain)) return;
    forget(chain);
    onNotice(message, true);
    try { await api('/api/wallets/disconnect', { method: 'POST', body: { chain, clientId } }); } catch {}
    onChange();
  }
  function bindEvents(chain, row) {
    row.listeners = [];
    const bind = (name, fn) => { row.provider.on?.(name, fn); row.listeners.push([name, fn]); };
    if (chain === 'bnb') {
      bind('accountsChanged', accounts => { if (!accounts?.length || !sameAddress(chain, accounts[0], row.address)) void invalidate(chain, 'BNB 插件账户已变化，自动执行已暂停，请重新连接'); });
      bind('chainChanged', id => { if (String(id).toLowerCase() !== CHAIN_ID) void invalidate(chain, '插件已离开 BNB Chain 主网，请切回后重新连接'); });
    } else bind('accountChanged', key => { if (!key || !sameAddress(chain, key.toString(), row.address)) void invalidate(chain, 'Solana 插件账户已变化，自动执行已暂停，请重新连接'); });
    bind('disconnect', () => void invalidate(chain, `${PROVIDER_NAMES[row.name]} 已断开，请重新连接`));
  }
  async function connect(chain, name) {
    if (!['bnb', 'solana'].includes(chain) || !((chain === 'bnb' && ['metamask', 'okx'].includes(name)) || (chain === 'solana' && ['phantom', 'okx'].includes(name)))) throw new Error('不支持的钱包与链组合');
    if (connecting.has(chain)) throw new Error('该链的钱包连接正在等待确认');
    connecting.add(chain);
    const provider = chain === 'bnb' ? evmProvider(name) : solanaProvider(name);
    try {
      if (!provider) throw new Error(`没有检测到 ${PROVIDER_NAMES[name]} 插件，请在当前浏览器安装或启用该插件，解锁后刷新页面`);
      let address;
      if (chain === 'bnb') {
        await provider.request({ method: 'eth_requestAccounts' });
        let network = await provider.request({ method: 'eth_chainId' });
        if (String(network).toLowerCase() !== CHAIN_ID) {
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID }] });
          network = await provider.request({ method: 'eth_chainId' });
        }
        if (String(network).toLowerCase() !== CHAIN_ID) throw new Error('请在钱包中选择 BNB Chain 主网（56）');
        const accounts = await provider.request({ method: 'eth_accounts' });
        address = accounts?.[0];
        if (!/^0x[0-9a-f]{40}$/i.test(address || '')) throw new Error('插件未返回有效的 BNB 钱包地址');
      } else {
        const result = await provider.connect();
        address = (result?.publicKey || provider.publicKey)?.toString();
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address || '')) throw new Error('插件未返回有效的 Solana 钱包地址');
        if (typeof provider.signTransaction !== 'function') throw new Error('该 Solana 插件不支持交易签名');
      }
      const result = await api('/api/wallets/connect', { method: 'POST', body: { chain, provider: name, address, clientId } });
      forget(chain);
      const row = { provider, name, address, listeners: [] };
      connected.set(chain, row); bindEvents(chain, row);
      void heartbeat(); void poll();
      return result;
    } catch (error) {
      if (error?.code) throw new Error(safeProviderError(error).message);
      throw error;
    } finally { connecting.delete(chain); }
  }
  async function disconnect(chain) {
    const result = await api('/api/wallets/disconnect', { method: 'POST', body: { chain, clientId } });
    forget(chain); return result;
  }
  async function heartbeat() {
    if (heartbeating || !connected.size) return;
    heartbeating = true;
    try {
      await api('/api/wallets/browser/heartbeat', { method: 'POST', body: { clientId, connections: [...connected].map(([chain, row]) => ({ chain, address: row.address })) } });
    } catch (error) {
      // A dropped HTTP response never causes signing or rebroadcast. The server TTL pauses new work.
      if (Date.now() - lastTransportWarning > 30000) { lastTransportWarning = Date.now(); onNotice('插件连接心跳暂不可用，请确认本机服务仍运行；不要重复提交在途交易', true); }
    } finally { heartbeating = false; }
  }
  async function deliver(id, outcome) {
    deliveries.set(id, outcome);
    try {
      await api('/api/wallets/browser/result', { method: 'POST', body: { clientId, requestId: id, ...outcome } });
      deliveries.delete(id); onChange();
    } catch {
      // Retrying outcome delivery is safe. The wallet method is NEVER invoked a second time.
      if (Date.now() - lastTransportWarning > 15000) { lastTransportWarning = Date.now(); onNotice('钱包已返回结果，但本机服务暂未收到；正在重传结果，请保留页面并核对档案', true); }
    }
  }
  async function perform(request) {
    const row = connected.get(request.chain);
    if (!row) throw new Error('当前标签页未连接所需插件钱包');
    if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('签名请求已过期，请核对交易档案');
    const payload = request.payload || {};
    if (request.kind === 'evmSend' && request.chain === 'bnb') {
      const transaction = payload.transaction;
      const accounts = await row.provider.request({ method: 'eth_accounts' });
      const network = await row.provider.request({ method: 'eth_chainId' });
      if (String(network).toLowerCase() !== CHAIN_ID || !sameAddress('bnb', accounts?.[0], row.address)) throw new Error('插件账户或网络已变化，请核对后重新连接');
      if (!transaction || !sameAddress('bnb', transaction.from, row.address) || BigInt(transaction.chainId) !== 56n) throw new Error('待签名交易与当前钱包或 BNB Chain 不一致');
      if (Date.parse(request.expiresAt) <= Date.now()) throw new Error('签名请求已过期');
      const hash = await row.provider.request({ method: 'eth_sendTransaction', params: [transaction] });
      if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('插件没有返回有效交易哈希，请人工核对钱包交易');
      return { hash };
    }
    if (request.kind === 'solSign' && request.chain === 'solana') {
      if (!sameAddress('solana', row.provider.publicKey?.toString(), row.address) || !sameAddress('solana', payload.sender, row.address)) throw new Error('Solana 插件账户已变化，请重新连接');
      if (!window.solanaWeb3?.VersionedTransaction) throw new Error('Solana 签名组件未加载，请刷新本机页面');
      const transaction = window.solanaWeb3.VersionedTransaction.deserialize(base64ToBytes(payload.transactionBase64));
      const beforeMessage = bytesToBase64(transaction.message.serialize());
      if (transaction.message.staticAccountKeys[0]?.toBase58() !== row.address || transaction.message.header.numRequiredSignatures !== 1) throw new Error('Solana 待签名交易的付款人与当前插件不一致');
      if (Date.parse(request.expiresAt) <= Date.now()) throw new Error('签名请求已过期');
      const signed = await row.provider.signTransaction(transaction);
      if (!signed?.message || bytesToBase64(signed.message.serialize()) !== beforeMessage) throw new Error('插件返回的 Solana 交易内容已改变，请人工核对');
      return { signedTransactionBase64: bytesToBase64(signed.serialize()) };
    }
    throw new Error('不支持的插件签名请求');
  }
  function nextSigning() {
    if (signing || deliveries.size || !signingQueue.length) return;
    const request = signingQueue.shift();
    signing = true;
    const row = connected.get(request.chain);
    onSigning({ active: true, id: request.id, chain: request.chain, provider: row?.name, summary: request.summary, kind: request.kind });
    // Signing must not block heartbeat and result-delivery retries.
    void (async () => {
      let outcome;
      try { outcome = { result: await perform(request) }; }
      catch (error) {
        outcome = { error: error?.code ? safeProviderError(error) : { code: 'WALLET_CHECK_FAILED', message: '插件签名前置核对失败或签名结果不可核验，请查看页面提示与交易档案' } };
        onNotice(error?.code ? safeProviderError(error).message : String(error.message || '插件操作失败'), true);
      }
      // A late EVM result can refer to a transaction already broadcast by the extension.
      await deliver(request.id, outcome);
      signing = false; onSigning({ active: false, id: request.id });
      nextSigning();
    })();
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const [id, outcome] of [...deliveries]) await deliver(id, outcome);
      if (!signing && connected.size) {
        const body = await api(`/api/wallets/browser/requests?clientId=${encodeURIComponent(clientId)}`);
        // The server consumes delivery before responding. Keep every delivered
        // request, including requests for two different chains in one response.
        for (const request of body.requests || []) {
          if (typeof request?.id !== 'string' || !request.id || handled.has(request.id)) continue;
          markHandled(request.id); signingQueue.push(request);
        }
      }
      nextSigning();
    } catch {
      // Connection errors remain explicit in connect(); no wallet send is replayed.
    } finally { polling = false; }
  }
  function syncServerState(wallets) {
    for (const [chain, row] of [...connected]) {
      const wallet = wallets?.[chain];
      if (wallet && (wallet.mode !== 'browser' || !sameAddress(chain, wallet.address, row.address) || (wallet.provider && wallet.provider !== row.name))) forget(chain);
    }
  }
  function start() {
    if (started) return; started = true;
    pollTimer = setInterval(poll, 1000); heartbeatTimer = setInterval(heartbeat, 5000);
  }
  function stop() {
    clearInterval(pollTimer); clearInterval(heartbeatTimer); started = false;
    for (const chain of [...connected.keys()]) forget(chain);
    window.removeEventListener('eip6963:announceProvider', announce);
  }
  return { connect, disconnect, forget, start, stop, syncServerState, clientId,
    available: (chain, name) => Boolean(chain === 'bnb' ? evmProvider(name) : solanaProvider(name)),
    isConnectedHere: chain => connected.has(chain), providerName: name => PROVIDER_NAMES[name] || name };
}
