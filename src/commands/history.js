/**
 * src/commands/history.js
 *
 * cascan history <address> — full confirmed history as CSV (stdout or
 * --out file), optionally enriched with historical USD prices and FIFO
 * cost basis (--cost-basis fifo).
 *
 * Data plane: Fulcrum only. `get_history` lists the txids; each tx AND each
 * of its inputs' source txs are fetched verbose to compute signed deltas and
 * fees. No Chaingraph, no indexer, no API key — the same zero-dependency
 * posture as every other command. (The public Chaingraph instance was
 * unreachable at both probe dates; building on it would have made the one
 * tax-relevant command the one that silently breaks.)
 *
 * Attribution honesty: history runs on ONE persistent server connection
 * (a quorum fan-out of hundreds of tx fetches would hammer volunteer
 * servers). meta.sources.fulcrum says so; cross-check any single figure
 * with `cascan tx <txid> --quorum all`.
 */

import { writeFile } from 'node:fs/promises';
import { parseAddress } from '../address.js';
import { connectPool } from '../pool/resolve.js';
import { serverOverride } from '../fulcrum/servers.js';
import { buildLedger } from '../history/ledger.js';
import { getHistoricalBchPrices } from '../history/prices_history.js';
import { computeCostBasis } from '../history/cost_basis.js';
import { rowsToCsv } from '../history/csv.js';
import { SCHEMA } from '../output/schemas.js';
import { wrap } from '../output/envelope.js';
import { emitJSON } from '../output/emit.js';
import { shortenCashaddr, sanitize } from '../cli/render.js';
import { gray, cyan, yellow } from '../cli/theme.js';

const FETCH_CONCURRENCY = 8;
const LARGE_HISTORY_WARN = 500;

