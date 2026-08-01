/**
 * test/tokens.test.js
 *
 * Pure token-aggregation + formatting tests (no network).
 * Shapes mirror the live Fulcrum probe (scripts/probe-tokens.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTokenUtxos, formatTokenAmount, isValidCategory } from '../src/tokens/aggregate.js';

const CAT_A = 'a'.repeat(64);
const CAT_B = 'b'.repeat(64);

test('aggregate: FT amounts sum as BigInt across UTXOs (no float drift)', () => {
  const utxos = [
    { tx_hash: 't1', tx_pos: 0, value: 800, token_data: { category: CAT_A, amount: '99999999999999950' } },
    { tx_hash: 't2', tx_pos: 1, value: 800, token_data: { category: CAT_A, amount: '100' } },
  ];
  const [a] = aggregateTokenUtxos(utxos);
  assert.equal(a.ftAmount, '100000000000000050'); // exact — Number would lose precision here
  assert.equal(a.utxoCount, 2);
  assert.equal(a.satsLocked, '1600');
  assert.equal(a.nftCount, 0);
});

test('aggregate: NFTs tracked with capability + commitment', () => {
  const utxos = [
    { tx_hash: 't1', tx_pos: 0, value: 800, token_data: { category: CAT_B, nft: { capability: 'minting', commitment: 'deadbeef' } } },
    { tx_hash: 't2', tx_pos: 0, value: 800, token_data: { category: CAT_B, nft: { capability: 'none', commitment: '' } } },
  ];
  const [b] = aggregateTokenUtxos(utxos);
  assert.equal(b.nftCount, 2);
  assert.deepEqual(b.nfts[0], { capability: 'minting', commitment: 'deadbeef', txid: 't1', vout: 0 });
  assert.equal(b.ftAmount, '0');
});

test('aggregate: mixed FT+NFT+plain entries; plain (no token_data) ignored', () => {
  const utxos = [
    { tx_hash: 't0', tx_pos: 0, value: 100000 }, // plain BCH utxo
    { tx_hash: 't1', tx_pos: 0, value: 800, token_data: { category: CAT_A, amount: '5', nft: { capability: 'none', commitment: '' } } },
    { tx_hash: 't2', tx_pos: 0, value: 800, token_data: { category: CAT_B, amount: '7' } },
  ];
  const out = aggregateTokenUtxos(utxos);
  assert.equal(out.length, 2);
  const a = out.find(e => e.category === CAT_A);
  assert.equal(a.ftAmount, '5');
  assert.equal(a.nftCount, 1); // FT and NFT can share one UTXO (immutable NFT + FT amount)
});

test('aggregate: empty input → empty output', () => {
  assert.deepEqual(aggregateTokenUtxos([]), []);
  assert.deepEqual(aggregateTokenUtxos(null), []);
});

test('format: decimals applied as string math', () => {
  assert.equal(formatTokenAmount('100000000000000050', 8), '1000000000.0000005');
  assert.equal(formatTokenAmount('1234567', 6), '1.234567');
  assert.equal(formatTokenAmount('100', 2), '1');
  assert.equal(formatTokenAmount('42', 0), '42');
  assert.equal(formatTokenAmount('7', 8), '0.00000007');
  assert.equal(formatTokenAmount('123', null), '123');
});

test('category id validation', () => {
  assert.ok(isValidCategory(CAT_A));
  assert.ok(isValidCategory(CAT_A.toUpperCase()));
  assert.ok(!isValidCategory('xyz'));
  assert.ok(!isValidCategory('a'.repeat(63)));
  assert.ok(!isValidCategory(null));
});
