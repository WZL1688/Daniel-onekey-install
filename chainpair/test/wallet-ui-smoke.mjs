// Browser-only wallet fixtures. No external wallet, credential, RPC or broadcast is used.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { Wallet } from 'ethers';
import { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { Store } from '../src/store.mjs';
import { Vault } from '../src/vault.mjs';
import { Engine } from '../src/engine.mjs';
import { BrowserWalletBridge } from '../src/browser-wallets.mjs';
import { startLocalServer } from '../src/server.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'chainpair-wallet-ui-'));
const store = new Store(dir);
store.setConfig({ ...store.config, pollIntervalMs: 300000 });
const broker = new BrowserWalletBridge({ store, requestTimeoutMs: 20000 });
const vault = new Vault(dir, { browserWallets: broker });
const localWallet = Wallet.createRandom();
vault.importWallet({ chain: 'bnb', mode: 'private', secret: localWallet.privateKey, password: 'fixture-local-password' });
const engine = new Engine({ store, vault, browserWallets: broker });
await engine.init();
const { server, url } = await startLocalServer({ store, vault, engine, browserWallets: broker });
const fixture = {
  bnb: Wallet.createRandom().address,
  okxBnb: Wallet.createRandom().address,
  otherBnb: Wallet.createRandom().address,
  phantomSeed: [...randomBytes(32)],
  okxSolSeed: [...randomBytes(32)],
  otherSol: Keypair.generate().publicKey.toBase58(),
};
fixture.phantom = Keypair.fromSeed(Uint8Array.from(fixture.phantomSeed)).publicKey.toBase58();
fixture.okxSol = Keypair.fromSeed(Uint8Array.from(fixture.okxSolSeed)).publicKey.toBase58();
let browser;
const errors = [];
const apiBodies = [];
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  await context.addInitScript(f => {
    function emitter(target) {
      const listeners = new Map();
      target.on = (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return target; };
      target.removeListener = (event, fn) => listeners.get(event)?.delete(fn);
      target.emit = (event, ...args) => { for (const fn of [...(listeners.get(event) || [])]) fn(...args); };
      return target;
    }
    function evm(address, kind) {
      const provider = emitter({ account: address, chainId: kind === 'metamask' ? '0x1' : '0x38', calls: [], isMetaMask: kind === 'metamask', isOkxWallet: kind === 'okx' });
      provider.request = async ({ method, params }) => {
        provider.calls.push({ method, params });
        if (method === 'eth_requestAccounts') { if (provider.rejectConnect) { provider.rejectConnect = false; throw Object.assign(new Error('fixture cancellation'), { code: 4001 }); } return [provider.account]; }
        if (method === 'eth_accounts') return [provider.account];
        if (method === 'eth_chainId') return provider.chainId;
        if (method === 'wallet_switchEthereumChain') { provider.chainId = params[0].chainId; provider.emit('chainChanged', provider.chainId); return null; }
        if (method === 'eth_sendTransaction') {
          if (provider.rejectSend) { provider.rejectSend = false; throw Object.assign(new Error('fixture cancellation'), { code: 4001 }); }
          return '0x' + (kind === 'metamask' ? '11' : '22').repeat(32);
        }
        throw new Error('unexpected fixture method');
      };
      return provider;
    }
    function sol(address, seed) {
      const provider = emitter({ publicKey: { toString: () => address }, signCalls: 0 });
      provider.connect = async () => { provider.publicKey = new window.solanaWeb3.PublicKey(address); return { publicKey: provider.publicKey }; };
      provider.signTransaction = async transaction => {
        provider.signCalls++;
        if (provider.rejectSend) { provider.rejectSend = false; throw Object.assign(new Error('fixture cancellation'), { code: 4001 }); }
        transaction.sign([window.solanaWeb3.Keypair.fromSeed(Uint8Array.from(seed))]);
        return transaction;
      };
      return provider;
    }
    const metamask = evm(f.bnb, 'metamask');
    const okx = evm(f.okxBnb, 'okx');
    const phantom = sol(f.phantom, f.phantomSeed); phantom.isPhantom = true;
    const okxSol = sol(f.okxSol, f.okxSolSeed);
    window.ethereum = { providers: [metamask, okx] };
    window.okxwallet = okx; window.okxwallet.solana = okxSol;
    window.phantom = { solana: phantom }; window.solana = phantom;
    window.__walletFixtures = { metamask, okx, phantom, okxSol };
    window.addEventListener('eip6963:requestProvider', () => {
      for (const [uuid, rdns, name, provider] of [['fixture-metamask', 'io.metamask', 'MetaMask', metamask], ['fixture-okx', 'com.okex.wallet', 'OKX Wallet', okx]]) {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, rdns, name }, provider } }));
      }
    });
  }, fixture);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/wallets/')) apiBodies.push(request.postDataJSON()); });
  await page.goto(url + '/#settings');
  await expect(page.locator('[data-wallet-connect]')).toHaveCount(4);
  assert(await page.evaluate(() => Boolean(window.solanaWeb3?.VersionedTransaction)));
  const connect = async (chain, provider) => {
    await page.locator(`[data-wallet-connect="${provider}"][data-chain="${chain}"]`).click();
    await expect.poll(() => vault.publicStatus()[chain].provider).toBe(provider);
    await expect(page.locator(`[data-wallet-state="${chain}"]`)).toHaveText('插件已连接');
  };
  await connect('bnb', 'metamask');
  await connect('solana', 'phantom');
  assert.equal(vault.publicStatus().bnb.hasLocalProfile, true);
  assert.equal(await page.evaluate(() => window.__walletFixtures.metamask.calls.filter(c => c.method === 'eth_sendTransaction').length), 0);
  assert.equal(await page.evaluate(() => window.__walletFixtures.metamask.calls.find(c => c.method === 'wallet_switchEthereumChain').params[0].chainId), '0x38');
  console.log('PASS MetaMask and Phantom connect independently, network switches and connection does not sign');

  const evmPayload = address => ({ transaction: { from: address, to: fixture.otherBnb, chainId: '0x38', value: '0x0', data: '0x', gas: '0x5208', gasPrice: '0x1' } });
  const solPayload = address => {
    const payerKey = new (Keypair.generate().publicKey.constructor)(address);
    const message = new TransactionMessage({ payerKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: payerKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message();
    return { sender: address, transactionBase64: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64') };
  };
  const ask = (chain, kind, payload, quoteId) => broker.request(chain, { kind, payload, quoteId, expiresAt: new Date(Date.now() + 15000).toISOString() }).then(result => ({ result }), error => ({ error }));
  // Both queues are populated before a browser poll. Every consumed request must survive.
  const evm = ask('bnb', 'evmSend', evmPayload(fixture.bnb), 'fixture-evm');
  const unsignedSol = solPayload(fixture.phantom);
  const solana = ask('solana', 'solSign', unsignedSol, 'fixture-sol');
  const [evmOutcome, solOutcome] = await Promise.all([evm, solana]);
  assert.equal(evmOutcome.result?.hash, '0x' + '11'.repeat(32));
  assert(solOutcome.result?.signedTransactionBase64);
  const signed = VersionedTransaction.deserialize(Buffer.from(solOutcome.result.signedTransactionBase64, 'base64'));
  const original = VersionedTransaction.deserialize(Buffer.from(unsignedSol.transactionBase64, 'base64'));
  assert.deepEqual([...signed.message.serialize()], [...original.message.serialize()]);
  assert(signed.signatures[0].some(byte => byte !== 0));
  assert.equal(await page.evaluate(() => window.__walletFixtures.metamask.calls.filter(c => c.method === 'eth_sendTransaction').length), 1);
  assert.equal(await page.evaluate(() => window.__walletFixtures.phantom.signCalls), 1);
  assert.equal(broker.poll(broker.connections.get('bnb').clientId).requests.length, 0);
  console.log('PASS one poll preserves two chain requests, serial signing returns exact EVM data and real Solana signature');

  await page.evaluate(() => { window.__walletFixtures.metamask.rejectSend = true; });
  const cancelled = await ask('bnb', 'evmSend', evmPayload(fixture.bnb), 'fixture-rejected');
  assert.match(cancelled.error?.message || '', /取消/);
  await expect(page.locator('#toast-region')).toContainText('取消');
  await page.evaluate(address => { const p = window.__walletFixtures.metamask; p.account = address; p.emit('accountsChanged', [address]); }, fixture.otherBnb);
  await expect.poll(() => vault.publicStatus().bnb.connected).toBe(false);
  assert.equal(engine.running, false);
  assert.equal(vault.publicStatus().solana.connected, true);
  console.log('PASS user rejection and account change stop only the affected plugin connection');

  await connect('bnb', 'okx');
  await connect('solana', 'okx');
  const okxEvm = ask('bnb', 'evmSend', evmPayload(fixture.okxBnb), 'fixture-okx-evm');
  const okxSolana = ask('solana', 'solSign', solPayload(fixture.okxSol), 'fixture-okx-sol');
  const [oe, os] = await Promise.all([okxEvm, okxSolana]);
  assert.equal(oe.result?.hash, '0x' + '22'.repeat(32)); assert(os.result?.signedTransactionBase64);
  assert.equal(await page.evaluate(() => window.__walletFixtures.okx.calls.filter(c => c.method === 'eth_sendTransaction').length), 1);
  assert.equal(await page.evaluate(() => window.__walletFixtures.okxSol.signCalls), 1);
  console.log('PASS explicit OKX EVM/Solana selection and signing');

  await page.evaluate(() => { window.__walletFixtures.metamask.rejectConnect = true; });
  await page.locator('[data-wallet-connect="metamask"]').click();
  await expect(page.locator('#toast-region')).toContainText('已在插件钱包中取消操作');
  assert.equal(vault.publicStatus().bnb.provider, 'okx');
  assert.equal(vault.publicStatus().bnb.connected, true);
  await page.evaluate(() => { const p = window.__walletFixtures.okx; p.chainId = '0x1'; p.emit('chainChanged', '0x1'); });
  await expect.poll(() => vault.publicStatus().bnb.connected).toBe(false);
  await connect('bnb', 'okx');
  console.log('PASS rejected connection preserves existing provider and network changes require reconnection');

  if (process.env.SCREENSHOT_DIR) {
    mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    await page.locator('#settings-wallets').screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'wallet-connections.png') });
  }
  await page.evaluate(address => { const p = window.__walletFixtures.okxSol; p.publicKey = new window.solanaWeb3.PublicKey(address); p.emit('accountChanged', p.publicKey); }, fixture.otherSol);
  await expect.poll(() => vault.publicStatus().solana.connected).toBe(false);
  assert.equal(vault.publicStatus().bnb.connected, true);
  const blankContext = await browser.newContext();
  const missingPage = await blankContext.newPage();
  await missingPage.goto(url + '/#settings');
  await missingPage.locator('[data-wallet-connect="phantom"]').click();
  await expect(missingPage.locator('#toast-region')).toContainText('没有检测到 Phantom');
  await blankContext.close();
  console.log('PASS Solana account changes and missing-extension feedback');

  await page.reload();
  await expect(page.locator('[data-wallet-state="bnb"]')).toHaveText('请在当前页重新连接');
  assert.equal(await page.evaluate(() => window.__walletFixtures.okx.calls.filter(c => c.method === 'eth_sendTransaction').length), 0);
  await page.locator('[data-wallet-restore="bnb"]').click();
  await expect.poll(() => vault.publicStatus().bnb.mode).toBe('private');
  assert.equal(vault.signer('bnb').address, localWallet.address);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  for (const body of apiBodies) for (const key of ['privateKey', 'secret', 'password', 'mnemonic']) assert.equal(Object.hasOwn(body, key), false);
  assert.deepEqual(errors, []);
  console.log('PASS reload does not replay signing, local wallet restoration, 390px layout and no secret uploads');
} finally {
  await browser?.close();
  engine.stop(); broker.close();
  await new Promise(resolve => server.close(resolve));
  store.close(); rmSync(dir, { recursive: true, force: true });
}
