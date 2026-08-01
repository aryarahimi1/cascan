/**
 * src/pool/resolve.js
 *
 * Pool sourcing shared by the library (`connect()`) and every CLI command:
 * cache → discovery → curated fallback, plus the adapters that feed the
 * quorum layer and the process-wide default pool.
 *
 * Escape hatches:
 *   CASCAN_NO_DISCOVERY=1  — curated list only (deterministic environments)
 *   opts.discover: false   — same, programmatic
 */

import { discoverServers, isAllowedDiscoveryPort, isValidHostname } from './discovery.js';
import { loadServerCache, saveServerCache } from './cache.js';
import { ServerPool } from './pool.js';
import { rankServers } from './health.js';
import { quorumServers } from '../fulcrum/servers.js';
import { isIP } from 'node:net';
import { isPublicIp } from '../net/public-destination.js';
import { requireAllowedTransport } from './transport.js';
import { curatedIdentity } from '../networks.js';

/** Strip serialized identity claims, then re-attach only built-in metadata. */
function withCuratedIdentity(record, network) {
  const {
    operator: _untrustedOperator,
    infrastructure: _untrustedInfrastructure,
    ...endpoint
  } = record;
  const identity = curatedIdentity(network, record.host);
  return { ...endpoint, ...(identity ?? {}) };
}

function prepareRecords(records, opts = {}) {
  const prepared = [];
  for (const record of records) {
    try {
      requireAllowedTransport(record, {
        allowInsecureTransport: opts.allowInsecureTransport === true,
      });
    } catch {
      continue;
    }
    prepared.push({
      ...withCuratedIdentity(record, opts.network ?? record.network ?? 'mainnet'),
      network: opts.network ?? record.network ?? 'mainnet',
      publicOnly: true,
    });
  }
  return prepared;
}

/** Old cache data is untrusted input and must satisfy today's endpoint policy. */
export function hardenCachedServers(records, opts = {}) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const hardened = [];
  for (const record of records) {
    if (!record || record.verified !== true || !isValidHostname(record.host)) return null;
    if (record.network != null && record.network !== (opts.network ?? 'mainnet')) return null;
    if (isIP(record.host) !== 0 && !isPublicIp(record.host)) return null;
    let target;
    try {
      target = requireAllowedTransport(record, {
        allowInsecureTransport: opts.allowInsecureTransport === true,
      });
    } catch { return null; }
    if (!isAllowedDiscoveryPort(target.port)) return null;
    hardened.push({
      ...withCuratedIdentity(record, opts.network ?? record.network ?? 'mainnet'),
      network: opts.network ?? record.network ?? 'mainnet',
      publicOnly: true,
    });
  }
  return hardened;
}

/**
 * Resolve the server pool: cache → discovery → curated fallback.
 *
 * @param {{ discover?: boolean, cachePath?: string, cacheTtlMs?: number,
 *           forceProbe?: boolean, onLog?: (m: string) => void }} [opts]
 * @returns {Promise<{ servers: Array, origin: 'cache'|'discovery'|'curated', discovery?: object }>}
 */
export async function resolvePool(opts = {}) {
  const log = opts.onLog ?? (() => {});
  const network = opts.network ?? 'mainnet';
  const curated = quorumServers(network);
  const policy = {
    network,
    allowInsecureTransport: opts.allowInsecureTransport === true,
  };

  if (opts.discover === false || process.env.CASCAN_NO_DISCOVERY) {
    return { servers: prepareRecords(curated, policy), origin: 'curated' };
  }

  if (!opts.forceProbe) {
    const cached = await loadServerCache({ path: opts.cachePath, network, ttlMs: opts.cacheTtlMs });
    if (cached) {
      const hardened = hardenCachedServers(cached.servers, policy);
      if (hardened) {
        log(`server pool from cache (${hardened.length} servers, ${Math.round((Date.now() - cached.updatedAt) / 60000)}m old)`);
        return { servers: hardened, origin: 'cache' };
      }
      log('server cache rejected by current public-endpoint policy — rediscovering');
    }
  }

  try {
    const d = await discoverServers({
      onLog: log,
      network,
      allowInsecureTransport: policy.allowInsecureTransport,
    });
    if (d.servers.length > 0) {
      await saveServerCache(d.servers, { path: opts.cachePath, network, meta: d.meta });
      return { servers: prepareRecords(d.servers, policy), origin: 'discovery', discovery: d };
    }
    log('discovery returned no servers — using curated fallback');
  } catch (err) {
    log(`discovery failed (${err.message}) — using curated fallback`);
  }
  return { servers: prepareRecords(curated, policy), origin: 'curated' };
}

