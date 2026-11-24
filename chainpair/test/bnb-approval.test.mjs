import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interface, Transaction, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DemoAdapter } from '../src/adapters/demo.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createPolicySnapshot, policyFingerprint } from '../src/policy.mjs';
import { BnbApprovalService } from '../src/bnb-approval.mjs';

const ERC20 = new Interface(['function approve(address spender,uint256 amount) returns(bool)']);
const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const OUTPUT = '0x3333333333333333333333333333333333333333';
const SECRET_MARKER = 'test-provider-secret-do-not-persist';
const stamp = () => new Date().toISOString();
const safe = message => Object.assign(new Error(message), { safe: true });
const hex = value => '0x' + BigInt(value).toString(16);

function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bnb-approval-'));
  const store = new Store(dir), config = structuredClone(DEFAULT_CONFIG), wallet = Wallet.createRandom();
  config.mode = options.parentMode || 'live'; config.executionMode = 'inventory';
  config.inventory = { assetId: 'manual:configured-label', mappingConfirmed: true, mappingEvidence: 'Offline fixture only', scanApprovedAssets: false };
  config.chains.bnb.tokenAddress = TOKEN; config.chains.bnb.poolAddress = OUTPUT; config.chains.bnb.routerAllowlist = [SPENDER];
  store.setConfig(config);
  let clock = Date.now(), current = options.currentRaw || '0', reportValid = true, reportExpiry = clock + 15000, lookupCount = 0;
  let lastRaw = null, signerCalls = 0, browserCalls = 0, binding, withheld;
  let published = null;
  const calls = [], sent = [], browserInputs = [];
  const status = { bnb: { address: wallet.address, mode: options.walletMode || 'private', canSign: options.canSign !== false, unlocked: options.unlocked !== false },
    solana: { address: '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr', mode: 'readonly', canSign: false, unlocked: false }, locked: false, okxConfigured: true };
  const vault = { publicStatus: () => structuredClone(status), redact: text => String(text).replaceAll(SECRET_MARKER, '[REDACTED]'), signer: async chain => {
    assert.equal(chain, 'bnb');
    return { address: wallet.address, signTransaction: async request => {
      signerCalls++;
      assert.equal(store.allTrades()[0]?.status, 'APPROVAL_SUBMITTING', 'the exact unsigned intent is durable before signing');
      options.onSign?.({ engine, status });
      if (options.signerGate) await options.signerGate;
      if (options.badSigner) return Wallet.createRandom().signTransaction(request);
      return wallet.signTransaction(request);
    } };
  } };
  const engine = new Engine({ store, vault });
  const fingerprint = () => policyFingerprint(createPolicySnapshot(engine.config));
  const walletBinding = () => JSON.stringify(status);
  const scannerAsset = { id: 'manual:scanner-asset', revision: 1, mappingEvidence: 'Offline registry fixture', chains: { bnb: { address: TOKEN }, solana: { address: status.solana.address } } };
  const scanner = { getApprovedAsset(id) { assert.equal(id, scannerAsset.id, 'configured local labels must not be treated as registry IDs'); return structuredClone(scannerAsset); }, assertComparisonUsable() { if (options.quarantined) throw safe('价格已隔离'); } };
  const required = options.requiredRaw || '1000';
  const readiness = {
    scanner,
    refresh() { binding = { parentRevision: engine.configRevision, parentPolicyFingerprint: fingerprint(), wallets: walletBinding(), assetId: options.scannerAsset ? scannerAsset.id : null, assetIdentity: options.scannerAsset ? JSON.stringify(scannerAsset) : null }; reportValid = true; reportExpiry = clock + 15000; },
    assertApprovalContextCurrent(context) {
      const original = context?.contextBinding;
      if (!original || original.parentRevision !== engine.configRevision || original.parentPolicyFingerprint !== fingerprint() || original.wallets !== walletBinding() || original.assetId && original.assetIdentity !== JSON.stringify(scannerAsset)) throw safe('预检钱包或配置已变化');
    },
    getReviewableApproval(reportId, index) {
      if (!reportValid || clock >= reportExpiry || reportId !== 'report-fixture' || index !== 0) throw safe('授权预检已过期');
      return { reportId, chain: 'bnb', tokenAddress: TOKEN, spender: SPENDER, owner: wallet.address, requiredRaw: required, currentRaw: current,
        parentRevision: binding.parentRevision, parentPolicyFingerprint: binding.parentPolicyFingerprint, assetId: options.scannerAsset ? scannerAsset.id : config.inventory.assetId,
        ...(options.scannerAsset ? { assetRevision: scannerAsset.revision } : {}), expiresAt: new Date(reportExpiry).toISOString() };
    },
    getApprovalContext(reportId, index) {
      const publicRequirement = this.getReviewableApproval(reportId, index), workerConfig = structuredClone(config); workerConfig.mode = 'live';
      return { ...publicRequirement, config: workerConfig, fromToken: { address: TOKEN, decimals: 18, kind: 'token' }, toToken: { address: OUTPUT, decimals: 18, kind: 'stable' },
        amountRaw: required, owner: wallet.address, spender: SPENDER, contextBinding: structuredClone(binding) };
    },
  };
  readiness.refresh();
  function publish(tx, hash) {
    const decoded = ERC20.decodeFunctionData('approve', tx.data);
    assert.equal(decoded.spender.toLowerCase(), SPENDER.toLowerCase());
    assert.equal(tx.to.toLowerCase(), TOKEN.toLowerCase());
    if (!options.noAllowanceChange) current = decoded.amount.toString();
    published = { hash, from: wallet.address, to: TOKEN, input: tx.data, value: '0x0', gas: tx.gas || hex(tx.gasLimit), gasPrice: hex(tx.gasPrice), chainId: '0x38' };
    if (options.badPublished) published.to = OUTPUT;
  }
  const adapter = {
    async allowanceRequirement() {
      const result = { chain: 'bnb', tokenAddress: TOKEN, spender: SPENDER, owner: wallet.address, requiredRaw: required, currentRaw: current, sufficient: BigInt(current) >= BigInt(required) };
      return options.requirement ? options.requirement(result) : result;
    },
    rpc: { bnb: { async call(method, params = [], flags = {}) {
      calls.push({ method, params, flags });
      if (options.rpcError) throw new Error('provider https://private.invalid/' + SECRET_MARKER);
      if (method === 'eth_getCode') return options.codeResult ?? (options.emptyCode ? '0x' : '0x6001');
      if (method === 'eth_estimateGas') return options.gasEstimate === undefined ? '0xc350' : typeof options.gasEstimate === 'function' ? options.gasEstimate() : options.gasEstimate;
      if (method === 'eth_gasPrice') return '0x3b9aca00';
      if (method === 'eth_getBalance') return options.balance === undefined ? hex(10n ** 18n) : options.balance;
      if (method === 'eth_call') {
        assert.equal(params[0].to.toLowerCase(), TOKEN.toLowerCase());
        assert.equal(params[0].value, '0x0');
        assert.ok(params[0].gas && params[0].gasPrice, 'simulation includes the reviewed gas bounds');
        return options.approveResult === undefined ? ERC20.encodeFunctionResult('approve', [true]) : options.approveResult;
      }
      if (method === 'eth_getTransactionCount') { options.onNonce?.({ engine, status }); return options.nonce === undefined ? '0x0' : options.nonce; }
      if (method === 'eth_sendRawTransaction') {
        assert.equal(flags.broadcast, true);
        lastRaw = params[0]; const tx = Transaction.from(lastRaw), hash = keccak256(lastRaw);
        assert.equal(store.allTrades()[0]?.status, 'APPROVAL_SUBMITTED', 'deterministic hash is durable before broadcast');
        assert.equal(store.allTrades()[0]?.legs[0].hash, hash);
        assert.equal(tx.from, wallet.address); assert.equal(tx.chainId, 56n); assert.equal(tx.value, 0n);
        sent.push({ hash, tx }); publish(tx, hash);
        return options.wrongRpcHash ? '0x' + 'f'.repeat(64) : hash;
      }
      if (method === 'eth_getTransactionByHash') { lookupCount++; return lookupCount <= (options.nullLookups || 0) ? null : published; }
      throw new Error('Unexpected offline RPC method ' + method);
    } } },
    async receipt(chain, hash) {
      assert.equal(chain, 'bnb');
      if (options.receiptFailure) throw new Error(SECRET_MARKER);
      if (options.postAllowance !== undefined) current = options.postAllowance;
      return { receipt: { transactionHash: hash, status: options.reverted ? '0x0' : '0x1', blockHash: '0x' + 'a'.repeat(64), blockNumber: '0x64', gasUsed: '0x7530', effectiveGasPrice: '0x3b9aca00' }, feesNative: options.actualFee === undefined ? .00003 : options.actualFee, rentNative: 0 };
    },
  };
  engine.browserWallets = { async request(chain, input) {
    browserCalls++; browserInputs.push(input); assert.equal(chain, 'bnb'); assert.equal(input.kind, 'evmSend');
    assert.equal(store.allTrades()[0]?.status, 'APPROVAL_SUBMITTING', 'intent is durable before extension request');
    if (options.browserFailure) throw new Error(SECRET_MARKER);
    const hash = keccak256(toUtf8Bytes('offline-browser-' + browserCalls)); publish(input.payload.transaction, hash); return { hash };
  } };
  const service = new BnbApprovalService({ engine, readiness, adapterFactory: () => adapter, now: () => clock, publishedPollMs: 1, publishedTimeoutMs: options.publishedTimeoutMs ?? 50 });
  t.after(async () => { if (service.pending) await service.pending.catch(() => {}); engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, service, readiness, status, config, scannerAsset, adapter, calls, sent, browserInputs, options,
    prepare: () => service.prepare({ reportId: 'report-fixture', index: 0 }), advance: ms => { clock += ms; },
    setCurrent: raw => { current = raw; }, getCurrent: () => current, invalidateReport: () => { reportValid = false; },
    getSignerCalls: () => signerCalls, getBrowserCalls: () => browserCalls, getLastRaw: () => lastRaw };
}

