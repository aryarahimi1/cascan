/**
 * src/cashaddr.js
 *
 * CashAddr codec for Bitcoin Cash (spec: https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md).
 * No external dependencies.
 *
 * CashAddr reuses the bech32 charset but with a 40-bit polymod checksum
 * (8 checksum symbols instead of 6) and a version byte encoding
 * (type bits << 3) | size bits. Types 0/1 are P2PKH/P2SH; types 2/3
 * are their token-aware CashTokens equivalents.
 *
 * The polymod accumulator is 40 bits, which overflows JS's 32-bit bitwise
 * operators — all checksum arithmetic is done in BigInt.
 *
 * Exports:
 *   decodeCashAddr(str)          → { prefix, type, hash } | null
 *   encodeCashAddr(prefix, type, hash) → string
 *   isValidCashAddr(str)         → boolean
 *   DEFAULT_PREFIX = 'bitcoincash'
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARSET_INDEX = (() => {
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < CHARSET.length; i++) map[CHARSET.charCodeAt(i)] = i;
  return map;
})();

export const DEFAULT_PREFIX = 'bitcoincash';

// 40-bit generators (5 × 35-bit values), from the cashaddr spec.
const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function polymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) {
      if ((c0 >> BigInt(i)) & 1n) c ^= GENERATORS[i];
    }
  }
  return c ^ 1n;
}

function expandPrefix(prefix) {
  const out = [];
  for (let i = 0; i < prefix.length; i++) out.push(prefix.charCodeAt(i) & 0x1f);
  out.push(0);
  return out;
}

function createChecksum(prefix, payload) {
  const enc = [...expandPrefix(prefix), ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const mod = polymod(enc);
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(Number((mod >> BigInt(5 * (7 - i))) & 0x1fn));
  }
  return out;
}

function verifyChecksum(prefix, payloadWithChecksum) {
  return polymod([...expandPrefix(prefix), ...payloadWithChecksum]) === 0n;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    if (v < 0 || (v >> fromBits) !== 0) return null;
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

// Version byte: (typeBits << 3) | sizeBits
const TYPE_BITS = { p2pkh: 0, p2sh: 1 };
const TYPE_INFO = Object.freeze({
  0: Object.freeze({ type: 'p2pkh', tokenAware: false }),
  1: Object.freeze({ type: 'p2sh', tokenAware: false }),
  2: Object.freeze({ type: 'p2pkh', tokenAware: true }),
  3: Object.freeze({ type: 'p2sh', tokenAware: true }),
});
const SIZE_BITS_BY_LENGTH = { 20: 0, 24: 1, 28: 2, 32: 3, 40: 4, 48: 5, 56: 6, 64: 7 };
const LENGTH_BY_SIZE_BITS = [20, 24, 28, 32, 40, 48, 56, 64];

/**
 * Decode a cashaddr string (with or without prefix). Bare payloads are
 * interpreted under `defaultPrefix` (mainnet 'bitcoincash').
 *
 * @param {string} str
 * @param {{ defaultPrefix?: string }} [opts]
 * @returns {{ prefix: string, type: 'p2pkh'|'p2sh', tokenAware: boolean,
 *   hash: Uint8Array, cashaddr: string } | null}
 */
export function decodeCashAddr(str, opts = {}) {
  if (typeof str !== 'string' || str.length === 0) return null;
  const defaultPrefix = opts.defaultPrefix ?? DEFAULT_PREFIX;

  // Must be all-lowercase or all-uppercase.
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
  const lower = str.toLowerCase();

  let prefix, payload;
  const sep = lower.indexOf(':');
  if (sep !== -1) {
    prefix = lower.slice(0, sep);
    payload = lower.slice(sep + 1);
    if (prefix.length === 0) return null;
  } else {
    prefix = defaultPrefix;
    payload = lower;
  }
  if (payload.length < 8) return null;

  const values = [];
  for (const ch of payload) {
    const code = ch.charCodeAt(0);
    if (code >= 128) return null;
    const idx = CHARSET_INDEX[code];
    if (idx < 0) return null;
    values.push(idx);
  }

  if (!verifyChecksum(prefix, values)) return null;

  const data = values.slice(0, -8);
  const bytes = convertBits(data, 5, 8, false);
  if (!bytes || bytes.length < 1) return null;

  const version = bytes[0];
  if ((version & 0x80) !== 0) return null; // CashAddr reserved bit
  const typeBits = (version >> 3) & 0x0f;
  const sizeBits = version & 0x07;
  const hashLen = LENGTH_BY_SIZE_BITS[sizeBits];
  const hash = Uint8Array.from(bytes.slice(1));

  if (hash.length !== hashLen) return null;
  const typeInfo = TYPE_INFO[typeBits];
  if (!typeInfo) return null;

  return { ...typeInfo, prefix, hash, cashaddr: `${prefix}:${payload}` };
}

/**
 * Encode a type + 20-byte hash as a cashaddr string.
 *
 * @param {string} prefix  - e.g. 'bitcoincash'
 * @param {'p2pkh'|'p2sh'} type
 * @param {Uint8Array} hash - 20 bytes for standard P2PKH/P2SH20, or 32
 *   bytes for P2SH32
 * @param {{ tokenAware?: boolean }} [opts]
 * @returns {string}
 */
export function encodeCashAddr(prefix, type, hash, opts = {}) {
  const typeBits = TYPE_BITS[type];
  if (typeBits === undefined) throw new Error(`unknown cashaddr type: ${type}`);
  const sizeBits = SIZE_BITS_BY_LENGTH[hash.length];
  if (sizeBits === undefined) throw new Error(`unsupported hash length: ${hash.length}`);

  const version = ((typeBits + (opts.tokenAware === true ? 2 : 0)) << 3) | sizeBits;
  const payload = convertBits([version, ...hash], 8, 5, true);
  const checksum = createChecksum(prefix, payload);
  const str = [...payload, ...checksum].map(v => CHARSET[v]).join('');
  return `${prefix}:${str}`;
}

/**
 * @param {string} str
 * @returns {boolean}
 */
export function isValidCashAddr(str) {
  return decodeCashAddr(str) !== null;
}
