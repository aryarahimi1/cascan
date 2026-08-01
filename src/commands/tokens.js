/**
 * src/commands/tokens.js
 *
 * cascan tokens <category> — CashToken category card from the BCMR
 * (issuer-published metadata). Honest framing: this is what the minter
 * claims the token is, signed via their authchain — not consensus truth.
 */

import { isValidCategory } from '../tokens/aggregate.js';
import { getTokenMeta } from '../tokens/bcmr.js';
import { SCHEMA } from '../output/schemas.js';
import { wrap } from '../output/envelope.js';
import { renderTokenCard } from '../cli/render.js';

export async function cmdTokens(parsed) {
  const category = parsed.target.toLowerCase();
  if (!isValidCategory(category)) {
    const err = new Error(`not a token category: ${parsed.target} (expected 64 hex chars)`);
    err.exitCode = 1;
    throw err;
  }

  const r = await getTokenMeta(category);

  const data = {
    category,
    found: r.found,
    metadata: r.meta,
    // Explicit honesty marker: BCMR is a registry of issuer claims.
    metadataNature: 'issuer-published (authchain-signed), not consensus',
  };

  const meta = {
    sources: {
      bcmr: { ok: r.ok, provider: 'paytaca', ...(r.error ? { error: r.error } : {}) },
    },
    partial: !r.ok,
    warnings: r.ok ? [] : [`BCMR lookup failed: ${r.error}`],
  };

  const human = renderTokenCard(category, r);
  return { envelope: wrap(SCHEMA.TOKENS, data, meta), human, meta };
}
