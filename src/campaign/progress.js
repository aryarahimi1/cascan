const SATS_PER_BCH = 100_000_000n;

/** Pure, BigInt-safe fundraiser progress computation. */
export function computeProgress(raisedSats, goalSats) {
  const raised = decimalSats(raisedSats, 'raisedSats');
  const goal = goalSats == null ? null : decimalSats(goalSats, 'goalSats');
  const percent = goal != null && goal > 0n
    ? Number((raised * 10_000n) / goal) / 100
    : null;
  return {
    raisedSats: raised.toString(),
    goalSats: goal?.toString() ?? null,
    percent,
    reached: goal != null && raised >= goal,
  };
}

/** Parse a BCH amount such as `10` or `0.5` into decimal satoshis. */
export function parseGoalBch(value) {
  if (!/^\d+(\.\d{1,8})?$/.test(value ?? '')) {
    const err = new Error(
      `--goal must be a non-negative BCH amount with ≤8 decimals (got: ${JSON.stringify(value)})`,
    );
    err.exitCode = 1;
    throw err;
  }
  const [whole, fraction = ''] = value.split('.');
  return (
    BigInt(whole) * SATS_PER_BCH
    + BigInt((fraction + '00000000').slice(0, 8))
  ).toString();
}

/** Format decimal satoshis without converting money through Number. */
export function formatBch(wholeSats) {
  const sats = decimalSats(wholeSats, 'satoshis');
  const sign = sats < 0n ? '-' : '';
  const absolute = sats < 0n ? -sats : sats;
  const whole = absolute / SATS_PER_BCH;
  const fraction = (absolute % SATS_PER_BCH)
    .toString()
    .padStart(8, '0')
    .replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function decimalSats(value, field) {
  const normalized = typeof value === 'bigint' ? value.toString() : value;
  if (typeof normalized !== 'string' || !/^-?\d+$/.test(normalized)) {
    throw new TypeError(`${field} must be decimal satoshis`);
  }
  return BigInt(normalized);
}
