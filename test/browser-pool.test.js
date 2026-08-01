import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserServerPool,
  MAX_BROWSER_CALLBACKS,
  MAX_BROWSER_CALLBACKS_PER_SUBSCRIPTION,
  MAX_BROWSER_EVENT_HANDLERS,
  MAX_BROWSER_EVENT_HANDLERS_PER_EVENT,
  MAX_BROWSER_SERVERS,
  MAX_REASONABLE_BCH_HEIGHT,
} from '../src/browser/pool.js';
import { BrowserFulcrumError } from '../src/browser/client.js';
import { AllServersFailedError } from '../src/fulcrum/errors.js';
import { createManualTimers } from './helpers.js';

class FakeBrowserClient {
  constructor(spec) {
    this.spec = spec;
    this.connected = false;
    this._notifications = new Set();
    this._closeHandlers = new Set();
    this._rejectConnect = null;
    this.closeCalls = 0;
  }

  async connect() {
    if (this.spec.hangConnect) {
      await new Promise((resolve, reject) => {
        this._rejectConnect = reject;
      });
    }
    await this.spec.connectGate;
    if (this.spec.connectFails) throw transport('connect failed');
    this.connected = true;
    return this;
  }

  async request(method, params = []) {
    if (!this.connected) throw transport('not connected');
    if (method === 'blockchain.headers.subscribe') {
      return { height: this.spec.height ?? 100, hex: this.spec.headerHex ?? '00'.repeat(80) };
    }
    const result = this.spec.responses?.[method];
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return result(params, this);
    return result ?? null;
  }

  onNotification(fn) {
    this._notifications.add(fn);
    return () => this._notifications.delete(fn);
  }

  onClose(fn) {
    this._closeHandlers.add(fn);
    if (this.spec.closeDuringSetup) this.connected = false;
    return () => this._closeHandlers.delete(fn);
  }

  close() {
    this.closeCalls++;
    this._rejectConnect?.(transport('connect cancelled'));
    this._rejectConnect = null;
    this.connected = false;
  }

  die() {
    this.connected = false;
    for (const fn of this._closeHandlers) fn();
  }

  notify(method, params) {
    for (const fn of this._notifications) fn(method, params);
  }
}

function transport(message) {
  return new BrowserFulcrumError(message, { kind: 'transport' });
}

function application(message) {
  return new BrowserFulcrumError(message, { kind: 'application' });
}

function makePool(specs, opts = {}) {
  const clients = new Map();
  const created = new Map();
  const pool = new BrowserServerPool(
    specs.map(spec => ({ url: `wss://${spec.name}.example/` })),
    {
      ...opts,
      keepaliveMs: 3_600_000,
      clientFactory(server) {
        const name = new URL(server.url).hostname.split('.')[0];
        const client = new FakeBrowserClient(specs.find(spec => spec.name === name));
        clients.set(name, client);
        created.set(name, (created.get(name) ?? 0) + 1);
        return client;
      },
    },
  );
  return { pool, clients, created };
}

test('browser pool: skips a dead server and connects to the next healthy server', async () => {
  const { pool } = makePool([
    { name: 'alpha', connectFails: true },
    { name: 'beta', responses: { 'server.ping': 'pong' } },
  ]);
  assert.equal(await pool.request('server.ping'), 'pong');
  assert.equal(pool.current, 'wss://beta.example/');
  assert.equal(pool.servers[0].health.failures, 1);
  pool.close();
});

test('browser pool: retries a transport failure on another server', async () => {
  const { pool } = makePool([
    { name: 'alpha', responses: { lookup: transport('connection closed') } },
    { name: 'beta', responses: { lookup: 'from-beta' } },
  ]);
  const failovers = [];
  pool.on('failover', event => failovers.push(event));

  assert.equal(await pool.request('lookup'), 'from-beta');
  assert.equal(pool.current, 'wss://beta.example/');
  assert.ok(failovers.some(event => event.from === 'wss://alpha.example/'));
  pool.close();
});

test('browser pool: does not hide an application-level server answer', async () => {
  const { pool } = makePool([
    { name: 'alpha', responses: { lookup: application('transaction not found') } },
    { name: 'beta', responses: { lookup: 'must-not-run' } },
  ]);
  await assert.rejects(() => pool.request('lookup'), /transaction not found/);
  assert.equal(pool.current, 'wss://alpha.example/');
  pool.close();
});

test('browser pool: automatic close notification triggers failover', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha' },
    { name: 'beta' },
  ]);
  await pool.acquire();
  const switched = new Promise(resolve => pool.on('failover', resolve));
  clients.get('alpha').die();
  await switched;
  assert.equal(pool.current, 'wss://beta.example/');
  pool.close();
});

