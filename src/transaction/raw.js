/**
 * Minimal, strict BCH transaction output decoder.
 *
 * Used at signing and payment trust boundaries so server-supplied verbose
 * JSON cannot hide CashToken prefixes or fabricate output values/scripts.
 */

import { createHash } from 'node:crypto';

/** txid = double-SHA256 of the raw transaction, byte-reversed, hex. */
export function txidFromHex(txHex) {
  if (typeof txHex !== 'string' || txHex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(txHex)) {
    throw new Error('raw transaction must be even-length hexadecimal');
  }
  const h1 = createHash('sha256').update(Buffer.from(txHex, 'hex')).digest();
  return createHash('sha256').update(h1).digest().reverse().toString('hex');
}

function take(buffer, cursor, length, label) {
  if (!Number.isSafeInteger(length) || length < 0 || cursor.offset + length > buffer.length) {
    throw new Error(`truncated ${label}`);
  }
  const out = buffer.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return out;
}

function readCompactSize(buffer, cursor, label) {
  const prefix = take(buffer, cursor, 1, label)[0];
  if (prefix < 0xfd) return BigInt(prefix);
  if (prefix === 0xfd) {
    const value = take(buffer, cursor, 2, label).readUInt16LE(0);
    if (value < 0xfd) throw new Error(`non-minimal ${label}`);
    return BigInt(value);
  }
  if (prefix === 0xfe) {
    const value = take(buffer, cursor, 4, label).readUInt32LE(0);
    if (value <= 0xffff) throw new Error(`non-minimal ${label}`);
    return BigInt(value);
  }
  const value = take(buffer, cursor, 8, label).readBigUInt64LE(0);
  if (value <= 0xffffffffn) throw new Error(`non-minimal ${label}`);
  return value;
}

function toLength(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds safe parser limits`);
  }
  return Number(value);
}

function decodeOutputPayload(payload) {
  if (payload[0] !== 0xef) {
    return { lockingBytecode: Buffer.from(payload), token: null };
  }

  const cursor = { offset: 1 };
  const category = Buffer.from(take(payload, cursor, 32, 'token category'))
    .reverse()
    .toString('hex');
  const bitfield = take(payload, cursor, 1, 'token bitfield')[0];
  const hasCommitment = (bitfield & 0x40) !== 0;
  const hasNft = (bitfield & 0x20) !== 0;
  const hasAmount = (bitfield & 0x10) !== 0;
  const capabilityCode = bitfield & 0x0f;

  if ((bitfield & 0x80) !== 0) throw new Error('token bitfield sets reserved bit');
  if (!hasNft && !hasAmount) throw new Error('token prefix encodes no tokens');
  if (hasCommitment && !hasNft) throw new Error('token commitment without NFT');
  if ((!hasNft && capabilityCode !== 0) || capabilityCode > 2) {
    throw new Error('invalid token NFT capability');
  }

  let commitment = Buffer.alloc(0);
  if (hasCommitment) {
    const length = readCompactSize(payload, cursor, 'token commitment length');
    if (length === 0n) throw new Error('token commitment length must be positive');
    commitment = Buffer.from(take(payload, cursor, toLength(length, 'token commitment length'), 'token commitment'));
  }

  let amount = 0n;
  if (hasAmount) {
    amount = readCompactSize(payload, cursor, 'fungible token amount');
    if (amount === 0n || amount > 0x7fffffffffffffffn) {
      throw new Error('fungible token amount out of range');
    }
  }

  const capabilities = ['none', 'mutable', 'minting'];
  return {
    lockingBytecode: Buffer.from(payload.subarray(cursor.offset)),
    token: {
      category,
      amount,
      ...(hasNft ? {
        nft: {
          capability: capabilities[capabilityCode],
          commitment: commitment.toString('hex'),
        },
      } : {}),
    },
  };
}

/**
 * @returns {{ outputs: Array<{ valueSatoshis: bigint,
 *   lockingBytecode: Buffer, token: object|null }> }}
 */
export function parseRawTransaction(txHex) {
  if (typeof txHex !== 'string' || txHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(txHex)) {
    throw new Error('raw transaction must be non-empty even-length hexadecimal');
  }
  const buffer = Buffer.from(txHex, 'hex');
  const cursor = { offset: 0 };

  take(buffer, cursor, 4, 'transaction version');
  const inputCount = toLength(readCompactSize(buffer, cursor, 'input count'), 'input count');
  for (let i = 0; i < inputCount; i++) {
    take(buffer, cursor, 36, `input ${i} outpoint`);
    const scriptLength = toLength(readCompactSize(buffer, cursor, `input ${i} bytecode length`), 'input bytecode length');
    take(buffer, cursor, scriptLength, `input ${i} bytecode`);
    take(buffer, cursor, 4, `input ${i} sequence`);
  }

  const outputCount = toLength(readCompactSize(buffer, cursor, 'output count'), 'output count');
  const outputs = [];
  for (let i = 0; i < outputCount; i++) {
    const valueSatoshis = take(buffer, cursor, 8, `output ${i} value`).readBigUInt64LE(0);
    const payloadLength = toLength(readCompactSize(buffer, cursor, `output ${i} payload length`), 'output payload length');
    const payload = take(buffer, cursor, payloadLength, `output ${i} payload`);
    outputs.push({ valueSatoshis, ...decodeOutputPayload(payload) });
  }

  take(buffer, cursor, 4, 'transaction locktime');
  if (cursor.offset !== buffer.length) throw new Error('trailing bytes after transaction locktime');
  return { outputs };
}
