/**
 * src/commands/watch.js
 *
 * cascan watch <address> — the payments headline.
 *
 * Subscribes to an address over a persistent Fulcrum connection and emits
 * an event every time the address's on-chain state changes:
 *
 *   payment    — new tx paying this address (confirmed:false when 0-conf)
 *   confirmed  — a previously-seen 0-conf tx just got mined
 *   poll       --once snapshot (no subscription)
 *   failover   — the pool switched servers; the subscription was
 *                resurrected on the replacement
 *   stop       — Ctrl+C teardown line (JSON mode)
 *
 * Events are NDJSON envelopes under cascan.watch/v1 with --json (default
 * human lines otherwise). Webhooks fire for confirmed payments always and
 * for 0-conf payments only with --0conf — BCH's instant-payment story is
 * opt-in, not assumed.
 *
 * Runs on the library's ServerPool. A dying server no longer kills
 * the watch — the subscription moves to the next-ranked server and anything
 * that happened during the gap is delivered. Loud death (exit 2) now means
 * the ENTIRE pool is unreachable.
 */

import { parseAddress } from '../address.js';
import { connectPool, toQuorumEntry } from '../pool/resolve.js';
import { queryQuorum, fulcrumMeta } from '../fulcrum/quorum.js';
import { serverOverride } from '../fulcrum/servers.js';
import { parseRawTransaction } from '../transaction/raw.js';
import { getBchPrice } from '../prices.js';
import { SCHEMA } from '../output/schemas.js';
import { wrapEvent } from '../output/envelope.js';
import { emitNDJSON } from '../output/emit.js';
import { renderPaymentEvent, shortenCashaddr, sanitize } from '../cli/render.js';
import { gray, cyan } from '../cli/theme.js';
import { postWebhook } from './webhook.js';