test('browser pool: all dead servers fail loudly', async () => {
  const { pool } = makePool([
    { name: 'alpha', connectFails: true },
    { name: 'beta', connectFails: true },
  ]);
  await assert.rejects(() => pool.acquire(), AllServersFailedError);
  pool.close();
});

test('browser pool: close cancels a pending recovery timer even when its handle is zero', () => {
  const cleared = [];
  const { pool } = makePool([
    { name: 'alpha' },
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

test('browser pool: close wins a race with an in-flight connection', async () => {
  let releaseConnect;
  const connectGate = new Promise(resolve => { releaseConnect = resolve; });
  const { pool } = makePool([
    { name: 'alpha', connectGate },
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

test('browser pool: close actively cancels a candidate that never connects', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', hangConnect: true },
  ]);

  const pending = pool.acquire();
  await Promise.resolve();
  pool.close();

  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('candidate was not cancelled')), 50)),
    ]),
    /pool closed/,
  );
  assert.ok(clients.get('alpha').closeCalls >= 1);
  assert.equal(pool._candidateClient, null);
});

test('browser pool: an open circuit is skipped without opening a WebSocket', async () => {
  const { pool, created } = makePool([
    { name: 'alpha' },
    { name: 'beta' },
  ]);
  pool.servers[0].health.cooldownUntil = Date.now() + 60_000;
  await pool.acquire();
  assert.equal(pool.current, 'wss://beta.example/');
  assert.equal(created.get('alpha'), undefined);
  pool.close();
});

test('browser pool: an exhausted active pool recovers with one bounded timer', async (t) => {
  const alpha = {
    name: 'alpha',
    connectFails: false,
    responses: {
      'blockchain.address.subscribe': () => STATUS_A,
      lookup: () => {
        alpha.connectFails = true;
        throw transport('connection closed');
      },
    },
  };
  const beta = {
    name: 'beta',
    connectFails: true,
    responses: { 'blockchain.address.subscribe': () => STATUS_B },
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
  const recovered = new Promise(resolve => pool.on('recovered', resolve));
  pool.on('recovery-scheduled', event => scheduled.push(event));

  await assert.rejects(() => pool.request('lookup'), AllServersFailedError);
  assert.ok(pool._recoveryTimer);
  const recoveryTimer = pool._recoveryTimer;
  await assert.rejects(() => pool.acquire(), AllServersFailedError);
  assert.equal(pool._recoveryTimer, recoveryTimer);
  assert.equal(timers.size, 1);
  beta.connectFails = false;
  timers.runNext();
  const event = await recovered;

  assert.equal(event.server, 'wss://beta.example/');
  assert.equal(pool.current, 'wss://beta.example/');
  assert.deepEqual(seen, [STATUS_B]);
  assert.equal(scheduled.length, 1);
  assert.equal(pool._recoveryTimer, null);
});

test('browser pool: a total outage storm stays bounded and recovers one subscription once', async (t) => {
  const alpha = {
    name: 'alpha',
    connectFails: false,
    responses: {
      'blockchain.address.subscribe': () => STATUS_A,
      lookup: () => {
        alpha.connectFails = true;
        throw transport('network disappeared');
      },
    },
  };
  const beta = {
    name: 'beta',
    connectFails: true,
    responses: {
      'blockchain.address.subscribe': () => STATUS_B,
      lookup: () => 'recovered',
    },
  };
  const timers = createManualTimers();
  const { pool, clients, created } = makePool([alpha, beta], {
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
  const recovered = [];
  pool.on('recovered', event => recovered.push(event));
  await pool.subscribeAddress('bitcoincash:qstorm', status => seen.push(status));
  const retiredAlpha = clients.get('alpha');

  const failures = await Promise.allSettled(
    Array.from({ length: 50 }, () => pool.request('lookup')),
  );
  assert.ok(failures.every(result => result.status === 'rejected'));
  assert.ok(
    [...created.values()].reduce((sum, count) => sum + count, 0) <= 4,
    'the global dial budget bounds concurrent callers',
  );
  assert.equal(timers.size, 1, 'all callers share one recovery timer');

  for (let cycle = 0; cycle < 2; cycle++) {
    timers.runNext();
    await waitFor(() => timers.size === 1);
    assert.equal(pool.current, null);
    assert.ok(
      [...created.values()].reduce((sum, count) => sum + count, 0) <= 4 * (cycle + 2),
      'each retry window remains globally bounded',
    );
  }

  beta.connectFails = false;
  timers.runNext();
  const foreground = pool.acquire();
  await foreground;
  await waitFor(() => recovered.length === 1 && seen.length === 1);

  assert.equal(pool.current, 'wss://beta.example/');
  assert.equal(created.get('beta'), 4, 'timer and foreground caller shared the recovery connection');
  assert.deepEqual(seen, [STATUS_B], 'changed subscription state was delivered exactly once');
  assert.equal(recovered.length, 1);
  assert.equal(timers.size, 0);

  retiredAlpha.die();
  await Promise.resolve();
  assert.equal(pool.current, 'wss://beta.example/', 'a retired socket cannot tear down its replacement');
  assert.deepEqual(seen, [STATUS_B]);
});

test('browser pool: setup-close race rejects that candidate', async () => {
  const { pool } = makePool([
    { name: 'alpha', closeDuringSetup: true },
    { name: 'beta', responses: { 'server.ping': 'pong' } },
  ]);
  assert.equal(await pool.request('server.ping'), 'pong');
  assert.equal(pool.current, 'wss://beta.example/');
  pool.close();
});

test('browser pool: hostile height cannot poison server ranking', async () => {
  const { pool } = makePool([
    { name: 'alpha', height: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'beta', height: 100 },
  ]);
  await pool.acquire();
  assert.equal(pool.servers[0].health.height, null);
  pool.close();
});

test('browser pool: invalid header notifications cannot fire block callbacks', async () => {
  const { pool, clients } = makePool([{ name: 'alpha', height: 100 }]);
  const blocks = [];
  pool.on('block', block => blocks.push(block));
  await pool.acquire();

  clients.get('alpha').notify('blockchain.headers.subscribe', [{
    height: MAX_REASONABLE_BCH_HEIGHT + 1,
    hex: 'attacker-controlled',
  }]);

  assert.deepEqual(blocks, []);
  assert.equal(pool.servers[0].health.height, 100);
  pool.close();
});

test('browser pool: malformed header hex is rejected during setup and live failover', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', headerHex: '00' },
    { name: 'beta' },
    { name: 'gamma' },
  ]);
  const blocks = [];
  pool.on('block', block => blocks.push(block));

  await pool.acquire();
  assert.equal(pool.current, 'wss://beta.example/');
  assert.equal(pool.servers[0].health.height, null);

  clients.get('beta').notify('blockchain.headers.subscribe', [{
    height: 101,
    hex: 'not-an-80-byte-header',
  }]);
  await waitFor(() => pool.current === 'wss://gamma.example/');

  assert.deepEqual(blocks, []);
  pool.close();
});

