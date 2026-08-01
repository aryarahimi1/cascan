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
import { createManualTimers } from './helpers.js';

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
    await this.spec.connectGate;
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
  const created = new Map();
  const servers = specs.map(s => ({ host: s.name, ports: { ssl: 50002 }, tlsStrict: true }));
  const pool = new ServerPool(servers, {
    ...opts,
    keepaliveMs: 3_600_000, // effectively off for tests
    clientFactory: (server) => {
      const spec = specs.find(s => s.name === server.host);
      const client = new FakeClient(spec);
      clients.set(server.host, client);
      created.set(server.host, (created.get(server.host) ?? 0) + 1);
      return client;
    },
  });
  return { pool, clients, created };
}

const tipHandler = () => ({ height: 1000, hex: '00' });
const STATUS_A = 'a'.repeat(64);
const STATUS_B = 'b'.repeat(64);
const STATUS_C = 'c'.repeat(64);
const waitFor = async (predicate, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for pool state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

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

test('pool: close cancels a pending recovery timer even when its handle is zero', () => {
  const cleared = [];
  const { pool } = makePool([
    { name: 'alpha', handlers: {} },
  ], {
    setTimeout: () => 0,
    clearTimeout: handle => cleared.push(handle),
  });
  pool._everConnected = true;

  pool._scheduleRecovery();
  assert.equal(pool._recoveryTimer, 0);
  pool.close();

  assert.deepEqual(cleared, [0]);
  assert.equal(pool._recoveryTimer, null);
});

test('pool: close wins a race with an in-flight connection', async () => {
  let releaseConnect;
  const connectGate = new Promise(resolve => { releaseConnect = resolve; });
  const { pool } = makePool([
    { name: 'alpha', connectGate, handlers: { 'blockchain.headers.subscribe': tipHandler } },
  ]);

  const pending = pool.acquire();
  await Promise.resolve();
  pool.close();
  releaseConnect();

  await assert.rejects(pending, /pool closed/);
  assert.equal(pool.current, null);
  assert.equal(pool._keepalive, null);
  assert.equal(pool._recoveryTimer, null);
});

test('pool: an open server circuit is skipped even when it would rank fastest', async () => {
  const { pool, created } = makePool([
    { name: 'alpha', handlers: { 'blockchain.headers.subscribe': tipHandler } },
    { name: 'beta', handlers: { 'blockchain.headers.subscribe': tipHandler } },
  ]);
  const alpha = pool.servers.find(server => server.host === 'alpha');
  alpha.health.latencyEmaMs = 1;
  alpha.health.cooldownUntil = Date.now() + 60_000;

  await pool.acquire();
  assert.equal(pool.current, 'beta:50002');
  assert.equal(created.get('alpha'), undefined, 'open circuit was never dialed');
  pool.close();
});

test('pool: the global dial budget caps a hostile all-dead pool', async () => {
  const { pool, created } = makePool(
    Array.from({ length: 6 }, (_, index) => ({
      name: `dead-${index}`,
      connectFails: true,
      handlers: {},
    })),
    { retryBudgetAttempts: 2 },
  );

  await assert.rejects(
    () => pool.acquire(),
    error => error instanceof AllServersFailedError
      && error.errors.some(item => /retry budget exhausted/.test(item.message)),
  );
  assert.equal([...created.values()].reduce((sum, count) => sum + count, 0), 2);
  assert.equal(pool._recoveryTimer, null, 'an initial failed connect cannot leak a background pool');
  pool.close();
});

test('pool: concurrent transport failures share one failover transition', async () => {
  const { pool, created } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'x.y': () => 'TRANSPORT:connection closed',
    } },
    { name: 'beta', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'x.y': () => 'rescued',
    } },
  ]);

  const values = await Promise.all([pool.request('x.y'), pool.request('x.y')]);
  assert.deepEqual(values, ['rescued', 'rescued']);
  assert.equal(created.get('beta'), 1, 'only one replacement socket was created');
  pool.close();
});

test('pool: setup success keeps failure debt until minimum healthy uptime', async () => {
  let now = 0;
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      ping: () => 'pong',
    } },
  ], {
    now: () => now,
    minHealthyUptimeMs: 1_000,
  });
  await pool.acquire();
  const health = pool.servers[0].health;
  health.failures = 3;

  now = 999;
  assert.equal(await pool.request('ping'), 'pong');
  assert.equal(health.failures, 3);
  now = 1_000;
  assert.equal(await pool.request('ping'), 'pong');
  assert.equal(health.failures, 0);
  assert.equal(pool._retryController.attempts, 0, 'stable uptime resets the global episode budget');
  pool.close();
});

