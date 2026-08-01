/**
 * src/pool/health.js
 *
 * Pure per-server health scoring — no I/O, fully unit-testable.
 *
 * Each server record carries a `health` object updated by the pool on
 * every observation:
 *
 *   latencyEmaMs  — exponential moving average of request latency
 *   failures      — consecutive failure count (reset on success)
 *   lastOkAt      — ms epoch of last successful call (0 = never)
 *   lastFailAt    — ms epoch of last failure (0 = never)
 *   height        — last reported chain tip (null = unknown)
 *   heightAt      — ms epoch of that height observation (0 = never)
 *
 * The score is a comparable number (higher = better). It is deliberately
 * simple and explainable — every penalty is visible in `cascan servers`
 * output rather than hidden in a magic formula:
 *
 *   100
 *   − latency penalty        (EMA ms / 50 — 500ms costs 10 points)
 *   − 25 × consecutive failures
 *   − 40 × height lag        (blocks behind the corroborated pool tip, capped at 3 —
 *                             ONLY when the observation is fresh: a stale
 *                             cached height says nothing about current lag,
 *                             and penalizing it made every idle server look
 *                             behind the connected one after each new block)
 *   − 15 if failed within the last 5 minutes (flap guard)
 *   + 5  if TLS-verified hostname (authenticated transport)
 */

import { isValidBchHeight } from '../validation.js';

const LATENCY_DIVISOR = 50;
const FAILURE_PENALTY = 25;
const LAG_PENALTY = 40;
const LAG_CAP = 3;
const RECENT_FAIL_PENALTY = 15;
const RECENT_FAIL_WINDOW_MS = 5 * 60 * 1000;
const HEIGHT_FRESH_MS = 10 * 60 * 1000; // ≈ one BCH block interval
const TLS_BONUS = 5;
const EMA_ALPHA = 0.3;

/** Fresh health record for a never-probed server. */
export function newHealth() {
  return { latencyEmaMs: null, failures: 0, lastOkAt: 0, lastFailAt: 0, height: null, heightAt: 0 };
}

/** Record a successful call. Mutates and returns the health record. */
export function recordSuccess(health, latencyMs, height = null) {
  health.latencyEmaMs = health.latencyEmaMs === null
    ? latencyMs
    : Math.round(EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * health.latencyEmaMs);
  health.failures = 0;
  health.lastOkAt = Date.now();
  if (isValidBchHeight(height)) {
    health.height = height;
    health.heightAt = Date.now();
  }
  return health;
}

/** Record a height observation without a latency sample (notifications). */
export function recordHeight(health, height) {
  if (isValidBchHeight(height)) {
    health.height = height;
    health.heightAt = Date.now();
  }
  return health;
}

/** A height observation counts for lag scoring only while fresh. */
function freshHeight(h, now) {
  return h.height != null && h.heightAt > 0 && (now - h.heightAt) <= HEIGHT_FRESH_MS
    ? h.height
    : null;
}

/** Record a failed call. Mutates and returns the health record. */
export function recordFailure(health) {
  health.failures += 1;
  health.lastFailAt = Date.now();
  return health;
}

/**
 * Score one server record against the pool's best height.
 *
 * @param {{ health: object, tlsStrict?: boolean }} server
 * @param {number|null} poolMaxHeight — best height seen across the pool
 * @param {number} [now] — injectable clock for tests
 * @returns {number}
 */
export function scoreServer(server, poolMaxHeight = null, now = Date.now()) {
  const h = server.health;
  let score = 100;

  if (h.latencyEmaMs !== null) score -= h.latencyEmaMs / LATENCY_DIVISOR;
  score -= FAILURE_PENALTY * h.failures;

  const fresh = freshHeight(h, now);
  if (poolMaxHeight != null && fresh != null && fresh < poolMaxHeight) {
    score -= LAG_PENALTY * Math.min(poolMaxHeight - fresh, LAG_CAP);
  }

  if (h.lastFailAt > 0 && (now - h.lastFailAt) < RECENT_FAIL_WINDOW_MS) {
    score -= RECENT_FAIL_PENALTY;
  }

  if (server.tlsStrict) score += TLS_BONUS;

  return score;
}

/**
 * Highest fresh height reported by at least two servers. A single server's
 * tip claim is not sufficient to penalize peers: it may be stale or hostile.
 * When there is no corroborated tip, latency/TLS/failure data still rank the
 * pool but no height-lag score is applied.
 */
export function consensusHeight(servers, now = Date.now()) {
  const counts = new Map();
  for (const server of servers) {
    const height = freshHeight(server.health, now);
    if (height != null) counts.set(height, (counts.get(height) ?? 0) + 1);
  }

  let highest = null;
  for (const [height, count] of counts) {
    if (count >= 2 && (highest === null || height > highest)) highest = height;
  }
  return highest;
}

/**
 * Rank server records best-first. Never-probed servers (no latency data)
 * sort after probed healthy ones but before known-bad ones, so the pool
 * prefers proven servers yet still explores new discoveries on failover.
 *
 * @param {Array<{ health: object, tlsStrict?: boolean }>} servers
 * @param {number} [now]
 * @returns {Array} new sorted array (input not mutated)
 */
export function rankServers(servers, now = Date.now()) {
  const maxHeight = consensusHeight(servers, now);
  return [...servers].sort((a, b) => scoreServer(b, maxHeight, now) - scoreServer(a, maxHeight, now));
}

/** Expose the scoring constants for display/tests (read-only contract). */
export const SCORING = Object.freeze({
  LATENCY_DIVISOR, FAILURE_PENALTY, LAG_PENALTY, LAG_CAP,
  RECENT_FAIL_PENALTY, RECENT_FAIL_WINDOW_MS, HEIGHT_FRESH_MS, TLS_BONUS, EMA_ALPHA,
});
