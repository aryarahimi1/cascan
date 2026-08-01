/**
 * src/commands/campaign.js
 *
 * cascan campaign <address> --goal <BCH> — flipstarter-style fundraiser
 * tracking, one-shot or live (--watch).
 *
 * v0.1 honesty notes (documented, not hidden):
 *   - "raised" is the CURRENT balance of the address: funds spent out of
 *     it reduce the total. It is not a lifetime-contributions sum (that
 *     needs full history inspection — a later phase via Chaingraph).
 *   - "donors" is the address's transaction count — an upper-bound proxy
 *     for contributor count (change outputs, multi-output pays, and
 *     self-sends all distort it).
 *   - Live mode runs on the ServerPool: a dying server triggers
 *     failover + subscription resurrection, not death. Exit 2 now means
 *     the entire pool is unreachable — never a quiet campaign.
 *
 * Events (cascan.campaign/v1 NDJSON with --watch --json):
 *   progress      — initial snapshot + every balance change
 *   goal-reached  — edge-triggered once when raised >= goal
 *   failover      — pool switched servers
 *   stop          — Ctrl+C ('sigint') or 'all-servers-failed' teardown
 */

import { parseAddress } from '../address.js';
import { connectPool, toQuorumEntry } from '../pool/resolve.js';
import { queryQuorum, fulcrumMeta } from '../fulcrum/quorum.js';
import { serverOverride } from '../fulcrum/servers.js';
import { getBchPrice } from '../prices.js';
import { SCHEMA } from '../output/schemas.js';
import { wrap, wrapEvent } from '../output/envelope.js';
import { emitNDJSON } from '../output/emit.js';
import { renderCampaign, sanitize } from '../cli/render.js';
import { gray, cyan } from '../cli/theme.js';
import { postWebhook } from './webhook.js';

const SATS_PER_BCH = 100_000_000n;

/** Pure progress computation — unit-tested. */
export function computeProgress(raisedSats, goalSats) {
  const raised = BigInt(raisedSats);
  const goal = goalSats == null ? null : BigInt(goalSats);
  const percent = goal != null && goal > 0n ? Number((raised * 10_000n) / goal) / 100 : null;
  return {
    raisedSats: raised.toString(),
    goalSats: goal?.toString() ?? null,
    percent,
    reached: goal != null && raised >= goal,
  };
}

/** Parse a BCH goal string ('10', '0.5') to satoshis. Throws on garbage. */
export function parseGoalBch(str) {
  if (!/^\d+(\.\d{1,8})?$/.test(str ?? '')) {
    const err = new Error(`--goal must be a non-negative BCH amount with ≤8 decimals (got: ${JSON.stringify(str)})`);
    err.exitCode = 1;
    throw err;
  }
  const [whole, frac = ''] = str.split('.');
  return (BigInt(whole) * SATS_PER_BCH + BigInt((frac + '00000000').slice(0, 8))).toString();
}

/** Server-supplied satoshi fields are untrusted — null on malformed. */
const toSats = (v) => {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
};

