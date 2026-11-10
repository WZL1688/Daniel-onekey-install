import { encodeAbiParameters, keccak256, padHex, stringToHex, toHex } from 'viem';
import type { Hex } from 'viem';
import manifest from './code-identities.json';
import deploymentSource from './deployment-source.json';
import { ADDRESSES, CHAIN_ID } from './config';

export type RuntimeRole = 'manager' | 'poolManager' | 'stateView' | 'permit2';
type Binding = 'poolManager' | 'whype' | 'permit2' | 'chainId' | 'posmDomain' | 'permit2Domain' | 'posmName' | 'descriptor' | 'unsubscribeGas';
export interface RuntimeTemplate {
  role: RuntimeRole;
  label: string;
  byteLength: number;
  maskedHash: Hex;
  immutables: { name: string; binding: Binding; references: { start: number; length: number }[] }[];
}

// This allowlist is built into the source. RPC responses, user acknowledgements,
// localStorage and caller-supplied fingerprints cannot add approved code.
const ROLES: readonly RuntimeRole[] = ['manager', 'poolManager', 'stateView', 'permit2'];
const LABELS: Record<RuntimeRole, string> = { manager: 'PositionManager', poolManager: 'PoolManager', stateView: 'StateView', permit2: 'Permit2' };
const DOMAIN_TYPE = keccak256(stringToHex('EIP712Domain(string name,uint256 chainId,address verifyingContract)'));

function domain(name: string, address: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [DOMAIN_TYPE, keccak256(stringToHex(name)), BigInt(CHAIN_ID), address],
  ));
}

const EXPECTED: Partial<Record<Binding, Hex>> = {
  poolManager: padHex(ADDRESSES.poolManager, { size: 32 }),
  permit2: padHex(ADDRESSES.permit2, { size: 32 }),
  whype: padHex(ADDRESSES.whype, { size: 32 }),
  chainId: toHex(CHAIN_ID, { size: 32 }),
  posmDomain: domain('Uniswap v4 Positions NFT', ADDRESSES.manager),
  permit2Domain: domain('Permit2', ADDRESSES.permit2),
  posmName: keccak256(stringToHex('Uniswap v4 Positions NFT')),
  descriptor: padHex(deploymentSource.positionManagerConstructor._tokenDescriptor as Hex, { size: 32 }),
  unsubscribeGas: toHex(BigInt(deploymentSource.positionManagerConstructor._unsubscribeGasLimit), { size: 32 }),
};

/** Check the immutable values before masking them. Every compiled copy of a
 * constructor immutable must agree. Critical addresses and cached EIP-712 chain
 * values are pinned, including the official deployment's descriptor and gas stipend.
 */
export function matchesRuntimeTemplate(code: Hex, template: RuntimeTemplate): boolean {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return false;
  if (!Number.isInteger(template.byteLength) || template.byteLength < 1 || template.byteLength > 24_576) return false;
  const data = code.slice(2).toLowerCase();
  if (data.length !== template.byteLength * 2 || !/^0x[0-9a-fA-F]{64}$/.test(template.maskedHash)) return false;
  let masked = data;
  const occupied = new Set<number>();
  for (const group of template.immutables) {
    if (!group.references.length) return false;
    let value: Hex | undefined;
    for (const ref of group.references) {
      if (!Number.isInteger(ref.start) || ref.start < 0 || ref.length !== 32 || ref.start + ref.length > template.byteLength) return false;
      for (let offset = ref.start; offset < ref.start + ref.length; offset++) {
        if (occupied.has(offset)) return false;
        occupied.add(offset);
      }
      const current = `0x${data.slice(ref.start * 2, (ref.start + ref.length) * 2)}` as Hex;
      if (value !== undefined && current !== value) return false;
      value = current;
      masked = masked.slice(0, ref.start * 2) + '0'.repeat(ref.length * 2) + masked.slice((ref.start + ref.length) * 2);
    }
    if (!value) return false;
    const expected = EXPECTED[group.binding];
    if (!expected || value !== expected.toLowerCase()) return false;
  }
  return keccak256(`0x${masked}`) === template.maskedHash;
}

/** Fixed-deployment verification requires the FULL runtime fingerprint derived
 * from the official published creation input at its actual address and chain.
 * A different generic npm build is never a fallback for this deployment.
 * RPC honesty, token upgrades and absence of all bugs remain separate concerns.
 */
export function assertRuntimeIdentity(codes: Record<RuntimeRole, Hex>): { verified: boolean; evidence: string[] } {
  const evidence: string[] = [];
  let verified = true;
  for (const role of ROLES) {
    const expected = manifest.exactDeployments.find((entry) => entry.role === role);
    const code = codes?.[role];
    const accepted = expected && typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code)
      && (code.length - 2) / 2 === expected.runtimeBytes && keccak256(code) === expected.runtimeHash;
    if (!accepted) {
      verified = false;
      evidence.push(`${LABELS[role]}：完整运行代码不匹配固定官方部署指纹，禁止签名。`);
    } else {
      evidence.push(`${LABELS[role]}：匹配固定官方部署记录的完整运行代码与构造参数。`);
    }
  }
  if (verified) evidence.push('通过的是返回代码的固定部署指纹核验；官方来源见固定记录，RPC 诚实与当前链上状态仍须独立核对。');
  return { verified, evidence };
}
