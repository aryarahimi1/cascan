/**
 * test/pool.test.js
 *
 * Pure pool-layer tests (no network): health scoring math, failover
 * semantics, and the subscription-resurrection guarantee — the load-bearing
 * reliability guarantees of the public library.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consensusHeight, newHealth, recordSuccess, recordFailure, recordHeight, scoreServer, rankServers, SCORING } from '../src/pool/health.js';
import { ServerPool } from '../src/pool/pool.js';
import { AllServersFailedError } from '../src/fulcrum/errors.js';
import { toQuorumEntry } from '../src/pool/resolve.js';
import { MAX_REASONABLE_BCH_HEIGHT } from '../src/validation.js';
import { checkpointHeader } from './checkpoint-fixtures.js';

// ---------------------------------------------------------------------------
// health scoring
// ---------------------------------------------------------------------------

test('health: latency EMA converges toward new observations', () => {
  const h = newHealth();
  recordSuccess(h, 100);
  assert.equal(h.latencyEmaMs, 100);
  recordSuccess(h, 200);
  // 0.3 × 200 + 0.7 × 100 = 130
  assert.equal(h.latencyEmaMs, 130);
});

test('health: success resets consecutive failures', () => {
  const h = newHealth();
  recordFailure(h); recordFailure(h);
  assert.equal(h.failures, 2);
  recordSuccess(h, 50);
  assert.equal(h.failures, 0);
});

test('health: invalid server heights cannot enter ranking state', () => {
  const h = newHealth();
  recordSuccess(h, 10, 100);
  const observedAt = h.heightAt;
  for (const invalid of [-1, 100.5, Number.MAX_SAFE_INTEGER, MAX_REASONABLE_BCH_HEIGHT + 1]) {
    recordHeight(h, invalid);
    assert.equal(h.height, 100);
    assert.equal(h.heightAt, observedAt);
  }
});

test('score: fast healthy server beats slow one; failures dominate latency', () => {
  const now = Date.now();
  const fast = { health: { ...newHealth(), latencyEmaMs: 100, lastFailAt: 0 } };
  const slow = { health: { ...newHealth(), latencyEmaMs: 1500, lastFailAt: 0 } };
  const failing = { health: { ...newHealth(), latencyEmaMs: 100, failures: 2, lastFailAt: 0 } };
  assert.ok(scoreServer(fast, null, now) > scoreServer(slow, null, now));
  assert.ok(scoreServer(slow, null, now) > scoreServer(failing, null, now), 'two failures outweigh 1.4s of latency');
});

test('score: FRESH height lag penalized, capped; recent failure flap-guarded', () => {
  const now = Date.now();
  const lagging = { health: { ...newHealth(), latencyEmaMs: 100, height: 100, heightAt: now } };
  const current = { health: { ...newHealth(), latencyEmaMs: 100, height: 105, heightAt: now } };
  const lagScore = scoreServer(lagging, 105, now);
  assert.equal(scoreServer(current, 105, now) - lagScore, SCORING.LAG_PENALTY * SCORING.LAG_CAP, 'lag of 5 capped at 3 blocks');

  const flapped = { health: { ...newHealth(), latencyEmaMs: 100, lastFailAt: now - 60_000 } };
  const stable = { health: { ...newHealth(), latencyEmaMs: 100, lastFailAt: now - 10 * 60_000 } };
  assert.equal(scoreServer(stable, null, now) - scoreServer(flapped, null, now), SCORING.RECENT_FAIL_PENALTY);
});

// Regression (live-demo bug): after a new block, the connected server's
// height updates live while idle members keep a stale observation — stale
// heights must NOT be scored as lag, or the just-killed server outranks
// every healthy alternative and failover reconnects to it.
test('score: STALE height observations are ignored for lag (failover re-pick bug)', () => {
  const now = Date.now();
  const staleIdle = { health: { ...newHealth(), latencyEmaMs: 100, height: 100, heightAt: now - SCORING.HEIGHT_FRESH_MS - 1 } };
  const freshIdle = { health: { ...newHealth(), latencyEmaMs: 100, height: 101, heightAt: now } };
  assert.equal(scoreServer(staleIdle, 101, now), scoreServer(freshIdle, 101, now), 'stale observation carries no lag penalty');

  // The demo scenario: killed server has fresh height + fresh failure; idle
  // alternative has stale height. The alternative must win.
  const justKilled = { health: { ...newHealth(), latencyEmaMs: 100, height: 101, heightAt: now, failures: 1, lastFailAt: now } };
  const ranked = rankServers([justKilled, staleIdle], now);
  assert.equal(ranked[0], staleIdle, 'healthy idle server outranks the just-killed one');
});

test('rank: best-first, TLS-verified bonus breaks ties', () => {
  const a = { host: 'a', tlsStrict: false, health: { ...newHealth(), latencyEmaMs: 200 } };
  const b = { host: 'b', tlsStrict: true, health: { ...newHealth(), latencyEmaMs: 200 } };
  const ranked = rankServers([a, b]);
  assert.equal(ranked[0].host, 'b');
});

test('rank: one fabricated future height cannot penalize corroborating peers', () => {
  const honestA = { host: 'honest-a', tlsStrict: true, health: newHealth() };
  const honestB = { host: 'honest-b', tlsStrict: true, health: newHealth() };
  const attacker = { host: 'attacker', tlsStrict: false, health: newHealth() };
  recordSuccess(honestA.health, 100, 900_000);
  recordSuccess(honestB.health, 120, 900_000);
  recordSuccess(attacker.health, 500, 900_003);

  assert.equal(consensusHeight([honestA, honestB, attacker]), 900_000);
  assert.equal(rankServers([attacker, honestA, honestB])[0].host, 'honest-a');

  // Without two matching observations, height lag is not considered at all.
  assert.equal(consensusHeight([honestA, attacker]), null);
});

test('transport: pool and quorum preserve the discovery-verified TCP endpoint', () => {
  const record = {
    host: 'tcp-only.test',
    ports: { ssl: 50002, tcp: 50001 },
    transport: 'tcp',
    port: 50001,
    tlsStrict: false,
  };
  const pool = new ServerPool([record], { allowInsecureTransport: true });
  const client = pool._clientFactory(pool.servers[0]);
  assert.equal(client.transport, 'tcp');
  assert.equal(client.port, 50001);
  pool._current = pool.servers[0];
  assert.equal(pool.current, 'tcp-only.test:50001');
  const quorum = toQuorumEntry(record);
  assert.equal(quorum.transport, 'tcp');
  assert.equal(quorum.port, 50001);
  assert.deepEqual(quorum.ports, record.ports);
  assert.equal(quorum.operator, undefined, 'an endpoint source label is not an operator identity');
  client.close();
  pool.close();
});

// ---------------------------------------------------------------------------
// FakeClient — deterministic Electrum server stand-in
// ---------------------------------------------------------------------------

class FakeClient {
  /**
   * @param {{ name: string, connectFails?: boolean,
   *           handlers: Record<string, (params: any[]) => any> }} spec
   * handlers throw strings prefixed 'TRANSPORT:' to simulate socket death.
   */
  constructor(spec) {
    this.spec = spec;
    this.name = spec.name;
    this.connected = false;
    this._notify = [];
    this._socket = { once() {}, destroyed: false };
    this.serverVersion = ['FakeFulcrum 1.0', '1.6'];
    this.subscribed = [];
  }
  async connect() {
    if (this.spec.connectFails) throw new Error(`connect timeout after 1ms`);
    this.connected = true;
    return this;
  }
  async request(method, params = []) {
    if (!this.connected) throw new Error('not connected');
    const h = this.spec.handlers[method];
    if (!h && method === 'blockchain.block.header') return checkpointHeader(params);
    if (!h) return null;
    const out = h(params, this);
    if (typeof out === 'string' && out.startsWith('TRANSPORT:')) {
      this.connected = false; // socket died
      throw new Error(out.slice('TRANSPORT:'.length));
    }
    if (typeof out === 'string' && out.startsWith('APP:')) {
      throw new Error(out.slice('APP:'.length)); // connection stays up
    }
    return out;
  }
  onNotification(fn) { this._notify.push(fn); }
  fireNotification(method, params) { for (const fn of this._notify) fn(method, params); }
  close() { this.connected = false; }
}

