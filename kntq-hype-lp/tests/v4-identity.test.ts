import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { keccak256 } from 'viem';
import manifest from '../src/elysium/code-identities.json';
import fixture from './fixtures/v4-runtime.json';
import templateFixture from './fixtures/v4-runtime-template.json';
import deploymentSource from '../src/elysium/deployment-source.json';
import { ADDRESSES, CHAIN_ID } from '../src/elysium/config';
import { assertRuntimeIdentity, matchesRuntimeTemplate } from '../src/elysium/identity';
import type { RuntimeRole, RuntimeTemplate } from '../src/elysium/identity';

// These are canonical official runtime artifacts with Elysium constructor
// parameters, not RPC snapshots or proof that Elysium deployed those bytes.
const codes = fixture.codes as Record<RuntimeRole, Hex>;
const templateCodes = templateFixture.codes as Record<RuntimeRole, Hex>;
const templates = manifest.templates as RuntimeTemplate[];
const template = (role: RuntimeRole) => templates.find((item) => item.role === role)!;
function replaceBytes(code: Hex, start: number, replacement: Hex): Hex {
  return `0x${code.slice(2, 2 + start * 2)}${replacement.slice(2)}${code.slice(2 + start * 2 + replacement.length - 2)}`;
}
function flipByte(code: Hex, start: number): Hex {
  const value = Number.parseInt(code.slice(2 + start * 2, 4 + start * 2), 16) ^ 1;
  return replaceBytes(code, start, `0x${value.toString(16).padStart(2, '0')}`);
}
function mutateGroup(role: RuntimeRole, binding: string): Hex {
  const group = template(role).immutables.find((item) => item.binding === binding)!;
  let code = templateCodes[role];
  for (const ref of group.references) code = flipByte(code, ref.start + ref.length - 1);
  return code;
}

