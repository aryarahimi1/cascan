/**
 * test/adapter.test.js
 *
 * CashScript NetworkProvider adapter tests (no network): UTXO shape
 * mapping (bigint money, CashTokens), locking-bytecode scripthash path,
 * broadcast error classification, and the double-broadcast txid recovery.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CascanNetworkProvider, toCashScriptUtxo, txidFromHex } from '../src/adapters/cashscript.js';
import { parseAddress } from '../src/address.js';
import { encodeCashAddr } from '../src/cashaddr.js';
import { rawTransaction, outpointForRaw } from './helpers.js';

/** Minimal Cascan stand-in: routes request() to a handler map. */
function fakeCascan(handlers) {
  return {
    pool: {},
    request: async (method, params) => {
      const h = handlers[method];
      if (!h) throw new Error(`unexpected method ${method}`);
      return h(params);
    },
    verify: async (method, params, opts) => {
      const h = handlers._verify ?? handlers[method];
      if (!h) throw new Error(`unexpected verified method ${method}`);
      return { value: await h(params), receipt: { agreementCount: opts.minAgreement } };
    },
    height: async () => handlers._height ?? 961725,
  };
}

// ---------------------------------------------------------------------------
// UTXO mapping — the money-shape contract
// ---------------------------------------------------------------------------

test('utxo: plain BCH — bigint satoshis, no token field', () => {
  const u = toCashScriptUtxo({ tx_hash: 'aa'.repeat(32), tx_pos: 1, value: 546, height: 1 });
  assert.equal(u.txid, 'aa'.repeat(32));
  assert.equal(u.vout, 1);
  assert.equal(u.satoshis, 546n);
  assert.equal(typeof u.satoshis, 'bigint');
  assert.equal('token' in u, false);
});

test('utxo: fungible CashTokens — amount as bigint from decimal string', () => {
  const u = toCashScriptUtxo({
    tx_hash: 'bb'.repeat(32), tx_pos: 0, value: 1000,
    token_data: { category: 'cc'.repeat(32), amount: '99999999999999950' },
  });
  assert.equal(u.token.amount, 99999999999999950n); // exceeds float precision — must be exact
  assert.equal(u.token.category, 'cc'.repeat(32));
  assert.equal('nft' in u.token, false);
});

test('utxo: NFT — capability + commitment mapped, defaults applied', () => {
  const u = toCashScriptUtxo({
    tx_hash: 'dd'.repeat(32), tx_pos: 2, value: 800,
    token_data: { category: 'ee'.repeat(32), amount: '0', nft: { capability: 'minting', commitment: 'beef' } },
  });
  assert.deepEqual(u.token.nft, { capability: 'minting', commitment: 'beef' });
  const bare = toCashScriptUtxo({
    tx_hash: 'dd'.repeat(32), tx_pos: 3, value: 800,
    token_data: { category: 'ee'.repeat(32), nft: {} },
  });
  assert.deepEqual(bare.token.nft, { capability: 'none', commitment: '' });
  assert.equal(bare.token.amount, 0n);
});

// ---------------------------------------------------------------------------
// Provider methods
// ---------------------------------------------------------------------------

test('provider: getUtxos preserves a token-aware P2SH32 address and verifies its outputs', async () => {
  let seen = null;
  const address = encodeCashAddr(
    'bitcoincash',
    'p2sh',
    new Uint8Array(32).fill(0x42),
    { tokenAware: true },
  );
  const expected = parseAddress(address);
  const raw = rawTransaction([{ value: 1n, lockingBytecode: Buffer.from(expected.lockingScript, 'hex') }]);
  const p = new CascanNetworkProvider(fakeCascan({
    'blockchain.address.listunspent': (params) => { seen = params; return [outpointForRaw(raw, 0, 1n)]; },
    'blockchain.transaction.get': () => raw,
  }));
  const utxos = await p.getUtxos(address);
  assert.deepEqual(seen, [address, 'include_tokens']);
  assert.equal(utxos.length, 1);
  assert.equal(p.network, 'mainnet');
});