function makePool(specs, opts = {}) {
  const clients = new Map();
  const servers = specs.map(s => ({ host: s.name, ports: { ssl: 50002 }, tlsStrict: true }));
  const pool = new ServerPool(servers, {
    ...opts,
    keepaliveMs: 3_600_000, // effectively off for tests
    clientFactory: (server) => {
      const spec = specs.find(s => s.name === server.host);
      const client = new FakeClient(spec);
      clients.set(server.host, client);
      return client;
    },
  });
  return { pool, clients };
}

const tipHandler = () => ({ height: 1000, hex: '00' });
const STATUS_A = 'a'.repeat(64);
const STATUS_B = 'b'.repeat(64);
const STATUS_C = 'c'.repeat(64);

// ---------------------------------------------------------------------------
// failover
// ---------------------------------------------------------------------------

test('pool: connects to first-ranked server; request succeeds', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: { 'blockchain.headers.subscribe': tipHandler, ping: () => true, 'x.y': () => 42 } },
    { name: 'beta', handlers: { 'blockchain.headers.subscribe': tipHandler, 'x.y': () => 43 } },
  ]);
  assert.equal(await pool.request('x.y'), 42);
  assert.equal(pool.current, 'alpha:50002');
  pool.close();
});

test('pool: dead first server → transparent failover to second', async () => {
  const { pool } = makePool([
    { name: 'alpha', connectFails: true, handlers: {} },
    { name: 'beta', handlers: { 'blockchain.headers.subscribe': tipHandler, 'x.y': () => 'from-beta' } },
  ]);
  const lost = [];
  pool.on('server-lost', (e) => lost.push(e.server));
  assert.equal(await pool.request('x.y'), 'from-beta');
  assert.equal(pool.current, 'beta:50002');
  assert.deepEqual(lost, ['alpha']);
  // Health remembers: alpha carries a failure, beta a success.
  assert.equal(pool.servers.find(s => s.host === 'alpha').health.failures, 1);
  assert.equal(pool.servers.find(s => s.host === 'beta').health.failures, 0);
  pool.close();
});

