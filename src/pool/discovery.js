/**
 * src/pool/discovery.js
 *
 * Server discovery for the connection pool. Kills the hardcoded-server
 * problem: the pool is sourced live instead of shipped as a frozen list.
 *
 * Sources, in order:
 *   1. curated  — src/fulcrum/servers.js (always in the pool; the fallback
 *                 when DNS and gossip are unreachable)
 *   2. seed     — ec-seed.flowee.cash A records (Flowee's DNS seed, built
 *                 by tom because "hardcoding one server puts a target on
 *                 its back"). Returns bare IPv4s; standard ports assumed.
 *   3. gossip   — server.peers.subscribe on responding servers (25–41
 *                 peers each at probe time)
 *
 * Every candidate is VERIFIED before it may serve answers:
 *   - speaks the Electrum protocol (server.version negotiates)
 *   - is on the BCH chain — genesis alone cannot prove this (BTC shares
 *     block 0, BSV shares history to 556766), so we check the block-header
 *     hash at two fork heights. Wrong-chain servers are rejected loudly.
 *
 * TLS policy (honest, per transport):
 *   - hostname + valid cert  → tlsStrict: true  (authenticated transport)
 *   - hostname/IP, self-signed or IP-SAN-less cert → ssl with
 *     rejectUnauthorized: false (encrypted, UNauthenticated — standard
 *     Electrum practice, surfaced as tlsStrict: false, scored lower)
 *   - tcp only → cleartext (public chain data; still surfaced)
 */

import { resolve4, resolve6 } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { FulcrumClient } from '../fulcrum/client.js';
import { getNetwork } from '../networks.js';
import { newHealth, recordSuccess } from './health.js';
import { isPublicIp } from '../net/public-destination.js';

// Back-compat exports (mainnet values). The per-network truth — including
// chipnet/testnet4 checkpoints and curated lists — lives in src/networks.js.
export const DNS_SEED = getNetwork('mainnet').dnsSeed;
export const CHECKPOINTS = getNetwork('mainnet').checkpoints;

const DEFAULTS = {
  probeTimeoutMs: 6_000,
  concurrency: 8,
  maxProbes: 24,        // seed + curated + a slice of gossip — polite, plenty
  gossipPerServer: 12,  // top-of-list peers from each responding server
};

/** Double-SHA256 of a hex block header, reversed — the block hash. */
export function headerHash(headerHex) {
  const h1 = createHash('sha256').update(Buffer.from(headerHex, 'hex')).digest();
  return createHash('sha256').update(h1).digest().reverse().toString('hex');
}

/** Bounded-concurrency map; failures land as nulls. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return results;
}

const isOnion = (h) => typeof h === 'string' && h.endsWith('.onion');
const isIp = (h) => isIP(h) !== 0;

// Public Fulcrum deployments use a small family of conventional port groups.
// Gossip is untrusted; constraining it prevents Cascan from becoming a generic
// public port scanner while retaining the ports observed in BCH fleets.
const GOSSIP_PORT_GROUPS = Object.freeze([5000, 50000, 51000, 60000, 62000, 62100, 64000]);
const GOSSIP_ALLOWED_PORTS = new Set(
  GOSSIP_PORT_GROUPS.flatMap(base => [1, 2, 3, 4].map(offset => base + offset)),
);

export function isAllowedDiscoveryPort(port) {
  return Number.isInteger(port) && GOSSIP_ALLOWED_PORTS.has(port);
}

/**
 * Hostname sanity gate — gossip and cache data are untrusted input. A
 * "hostname" carrying ANSI escapes, whitespace, or exotic bytes is garbage
 * by definition, so it is rejected at the boundary rather than sanitized at
 * every display sink.
 * Accepts DNS names, IPv4, and bare IPv6 literals.
 */
export function isValidHostname(h) {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false;
  if (h.includes(':')) return isIP(h) === 6;
  if (/^[0-9.]+$/.test(h)) return isIP(h) === 4;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h);
}

/** Cap + strip control chars from server-supplied metadata strings. */
function cleanMetaString(s, max = 64) {
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, max) || null;
}

/**
 * Parse one server.peers.subscribe entry:
 *   [ip, hostname, ["v1.6", "s50002", "t50001"]]
 * @returns {{ host: string, ports: { ssl: number|null, tcp: number|null } } | null}
 */
