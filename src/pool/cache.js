/**
 * src/pool/cache.js
 *
 * Persist the discovered server pool to ~/.cascan/servers.json so one-shot
 * CLI invocations don't re-run DNS + probing every time. Same atomic
 * tmp+rename pattern as src/alert/state.js.
 *
 * Freshness contract: a cache older than TTL (default 24h) is stale and
 * ignored by loadServerCache — discovery re-runs. `cascan servers --probe`
 * forces a refresh regardless.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getNetwork } from '../networks.js';

export const CACHE_VERSION = 1;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function defaultCachePath(network = 'mainnet') {
  return join(homedir(), '.cascan', getNetwork(network).cacheFile);
}

/**
 * Load the cached pool. Returns null when missing, malformed, wrong
 * version, or older than ttlMs.
 *
 * @param {{ path?: string, ttlMs?: number }} [opts]
 * @returns {Promise<{ servers: Array, updatedAt: number, meta?: object } | null>}
 */
export async function loadServerCache(opts = {}) {
  const path = opts.path ?? defaultCachePath(opts.network);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (raw?.version !== CACHE_VERSION) return null;
    if (!Array.isArray(raw.servers) || raw.servers.length === 0) return null;
    if (typeof raw.updatedAt !== 'number' || Date.now() - raw.updatedAt > ttlMs) return null;
    return { servers: raw.servers, updatedAt: raw.updatedAt, meta: raw.meta };
  } catch {
    return null;
  }
}

/**
 * Persist a discovered pool. Never throws — a read-only home directory
 * degrades to rediscovery, not failure.
 *
 * @param {Array} servers — discovery output records
 * @param {{ path?: string, meta?: object }} [opts]
 */
export async function saveServerCache(servers, opts = {}) {
  const path = opts.path ?? defaultCachePath(opts.network);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      meta: opts.meta ?? null,
      servers,
    }, null, 2));
    await rename(tmp, path);
  } catch {
    // Non-fatal.
  }
}
