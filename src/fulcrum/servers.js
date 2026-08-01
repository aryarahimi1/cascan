/**
 * src/fulcrum/servers.js
 *
 * Curated public Fulcrum servers for BCH mainnet. These are anonymous
 * public endpoints — no account, no API key — the same trust model as
 * glnc's public-RPC lists, and the same caveat: a single server is one
 * operator's view of the chain. That's why cascan queries several.
 *
 * Ports follow Electrum convention: 50001 TCP, 50002 SSL.
 * 50003/50004 (WS/WSS) are probed by scripts/spike.mjs and recorded in
 * README — the no-backend browser dapp depends on WSS availability.
 *
 * TLS note: automatic/payment paths accept only valid, hostname-authenticated
 * certificates. Insecure community endpoints remain visible in the network
 * registry but require an explicit non-payment transport opt-in.
 */

// Probe results 2026-07-28 (scripts/spike.mjs, see spike-results.*.json):
//   electrum.imaginary.cash  SSL 259ms + TCP + WS + WSS  (Fulcrum 2.1.1, protocol 1.6)
//   bch.loping.net           SSL 907ms + TCP + WS + WSS
//   bch.cyberbits.eu         SSL 327ms only
//   fulcrum.jettscythe.xyz   TCP only (no SSL) — not in the quorum set
//   electroncash.de          dead on all ports — removed
import { getNetwork } from '../networks.js';

// The canonical curated lists live in src/networks.js (per network, next to
// each network's checkpoints and prefixes). This export remains the mainnet
// list for backward compatibility.
export const DEFAULT_FULCRUM_SERVERS = [...getNetwork('mainnet').curated];

/**
 * Curated servers for a network (quorum fallback / discovery base).
 * @param {string} [network]
 */
export function quorumServers(network = 'mainnet') {
  return [...getNetwork(network).curated];
}

/**
 * --server host:port override: pin all queries to one user-specified server
 * (single-element list → quorum modes still work, they just have one voter).
 * Returns null when no override was given.
 *
 * @param {string|null} spec - 'host:port' (already validated by args parser)
 * @returns {Array|null}
 */
export function serverOverride(spec) {
  if (!spec) return null;
  const [host, portStr] = spec.split(':');
  const port = Number(portStr);
  return [{
    host,
    ports: { tcp: port, ssl: port, ws: port + 1, wss: port + 2 },
    operator: 'user-specified (--server)',
  }];
}