/** Map with bounded concurrency; failures land as nulls (caller warns). */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]).catch(() => null);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function cmdHistory(parsed) {
  const rec = parseAddress(parsed.target, { network: parsed.network });
  const chatter = (s) => { if (!parsed.json) process.stderr.write(gray(s + '\n')); };

  // Pooled connection: hundreds of sequential tx fetches survive a
  // mid-history server death by failing over instead of aborting.
  const { pool } = await connectPool({ servers: serverOverride(parsed.server) ?? undefined, network: parsed.network });
  const warnings = [...rec.warnings];
  pool.on('failover', f => chatter(`  ! server ${sanitize(String(f.from))} lost — failed over to ${sanitize(String(f.to))}`));

  try {
    const hist = await pool.request('blockchain.address.get_history', [rec.cashaddr]);

    const confirmed = (hist ?? []).filter(h => h.height > 0);
    const mempoolCount = (hist ?? []).length - confirmed.length;
    if (mempoolCount > 0) {
      warnings.push(`${mempoolCount} unconfirmed tx(s) excluded — history covers confirmed transactions only`);
    }
    if (confirmed.length > LARGE_HISTORY_WARN) {
      chatter(`  large history (${confirmed.length} txs) — fetching transactions + prevouts, this can take a while`);
    }
    chatter(`  ${shortenCashaddr(rec.cashaddr)} via ${cyan(sanitize(String(pool.current)))} — ${confirmed.length} confirmed txs`);

    // Pass 1: every history tx, verbose.
    const txByTxid = new Map();
    const fetched = await mapLimit(confirmed, FETCH_CONCURRENCY,
      h => pool.request('blockchain.transaction.get', [h.tx_hash, true]));
    confirmed.forEach((h, i) => { if (fetched[i]) txByTxid.set(h.tx_hash, fetched[i]); });

    // Pass 2: every distinct prevout tx not already in hand.
    const prevoutIds = new Set();
    for (const tx of txByTxid.values()) {
      for (const vin of tx.vin ?? []) {
        if (vin.coinbase === undefined && typeof vin.txid === 'string' && !txByTxid.has(vin.txid)) {
          prevoutIds.add(vin.txid);
        }
      }
    }
    if (prevoutIds.size > 0) {
      chatter(`  resolving ${prevoutIds.size} input source tx(s)`);
      const ids = [...prevoutIds];
      const prevs = await mapLimit(ids, FETCH_CONCURRENCY,
        id => pool.request('blockchain.transaction.get', [id, true]));
      ids.forEach((id, i) => { if (prevs[i]) txByTxid.set(id, prevs[i]); });
    }

    // Ledger
    const addrMatches = new Set([rec.cashaddr, rec.cashaddr.split(':')[1], rec.legacy]);
    const ledger = buildLedger(confirmed, txByTxid, addrMatches);
    warnings.push(...ledger.warnings);
    let rows = ledger.rows;

    // Date-range filter (inclusive, UTC days)
    if (parsed.from) {
      const fromSec = Date.parse(parsed.from + 'T00:00:00Z') / 1000;
      rows = rows.filter(r => r.timestamp >= fromSec);
    }
    if (parsed.to) {
      const toSec = Date.parse(parsed.to + 'T23:59:59.999Z') / 1000;
      rows = rows.filter(r => r.timestamp <= toSec);
    }

    // Historical USD prices (deduped per UTC day, rate-limit-gated)
    let pricesOk = true;
    if (!parsed.noPrices && rows.length > 0) {
      const days = new Set(rows.map(r => r.isoTimestamp.slice(0, 10)));
      chatter(`  fetching USD prices for ${days.size} day(s) — Kraken dailies + CoinGecko fallback, no API key`);
      const priceMap = await getHistoricalBchPrices(
        rows.map(r => r.timestamp),
        { onWarn: (m) => { warnings.push(m); pricesOk = false; } }
      );
      for (const r of rows) {
        const usd = priceMap.get(r.timestamp) ?? null;
        r.usdPrice = usd;
        r.usdValue = usd != null ? r.amountBch * usd : null;
        if (usd == null) pricesOk = false;
      }
    }

    // FIFO cost basis
    if (parsed.costBasis === 'fifo') {
      if (parsed.noPrices) {
        warnings.push('--cost-basis fifo with --no-prices: all bases/proceeds are unknown — output is lot bookkeeping only');
      }
      if (parsed.from) {
        warnings.push(`--cost-basis fifo with --from ${parsed.from}: lots acquired before the range are invisible (disposals may show basis 0)`);
      }
      const cb = computeCostBasis(rows, { method: 'fifo' });
      warnings.push(...cb.warnings);
    }

    // Summary + meta
    const totals = rows.reduce((acc, r) => {
      const d = BigInt(r.deltaSats);
      if (d > 0n) acc.receivedSats += d; else acc.sentSats -= d;
      if (r.realizedGainUsd != null) acc.realizedGainUsd += r.realizedGainUsd;
      return acc;
    }, { receivedSats: 0n, sentSats: 0n, realizedGainUsd: 0 });

    const meta = {
      sources: {
        fulcrum: {
          ok: true,
          answered: pool.current,
          note: 'history runs single-server for volume; cross-check figures with cascan tx <txid> --quorum all',
        },
        ...(parsed.noPrices ? {} : { prices: { ok: pricesOk, provider: 'kraken+coingecko', endpoint: 'historical-daily', note: 'keyless coverage ≈ 2 years (kraken) / 365 days (coingecko); older rows have empty usd_value' } }),
      },
      partial: !pricesOk && !parsed.noPrices,
      warnings,
    };

    // Output
    if (parsed.json) {
      const data = {
        address: { input: rec.input, cashaddr: rec.cashaddr, legacy: rec.legacy },
        rows,
        summary: {
          txCount: rows.length,
          receivedSats: totals.receivedSats.toString(),
          sentSats: totals.sentSats.toString(),
          costBasis: parsed.costBasis,
          ...(parsed.costBasis === 'fifo' ? { realizedGainUsd: totals.realizedGainUsd } : {}),
        },
      };
      emitJSON(wrap(SCHEMA.HISTORY, data, meta));
    } else {
      const csv = rowsToCsv(rows);
      if (parsed.out) {
        await writeFile(parsed.out, csv);
        chatter(`  wrote ${rows.length} rows → ${parsed.out}`);
      } else {
        process.stdout.write(csv);
      }
      chatter(`  received ${fmtBchStr(totals.receivedSats)} · sent ${fmtBchStr(totals.sentSats)} BCH across ${rows.length} rows` +
        (parsed.costBasis === 'fifo' ? ` · realized gain $${totals.realizedGainUsd.toFixed(2)}` : ''));
      for (const w of warnings) process.stderr.write(yellow(`! ${w}\n`));
    }

    return { exitCode: parsed.strict && meta.partial ? 3 : 0 };
  } finally {
    pool.close();
  }
}

function fmtBchStr(sats) {
  return (Number(sats) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}