async function execute(ctx, intent) {
  const accepted = ctx.service.execute({ intentId: intent.id, expectedMode: 'live', confirmed: true });
  assert.equal(accepted.accepted, true); assert.equal(ctx.engine.busy, true);
  return ctx.service.pending;
}

test('prepare only simulates exact bounded approval and never signs, broadcasts or creates a trade', async t => {
  const ctx = fixture(t), before = JSON.stringify(ctx.engine.config), intent = await ctx.prepare();
  assert.equal(intent.action, 'approve'); assert.equal(intent.amountRaw, '1000'); assert.equal(intent.tokenAddress, TOKEN); assert.equal(intent.spender, SPENDER);
  assert.equal(intent.feeNative, .00006); assert.equal(intent.realTransaction, true); assert.equal(intent.readOnly, true);
  assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.getSignerCalls(), 0); assert.equal(ctx.getBrowserCalls(), 0); assert.equal(ctx.sent.length, 0);
  assert.equal(JSON.stringify(ctx.engine.config), before); assert.equal(ctx.engine.running, false); assert.equal(ctx.engine.busy, false);
  assert.equal(ctx.service.snapshot().prepared.length, 1); assert.ok(ctx.calls.some(call => call.method === 'eth_call'));
});

test('private approval journals before signing/broadcast, verifies receipt and exact post-allowance, with independent cost', async t => {
  const ctx = fixture(t), intent = await ctx.prepare(), result = await execute(ctx, intent);
  assert.equal(result.type, 'approval'); assert.equal(result.mode, 'live'); assert.equal(result.status, 'COMPLETED'); assert.equal(result.amountUsd, 0);
  assert.equal(result.legs[0].status, 'CONFIRMED'); assert.equal(result.legs[0].receipt.confirmed, true); assert.equal(result.actual.allowanceRaw, '1000');
  assert.equal(result.actual.gasUsd, .018); assert.equal(result.actual.profitUsd, -.018); assert.equal(result.actual.approvalCostUsd, .018);
  assert.equal(ctx.store.stats('live').executions, 0); assert.equal(ctx.store.stats('live').cumulativeUsd, 0);
  assert.equal(ctx.getSignerCalls(), 1); assert.equal(ctx.sent.length, 1); assert.equal(ctx.getBrowserCalls(), 0);
  const events = result.events.map(row => row.status);
  assert.ok(events.indexOf('APPROVAL_SUBMITTING') < events.indexOf('APPROVAL_SUBMITTED')); assert.ok(events.indexOf('APPROVAL_SUBMITTED') < events.indexOf('APPROVAL_RECEIPT'));
  assert.ok(!JSON.stringify(result).includes(ctx.getLastRaw())); assert.ok(!JSON.stringify(ctx.service.snapshot()).includes(ctx.getLastRaw()));
  assert.equal(ctx.engine.running, false); assert.equal(ctx.engine.busy, false); assert.equal(ctx.service.snapshot().job.status, 'completed');
  assert.throws(() => ctx.service.execute({ intentId: intent.id, expectedMode: 'live', confirmed: true }), /不存在|已使用/);
});

