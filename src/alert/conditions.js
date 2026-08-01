/**
 * src/alert/conditions.js
 *
 * Parser and evaluator for the alert condition DSL.
 * Syntax: <lhs> <op> <number>
 *
 * Supported LHS paths (case-insensitive):
 *   balance              — confirmed + unconfirmed, in BCH
 *   balance.bch          — alias of balance
 *   balance.sats         — confirmed + unconfirmed, in satoshis
 *   balance.usd          — balance × BCH/USD spot price
 *   unconfirmed          — unconfirmed (mempool) delta, in BCH
 *   unconfirmed.sats     — unconfirmed delta, in satoshis
 *
 * Lineage: ported from glnc's src/alert/conditions.js; the EVM/Aave paths
 * were replaced by the Fulcrum balance shape (confirmed/unconfirmed sats).
 */

const VALID_OPS = new Set(['<', '<=', '>', '>=', '==', '!=']);

const VALID_PATHS = new Set([
  'balance', 'balance.bch', 'balance.sats', 'balance.usd',
  'unconfirmed', 'unconfirmed.bch', 'unconfirmed.sats',
]);

/**
 * @typedef {{ lhs: string[], op: string, rhs: number, needsPrice: boolean }} ParsedCondition
 */

/**
 * Parse a condition string into its components.
 * Throws with a descriptive message on invalid input.
 *
 * @param {string} str
 * @returns {ParsedCondition}
 */
export function parseCondition(str) {
  const parts = String(str ?? '').trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(
      `Unsupported condition: ${JSON.stringify(str)}. ` +
      `Expected exactly 3 tokens: <lhs> <op> <number>. Got ${parts.length}.`
    );
  }

  const [lhsRaw, op, rhsRaw] = parts;

  if (!VALID_OPS.has(op)) {
    throw new Error(
      `Unsupported operator: "${op}". Valid operators: ${[...VALID_OPS].join(', ')}`
    );
  }

  const rhs = Number(rhsRaw);
  if (!Number.isFinite(rhs)) {
    throw new Error(`Right-hand side "${rhsRaw}" is not a valid number.`);
  }

  const lhsPath = lhsRaw.toLowerCase();
  if (!VALID_PATHS.has(lhsPath)) {
    throw new Error(
      `Unsupported condition path: "${lhsRaw}". ` +
      `Valid paths: balance, balance.sats, balance.usd, unconfirmed, unconfirmed.sats`
    );
  }

  return {
    lhs: lhsPath.split('.'),
    op,
    rhs,
    needsPrice: lhsPath === 'balance.usd',
  };
}

/**
 * Build the evaluation context from a Fulcrum get_balance result.
 *
 * @param {{ confirmed?: number|string, unconfirmed?: number|string }} balance
 *        — raw Fulcrum `blockchain.address.get_balance` value (satoshis)
 * @param {number|null} [usdPrice] — BCH/USD spot, or null when unavailable
 * @returns {object} evaluation context
 */
export function buildContext(balance, usdPrice = null) {
  const toSats = (v) => {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
    return null;
  };

  const confirmed = toSats(balance?.confirmed);
  const unconfirmed = toSats(balance?.unconfirmed);
  const totalSats = confirmed != null && unconfirmed != null ? confirmed + unconfirmed : null;
  const totalBch = totalSats != null ? totalSats / 1e8 : null;

  return {
    balance: {
      bch: totalBch,
      sats: totalSats,
      usd: totalBch != null && usdPrice != null ? totalBch * usdPrice : null,
    },
    unconfirmed: {
      bch: unconfirmed != null ? unconfirmed / 1e8 : null,
      sats: unconfirmed,
    },
  };
}

/**
 * Resolve the LHS path in the context and return its numeric value, or null.
 */
function resolveLhs(lhs, ctx) {
  const root = ctx[lhs[0]];
  if (!root) return null;
  const field = lhs[1] ?? 'bch'; // bare `balance` / `unconfirmed` mean BCH
  return root[field] ?? null;
}

/**
 * Evaluate a parsed condition against a context.
 *
 * @param {ParsedCondition} parsed
 * @param {object} ctx  — from buildContext
 * @returns {{ ok: boolean, lhsValue: number|null, reason: string }}
 */
export function evaluateCondition(parsed, ctx) {
  const { lhs, op, rhs } = parsed;
  const lhsValue = resolveLhs(lhs, ctx);

  if (lhsValue === null) {
    return {
      ok: false,
      lhsValue: null,
      reason: `LHS path "${lhs.join('.')}" resolved to null (missing data — price or malformed balance)`,
    };
  }

  let ok;
  switch (op) {
    case '<':  ok = lhsValue <  rhs; break;
    case '<=': ok = lhsValue <= rhs; break;
    case '>':  ok = lhsValue >  rhs; break;
    case '>=': ok = lhsValue >= rhs; break;
    case '==': ok = lhsValue === rhs; break;
    case '!=': ok = lhsValue !== rhs; break;
    default:   ok = false;
  }

  return { ok, lhsValue, reason: `${lhsValue} ${op} ${rhs} → ${ok}` };
}
