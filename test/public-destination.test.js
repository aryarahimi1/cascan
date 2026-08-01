import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPinnedLookup,
  isBlockedHostname,
  isPublicIp,
  resolvePublicAddresses,
  UnsafeDestinationError,
} from '../src/net/public-destination.js';
import { FulcrumClient } from '../src/fulcrum/client.js';
import { hardenCachedServers, resolvePool, toQuorumEntry } from '../src/pool/resolve.js';
import { ServerPool } from '../src/pool/pool.js';

test('public destination: accepts global IPv4/IPv6 and blocks special-use ranges', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPublicIp(address), true, address);
  }
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2001:db8::1', 'fc00::1',
    'fe80::1', 'fe80::1%lo0', 'ff02::1',
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
});

test('public destination: blocks local and cloud metadata hostnames', () => {
  for (const hostname of [
    'localhost', 'api.localhost', 'metadata', 'metadata.google.internal',
    'instance-data.ec2.internal', 'printer.local', 'redis.internal', 'router.lan',
  ]) {
    assert.equal(isBlockedHostname(hostname), true, hostname);
  }
  assert.equal(isBlockedHostname('electrum.imaginary.cash'), false);
});

test('public destination: rejects a mixed public/private DNS answer instead of filtering it', async () => {
  const lookup = async () => [
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(
    () => resolvePublicAddresses('attacker.example', { lookup }),
    err => err instanceof UnsafeDestinationError && /non-public/.test(err.message),
  );
});

test('public destination: rejects malformed family claims and unsafe pin sets', async () => {
  await assert.rejects(
    () => resolvePublicAddresses('mismatch.example', {
      lookup: async () => [{ address: '2606:4700:4700::1111', family: 4 }],
    }),
    UnsafeDestinationError,
  );
  assert.throws(
    () => createPinnedLookup([{ address: '127.0.0.1', family: 4 }]),
    UnsafeDestinationError,
  );
});

test('public destination: validated DNS answers are pinned into the socket lookup', async () => {
  let lookups = 0;
  const records = await resolvePublicAddresses('fulcrum.example', {
    lookup: async () => {
      lookups++;
      return [
        { address: '1.1.1.1', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ];
    },
  });
  const pinned = createPinnedLookup(records);
  const all = await new Promise((resolve, reject) => {
    pinned('fulcrum.example', { all: true }, (err, answers) => err ? reject(err) : resolve(answers));
  });
  const v4 = await new Promise((resolve, reject) => {
    pinned('fulcrum.example', { family: 4 }, (err, address, family) => (
      err ? reject(err) : resolve({ address, family })
    ));
  });
  assert.equal(lookups, 1, 'DNS is resolved once before the socket is created');
  assert.deepEqual(all, records);
  assert.deepEqual(v4, { address: '1.1.1.1', family: 4 });
});

test('FulcrumClient publicOnly rejects loopback and mixed DNS before opening a socket', async () => {
  const literal = new FulcrumClient({
    host: '127.0.0.1', port: 50002, tls: false, publicOnly: true, timeoutMs: 20,
  });
  await assert.rejects(() => literal.connect(), /not a public IP address/);

  const rebound = new FulcrumClient({
    host: 'rebind.example',
    port: 50002,
    tls: false,
    publicOnly: true,
    timeoutMs: 20,
    lookup: async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ],
  });
  await assert.rejects(() => rebound.connect(), /non-public address/);
});

test('cache hardening rejects private, arbitrary-port, and unverified records', () => {
  const valid = {
    host: '1.1.1.1',
    ports: { ssl: 50002, tcp: 50001 },
    transport: 'ssl',
    port: 50002,
    tlsStrict: false,
    verified: true,
  };
  assert.equal(hardenCachedServers([valid])?.[0].publicOnly, true);
  assert.equal(hardenCachedServers([{ ...valid, host: '127.0.0.1' }]), null);
  assert.equal(hardenCachedServers([{ ...valid, port: 8080 }]), null);
  assert.equal(hardenCachedServers([{ ...valid, verified: false }]), null);
});

test('default curated/discovery records retain public-only dialing through pool and quorum', async () => {
  const resolved = await resolvePool({ discover: false, network: 'mainnet' });
  assert.ok(resolved.servers.length >= 3);
  assert.ok(resolved.servers.every(record => record.publicOnly === true));

  const pool = new ServerPool([resolved.servers[0]]);
  const client = pool._clientFactory(pool.servers[0]);
  assert.equal(client.publicOnly, true);
  assert.equal(toQuorumEntry(resolved.servers[0]).publicOnly, true);
  client.close();
  pool.close();
});
