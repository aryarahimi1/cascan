/**
 * src/cli/args.js
 *
 * Minimal argument parser — no external dependencies.
 * Lineage: ported from glnc's src/cli/args.js (same zero-dep philosophy).
 *
 * Commands: balance, tx, watch, gas, addr, schema, tokens, campaign,
 *           history, alert, interactive
 */

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
    this.exitCode = 1;
  }
}

const QUORUM_MODES = new Set(['any', 'majority', 'all']);
const NETWORKS = new Set(['mainnet', 'chipnet', 'testnet4']);
const COMMANDS = new Set(['balance', 'tx', 'watch', 'gas', 'addr', 'schema', 'tokens', 'campaign', 'history', 'alert', 'interactive', 'servers']);
const COST_BASIS_METHODS = new Set(['fifo', 'none']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {string[]} argv - process.argv.slice(2)
 */
export function parseArgs(argv) {
  const raw = [...argv];

  const out = {
    command: null,
    target: null,          // address or txid (or schema id)
    json: false,
    ndjson: false,
    quorum: 'majority',
    interval: 15,
    intervalSet: false,    // true when --interval was passed explicitly
    webhook: null,
    zeroConf: false,
    once: false,
    strict: false,
    verbose: false,
    noColor: false,
    raw: false,
    network: 'mainnet',    // --network mainnet|chipnet|testnet4 (--chipnet shorthand)
    server: null,          // host:port override → single-server mode
    watch: false,          // campaign: live event stream (default one-shot)
    goal: null,            // campaign: BCH goal string
    condition: null,       // alert: --if "<lhs> <op> <number>"
    dryRun: false,         // alert: evaluate without firing the webhook
    costBasis: 'none',     // history: 'fifo' | 'none'
    from: null,            // history: YYYY-MM-DD inclusive
    to: null,              // history: YYYY-MM-DD inclusive
    out: null,             // history: CSV file path (default stdout)
    noPrices: false,       // history: skip historical USD price lookups
    help: false,
    version: false,
    rawArgs: raw,
  };

  while (raw.length > 0) {
    const tok = raw.shift();

    if (tok === '--json') { out.json = true; continue; }
    if (tok === '--ndjson') { out.ndjson = true; out.json = true; continue; }
    if (tok === '--strict') { out.strict = true; continue; }
    if (tok === '--verbose' || tok === '-v') { out.verbose = true; continue; }
    if (tok === '--no-color') { out.noColor = true; continue; }
    if (tok === '--0conf') { out.zeroConf = true; continue; }
    if (tok === '--once') { out.once = true; continue; }
    if (tok === '--raw') { out.raw = true; continue; }
    if (tok === '--watch' || tok === '-w') { out.watch = true; continue; }
    if (tok === '--dry-run') { out.dryRun = true; continue; }
    if (tok === '--chipnet') { out.network = 'chipnet'; continue; }
    if (tok === '--network') {
      const v = raw.shift();
      if (!v || !NETWORKS.has(v)) {
        throw new ParseError(`--network must be one of: ${[...NETWORKS].join(', ')} (got: ${JSON.stringify(v)})`);
      }
      out.network = v;
      continue;
    }
    if (tok === '--no-prices') { out.noPrices = true; continue; }
    if (tok === '--help' || tok === '-h') { out.help = true; continue; }
    if (tok === '--version') { out.version = true; continue; }

    if (tok === '--if') {
      const v = raw.shift();
      if (!v) throw new ParseError('--if requires a condition string (e.g. --if "balance < 0.5")');
      out.condition = v;
      continue;
    }
    if (tok === '--cost-basis') {
      const v = raw.shift();
      if (!v || !COST_BASIS_METHODS.has(v)) {
        throw new ParseError(`--cost-basis must be one of: fifo, none (got: ${JSON.stringify(v)})`);
      }
      out.costBasis = v;
      continue;
    }
    if (tok === '--from' || tok === '--to') {
      const v = raw.shift();
      if (!v || !DATE_RE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
        throw new ParseError(`${tok} expects a date as YYYY-MM-DD (got: ${JSON.stringify(v)})`);
      }
      out[tok === '--from' ? 'from' : 'to'] = v;
      continue;
    }
    if (tok === '--out') {
      const v = raw.shift();
      if (!v) throw new ParseError('--out requires a file path');
      out.out = v;
      continue;
    }

    if (tok === '--goal') {
      const v = raw.shift();
      if (!v) throw new ParseError('--goal requires a BCH amount (e.g. --goal 100)');
      out.goal = v;
      continue;
    }

    if (tok === '--quorum') {
      const v = raw.shift();
      if (!v || !QUORUM_MODES.has(v)) {
        throw new ParseError(`--quorum must be one of: any, majority, all (got: ${JSON.stringify(v)})`);
      }
      out.quorum = v;
      continue;
    }
    if (tok === '--interval') {
      const v = Number.parseInt(raw.shift(), 10);
      if (!Number.isFinite(v) || v < 5) {
        throw new ParseError('--interval must be an integer ≥ 5 seconds');
      }
      out.interval = v;
      out.intervalSet = true;
      continue;
    }
    if (tok === '--webhook') {
      const v = raw.shift();
      if (!v) throw new ParseError('--webhook requires a URL');
      out.webhook = v;
      continue;
    }
    if (tok === '--server') {
      const v = raw.shift();
      if (!v || !/^[^:]+:\d+$/.test(v)) {
        throw new ParseError('--server expects host:port (e.g. electrum.imaginary.cash:50002)');
      }
      out.server = v;
      continue;
    }
    if (tok.startsWith('--')) {
      throw new ParseError(`unknown flag: ${tok}`);
    }

    // First positional = command, second = target
    if (out.command === null) {
      const cmd = tok.toLowerCase();
      if (!COMMANDS.has(cmd)) {
        throw new ParseError(`unknown command: ${tok} (expected: ${[...COMMANDS].join(', ')})`);
      }
      out.command = cmd;
      continue;
    }
    if (out.target === null) {
      out.target = tok;
      continue;
    }
    throw new ParseError(`unexpected extra argument: ${tok}`);
  }

  if (out.help || out.version) return out;

  if (out.command === null) {
    throw new ParseError('no command given — try cascan --help');
  }

  // Command/target validation
  if (['balance', 'tx', 'watch', 'addr', 'tokens', 'campaign', 'history', 'alert'].includes(out.command) && out.target === null) {
    throw new ParseError(`cascan ${out.command} requires an argument`);
  }
  if ((out.command === 'interactive' || out.command === 'servers') && out.target !== null) {
    throw new ParseError(`cascan ${out.command} takes no arguments (got: ${out.target})`);
  }
  if (out.raw && out.command !== 'tx') {
    throw new ParseError(`--raw is only supported on the 'tx' command`);
  }
  if (out.zeroConf && out.command !== 'watch') {
    throw new ParseError(`--0conf is only meaningful on the 'watch' command`);
  }
  if (out.webhook && !['watch', 'campaign', 'alert'].includes(out.command)) {
    throw new ParseError(`--webhook is only supported on the 'watch', 'campaign', and 'alert' commands`);
  }
  if (out.goal != null && out.command !== 'campaign') {
    throw new ParseError(`--goal is only supported on the 'campaign' command`);
  }
  if (out.watch && out.command !== 'campaign') {
    throw new ParseError(`--watch is only supported on the 'campaign' command (the 'watch' command is always live)`);
  }
  if (out.command === 'campaign' && out.webhook && !out.watch) {
    throw new ParseError(`--webhook on 'campaign' requires --watch (one-shot campaign has no events to send)`);
  }
  if (out.once && out.command !== 'watch' && out.command !== 'alert') {
    throw new ParseError(`--once is only supported on the 'watch' and 'alert' commands`);
  }

  // alert
  if (out.condition != null && out.command !== 'alert') {
    throw new ParseError(`--if is only supported on the 'alert' command`);
  }
  if (out.dryRun && out.command !== 'alert') {
    throw new ParseError(`--dry-run is only supported on the 'alert' command`);
  }
  if (out.command === 'alert') {
    if (out.condition == null) {
      throw new ParseError(`cascan alert requires --if "<condition>" (e.g. --if "balance < 0.5")`);
    }
    if (!out.webhook && !out.dryRun) {
      throw new ParseError(`cascan alert requires --webhook <url> (or --dry-run to evaluate without firing)`);
    }
    if (!out.intervalSet) out.interval = 60; // alerts poll gently by default
  }

  // history
  for (const [flag, val] of [['--cost-basis', out.costBasis !== 'none'], ['--from', out.from != null], ['--to', out.to != null], ['--out', out.out != null], ['--no-prices', out.noPrices]]) {
    if (val && out.command !== 'history') {
      throw new ParseError(`${flag} is only supported on the 'history' command`);
    }
  }
  if (out.from && out.to && out.from > out.to) {
    throw new ParseError(`--from (${out.from}) must not be after --to (${out.to})`);
  }

  return out;
}