test('browser pool: valid header events preserve height and normalize hex', async () => {
  const { pool, clients } = makePool([{ name: 'alpha' }]);
  const blocks = [];
  pool.on('block', block => blocks.push(block));
  await pool.acquire();

  clients.get('alpha').notify('blockchain.headers.subscribe', [{
    height: 101,
    hex: 'AB'.repeat(80),
  }]);

  assert.deepEqual(blocks, [{ height: 101, hex: 'ab'.repeat(80) }]);
  pool.close();
});

test('browser pool: bounds user-provided server lists', () => {
  assert.throws(
    () => new BrowserServerPool(
      Array.from({ length: MAX_BROWSER_SERVERS + 1 }, (_, index) => ({
        url: `wss://server-${index}.example/`,
      })),
    ),
    /limited/,
  );
});

test('browser pool: liveness timers cannot overflow into a hot loop', () => {
  assert.throws(
    () => makePool([{ name: 'alpha' }], { subscriptionCheckMs: 2_147_483_648 }),
    /integer from 1 to 2147483647/,
  );
});

test('browser pool: event handlers are capped per event and across the pool', () => {
  const { pool } = makePool([{ name: 'alpha' }]);
  const duplicate = () => {};
  pool.on('block', duplicate).on('block', duplicate);
  for (let index = 1; index < MAX_BROWSER_EVENT_HANDLERS_PER_EVENT; index++) {
    pool.on('block', () => {});
  }
  assert.throws(() => pool.on('block', () => {}), /per event/);

  for (let group = 1; group < MAX_BROWSER_EVENT_HANDLERS / MAX_BROWSER_EVENT_HANDLERS_PER_EVENT; group++) {
    for (let index = 0; index < MAX_BROWSER_EVENT_HANDLERS_PER_EVENT; index++) {
      pool.on(`event-${group}`, () => {});
    }
  }
  assert.equal(pool._eventHandlerCount, MAX_BROWSER_EVENT_HANDLERS);
  assert.throws(() => pool.on('overflow', () => {}), /total event handler limit/);
  assert.equal(pool._events.has('overflow'), false);
  pool.close();
});

