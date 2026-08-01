/**
 * Security checks shared by wallet/signing adapters.
 */

import { parseRawTransaction, txidFromHex } from '../transaction/raw.js';

const ALREADY_KNOWN_RE = /already.in.(the.)?mempool|already known|already.in.block.?chain|ALREADY_EXISTS/i;

function sameToken(reported, actual) {
  if (reported == null || typeof reported !== 'object') return actual === null;
  if (actual === null) return false;
  try {
    if (String(reported.category).toLowerCase() !== actual.category) return false;
    if (BigInt(reported.amount ?? 0) !== actual.amount) return false;
  } catch {
    return false;
  }
  const reportedNft = reported.nft && typeof reported.nft === 'object' ? reported.nft : null;
  if (Boolean(reportedNft) !== Boolean(actual.nft)) return false;
  if (reportedNft) {
    if ((reportedNft.capability ?? 'none') !== actual.nft.capability) return false;
    if ((reportedNft.commitment ?? '').toLowerCase() !== actual.nft.commitment) return false;
  }
  return true;
}

export async function independentlyVerifiedRaw(cascan, txid) {
  if (typeof cascan?.verify !== 'function') {
    throw new Error('connected cascan instance does not support quorum verification');
  }
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
    throw new TypeError('transaction id must be 64 hexadecimal characters');
  }
  const normalizedTxid = txid.toLowerCase();
  const { value } = await cascan.verify(
    'blockchain.transaction.get',
    [normalizedTxid, false],
    { mode: 'majority', minAgreement: 2 }
  );
  if (typeof value !== 'string' || txidFromHex(value) !== normalizedTxid) {
    throw new Error(`verified raw transaction does not match requested txid ${normalizedTxid}`);
  }
  return value;
}

/**
 * Verify every signing candidate against independently-agreed raw funding
 * transactions, then compare value and the complete CashToken prefix.
 */
export async function verifyFundingUtxos(cascan, utxos, opts = {}) {
  if (!Array.isArray(utxos)) throw new Error('listunspent response must be an array');
  const txids = new Set();

  for (const utxo of utxos) {
    const txid = String(utxo?.tx_hash ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(utxo?.tx_pos) || utxo.tx_pos < 0) {
      throw new Error('listunspent returned an invalid outpoint');
    }
    txids.add(txid);
  }

  const ids = [...txids];
  const rawByTxid = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const txid = ids[next++];
      rawByTxid.set(txid, parseRawTransaction(await independentlyVerifiedRaw(cascan, txid)));
    }
  }));

  const expectedScript = opts.lockingBytecode == null
    ? null
    : Buffer.from(opts.lockingBytecode).toString('hex');

  for (const utxo of utxos) {
    const txid = utxo.tx_hash.toLowerCase();
    const output = rawByTxid.get(txid).outputs[utxo.tx_pos];
    if (!output) throw new Error(`funding output ${txid}:${utxo.tx_pos} does not exist`);

    let reportedValue;
    try { reportedValue = BigInt(utxo.value); } catch { throw new Error(`invalid value for ${txid}:${utxo.tx_pos}`); }
    if (reportedValue !== output.valueSatoshis) {
      throw new Error(`funding output value mismatch for ${txid}:${utxo.tx_pos}`);
    }
    if (!sameToken(utxo.token_data, output.token)) {
      throw new Error(`CashToken data mismatch for ${txid}:${utxo.tx_pos}`);
    }
    if (expectedScript !== null && output.lockingBytecode.toString('hex') !== expectedScript) {
      throw new Error(`locking bytecode mismatch for ${txid}:${utxo.tx_pos}`);
    }
  }
  return utxos;
}

/**
 * A server response is not propagation evidence. Return success only after
 * two matching servers can independently retrieve the exact raw tx.
 */
export async function broadcastAndVerify(cascan, txHex) {
  const txid = txidFromHex(txHex);
  let broadcastError = null;
  try {
    await cascan.request('blockchain.transaction.broadcast', [txHex]);
  } catch (err) {
    if (!ALREADY_KNOWN_RE.test(String(err?.message ?? err))) throw err;
    broadcastError = err;
  }

  let verificationError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await independentlyVerifiedRaw(cascan, txid);
      return txid;
    } catch (err) {
      verificationError = err;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }

  const err = new Error(`transaction broadcast was not independently verified: ${verificationError?.message ?? 'unknown verification failure'}`);
  err.name = 'TransactionPropagationError';
  err.cause = broadcastError ?? verificationError;
  throw err;
}