describe('v4 canonical runtime identity', () => {
  it('accepts all four exact official deployment runtimes and records the limited trust scope', () => {
    const result = assertRuntimeIdentity(codes);
    expect(result.verified).toBe(true);
    expect(result.evidence).toHaveLength(5);
    expect(result.evidence.at(-1)).toContain('RPC 诚实与当前链上状态');
    for (const item of templates) expect(matchesRuntimeTemplate(templateCodes[item.role], item)).toBe(true);
  });

  it('does not accept a different canonical npm build as the fixed deployed PositionManager', () => {
    expect(matchesRuntimeTemplate(templateCodes.manager, template('manager'))).toBe(true);
    expect(assertRuntimeIdentity({ ...codes, manager: templateCodes.manager }).verified).toBe(false);
  });

  it('pins every full runtime to its official creation provenance and independently observed manager hash', () => {
    for (const entry of manifest.exactDeployments) {
      const role=entry.role as RuntimeRole;
      expect(keccak256(codes[role])).toBe(entry.runtimeHash);
      expect((codes[role].length-2)/2).toBe(entry.runtimeBytes);
      expect(entry.chainId).toBe(CHAIN_ID);
      expect(entry.sourceURL).toContain('/Uniswap/contracts/');
      expect(entry.address.toLowerCase()).toBe(ADDRESSES[role].toLowerCase());
    }
    expect(manifest.exactDeployments.find(entry=>entry.role==='manager')?.runtimeHash).toBe(manifest.independentEvidence[0].runtimeHash);
  });

  it.each(['manager', 'poolManager', 'stateView', 'permit2'] as const)('rejects changed executable code in %s', (role) => {
    const changed = { ...codes, [role]: flipByte(codes[role], 0) };
    expect(assertRuntimeIdentity(changed).verified).toBe(false);
    expect(assertRuntimeIdentity(changed).evidence.some((line) => line.includes('禁止签名'))).toBe(true);
  });

  it.each([
    ['manager', 'poolManager'], ['manager', 'permit2'], ['manager', 'whype'],
    ['manager', 'chainId'], ['manager', 'posmName'], ['manager', 'posmDomain'],
    ['poolManager', 'poolManager'], ['stateView', 'poolManager'],
    ['permit2', 'chainId'], ['permit2', 'permit2Domain'],
  ] as const)('rejects wrong constructor binding %s.%s even when every copy agrees', (role, binding) => {
    expect(matchesRuntimeTemplate(mutateGroup(role, binding), template(role))).toBe(false);
  });

  it('does not permit one constructor copy to differ from another', () => {
    const desc = template('manager').immutables.find((item) => item.binding === 'descriptor')!;
    expect(desc.references.length).toBeGreaterThan(1);
    const changed = flipByte(templateCodes.manager, desc.references[0].start + 31);
    expect(matchesRuntimeTemplate(changed, template('manager'))).toBe(false);
  });

  it('rejects unknown, empty, malformed, truncated and extra runtime bytes', () => {
    for (const invalid of ['0x', '0x00', '0xabc', '0xzz', codes.manager.slice(0, -2), codes.manager + '00']) {
      expect(assertRuntimeIdentity({ ...codes, manager: invalid as Hex }).verified).toBe(false);
    }
    expect(assertRuntimeIdentity({ ...codes, manager: undefined as unknown as Hex }).verified).toBe(false);
  });

  it('fails closed on overlapping or out-of-range mask metadata', () => {
    const base = template('poolManager');
    const badRange: RuntimeTemplate = { ...base, immutables: [{ ...base.immutables[0], references: [{ start: base.byteLength, length: 32 }] }] };
    const duplicate = { ...base, immutables: [...base.immutables, base.immutables[0]] };
    expect(matchesRuntimeTemplate(templateCodes.poolManager, badRange)).toBe(false);
    expect(matchesRuntimeTemplate(templateCodes.poolManager, duplicate)).toBe(false);
  });

  it('rejects metadata and notification stipend from another deployment even when code matches', () => {
    const gasGroup = template('manager').immutables.find((item) => item.binding === 'unsubscribeGas')!;
    let changed = templateCodes.manager;
    const excessive = `0x${(2_000_001n).toString(16).padStart(64, '0')}` as Hex;
    for (const ref of gasGroup.references) changed = replaceBytes(changed, ref.start, excessive);
    expect(matchesRuntimeTemplate(changed, template('manager'))).toBe(false);
    const descriptor = template('manager').immutables.find((item) => item.binding === 'descriptor')!;
    changed = templateCodes.manager;
    for (const ref of descriptor.references) changed = replaceBytes(changed, ref.start, `0x${'ff'.repeat(32)}`);
    expect(matchesRuntimeTemplate(changed, template('manager'))).toBe(false);
  });

  it('binds configured addresses and every constructor field to the pinned official Elysium record', () => {
    expect(deploymentSource.chainId).toBe(CHAIN_ID);
    for (const [role, key] of [['manager','PositionManager'],['poolManager','PoolManager'],['stateView','StateView'],['permit2','Permit2']] as const) expect(ADDRESSES[role].toLowerCase()).toBe(deploymentSource.contracts[key].address.toLowerCase());
    for (const binding of ['descriptor','unsubscribeGas']) {
      const group=template('manager').immutables.find(item=>item.binding===binding)!;
      const ref=group.references[0];
      const value=BigInt(`0x${templateCodes.manager.slice(2+ref.start*2,2+(ref.start+ref.length)*2)}`);
      expect(value).toBe(BigInt(binding==='descriptor'?deploymentSource.positionManagerConstructor._tokenDescriptor:deploymentSource.positionManagerConstructor._unsubscribeGasLimit));
    }
    expect(deploymentSource.positionManagerConstructor._unsubscribeGasLimit).toBe('2000000');
  });

  it('keeps trusted artifact provenance pinned to official package integrity', () => {
    for (const item of manifest.templates) {
      expect(item.source.package).toMatch(/^@uniswap\/v4-(core|periphery)$/);
      expect(item.source.tarball).toMatch(/^https:\/\/registry\.npmjs\.org\/@uniswap\/v4-(core|periphery)\/-\/v4-(core|periphery)-\d+\.\d+\.\d+\.tgz$/);
      expect(item.source.integrity).toMatch(/^sha512-/);
    }
  });
});
