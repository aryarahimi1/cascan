/**
 * src/commands/gas.js
 *
 * cascan gas — BCH fee market: estimatefee tiers, relay fee, mempool depth.
 * Single-server 'any' semantics (fee data doesn't benefit from quorum the
 * way balances do); the answering server is still attributed in meta.
 */

import { connectPool } from '../pool/resolve.js';
import { serverOverride } from '../fulcrum/servers.js';
import { SCHEMA } from '../output/schemas.js';
import { wrap } from '../output/envelope.js';
import { renderGas } from '../cli/render.js';

/** estimatefee returns BCH/kB; convert to sats/byte. -1 means "no estimate". */
function feeToSatsPerByte(bchPerKb) {
  if (typeof bchPerKb !== 'number' || bchPerKb <= 0) return null;
  // sats/kB is an integer in reality — round there so float drift from the
  // multiply never leaks into the envelope (0.00001 * 1e8 = 1000.0000000000001).
  return Math.round(bchPerKb * 1e8) / 1000;
}

export async function cmdGas(parsed) {
  const { pool } = await connectPool({ servers: serverOverride(parsed.server) ?? undefined, network: parsed.network });
  try {
    const [hist, est1, est3, est6, relay, tip] = await Promise.all([
      pool.request('blockchain.mempool.get_fee_histogram').catch(() => null),
      pool.request('blockchain.estimatefee', [1]).catch(() => null),
      pool.request('blockchain.estimatefee', [3]).catch(() => null),
      pool.request('blockchain.estimatefee', [6]).catch(() => null),
      pool.request('blockchain.relayfee').catch(() => null),
      pool.request('blockchain.headers.subscribe').catch(() => null),
    ]);

    const tiers = [
      ['next block', feeToSatsPerByte(est1)],
      ['3 blocks', feeToSatsPerByte(est3)],
      ['6 blocks', feeToSatsPerByte(est6)],
    ];
    const mempoolVsize = Array.isArray(hist)
      ? hist.reduce((s, pair) => s + (Array.isArray(pair) ? Number(pair[1]) || 0 : 0), 0)
      : null;

    const data = {
      tiers: tiers.map(([target, satsPerByte]) => ({ target, satsPerByte })),
      relaySatsPerByte: feeToSatsPerByte(relay),
      mempoolVsize,
      histogram: Array.isArray(hist) ? hist : null,
      height: tip?.height ?? null,
    };

    // partial when any fee component failed — no silent gaps.
    const feesMissing = [est1, est3, est6, relay].every(v => v == null);
    const meta = {
      sources: {
        fulcrum: { ok: true, answered: pool.current, height: data.height, servers: [], disagreements: [], degraded: [] },
      },
      partial: feesMissing,
      warnings: feesMissing ? ['all fee estimates unavailable from this server'] : [],
    };

    const human = renderGas({ tiers, relaySatsPerByte: data.relaySatsPerByte, mempoolVsize });
    return { envelope: wrap(SCHEMA.GAS, data, meta), human, meta };
  } finally {
    pool.close();
  }
}
