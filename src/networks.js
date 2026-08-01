/**
 * src/networks.js
 *
 * Network registry — everything that differs between BCH mainnet and its
 * test networks in one place: cashaddr prefix, legacy version bytes, the
 * DNS seed (mainnet only), chain-identity checkpoints, curated servers,
 * and the discovery-cache filename.
 *
 * Chipnet is the network CashScript developers actually build on — first-
 * class support here is what makes the CascanNetworkProvider usable for
 * contract development, not just production.
 *
 * Checkpoint provenance:
 *   mainnet  — cross-checked against 3 independent servers (2026-07-29):
 *              478559 = first BCH block after the BTC split,
 *              556767 = first BCH block after the BSV split
 *   chipnet  — cross-checked against 3 independent servers (2026-07-29):
 *              120000 and 300000, both past the testnet4→chipnet split
 *              (~115252, Nov 2022)
 *   testnet4 — single-source (testnet4.imaginary.cash, 2026-07-29; the
 *              other known public server was down) — labeled accordingly.
 *              120000 differs from chipnet's 120000, separating the chains.
 *
 * Curated `operator`/`infrastructure` ids are conservative maintained
 * groupings, reviewed 2026-07-31. They prevent endpoint aliases from gaining
 * votes but are not cryptographic proof of ownership independence.
 */

export const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    name: 'mainnet',
    cashaddrPrefix: 'bitcoincash',
    legacyP2PKH: 0x00,
    legacyP2SH: 0x05,
    dnsSeed: 'ec-seed.flowee.cash',
    cacheFile: 'servers.json',
    checkpoints: Object.freeze([
      { height: 478559, hash: '000000000000000000651ef99cb9fcbe0dadde1d424bd9f15ff20136191a5eec' },
      { height: 556767, hash: '0000000000000000004626ff6e3b936941d341c5932ece4357eeccac44e6d56c' },
    ]),
    curated: Object.freeze([
      { host: 'electrum.imaginary.cash', ports: { tcp: 50001, ssl: 50002 }, operator: 'imaginary.cash', infrastructure: 'imaginary.cash' },
      { host: 'bch.cyberbits.eu', ports: { tcp: 50001, ssl: 50002 }, operator: 'cyberbits.eu', infrastructure: 'cyberbits.eu' },
      { host: 'bch.loping.net', ports: { tcp: 50001, ssl: 50002 }, operator: 'loping.net', infrastructure: 'loping.net' },
    ]),
  }),

  chipnet: Object.freeze({
    name: 'chipnet',
    cashaddrPrefix: 'bchtest',
    legacyP2PKH: 0x6f,
    legacyP2SH: 0xc4,
    dnsSeed: null, // no public DNS seed for chipnet — curated + gossip only
    cacheFile: 'servers-chipnet.json',
    checkpoints: Object.freeze([
      { height: 120000, hash: '000000006a03896486da5a64d0145a8ff8ded7dc417b4ed57211d5137763287c' },
      { height: 300000, hash: '00000000142fbee39fa4ba154cd61677beb9d446cfd43fe80fda4e1579f5d06a' },
    ]),
    curated: Object.freeze([
      { host: 'chipnet.imaginary.cash', ports: { tcp: 50001, ssl: 50002 }, operator: 'imaginary.cash', infrastructure: 'imaginary.cash' },
      { host: 'chipnet.bch.ninja', ports: { tcp: null, ssl: 50002 }, operator: 'bch.ninja', infrastructure: 'bch.ninja' },
      { host: 'cbch.loping.net', ports: { tcp: 62101, ssl: 62102 }, operator: 'loping.net', infrastructure: 'loping.net' },
    ]),
  }),

  testnet4: Object.freeze({
    name: 'testnet4',
    cashaddrPrefix: 'bchtest',
    legacyP2PKH: 0x6f,
    legacyP2SH: 0xc4,
    dnsSeed: null,
    cacheFile: 'servers-testnet4.json',
    checkpoints: Object.freeze([
      // Single-source pins (see header) — better than no chain check at all.
      { height: 120000, hash: '000000000085b098b26bc2d9ccc88463da7e34bd91b56219763a49dc11069c18' },
      { height: 200000, hash: '00000000071ca109d9e44e26c1510922d2913ead12e8d2bd86d7bc7577806d7b' },
    ]),
    curated: Object.freeze([
      // Probed 2026-07-29: certificates were invalid. These require the
      // explicit non-payment allowInsecureTransport development mode.
      { host: 'testnet4.imaginary.cash', ports: { tcp: 50001, ssl: 50002 }, operator: 'imaginary.cash', infrastructure: 'imaginary.cash', tlsStrict: false },
      { host: 'tbch4.loping.net', ports: { tcp: 62103, ssl: 62104 }, operator: 'loping.net', infrastructure: 'loping.net', tlsStrict: false },
    ]),
  }),
});

export const NETWORK_NAMES = Object.freeze(Object.keys(NETWORKS));

/**
 * @param {string} [name]
 * @returns {(typeof NETWORKS)['mainnet']}
 */
export function getNetwork(name = 'mainnet') {
  const net = NETWORKS[name];
  if (!net) {
    throw new Error(`unknown network: ${JSON.stringify(name)} (expected: ${NETWORK_NAMES.join(', ')})`);
  }
  return net;
}

/**
 * Return security-voter metadata only when the host is in today's built-in
 * registry. Cache and gossip records are untrusted, so callers must derive
 * this metadata from code rather than accepting serialized claims.
 */
export function curatedIdentity(name = 'mainnet', host) {
  if (typeof host !== 'string') return null;
  const record = getNetwork(name).curated.find(
    server => server.host.toLowerCase() === host.toLowerCase(),
  );
  if (!record?.operator || !record?.infrastructure) return null;
  return { operator: record.operator, infrastructure: record.infrastructure };
}
