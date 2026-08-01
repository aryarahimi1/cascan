/**
 * src/prices.js
 *
 * BCH/USD price from CoinGecko's free public API. 60s in-memory cache,
 * freshness metadata in the envelope (ported from glnc's prices.js).
 * No API key; free-tier rate limits are surfaced, never hidden.
 */

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const COIN_ID = 'bitcoin-cash';
const PRICE_TTL_MS = 60 * 1000;

let cache = null; // { usd, cachedAt, rateLimited }

/**
 * Fetch the BCH/USD price.
 *
 * @returns {Promise<{ usd: number|null, meta: {
 *   ok: boolean, provider: 'coingecko', cacheAgeSec: number,
 *   stale: boolean, rateLimited: boolean } }>}
 */
export async function getBchPrice() {
  const now = Date.now();

  if (cache && (now - cache.cachedAt) < PRICE_TTL_MS) {
    return {
      usd: cache.usd,
      meta: {
        ok: true,
        provider: 'coingecko',
        cacheAgeSec: Math.floor((now - cache.cachedAt) / 1000),
        stale: false,
        rateLimited: cache.rateLimited,
      },
    };
  }

  try {
    const url = `${COINGECKO_BASE}/simple/price?ids=${COIN_ID}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      if (cache) {
        cache.rateLimited = true;
        return { usd: cache.usd, meta: staleMeta(now, true) };
      }
      return { usd: null, meta: failMeta(true) };
    }
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);

    const json = await res.json();
    const usd = json?.[COIN_ID]?.usd;
    if (typeof usd !== 'number') throw new Error('CoinGecko: unexpected payload');

    cache = { usd, cachedAt: now, rateLimited: false };
    return {
      usd,
      meta: { ok: true, provider: 'coingecko', cacheAgeSec: 0, stale: false, rateLimited: false },
    };
  } catch {
    if (cache) return { usd: cache.usd, meta: staleMeta(now, cache.rateLimited) };
    return { usd: null, meta: failMeta(false) };
  }
}

function staleMeta(now, rateLimited) {
  return {
    ok: true,
    provider: 'coingecko',
    cacheAgeSec: Math.floor((now - cache.cachedAt) / 1000),
    stale: true,
    rateLimited,
  };
}

function failMeta(rateLimited) {
  return { ok: false, provider: 'coingecko', cacheAgeSec: 0, stale: false, rateLimited };
}
