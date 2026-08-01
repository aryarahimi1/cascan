/**
 * src/history/csv.js
 *
 * CSV writer for history rows. RFC 4180-ish: quote fields with
 * comma/quote/CR/LF, double embedded quotes, CRLF line endings,
 * spreadsheet formula-injection guard. No I/O.
 *
 * Cost-basis columns (cost_basis_usd, proceeds_usd, realized_gain_usd,
 * holding_period, income_usd) are populated only under --cost-basis fifo;
 * otherwise they stay empty so the CSV shape never changes.
 *
 * Lineage: ported from glnc's src/history/csv.js.
 */

export const CSV_COLUMNS = [
  'timestamp', 'iso_timestamp', 'txid', 'height', 'type',
  'delta_sats', 'amount_bch', 'fee_sats',
  'usd_price', 'usd_value',
  'cost_basis_usd', 'proceeds_usd', 'realized_gain_usd', 'holding_period',
  'income_usd',
];

const COLUMN_TO_ROW_KEY = {
  timestamp:         'timestamp',
  iso_timestamp:     'isoTimestamp',
  txid:              'txid',
  height:            'height',
  type:              'type',
  delta_sats:        'deltaSats',
  amount_bch:        'amountBch',
  fee_sats:          'feeSats',
  usd_price:         'usdPrice',
  usd_value:         'usdValue',
  cost_basis_usd:    'costBasisUsd',
  proceeds_usd:      'proceedsUsd',
  realized_gain_usd: 'realizedGainUsd',
  holding_period:    'holdingPeriod',
  income_usd:        'incomeUsd',
};

const USD_COLUMNS = new Set(['usd_price', 'usd_value', 'cost_basis_usd', 'proceeds_usd', 'realized_gain_usd', 'income_usd']);

// Fixed 4-decimal precision, never scientific.
function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return n.toFixed(4);
}

export function escapeField(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'string')        s = v;
  else if (typeof v === 'number')   s = Number.isFinite(v) ? String(v) : '';
  else if (typeof v === 'bigint')   s = v.toString();
  else if (typeof v === 'boolean')  s = v ? 'true' : 'false';
  else                              s = JSON.stringify(v);

  // Spreadsheet formula-injection guard: =, +, -, @, tab, CR at cell start.
  // Purely numeric strings (e.g. a negative delta_sats) are exempt — they
  // cannot be formulas and guarding them would corrupt numeric columns.
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s);
  if (needsFormulaGuard) s = "'" + s;
  if (needsFormulaGuard || /[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCells(row) {
  const cells = [];
  for (const col of CSV_COLUMNS) {
    let v = row[COLUMN_TO_ROW_KEY[col]];
    if (USD_COLUMNS.has(col)) v = formatUsd(v);
    cells.push(escapeField(v));
  }
  return cells;
}

/**
 * Convert history rows into a CSV string.
 * @param {object[]} rows
 * @returns {string}
 */
export function rowsToCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows ?? []) lines.push(rowToCells(r).join(','));
  return lines.join('\r\n') + '\r\n';
}
