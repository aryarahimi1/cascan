/**
 * test/campaign.test.js — pure campaign math (no network).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProgress, parseGoalBch } from '../src/commands/campaign.js';
import { formatBch } from '../src/campaign/progress.js';

test('parseGoalBch: valid amounts', () => {
  assert.equal(parseGoalBch('100'), '10000000000');
  assert.equal(parseGoalBch('0.5'), '50000000');
  assert.equal(parseGoalBch('1.23456789'), '123456789');
  assert.equal(parseGoalBch('0'), '0');
});

test('parseGoalBch: rejects garbage and >8 decimals', () => {
  for (const bad of ['abc', '-5', '1.000000001', '1e3', '', null, '1.', '.5']) {
    assert.throws(() => parseGoalBch(bad), /--goal/);
  }
});

test('computeProgress: percent is basis-point exact via BigInt', () => {
  const p = computeProgress('2500000000', '10000000000'); // 2.5 / 10 BCH
  assert.equal(p.percent, 25);
  assert.equal(p.reached, false);
});

test('computeProgress: exact-goal and over-goal reach', () => {
  assert.equal(computeProgress('10000000000', '10000000000').reached, true);
  assert.equal(computeProgress('10000000001', '10000000000').reached, true);
  assert.equal(computeProgress('10000000000', '10000000000').percent, 100);
});

test('computeProgress: no goal → null percent, never reached', () => {
  const p = computeProgress('500000000', null);
  assert.equal(p.percent, null);
  assert.equal(p.reached, false);
  assert.equal(p.goalSats, null);
});

test('computeProgress: zero goal → null percent (no div-by-zero)', () => {
  const p = computeProgress('500000000', '0');
  assert.equal(p.percent, null);
});

test('computeProgress: huge satoshi sums stay exact (float-unsafe range)', () => {
  const p = computeProgress('9999999999999999', '10000000000000000');
  // 0.9999999999999999 of goal → 99.99% (basis-point truncation), not reached
  assert.equal(p.percent, 99.99);
  assert.equal(p.reached, false);
  assert.equal(p.raisedSats, '9999999999999999'); // exact — floats would round this
});

test('campaign browser math: formats BCH without floating money conversion', () => {
  assert.equal(formatBch('0'), '0');
  assert.equal(formatBch('25000000'), '0.25');
  assert.equal(formatBch('100000001'), '1.00000001');
  assert.equal(formatBch('-1'), '-0.00000001');
  assert.throws(() => formatBch('0x10'), /decimal satoshis/);
  assert.throws(() => computeProgress('1e8', '100000000'), /decimal satoshis/);
});