export function parsePeerEntry(entry) {
  if (!Array.isArray(entry) || entry.length < 3 || !Array.isArray(entry[2])) return null;
  const host = typeof entry[1] === 'string' && entry[1].length > 0 ? entry[1] : entry[0];
  if (typeof host !== 'string' || host.length === 0 || isOnion(host) || !isValidHostname(host)) return null;

  let ssl = null, tcp = null;
  for (const f of entry[2]) {
    if (typeof f !== 'string') continue;
    if (f[0] === 's') { const p = Number(f.slice(1)); if (isAllowedDiscoveryPort(p)) ssl = p; }
    if (f[0] === 't') { const p = Number(f.slice(1)); if (isAllowedDiscoveryPort(p)) tcp = p; }
  }
  if (ssl === null && tcp === null) return null;
  if (isIp(host) && !isPublicIp(host)) return null;
  return { host, ports: { ssl, tcp } };
}

/**
 * Try to connect to a candidate over the transports it plausibly supports,
 * most-authenticated first. Returns a live client + transport facts.
 */
async function connectCandidate(cand, opts) {
  const attempts = [];
  if (cand.ports.ssl) {
    if (!isIp(cand.host)) attempts.push({ port: cand.ports.ssl, tls: true, reject: true, tlsStrict: true });
    attempts.push({ port: cand.ports.ssl, tls: true, reject: false, tlsStrict: false });
  }
  if (cand.ports.tcp) {
    attempts.push({ port: cand.ports.tcp, tls: false, reject: false, tlsStrict: false, cleartext: true });
  }

  let lastErr = null;
  for (const a of attempts) {
    const client = new FulcrumClient({
      host: cand.host, port: a.port, tls: a.tls,
      rejectUnauthorized: a.reject,
      timeoutMs: opts.probeTimeoutMs,
      publicOnly: true,
      lookup: opts.publicLookup,
    });
    const t0 = Date.now();
    try {
      await client.connect();
      return { client, latencyMs: Date.now() - t0, tlsStrict: a.tlsStrict === true, transport: a.tls ? 'ssl' : 'tcp', port: a.port };
    } catch (err) {
      lastErr = err;
      client.close();
    }
  }
  throw lastErr ?? new Error('no transport available');
}

/**
 * Probe one candidate: connect, verify chain checkpoints, collect height,
 * current height and peer gossip. Remote metadata cannot rewrite the exact
 * endpoint that was validated.
 *
 * @returns {{ server: object, gossip: Array }} verified record + raw peers
 * @throws on unreachable / wrong chain / protocol failure
 */
async function probeCandidate(cand, opts) {
  const { client, latencyMs, tlsStrict, transport, port } = await connectCandidate(cand, opts);
  try {
    // Chain identity — every checkpoint must match, or the server is on the
    // wrong chain for this network (BTC/BSV for mainnet; testnet4 vs
    // chipnet for the test networks).
    for (const cp of opts.checkpoints) {
      const hex = await client.request('blockchain.block.header', [cp.height]);
      const got = headerHash(hex);
      if (got !== cp.hash) {
        throw new Error(`wrong chain: header @${cp.height} = ${got.slice(0, 16)}… (expected ${opts.networkName} ${cp.hash.slice(0, 16)}…)`);
      }
    }

    const tip = await client.request('blockchain.headers.subscribe').catch(() => null);

    let gossip = [];
    try {
      const peers = await client.request('server.peers.subscribe');
      if (Array.isArray(peers)) gossip = peers.slice(0, opts.gossipPerServer);
    } catch { /* optional */ }

    const health = newHealth();
    recordSuccess(health, latencyMs, tip?.height ?? null);

    return {
      server: {
        host: cand.host,
        ports: { ...cand.ports },
        source: cand.source,
        transport,
        port,
        tlsStrict,
        software: cleanMetaString(client.serverVersion?.[0]),
        protocol: cleanMetaString(client.serverVersion?.[1], 16),
        verified: true,
        aliases: [],
        health,
      },
      gossip,
    };
  } finally {
    client.close();
  }
}

/**
 * Discover, verify, and rank the server pool.
 *
 * @param {{
 *   seedHost?: string,
 *   curated?: Array,           — fallback/base list (servers.js shape)
 *   probeTimeoutMs?: number,
 *   concurrency?: number,
 *   maxProbes?: number,
 *   gossipPerServer?: number,
 *   dnsResolve?: (host: string) => Promise<string[]>,  — injectable for tests
 *   probe?: typeof probeCandidate,                     — injectable for tests
 *   onLog?: (msg: string) => void,
 * }} [options]
 * @returns {Promise<{
 *   servers: Array,       — verified, health-seeded records
 *   rejected: Array<{ host: string, reason: string }>,
 *   meta: { seedIps: number, candidates: number, probed: number, sources: object },
 * }>}
 */
