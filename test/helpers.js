import { txidFromHex } from '../src/transaction/raw.js';

export function compactSize(value) {
  const n = BigInt(value);
  if (n < 0xfdn) return Buffer.from([Number(n)]);
  if (n <= 0xffffn) {
    const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(Number(n), 1); return b;
  }
  if (n <= 0xffffffffn) {
    const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(Number(n), 1); return b;
  }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(n, 1); return b;
}

export function tokenPrefix({ category, amount = 0n, nft = null }) {
  let bitfield = amount > 0n ? 0x10 : 0;
  const parts = [Buffer.from([0xef]), Buffer.from(category, 'hex').reverse()];
  if (nft) {
    bitfield |= 0x20;
    const capability = { none: 0, mutable: 1, minting: 2 }[nft.capability ?? 'none'];
    bitfield |= capability;
    const commitment = Buffer.from(nft.commitment ?? '', 'hex');
    if (commitment.length > 0) bitfield |= 0x40;
    parts.push(Buffer.from([bitfield]));
    if (commitment.length > 0) parts.push(compactSize(commitment.length), commitment);
  } else {
    parts.push(Buffer.from([bitfield]));
  }
  if (amount > 0n) parts.push(compactSize(amount));
  return Buffer.concat(parts);
}

export function rawTransaction(outputs) {
  const version = Buffer.from('02000000', 'hex');
  const input = Buffer.concat([
    Buffer.alloc(32), Buffer.from('ffffffff', 'hex'),
    Buffer.from([0]), Buffer.from('ffffffff', 'hex'),
  ]);
  const encodedOutputs = outputs.map(({ value, lockingBytecode, token = null }) => {
    const sats = Buffer.alloc(8); sats.writeBigUInt64LE(BigInt(value));
    const script = Buffer.from(lockingBytecode);
    const payload = token ? Buffer.concat([tokenPrefix(token), script]) : script;
    return Buffer.concat([sats, compactSize(payload.length), payload]);
  });
  return Buffer.concat([
    version,
    compactSize(1), input,
    compactSize(encodedOutputs.length), ...encodedOutputs,
    Buffer.alloc(4),
  ]).toString('hex');
}

export function outpointForRaw(raw, vout, value, token_data) {
  return {
    tx_hash: txidFromHex(raw),
    tx_pos: vout,
    value: String(value),
    ...(token_data === undefined ? {} : { token_data }),
  };
}
