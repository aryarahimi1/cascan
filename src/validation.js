/**
 * Shared validation for BCH values received from untrusted servers.
 *
 * Ten million blocks is safely beyond BCH's plausible lifetime while still
 * preventing a fabricated height from distorting health ranking or dapp
 * confirmation logic.
 */

export const MAX_REASONABLE_BCH_HEIGHT = 10_000_000;
export const MAX_BCH_SATOSHIS = 2_100_000_000_000_000n;

export function isValidBchHeight(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_REASONABLE_BCH_HEIGHT;
}

export function requireBchHeight(value, message = 'server returned an invalid BCH height') {
  if (!isValidBchHeight(value)) throw new TypeError(message);
  return value;
}

export function isValidBchBlockHeaderHex(value) {
  return typeof value === 'string' && /^[0-9a-f]{160}$/i.test(value);
}

export function requireBchBlockHeaderHex(
  value,
  message = 'server returned a malformed 80-byte block header',
) {
  if (!isValidBchBlockHeaderHex(value)) throw new TypeError(message);
  return value.toLowerCase();
}

/**
 * Parse a server-provided satoshi amount without accepting JavaScript's
 * permissive BigInt syntax (hex, whitespace, signs in confirmed balances).
 */
export function parseBchSatoshis(value, opts = {}) {
  const {
    allowNegative = false,
    field = 'satoshis',
  } = opts;

  let sats;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    sats = BigInt(value);
  } else if (
    typeof value === 'string' &&
    (allowNegative ? /^-?\d{1,16}$/ : /^\d{1,16}$/).test(value)
  ) {
    sats = BigInt(value);
  } else {
    throw new TypeError(`server returned invalid ${field} satoshis`);
  }

  if (
    sats > MAX_BCH_SATOSHIS ||
    sats < (allowNegative ? -MAX_BCH_SATOSHIS : 0n)
  ) {
    throw new RangeError(`server returned impossible ${field} satoshis`);
  }
  return sats;
}

export function isValidElectrumAddressStatus(value) {
  return value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value));
}
