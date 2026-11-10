import { getAddress, type Address, type EIP1193Provider } from 'viem';
import { PROFILES } from './profiles';
import type { WorkspaceProfile } from './profiles';

export interface WalletOption { id: string; name: string; icon?: string; provider: EIP1193Provider; }
type EventProvider = EIP1193Provider & {
  providers?: EIP1193Provider[];
  isMetaMask?: boolean;
  isRabby?: boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

/** Discover providers without connecting accounts or asking the wallet to sign. */
export function discoverWallets(callback: (options: WalletOption[]) => void): () => void {
  const options: WalletOption[] = [];
  const add = (option: WalletOption) => {
    if (!option.provider || typeof option.provider.request !== 'function') return;
    const existing = options.findIndex((item) => item.provider === option.provider);
    if (existing >= 0) options.splice(existing, 1, option);
    else options.push(option);
    callback([...options]);
  };
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<{ info: { uuid: string; name: string; icon?: string }; provider: EIP1193Provider }>).detail;
    if (!detail?.info || !detail.provider) return;
    add({ id: detail.info.uuid, name: String(detail.info.name).slice(0, 80), icon: detail.info.icon, provider: detail.provider });
  };
  window.addEventListener('eip6963:announceProvider', announce);
  const injected = (window as unknown as { ethereum?: EventProvider }).ethereum;
  if (injected) {
    for (const [index, provider] of (injected.providers?.length ? injected.providers : [injected]).entries()) {
      const identified = provider as EventProvider;
      add({ id: `injected-${index}`, name: identified.isRabby ? 'Rabby Wallet' : identified.isMetaMask ? 'MetaMask' : '浏览器钱包', provider });
    }
  }
  callback([...options]);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => window.removeEventListener('eip6963:announceProvider', announce);
}

export async function connectWallet(provider: EIP1193Provider, profile: WorkspaceProfile = PROFILES['hyperevm-v3']): Promise<Address> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new Error('钱包未提供账户。');
  const chainId = `0x${profile.chainId.toString(16)}`;
  const currentChain = await provider.request({ method: 'eth_chainId' });
  if (Number(currentChain) !== profile.chainId) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    } catch (error) {
      const walletError = error as { code?: number; data?: { originalError?: { code?: number } } };
      if (walletError.code !== 4902 && walletError.data?.originalError?.code !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{
        chainId, chainName: profile.chain.name,
        nativeCurrency: profile.chain.nativeCurrency,
        rpcUrls: [...profile.chain.rpcUrls.default.http],
        blockExplorerUrls: [profile.explorer],
      }] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    }
  }
  if (Number(await provider.request({ method: 'eth_chainId' })) !== profile.chainId) throw new Error(`请将钱包切换至 ${profile.name} 主网（${profile.chainId}）。`);
  // Re-read after the chain switch: some wallets change the selected account as well.
  const finalAccounts = await provider.request({ method: 'eth_accounts' });
  if (!finalAccounts[0]) throw new Error('钱包账户已断开。');
  if (Number(await provider.request({ method: 'eth_chainId' })) !== profile.chainId) throw new Error('查询账户期间钱包网络已变化，请重新连接。');
  return getAddress(finalAccounts[0]);
}

/** Any account/network change invalidates plans held by the caller. */
export function subscribeWallet(provider: EIP1193Provider, onChange: () => void): () => void {
  const eventProvider = provider as EventProvider;
  const changed = () => onChange();
  eventProvider.on?.('accountsChanged', changed);
  eventProvider.on?.('chainChanged', changed);
  eventProvider.on?.('disconnect', changed);
  return () => {
    eventProvider.removeListener?.('accountsChanged', changed);
    eventProvider.removeListener?.('chainChanged', changed);
    eventProvider.removeListener?.('disconnect', changed);
  };
}
