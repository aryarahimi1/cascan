import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_BOOTSTRAP_SERVERS,
  BrowserCascan,
  browserBootstrapServers,
  connect,
  normalizeBrowserServers,
} from '../src/browser/index.js';

const MAINNET = 'bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl';
const CHIPNET = 'bchtest:qr7fzmep8g7h7ymfxy74lgc0v950j3r295pdnvy3hr';

class FakePool {
  constructor() {
    this.current = 'wss://one.example/';
    this.events = new Map();
    this.subscribed = null;
  }

  on(event, callback) {
    this.events.set(event, callback);
  }

  off(event) {
    this.events.delete(event);
  }

  async request(method) {
    if (method === 'blockchain.headers.subscribe') return { height: 900_002 };
    if (method === 'blockchain.address.get_balance') {
      return { confirmed: '2100000000000000', unconfirmed: -1 };
    }
    return 'raw-result';
  }

  async subscribeAddress(address, callback) {
    this.subscribed = { address, callback };
    return null;
  }

  unsubscribeAddress(address, callback) {
    if (this.subscribed?.address === address && this.subscribed?.callback === callback) {
      this.subscribed = null;
    }
  }

  ranked() {
    return [{
      url: this.current,
      tlsStrict: true,
      health: {
        height: 900_002,
        heightAt: Date.now(),
        latencyEmaMs: 25,
        failures: 0,
        lastOkAt: Date.now(),
        lastFailAt: 0,
      },
    }];
  }

  close() {}
}

test('browser API: normalizes and deduplicates user-selected WSS servers', () => {
  assert.deepEqual(
    normalizeBrowserServers([
      'wss://one.example:50004',
      { url: 'wss://one.example:50004/' },
      'wss://two.example/electrum',
    ]),
    [
      { url: 'wss://one.example:50004/', source: 'user' },
      { url: 'wss://two.example/electrum', source: 'user' },
    ],
  );
});

test('browser API: provides automatic checkpoint-verified bootstrap pools', () => {
  assert.deepEqual(
    browserBootstrapServers('mainnet'),
    BROWSER_BOOTSTRAP_SERVERS.mainnet.map(url => ({ url, source: 'bootstrap' })),
  );
  assert.deepEqual(
    browserBootstrapServers('chipnet'),
    BROWSER_BOOTSTRAP_SERVERS.chipnet.map(url => ({ url, source: 'bootstrap' })),
  );
  assert.throws(
    () => browserBootstrapServers('testnet4'),
    /no built-in browser WSS bootstrap servers/,
  );
});

test('browser API: rejects insecure, credential-bearing, and empty explicit server lists', async () => {
  assert.throws(() => normalizeBrowserServers(['ws://one.example/']), /wss/);
  assert.throws(() => normalizeBrowserServers(['wss://user:pass@one.example/']), /credentials/);
  assert.throws(() => normalizeBrowserServers([]), /requires a non-empty servers array/);
  await assert.rejects(
    () => connect({ servers: ['wss://one.example/'], keepaliveMs: 1 }),
    /keepaliveMs/,
  );
  assert.throws(
    () => normalizeBrowserServers([`wss://one.example/${'x'.repeat(2_100)}`]),
    /at most/,
  );
});

test('browser API: rejects economically impossible balances and heights', async () => {
  const pool = new FakePool();
  const cascan = new BrowserCascan(pool);

  pool.request = async method => method === 'blockchain.headers.subscribe'
    ? { height: 10_000_001 }
    : { confirmed: '2100000000000001', unconfirmed: 0 };
  await assert.rejects(() => cascan.height(), /invalid BCH height/);
  await assert.rejects(() => cascan.balance(MAINNET), /impossible BCH balance/);
});

test('browser API: height, balance, request, and server health are browser-safe', async () => {
  const cascan = new BrowserCascan(new FakePool());
  assert.equal(await cascan.height(), 900_002);
  assert.deepEqual(await cascan.balance(MAINNET), {
    address: MAINNET,
    confirmedSats: '2100000000000000',
    unconfirmedSats: '-1',
    totalSats: '2099999999999999',
  });
  assert.equal(await cascan.request('server.ping'), 'raw-result');
  assert.equal(cascan.servers()[0].connected, true);
});

test('browser API: watch validates network and returns an unsubscribe function', async () => {
  const pool = new FakePool();
  const cascan = new BrowserCascan(pool);
  const callback = () => {};
  const stop = await cascan.watch(MAINNET, callback);
  assert.equal(pool.subscribed.address, MAINNET);
  stop();
  assert.equal(pool.subscribed, null);
  await assert.rejects(() => cascan.watch(CHIPNET, callback), /invalid mainnet CashAddr|not mainnet/);
});