test('pool: mid-session transport death → request retried on next server', async () => {
  let alphaCalls = 0;
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'x.y': () => { alphaCalls++; return 'TRANSPORT:connection closed'; },
    } },
    { name: 'beta', handlers: { 'blockchain.headers.subscribe': tipHandler, 'x.y': () => 'rescued' } },
  ]);
  const events = [];
  pool.on('failover', (f) => events.push(`${f.from}→${f.to}`));

  assert.equal(await pool.request('x.y'), 'rescued');
  assert.equal(alphaCalls, 1);
  assert.deepEqual(events, ['alpha:50002→beta:50002']);
  pool.close();
});

test('pool: application error (tx not found) does NOT fail over', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'x.y': () => 'APP:daemon error: No such mempool or blockchain transaction',
    } },
    { name: 'beta', handlers: { 'blockchain.headers.subscribe': tipHandler, 'x.y': () => 'should-not-reach' } },
  ]);
  await assert.rejects(() => pool.request('x.y'), /No such mempool/);
  assert.equal(pool.current, 'alpha:50002', 'still on alpha — the answer was an answer');
  pool.close();
});

test('pool: every server dead → AllServersFailedError + exhausted event', async () => {
  const { pool } = makePool([
    { name: 'alpha', connectFails: true, handlers: {} },
    { name: 'beta', connectFails: true, handlers: {} },
  ]);
  let exhausted = null;
  pool.on('exhausted', (e) => { exhausted = e; });
  await assert.rejects(() => pool.request('x.y'), AllServersFailedError);
  assert.ok(exhausted, 'exhausted event emitted');
  assert.equal(exhausted.errors.length, 2);
  pool.close();
});

// ---------------------------------------------------------------------------
// subscription resurrection — the guarantee that makes watch safe
// ---------------------------------------------------------------------------

test('pool: subscription survives failover; unchanged status stays silent', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
      'x.y': () => 'TRANSPORT:connection closed',
    } },
    { name: 'beta', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A, // nothing changed during gap
    } },
  ]);

  const fired = [];
  const status0 = await pool.subscribeAddress('bitcoincash:qqaddr', (s) => fired.push(s));
  assert.equal(status0, STATUS_A);

  await pool.request('x.y').catch(() => {}); // kill alpha → failover
  assert.equal(pool.current, 'beta:50002');
  assert.equal(clients.get('beta').spec.handlers['blockchain.address.subscribe'] != null, true);
  assert.deepEqual(fired, [], 'same status on new server → no spurious event');
  pool.close();
});

test('pool: status change DURING failover gap is delivered, not lost', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
      'x.y': () => 'TRANSPORT:connection closed',
    } },
    { name: 'beta', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_B, // a payment landed mid-gap
    } },
  ]);

  const fired = [];
  await pool.subscribeAddress('bitcoincash:qqaddr', (s) => fired.push(s));
  await pool.request('x.y').catch(() => {}); // force failover

  assert.deepEqual(fired, [STATUS_B], 'the payment that landed between servers was delivered');
  pool.close();
});

test('pool: failed resubscribe rejects the candidate and continues failover', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
      'x.y': () => 'TRANSPORT:connection closed',
    } },
    { name: 'beta', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => 'APP:temporary resubscribe failure',
    } },
    { name: 'gamma', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_B,
      'x.y': () => 'recovered',
    } },
  ]);

  const fired = [];
  await pool.subscribeAddress('bitcoincash:qqaddr', status => fired.push(status));
  assert.equal(await pool.request('x.y'), 'recovered');
  assert.equal(pool.current, 'gamma:50002');
  assert.deepEqual(fired, [STATUS_B]);
  assert.equal(pool.servers.find(s => s.host === 'beta').health.failures, 1);
  pool.close();
});