test('provider: getUtxos rejects a real UTXO locked to a different address', async () => {
  const address = 'bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl';
  const foreignRaw = rawTransaction([{
    value: 50_000n,
    lockingBytecode: Buffer.from('76a914' + 'ff'.repeat(20) + '88ac', 'hex'),
  }]);
  const p = new CascanNetworkProvider(fakeCascan({
    'blockchain.address.listunspent': () => [outpointForRaw(foreignRaw, 0, 50_000n)],
    'blockchain.transaction.get': () => foreignRaw,
  }));

  await assert.rejects(() => p.getUtxos(address), /locking bytecode mismatch/);
});

test('provider: getUtxosForLockingBytecode → electrum scripthash (hex + bytes agree)', async () => {
  const calls = [];
  const p = new CascanNetworkProvider(fakeCascan({
    'blockchain.scripthash.listunspent': (params) => { calls.push(params[0]); return []; },
  }));
  // P2PKH locking script (76a914…88ac) — 25 bytes
  const hex = '76a914fc916f213a3d7f1369313d5fa30f6168f9446a2d88ac';
  await p.getUtxosForLockingBytecode(hex);
  await p.getUtxosForLockingBytecode(Uint8Array.from(Buffer.from(hex, 'hex')));
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1], 'hex string and Uint8Array produce the same scripthash');
  assert.match(calls[0], /^[0-9a-f]{64}$/);
});

test('provider: constructor rejects a non-connected argument', () => {
  assert.throws(() => new CascanNetworkProvider(null), /connected cascan instance/);
  assert.throws(() => new CascanNetworkProvider({}), /connected cascan instance/);
});

// ---------------------------------------------------------------------------
// Broadcast semantics
// ---------------------------------------------------------------------------

test('broadcast: errors carry the CashScript-documented names', async () => {
  const cases = [
    ['bad-txns-inputs-missingorspent', 'NetworkProviderMissingInputsError'],
    ['txn-mempool-conflict', 'NetworkProviderMempoolConflictError'],
    ['the transaction was not final', 'NetworkProviderAbsoluteTimelockError'],
    ['non-BIP68-final', 'NetworkProviderRelativeTimelockError'],
    ['scriptsig-not-pushonly', 'NetworkProviderError'], // fallback
  ];
  for (const [msg, name] of cases) {
    const p = new CascanNetworkProvider(fakeCascan({
      'blockchain.transaction.broadcast': () => { throw new Error(msg); },
    }));
    await assert.rejects(() => p.sendRawTransaction('00'), (err) => {
      assert.equal(err.name, name, msg);
      return true;
    });
  }
});

test('broadcast: "already in mempool" is success only after independent retrieval', async () => {
  const txHex = '0100000001' + '00'.repeat(20); // arbitrary bytes — txid is just double-SHA256
  const p = new CascanNetworkProvider(fakeCascan({
    'blockchain.transaction.broadcast': () => { throw new Error('Transaction already in the mempool'); },
    _verify: () => txHex,
  }));
  const txid = await p.sendRawTransaction(txHex);
  assert.equal(txid, txidFromHex(txHex));
  assert.match(txid, /^[0-9a-f]{64}$/);
});

test('broadcast: one server claiming "already in mempool" cannot fake success', async () => {
  const p = new CascanNetworkProvider(fakeCascan({
    'blockchain.transaction.broadcast': () => { throw new Error('Transaction already in the mempool'); },
    _verify: () => { throw new Error('security quorum unavailable'); },
  }));
  await assert.rejects(
    () => p.sendRawTransaction('0100000001' + '00'.repeat(20)),
    /not independently verified/
  );
});

test('txidFromHex: double-SHA256, byte-reversed (pinned vector)', () => {
  // sha256d(0x00) = 1406e058…539a; txid rule reverses the bytes.
  const txid = txidFromHex('00');
  assert.equal(txid, '9a538906e6466ebd2617d321f71bc94e56056ce213d366773699e28158e00614');
});
