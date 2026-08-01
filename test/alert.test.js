/**
 * test/alert.test.js
 *
 * Pure condition-DSL tests (no network): parse, context building from
 * Fulcrum get_balance shapes, evaluation semantics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCondition, buildContext, evaluateCondition } from '../src/alert/conditions.js';

// ---------------------------------------------------------------------------
// parseCondition
// ---------------------------------------------------------------------------

test('parse: happy path for every supported LHS path', () => {
  for (const path of ['balance', 'balance.bch', 'balance.sats', 'balance.usd', 'unconfirmed', 'unconfirmed.sats']) {
    const p = parseCondition(`${path} < 5`);
    assert.equal(p.op, '<');
    assert.equal(p.rhs, 5);
    assert.equal(p.needsPrice, path === 'balance.usd');
  }
});

test('parse: case-insensitive, whitespace-tolerant', () => {
  const p = parseCondition('  Balance.USD   >=  1000.5 ');
  assert.deepEqual(p.lhs, ['balance', 'usd']);
  assert.equal(p.op, '>=');
  assert.equal(p.rhs, 1000.5);
  assert.equal(p.needsPrice, true);
});

test('parse: rejects wrong token count, bad ops, bad numbers, bad paths', () => {
  assert.throws(() => parseCondition('balance < '), /3 tokens/);
  assert.throws(() => parseCondition('balance'), /3 tokens/);
  assert.throws(() => parseCondition('balance ~ 5'), /Unsupported operator/);
  assert.throws(() => parseCondition('balance < five'), /not a valid number/);
  assert.throws(() => parseCondition('balance < Infinity'), /not a valid number/);
  assert.throws(() => parseCondition('aave.hf < 1'), /Unsupported condition path/);
  assert.throws(() => parseCondition('balance.eth < 1'), /Unsupported condition path/);
});

// ---------------------------------------------------------------------------
// buildContext — Fulcrum get_balance returns satoshis
// ---------------------------------------------------------------------------

test('context: sats → BCH/sats/USD paths', () => {
  const ctx = buildContext({ confirmed: 150_000_000, unconfirmed: 50_000_000 }, 250);
  assert.equal(ctx.balance.sats, 200_000_000);
  assert.equal(ctx.balance.bch, 2);
  assert.equal(ctx.balance.usd, 500);
  assert.equal(ctx.unconfirmed.sats, 50_000_000);
  assert.equal(ctx.unconfirmed.bch, 0.5);
});

test('context: string sats accepted (defensive), USD null without price', () => {
  const ctx = buildContext({ confirmed: '100000000', unconfirmed: '0' }, null);
  assert.equal(ctx.balance.bch, 1);
  assert.equal(ctx.balance.usd, null);
});

test('context: malformed server fields resolve to null, never NaN', () => {
  const ctx = buildContext({ confirmed: 'abc', unconfirmed: 1.5 }, 250);
  assert.equal(ctx.balance.sats, null);
  assert.equal(ctx.balance.bch, null);
  assert.equal(ctx.balance.usd, null);
});

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

test('evaluate: every operator', () => {
  const ctx = buildContext({ confirmed: 100_000_000, unconfirmed: 0 }, null); // 1 BCH
  const cases = [
    ['balance < 2', true], ['balance < 1', false],
    ['balance <= 1', true], ['balance > 0.5', true],
    ['balance >= 1', true], ['balance == 1', true],
    ['balance != 1', false], ['balance != 2', true],
  ];
  for (const [cond, expected] of cases) {
    const r = evaluateCondition(parseCondition(cond), ctx);
    assert.equal(r.ok, expected, cond);
    assert.equal(r.lhsValue, 1);
  }
});

test('evaluate: missing data (null LHS) is false with a reason, never a fire', () => {
  const ctx = buildContext({ confirmed: 100_000_000, unconfirmed: 0 }, null); // no price
  const r = evaluateCondition(parseCondition('balance.usd > 0'), ctx);
  assert.equal(r.ok, false);
  assert.equal(r.lhsValue, null);
  assert.match(r.reason, /resolved to null/);
});

test('evaluate: unconfirmed paths see only the mempool delta', () => {
  const ctx = buildContext({ confirmed: 500_000_000, unconfirmed: 25_000_000 }, null);
  assert.equal(evaluateCondition(parseCondition('unconfirmed > 0.2'), ctx).ok, true);
  assert.equal(evaluateCondition(parseCondition('unconfirmed.sats == 25000000'), ctx).ok, true);
});