test('pool: live notifications dispatch to subscribers and update lastStatus', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
    } },
  ]);

  const fired = [];
  await pool.subscribeAddress('bitcoincash:qqaddr', (s) => fired.push(s));
  clients.get('alpha').fireNotification('blockchain.address.subscribe', ['bitcoincash:qqaddr', STATUS_C]);
  assert.deepEqual(fired, [STATUS_C]);
  // header notifications keep height fresh for lag scoring
  clients.get('alpha').fireNotification('blockchain.headers.subscribe', [{ height: 1234 }]);
  assert.equal(pool.servers.find(s => s.host === 'alpha').health.height, 1234);
  pool.close();
});

test('pool: invalid header notifications cannot poison health or fire block callbacks', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', handlers: { 'blockchain.headers.subscribe': tipHandler } },
  ]);
  const blocks = [];
  pool.on('block', block => blocks.push(block));
  await pool.acquire();

  clients.get('alpha').fireNotification(
    'blockchain.headers.subscribe',
    [{ height: MAX_REASONABLE_BCH_HEIGHT + 1, hex: 'attacker-controlled' }],
  );

  assert.equal(pool.servers[0].health.height, 1000);
  assert.deepEqual(blocks, []);
  pool.close();
});

test('pool: invalid transaction subscription heights are rejected', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.transaction.subscribe': () => MAX_REASONABLE_BCH_HEIGHT + 1,
    } },
  ]);

  await assert.rejects(
    () => pool.subscribeTransaction('a'.repeat(64), () => {}),
    /invalid BCH transaction height/,
  );
  assert.equal(pool._txSubs.size, 0, 'rejected subscription must not retain a callback');
  pool.close();
});

test('pool: rejected address subscriptions do not retain callbacks', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => 'not-a-status-hash',
    } },
  ]);

  await assert.rejects(
    () => pool.subscribeAddress('bitcoincash:qptest', () => {}),
    /invalid Electrum address status/,
  );
  assert.equal(pool._subs.size, 0, 'rejected subscription must not retain a callback');
  pool.close();
});

test('pool: malformed initial status fails over and retries against a healthy server', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => 'not-a-status-hash',
    } },
    { name: 'beta', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
    } },
  ]);
  // Without explicit exclusion, alpha's low latency can still outweigh beta
  // after a single failure and cause the retry to hit alpha again.
  pool.servers.find(server => server.host === 'beta').health.latencyEmaMs = 5_000;

  assert.equal(
    await pool.subscribeAddress('bitcoincash:qptest', () => {}),
    STATUS_A,
  );
  assert.equal(pool.current, 'beta:50002');
  pool.close();
});

test('pool: malformed initial transaction heights skip every hostile endpoint before retrying', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.transaction.subscribe': () => MAX_REASONABLE_BCH_HEIGHT + 1,
    } },
    { name: 'beta', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.transaction.subscribe': () => MAX_REASONABLE_BCH_HEIGHT + 1,
    } },
    { name: 'gamma', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.transaction.subscribe': () => 1000,
    } },
  ]);
  pool.servers.find(server => server.host === 'beta').health.latencyEmaMs = 5_000;
  pool.servers.find(server => server.host === 'gamma').health.latencyEmaMs = 5_000;

  assert.equal(await pool.subscribeTransaction('a'.repeat(64), () => {}), 1000);
  assert.equal(pool.current, 'gamma:50002');
  pool.close();
});

test('pool: malformed address notifications never reach callbacks', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
    } },
  ]);
  const fired = [];
  await pool.subscribeAddress('bitcoincash:qptest', status => fired.push(status));

  clients.get('alpha').fireNotification(
    'blockchain.address.subscribe',
    ['bitcoincash:qptest', 'not-a-status-hash'],
  );

  assert.deepEqual(fired, []);
  pool.close();
});

test('pool: unsubscribe removes interest; last unsubscriber clears the address', async () => {
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
      'blockchain.address.unsubscribe': () => true,
    } },
  ]);
  const fired = [];
  const cb = (s) => fired.push(s);
  await pool.subscribeAddress('bitcoincash:qqaddr', cb);
  pool.unsubscribeAddress('bitcoincash:qqaddr', cb);
  assert.equal(pool._subs.size, 0);
  pool.close();
});
