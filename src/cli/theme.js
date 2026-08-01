/**
 * src/cli/theme.js
 *
 * All ANSI styling in one place. Disabled by --no-color, NO_COLOR env,
 * non-TTY stdout, or --json/--ndjson mode.
 */

let colorsEnabled = true;

export function initTheme({ noColor = false, jsonMode = false } = {}) {
  colorsEnabled =
    !noColor &&
    !jsonMode &&
    process.env.NO_COLOR === undefined &&
    Boolean(process.stdout.isTTY);
}

function wrap(code, reset, s) {
  const str = String(s);
  return colorsEnabled ? `[${code}m${str}[${reset}m` : str;
}

export const bold    = (s) => wrap(1, 22, s);
export const dim     = (s) => wrap(2, 22, s);
export const red     = (s) => wrap(31, 39, s);
export const green   = (s) => wrap(32, 39, s);
export const yellow  = (s) => wrap(33, 39, s);
export const cyan    = (s) => wrap(36, 39, s);
export const gray    = (s) => wrap(90, 39, s);

export const okMark  = () => colorsEnabled ? '[32m✓[39m' : '✓';
export const badMark = () => colorsEnabled ? '[31m✗[39m' : '✗';
