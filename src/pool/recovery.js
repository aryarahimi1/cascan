/**
 * Browser-safe retry and recovery policy shared by both server pools.
 *
 * Connection attempts are globally budgeted in a fixed window. Individual
 * server failures open a circuit with equal-jitter exponential cooldown, and
 * whole-pool recovery uses its own bounded exponential schedule. The class
 * owns no timers; pools keep exactly one recovery timer and remain in control
 * of lifecycle/close semantics.
 */

export const MAX_RECOVERY_TIMER_MS = 2_147_483_647;

const DEFAULTS = Object.freeze({
  failureBackoffBaseMs: 1_000,
  failureBackoffMaxMs: 60_000,
  minHealthyUptimeMs: 60_000,
  retryBudgetWindowMs: 60_000,
  recoveryBackoffBaseMs: 1_000,
  recoveryBackoffMaxMs: 60_000,
});

function boundedInteger(name, value, fallback, max = MAX_RECOVERY_TIMER_MS, min = 1) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

export function normalizeRecoveryOptions(opts = {}, serverCount = 1) {
  const policy = {
    failureBackoffBaseMs: boundedInteger(
      'failureBackoffBaseMs', opts.failureBackoffBaseMs, DEFAULTS.failureBackoffBaseMs,
      MAX_RECOVERY_TIMER_MS, 100,
    ),
    failureBackoffMaxMs: boundedInteger(
      'failureBackoffMaxMs', opts.failureBackoffMaxMs, DEFAULTS.failureBackoffMaxMs,
    ),
    minHealthyUptimeMs: boundedInteger(
      'minHealthyUptimeMs', opts.minHealthyUptimeMs, DEFAULTS.minHealthyUptimeMs,
      MAX_RECOVERY_TIMER_MS, 1_000,
    ),
    retryBudgetAttempts: boundedInteger(
      'retryBudgetAttempts', opts.retryBudgetAttempts,
      Math.min(32, Math.max(4, serverCount)), 64,
    ),
    retryBudgetWindowMs: boundedInteger(
      'retryBudgetWindowMs', opts.retryBudgetWindowMs, DEFAULTS.retryBudgetWindowMs,
      MAX_RECOVERY_TIMER_MS, 1_000,
    ),
    recoveryBackoffBaseMs: boundedInteger(
      'recoveryBackoffBaseMs', opts.recoveryBackoffBaseMs, DEFAULTS.recoveryBackoffBaseMs,
      MAX_RECOVERY_TIMER_MS, 100,
    ),
    recoveryBackoffMaxMs: boundedInteger(
      'recoveryBackoffMaxMs', opts.recoveryBackoffMaxMs, DEFAULTS.recoveryBackoffMaxMs,
    ),
  };
  if (policy.failureBackoffMaxMs < policy.failureBackoffBaseMs) {
    throw new RangeError('failureBackoffMaxMs must be greater than or equal to failureBackoffBaseMs');
  }
  if (policy.recoveryBackoffMaxMs < policy.recoveryBackoffBaseMs) {
    throw new RangeError('recoveryBackoffMaxMs must be greater than or equal to recoveryBackoffBaseMs');
  }
  return Object.freeze(policy);
}

function safeRandom(random) {
  try {
    const value = random();
    if (Number.isFinite(value)) return Math.max(0, Math.min(0.9999999999999999, value));
  } catch { /* deterministic midpoint fallback */ }
  return 0.5;
}

/** Equal jitter: delay is always in [cap/2, cap), avoiding zero-delay loops. */
export function equalJitterDelay(attempt, baseMs, maxMs, random = Math.random) {
  const exponent = Math.min(16, Math.max(0, Number.isInteger(attempt) ? attempt - 1 : 0));
  const cap = Math.min(maxMs, baseMs * (2 ** exponent));
  const floor = Math.ceil(cap / 2);
  return Math.min(maxMs, floor + Math.floor((cap - floor) * safeRandom(random)));
}

export class RetryController {
  constructor(policy, opts = {}) {
    this.policy = policy;
    this.random = typeof opts.random === 'function' ? opts.random : Math.random;
    this.windowStartedAt = null;
    this.attempts = 0;
    this.recoveryFailures = 0;
  }

  _refresh(now) {
    if (this.windowStartedAt === null || now >= this.windowStartedAt + this.policy.retryBudgetWindowMs) {
      this.windowStartedAt = now;
      this.attempts = 0;
    }
  }

  take(now) {
    this._refresh(now);
    if (this.attempts >= this.policy.retryBudgetAttempts) return false;
    this.attempts++;
    return true;
  }

  budgetAvailableAt(now) {
    this._refresh(now);
    return this.attempts < this.policy.retryBudgetAttempts
      ? now
      : this.windowStartedAt + this.policy.retryBudgetWindowMs;
  }

  noteExhaustion(now, earliestCircuitAt = now) {
    this.recoveryFailures++;
    const backoffMs = equalJitterDelay(
      this.recoveryFailures,
      this.policy.recoveryBackoffBaseMs,
      this.policy.recoveryBackoffMaxMs,
      this.random,
    );
    const retryAt = Math.max(
      now + backoffMs,
      earliestCircuitAt,
      this.budgetAvailableAt(now),
    );
    return {
      attempt: this.recoveryFailures,
      delayMs: Math.max(1, retryAt - now),
      retryAt,
    };
  }

  noteStable(now) {
    this.windowStartedAt = now;
    this.attempts = 0;
    this.recoveryFailures = 0;
  }
}
