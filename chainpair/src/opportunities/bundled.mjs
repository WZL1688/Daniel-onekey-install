import { readFileSync } from 'node:fs';
import { validAddress } from './registry.mjs';

// Address metadata only: this file never supplies prices, approvals or balances.
export function bundledDirectory() {
  const record = JSON.parse(readFileSync(new URL('./data/wormhole-candidates.json', import.meta.url), 'utf8'));
  if (record.schema !== 1 || !Array.isArray(record.candidates) || record.candidates.length > 100) throw new Error('内置资产映射文件损坏');
  return record.candidates.map(row => {
    if (!/^wormhole:[a-f0-9]{40}$/.test(row.id)) throw new Error('内置资产映射身份无效');
    for (const chain of ['bnb','solana']) validAddress(chain, row.chains?.[chain]?.address);
    return structuredClone(row);
  });
}
