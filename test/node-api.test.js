import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Cascan, connect } from '../src/index.js';
import { MAX_REASONABLE_BCH_HEIGHT } from '../src/validation.js';

class FakePool extends EventEmitter {
  constructor(tip) {
    super();
    this.tip = tip;
  }

  async request(method) {
    assert.equal(method, 'blockchain.headers.subscribe');
    return this.tip;
  }
}

test('Node API: height rejects an impossible server-reported value', async () => {
  const cascan = new Cascan(new FakePool({ height: MAX_REASONABLE_BCH_HEIGHT + 1 }));
  await assert.rejects(() => cascan.height({ verify: false }), /invalid BCH height/);
});

test('Node API: height returns a valid BCH height', async () => {
  const cascan = new Cascan(new FakePool({ height: 900_002 }));
  assert.equal(await cascan.height({ verify: false }), 900_002);
});

test('Node API: callback delivery options are forwarded and fail fast', async () => {
  await assert.rejects(
    () => connect({
      servers: [{ host: 'never-dial.example', ports: { ssl: 50002 } }],
      handlerRetryBaseMs: 100,
      handlerRetryMaxMs: 10,
    }),
    /retryMaxMs must be greater than or equal to retryBaseMs/,
  );
});

test('Node API: handler-error is visible through Cascan', () => {
  const pool = new FakePool({ height: 1 });
  const cascan = new Cascan(pool);
  const expected = { eventId: 'delivery-1', willRetry: true };
  let seen;
  cascan.on('handler-error', event => { seen = event; });
  pool.emit('handler-error', expected);
  assert.equal(seen, expected);
});

test('Node API: balance and height use strict verification by default', async () => {
  const cascan = new Cascan(new FakePool({ height: 1 }));
  const calls = [];
  cascan.verify = async (method) => {
    calls.push(method);
    if (method === 'blockchain.address.get_balance') {
      return { value: { confirmed: 42, unconfirmed: 0 }, receipt: { agreement: 'unanimous' } };
    }
    return { value: { height: 900_002 }, receipt: { agreement: 'unanimous' } };
  };

  const balance = await cascan.balance('bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl');
  assert.equal(balance.totalSats, '42');
  assert.equal(await cascan.height(), 900_002);
  assert.deepEqual(calls, [
    'blockchain.address.get_balance',
    'blockchain.headers.subscribe',
  ]);
});

test('Node API: balance rejects hostile satoshi encodings and impossible values', async () => {
  const invalidBalances = [
    { confirmed: undefined, unconfirmed: 0, message: /invalid confirmed/ },
    { confirmed: -1, unconfirmed: 0, message: /impossible confirmed/ },
    { confirmed: '0x10', unconfirmed: 0, message: /invalid confirmed/ },
    { confirmed: 1e21, unconfirmed: 0, message: /invalid confirmed/ },
    { confirmed: '2100000000000001', unconfirmed: 0, message: /impossible confirmed/ },
    { confirmed: 0, unconfirmed: '2100000000000001', message: /impossible unconfirmed/ },
  ];

  for (const { confirmed, unconfirmed, message } of invalidBalances) {
    const cascan = new Cascan(new FakePool({ height: 1 }));
    cascan.verify = async () => ({ value: { confirmed, unconfirmed }, receipt: {} });
    await assert.rejects(
      () => cascan.balance('bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl'),
      message,
    );
  }
});
