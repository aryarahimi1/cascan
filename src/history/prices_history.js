/**
 * src/history/prices_history.js
 *
 * Historical BCH/USD daily prices with NO API key — which, as of 2026, is
 * a shrinking privilege (probed 2026-07-29):
 *
 *   CoinGecko /coins/{id}/history  — keyless only within the past 365 days
 *                                    (HTTP 401/10012 beyond that)
 *   CryptoCompare histoday         — now key-required (HTTP 401)
 *   Coinbase spot?date=            — historical lookback discontinued
 *   Kraken OHLC interval=1440      — keyless, ONE request returns the last
 *                                    ~720 daily candles (~2 years)
 *
 * Strategy: Kraken daily closes as primary (single request, no rate-limit
 * dance), CoinGecko as fallback for any day Kraken misses within its 365-day
 * window, and an honest null + warning for anything older. Rows older than
 * ~2 years get usd_value = '' in the CSV — surfaced, never guessed.
 *
 * Lineage: glnc's src/history/prices_history.js, rebuilt around the
 * keyless-coverage reality above.
 */

const KRAKEN_OHLC_URL = 'https://api.kraken.com/0/public/OHLC?pair=BCHUSD&interval=1440';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const COIN_ID = 'bitcoin-cash';
const COINGECKO_KEYLESS_WINDOW_SEC = 364 * 86400; // stay safely inside "past 365 days"

// 'YYYY-MM-DD' → number|null. Populated by Kraken once, then per-day by CoinGecko.
const priceCache = new Map();
let krakenLoaded = false;

/** Unix seconds → 'YYYY-MM-DD' (UTC). */
export function toUtcDay(unixSec) {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/** Unix seconds → CoinGecko's DD-MM-YYYY (UTC). */
export function toCoinGeckoDate(unixSec) {
  const d = new Date(unixSec * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

/**
 * One request → every daily close Kraken will give us (~720 days).
 * Candle open time is UTC midnight; close is the day's closing price.
 */
async function loadKrakenDailies(opts = {}) {
  if (krakenLoaded) return;
  krakenLoaded = true; // one attempt per process — a failure falls through to CoinGecko

  try {
    const res = await fetch(KRAKEN_OHLC_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: opts.signal ?? AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      opts.onWarn?.(`kraken OHLC: HTTP ${res.status} — falling back to CoinGecko (slower, 365-day window)`);
      return;
    }
    const data = await res.json();
    const candles = data?.result?.BCHUSD;
    if (!Array.isArray(candles)) {
      opts.onWarn?.('kraken OHLC: unexpected payload — falling back to CoinGecko');
      return;
    }
    for (const c of candles) {
      const [openTime, , , , close] = c;
      const usd = Number(close);
      if (Number.isFinite(openTime) && Number.isFinite(usd) && usd > 0) {
        priceCache.set(toUtcDay(openTime), usd);
      }
    }
  } catch {
    opts.onWarn?.('kraken OHLC: network error — falling back to CoinGecko (slower, 365-day window)');
  }
}

// CoinGecko fallback: rate-limit gate (free tier is ~10–30 req/min).
const MIN_REQUEST_GAP_MS = 600;
let _gateChain = Promise.resolve();
let _lastRequestAt = 0;
function rateLimitGate() {
  const next = _gateChain.then(async () => {
    const wait = _lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastRequestAt = Date.now();
  });
  _gateChain = next.catch(() => {});
  return next;
}

async function fetchCoinGeckoDay(unixSec, opts = {}) {
  const day = toUtcDay(unixSec);
  if (priceCache.has(day)) return priceCache.get(day);

  await rateLimitGate();
  const url = `${COINGECKO_BASE}/coins/${COIN_ID}/history?date=${toCoinGeckoDate(unixSec)}&localization=false`;

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: opts.signal ?? AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      opts.onWarn?.(`coingecko history: HTTP ${res.status} for ${day}`);
      return null; // not cached — 429s and 401s are not stable facts
    }
    const data = await res.json();
    const v = data?.market_data?.current_price?.usd;
    const usd = typeof v === 'number' && Number.isFinite(v) ? v : null;
    priceCache.set(day, usd); // misses within coverage are stable → cache
    return usd;
  } catch {
    opts.onWarn?.(`coingecko history: network error for ${day}`);
    return null;
  }
}

/**
 * Batched historical BCH/USD lookup, deduplicated by UTC day.
 *
 * @param {number[]} unixSecs — tx timestamps in seconds
 * @param {{ signal?: AbortSignal, onWarn?: (m: string) => void }} [opts]
 * @returns {Promise<Map<number, number|null>>} keyed by the input unixSec
 */
export async function getHistoricalBchPrices(unixSecs, opts = {}) {
  const result = new Map();
  if (!unixSecs || unixSecs.length === 0) return result;

  await loadKrakenDailies(opts);

  const byDay = new Map(); // 'YYYY-MM-DD' → unixSec[]
  for (const sec of unixSecs) {
    const day = toUtcDay(sec);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(sec);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let tooOldDays = 0;

  for (const [day, secs] of byDay) {
    let usd = priceCache.get(day) ?? null;

    if (usd === null && !priceCache.has(day)) {
      // Not in Kraken's window — CoinGecko fallback, keyless-limited to 365d.
      const sec = secs[0];
      if (nowSec - sec <= COINGECKO_KEYLESS_WINDOW_SEC) {
        usd = await fetchCoinGeckoDay(sec, opts);
      } else {
        tooOldDays++;
        usd = null;
      }
    }

    for (const sec of secs) result.set(sec, usd);
  }

  if (tooOldDays > 0) {
    opts.onWarn?.(
      `${tooOldDays} day(s) predate keyless price coverage (~2 years via Kraken) — ` +
      `usd_value left empty for those rows`
    );
  }

  return result;
}
