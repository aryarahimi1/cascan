/**
 * src/base58.js
 *
 * Base58Check encode/decode for BCH legacy (P2PKH '1...' / P2SH '3...')
 * addresses. No external dependencies — uses node:crypto's sha256.
 *
 * Lineage: ported from glnc's src/chains/_base58check.js, extended with
 * encoding (glnc only needed verification; cascan converts both ways).
 */

import { createHash } from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const BASE58_INDEX = (() => {
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    map[BASE58_ALPHABET.charCodeAt(i)] = i;
  }
  return map;
})();

function sha256d(bytes) {
  const h1 = createHash('sha256').update(bytes).digest();
  return createHash('sha256').update(h1).digest();
}

/**
 * Decode a base58 string to bytes. Returns null on invalid input.
 * @param {string} str
 * @returns {Uint8Array | null}
 */
export function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) return null;

  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 128) return null;
    const v = BASE58_INDEX[code];
    if (v < 0) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }

  // Each leading '1' represents a leading zero byte.
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    bytes.push(0);
  }

  bytes.reverse();
  return Uint8Array.from(bytes);
}

/**
 * Encode bytes to a base58 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base58Encode(bytes) {
  if (!bytes || bytes.length === 0) return '';

  // Count leading zero bytes (each becomes a leading '1').
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Big-endian base-256 → base-58 conversion.
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

/**
 * Decode a base58check string. Returns { version, hash } for valid 21-byte
 * payloads (1 version byte + 20-byte hash), else null.
 *
 * @param {string} str
 * @returns {{ version: number, hash: Uint8Array } | null}
 */
export function base58CheckDecode(str) {
  const decoded = base58Decode(str);
  if (!decoded || decoded.length !== 25) return null;

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const h = sha256d(payload);
  for (let i = 0; i < 4; i++) {
    if (h[i] !== checksum[i]) return null;
  }
  return { version: decoded[0], hash: decoded.subarray(1, 21) };
}

/**
 * Encode a version byte + 20-byte hash as a base58check string.
 *
 * @param {number} version  - 0x00 (P2PKH) or 0x05 (P2SH)
 * @param {Uint8Array} hash - 20 bytes
 * @returns {string}
 */
export function base58CheckEncode(version, hash) {
  if (!hash || hash.length !== 20) throw new Error('base58CheckEncode: hash must be 20 bytes');
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(hash, 1);
  const h = sha256d(payload);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(h.subarray(0, 4), 21);
  return base58Encode(full);
}