test('pool: an exhausted active pool recovers once with bounded background retries', async (t) => {
  const alpha = {
    name: 'alpha',
    connectFails: false,
    handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
      'x.y': () => {
        alpha.connectFails = true;
        return 'TRANSPORT:connection closed';
      },
    },
  };
  const beta = {
    name: 'beta',
    connectFails: true,
    handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_B,
    },
  };
  const timers = createManualTimers();
  const { pool } = makePool([alpha, beta], {
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    random: () => 0,
    failureBackoffBaseMs: 100,
    failureBackoffMaxMs: 100,
    recoveryBackoffBaseMs: 100,
    recoveryBackoffMaxMs: 100,
    retryBudgetAttempts: 4,
    retryBudgetWindowMs: 1_000,
  });
  t.after(() => pool.close());
  const seen = [];
  await pool.subscribeAddress('bitcoincash:qrecovery', status => seen.push(status));
  const scheduled = [];
  const recovered = new Promise(resolve => pool.once('recovered', resolve));
  pool.on('recovery-scheduled', event => scheduled.push(event));

  await assert.rejects(() => pool.request('x.y'), AllServersFailedError);
  assert.ok(pool._recoveryTimer, 'one background recovery is scheduled');
  const recoveryTimer = pool._recoveryTimer;
  await assert.rejects(() => pool.acquire(), AllServersFailedError);
  assert.equal(pool._recoveryTimer, recoveryTimer, 'repeated callers share the existing recovery timer');
  assert.equal(timers.size, 1, 'only one recovery timer is pending');
  beta.connectFails = false;
  timers.runNext();
  const event = await recovered;

  assert.equal(event.server, 'beta:50002');
  assert.equal(pool.current, 'beta:50002');
  assert.deepEqual(seen, [STATUS_B], 'recovery restored and reconciled the subscription');
  assert.equal(scheduled.length, 1);
  assert.equal(pool._recoveryTimer, null);
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

test('pool: retired socket notifications cannot overwrite the replacement state', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
    } },
    { name: 'beta', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_B,
    } },
  ]);
  const seen = [];
  await pool.subscribeAddress('bitcoincash:qptest', status => seen.push(status));
  const retired = clients.get('alpha');
  await pool.killCurrent();
  retired.fireNotification('blockchain.address.subscribe', ['bitcoincash:qptest', STATUS_C]);

  assert.deepEqual(seen, [STATUS_B]);
  assert.equal(pool._subs.get('bitcoincash:qptest').observedStatus, STATUS_B);
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

test('pool: rejected candidate cannot leak staged callbacks', async () => {
  const addressOne = 'bitcoincash:qone';
  const addressTwo = 'bitcoincash:qtwo';
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
    } },
    { name: 'beta', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': ([address], client) => {
        if (address === addressOne) {
          client.fireNotification('blockchain.address.subscribe', [address, STATUS_C]);
          return STATUS_C;
        }
        return 'APP:second restore failed';
      },
    } },
    { name: 'gamma', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_B,
    } },
  ]);
  const seenOne = [];
  const seenTwo = [];
  await pool.subscribeAddress(addressOne, status => seenOne.push(status));
  await pool.subscribeAddress(addressTwo, status => seenTwo.push(status));
  await pool.killCurrent();

  assert.equal(pool.current, 'gamma:50002');
  assert.deepEqual(seenOne, [STATUS_B], 'beta staged status never escaped');
  assert.deepEqual(seenTwo, [STATUS_B]);
  pool.close();
});

test('pool: live notifications dispatch to subscribers and update observed status', async () => {
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

test('pool: a change during the initial subscribe handshake is not discarded', async () => {
  const address = 'bitcoincash:qinitialrace';
  const { pool } = makePool([
    { name: 'alpha', handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': (_params, client) => {
        client.fireNotification('blockchain.address.subscribe', [address, STATUS_B]);
        return STATUS_A;
      },
    } },
  ]);
  const seen = [];
  const current = await pool.subscribeAddress(address, (status, event) => {
    seen.push({ status, source: event.source });
  });

  assert.equal(current, STATUS_B);
  assert.deepEqual(seen, [{ status: STATUS_B, source: 'notification' }]);
  pool.close();
});

test('pool: rejected async handlers retry visibly with the same event id', async () => {
  const { pool, clients } = makePool([{
    name: 'alpha',
    handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => STATUS_A,
    },
  }], {
    handlerRetryBaseMs: 2,
    handlerRetryMaxMs: 4,
    handlerTimeoutMs: 100,
  });
  const failures = [];
  const attempts = [];
  pool.on('handler-error', event => failures.push(event));
  await pool.subscribeAddress('bitcoincash:qptest', async (status, event) => {
    attempts.push({ status, ...event });
    if (attempts.length === 1) throw new Error('database unavailable');
  });

  clients.get('alpha').fireNotification(
    'blockchain.address.subscribe',
    ['bitcoincash:qptest', STATUS_B],
  );
  const entry = pool._subs.get('bitcoincash:qptest');
  assert.equal(entry.observedStatus, STATUS_B);
  assert.equal(entry.deliveredStatus, STATUS_A, 'failed callback is not acknowledged');
  await waitFor(() => attempts.length === 2 && entry.deliveredStatus === STATUS_B);

  assert.equal(failures.length, 1);
  assert.equal(attempts[0].id, attempts[1].id);
  assert.equal(failures[0].eventId, attempts[0].id);
  assert.deepEqual(attempts.map(attempt => attempt.attempt), [1, 2]);
  pool.close();
});

test('pool: liveness re-query detects a change when notifications go silent', async () => {
  let status = STATUS_A;
  const { pool } = makePool([{
    name: 'alpha',
    handlers: {
      'blockchain.headers.subscribe': tipHandler,
      'blockchain.address.subscribe': () => status,
    },
  }]);
  const events = [];
  await pool.subscribeAddress('bitcoincash:qptest', (value, event) => events.push({ value, event }));
  assert.ok(pool._subscriptionCheck, 'periodic liveness check is scheduled');
  status = STATUS_C;

  await pool._checkSubscriptionBatch();
  assert.equal(events.length, 1);
  assert.equal(events[0].value, STATUS_C);
  assert.equal(events[0].event.source, 'liveness-check');
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
