import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAddress } from 'ethers';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';

test('same BNB token checksum casing cannot replenish depleted demo inventory', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'inventory-case-audit-'));
  const store = new Store(directory);
  try {
    const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const config = structuredClone(DEFAULT_CONFIG);
    config.executionMode = 'inventory'; config.inventory.assetId = 'case-fixture';
    config.chains.bnb.tokenAddress = address;
    config.chains.solana.tokenAddress = 'So11111111111111111111111111111111111111112';
    store.setConfig(config);
    const first = new DemoAdapter({ store, getConfig: () => config });
    const saved = store.getMeta('demoInventoryTokens');
    const depleted = '42000000000000000000';
    saved[`bnb:${address}`].raw = depleted;
    store.setMeta('demoInventoryTokens', saved);
    assert.equal((await first.balances('bnb')).tokenRaw, depleted);

    const checksummed = structuredClone(config);
    checksummed.chains.bnb.tokenAddress = getAddress(address);
    assert.notEqual(checksummed.chains.bnb.tokenAddress, address);
    store.setConfig(checksummed);
    const restored = new DemoAdapter({ store, getConfig: () => checksummed });
    assert.equal((await restored.balances('bnb')).tokenRaw, depleted);
    assert.equal(Object.keys(store.getMeta('demoInventoryTokens')).length, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
