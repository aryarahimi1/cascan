/**
 * src/output/emit.js
 *
 * The single chokepoint that writes JSON / NDJSON to stdout. All other
 * console output paths are for human (TTY) rendering; anything routed
 * through here is part of cascan's stable machine API.
 *
 * Single-document mode (`emitJSON`): one envelope, pretty-printed when
 * stdout is a TTY but always single-line when piped so jq parses without
 * `slurp`. Stream mode (`emitNDJSON`): one envelope per line, never pretty.
 *
 * Lineage: ported from glnc's src/output/emit.js.
 */

// Defense-in-depth: if a BigInt ever slips into an envelope, coerce it to a
// decimal string rather than letting JSON.stringify throw and break the
// entire JSON stdout path.
const bigintReplacer = (_k, v) => typeof v === 'bigint' ? v.toString() : v;

/**
 * Emit a single JSON document to stdout, terminated by a newline.
 * @param {object} envelope
 */
export function emitJSON(envelope) {
  const pretty = process.stdout.isTTY ? 2 : 0;
  process.stdout.write(JSON.stringify(envelope, bigintReplacer, pretty) + '\n');
}

/**
 * Emit one NDJSON line to stdout. Always compact, always newline-terminated.
 * @param {object} envelope
 */
export function emitNDJSON(envelope) {
  process.stdout.write(JSON.stringify(envelope, bigintReplacer) + '\n');
}