test('browser approval uses one exact extension request and tolerates hash propagation without resending', async t => {
  const ctx = fixture(t, { walletMode: 'browser', nullLookups: 2 }), intent = await ctx.prepare(), result = await execute(ctx, intent);
  assert.equal(result.status, 'COMPLETED'); assert.equal(ctx.getBrowserCalls(), 1); assert.equal(ctx.getSignerCalls(), 0); assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
  assert.equal(ctx.calls.filter(call => call.method === 'eth_getTransactionByHash').length, 3);
  const tx = ctx.browserInputs[0].payload.transaction, decoded = ERC20.decodeFunctionData('approve', tx.data);
  assert.equal(tx.to, TOKEN); assert.equal(tx.value, '0x0'); assert.equal(tx.chainId, '0x38'); assert.equal(decoded.amount, 1000n);
});

test('nonzero insufficient allowance first resets only; fresh check and a second explicit click are required', async t => {
  const ctx = fixture(t, { currentRaw: '3' }), first = await ctx.prepare();
  assert.equal(first.action, 'reset'); assert.equal(first.amountRaw, '0');
  await execute(ctx, first); assert.equal(ctx.getCurrent(), '0'); assert.equal(ctx.sent.length, 1);
  ctx.advance(1200); ctx.readiness.refresh(); const second = await ctx.prepare();
  assert.equal(second.action, 'approve'); assert.equal(second.amountRaw, '1000'); assert.equal(ctx.sent.length, 1, 'preparing never automatically sends the second transaction');
  await execute(ctx, second); assert.equal(ctx.sent.length, 2); assert.equal(ctx.getCurrent(), '1000'); assert.equal(ctx.store.stats('live').executions, 0);
});