export async function cmdWatch(parsed) {
  const rec = parseAddress(parsed.target, { network: parsed.network });
  const { pool } = await connectPool({ servers: serverOverride(parsed.server) ?? undefined, network: parsed.network });
  let lastVerification = null;

  const verifiedRequest = async (method, params) => {
    const qr = await queryQuorum(method, params, {
      mode: 'majority',
      minAgreement: 2,
      servers: pool.ranked().map(toQuorumEntry),
      network: parsed.network,
    });
    lastVerification = qr;
    return qr;
  };

  const watchMeta = () => ({
    sources: {
      fulcrum: fulcrumMeta(lastVerification),
    },
    partial: false,
    warnings: [...rec.warnings],
  });

  const emit = (event, data) => {
    const env = wrapEvent(SCHEMA.WATCH, event, { data, meta: watchMeta() });
    if (parsed.json) {
      emitNDJSON(env);
    } else if (event === 'payment' || event === 'confirmed') {
      process.stdout.write(renderPaymentEvent({ ...data, confirmed: event === 'confirmed' ? true : data.confirmed }) + '\n');
    }
    return env;
  };

  const fireWebhook = async (env) => {
    if (!parsed.webhook) return;
    const d = env.data;
    if (env.event === 'payment' && d?.confirmed === false && !parsed.zeroConf) return; // 0-conf is opt-in
    if (env.event !== 'payment' && env.event !== 'confirmed') return;
    try {
      await postWebhook(parsed.webhook, env);
    } catch (err) {
      process.stderr.write(`! webhook failed: ${err.message}\n`);
    }
  };

  const fetchHistory = async () =>
    (await verifiedRequest('blockchain.address.get_history', [rec.cashaddr])).value;
  const fetchBalance = async () =>
    (await verifiedRequest('blockchain.address.get_balance', [rec.cashaddr])).value;

  const buildPaymentEvent = async (txid, height) => {
    const raw = (await verifiedRequest('blockchain.transaction.get', [txid, false])).value;
    const tx = parseRawTransaction(raw);
    const targetScript = rec.lockingScript;
    const received = tx.outputs
      .filter(output => output.lockingBytecode.toString('hex') === targetScript)
      .reduce((sum, output) => sum + output.valueSatoshis, 0n);
    if (received === 0n) return null; // address history also includes spends
    return {
      txid,
      height,
      confirmed: height > 0,
      receivedSats: received.toString(),
      address: rec.cashaddr,
    };
  };

  // Server-supplied satoshi fields are untrusted — null on malformed.
  const toSats = (v) => {
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
    return null;
  };

  try {
    // Initial state
    const [tip, hist0, bal0, price] = [
      await pool.request('blockchain.headers.subscribe').catch(() => null),
      await fetchHistory(),
      await fetchBalance(),
      await getBchPrice().catch(() => ({ usd: null })),
    ];
    const seen = new Map(hist0.map(h => [h.tx_hash, h.height]));
    const conf0 = toSats(bal0?.confirmed);
    const unconf0 = toSats(bal0?.unconfirmed);
    if (conf0 == null || unconf0 == null) {
      process.stderr.write('! server returned malformed balance fields\n');
    }
    const totalSats = ((conf0 ?? 0n) + (unconf0 ?? 0n)).toString();

    const startData = {
      address: rec.cashaddr,
      legacy: rec.legacy,
      height: tip?.height ?? null,
      txCount: seen.size,
      totalSats,
      usd: price.usd != null ? (Number(totalSats) / 1e8) * price.usd : null,
      zeroConfEnabled: parsed.zeroConf,
      server: pool.current,
    };

    if (parsed.once) {
      const env = emit('poll', startData);
      await fireWebhook(env);
      return { exitCode: 0 };
    }

    emit('start', startData);
    if (!parsed.json) {
      process.stderr.write(
        gray(`  watching ${shortenCashaddr(rec.cashaddr)} via ${cyan(sanitize(String(pool.current)))} — ${seen.size} known txs — pool of ${pool.servers.length}, auto-failover — Ctrl+C to stop\n`)
      );
    }

    // Subscription-driven change loop (reentrancy-guarded)
    let busy = false, dirty = false;
    const onChange = async () => {
      if (busy) { dirty = true; return; }
      busy = true;
      try {
        const hist = await fetchHistory();
        for (const h of hist) {
          if (!seen.has(h.tx_hash)) {
            seen.set(h.tx_hash, h.height);
            const ev = await buildPaymentEvent(h.tx_hash, h.height);
            if (!ev) continue;
            const env = emit('payment', ev);
            await fireWebhook(env);
          } else if (seen.get(h.tx_hash) === 0 && h.height > 0) {
            seen.set(h.tx_hash, h.height);
            const ev = await buildPaymentEvent(h.tx_hash, h.height);
            if (!ev) continue;
            const env = emit('confirmed', ev);
            await fireWebhook(env);
          }
        }
      } finally {
        busy = false;
        if (dirty) { dirty = false; await onChange(); }
      }
    };

    // Subscription errors must not be silent — a swallowed exception once
    // hid a renderer bug that dropped 0-conf payments (security review).
    // Pool-managed: survives failover, and a status change that happened
    // during the gap fires this callback immediately after resubscription.
    pool.on('handler-error', event => {
      process.stderr.write(`! watch handler error (${event.eventId}, retry ${event.attempt}): ${event.error}\n`);
    });
    await pool.subscribeAddress(rec.cashaddr, () => onChange());

    // Lifecycle: the pool owns keepalive + failover. The watch ends on
    // Ctrl+C (exit 0) or when the ENTIRE pool is unreachable (exit 2) —
    // loud death still exists, it just takes the whole fleet to trigger it.
    const exitCode = await new Promise((resolve) => {
      const onSigint = () => {
        emit('stop', { reason: 'sigint', address: rec.cashaddr });
        finish(0);
      };
      const onFailover = (f) => {
        emit('failover', { from: f.from, to: f.to, reason: f.reason, address: rec.cashaddr });
        if (!parsed.json) {
          process.stderr.write(gray(`  ! server ${sanitize(String(f.from))} lost (${sanitize(String(f.reason))}) — failed over to ${cyan(sanitize(String(f.to)))}, subscription resurrected\n`));
        }
      };
      const onExhausted = () => {
        emit('stop', { reason: 'all-servers-failed', server: pool.current });
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
