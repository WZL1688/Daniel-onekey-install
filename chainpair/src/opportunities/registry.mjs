import { randomUUID } from 'node:crypto';
import { getAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { WORMHOLE_SOURCE_REF } from './wormhole.mjs';

export const opportunityError = message => Object.assign(new Error(message), { safe: true });
export const publicText = (value, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
export const sameAddress = (chain, a, b) => typeof a === 'string' && typeof b === 'string' && (chain === 'bnb' ? a.toLowerCase() === b.toLowerCase() : a === b);
export function validAddress(chain, value, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return '';
  if (!['bnb', 'solana'].includes(chain) || typeof value !== 'string' || value.length > 100) throw opportunityError('同币清单的链或地址无效');
  try {
    const address = chain === 'bnb' ? getAddress(value.trim()) : new PublicKey(value.trim()).toBase58();
    if (chain === 'bnb' && /^0x0{40}$/i.test(address)) throw Error();
    return address;
  } catch { throw opportunityError('同币清单的地址格式无效'); }
}
export function validId(value) {
  if (typeof value !== 'string' || !/^(?:manual:[A-Za-z0-9_-]{1,100}|(?:coingecko|coinpaprika):[a-z0-9-]{1,100}|project:babydoge|wormhole:[a-f0-9]{40})$/.test(value)) throw opportunityError('同币条目标识无效');
  return value;
}
export function decimals(chain, value, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (!Number.isInteger(value) || value < 0 || value > (chain === 'solana' ? 9 : 36)) throw opportunityError('代币精度无效，请核对两链元数据');
  return value;
}
export function normalizeAsset(input, { previous, now = Date.now(), directory = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw opportunityError('同币条目格式无效');
  const id = input.id ? validId(input.id) : previous?.id || `manual:${randomUUID()}`;
  const source = id.split(':')[0];
  if (!previous && source !== 'manual' && !directory) throw opportunityError('自动目录条目须先通过目录发现');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw opportunityError('同币条目开关无效');
  const chains = {};
  for (const chain of ['bnb', 'solana']) {
    const c = input.chains?.[chain] || {}, old = previous?.chains?.[chain] || {};
    chains[chain] = {
      address: validAddress(chain, c.address ?? old.address),
      decimals: decimals(chain, c.decimals === undefined ? old.decimals : c.decimals, true),
      poolAddress: validAddress(chain, c.poolAddress === undefined ? old.poolAddress : c.poolAddress, true),
    };
  }
  const changed = !previous || ['bnb', 'solana'].some(chain => !sameAddress(chain, previous.chains[chain].address, chains[chain].address) || previous.chains[chain].decimals !== chains[chain].decimals || !sameAddress(chain, previous.chains[chain].poolAddress, chains[chain].poolAddress));
  return {
    id, name: publicText(input.name === undefined ? previous?.name : input.name, 100), symbol: publicText(input.symbol === undefined ? previous?.symbol : input.symbol, 32), source,
    sourceRef: source === 'coingecko' ? `https://www.coingecko.com/en/coins/${id.slice(10)}` : source === 'coinpaprika' ? `https://coinpaprika.com/coin/${id.slice(12)}` : source === 'project' ? 'https://babydoge.com/transparency/' : source === 'wormhole' ? WORMHOLE_SOURCE_REF : '',
    sourceKind: source === 'wormhole' ? (input.sourceKind || previous?.sourceKind) === 'bundled' ? 'bundled' : 'remote' : source === 'project' ? 'issuer-snapshot' : source === 'manual' ? 'manual' : 'remote',
    sourceDate: source === 'wormhole' ? '2026-04-08' : source === 'project' ? '2026-11-22' : null,
    origin: source === 'wormhole' ? { chain: publicText(input.origin?.chain || previous?.origin?.chain, 40), address: publicText(input.origin?.address || previous?.origin?.address, 100) } : null,
    riskNotice: source === 'wormhole' ? '桥接包装资产；官方映射快照不证明安全、可赎回或当前流动性' : source === 'project' ? '发行方公布的双链地址快照；仍须核验数量关系、税费与可卖出性' : source === 'coinpaprika' ? '共享目录 ID 仅作候选依据，不证明资产可赎回或无税费' : '',
    enabled: input.enabled ?? previous?.enabled ?? true, chains,
    mapping: changed ? { confirmed: false, evidence: '', warning: '' } : { confirmed: previous?.mapping?.confirmed === true, evidence: publicText(previous?.mapping?.evidence, 1000), warning: publicText(previous?.mapping?.warning, 200) },
    revision: (previous?.revision || 0) + 1,
    createdAt: previous?.createdAt || now, updatedAt: now,
    sourceObservedAt: directory ? now : previous?.sourceObservedAt || null,
    sourceProposal: changed ? null : previous?.sourceProposal || null,
  };
}
export function registryConflictIds(assets) {
  const identities = new Map(), conflicts = new Set();
  for (const asset of assets.filter(a => a.enabled)) for (const chain of ['bnb', 'solana']) {
    const key = `${chain}:${chain === 'bnb' ? asset.chains[chain].address.toLowerCase() : asset.chains[chain].address}`;
    const prior = identities.get(key);
    if (prior && prior !== asset.id) { conflicts.add(prior); conflicts.add(asset.id); } else identities.set(key, asset.id);
  }
  return conflicts;
}

