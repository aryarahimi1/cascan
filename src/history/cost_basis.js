/**
 * src/history/cost_basis.js
 *
 * FIFO cost-basis computation for BCH history rows.
 *
 * Walks rows in chronological order, tracks acquisition lots in a queue,
 * and for each disposal pops lots FIFO to compute:
 *
 *   costBasisUsd, proceedsUsd, realizedGainUsd, holdingPeriod
 *
 * Row semantics (single asset — BCH):
 *   receive (delta > 0) → push a lot; usdValue at receipt is the basis and
 *                         is also surfaced as incomeUsd (ordinary income at
 *                         FMV on receipt — Rev. Rul. 2019-24 / 2023-14; the
 *                         taxpayer decides whether it applies).
 *   send / self (delta < 0) → dispose abs(delta) BCH. The network fee is
 *                         part of the disposed amount (simplest defensible
 *                         default; a `self` row's delta IS the fee).
 *
 * Conservative on edge cases — missing basis lands as 0 (taxpayer overpays
 * vs underpays) and surfaces as a warning.
 *
 * Lineage: ported from glnc's src/history/cost_basis.js, reduced to the
 * single-asset UTXO case. FIFO only, USD only.
 */

const LONG_TERM_THRESHOLD_SEC = 365 * 86400;

/** @returns {'short'|'long'} */
function classifyHolding(acquiredAt, disposedAt) {
  return (disposedAt - acquiredAt) > LONG_TERM_THRESHOLD_SEC ? 'long' : 'short';
}

/**
 * Pop up to `amount` BCH from the lot queue FIFO. Mutates the queue.
 *
 * @param {Array<{quantity:number, costBasisPerUnit:number, acquiredAt:number}>} queue
 * @param {number} amount
 * @param {number} disposedAt - unix seconds
 * @returns {{ costBasis: number, unbased: number, holdings: Array<'short'|'long'> }}
 */
export function popFifo(queue, amount, disposedAt) {
  let remaining = amount;
  let costBasis = 0;
  /** @type {Array<'short'|'long'>} */
  const holdings = [];

  while (remaining > 0 && queue.length > 0) {
    const EPS = Math.max(1e-9, Math.abs(remaining) * 1e-12);
    if (remaining <= EPS) break;
    const lot = queue[0];
    if (lot.quantity <= remaining + EPS) {
      costBasis += lot.quantity * lot.costBasisPerUnit;
      holdings.push(classifyHolding(lot.acquiredAt, disposedAt));
      remaining -= lot.quantity;
      queue.shift();
    } else {
      costBasis += remaining * lot.costBasisPerUnit;
      holdings.push(classifyHolding(lot.acquiredAt, disposedAt));
      lot.quantity -= remaining;
      remaining = 0;
    }
  }

  return { costBasis, unbased: Math.max(0, remaining), holdings };
}

/** @returns {'short'|'long'|'mixed'|null} */
function summarizeHoldings(holdings) {
  if (holdings.length === 0) return null;
  const set = new Set(holdings);
  if (set.size === 1) return holdings[0];
  return 'mixed';
}

/**
 * Walk rows in chronological order and annotate each disposal with
 * cost-basis fields. Mutates `rows` in place.
 *
 * @param {Array<{
 *   txid: string, timestamp: number, type: 'receive'|'send'|'self',
 *   deltaSats: string, usdPrice: number|null, usdValue: number|null,
 * }>} rows — chronological, price-enriched
 * @param {{ method?: 'fifo'|'none' }} [opts]
 * @returns {{ warnings: string[] }}
 */
export function computeCostBasis(rows, opts = {}) {
  const method = opts.method ?? 'none';
  if (method === 'none') return { warnings: [] };
  if (method !== 'fifo') {
    return { warnings: [`unsupported cost-basis method "${method}"; expected "fifo" or "none"`] };
  }

  /** @type {Array<{quantity:number, costBasisPerUnit:number, acquiredAt:number}>} */
  const queue = [];
  const warnings = [];
  const shortId = t => (typeof t === 'string' && t.length > 10) ? `${t.slice(0, 10)}…` : (t ?? '?');

  for (const row of rows) {
    const deltaSats = Number(row.deltaSats);
    if (!Number.isFinite(deltaSats) || deltaSats === 0) continue;
    const amountBch = Math.abs(deltaSats) / 1e8;

    if (deltaSats > 0) {
      // ── Acquisition ──────────────────────────────────────────────────
      const usdValue = row.usdValue;
      const hasUsd = usdValue != null && Number.isFinite(usdValue);
      queue.push({
        quantity: amountBch,
        costBasisPerUnit: hasUsd ? usdValue / amountBch : 0,
        acquiredAt: row.timestamp,
      });
      if (hasUsd) row.incomeUsd = usdValue;
      else {
        warnings.push(
          `tx ${shortId(row.txid)}: received ${amountBch} BCH but USD value at receipt ` +
          `is unknown (cost basis recorded as 0)`
        );
      }
    } else {
      // ── Disposal ─────────────────────────────────────────────────────
      const proceedsUsd = (row.usdValue != null && Number.isFinite(row.usdValue)) ? row.usdValue : null;
      const { costBasis, unbased, holdings } = popFifo(queue, amountBch, row.timestamp);

      row.costBasisUsd = costBasis;
      row.proceedsUsd = proceedsUsd;
      row.realizedGainUsd = proceedsUsd === null ? null : proceedsUsd - costBasis;
      row.holdingPeriod = summarizeHoldings(holdings);

      if (unbased > 1e-9) {
        warnings.push(
          `tx ${shortId(row.txid)}: disposed ${unbased.toFixed(8)} BCH with no prior basis ` +
          `(received before --from, or outside this address; basis recorded as 0 — verify before filing)`
        );
      }
      if (proceedsUsd === null) {
        warnings.push(
          `tx ${shortId(row.txid)}: disposed ${amountBch} BCH but USD value at disposal ` +
          `is unknown (proceeds = null)`
        );
      }
    }
  }

  return { warnings };
}