/** Discovery/pool record → quorum-layer server entry. */
export function toQuorumEntry(record) {
  return {
    host: record.host,
    ports: { ...record.ports },
    ...(record.transport ? { transport: record.transport } : {}),
    ...(record.port != null ? { port: record.port } : {}),
    rejectUnauthorized: record.tlsStrict !== false,
    network: record.network ?? 'mainnet',
    ...(record.operator ? { operator: record.operator } : {}),
    ...(record.operator ? { infrastructure: record.infrastructure ?? record.operator } : {}),
    ...(record.publicOnly === true ? { publicOnly: true } : {}),
  };
}

// Process-wide default pool records per network, resolved once (cache makes
// repeat CLI invocations cheap; a long process shouldn't re-discover per call).
const _defaultRecords = new Map(); // network + transport policy → Promise<records>

/** @returns {Promise<Array>} discovery/curated records, health-ranked. */
export async function defaultPoolRecords(opts = {}) {
  const network = opts.network ?? 'mainnet';
  const allowInsecureTransport = opts.allowInsecureTransport === true;
  const key = `${network}:${allowInsecureTransport ? 'insecure' : 'authenticated'}`;
  if (!_defaultRecords.has(key)) {
    _defaultRecords.set(key, resolvePool({ ...opts, network, allowInsecureTransport }).then(r =>
      r.servers.map(s => ({ ...s })) // defensive copy; health mutates
    ));
  }
  const records = await _defaultRecords.get(key);
  return records.every(r => r.health) ? rankServers(records) : records;
}

/** Test hook: reset the process-wide defaults. */
export function _resetDefaultPool() {
  _defaultRecords.clear();
}

/** Ranked quorum-layer entries from the default pool. */
export async function defaultQuorumEntries(opts = {}) {
  return (await defaultPoolRecords(opts)).map(toQuorumEntry);
}

/**
 * Open a failover-capable pooled connection — the replacement for the old
 * single-server `connectFirst`. Commands that held one client now hold a
 * pool that survives server death.
 *
 * @param {{ servers?: Array, network?: 'mainnet'|'chipnet'|'testnet4',
 *           timeoutMs?: number, allowInsecureTransport?: boolean,
 *           subscriptionCheckMs?: number, subscriptionCheckBatchSize?: number,
 *           handlerRetryBaseMs?: number, handlerRetryMaxMs?: number,
 *           handlerTimeoutMs?: number,
 *           failureBackoffBaseMs?: number, failureBackoffMaxMs?: number,
 *           minHealthyUptimeMs?: number,
 *           retryBudgetAttempts?: number, retryBudgetWindowMs?: number,
 *           recoveryBackoffBaseMs?: number, recoveryBackoffMaxMs?: number,
 *           onLog?: (m) => void }} [opts]
 * @returns {Promise<{ pool: ServerPool, server: string }>}
 */
export async function connectPool(opts = {}) {
  const servers = opts.servers ?? await defaultPoolRecords({
    onLog: opts.onLog,
    network: opts.network,
    allowInsecureTransport: opts.allowInsecureTransport,
  });
  const pool = new ServerPool(servers, {
    network: opts.network,
    timeoutMs: opts.timeoutMs,
    allowInsecureTransport: opts.allowInsecureTransport,
    subscriptionCheckMs: opts.subscriptionCheckMs,
    subscriptionCheckBatchSize: opts.subscriptionCheckBatchSize,
    handlerRetryBaseMs: opts.handlerRetryBaseMs,
    handlerRetryMaxMs: opts.handlerRetryMaxMs,
    handlerTimeoutMs: opts.handlerTimeoutMs,
    failureBackoffBaseMs: opts.failureBackoffBaseMs,
    failureBackoffMaxMs: opts.failureBackoffMaxMs,
    minHealthyUptimeMs: opts.minHealthyUptimeMs,
    retryBudgetAttempts: opts.retryBudgetAttempts,
    retryBudgetWindowMs: opts.retryBudgetWindowMs,
    recoveryBackoffBaseMs: opts.recoveryBackoffBaseMs,
    recoveryBackoffMaxMs: opts.recoveryBackoffMaxMs,
  });
  await pool.acquire();
  return { pool, server: pool.current };
}
