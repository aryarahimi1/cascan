/**
 * src/history/ledger.js
 *
 * Pure ledger construction: verbose Fulcrum transactions → per-tx signed
 * balance deltas for one address. No I/O — the command layer fetches txs
 * (and their prevouts) and hands them in.
 *
 * Direction/fee semantics:
 *   receivedSats — sum of this tx's outputs paying the address
 *   spentSats    — sum of this tx's inputs whose prevouts belonged to it
 *   delta        — received − spent (signed; negative = funds left)
 *   type         — receive (delta > 0) · send (delta < 0, external outputs)
 *                  · self (all inputs AND outputs ours — delta is the fee)
 *   feeSats      — whole-tx fee (Σ prevouts − Σ outputs); reported only on
 *                  send/self rows where the address actually paid it
 */

/** BCH float from a verbose vout → satoshis BigInt (null on malformed). */
function valueToSats(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return BigInt(Math.round(v * 1e8));
}

/** All address strings on one output (handles both plural and singular field). */
function outputAddresses(vout) {
  const spk = vout?.scriptPubKey ?? {};
  if (Array.isArray(spk.addresses)) return spk.addresses;
  if (typeof spk.address === 'string') return [spk.address];
  return [];
}

/**
 * Build chronological ledger rows for one address.
 *
 * @param {Array<{ tx_hash: string, height: number }>} entries — confirmed history
 * @param {Map<string, object>} txByTxid — verbose txs, including every prevout
 *        tx referenced by the history txs' inputs
 * @param {Set<string>} addrMatches — address spellings that count as "ours"
 * @returns {{ rows: object[], warnings: string[] }}
 */
export function buildLedger(entries, txByTxid, addrMatches) {
  const rows = [];
  const warnings = [];

  for (const entry of entries) {
    const tx = txByTxid.get(entry.tx_hash);
    if (!tx) {
      warnings.push(`tx ${entry.tx_hash.slice(0, 10)}…: fetch failed — excluded from ledger`);
      continue;
    }

    let receivedSats = 0n;
    let outTotal = 0n;
    let outputsOursCount = 0;
    let malformed = false;

    for (const o of tx.vout ?? []) {
      const sats = valueToSats(o.value);
      if (sats === null) { malformed = true; continue; }
      outTotal += sats;
      if (outputAddresses(o).some(a => addrMatches.has(a))) {
        receivedSats += sats;
        outputsOursCount++;
      }
    }

    let spentSats = 0n;
    let inTotal = 0n;
    let inputsOursCount = 0;
    let inputCount = 0;
    let prevoutMissing = false;
    let coinbase = false;

    for (const vin of tx.vin ?? []) {
      if (vin.coinbase !== undefined) { coinbase = true; continue; }
      inputCount++;
      const prev = txByTxid.get(vin.txid);
      const prevOut = prev?.vout?.[vin.vout];
      const sats = prevOut ? valueToSats(prevOut.value) : null;
      if (sats === null) { prevoutMissing = true; continue; }
      inTotal += sats;
      if (outputAddresses(prevOut).some(a => addrMatches.has(a))) {
        spentSats += sats;
        inputsOursCount++;
      }
    }

    if (malformed || prevoutMissing) {
      warnings.push(
        `tx ${entry.tx_hash.slice(0, 10)}…: ${malformed ? 'malformed output value' : 'prevout unavailable'} — ` +
        `amounts for this tx may be incomplete`
      );
    }

    const delta = receivedSats - spentSats;
    const allInputsOurs = inputCount > 0 && inputsOursCount === inputCount && !prevoutMissing;
    const allOutputsOurs = (tx.vout ?? []).length > 0 && outputsOursCount === (tx.vout ?? []).length;

    let type;
    if (delta > 0n) type = 'receive';
    else if (allInputsOurs && allOutputsOurs) type = 'self';
    else type = 'send';

    // Fee is knowable only with every prevout in hand; report it on rows
    // where the address is the spender.
    const fee = (!coinbase && !prevoutMissing && inputCount > 0) ? inTotal - outTotal : null;
    const paysFee = type === 'send' || type === 'self';

    const timestamp = typeof tx.time === 'number' ? tx.time
                    : typeof tx.blocktime === 'number' ? tx.blocktime
                    : null;
    if (timestamp === null) {
      warnings.push(`tx ${entry.tx_hash.slice(0, 10)}…: no timestamp from server — excluded from ledger`);
      continue;
    }

    rows.push({
      txid: entry.tx_hash,
      height: entry.height,
      timestamp,
      isoTimestamp: new Date(timestamp * 1000).toISOString(),
      type,
      deltaSats: delta.toString(),
      amountBch: Number(delta < 0n ? -delta : delta) / 1e8,
      feeSats: paysFee && fee !== null && fee >= 0n ? fee.toString() : null,
      usdPrice: null,
      usdValue: null,
      costBasisUsd: null,
      proceedsUsd: null,
      realizedGainUsd: null,
      holdingPeriod: null,
      incomeUsd: null,
    });
  }

  rows.sort((a, b) => a.timestamp - b.timestamp || (a.height - b.height) || a.txid.localeCompare(b.txid));
  return { rows, warnings };
}
