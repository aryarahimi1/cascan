/**
 * test/history.test.js
 *
 * Pure history-pipeline tests (no network): ledger construction from
 * verbose Fulcrum tx shapes, CSV escaping, FIFO cost-basis math.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/history/ledger.js';
import { rowsToCsv, escapeField, CSV_COLUMNS } from '../src/history/csv.js';
import { computeCostBasis, popFifo } from '../src/history/cost_basis.js';

const OURS = 'bitcoincash:qqour';
const THEIRS = 'bitcoincash:qqtheirs';
const addrMatches = new Set([OURS]);

/** Minimal verbose-tx builder. */
function vtx(txid, { vin = [], vout = [], time = 1700000000 } = {}) {
  return {
    txid,
    time,
    vin: vin.map(v => v.coinbase ? { coinbase: '04ffff' } : { txid: v.txid, vout: v.vout }),
    vout: vout.map((v, i) => ({ n: i, value: v.value, scriptPubKey: { addresses: [v.addr] } })),
  };
}

// ---------------------------------------------------------------------------
// buildLedger
// ---------------------------------------------------------------------------

test('ledger: pure receive — delta positive, no fee attributed', () => {
  const prev = vtx('aa', { vout: [{ value: 1.0, addr: THEIRS }] });
  const tx = vtx('bb', {
    vin: [{ txid: 'aa', vout: 0 }],
    vout: [{ value: 0.5, addr: OURS }, { value: 0.4999, addr: THEIRS }],
    time: 1700000100,
  });
  const txMap = new Map([['aa', prev], ['bb', tx]]);
  const { rows, warnings } = buildLedger([{ tx_hash: 'bb', height: 100 }], txMap, addrMatches);

  assert.equal(warnings.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'receive');
  assert.equal(rows[0].deltaSats, '50000000');
  assert.equal(rows[0].amountBch, 0.5);
  assert.equal(rows[0].feeSats, null); // receiver doesn't pay the fee
});

test('ledger: send — negative delta includes fee; fee = Σin − Σout', () => {
  const funding = vtx('aa', { vout: [{ value: 1.0, addr: OURS }] });
  const spend = vtx('bb', {
    vin: [{ txid: 'aa', vout: 0 }],
    vout: [{ value: 0.6, addr: THEIRS }, { value: 0.39999, addr: OURS }], // change back
    time: 1700000200,
  });
  const txMap = new Map([['aa', funding], ['bb', spend]]);
  const { rows } = buildLedger([{ tx_hash: 'bb', height: 101 }], txMap, addrMatches);

  assert.equal(rows[0].type, 'send');
  // delta = change received (0.39999) − input spent (1.0) = −0.60001 BCH
  assert.equal(rows[0].deltaSats, '-60001000');
  assert.equal(rows[0].feeSats, '1000');
});

test('ledger: self transfer — all inputs and outputs ours, delta is the fee', () => {
  const funding = vtx('aa', { vout: [{ value: 1.0, addr: OURS }] });
  const shuffle = vtx('bb', {
    vin: [{ txid: 'aa', vout: 0 }],
    vout: [{ value: 0.99999, addr: OURS }],
    time: 1700000300,
  });
  const txMap = new Map([['aa', funding], ['bb', shuffle]]);
  const { rows } = buildLedger([{ tx_hash: 'bb', height: 102 }], txMap, addrMatches);

  assert.equal(rows[0].type, 'self');
  assert.equal(rows[0].deltaSats, '-1000');
  assert.equal(rows[0].feeSats, '1000');
});

test('ledger: coinbase receive — no prevout fetch, no fee', () => {
  const cb = vtx('bb', { vin: [{ coinbase: true }], vout: [{ value: 6.25, addr: OURS }], time: 1700000400 });
  const { rows, warnings } = buildLedger([{ tx_hash: 'bb', height: 103 }], new Map([['bb', cb]]), addrMatches);

  assert.equal(warnings.length, 0);
  assert.equal(rows[0].type, 'receive');
  assert.equal(rows[0].deltaSats, '625000000');
  assert.equal(rows[0].feeSats, null);
});

