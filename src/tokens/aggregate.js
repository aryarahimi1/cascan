/**
 * src/tokens/aggregate.js
 *
 * Pure functions: Fulcrum listunspent UTXOs → per-category token summaries.
 * No I/O — fully unit-testable.
 *
 * CashTokens data model (from the Fulcrum probe):
 *   token_data.amount    — fungible amount, decimal STRING (can exceed 2^53)
 *   token_data.category  — 32-byte category id, hex
 *   token_data.nft       — { capability: 'none'|'mutable'|'minting',
 *                            commitment: hex } — present on NFT UTXOs
 */

const CATEGORY_RE = /^[0-9a-f]{64}$/;

export function isValidCategory(id) {
  return typeof id === 'string' && CATEGORY_RE.test(id.toLowerCase());
}

/**
 * @param {Array<{ tx_hash: string, tx_pos: number, value: number,
 *                 token_data?: { category: string, amount?: string,
 *                                nft?: { capability?: string, commitment?: string } } }>} utxos
 * @returns {Array<{
 *   category: string,
 *   ftAmount: string,     // raw integer string, pre-decimals
 *   nftCount: number,
 *   nfts: Array<{ capability: string|null, commitment: string|null, txid: string, vout: number }>,
 *   satsLocked: string,   // BCH dust riding in these UTXOs
 *   utxoCount: number,
 * }>}
 */
export function aggregateTokenUtxos(utxos) {
  const byCat = new Map();

  for (const u of utxos ?? []) {
    const td = u?.token_data;
    if (!td || typeof td.category !== 'string' || !CATEGORY_RE.test(td.category.toLowerCase())) continue;
    const category = td.category.toLowerCase();

    if (!byCat.has(category)) {
      byCat.set(category, {
        category,
        ftAmount: 0n,
        nftCount: 0,
        nfts: [],
        satsLocked: 0n,
        utxoCount: 0,
      });
    }
    const e = byCat.get(category);
    e.utxoCount++;

    // Server data is untrusted: malformed numerics are skipped, never thrown.
    try { e.satsLocked += BigInt(u.value ?? 0); } catch { /* skip */ }
    try {
      const amt = td.amount != null ? BigInt(td.amount) : 0n;
      if (amt > 0n) e.ftAmount += amt;
    } catch { /* skip malformed amount */ }

    if (td.nft) {
      e.nftCount++;
      e.nfts.push({
        capability: td.nft.capability ?? null,
        commitment: td.nft.commitment ?? null,
        txid: u.tx_hash ?? null,
        vout: u.tx_pos ?? null,
      });
    }
  }

  return [...byCat.values()]
    .map(e => ({ ...e, ftAmount: e.ftAmount.toString(), satsLocked: e.satsLocked.toString() }))
    // FT-heavy categories first, then NFT collections, then dust.
    .sort((a, b) =>
      Number(BigInt(b.ftAmount) > 0n) - Number(BigInt(a.ftAmount) > 0n) ||
      b.nftCount - a.nftCount ||
      b.utxoCount - a.utxoCount
    );
}

/**
 * Format a raw integer token amount with a decimals value (string math —
 * amounts routinely exceed Number.MAX_SAFE_INTEGER).
 *
 * @param {string} amountStr - raw integer string
 * @param {number|null} decimals
 * @returns {string}
 */
export function formatTokenAmount(amountStr, decimals) {
  const d = Number(decimals ?? 0);
  if (!Number.isInteger(d) || d < 0 || d > 18) return amountStr;
  if (d === 0) return amountStr;
  const padded = amountStr.padStart(d + 1, '0');
  const whole = padded.slice(0, -d);
  const frac = padded.slice(-d).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