test('explicit confirmation and live mode are required before consuming an intent', async t => {
  const ctx = fixture(t), intent = await ctx.prepare();
  for (const body of [{}, { confirmed: false, expectedMode: 'live' }, { confirmed: true, expectedMode: 'demo' }]) assert.throws(() => ctx.service.execute({ intentId: intent.id, ...body }), /明确确认|实盘/);
  assert.equal(ctx.service.snapshot().prepared.length, 1); assert.equal(ctx.getSignerCalls(), 0);
  await execute(ctx, intent); assert.equal(ctx.sent.length, 1);
});

test('demo parent can review a real bounded intent but cannot send it', async t => {
  const ctx = fixture(t, { parentMode: 'demo' }), intent = await ctx.prepare();
  assert.equal(intent.realTransaction, true); assert.throws(() => ctx.service.execute({ intentId: intent.id, expectedMode: 'demo', confirmed: true }), /实盘/);
  assert.equal(ctx.engine.config.mode, 'demo'); assert.equal(ctx.getSignerCalls(), 0); assert.equal(ctx.store.allTrades().length, 0);
});

for (const change of ['mode', 'canSign', 'unlocked']) test(`unavailable BNB signing state ${change} cannot send an approval`, async t => {
  const options = change === 'mode' ? { walletMode: 'readonly' } : { [change]: false };
  const ctx = fixture(t, options), intent = await ctx.prepare();
  assert.throws(() => ctx.service.execute({ intentId: intent.id, expectedMode: 'live', confirmed: true }), /连接|解锁|签名/);
  assert.equal(ctx.getSignerCalls(), 0); assert.equal(ctx.store.allTrades().length, 0);
});

test('already sufficient allowance and uint256 unlimited amount are never approved again', async t => {
  const sufficient = fixture(t, { currentRaw: '1000' }); await assert.rejects(sufficient.prepare(), /已经足够/); assert.equal(sufficient.store.allTrades().length, 0);
  const unlimited = fixture(t, { requiredRaw: ((1n << 256n) - 1n).toString() }); await assert.rejects(unlimited.prepare(), /无限额度/); assert.equal(unlimited.calls.length, 0);
});