export async function cmdCampaign(parsed) {
  const rec = parseAddress(parsed.target, { network: parsed.network });
  const goalSats = parsed.goal != null ? parseGoalBch(parsed.goal) : null;
  const { pool } = await connectPool({ servers: serverOverride(parsed.server) ?? undefined, network: parsed.network });

  const verifiedRequest = (method, params) => queryQuorum(method, params, {
    mode: 'majority',
    minAgreement: 2,
    servers: pool.ranked().map(toQuorumEntry),
    network: parsed.network,
  });

  const snapshot = async () => {
    const failures = [];
    const [balQr, histQr, tip, price] = [
      await verifiedRequest('blockchain.address.get_balance', [rec.cashaddr]),
      await verifiedRequest('blockchain.address.get_history', [rec.cashaddr])
        .catch(() => { failures.push('quorum history unavailable — donors count degraded'); return null; }),
      await pool.request('blockchain.headers.subscribe')
        .catch(() => { failures.push('block height unavailable'); return null; }),
      await getBchPrice()
        .catch(() => ({ usd: null, meta: { ok: false, provider: 'coingecko' } })),
    ];
    const bal = balQr.value;
    const hist = histQr?.value ?? [];
    if (price.meta && price.meta.ok === false) failures.push('BCH price unavailable');

    const conf = toSats(bal?.confirmed);
    const unconf = toSats(bal?.unconfirmed);
    if (conf == null || unconf == null) failures.push('server returned malformed balance fields');
    const raisedSats = ((conf ?? 0n) + (unconf ?? 0n)).toString();

    const prog = computeProgress(raisedSats, goalSats);
    return {
      data: {
        address: rec.cashaddr,
        ...prog,
        usdRaised: price.usd != null ? (Number(raisedSats) / 1e8) * price.usd : null,
        donorsTxCount: hist.length,
        donorsNote: 'transaction count — upper-bound proxy for contributor count',
        raisedNote: 'current balance — decreases if funds move out',
        height: tip?.height ?? null,
        server: pool.current,
      },
      failures,
      priceMeta: price.meta ?? null,
      fulcrum: balQr,
    };
  };

  const buildMeta = (failures, priceMeta, qr) => ({
    sources: {
      fulcrum: qr ? fulcrumMeta(qr) : { ok: true, answered: pool.current },
      ...(priceMeta ? { prices: priceMeta } : {}),
    },
    partial: failures.length > 0,
    warnings: [...rec.warnings, ...failures],
  });

  const fireWebhook = async (env) => {
    if (!parsed.webhook) return;
    try {
      await postWebhook(parsed.webhook, env);
    } catch (err) {
      process.stderr.write(`! webhook failed: ${err.message}\n`);
    }
  };

  try {
    const first = await snapshot();

    // One-shot (default): single envelope or human card.
    if (!parsed.watch) {
      const meta = buildMeta(first.failures, first.priceMeta, first.fulcrum);
      const human = renderCampaign(first.data, parsed.verbose);
      return { envelope: wrap(SCHEMA.CAMPAIGN, first.data, meta), human, meta };
    }

    // Live mode: NDJSON events on every change.
    const emit = (event, snap) => {
      const env = wrapEvent(SCHEMA.CAMPAIGN, event, {
        data: snap.data ?? snap,
        meta: buildMeta(snap.failures ?? [], snap.priceMeta ?? null, snap.fulcrum),
      });
      if (parsed.json) emitNDJSON(env);
      else if (event === 'progress' || event === 'goal-reached') {
        process.stdout.write(renderCampaign(env.data, parsed.verbose, { inline: true }) + '\n');
      }
      return env;
    };

    let last = first;
    let goalAnnounced = first.data.reached;
    await fireWebhook(emit('progress', first));
    if (first.data.reached) await fireWebhook(emit('goal-reached', first));

    if (!parsed.json) {
      process.stderr.write(gray(`  tracking campaign via ${cyan(sanitize(String(pool.current)))} — pool of ${pool.servers.length}, auto-failover — Ctrl+C to stop\n`));
    }

    let busy = false, dirty = false;
    const onChange = async () => {
      if (busy) { dirty = true; return; }
      busy = true;
      try {
        const next = await snapshot();
        if (next.data.raisedSats !== last.data.raisedSats || next.data.donorsTxCount !== last.data.donorsTxCount) {
          last = next;
          await fireWebhook(emit('progress', next));
          if (next.data.reached && !goalAnnounced) {
            goalAnnounced = true;
            await fireWebhook(emit('goal-reached', next));
          }
        }
      } finally {
        busy = false;
        if (dirty) { dirty = false; await onChange(); }
      }
    };

    // Pool-managed subscription: survives failover; gap changes delivered.
    await pool.subscribeAddress(rec.cashaddr, () => {
      onChange().catch(err => process.stderr.write(`! campaign handler error: ${err?.message ?? err}\n`));
    });

    const exitCode = await new Promise((resolve) => {
      const onSigint = () => {
        emit('stop', { data: { reason: 'sigint', address: rec.cashaddr }, failures: [], priceMeta: null });
        finish(0);
      };
      const onFailover = (f) => {
        emit('failover', { data: { from: f.from, to: f.to, reason: f.reason, address: rec.cashaddr }, failures: [], priceMeta: null });
        if (!parsed.json) {
          process.stderr.write(gray(`  ! server ${sanitize(String(f.from))} lost (${sanitize(String(f.reason))}) — failed over to ${cyan(sanitize(String(f.to)))}\n`));
        }
      };
      const onExhausted = () => {
        emit('stop', { data: { reason: 'all-servers-failed' }, failures: ['all servers failed'], priceMeta: null });
        finish(2);
      };
      const finish = (code) => {
        process.removeListener('SIGINT', onSigint);
        pool.removeListener('failover', onFailover);
        pool.removeListener('exhausted', onExhausted);
        resolve(code);
      };
      process.on('SIGINT', onSigint);
      pool.on('failover', onFailover);
      pool.on('exhausted', onExhausted);
    });

    return { exitCode };
  } finally {
    pool.close();
  }
}
