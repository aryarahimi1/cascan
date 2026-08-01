/**
 * src/fulcrum/quorum.js
 *
 * Multi-server query helper — the BCH-native port of glnc's v1.2
 * "honest multi-RPC" queryQuorum. Payment mode admits only explicitly
 * identified operators, counts one vote per operator/infrastructure group,
 * and surfaces disagreement instead of hiding it.
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

// Identity labels enter receipts and logs. Keep them deliberately boring so
// caller-provided metadata cannot smuggle control characters or markup into
// an operator's terminal. Built-in ids use DNS-style names.
const IDENTITY_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/i;

function normalizedIdentity(value) {
  if (typeof value !== 'string' || !IDENTITY_RE.test(value)) return null;
  return value.toLowerCase();
}

/**
 * Pick security voters before applying the fan-out cap. Unknown discovery
 * peers remain useful for failover but cannot manufacture quorum votes.
 */
export function selectQuorumVoters(servers, { paymentMode, maxFanout }) {
  if (!paymentMode) {
    return { selected: servers.slice(0, maxFanout), excluded: [] };
  }

  const selected = [];
  const excluded = [];
  const operators = new Set();
  const infrastructure = new Set();

  for (const entry of servers) {
    const operator = normalizedIdentity(entry.operator);
    const infra = normalizedIdentity(entry.infrastructure ?? entry.operator);
    let reason = null;
    if (!operator || !infra) reason = 'unknown-operator';
    else if (operators.has(operator)) reason = 'duplicate-operator';
    else if (infrastructure.has(infra)) reason = 'duplicate-infrastructure';
    else if (selected.length >= maxFanout) reason = 'fanout-limit';

    if (reason) {
      excluded.push({
        server: serverName(entry),
        status: 'not-tried',
        reason,
        ...(operator ? { operator } : {}),
        ...(infra ? { infrastructure: infra } : {}),
      });
      continue;
    }

    operators.add(operator);
    infrastructure.add(infra);
    selected.push({ ...entry, operator, infrastructure: infra });
  }
  return { selected, excluded };
}

function normalizeRemoteAddress(address) {
  if (typeof address !== 'string') return null;
  return address.toLowerCase().replace(/^::ffff:/, '');
}

/**
 * Collapse dynamically observed shared infrastructure. Static labels catch
 * known grouping; connected IP and certificate fingerprints catch aliases
 * that were not visible in the registry. Transitive matches form one voter.
 */
