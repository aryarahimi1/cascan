/**
 * Pure helpers for the public network-status snapshot
 * (scripts/status-snapshot.mjs). Kept free of I/O so they are unit-tested.
 *
 * One character per server per run, oldest first:
 *   A  up, certificate-authenticated TLS, BCH checkpoints verified
 *   S  up, self-signed TLS, BCH checkpoints verified
 *   C  up, cleartext TCP only, BCH checkpoints verified
 *   W  answered, but on the wrong chain (checkpoint mismatch)
 *   X  answered, but failed the protocol/verification handshake
 *   D  unreachable (timeout, refused, reset)
 *   -  not probed in that run
 */

export const STATUS_SCHEMA = 1;
export const UP_STATES = new Set(['A', 'S', 'C']);

export function isUp(state) {
  return UP_STATES.has(state);
}

/** State for a server that passed discovery (chain already verified). */
export function classifyVerified(record) {
  if (record.transport === 'tcp') return 'C';
  return record.tlsStrict === false ? 'S' : 'A';
}

/** State for a discovery rejection, from its error message. */
export function classifyRejection(reason) {
  const text = String(reason ?? '');
  if (/wrong chain|checkpoint/i.test(text)) return 'W';
  if (/timeout|timed out|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|connection closed|no transport available/i.test(text)) {
    return 'D';
  }
  return 'X';
}

/** Short, display-safe rejection text (no stack traces, bounded length). */
export function shortReason(reason) {
  return String(reason ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 120);
}

const byHost = (a, b) => a.host.localeCompare(b.host);

/**
 * Fold one run's observations into the rolling per-network status.
 *
 * @param {object|undefined} previous  prior network status (or undefined)
 * @param {Array<object>} observations one entry per probed host:
 *        { host, state, source?, ports?, transport?, port?, latencyMs?,
 *          height?, software?, protocol?, reason? }
 * @param {{ now: string, windowSamples: number }} opts
 */
export function mergeRun(previous, observations, { now, windowSamples }) {
  const servers = new Map();
  for (const entry of previous?.servers ?? []) servers.set(entry.host, { ...entry });

  const observed = new Map();
  for (const obs of observations) {
    if (!observed.has(obs.host)) observed.set(obs.host, obs);
  }

  for (const [host, obs] of observed) {
    if (!servers.has(host)) {
      servers.set(host, {
        host,
        source: obs.source ?? 'unknown',
        firstSeen: now,
        lastUp: null,
        samples: '',
      });
    }
  }

  const tipCandidates = [...observed.values()]
    .filter(obs => isUp(obs.state) && Number.isSafeInteger(obs.height))
    .map(obs => obs.height);
  const tip = tipCandidates.length > 0 ? Math.max(...tipCandidates) : null;

  const next = [];
  for (const entry of servers.values()) {
    const obs = observed.get(entry.host);
    const state = obs?.state ?? '-';
    const samples = (entry.samples + state).slice(-windowSamples);
    // Forget hosts with nothing but "not probed" left in the window.
    if (!/[^-]/.test(samples)) continue;

    const updated = { ...entry, samples };
    if (obs) {
      if (obs.ports) updated.ports = obs.ports;
      if (isUp(state)) updated.lastUp = now;
      updated.last = {
        at: now,
        state,
        transport: obs.transport ?? null,
        port: obs.port ?? null,
        latencyMs: obs.latencyMs ?? null,
        height: obs.height ?? null,
        lag: isUp(state) && tip !== null && Number.isSafeInteger(obs.height) ? tip - obs.height : null,
        software: obs.software ?? null,
        protocol: obs.protocol ?? null,
        ...(obs.reason ? { reason: shortReason(obs.reason) } : {}),
      };
    }
    next.push(updated);
  }
  next.sort(byHost);

  const probed = [...observed.values()];
  const run = {
    at: now,
    probed: probed.length,
    up: probed.filter(obs => isUp(obs.state)).length,
    authenticated: probed.filter(obs => obs.state === 'A').length,
    tip,
  };
  const runs = [...(previous?.runs ?? []), run].slice(-windowSamples);

  return { runs, servers: next };
}

/** Uptime over the window: share of probed runs in which the server was up. */
export function uptime(samples) {
  const probed = samples.replace(/-/g, '');
  if (probed.length === 0) return null;
  const up = [...probed].filter(isUp).length;
  return up / probed.length;
}