for (const field of ['tokenAddress', 'spender', 'owner', 'requiredRaw', 'sufficient']) test(`changed ${field} in fresh allowance query cannot approve a different intent`, async t => {
  const ctx = fixture(t, { requirement: value => ({ ...value, [field]: field === 'requiredRaw' ? '1001' : field === 'sufficient' ? true : OUTPUT }) });
  await assert.rejects(ctx.prepare(), /变化|不一致/); assert.equal(ctx.getSignerCalls(), 0); assert.equal(ctx.store.allTrades().length, 0);
});

for (const options of [{ emptyCode: true }, { codeResult: '0xzz' }, { codeResult: 'not bytecode' }, { balance: '0x1' }, { gasEstimate: '0x100000000' }, { approveResult: ERC20.encodeFunctionResult('approve', [false]) }, { balance: true }]) test(`invalid code, funds, gas, simulation or RPC quantity blocks before persistence ${JSON.stringify(options)}`, async t => {
  const ctx = fixture(t, options); await assert.rejects(ctx.prepare()); assert.equal(ctx.sent.length, 0); assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.engine.busy, false);
});

test('nonstandard void-return approve can be simulated while the encoded amount stays exact', async t => {
  const ctx = fixture(t, { approveResult: '0x' }), intent = await ctx.prepare(); assert.equal(intent.amountRaw, '1000'); assert.equal(ctx.sent.length, 0);
});

test('a zero gas estimate after the initial valid estimate cannot become a prepared transaction', async t => {
  let reads = 0;
  const ctx = fixture(t, { gasEstimate: () => ++reads === 1 ? '0xc350' : '0x0' });
  await assert.rejects(ctx.prepare(), /Gas 估算无效/); assert.equal(ctx.store.allTrades().length, 0); assert.equal(ctx.getSignerCalls(), 0);
});

for (const postAllowance of ['1001', ((1n << 256n) - 1n).toString()]) test(`a token that grants more than the exact reviewed amount is paused with its actual allowance recorded ${postAllowance}`, async t => {
  const ctx = fixture(t, { postAllowance }), intent = await ctx.prepare(); await assert.rejects(execute(ctx, intent), /准确限额/);
  const trade = ctx.store.allTrades()[0]; assert.equal(trade.status, 'NEEDS_REVIEW'); assert.equal(trade.approvalAllowance.currentRaw, postAllowance);
  assert.equal(trade.legs[0].receipt.confirmed, true); assert.equal(ctx.sent.length, 1); assert.match(ctx.engine.pausedReason, /核对/);
});

test('prepared approval has an independent deadline after its source quote expires', async t => {
  const ctx = fixture(t), intent = await ctx.prepare(); ctx.advance(20000); ctx.invalidateReport();
  const result = await execute(ctx, intent); assert.equal(result.status, 'COMPLETED'); assert.equal(ctx.sent.length, 1);
});

test('approval deadline, parent revision and either public wallet change invalidate a review', async t => {
  for (const changed of ['expiry', 'revision', 'solana']) {
    const ctx = fixture(t), intent = await ctx.prepare();
    if (changed === 'expiry') ctx.advance(90001);
    if (changed === 'revision') ctx.engine.configRevision++;
    if (changed === 'solana') ctx.status.solana.address = '11111111111111111111111111111111';
    assert.throws(() => ctx.service.execute({ intentId: intent.id, expectedMode: 'live', confirmed: true }));
    assert.equal(ctx.service.snapshot().prepared.length, 0); assert.equal(ctx.getSignerCalls(), 0);
  }
});

test('scanner-backed identity changes invalidate the intent while a configured label needs no registry record', async t => {
  const ctx = fixture(t, { scannerAsset: true }), intent = await ctx.prepare(); ctx.scannerAsset.revision++;
  assert.throws(() => ctx.service.execute({ intentId: intent.id, expectedMode: 'live', confirmed: true })); assert.equal(ctx.sent.length, 0);
});

