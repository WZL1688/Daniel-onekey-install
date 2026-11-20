import { createHash } from 'node:crypto';
import { getAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';

// Data provenance is pinned. This module parses a tiny data grammar and never
// imports or executes the TypeScript downloaded from the public repository.
export const WORMHOLE_WRAPPED_URL = 'https://raw.githubusercontent.com/wormhole-foundation/wormhole-connect/267c9a649c74097cdbf5096d1d37cb45e7695a5b/src/config/mainnet/wrappedTokens.ts';
export const WORMHOLE_SOURCE_REF = 'https://github.com/wormhole-foundation/wormhole-connect/blob/267c9a649c74097cdbf5096d1d37cb45e7695a5b/src/config/mainnet/wrappedTokens.ts';
const invalid = () => Object.assign(new Error('官方包装资产映射格式无效，未执行任何远程代码'), { safe: true, code: 'DISCOVERY_FORMAT' });
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/** Only comments, keys, strings and nested objects are part of this grammar. */
function parseObjectData(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 256 * 1024) throw invalid();
  let position = 0, nodes = 0;
  const skip = () => {
    for (;;) {
      while (/\s/.test(source[position] || '') && position < source.length) position++;
      if (source.startsWith('//', position)) { const end = source.indexOf('\n', position + 2); position = end < 0 ? source.length : end + 1; }
      else if (source.startsWith('/*', position)) { const end = source.indexOf('*/', position + 2); if (end < 0) throw invalid(); position = end + 2; }
      else break;
    }
  };
  const take = expected => { skip(); if (!source.startsWith(expected, position)) throw invalid(); position += expected.length; };
  const identifier = () => {
    skip(); const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(position));
    if (!match || match[0].length > 100) throw invalid(); position += match[0].length; return match[0];
  };
  const string = () => {
    skip(); const quote = source[position++]; if (quote !== "'" && quote !== '"') throw invalid();
    let result = '', closed = false;
    while (position < source.length) {
      let character = source[position++];
      if (character === quote) { closed = true; break; }
      if (character === '\\') {
        const escaped = source[position++];
        if (["'", '"', '\\', '/'].includes(escaped)) character = escaped;
        else if (escaped === 'n') character = '\n';
        else if (escaped === 'r') character = '\r';
        else if (escaped === 't') character = '\t';
        else if (escaped === 'u') { const hex = source.slice(position, position + 4); if (!/^[0-9a-f]{4}$/i.test(hex)) throw invalid(); character = String.fromCharCode(parseInt(hex, 16)); position += 4; }
        else throw invalid();
      } else if (character.charCodeAt(0) < 32) throw invalid();
      result += character; if (result.length > 300) throw invalid();
    }
    if (!closed) throw invalid(); return result;
  };
  const object = depth => {
    if (depth > 4 || ++nodes > 20000) throw invalid();
    take('{'); const value = Object.create(null); skip();
    if (source[position] === '}') { position++; return value; }
    for (;;) {
      skip(); const key = ["'", '"'].includes(source[position]) ? string() : identifier();
      if (forbidden.has(key) || Object.hasOwn(value, key)) throw invalid();
      take(':'); skip();
      value[key] = source[position] === '{' ? object(depth + 1) : string();
      if (++nodes > 20000) throw invalid();
      skip();
      if (source[position] === '}') { position++; return value; }
      take(','); skip(); if (source[position] === '}') { position++; return value; }
    }
  };
  if (identifier() !== 'export' || identifier() !== 'const' || identifier() !== 'MAINNET_WRAPPED_TOKENS') throw invalid();
  take('='); const result = object(1); skip();
  if (source.startsWith('as', position)) { if (identifier() !== 'as' || identifier() !== 'const') throw invalid(); skip(); }
  if (source[position] === ';') position++;
  skip(); if (position !== source.length) throw invalid();
  return result;
}

