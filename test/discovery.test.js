/**
 * test/discovery.test.js
 *
 * Discovery-layer tests with injected DNS + probe (no network): candidate
 * assembly, gossip parsing, dedupe, checkpoint constants, fallback paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverServers, parsePeerEntry, headerHash, CHECKPOINTS, isValidHostname } from '../src/pool/discovery.js';
import { newHealth, recordSuccess } from '../src/pool/health.js';

// ---------------------------------------------------------------------------
// parsePeerEntry — server.peers.subscribe shapes (live-probed 2026-07-29)
// ---------------------------------------------------------------------------

test('peers: hostname entry with ssl+tcp ports', () => {
  const p = parsePeerEntry(['183.89.202.207', 'bch.loping.net', ['v1.6', 's50002', 't50001']]);
  assert.deepEqual(p, { host: 'bch.loping.net', ports: { ssl: 50002, tcp: 50001 } });
});

test('peers: IP-only entry, non-standard tcp port', () => {
  const p = parsePeerEntry(['193.138.218.77', 'se-mma.mullvad.net', ['v1.6', 't5001']]);
  assert.deepEqual(p, { host: 'se-mma.mullvad.net', ports: { ssl: null, tcp: 5001 } });
});

test('peers: onion peers skipped; garbage skipped; portless skipped', () => {
  assert.equal(parsePeerEntry(['x.onion', 'x.onion', ['v1.6', 's50002']]), null);
  assert.equal(parsePeerEntry(['1.2.3.4', 'host', ['v1.6']]), null, 'no ports advertised');
  assert.equal(parsePeerEntry(['1.2.3.4', 'host', 'not-an-array']), null);
  assert.equal(parsePeerEntry(null), null);
  assert.equal(parsePeerEntry(['1.2.3.4', 'host', ['s99999999']]), null, 'port out of range');
});

// Gossip hostnames are attacker-controlled input.
// A "hostname" carrying terminal escapes must never enter the pool.
test('peers: hostile hostnames (ANSI/OSC escapes, whitespace, oversize) rejected at the boundary', () => {
  assert.equal(parsePeerEntry(['1.2.3.4', '\x1b]8;;https://evil.example\x07click\x1b]8;;\x07', ['v1.6', 's50002']]), null, 'OSC 8 hyperlink');
  assert.equal(parsePeerEntry(['1.2.3.4', 'evil\x1b[2Jhost.com', ['v1.6', 's50002']]), null, 'screen-clear CSI');
  assert.equal(parsePeerEntry(['1.2.3.4', 'host name.com', ['v1.6', 's50002']]), null, 'embedded whitespace');
  assert.equal(parsePeerEntry(['1.2.3.4', 'a'.repeat(300) + '.com', ['v1.6', 's50002']]), null, 'oversize hostname');
  assert.equal(isValidHostname('bch.loping.net'), true);
  assert.equal(isValidHostname('95.216.217.48'), true);
  assert.equal(isValidHostname('2604:a880:4:1d0:0:1:455:2000'), true, 'IPv6 literal');
  assert.equal(isValidHostname('-leading-dash.com'), false);
});

// ---------------------------------------------------------------------------
// headerHash + checkpoints
// ---------------------------------------------------------------------------

test('headerHash: double-SHA256 reversed (bitcoin block hash rule)', () => {
  // Bitcoin genesis header → the famous 000000000019d6689c085ae165831e93…
  const genesisHeader =
    '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
  assert.equal(headerHash(genesisHeader), '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
});

test('checkpoints: both fork heights pinned (BTC split + BSV split)', () => {
  assert.equal(CHECKPOINTS.length, 2);
  assert.equal(CHECKPOINTS[0].height, 478559);
  assert.equal(CHECKPOINTS[1].height, 556767);
  for (const cp of CHECKPOINTS) assert.match(cp.hash, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// discoverServers — injected DNS + probe
// ---------------------------------------------------------------------------

function fakeProbeFactory(behavior) {
  // behavior: host → { fail?: string, gossip?: [], canonical?: string }
  return async (cand) => {
    const b = behavior[cand.host];
    if (!b) throw new Error('unreachable');
    if (b.fail) throw new Error(b.fail);
    const health = newHealth();
    recordSuccess(health, 100, 1000);
    return {
      server: {
        host: b.canonical ?? cand.host,
        ports: cand.ports,
        source: cand.source,
        transport: 'ssl',
        tlsStrict: true,
        software: 'Fake 1.0',
        protocol: '1.6',
        verified: true,
        aliases: b.canonical && b.canonical !== cand.host ? [cand.host] : [],
        health,
      },
      gossip: b.gossip ?? [],
    };
  };
}

const CURATED = [{ host: 'curated.example', ports: { ssl: 50002, tcp: 50001 } }];

test('discovery: seed IPs + curated probed; canonical hostname replaces IP', async () => {
  const d = await discoverServers({
    curated: CURATED,
    dnsResolve: async () => ['1.1.1.1'],
    probe: fakeProbeFactory({
      'curated.example': {},
      '1.1.1.1': { canonical: 'seeded.example' },
    }),
  });
  const hosts = d.servers.map(s => s.host).sort();
  assert.deepEqual(hosts, ['curated.example', 'seeded.example']);
  const seeded = d.servers.find(s => s.host === 'seeded.example');
  assert.deepEqual(seeded.aliases, ['1.1.1.1']);
  assert.equal(d.meta.sources.curated, 1);
  assert.equal(d.meta.sources.seed, 1);
});

test('discovery: gossip peers probed in wave 2, deduped against wave 1', async () => {
  const d = await discoverServers({
    curated: CURATED,
    dnsResolve: async () => [],
    probe: fakeProbeFactory({
      'curated.example': { gossip: [
        ['9.9.9.9', 'gossiped.example', ['v1.6', 's50002']],
        ['8.8.8.8', 'curated.example', ['v1.6', 's50002']],   // already known → skipped
        ['7.7.7.7', 'x.onion', ['v1.6', 's50002']],           // onion → skipped
      ] },
      'gossiped.example': {},
    }),
  });
  const hosts = d.servers.map(s => s.host).sort();
  assert.deepEqual(hosts, ['curated.example', 'gossiped.example']);
  assert.equal(d.servers.find(s => s.host === 'gossiped.example').source, 'gossip');
});

test('discovery: wrong-chain server rejected with the reason preserved', async () => {
  const d = await discoverServers({
    curated: CURATED,
    dnsResolve: async () => ['2.2.2.2'],
    probe: fakeProbeFactory({
      'curated.example': {},
      '2.2.2.2': { fail: 'wrong chain: header @478559 = deadbeef… (expected BCH 0000000000000000…)' },
    }),
  });
  assert.equal(d.servers.length, 1);
  assert.equal(d.rejected.length, 1);
  assert.match(d.rejected[0].reason, /wrong chain/);
});

test('discovery: DNS seed down → curated still probed, no throw', async () => {
  const d = await discoverServers({
    curated: CURATED,
    dnsResolve: async () => { throw new Error('ENOTFOUND'); },
    probe: fakeProbeFactory({ 'curated.example': {} }),
  });
  assert.equal(d.servers.length, 1);
  assert.equal(d.meta.seedIps, 0);
});

test('discovery: everything dead → empty pool, all rejections recorded', async () => {
  const d = await discoverServers({
    curated: CURATED,
    dnsResolve: async () => ['3.3.3.3'],
    probe: fakeProbeFactory({}), // nothing answers
  });
  assert.equal(d.servers.length, 0);
  assert.equal(d.rejected.length, 2);
});
