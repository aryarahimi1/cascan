/**
 * src/commands/schema.js
 *
 * cascan schema [<id>] — list stable schema ids, or print one.
 * Useful for scripts that need to validate the stream they consume.
 */

import { ALL_SCHEMAS } from '../output/schemas.js';

export async function cmdSchema(parsed) {
  if (parsed.target == null) {
    return { human: ALL_SCHEMAS.map(s => `  ${s}`).join('\n'), envelope: null, meta: { partial: false } };
  }
  const want = parsed.target.startsWith('cascan.') ? parsed.target : `cascan.${parsed.target}/v1`;
  const found = ALL_SCHEMAS.find(s => s === want);
  if (!found) {
    const err = new Error(`unknown schema: ${parsed.target} — run 'cascan schema' to list all`);
    err.exitCode = 1;
    throw err;
  }
  return { human: `  ${found}`, envelope: null, meta: { partial: false } };
}