function address(chain, value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  try {
    const result = chain === 'bnb' ? getAddress(value) : new PublicKey(value).toBase58();
    return chain === 'bnb' && /^0x0{40}$/i.test(result) ? null : result;
  } catch { return null; }
}
function originAddress(chain, value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.-]{1,300}$/.test(value)) return null;
  if (chain === 'Solana') return address('solana', value);
  if (/^0x[0-9a-f]{40}$/i.test(value)) return address('bnb', value)?.toLowerCase() || null;
  return value;
}

/** Same origin identity supplies candidate evidence, not an asset safety pass. */
export function normalizeWrappedMapping(source, { observedAt = Date.now(), limit = 100 } = {}) {
  if (!Number.isSafeInteger(observedAt) || observedAt < Date.UTC(2009, 0, 1) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const tree = parseObjectData(source), byOrigin = new Map(), conflicts = new Set(), claims = [];
  for (const [chain, origins] of Object.entries(tree)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,50}$/.test(chain) || typeof origins !== 'object' || !origins) throw invalid();
    for (const [rawOrigin, destinations] of Object.entries(origins)) {
      if (!destinations || typeof destinations !== 'object') throw invalid();
      if (Object.values(destinations).some(value => typeof value !== 'string')) throw invalid();
      const origin = originAddress(chain, rawOrigin); if (!origin) continue;
      const bnb = address('bnb', chain === 'Bsc' ? origin : destinations.Bsc);
      const solana = address('solana', chain === 'Solana' ? origin : destinations.Solana);
      if (!bnb || !solana) continue;
      // If an origin is redundantly supplied as its own destination, it must agree.
      if (chain === 'Bsc' && destinations.Bsc !== undefined && address('bnb', destinations.Bsc)?.toLowerCase() !== bnb.toLowerCase()) continue;
      if (chain === 'Solana' && destinations.Solana !== undefined && address('solana', destinations.Solana) !== solana) continue;
      const canonicalOrigin = `${chain}:${origin}`, identity = `wormhole:${createHash('sha256').update(canonicalOrigin).digest('hex').slice(0, 40)}`;
      const candidate = { id: identity, source: 'wormhole', sourceRef: WORMHOLE_SOURCE_REF,
        symbol: 'WRAPPED', name: `Wormhole ${chain} asset ${origin.length > 16 ? `${origin.slice(0, 8)}…${origin.slice(-4)}` : origin}`,
        chains: { bnb: { address: bnb }, solana: { address: solana } }, observedAt,
        evidenceKind: 'canonical-origin-map', riskNotice: '桥接包装资产，映射不是安全或可赎回证明', origin: { chain, address: origin } };
      const signature = `${bnb.toLowerCase()}:${solana}`, previous = byOrigin.get(identity);
      claims.push({ id: identity, signature, bnb: bnb.toLowerCase(), solana });
      if (previous && previous.signature !== signature) conflicts.add(identity);
      else if (!previous) byOrigin.set(identity, { candidate, signature });
    }
  }
  const pairs = new Map();
  for (const [id, entry] of byOrigin) if (!conflicts.has(id) && !pairs.has(entry.signature)) pairs.set(entry.signature, entry.candidate);
  const owners = new Map(), quarantinedPairs = new Set();
  // Keep evidence from conflicting origin aliases too; discarding an origin
  // first must not let an identical address pair re-enter through another alias.
  for (const claim of claims) {
    if (conflicts.has(claim.id)) quarantinedPairs.add(claim.signature);
    for (const [chain, token] of [['bnb', claim.bnb], ['solana', claim.solana]]) {
      const key = `${chain}:${token}`, previous = owners.get(key);
      if (previous && previous !== claim.signature) { quarantinedPairs.add(previous); quarantinedPairs.add(claim.signature); }
      else owners.set(key, claim.signature);
    }
  }
  return [...pairs.entries()].filter(([signature]) => !quarantinedPairs.has(signature)).map(([, candidate]) => candidate).slice(0, limit);
}