const STATUS_A = 'a'.repeat(64);
const STATUS_B = 'b'.repeat(64);
const waitFor = async (predicate, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for browser pool state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

test('browser pool: address subscription survives failover without a duplicate event', async () => {
  const { pool } = makePool([
    { name: 'alpha', responses: { 'blockchain.address.subscribe': STATUS_A } },
    { name: 'beta', responses: { 'blockchain.address.subscribe': STATUS_A } },
  ]);
  const seen = [];
  assert.equal(await pool.subscribeAddress('bitcoincash:qptest', status => seen.push(status)), STATUS_A);
  await pool.killCurrent();
  assert.equal(pool.current, 'wss://beta.example/');
  assert.deepEqual(seen, []);
  pool.close();
});

test('browser pool: status change during failover is delivered once', async () => {
  const { pool } = makePool([
    { name: 'alpha', responses: { 'blockchain.address.subscribe': STATUS_A } },
    { name: 'beta', responses: { 'blockchain.address.subscribe': STATUS_B } },
  ]);
  const seen = [];
  await pool.subscribeAddress('bitcoincash:qptest', status => seen.push(status));
  await pool.killCurrent();
  assert.deepEqual(seen, [STATUS_B]);
  pool.close();
});

test('browser pool: retired socket notifications cannot replace newer state', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', responses: { 'blockchain.address.subscribe': STATUS_A } },
    { name: 'beta', responses: { 'blockchain.address.subscribe': STATUS_B } },
  ]);
  const seen = [];
  await pool.subscribeAddress('bitcoincash:qptest', status => seen.push(status));
  const retired = clients.get('alpha');
  await pool.killCurrent();
  retired.notify('blockchain.address.subscribe', ['bitcoincash:qptest', 'c'.repeat(64)]);

  assert.deepEqual(seen, [STATUS_B]);
  assert.equal(pool._subscriptions.get('bitcoincash:qptest').observedStatus, STATUS_B);
  pool.close();
});

test('browser pool: live duplicate statuses do not replay callbacks', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', responses: { 'blockchain.address.subscribe': STATUS_A } },
  ]);
  const seen = [];
  await pool.subscribeAddress('bitcoincash:qptest', status => seen.push(status));
  clients.get('alpha').notify('blockchain.address.subscribe', ['bitcoincash:qptest', STATUS_B]);
  clients.get('alpha').notify('blockchain.address.subscribe', ['bitcoincash:qptest', STATUS_B]);
  assert.deepEqual(seen, [STATUS_B]);
  pool.close();
});

test('browser pool: a change during the initial subscribe handshake is not discarded', async () => {
  const address = 'bitcoincash:qinitialrace';
  const { pool } = makePool([
    {
      name: 'alpha',
      responses: {
        'blockchain.address.subscribe': (_params, client) => {
          client.notify('blockchain.address.subscribe', [address, STATUS_B]);
          return STATUS_A;
        },
      },
    },
  ]);
  const seen = [];
  const current = await pool.subscribeAddress(address, (status, event) => {
    seen.push({ status, source: event.source });
  });

  assert.equal(current, STATUS_B);
  assert.deepEqual(seen, [{ status: STATUS_B, source: 'notification' }]);
  pool.close();
});

test('browser pool: subscription callbacks are capped without double-counting duplicates', async () => {
  const { pool } = makePool([
    { name: 'alpha', responses: { 'blockchain.address.subscribe': STATUS_A } },
  ]);
  const address = 'bitcoincash:qcallbacklimit';
  const callbacks = Array.from(
    { length: MAX_BROWSER_CALLBACKS_PER_SUBSCRIPTION },
    () => () => {},
  );
  for (const callback of callbacks) await pool.subscribeAddress(address, callback);
  await pool.subscribeAddress(address, callbacks[0]);

  await assert.rejects(
    () => pool.subscribeAddress(address, () => {}),
    /callback limit per subscription/,
  );
  assert.equal(pool._callbackCount, MAX_BROWSER_CALLBACKS_PER_SUBSCRIPTION);
  pool.close();
});