test('changed allowance or newly insufficient reviewed gas blocks before creating a trade', async t => {
  const allowance = fixture(t), first = await allowance.prepare(); allowance.setCurrent('1');
  await assert.rejects(execute(allowance, first), /额度已变化/); assert.equal(allowance.store.allTrades().length, 0); assert.equal(allowance.getSignerCalls(), 0);
  const gas = fixture(t), second = await gas.prepare(); gas.options.gasEstimate = '0x100000';
  await assert.rejects(execute(gas, second), /Gas需求|Gas 需求/); assert.equal(gas.store.allTrades().length, 0); assert.equal(gas.getSignerCalls(), 0);
});

test('parent context change during nonce reading leaves a durable review record and prevents signing', async t => {
  const ctx = fixture(t, { onNonce: ({ engine }) => { engine.configRevision++; } }), intent = await ctx.prepare();
  await assert.rejects(execute(ctx, intent)); assert.equal(ctx.getSignerCalls(), 0); assert.equal(ctx.sent.length, 0);
  const trade = ctx.store.allTrades()[0]; assert.equal(trade.status, 'NEEDS_REVIEW'); assert.match(ctx.engine.pausedReason, /禁止重发/);
  assert.ok(trade.events.some(event => event.status === 'APPROVAL_SUBMITTING'));
});

for (const options of [{ browserFailure: true, walletMode: 'browser' }, { wrongRpcHash: true }, { badPublished: true }, { reverted: true }, { receiptFailure: true }, { noAllowanceChange: true }, { actualFee: .002 }, { nullLookups: 999, publishedTimeoutMs: 0 }]) test(`uncertainty after durable intent pauses with public evidence, without replay ${JSON.stringify(options)}`, async t => {
  const ctx = fixture(t, options), intent = await ctx.prepare(); await assert.rejects(execute(ctx, intent));
  const trade = ctx.store.allTrades()[0]; assert.equal(trade.status, 'NEEDS_REVIEW'); assert.equal(ctx.engine.running, false); assert.equal(ctx.engine.busy, false);
  assert.equal(ctx.service.snapshot().job.status, 'needs_review'); assert.throws(() => ctx.service.execute({ intentId: intent.id, expectedMode: 'live', confirmed: true }), /待核对|未完成/);
  const publicState = JSON.stringify([trade, ctx.service.snapshot()]); assert.ok(!publicState.includes(SECRET_MARKER)); if (ctx.getLastRaw()) assert.ok(!publicState.includes(ctx.getLastRaw()));
  assert.equal(ctx.getSignerCalls() + ctx.getBrowserCalls(), 1);
  const restarted = new Engine({ store: ctx.store, vault: ctx.engine.vault, adapterFactory: args => new DemoAdapter(args) }); await restarted.init(); restarted.stop();
  assert.equal(ctx.store.getTrade(trade.id).status, 'NEEDS_REVIEW'); assert.equal(ctx.getSignerCalls() + ctx.getBrowserCalls(), 1, 'restart never replays a signed approval');
});

test('one consumed approval holds the parent mutex and cannot be sent a second time concurrently', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), ctx = fixture(t, { signerGate: gate }), intent = await ctx.prepare();
  const pending = execute(ctx, intent);
  assert.throws(() => ctx.service.execute({ intentId: intent.id, expectedMode: 'live', confirmed: true }), /已有/);
  await assert.rejects(ctx.prepare(), /已有/); await assert.rejects(ctx.engine.saveConfig(ctx.engine.config), /进行中|执行中/);
  release(); await pending; assert.equal(ctx.sent.length, 1); assert.equal(ctx.getSignerCalls(), 1);
});

test('prepare request budget survives recreation and failures never expose raw provider data', async t => {
  const ctx = fixture(t, { rpcError: true }); await assert.rejects(ctx.prepare(), error => !error.message.includes(SECRET_MARKER));
  const freshService = new BnbApprovalService({ engine: ctx.engine, readiness: ctx.readiness, adapterFactory: () => ctx.adapter, now: () => Date.now() });
  await assert.rejects(freshService.prepare({ reportId: 'report-fixture', index: 0 }), /频繁|回退/);
  assert.equal(ctx.store.allTrades().length, 0); assert.ok(!JSON.stringify(ctx.service.snapshot()).includes(SECRET_MARKER));
});
