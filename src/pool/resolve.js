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

import { discoverServers } from './discovery.js';
import { loadServerCache, saveServerCache } from './cache.js';
import { ServerPool } from './pool.js';
import { rankServers } from './health.js';
import { quorumServers } from '../fulcrum/servers.js';

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

  if (opts.discover === false || process.env.CASCAN_NO_DISCOVERY) {
    return { servers: curated, origin: 'curated' };
  }

  if (!opts.forceProbe) {
    const cached = await loadServerCache({ path: opts.cachePath, network, ttlMs: opts.cacheTtlMs });
    if (cached) {
      log(`server pool from cache (${cached.servers.length} servers, ${Math.round((Date.now() - cached.updatedAt) / 60000)}m old)`);
      return { servers: cached.servers, origin: 'cache' };
    }
  }

  try {
    const d = await discoverServers({ onLog: log, network });
    if (d.servers.length > 0) {
      await saveServerCache(d.servers, { path: opts.cachePath, network, meta: d.meta });
      return { servers: d.servers, origin: 'discovery', discovery: d };
    }
    log('discovery returned no servers — using curated fallback');
  } catch (err) {
    log(`discovery failed (${err.message}) — using curated fallback`);
  }
  return { servers: curated, origin: 'curated' };
}

/** Discovery/pool record → quorum-layer server entry. */
export function toQuorumEntry(record) {
  return {
    host: record.host,
    ports: { ...record.ports },
    ...(record.transport ? { transport: record.transport } : {}),
    ...(record.port != null ? { port: record.port } : {}),
    rejectUnauthorized: record.tlsStrict !== false,
    operator: record.operator ?? record.source ?? 'curated',
  };
}

// Process-wide default pool records per network, resolved once (cache makes
// repeat CLI invocations cheap; a long process shouldn't re-discover per call).
const _defaultRecords = new Map(); // network → Promise<records>

/** @returns {Promise<Array>} discovery/curated records, health-ranked. */
export async function defaultPoolRecords(opts = {}) {
  const network = opts.network ?? 'mainnet';
  if (!_defaultRecords.has(network)) {
    _defaultRecords.set(network, resolvePool({ ...opts, network }).then(r =>
      r.servers.map(s => ({ ...s })) // defensive copy; health mutates
    ));
  }
  const records = await _defaultRecords.get(network);
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
 * @param {{ servers?: Array, timeoutMs?: number, onLog?: (m) => void }} [opts]
 * @returns {Promise<{ pool: ServerPool, server: string }>}
 */
export async function connectPool(opts = {}) {
  const servers = opts.servers ?? await defaultPoolRecords({ onLog: opts.onLog, network: opts.network });
  const pool = new ServerPool(servers, { timeoutMs: opts.timeoutMs });
  await pool.acquire();
  return { pool, server: pool.current };
}
