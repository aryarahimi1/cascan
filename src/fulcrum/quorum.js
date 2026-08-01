/**
 * src/fulcrum/quorum.js
 *
 * Multi-server query helper — the BCH-native port of glnc's v1.2
 * "honest multi-RPC" queryQuorum. A single Fulcrum server is one
 * operator's view of the chain; cascan surfaces disagreement instead
 * of hiding it.
 *
 * Modes:
 *   any      — sequential fallback; first success wins. Untried servers are
 *              recorded as 'not-tried'. Cannot detect disagreement (by design).
 *   majority — parallel fan-out; plurality wins; dissent recorded in
 *              `disagreements[]` and `meta.partial` flips true.
 *   all      — parallel fan-out; unanimous agreement required; throws
 *              QuorumDisagreementError on any divergence.
 *
 * Each call opens a short-lived client per server (one-shot CLI semantics).
 * The watch command uses a persistent FulcrumClient directly instead.
 */

import { FulcrumClient } from './client.js';
import { verifyBchChain } from './chain.js';
import { defaultQuorumEntries } from '../pool/resolve.js';
import { QuorumDisagreementError, AllServersFailedError } from './errors.js';
import { requireAllowedTransport, serverName } from '../pool/transport.js';
import { getNetwork } from '../networks.js';

// Re-exported so existing `import { … } from './quorum.js'` sites (bin,
// commands, library index) keep working after the errors moved.
export { QuorumDisagreementError, AllServersFailedError };

