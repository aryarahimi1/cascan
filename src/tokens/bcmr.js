/**
 * src/tokens/bcmr.js
 *
 * BCMR (Bitcoin Cash Metadata Registry) client for CashToken metadata.
 * Source: Paytaca's public indexer API (bcmr.paytaca.com) — no API key,
 * same trust model as the rest of cascan, and attributed in meta.sources.
 *
 * Fail-open by design: metadata is cosmetic enrichment. A BCMR outage or
 * an unregistered category must never break a balance query — the raw
 * category id is always shown; meta.sources.bcmr records what happened.
 *
 * Note on trust: BCMR metadata is self-published by token issuers via
 * authchains. cascan displays it as issuer-claimed metadata, not as truth.
 */

const BCMR_BASE = 'https://bcmr.paytaca.com';
const TTL_MS = 10 * 60 * 1000;

const cache = new Map(); // category → { at, result }

/**
 * Fetch issuer-published metadata for a token category.
 *
 * @param {string} category - 64-char hex
 * @returns {Promise<{
 *   ok: boolean,
 *   found: boolean,
 *   meta: {
 *     name: string|null, symbol: string|null, decimals: number|null,
 *     description: string|null, icon: string|null, web: string|null,
 *     isNft: boolean, nftType: string|null,
 *   } | null,
 *   error: string|null,
 * }>}
 */
export async function getTokenMeta(category) {
  const cat = category.toLowerCase();
  const now = Date.now();
  const hit = cache.get(cat);
  if (hit && now - hit.at < TTL_MS) return hit.result;

  let result;
  try {
    const res = await fetch(`${BCMR_BASE}/api/tokens/${cat}/`, {
      headers: { Accept: 'application/json' },
      redirect: 'error', // no silent redirect into a different host's metadata
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) {
      result = { ok: true, found: false, meta: null, error: null };
    } else if (!res.ok) {
      throw new Error(`BCMR HTTP ${res.status}`);
    } else {
      const j = await res.json();
      result = {
        ok: true,
        found: true,
        meta: {
          name: j.name ?? null,
          symbol: j.token?.symbol ?? null,
          decimals: j.token?.decimals ?? null,
          description: j.description ?? null,
          icon: j.uris?.icon ?? null,
          web: j.uris?.web ?? null,
          isNft: Boolean(j.is_nft),
          nftType: j.nft_type ?? null,
        },
        error: null,
      };
    }
  } catch (err) {
    result = { ok: false, found: false, meta: null, error: err?.message ?? String(err) };
  }

  cache.set(cat, { at: now, result });
  return result;
}

/** Cache-aware batch; never throws. */
export async function getTokenMetaBatch(categories, { cap = 25 } = {}) {
  const out = new Map();
  const failures = [];
  const list = categories.slice(0, cap);
  await Promise.all(list.map(async (cat) => {
    const r = await getTokenMeta(cat);
    out.set(cat, r);
    if (!r.ok) failures.push(cat);
  }));
  return {
    map: out,
    capped: categories.length > cap ? categories.length - cap : 0,
    failures,
  };
}