test('browser pool: total subscription callback state is capped', async () => {
  const { pool } = makePool([
    { name: 'alpha', responses: { 'blockchain.address.subscribe': STATUS_A } },
  ]);
  const subscriptions = MAX_BROWSER_CALLBACKS / MAX_BROWSER_CALLBACKS_PER_SUBSCRIPTION;
  for (let addressIndex = 0; addressIndex < subscriptions; addressIndex++) {
    const address = `bitcoincash:qcallbacktotal${addressIndex}`;
    for (let index = 0; index < MAX_BROWSER_CALLBACKS_PER_SUBSCRIPTION; index++) {
      await pool.subscribeAddress(address, () => {});
    }
  }

  assert.equal(pool._callbackCount, MAX_BROWSER_CALLBACKS);
  await assert.rejects(
    () => pool.subscribeAddress('bitcoincash:qcallbackoverflow', () => {}),
    /total subscription callback limit/,
  );
  pool.close();
});

test('browser pool: rejected promise handlers retry and emit handler-error', async () => {
  const { pool, clients } = makePool([
    { name: 'alpha', responses: { 'blockchain.address.subscribe': STATUS_A } },
  ], {
    handlerRetryBaseMs: 2,
    handlerRetryMaxMs: 4,
    handlerTimeoutMs: 100,
  });
  const failures = [];
  const attempts = [];
  pool.on('handler-error', event => failures.push(event));
  await pool.subscribeAddress('bitcoincash:qptest', async (status, event) => {
    attempts.push({ status, ...event });
    if (attempts.length === 1) throw new Error('indexeddb unavailable');
  });

  clients.get('alpha').notify('blockchain.address.subscribe', ['bitcoincash:qptest', STATUS_B]);
  const entry = pool._subscriptions.get('bitcoincash:qptest');
  assert.equal(entry.observedStatus, STATUS_B);
  assert.equal(entry.deliveredStatus, STATUS_A);
  await waitFor(() => attempts.length === 2 && entry.deliveredStatus === STATUS_B);

  assert.equal(failures.length, 1);
  assert.equal(attempts[0].id, attempts[1].id);
  assert.equal(failures[0].eventId, attempts[0].id);
  pool.close();
});

test('browser pool: liveness re-query recovers a missed notification', async () => {
  let status = STATUS_A;
  const { pool } = makePool([
    {
      name: 'alpha',
      responses: { 'blockchain.address.subscribe': () => status },
    },
  ]);
  const events = [];
  await pool.subscribeAddress('bitcoincash:qptest', (value, event) => events.push({ value, event }));
  assert.ok(pool._subscriptionCheck, 'periodic liveness check is scheduled');
  status = STATUS_B;

  await pool._checkSubscriptionBatch();
  assert.equal(events.length, 1);
  assert.equal(events[0].value, STATUS_B);
  assert.equal(events[0].event.source, 'liveness-check');
  pool.close();
});

test('browser pool: malformed restored status rejects that server', async () => {
  const { pool } = makePool([
    { name: 'alpha', responses: { 'blockchain.address.subscribe': STATUS_A } },
    { name: 'beta', responses: { 'blockchain.address.subscribe': 'not-a-status' } },
    { name: 'gamma', responses: { 'blockchain.address.subscribe': STATUS_B } },
  ]);
  const seen = [];
  await pool.subscribeAddress('bitcoincash:qptest', status => seen.push(status));
  await pool.killCurrent();
  assert.equal(pool.current, 'wss://gamma.example/');
  assert.deepEqual(seen, [STATUS_B]);
  pool.close();
});

test('browser pool: rejected candidate cannot leak staged subscription callbacks', async () => {
  const addressOne = 'bitcoincash:qone';
  const addressTwo = 'bitcoincash:qtwo';
  const STATUS_C = 'c'.repeat(64);
  const { pool } = makePool([
    {
      name: 'alpha',
      responses: { 'blockchain.address.subscribe': STATUS_A },
    },
    {
      name: 'beta',
      responses: {
        'blockchain.address.subscribe': ([address], client) => {
          if (address === addressOne) {
            client.notify('blockchain.address.subscribe', [address, STATUS_C]);
            return STATUS_C;
          }
          throw application('second restore failed');
        },
      },
    },
    {
      name: 'gamma',
      responses: { 'blockchain.address.subscribe': STATUS_B },
    },
  ]);

  const seenOne = [];
  const seenTwo = [];
  await pool.subscribeAddress(addressOne, status => seenOne.push(status));
  await pool.subscribeAddress(addressTwo, status => seenTwo.push(status));
  await pool.killCurrent();

  assert.equal(pool.current, 'wss://gamma.example/');
  assert.deepEqual(seenOne, [STATUS_B], 'beta staged status never escaped');
  assert.deepEqual(seenTwo, [STATUS_B]);
  pool.close();
});
