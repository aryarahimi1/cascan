/**
 * src/commands/balance.js
 *
 * cascan balance <address> — quorum-checked BCH balance.
 */

import { parseAddress } from '../address.js';
import { queryQuorum, fulcrumMeta } from '../fulcrum/quorum.js';
import { serverOverride } from '../fulcrum/servers.js';
import { getBchPrice } from '../prices.js';
import { aggregateTokenUtxos, isValidCategory } from '../tokens/aggregate.js';
import { getTokenMetaBatch } from '../tokens/bcmr.js';
import { parseBchSatoshis, requireBchHeight } from '../validation.js';
import { SCHEMA } from '../output/schemas.js';
import { wrap } from '../output/envelope.js';
import { renderBalance, fmtBch } from '../cli/render.js';

export async function cmdBalance(parsed) {
  const rec = parseAddress(parsed.target, { network: parsed.network });
  const servers = serverOverride(parsed.server) ?? undefined;
  const minAgreement = parsed.server || parsed.quorum === 'any' ? 1 : 2;

  const qr = await queryQuorum('blockchain.address.get_balance', [rec.cashaddr], {
    mode: parsed.quorum,
    minAgreement,
    servers,
    network: parsed.network,
  });
  const heightQr = await queryQuorum('blockchain.headers.subscribe', [], {
    mode: parsed.quorum,
    minAgreement,
    servers,
    network: parsed.network,
  });

  const confirmedSats = parseBchSatoshis(qr.value?.confirmed, {
    field: 'confirmed',
  }).toString();
  const unconfirmedSats = parseBchSatoshis(qr.value?.unconfirmed, {
    allowNegative: true,
    field: 'unconfirmed',
  }).toString();
  const totalSats = (BigInt(confirmedSats) + BigInt(unconfirmedSats)).toString();
  const height = requireBchHeight(heightQr.value?.height);

  // CashTokens: enumerate token UTXOs ('tokens_only' filter), aggregate
  // per category, enrich with issuer-published BCMR metadata.
  // The BCH amount is quorum-checked per --quorum; the token listing runs
  // single-server ('any') and is attributed separately in meta — honest,
  // because it is.
  const warnings = [...rec.warnings];
  let tokens = [];
  let tokensAnswered = null;
  let tokensFailed = false;
  let bcmrFailures = [];
  try {
    const tq = await queryQuorum('blockchain.address.listunspent', [rec.cashaddr, 'tokens_only'], { mode: 'any', servers, network: parsed.network });
    tokensAnswered = tq.answered;
    const categories = aggregateTokenUtxos(tq.value);
    if (categories.length > 0) {
      // Only well-formed category ids reach the BCMR URL path.
      const bcmr = await getTokenMetaBatch(categories.map(c => c.category).filter(isValidCategory));
      bcmrFailures = bcmr.failures;
      if (bcmr.capped > 0) warnings.push(`BCMR enrichment capped at 25 categories (${bcmr.capped} shown without metadata)`);
      tokens = categories.map(c => {
        const m = bcmr.map.get(c.category);
        return {
          ...c,
          symbol: m?.meta?.symbol ?? null,
          name: m?.meta?.name ?? null,
          decimals: m?.meta?.decimals ?? null,
          bcmr: m?.ok ? (m.found ? 'ok' : 'unregistered') : 'unavailable',
        };
      });
    }
  } catch (err) {
    tokensFailed = true;
    warnings.push(`CashTokens listing failed (BCH amount unaffected): ${err.message}`);
  }

  const price = await getBchPrice();
  const usd = price.usd != null ? (Number(totalSats) / 1e8) * price.usd : null;

  const data = {
    address: {
      input: rec.input,
      cashaddr: rec.cashaddr,
      legacy: rec.legacy,
      type: rec.type,
      scripthash: rec.scripthash,
    },
    balance: {
      confirmedSats,
      unconfirmedSats,
      totalSats,
      bch: fmtBch(totalSats),
      usd,
    },
    tokens,
    height,
  };

  const fulcrumBlock = fulcrumMeta(qr);
  fulcrumBlock.tip = fulcrumMeta(heightQr, { height });
  if (tokensAnswered) fulcrumBlock.tokens = { answered: tokensAnswered, categories: tokens.length };

  const meta = {
    sources: {
      fulcrum: fulcrumBlock,
      prices: price.meta,
      ...(tokens.length > 0 ? {
        bcmr: {
          ok: bcmrFailures.length === 0,
          provider: 'paytaca',
          note: 'issuer-published metadata (authchain-signed by minter, not consensus)',
          failures: bcmrFailures,
        },
      } : {}),
    },
    partial: qr.partial || heightQr.partial || !price.meta.ok || tokensFailed,
    warnings,
  };

  const human = renderBalance(
    rec,
    { totalSats, unconfirmedSats, tokens },
    price,
    { answered: qr.answered, agreement: qr.agreement, height, statuses: qr.statuses },
    parsed.verbose
  );

  return { envelope: wrap(SCHEMA.BALANCE, data, meta), human, meta };
}
