import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserServerPool, MAX_BROWSER_SERVERS, MAX_REASONABLE_BCH_HEIGHT } from '../src/browser/pool.js';
import { BrowserFulcrumError } from '../src/browser/client.js';
import { AllServersFailedError } from '../src/fulcrum/errors.js';

class FakeBrowserClient {
  constructor(spec) {
    this.spec = spec;
    this.connected = false;
    this._notifications = new Set();
    this._closeHandlers = new Set();
  }

  async connect() {
    if (this.spec.connectFails) throw transport('connect failed');
    this.connected = true;
    return this;
  }

  async request(method, params = []) {
    if (!this.connected) throw transport('not connected');
    if (method === 'blockchain.headers.subscribe') return { height: this.spec.height ?? 100 };
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

function makePool(specs) {
  const clients = new Map();
  const pool = new BrowserServerPool(
    specs.map(spec => ({ url: `wss://${spec.name}.example/` })),
    {
      keepaliveMs: 3_600_000,
      clientFactory(server) {
        const name = new URL(server.url).hostname.split('.')[0];
        const client = new FakeBrowserClient(specs.find(spec => spec.name === name));
        clients.set(name, client);
        return client;
      },
    },
  );
  return { pool, clients };
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

const STATUS_A = 'a'.repeat(64);
const STATUS_B = 'b'.repeat(64);

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
