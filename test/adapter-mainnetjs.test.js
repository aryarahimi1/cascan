/**
 * test/adapter-mainnetjs.test.js
 *
 * mainnet-js NetworkProvider adapter tests (no network): shape mapping,
 * header decoding, input-value enrichment, broadcast semantics, tx
 * subscriptions via the pool.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CascanMainnetProvider, decodeHeader, toMainnetJsUtxo } from '../src/adapters/mainnetjs.js';
import { txidFromHex } from '../src/adapters/cashscript.js';
import { encodeCashAddr } from '../src/cashaddr.js';
import { ServerPool } from '../src/pool/pool.js';
import { rawTransaction, outpointForRaw } from './helpers.js';

function fakeCascan(handlers, network = 'mainnet') {
  return {
    network,
    pool: handlers._pool ?? {},
    request: async (method, params) => {
      const h = handlers[method];
      if (!h) throw new Error(`unexpected method ${method}`);
      return h(params);
    },
    verify: async (method, params, opts) => {
      const h = handlers._verify ?? handlers[method];
      if (!h) throw new Error(`unexpected verified method ${method}`);
      return { value: await h(params), receipt: { agreementCount: opts?.minAgreement } };
    },
    height: async () => {
      if (typeof handlers._height === 'function') return handlers._height();
      return handlers._height ?? 961725;
    },
  };
}

test('mainnetjs: utxo mapping carries address, height, bigint money, tokens', () => {
  const u = toMainnetJsUtxo(
    { tx_hash: 'aa'.repeat(32), tx_pos: 3, value: 5000, height: 961000, token_data: { category: 'bb'.repeat(32), amount: '7' } },
    'bitcoincash:qqtest'
  );
  assert.equal(u.address, 'bitcoincash:qqtest');
  assert.equal(u.height, 961000);
  assert.equal(u.satoshis, 5000n);
  assert.equal(u.token.amount, 7n);
});

test('mainnetjs: network maps chipnet/testnet4 → testnet (their enum)', () => {
  assert.equal(new CascanMainnetProvider(fakeCascan({}, 'mainnet')).network, 'mainnet');
  assert.equal(new CascanMainnetProvider(fakeCascan({}, 'chipnet')).network, 'testnet');
  assert.equal(new CascanMainnetProvider(fakeCascan({}, 'testnet4')).network, 'testnet');
});

test('mainnetjs: getBalance sums confirmed + unconfirmed as bigint', async () => {
  const cascan = fakeCascan({
    'blockchain.address.get_balance': () => ({ confirmed: 100, unconfirmed: -40 }),
  });
  let verifyCalled = false;
  const originalVerify = cascan.verify;
  cascan.verify = async (...args) => {
    verifyCalled = true;
    return originalVerify(...args);
  };
  const p = new CascanMainnetProvider(cascan);
  assert.equal(await p.getBalance('bitcoincash:qq'), 60n);
  assert.equal(verifyCalled, true);
});

test('mainnetjs: getBalance rejects hostile satoshi encodings', async () => {
  const p = new CascanMainnetProvider(fakeCascan({
    'blockchain.address.get_balance': () => ({ confirmed: '0x10', unconfirmed: 0 }),
  }));
  await assert.rejects(() => p.getBalance('bitcoincash:qq'), /invalid confirmed/);
});

test('mainnetjs: getUtxos rejects a real UTXO locked to a different address', async () => {
  const foreignRaw = rawTransaction([{
    value: 50_000n,
    lockingBytecode: Buffer.from('76a914' + 'ff'.repeat(20) + '88ac', 'hex'),
  }]);
  const p = new CascanMainnetProvider(fakeCascan({
    'blockchain.address.listunspent': () => [outpointForRaw(foreignRaw, 0, 50_000n)],
    'blockchain.transaction.get': () => foreignRaw,
  }));

  await assert.rejects(
    () => p.getUtxos('bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl'),
    /locking bytecode mismatch/,
  );
});

test('mainnetjs: getUtxos verifies a token-aware P2SH32 output', async () => {
  const hash = new Uint8Array(32).fill(0x42);
  const address = encodeCashAddr('bitcoincash', 'p2sh', hash, { tokenAware: true });
  const raw = rawTransaction([{
    value: 50_000n,
    lockingBytecode: Buffer.from('aa20' + Buffer.from(hash).toString('hex') + '87', 'hex'),
  }]);
  const p = new CascanMainnetProvider(fakeCascan({
    'blockchain.address.listunspent': () => [outpointForRaw(raw, 0, 50_000n)],
    'blockchain.transaction.get': () => raw,
  }));

  const utxos = await p.getUtxos(address);
  assert.equal(utxos.length, 1);
  assert.equal(utxos[0].address, address);
});

test('mainnetjs: decodeHeader — synthetic 80-byte header round-trips every field', () => {
  const b = Buffer.alloc(80);
  b.writeUInt32LE(0x20000002, 0);                                  // version
  Buffer.from('11'.repeat(32), 'hex').copy(b, 4);                  // prev (LE on wire)
  Buffer.from('22'.repeat(32), 'hex').copy(b, 36);                 // merkle
  b.writeUInt32LE(1501658398, 68);                                 // timestamp
  b.writeUInt32LE(0x18014735, 72);                                 // bits
  b.writeUInt32LE(0xdeadbeef, 76);                                 // nonce

  const h = decodeHeader(b.toString('hex'), 478559);
  assert.equal(h.height, 478559);
  assert.equal(h.version, 0x20000002);
  assert.equal(h.previousBlockHash, '11'.repeat(32)); // uniform bytes — reversal invariant
  assert.equal(h.merkleRoot, '22'.repeat(32));
  assert.equal(h.timestamp, 1501658398);
  assert.equal(h.bits, 0x18014735);
  assert.equal(h.nonce, 0xdeadbeef);
  assert.throws(() => decodeHeader('00'.repeat(79), 1), /80 bytes/);
});

test('mainnetjs: getRawTransaction with loadInputValues enriches vins from parents', async () => {
  const p = new CascanMainnetProvider(fakeCascan({
    'blockchain.transaction.get': ([txid, verbose]) => {
      if (txid === 'child') {
        return { txid: 'child', vin: [{ txid: 'parent', vout: 1 }], vout: [] };
      }
      assert.equal(verbose, true);
      return { txid: 'parent', vout: [{ n: 0, value: 9 }, { n: 1, value: 1.5, scriptPubKey: { addresses: ['x'] } }] };
    },
  }));
  const tx = await p.getRawTransaction('child', true, true);
  assert.equal(tx.vin[0].value, 1.5);
  assert.deepEqual(tx.vin[0].scriptPubKey.addresses, ['x']);
});

test('mainnetjs: sendRawTransaction rejects unverified fire-and-forget mode', async () => {
  let broadcastCalled = false;
  const p = new CascanMainnetProvider(fakeCascan({
    'blockchain.transaction.broadcast': () => { broadcastCalled = true; return 'server-txid'; },
  }));
  const txHex = '0100000001';
  await assert.rejects(() => p.sendRawTransaction(txHex, false), /unsafe and unsupported/);
  assert.equal(broadcastCalled, false);
});

test('mainnetjs: default broadcast requires independently verified propagation', async () => {
  const txHex = '0100000001';
  let minAgreement = null;
  const cascan = fakeCascan({
    'blockchain.transaction.broadcast': () => 'server-claimed-success',
    _verify: (_params) => txHex,
  });
  const originalVerify = cascan.verify;
  cascan.verify = async (method, params, opts) => {
    minAgreement = opts.minAgreement;
    return originalVerify(method, params, opts);
  };
  const p = new CascanMainnetProvider(cascan);
  assert.equal(await p.sendRawTransaction(txHex), txidFromHex(txHex));
  assert.equal(minAgreement, 2);
});

test('mainnetjs: getHistory height-range filter keeps mempool txs (height ≤ 0)', async () => {
  const p = new CascanMainnetProvider(fakeCascan({
    'blockchain.address.get_history': () => [
      { tx_hash: 'a', height: 100 }, { tx_hash: 'b', height: 500 }, { tx_hash: 'm', height: 0 },
    ],
  }));
  const hist = await p.getHistory('bitcoincash:qq', 400);
  assert.deepEqual(hist.map(h => h.tx_hash), ['b', 'm'], 'mempool tx survives the from-filter');
});

test('mainnetjs: waitForBlock propagates a failed secure height verification', async () => {
  const p = new CascanMainnetProvider(fakeCascan({
    _height: () => { throw new TypeError('server returned an invalid BCH height'); },
  }));

  await assert.rejects(() => p.waitForBlock(), /invalid BCH height/);
});

// ---------------------------------------------------------------------------
// tx subscriptions through the pool (resurrection contract)
// ---------------------------------------------------------------------------

class FakeClient {
  constructor(spec) {
    this.spec = spec; this.name = spec.name; this.connected = false;
    this._notify = []; this._socket = { once() {} };
    this.serverVersion = ['F', '1.6'];
  }
  async connect() { if (this.spec.connectFails) throw new Error('connect timeout'); this.connected = true; return this; }
  async request(m, p) {
    const h = this.spec.handlers[m];
    if (!h) return null;
    const out = h(p, this);
    if (typeof out === 'string' && out.startsWith('TRANSPORT:')) { this.connected = false; throw new Error(out.slice(10)); }
    return out;
  }
  onNotification(fn) { this._notify.push(fn); }
  fire(m, p) { for (const fn of this._notify) fn(m, p); }
  close() { this.connected = false; }
}

test('pool: tx subscription survives failover; confirmation during gap delivered', async () => {
  const specs = [
    { name: 'a', handlers: {
      'blockchain.headers.subscribe': () => ({ height: 1 }),
      'blockchain.transaction.subscribe': () => null,          // unconfirmed
      'x.kill': () => 'TRANSPORT:connection closed',
    } },
    { name: 'b', handlers: {
      'blockchain.headers.subscribe': () => ({ height: 1 }),
      'blockchain.transaction.subscribe': () => 961000,        // confirmed mid-gap!
    } },
  ];
  const pool = new ServerPool(specs.map(s => ({ host: s.name, ports: { ssl: 1 }, tlsStrict: true })), {
    clientFactory: (srv) => new FakeClient(specs.find(s => s.name === srv.host)),
  });

  const fired = [];
  const h0 = await pool.subscribeTransaction('cafe'.repeat(16), (h) => fired.push(h));
  assert.equal(h0, null, 'initially unconfirmed');

  await pool.request('x.kill').catch(() => {});
  assert.equal(pool.current, 'b:1');
  assert.deepEqual(fired, [961000], 'the confirmation that happened between servers was delivered');
  pool.close();
});