export async function discoverServers(options = {}) {
  const net = getNetwork(options.network ?? 'mainnet');
  const opts = {
    ...DEFAULTS,
    checkpoints: net.checkpoints,
    networkName: net.name,
    seedHost: net.dnsSeed,
    ...options,
  };
  const dnsResolve = opts.dnsResolve ?? resolve4;
  const probe = opts.probe ?? probeCandidate;
  const log = opts.onLog ?? (() => {});
  const curated = opts.curated ?? net.curated;

  // ── Candidate assembly ────────────────────────────────────────────────
  const candidates = [];
  const rejected = [];
  const seen = new Set(); // dedupe by host

  const addCandidate = (host, ports, source) => {
    if (!host || isOnion(host) || !isValidHostname(host) || seen.has(host)) return;
    if (isIp(host) && !isPublicIp(host)) {
      rejected.push({ host, reason: 'destination is not a public IP address' });
      seen.add(host);
      return;
    }
    seen.add(host);
    candidates.push({ host, ports, source });
  };

  for (const s of curated) {
    addCandidate(s.host, { ssl: s.ports.ssl ?? null, tcp: s.ports.tcp ?? null }, 'curated');
  }

  let seedIps = [];
  if (opts.seedHost) {
    try {
      const v4 = await dnsResolve(opts.seedHost);
      // AAAA records too — v6-only servers are part of the fleet. Optional:
      // a v4-only resolver failing the AAAA query must not sink discovery.
      const v6 = opts.dnsResolve ? [] : await resolve6(opts.seedHost).catch(() => []);
      seedIps = [...v4, ...v6];
      log(`DNS seed ${opts.seedHost}: ${seedIps.length} address(es)${v6.length ? ` (${v6.length} IPv6)` : ''}`);
    } catch (err) {
      log(`DNS seed unreachable (${err.message}) — continuing with curated + gossip`);
    }
  } else {
    log(`no DNS seed for ${net.name} — curated + gossip only`);
  }
  for (const ip of seedIps) {
    addCandidate(ip, { ssl: 50002, tcp: 50001 }, 'seed');
  }

  // ── Probe wave 1: curated + seed ──────────────────────────────────────
  const servers = [];
  const gossipPool = [];
  const acceptedHosts = new Set();

  const runProbes = async (cands) => {
    const results = await mapLimit(cands, opts.concurrency, async (cand) => {
      try {
        return await probe(cand, opts);
      } catch (err) {
        rejected.push({ host: cand.host, reason: err?.message ?? String(err) });
        return null;
      }
    });
    for (const r of results) {
      if (!r) continue;
      const key = r.server.host;
      if (acceptedHosts.has(key)) continue; // canonical-host dedupe (IP → hostname)
      acceptedHosts.add(key);
      for (const a of r.server.aliases) acceptedHosts.add(a);
      // Security policy travels with the record. Direct consumers of the
      // exported discoverServers() result must receive the same DNS/IP guard
      // as resolvePool(), ServerPool, and the quorum adapters.
      servers.push({ ...r.server, publicOnly: true });
      gossipPool.push(...r.gossip);
    }
  };

  await runProbes(candidates);

  // ── Probe wave 2: gossip (bounded) ────────────────────────────────────
  const gossipCands = [];
  for (const entry of gossipPool) {
    const parsed = parsePeerEntry(entry);
    if (!parsed || seen.has(parsed.host) || acceptedHosts.has(parsed.host)) continue;
    seen.add(parsed.host);
    gossipCands.push({ ...parsed, source: 'gossip' });
    if (servers.length + gossipCands.length >= opts.maxProbes) break;
  }
  if (gossipCands.length > 0) {
    log(`probing ${gossipCands.length} gossip peer(s)`);
    await runProbes(gossipCands);
  }

  const sources = servers.reduce((acc, s) => { acc[s.source] = (acc[s.source] ?? 0) + 1; return acc; }, {});
  log(`pool: ${servers.length} verified (${Object.entries(sources).map(([k, v]) => `${v} ${k}`).join(', ')}), ${rejected.length} rejected`);

  return {
    servers,
    rejected,
    meta: {
      seedIps: seedIps.length,
      candidates: seen.size,
      probed: servers.length + rejected.length,
      sources,
    },
  };
}
