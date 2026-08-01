/**
 * test/cashaddr.test.js
 *
 * CashAddr codec tests. Ground-truth anchors:
 *
 *   - The genesis coinbase address 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
 *     has the publicly documented hash160
 *     62e907b15cbf27d5425399ebf6f0fb50ebb88f18 (BTC and BCH share
 *     pre-fork history).
 *   - bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl is the
 *     cashaddr spec's worked-example string; hand-tracing the 5→8 bit
 *     conversion yields hash160 fc916f213a3d7f1369313d5fa30f6168f9446a2d
 *     (first two bytes 0x00 0xfc verified by manual bit grouping).
 *   - scripts/spike.mjs cross-checks legacy vs cashaddr against live
 *     Fulcrum servers (same scripthash ⇒ same balance).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeCashAddr, encodeCashAddr, isValidCashAddr } from '../src/cashaddr.js';
import { base58CheckDecode, base58CheckEncode } from '../src/base58.js';
import { parseAddress } from '../src/address.js';

const GENESIS_LEGACY = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const GENESIS_HASH160 = '62e907b15cbf27d5425399ebf6f0fb50ebb88f18';
const SPEC_EXAMPLE = 'bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl';
const SPEC_EXAMPLE_HASH160 = 'fc916f213a3d7f1369313d5fa30f6168f9446a2d';
const TOKEN_AWARE_SPEC_EXAMPLE = 'bitcoincash:zr7fzmep8g7h7ymfxy74lgc0v950j3r295z4y4gq0v';

const hex = (u8) => Buffer.from(u8).toString('hex');

test('base58check: genesis legacy decodes to the documented hash160', () => {
  const leg = base58CheckDecode(GENESIS_LEGACY);
  assert.ok(leg);
  assert.equal(leg.version, 0x00);
  assert.equal(hex(leg.hash), GENESIS_HASH160);
});

test('cashaddr: spec worked-example string decodes to the hand-traced hash160', () => {
  const ca = decodeCashAddr(SPEC_EXAMPLE);
  assert.ok(ca, 'spec example string failed to decode');
  assert.equal(ca.prefix, 'bitcoincash');
  assert.equal(ca.type, 'p2pkh');
  assert.equal(hex(ca.hash), SPEC_EXAMPLE_HASH160);
});

test('cashaddr: encode is the exact inverse of decode (spec example)', () => {
  const ca = decodeCashAddr(SPEC_EXAMPLE);
  assert.equal(encodeCashAddr('bitcoincash', ca.type, ca.hash), SPEC_EXAMPLE);
});

test('cashaddr: token-aware CashTokens addresses retain their base type', () => {
  const ca = decodeCashAddr(TOKEN_AWARE_SPEC_EXAMPLE);
  assert.ok(ca, 'token-aware spec example string failed to decode');
  assert.equal(ca.type, 'p2pkh');
  assert.equal(ca.tokenAware, true);
  assert.equal(hex(ca.hash), SPEC_EXAMPLE_HASH160);
  assert.equal(
    encodeCashAddr('bitcoincash', ca.type, ca.hash, { tokenAware: true }),
    TOKEN_AWARE_SPEC_EXAMPLE,
  );
});

test('legacy ↔ cashaddr: same hash produces both forms (genesis)', () => {
  const leg = base58CheckDecode(GENESIS_LEGACY);
  const cashaddr = encodeCashAddr('bitcoincash', 'p2pkh', leg.hash);
  const ca = decodeCashAddr(cashaddr);
  assert.ok(ca);
  assert.equal(hex(ca.hash), GENESIS_HASH160);
  // And back to legacy
  assert.equal(base58CheckEncode(0x00, ca.hash), GENESIS_LEGACY);
});

test('bare (prefixless) cashaddr decodes under mainnet default', () => {
  const bare = SPEC_EXAMPLE.split(':')[1];
  const d = decodeCashAddr(bare);
  assert.ok(d);
  assert.equal(d.cashaddr, SPEC_EXAMPLE);
});

test('uppercase cashaddr is accepted; mixed case is rejected', () => {
  assert.ok(isValidCashAddr(SPEC_EXAMPLE.toUpperCase()));
  const mixed = 'bitcoincash:qr7fzmep8G7H7YMFXY74LGC0V950J3R2959LHTXXSL';
  assert.equal(isValidCashAddr(mixed), false);
});

test('corrupted checksum is rejected', () => {
  const bad = SPEC_EXAMPLE.slice(0, -1) + (SPEC_EXAMPLE.endsWith('l') ? 'x' : 'l');
  assert.equal(decodeCashAddr(bad), null);
});

test('round-trip: random hashes survive encode→decode (both types)', () => {
  for (let i = 0; i < 32; i++) {
    const hash = new Uint8Array(randomBytes(20));
    const type = i % 2 === 0 ? 'p2pkh' : 'p2sh';
    const encoded = encodeCashAddr('bitcoincash', type, hash);
    const decoded = decodeCashAddr(encoded);
    assert.ok(decoded, `decode failed for ${encoded}`);
    assert.equal(hex(decoded.hash), hex(hash));
    assert.equal(decoded.type, type);
  }
});

test('base58 round-trip: random hashes survive encode→decode', () => {
  for (let i = 0; i < 16; i++) {
    const hash = new Uint8Array(randomBytes(20));
    const version = i % 2 === 0 ? 0x00 : 0x05;
    const decoded = base58CheckDecode(base58CheckEncode(version, hash));
    assert.ok(decoded);
    assert.equal(decoded.version, version);
    assert.equal(hex(decoded.hash), hex(hash));
  }
});

test('parseAddress: all three input forms converge to one record', () => {
  const a = parseAddress(GENESIS_LEGACY);
  const b = parseAddress(a.cashaddr);
  const c = parseAddress(a.cashaddr.split(':')[1]);
  assert.equal(hex(a.hash), GENESIS_HASH160);
  assert.equal(a.scripthash, b.scripthash);
  assert.equal(b.scripthash, c.scripthash);
  assert.equal(a.legacy, GENESIS_LEGACY);
  assert.ok(a.warnings.length > 0, 'legacy input should carry the BTC-ambiguity warning');
  assert.equal(b.warnings.length, 0);
});

test('parseAddress: known locking script + scripthash (genesis address)', () => {
  const rec = parseAddress(GENESIS_LEGACY);
  assert.equal(rec.lockingScript, '76a914' + GENESIS_HASH160 + '88ac');
  assert.match(rec.scripthash, /^[0-9a-f]{64}$/);
});

test('parseAddress: token-aware P2SH32 yields the OP_HASH256 locking script', () => {
  const hash = new Uint8Array(randomBytes(32));
  const address = encodeCashAddr('bitcoincash', 'p2sh', hash, { tokenAware: true });
  const rec = parseAddress(address);

  assert.equal(rec.type, 'p2sh');
  assert.equal(rec.tokenAware, true);
  assert.equal(rec.cashaddr, address);
  assert.equal(rec.legacy, null, 'P2SH32 has no legacy Base58Check representation');
  assert.equal(rec.lockingScript, 'aa20' + hex(hash) + '87');
});

test('parseAddress: garbage rejected with a useful error', () => {
  assert.throws(() => parseAddress('not-an-address'), /unrecognized address/);
  assert.throws(() => parseAddress(''), /empty address/);
});