test('ledger: missing prevout — warns, still emits the row', () => {
  const tx = vtx('bb', {
    vin: [{ txid: 'gone', vout: 0 }],
    vout: [{ value: 0.5, addr: OURS }],
    time: 1700000500,
  });
  const { rows, warnings } = buildLedger([{ tx_hash: 'bb', height: 104 }], new Map([['bb', tx]]), addrMatches);

  assert.equal(rows.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /prevout unavailable/);
});

test('ledger: rows sort chronologically regardless of input order', () => {
  const t1 = vtx('t1', { vin: [{ coinbase: true }], vout: [{ value: 1, addr: OURS }], time: 300 });
  const t2 = vtx('t2', { vin: [{ coinbase: true }], vout: [{ value: 1, addr: OURS }], time: 100 });
  const txMap = new Map([['t1', t1], ['t2', t2]]);
  const { rows } = buildLedger(
    [{ tx_hash: 't1', height: 2 }, { tx_hash: 't2', height: 1 }],
    txMap, addrMatches
  );
  assert.deepEqual(rows.map(r => r.txid), ['t2', 't1']);
});

test('ledger: singular scriptPubKey.address field also matches', () => {
  const tx = {
    txid: 'bb', time: 1700000600,
    vin: [{ coinbase: '04ff' }],
    vout: [{ n: 0, value: 1.0, scriptPubKey: { address: OURS } }],
  };
  const { rows } = buildLedger([{ tx_hash: 'bb', height: 105 }], new Map([['bb', tx]]), addrMatches);
  assert.equal(rows[0].deltaSats, '100000000');
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test('csv: header matches column contract; CRLF line endings', () => {
  const csv = rowsToCsv([]);
  assert.equal(csv, CSV_COLUMNS.join(',') + '\r\n');
});

test('csv: negative numeric strings are NOT formula-guarded', () => {
  assert.equal(escapeField('-60001000'), '-60001000');
  assert.equal(escapeField('-0.5'), '-0.5');
});

test('csv: formula injection guarded for non-numeric strings', () => {
  assert.equal(escapeField('=HYPERLINK("evil")'), '"\'=HYPERLINK(""evil"")"');
  assert.equal(escapeField('@cmd'), `"'@cmd"`);
  assert.equal(escapeField('+SUM(A1)'), `"'+SUM(A1)"`);
});

test('csv: commas and quotes escaped RFC-4180 style', () => {
  assert.equal(escapeField('a,b'), '"a,b"');
  assert.equal(escapeField('say "hi"'), '"say ""hi"""');
});

test('csv: usd columns fixed to 4 decimals; nulls stay empty', () => {
  const row = {
    timestamp: 1, isoTimestamp: 'x', txid: 't', height: 1, type: 'send',
    deltaSats: '-100', amountBch: 0.000001, feeSats: '10',
    usdPrice: 211.319999, usdValue: null,
    costBasisUsd: 0, proceedsUsd: null, realizedGainUsd: null, holdingPeriod: null, incomeUsd: null,
  };
  const line = rowsToCsv([row]).split('\r\n')[1];
  const cells = line.split(',');
  assert.equal(cells[CSV_COLUMNS.indexOf('usd_price')], '211.3200');
  assert.equal(cells[CSV_COLUMNS.indexOf('usd_value')], '');
  assert.equal(cells[CSV_COLUMNS.indexOf('cost_basis_usd')], '0.0000');
});

// ---------------------------------------------------------------------------
// FIFO cost basis
// ---------------------------------------------------------------------------

const DAY = 86400;

function row(type, deltaSats, timestamp, usdValue) {
  return {
    txid: 'tx-' + timestamp, timestamp, type,
    deltaSats: String(deltaSats),
    usdPrice: null, usdValue,
    costBasisUsd: null, proceedsUsd: null, realizedGainUsd: null, holdingPeriod: null, incomeUsd: null,
  };
}

test('fifo: single lot, full disposal — gain = proceeds − basis', () => {
  const rows = [
    row('receive', 100_000_000, 1000, 100),        // 1 BCH @ $100
    row('send',   -100_000_000, 1000 + DAY, 250),  // sold for $250
  ];
  const { warnings } = computeCostBasis(rows, { method: 'fifo' });
  assert.equal(warnings.length, 0);
  assert.equal(rows[1].costBasisUsd, 100);
  assert.equal(rows[1].proceedsUsd, 250);
  assert.equal(rows[1].realizedGainUsd, 150);
  assert.equal(rows[1].holdingPeriod, 'short');
  assert.equal(rows[0].incomeUsd, 100); // FMV at receipt
});

test('fifo: multi-lot disposal pops oldest first; mixed holding period', () => {
  const t0 = 1000;
  const rows = [
    row('receive', 100_000_000, t0, 100),                    // lot1: 1 BCH @ $100
    row('receive', 100_000_000, t0 + 400 * DAY, 400),        // lot2: 1 BCH @ $400
    row('send',   -150_000_000, t0 + 401 * DAY, 900),        // dispose 1.5 BCH for $900
  ];
  computeCostBasis(rows, { method: 'fifo' });
  // basis = 1 × $100 (lot1, long) + 0.5 × $400 (lot2, short) = $300
  assert.equal(rows[2].costBasisUsd, 300);
  assert.equal(rows[2].realizedGainUsd, 600);
  assert.equal(rows[2].holdingPeriod, 'mixed');
});

test('fifo: disposal beyond tracked lots warns and books basis 0', () => {
  const rows = [
    row('send', -100_000_000, 1000, 250), // nothing ever received
  ];
  const { warnings } = computeCostBasis(rows, { method: 'fifo' });
  assert.equal(rows[0].costBasisUsd, 0);
  assert.equal(rows[0].realizedGainUsd, 250);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no prior basis/);
});

test('fifo: unknown prices — receipt warns basis 0, disposal warns null proceeds', () => {
  const rows = [
    row('receive', 100_000_000, 1000, null),
    row('send',   -100_000_000, 2000, null),
  ];
  const { warnings } = computeCostBasis(rows, { method: 'fifo' });
  assert.equal(rows[1].costBasisUsd, 0);
  assert.equal(rows[1].proceedsUsd, null);
  assert.equal(rows[1].realizedGainUsd, null);
  assert.equal(warnings.length, 2);
});

test('fifo: method none is a no-op', () => {
  const rows = [row('send', -100_000_000, 1000, 250)];
  const { warnings } = computeCostBasis(rows, { method: 'none' });
  assert.equal(warnings.length, 0);
  assert.equal(rows[0].costBasisUsd, null);
});

test('popFifo: partial lot consumption leaves remainder in queue', () => {
  const queue = [{ quantity: 2, costBasisPerUnit: 100, acquiredAt: 0 }];
  const { costBasis, unbased } = popFifo(queue, 0.5, DAY);
  assert.equal(costBasis, 50);
  assert.equal(unbased, 0);
  assert.equal(queue[0].quantity, 1.5);
});

test('popFifo: float dust does not create phantom unbased amounts', () => {
  // 0.1 + 0.2 !== 0.3 in IEEE-754; the EPS guard must absorb it
  const queue = [
    { quantity: 0.1, costBasisPerUnit: 100, acquiredAt: 0 },
    { quantity: 0.2, costBasisPerUnit: 100, acquiredAt: 0 },
  ];
  const { unbased } = popFifo(queue, 0.3, DAY);
  assert.ok(unbased < 1e-9, `unbased should be ~0, got ${unbased}`);
});