/** Deterministic value normalization for cross-server comparison. */
function normalize(value) {
  return stableStringify(value);
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') {
    return typeof v === 'bigint' ? JSON.stringify(v.toString()) : JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/**
 * Run one method against one server with a short-lived client.
 * Optional `extras` run on the same connection after the primary call —
 * their results ride along with the winner (e.g. block height next to a
 * balance). Extra failures don't fail the primary call.
 *
 * @returns {Promise<{ server: string, value: any, latencyMs: number, extras: Record<string, any> }>}
 */
async function callOne(serverEntry, method, params, opts) {
  const target = requireAllowedTransport(serverEntry, {
    allowInsecureTransport: opts.allowInsecureTransport,
  });
  const client = new FulcrumClient({
    host: serverEntry.host,
    port: target.port,
    transport: target.transport,
    rejectUnauthorized: serverEntry.rejectUnauthorized !== false,
    timeoutMs: opts.timeoutMs,
    publicOnly: serverEntry.publicOnly === true,
  });
  const started = Date.now();
  try {
    await client.connect();
    // The checkpoint proof runs on the same socket as the application query.
    await verifyBchChain(client, opts.network);
    const value = await client.request(method, params);
    const extraResults = {};
    for (const ex of opts.extras) {
      try {
        extraResults[ex.key] = await client.request(ex.method, ex.params ?? []);
      } catch {
        extraResults[ex.key] = null;
      }
    }
    return { server: client.name, value, latencyMs: Date.now() - started, extras: extraResults };
  } finally {
    client.close();
  }
}

/**
 * Query a Fulcrum method under a quorum policy.
 *
 * @param {string} method   - e.g. 'blockchain.scripthash.get_balance'
 * @param {any[]}  params
 * @param {{ mode?: 'any'|'majority'|'all', servers?: Array,
 *           network?: 'mainnet'|'chipnet'|'testnet4', timeoutMs?: number,
 *           minAgreement?: number, allowInsecureTransport?: boolean,
 *           paymentMode?: boolean }} [opts]
 * @returns {Promise<{
 *   value: any,
 *   answered: string,           // server whose value was returned
 *   agreement: 'unanimous'|'majority'|'plurality'|'single'|null,
 *   statuses: Array<{ server: string, status: 'ok'|'failed'|'not-tried', latencyMs?: number, error?: string }>,
 *   disagreements: Array,        // empty under 'any'
 *   degraded: Array,             // non-empty when quorum policy degraded
 *   partial: boolean,
 * }>}
 */
export async function queryQuorum(method, params = [], opts = {}) {
  let mode = opts.mode ?? 'any';
  const network = getNetwork(opts.network ?? 'mainnet').name;
  // Default pool is discovery-backed (DNS seed + gossip, cached), curated
  // as fallback — the hardcoded list is no longer the primary source.
  let servers = opts.servers ?? await defaultQuorumEntries({ network });
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const extras = opts.extras ?? [];
  const minAgreement = opts.minAgreement ?? 1;
  // Payment verification never permits unauthenticated TLS or cleartext,
  // even if a caller enabled the non-payment escape hatch elsewhere.
  const paymentMode = opts.paymentMode ?? (minAgreement > 1);
  const allowInsecureTransport = opts.allowInsecureTransport === true && !paymentMode;
  // A minimum agreement greater than one is a security requirement, so a
  // first-success policy cannot satisfy it.
  if (minAgreement > 1 && mode === 'any') mode = 'majority';

  // Parallel fan-out is capped so a 20-server discovered pool doesn't get
  // hammered by every --quorum majority query; 'any' walks the ranked list
  // sequentially and stops at the first success, so it needs no cap.
  if (mode !== 'any') {
    servers = servers.slice(0, opts.maxFanout ?? 4);
  }

  if (mode === 'any') {
    const statuses = [];
    const errors = [];
    for (const entry of servers) {
      try {
        const r = await callOne(entry, method, params, {
          timeoutMs, extras, network, allowInsecureTransport,
        });
        statuses.push({ server: r.server, status: 'ok', latencyMs: r.latencyMs });
        for (const rest of servers.slice(statuses.length)) {
          statuses.push({ server: serverName(rest), status: 'not-tried' });
        }
        return {
          value: r.value,
          extras: r.extras,
          answered: r.server,
          agreement: null, // single-provider happy path; nothing to compare
          agreementCount: 1,
          statuses,
          disagreements: [],
          degraded: [],
          partial: false,
        };
      } catch (err) {
        errors.push(err);
        statuses.push({ server: serverName(entry), status: 'failed', error: err.message });
      }
    }
    // Uniform application-level error (e.g. "tx not found" from every
    // daemon) is NOT a network failure — surface it plainly instead of
    // claiming all servers failed.
    const messages = new Set(errors.map(e => e.message));
    if (messages.size === 1 && errors.every(err => err?.kind === 'application')) {
      throw new Error([...messages][0]);
    }
    throw new AllServersFailedError(errors);
  }

  // majority | all → parallel fan-out
  const settled = await Promise.allSettled(
    servers.map(entry => callOne(entry, method, params, {
      timeoutMs, extras, network, allowInsecureTransport,
    }))
  );

  const statuses = settled.map((res, i) => {
    const name = serverName(servers[i]);
    if (res.status === 'fulfilled') {
      return { server: res.value.server, status: 'ok', latencyMs: res.value.latencyMs };
    }
    return { server: name, status: 'failed', error: res.reason?.message ?? String(res.reason) };
  });

  const fulfilled = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (fulfilled.length === 0) {
    const rejected = settled.filter(r => r.status === 'rejected').map(r => r.reason);
    // Same uniform-error honesty rule as 'any' mode.
    const messages = new Set(rejected.map(e => e?.message ?? String(e)));
    if (messages.size === 1 && rejected.every(err => err?.kind === 'application')) {
      throw new Error([...messages][0]);
    }
    throw new AllServersFailedError(rejected);
  }

  // Group by normalized value; first-response order breaks ties.
  const groups = new Map(); // norm → { value, servers: string[], extras }
  for (const f of fulfilled) {
    const norm = normalize(f.value);
    if (!groups.has(norm)) groups.set(norm, { value: f.value, servers: [], extras: f.extras });
    groups.get(norm).servers.push(f.server);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].servers.length - a[1].servers.length);
  const [pickedNorm, pickedGroup] = ranked[0];
  const agreementCount = new Set(pickedGroup.servers).size;

  const unanimous = ranked.length === 1;
  const threshold = Math.floor(fulfilled.length / 2) + 1;
  const agreement =
    unanimous ? 'unanimous'
    : fulfilled.length === 1 ? 'single'
    : pickedGroup.servers.length >= threshold ? 'majority'
    : 'plurality';

  const serverRecords = fulfilled.map(f => ({
    server: f.server,
    value: f.value,
    agreed: normalize(f.value) === pickedNorm,
  }));

  const disagreements = unanimous ? [] : [{
    agreement,
    servers: serverRecords,
    picked: { server: pickedGroup.servers[0], value: pickedGroup.value },
  }];

  const degraded = [];
  if (fulfilled.length < 2) {
    degraded.push({
      requested: mode,
      agreement: 'single',
      fulfilledCount: fulfilled.length,
      totalCount: servers.length,
    });
  }

  if (mode === 'all' && !unanimous) {
    throw new QuorumDisagreementError(
      `--quorum=all: ${ranked.length} distinct values from ${fulfilled.length} servers for ${method}`,
      { agreement, servers: serverRecords }
    );
  }

  if (agreementCount < minAgreement) {
    throw new QuorumDisagreementError(
      `security quorum unavailable: ${agreementCount} matching response(s), ${minAgreement} required for ${method}`,
      {
        agreement,
        agreementCount,
        required: minAgreement,
        servers: serverRecords,
      }
    );
  }

  // A matching pair in a 2–2 split is not a majority. minAgreement protects
  // against one fabricated response; strict majority protects callers from
  // receiving an arbitrary tie winner chosen by endpoint ordering.
  if (minAgreement > 1 && agreement === 'plurality') {
    throw new QuorumDisagreementError(
      `security quorum unavailable: no strict majority for ${method}`,
      {
        agreement,
        agreementCount,
        required: minAgreement,
        servers: serverRecords,
      }
    );
  }

  return {
    value: pickedGroup.value,
    extras: pickedGroup.extras,
    answered: pickedGroup.servers[0],
    agreement,
    agreementCount,
    statuses,
    disagreements,
    degraded,
    partial: disagreements.length > 0 || degraded.length > 0,
  };
}

/**
 * Build the meta.sources.fulcrum block from a quorum result (+ optional tip).
 */
export function fulcrumMeta(qr, extra = {}) {
  return {
    ok: true,
    answered: qr.answered,
    agreement: qr.agreement,
    agreementCount: qr.agreementCount,
    ...(extra.height != null ? { height: extra.height } : {}),
    servers: qr.statuses,
    disagreements: qr.disagreements,
    degraded: qr.degraded,
  };
}

// NOTE: the old `connectFirst` (single server, loud death on its loss) was
// replaced by `connectPool` in src/pool/resolve.js — a pooled
// connection with health-ranked selection, transparent failover, and
// subscription resurrection. Commands hold a pool now, not a socket.
