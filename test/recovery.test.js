import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isServerCoolingDown,
  newHealth,
  normalizeHealth,
  rankServers,
  recordFailure,
  recordSuccess,
} from '../src/pool/health.js';
import {
  equalJitterDelay,
  normalizeRecoveryOptions,
  RetryController,
} from '../src/pool/recovery.js';

test('recovery: cached future health state cannot pin a circuit open', () => {
  const health = normalizeHealth({
    latencyEmaMs: 12,
    failures: 2,
    lastOkAt: 5_000,
    lastFailAt: 5_000,
    height: 900_000,
    heightAt: 5_000,
    cooldownUntil: 999_999_999,
  }, { now: 1_000, maxCooldownMs: 100 });

  assert.equal(health.latencyEmaMs, 12);
  assert.equal(health.failures, 2);
  assert.equal(health.lastOkAt, 0);
  assert.equal(health.lastFailAt, 0);
  assert.equal(health.heightAt, 0);
  assert.equal(health.cooldownUntil, 0);
});

test('recovery: equal jitter is exponential, bounded, and never zero', () => {
  assert.equal(equalJitterDelay(1, 100, 1_000, () => 0), 50);
  assert.equal(equalJitterDelay(2, 100, 1_000, () => 0), 100);
  assert.equal(equalJitterDelay(10, 100, 1_000, () => 0.999999), 999);
  assert.equal(equalJitterDelay(100, 100, 1_000, () => 0), 500);
});

test('recovery: invalid policies fail fast instead of creating timer hot loops', () => {
  assert.throws(
    () => normalizeRecoveryOptions({ failureBackoffBaseMs: 100, failureBackoffMaxMs: 10 }),
    /failureBackoffMaxMs/,
  );
  assert.throws(
    () => normalizeRecoveryOptions({ retryBudgetAttempts: 0 }),
    /retryBudgetAttempts/,
  );
  assert.throws(
    () => normalizeRecoveryOptions({ recoveryBackoffMaxMs: 2_147_483_648 }),
    /recoveryBackoffMaxMs/,
  );
});

test('recovery: one global budget caps all callers until the window rolls', () => {
  const policy = normalizeRecoveryOptions({
    retryBudgetAttempts: 2,
    retryBudgetWindowMs: 1_000,
  });
  const budget = new RetryController(policy, { random: () => 0 });
  assert.equal(budget.take(1_000), true);
  assert.equal(budget.take(1_001), true);
  assert.equal(budget.take(1_002), false);
  assert.equal(budget.budgetAvailableAt(1_002), 2_000);
  assert.equal(budget.take(2_000), true, 'new fixed window restores the budget');
});

test('recovery: whole-pool retry waits for backoff, circuit, and budget', () => {
  const policy = normalizeRecoveryOptions({
    retryBudgetAttempts: 1,
    retryBudgetWindowMs: 1_000,
    recoveryBackoffBaseMs: 100,
    recoveryBackoffMaxMs: 100,
  });
  const budget = new RetryController(policy, { random: () => 0 });
  assert.equal(budget.take(5_000), true);
  const recovery = budget.noteExhaustion(5_010, 5_500);
  assert.deepEqual(recovery, { attempt: 1, delayMs: 990, retryAt: 6_000 });
});

test('recovery property: a repeatedly flapping fast server never beats a healthy peer', () => {
  const healthy = { tlsStrict: true, health: newHealth() };
  const flapper = { tlsStrict: true, health: newHealth() };
  recordSuccess(healthy.health, 100, null, { now: 1 });
  recordSuccess(flapper.health, 1, null, { now: 1 });

  // Deterministic pseudo-random jitter exercises 200 failure/cooldown cycles.
  let seed = 0x12345678;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  let now = 10_000;
  for (let cycle = 1; cycle <= 200; cycle++) {
    recordFailure(flapper.health, {
      now,
      random,
      failureBackoffBaseMs: 100,
      failureBackoffMaxMs: 10_000,
    });
    assert.equal(isServerCoolingDown(flapper, now), true);
    assert.equal(rankServers([flapper, healthy], now)[0], healthy, `cooldown cycle ${cycle}`);

    now = flapper.health.cooldownUntil;
    recordSuccess(flapper.health, 1, null, { now, clearFailures: false });
    assert.equal(flapper.health.failures, cycle, 'setup success keeps failure debt');
    assert.equal(rankServers([flapper, healthy], now)[0], healthy, `reconnect cycle ${cycle}`);
    now++;
  }
});