export function collapseInfrastructureDuplicates(responses, paymentMode) {
  if (!paymentMode) return responses.map(response => ({ ...response, independent: true }));

  const parent = responses.map((_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < responses.length; i++) {
    for (let j = 0; j < i; j++) {
      const sameAddress = responses[i].remoteAddress &&
        responses[i].remoteAddress === responses[j].remoteAddress;
      const sameCertificate = responses[i].certificateFingerprint &&
        responses[i].certificateFingerprint === responses[j].certificateFingerprint;
      if (sameAddress || sameCertificate) union(j, i);
    }
  }

  const representatives = new Map();
  return responses.map((response, index) => {
    const root = find(index);
    if (!representatives.has(root)) {
      representatives.set(root, index);
      return { ...response, independent: true };
    }
    const representative = responses[representatives.get(root)];
    const reasons = [];
    if (response.remoteAddress && response.remoteAddress === representative.remoteAddress) reasons.push('shared-ip');
    if (response.certificateFingerprint && response.certificateFingerprint === representative.certificateFingerprint) reasons.push('shared-certificate');
    return {
      ...response,
      independent: false,
      duplicateOf: representative.server,
      duplicateReason: reasons.length ? reasons : ['shared-infrastructure'],
    };
  });
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
    const socket = client._socket;
    const certificate = client.useTls && typeof socket?.getPeerCertificate === 'function'
      ? socket.getPeerCertificate()
      : null;
    return {
      server: client.name,
      value,
      latencyMs: Date.now() - started,
      extras: extraResults,
      operator: normalizedIdentity(serverEntry.operator),
      infrastructure: normalizedIdentity(serverEntry.infrastructure ?? serverEntry.operator),
      remoteAddress: normalizeRemoteAddress(socket?.remoteAddress),
      certificateFingerprint: typeof certificate?.fingerprint256 === 'string'
        ? certificate.fingerprint256.toUpperCase()
        : null,
    };
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
 * `paymentMode: false` is an explicit non-security mode: matching endpoints
 * are not evidence of independent ownership, even when minAgreement > 1.
 * @returns {Promise<{
 *   value: any,
 *   answered: string,           // server whose value was returned
 *   agreement: 'unanimous'|'majority'|'plurality'|'single'|null,
 *   statuses: Array<{ server: string, status: 'ok'|'failed'|'not-tried', latencyMs?: number, error?: string,
 *     operator?: string, infrastructure?: string, independent?: boolean }>,
 *   disagreements: Array,        // empty under 'any'
 *   degraded: Array,             // non-empty when quorum policy degraded
 *   partial: boolean,
 * }>}
 */
export async function queryQuorum(method, params = [], opts = {}) {
  let mode = opts.mode ?? 'any';
  if (!['any', 'majority', 'all'].includes(mode)) {
    throw new TypeError('mode must be any, majority, or all');
  }
  const network = getNetwork(opts.network ?? 'mainnet').name;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const extras = opts.extras ?? [];
  const minAgreement = opts.minAgreement ?? 1;
  if (!Number.isInteger(minAgreement) || minAgreement < 1) {
    throw new RangeError('minAgreement must be a positive integer');
  }
  const maxFanout = opts.maxFanout ?? 4;
  if (!Number.isInteger(maxFanout) || maxFanout < 1 || maxFanout > 32) {
    throw new RangeError('maxFanout must be an integer from 1 to 32');
  }
  // Default pool is discovery-backed (DNS seed + gossip, cached), curated
  // as fallback — the hardcoded list is no longer the primary source.
  let servers = opts.servers ?? await defaultQuorumEntries({ network });
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
  let excluded = [];
  if (mode !== 'any' || paymentMode) {
    const selection = selectQuorumVoters(servers, {
      paymentMode,
      maxFanout: mode === 'any' ? servers.length : maxFanout,
    });
    servers = selection.selected;
    excluded = selection.excluded;
    if (paymentMode && servers.length < minAgreement) {
      throw new QuorumDisagreementError(
        `security quorum unavailable: ${servers.length} eligible independent operator(s), ${minAgreement} required for ${method}`,
        {
          agreement: null,
          agreementCount: 0,
          required: minAgreement,
          eligibleOperators: servers.map(server => server.operator),
          servers: excluded,
        },
      );
    }
  }

  if (mode === 'any') {
    const statuses = [];
    const errors = [];
    for (const entry of servers) {
      try {
        const r = await callOne(entry, method, params, {
          timeoutMs, extras, network, allowInsecureTransport,
        });
        statuses.push({
          server: r.server,
          status: 'ok',
          latencyMs: r.latencyMs,
          ...(r.operator ? { operator: r.operator } : {}),
          ...(r.infrastructure ? { infrastructure: r.infrastructure } : {}),
          ...(r.remoteAddress ? { remoteAddress: r.remoteAddress } : {}),
          ...(r.certificateFingerprint ? { certificateFingerprint: r.certificateFingerprint } : {}),
        });
        for (const rest of servers.slice(statuses.length)) {
          statuses.push({ server: serverName(rest), status: 'not-tried' });
        }
        statuses.push(...excluded);
        return {
          value: r.value,
          extras: r.extras,
          answered: r.server,
          answeredOperator: r.operator,
          agreement: null, // single-provider happy path; nothing to compare
          agreementCount: 1,
          operators: r.operator ? [r.operator] : [],
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

  const observed = collapseInfrastructureDuplicates(fulfilled, paymentMode);
  const independent = observed.filter(response => response.independent);
  let fulfilledIndex = 0;
  const statuses = settled.map((res, i) => {
    const entry = servers[i];
    const name = serverName(entry);
    if (res.status === 'fulfilled') {
      const response = observed[fulfilledIndex++];
      return {
        server: res.value.server,
        status: 'ok',
        latencyMs: res.value.latencyMs,
        ...(res.value.operator ? { operator: res.value.operator } : {}),
        ...(res.value.infrastructure ? { infrastructure: res.value.infrastructure } : {}),
        ...(res.value.remoteAddress ? { remoteAddress: res.value.remoteAddress } : {}),
        ...(res.value.certificateFingerprint ? { certificateFingerprint: res.value.certificateFingerprint } : {}),
        independent: response?.independent !== false,
        ...(response?.duplicateOf ? { duplicateOf: response.duplicateOf } : {}),
        ...(response?.duplicateReason ? { duplicateReason: response.duplicateReason } : {}),
      };
    }
    return {
      server: name,
      status: 'failed',
      error: res.reason?.message ?? String(res.reason),
      ...(entry.operator ? { operator: entry.operator } : {}),
      ...(entry.infrastructure ? { infrastructure: entry.infrastructure } : {}),
    };
  });
  statuses.push(...excluded);

  // Group only independent operator views; aliases remain visible in the
  // receipt but cannot increase any value's vote count.
  const groups = new Map(); // norm → { value, responses: object[], extras }
  for (const f of independent) {
    const norm = normalize(f.value);
    if (!groups.has(norm)) groups.set(norm, { value: f.value, responses: [], extras: f.extras });
    groups.get(norm).responses.push(f);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].responses.length - a[1].responses.length);
  const [pickedNorm, pickedGroup] = ranked[0];
  const agreementCount = pickedGroup.responses.length;

  const unanimous = ranked.length === 1;
  const threshold = Math.floor(independent.length / 2) + 1;
  const agreement =
    unanimous ? 'unanimous'
    : independent.length === 1 ? 'single'
    : pickedGroup.responses.length >= threshold ? 'majority'
    : 'plurality';

  const serverRecords = observed.map(f => ({
    server: f.server,
    value: f.value,
    agreed: normalize(f.value) === pickedNorm,
    ...(f.operator ? { operator: f.operator } : {}),
    ...(f.infrastructure ? { infrastructure: f.infrastructure } : {}),
    independent: f.independent,
    ...(f.duplicateOf ? { duplicateOf: f.duplicateOf } : {}),
  }));

  const disagreements = unanimous ? [] : [{
    agreement,
    servers: serverRecords,
    picked: { server: pickedGroup.responses[0].server, value: pickedGroup.value },
  }];

  const degraded = [];
  if (independent.length < 2) {
    degraded.push({
      requested: mode,
      agreement: 'single',
      fulfilledCount: independent.length,
      totalCount: servers.length,
    });
  }
  if (observed.length > independent.length) {
    degraded.push({
      requested: mode,
      reason: 'shared-infrastructure',
      fulfilledCount: observed.length,
      independentCount: independent.length,
      totalCount: servers.length,
    });
  }

  if (mode === 'all' && !unanimous) {
    throw new QuorumDisagreementError(
      `--quorum=all: ${ranked.length} distinct values from ${independent.length} independent operators for ${method}`,
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
    answered: pickedGroup.responses[0].server,
    answeredOperator: pickedGroup.responses[0].operator,
    agreement,
    agreementCount,
    operators: pickedGroup.responses.map(response => response.operator).filter(Boolean),
    voterCount: independent.length,
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
    ...(qr.answeredOperator ? { answeredOperator: qr.answeredOperator } : {}),
    agreement: qr.agreement,
    agreementCount: qr.agreementCount,
    ...(Array.isArray(qr.operators) ? { operators: qr.operators } : {}),
    ...(qr.voterCount != null ? { voterCount: qr.voterCount } : {}),
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
