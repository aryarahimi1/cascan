/**
 * src/address.js
 *
 * BCH address handling: parse cashaddr or legacy input into a canonical
 * record with every representation derived — cashaddr, legacy base58check,
 * locking script, and the Fulcrum scripthash.
 *
 * cascan is a BCH-only tool, so legacy '1...'/'3...' input is treated as
 * BCH (the same strings exist on BTC — a warning is attached so output can
 * surface the ambiguity instead of hiding it).
 */

import { createHash } from 'node:crypto';
import { decodeCashAddr, encodeCashAddr } from './cashaddr.js';
import { base58CheckDecode, base58CheckEncode } from './base58.js';
import { getNetwork } from './networks.js';

export class AddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AddressError';
  }
}

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest();
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Build the locking script (scriptPubKey) for P2PKH, P2SH20, or P2SH32.
 * @param {'p2pkh'|'p2sh'} type
 * @param {Uint8Array} hash - 20 bytes for P2PKH/P2SH20, 32 bytes for P2SH32
 * @returns {Buffer}
 */
export function lockingScript(type, hash) {
  const h = Buffer.from(hash);
  if (type === 'p2pkh' && h.length === 20) {
    return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), h, Buffer.from([0x88, 0xac])]);
  }
  if (type === 'p2sh' && h.length === 20) {
    return Buffer.concat([Buffer.from([0xa9, 0x14]), h, Buffer.from([0x87])]);
  }
  if (type === 'p2sh' && h.length === 32) {
    return Buffer.concat([Buffer.from([0xaa, 0x20]), h, Buffer.from([0x87])]);
  }
  if (type === 'p2pkh') throw new AddressError(`lockingScript: P2PKH requires a 20-byte hash, got ${h.length}`);
  if (type === 'p2sh') throw new AddressError(`lockingScript: P2SH requires a 20-byte or 32-byte hash, got ${h.length}`);
  throw new AddressError(`lockingScript: unknown type ${type}`);
}

/**
 * Electrum-protocol scripthash: sha256(lockingScript), byte-reversed, hex.
 * @param {Buffer} script
 * @returns {string}
 */
export function scriptToScripthash(script) {
  return Buffer.from(sha256(script)).reverse().toString('hex');
}

/**
 * Parse any BCH address representation into a canonical record.
 *
 * Accepts:
 *   - cashaddr with prefix:  bitcoincash:qr7f...
 *   - cashaddr bare:         qr7f...        (mainnet prefix assumed)
 *   - legacy P2PKH / P2SH:   1BpEi... / 3CWF...
 *
 * @param {string} input
 * @returns {{
 *   input: string,
 *   type: 'p2pkh'|'p2sh',
 *   hash: Uint8Array,
 *   cashaddr: string,
 *   legacy: string|null,
 *   lockingScript: string,   // hex
 *   scripthash: string,      // Fulcrum/Electrum form
 *   format: 'cashaddr'|'legacy',
 *   tokenAware: boolean,
 *   warnings: string[],
 * }}
 */
export function parseAddress(input, opts = {}) {
  if (!input || typeof input !== 'string') {
    throw new AddressError('empty address');
  }
  const net = getNetwork(opts.network ?? 'mainnet');
  const trimmed = input.trim();
  const warnings = [];

  // 1) CashAddr (prefixed or bare — bare payloads assume the network prefix)
  const ca = decodeCashAddr(trimmed, { defaultPrefix: net.cashaddrPrefix });
  if (ca) {
    // Wrong-network addresses fail loudly: silently querying a mainnet
    // address on chipnet (or vice versa) would "work" and return zeros.
    if (ca.prefix !== net.cashaddrPrefix) {
      throw new AddressError(
        `address prefix "${ca.prefix}:" does not belong to ${net.name} ` +
        `(expected "${net.cashaddrPrefix}:") — pass the matching --network`
      );
    }
    return buildRecord(trimmed, ca.type, ca.hash, 'cashaddr', warnings, net, ca.tokenAware);
  }

  // 2) Legacy base58check (version bytes are network-specific)
  const leg = base58CheckDecode(trimmed);
  if (leg) {
    if (leg.version === net.legacyP2PKH) {
      warnings.push(
        'Legacy P2PKH format: this string is byte-identical on BTC and BCH. ' +
        'cascan treats it as BCH. Prefer the cashaddr (q...) format to avoid ambiguity.'
      );
      return buildRecord(trimmed, 'p2pkh', leg.hash, 'legacy', warnings, net);
    }
    if (leg.version === net.legacyP2SH) {
      warnings.push(
        'Legacy P2SH format: this string is byte-identical on BTC and BCH. ' +
        'cascan treats it as BCH. Prefer the cashaddr (p...) format to avoid ambiguity.'
      );
      return buildRecord(trimmed, 'p2sh', leg.hash, 'legacy', warnings, net);
    }
    throw new AddressError(
      `unsupported legacy address version byte 0x${leg.version.toString(16).padStart(2, '0')} ` +
      `for ${net.name} P2PKH/P2SH`
    );
  }

  throw new AddressError(
    `unrecognized address: ${JSON.stringify(trimmed)} — expected cashaddr (${net.cashaddrPrefix}:q... or bare q...) or legacy`
  );
}

function buildRecord(input, type, hash, format, warnings, net, tokenAware = false) {
  const script = lockingScript(type, hash);
  return {
    input,
    type,
    hash,
    network: net.name,
    tokenAware,
    cashaddr: encodeCashAddr(net.cashaddrPrefix, type, hash, { tokenAware }),
    legacy: hash.length === 20
      ? base58CheckEncode(type === 'p2pkh' ? net.legacyP2PKH : net.legacyP2SH, hash)
      : null,
    lockingScript: hex(script),
    scripthash: scriptToScripthash(script),
    format,
    warnings,
  };
}

/**
 * Convert between representations. Returns the same canonical record —
 * both forms are always present on it.
 */
export function convertAddress(input) {
  return parseAddress(input);
}
