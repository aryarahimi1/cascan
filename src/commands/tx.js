/**
 * src/commands/tx.js
 *
 * cascan tx <txid> — decode a BCH transaction (verbose Electrum get).
 * --raw emits the provider-verbatim response under cascan.tx-raw/v1.
 */

import { queryQuorum, fulcrumMeta } from '../fulcrum/quorum.js';
import { serverOverride } from '../fulcrum/servers.js';
import { SCHEMA } from '../output/schemas.js';
import { wrap } from '../output/envelope.js';
import { renderTx } from '../cli/render.js';

const TXID_RE = /^[0-9a-fA-F]{64}$/;

export async function cmdTx(parsed) {
  const txid = parsed.target.toLowerCase();
  if (!TXID_RE.test(txid)) {
    const err = new Error(`not a txid: ${parsed.target} (expected 64 hex chars)`);
    err.exitCode = 1;
    throw err;
  }

  const minAgreement = parsed.server || parsed.quorum === 'any' ? 1 : 2;
  const qr = await queryQuorum('blockchain.transaction.get', [txid, true], {
    mode: parsed.quorum,
    minAgreement,
    network: parsed.network,
    servers: serverOverride(parsed.server) ?? undefined,
  });
  const raw = qr.value;

  const meta = {
    sources: { fulcrum: fulcrumMeta(qr) },
    partial: qr.partial,
    warnings: [],
  };

  if (parsed.raw) {
    // Provider-verbatim passthrough — explicitly NOT a stable shape.
    return {
      envelope: wrap(SCHEMA.TX_RAW, { txid, raw, source: qr.answered }, meta),
      human: null, // --raw implies --json (enforced in bin)
      meta,
    };
  }

  const tx = normalizeTx(raw, txid);
  const data = { ...tx, source: qr.answered };
  const human = renderTx(tx, parsed.verbose);

  return { envelope: wrap(SCHEMA.TX, data, meta), human, meta };
}

/**
 * Normalize an Electrum verbose transaction into cascan's stable shape.
 * Values arrive as BCH floats — converted to satoshi strings.
 */
function normalizeTx(raw, txid) {
  const vout = (raw.vout ?? []).map(o => ({
    n: o.n,
    // Server-provided numerics are untrusted: non-finite → null, never NaN.
    sats: Number.isFinite(o.value) ? String(Math.round(o.value * 1e8)) : null,
    addresses: Array.isArray(o.scriptPubKey?.addresses) ? o.scriptPubKey.addresses : [],
    type: o.scriptPubKey?.type ?? null,
    hasToken: Boolean(o.tokenData),
  }));
  return {
    txid: raw.txid ?? txid,
    version: raw.version ?? null,
    size: raw.size ?? null,
    locktime: raw.locktime ?? null,
    blockheight: raw.blockheight ?? null,
    confirmations: raw.confirmations ?? null,
    time: raw.time ?? raw.blocktime ?? null,
    vinCount: Array.isArray(raw.vin) ? raw.vin.length : null,
    vout,
  };
}
