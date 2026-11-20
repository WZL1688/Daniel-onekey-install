import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Vault } from '../src/vault.mjs';
import { createApp, startLocalServer } from '../src/server.mjs';

test('saving a radar data key cannot unlock previously locked trading wallets or OKX credentials', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'radar-lock-boundary-'));
  const password = 'fixture-radar-shared-vault-password';
  const vault = new Vault(directory);
  let server;
  try {
    const bnb = Wallet.createRandom(), solana = Keypair.generate();
    vault.importWallet({ chain: 'bnb', mode: 'private', secret: bnb.privateKey, password });
    vault.importWallet({ chain: 'solana', mode: 'private', secret: bs58.encode(solana.secretKey), password });
    vault.setOkxCredentials({ apiKey: 'fixture-okx-key', secretKey: 'fixture-okx-secret', passphrase: 'fixture-okx-passphrase', password });
    vault.lock();
    const engineCalls = [];
    const forbidden = name => () => { engineCalls.push(name); throw new Error('Radar credential save must not change trading execution'); };
    const engine = { running: true, start: forbidden('start'), execute: forbidden('execute'), saveConfig: forbidden('saveConfig'), pause: forbidden('pause'), walletChanged: forbidden('walletChanged') };
    let changed = 0;
    const app = createApp({ engine, store: {}, vault, radarService: { credentialsChanged() { changed++; } }, publicDir: directory });
    const running = await startLocalServer({ app }); server = running.server;
    const session = await fetch(`${running.url}/api/session`), { csrfToken } = await session.json();
    const result = await fetch(`${running.url}/api/radar/credentials`, {
      method: 'POST', headers: { Cookie: session.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'fixture-readonly-ave-key', password })
    });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { configured: true });
    assert.equal(changed, 1); assert.deepEqual(engineCalls, []); assert.equal(engine.running, true);
    assert.equal(vault.publicStatus().locked, true);
    assert.equal(vault.publicStatus().bnb.canSign, false); assert.equal(vault.publicStatus().solana.canSign, false);
    assert.throws(() => vault.signer('bnb')); assert.throws(() => vault.signer('solana'));
    assert.equal(vault.getOkxCredentials(), null); assert.equal(vault.getAveCredentials(), null);
    vault.unlock(password);
    assert.equal(vault.getAveCredentials().apiKey, 'fixture-readonly-ave-key');
    assert.equal(vault.getOkxCredentials().secretKey, 'fixture-okx-secret');
    assert.equal(vault.signer('bnb').address, bnb.address);
    assert.equal(vault.signer('solana').publicKey.toBase58(), solana.publicKey.toBase58());
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    vault.lock(); rmSync(directory, { recursive: true, force: true });
  }
});
