import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.mjs';
import { createPolicySnapshot, policyFingerprint, assertPolicyUnchanged, policyRecord } from '../src/policy.mjs';

test('routing mode defaults to pinned for existing configurations and only persists explicit supported choices', () => {
  const old = structuredClone(DEFAULT_CONFIG);
  delete old.chains.bnb.routingMode; delete old.chains.solana.routingMode;
  const config = validateConfig(old);
  assert.equal(config.chains.bnb.routingMode, 'pinned');
  assert.equal(config.chains.solana.routingMode, 'pinned');
  old.chains.bnb.routingMode = 'aggregator';
  assert.equal(validateConfig(old).chains.bnb.routingMode, 'aggregator');
  for (const value of ['any', '', true, null, {}, 1]) {
    old.chains.bnb.routingMode = value;
    assert.throws(() => validateConfig(old), /routingMode/);
  }
});

test('switching from fixed pool to aggregator changes policy and invalidates existing execution intents', () => {
  const config = validateConfig(DEFAULT_CONFIG), trade = policyRecord(config);
  const before = policyFingerprint(createPolicySnapshot(config));
  config.chains.solana.routingMode = 'aggregator';
  assert.notEqual(policyFingerprint(createPolicySnapshot(config)), before);
  assert.throws(() => assertPolicyUnchanged(trade, config), /配置已变化/);
  assert.equal(config.chains.bnb.routerAllowlist.length, 0, 'route selection cannot silently import permissions');
});
