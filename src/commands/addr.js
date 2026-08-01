/**
 * src/commands/addr.js
 *
 * cascan addr <address> — offline address inspection: validate, convert
 * cashaddr ↔ legacy, show type, hash160, locking script, scripthash.
 * No network access.
 */

import { parseAddress } from '../address.js';
import { SCHEMA } from '../output/schemas.js';
import { wrap } from '../output/envelope.js';
import { renderAddressRecord } from '../cli/render.js';

export async function cmdAddr(parsed) {
  const rec = parseAddress(parsed.target, { network: parsed.network });

  const data = {
    input: rec.input,
    cashaddr: rec.cashaddr,
    bare: rec.cashaddr.split(':')[1],
    legacy: rec.legacy,
    type: rec.type,
    hash160: Buffer.from(rec.hash).toString('hex'),
    lockingScript: rec.lockingScript,
    scripthash: rec.scripthash,
    inputFormat: rec.format,
  };

  const meta = { partial: false, warnings: [...rec.warnings] };
  const human = renderAddressRecord(rec);

  return { envelope: wrap(SCHEMA.ADDR, data, meta), human, meta };
}
