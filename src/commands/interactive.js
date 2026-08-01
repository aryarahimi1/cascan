/**
 * src/commands/interactive.js
 *
 * cascan interactive — arrow-key REPL over the same engine the flag CLI
 * uses. Every flow builds the exact `parsed` object the argument parser
 * would have produced and hands it to the shared dispatcher, so the REPL
 * can never behave differently from the scriptable surface.
 *
 * Lineage: ported from glnc's src/cli/interactive.js, re-themed and
 * re-flowed for the BCH command set.
 */

import { dispatchCommand } from '../cli/run.js';
import { box, select, input, CancelledError } from '../cli/prompts.js';
import { bold, dim, cyan, gray, red, yellow } from '../cli/theme.js';

const YES_NO = [
  { value: false, label: 'No',  icon: '·' },
  { value: true,  label: 'Yes', icon: '✓' },
];

const QUORUM_CHOICES = [
  { value: 'majority', icon: '◐', label: 'majority', description: 'fan out, plurality wins, dissent surfaced' },
  { value: 'any',      icon: '·', label: 'any',      description: 'first server to answer (fastest)' },
  { value: 'all',      icon: '●', label: 'all',      description: 'unanimous or exit 3 (paranoid mode)' },
];

const OUTPUT_MODES = [
  { value: 'pretty', icon: '◐', label: 'Pretty',  description: 'Human terminal UI (default)' },
  { value: 'json',   icon: '◍', label: 'JSON',    description: 'One envelope per command' },
  { value: 'ndjson', icon: '◎', label: 'NDJSON',  description: 'One envelope per line (live streams)' },
];

/** Session output mode → parsed-object flags. NDJSON implies JSON, like the CLI. */
function outputFlags(mode) {
  if (mode === 'ndjson') return { json: true, ndjson: true };
  if (mode === 'json') return { json: true };
  return {};
}

/** A full parsed-shaped object with the same defaults as src/cli/args.js. */
function baseParsed(command, target, session, extra = {}) {
  return {
    command, target,
    json: false, ndjson: false, network: session.network ?? 'mainnet',
    quorum: 'majority', interval: command === 'alert' ? 60 : 15, intervalSet: false,
    webhook: null, zeroConf: false, once: false, strict: false,
    verbose: false, noColor: false, raw: false, server: null,
    watch: false, goal: null,
    condition: null, dryRun: false,
    costBasis: 'none', from: null, to: null, out: null, noPrices: false,
    help: false, version: false, rawArgs: [],
    ...outputFlags(session.outputMode),
    ...extra,
  };
}

const EXAMPLE_ADDR = 'bitcoincash:qq1234…';

async function askAddress(session, message = 'Address') {
  const address = await input({
    message,
    placeholder: session.lastAddress || EXAMPLE_ADDR,
    acceptPlaceholder: Boolean(session.lastAddress),
    required: true,
  });
  const trimmed = address.trim();
  session.lastAddress = trimmed;
  return trimmed;
}

async function askQuorum() {
  return select({ message: 'Quorum policy?', choices: QUORUM_CHOICES });
}

// ---------------------------------------------------------------------------
// Flows — each returns a parsed object for dispatch
// ---------------------------------------------------------------------------

async function balanceFlow(session) {
  const target = await askAddress(session);
  const quorum = await askQuorum();
  return baseParsed('balance', target, session, { quorum });
}

async function txFlow(session) {
  const target = (await input({ message: 'Transaction id', placeholder: '64-hex txid', required: true })).trim();
  const quorum = await askQuorum();
  return baseParsed('tx', target, session, { quorum });
}

async function watchFlow(session) {
  const target = await askAddress(session, 'Address to watch');
  const zeroConf = await select({
    message: 'Treat 0-conf (mempool) payments as payable events?',
    hint: 'BCH instant payments — opt-in',
    choices: YES_NO,
  });
  const webhook = (await input({
    message: 'Webhook URL (empty = terminal only)',
    placeholder: 'https://example.com/hook',
  })).trim() || null;
  return baseParsed('watch', target, session, { zeroConf, webhook });
}

async function tokensFlow(session) {
  const target = (await input({ message: 'Token category', placeholder: '64-hex category id', required: true })).trim();
  return baseParsed('tokens', target, session);
}

async function campaignFlow(session) {
  const target = await askAddress(session, 'Fundraiser address');
  const goal = (await input({ message: 'Goal in BCH (empty = no goal)', placeholder: '100' })).trim() || null;
  const live = await select({ message: 'Live progress stream?', choices: YES_NO });
  let webhook = null;
  if (live) {
    webhook = (await input({
      message: 'Webhook URL (empty = terminal only)',
      placeholder: 'https://example.com/hook',
    })).trim() || null;
  }
  return baseParsed('campaign', target, session, { goal, watch: live, webhook });
}

async function gasFlow(session) {
  return baseParsed('gas', null, session);
}

async function serversFlow(session) {
  return baseParsed('servers', null, session);
}

async function addrFlow(session) {
  const target = await askAddress(session, 'Address (cashaddr or legacy)');
  return baseParsed('addr', target, session);
}

async function historyFlow(session) {
  const target = await askAddress(session);

  const range = await select({
    message: 'Date range?',
    choices: [
      { value: 'all', icon: '·', label: 'Everything',     description: 'Full confirmed history' },
      { value: '365', icon: '·', label: 'Last 12 months', description: 'Fits a tax year' },
      { value: 'ytd', icon: '·', label: 'Year-to-date',   description: 'From Jan 1 (UTC)' },
      { value: 'custom', icon: '·', label: 'Custom dates', description: 'Enter --from / --to' },
    ],
  });

  const today = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  let from = null, to = null;
  if (range === '365') { from = ymd(new Date(today.getTime() - 365 * 86400_000)); to = ymd(today); }
  else if (range === 'ytd') { from = `${today.getUTCFullYear()}-01-01`; to = ymd(today); }
  else if (range === 'custom') {
    from = (await input({ message: 'From (YYYY-MM-DD, empty = beginning)', placeholder: '2025-01-01' })).trim() || null;
    to = (await input({ message: 'To (YYYY-MM-DD, empty = today)', placeholder: ymd(today) })).trim() || null;
  }

  const prices = await select({
    message: 'Fetch historical USD prices?',
    hint: 'CoinGecko free tier — ~0.6s per distinct day',
    choices: [
      { value: true,  icon: '✓', label: 'Yes', description: 'Recommended — lights up usd_value' },
      { value: false, icon: '·', label: 'No',  description: 'Much faster, USD columns stay empty' },
    ],
  });

  let costBasis = 'none';
  if (prices) {
    const fifo = await select({
      message: 'Compute FIFO cost basis (tax export)?',
      choices: YES_NO,
    });
    costBasis = fifo ? 'fifo' : 'none';
  }

  const dest = await select({
    message: 'Where should the CSV go?',
    choices: [
      { value: 'stdout', icon: '·', label: 'Print to terminal', description: 'Pipe-friendly' },
      { value: 'file',   icon: '✓', label: 'Write to file',     description: 'cascan-history-<date>.csv or custom' },
    ],
  });
  let out = null;
  if (dest === 'file') {
    const suggested = `cascan-history-${ymd(today)}.csv`;
    out = (await input({ message: 'File path', placeholder: suggested, acceptPlaceholder: true })).trim() || suggested;
  }

  return baseParsed('history', target, session, { from, to, noPrices: !prices, costBasis, out });
}

async function alertFlow(session) {
  const target = await askAddress(session, 'Address to monitor');

  const condition = (await input({
    message: 'Condition',
    hint: 'balance[.sats|.usd] or unconfirmed[.sats] — e.g. "balance.usd > 1000"',
    placeholder: 'balance < 0.5',
    acceptPlaceholder: true,
    required: true,
  })).trim();

  const dryRun = await select({
    message: 'Dry-run (evaluate without firing the webhook)?',
    hint: 'recommended for the first run',
    choices: YES_NO,
    initial: 1,
  });

  let webhook = null;
  if (!dryRun) {
    webhook = (await input({
      message: 'Webhook URL',
      placeholder: 'https://example.com/hook',
      required: true,
    })).trim();
  }

  const once = await select({
    message: 'Run once or keep polling?',
    choices: [
      { value: false, label: 'Loop', icon: '↻', description: 'Poll on interval until Ctrl+C' },
      { value: true,  label: 'Once', icon: '·', description: 'Evaluate one time, back to menu' },
    ],
  });

  let interval = 60;
  if (!once) {
    const raw = (await input({ message: 'Polling interval (seconds, ≥ 5)', placeholder: '60', initial: '60' })).trim();
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 5) interval = n;
  }

  const quorum = await askQuorum();
  return baseParsed('alert', target, session, { condition, dryRun, webhook, once, interval, quorum });
}

// ---------------------------------------------------------------------------
// Banner + loop
// ---------------------------------------------------------------------------

function printBanner(version) {
  const rows = [
    bold(cyan('◈ cascan')) + dim('  — verify, don\'t trust: BCH in your terminal'),
    '',
    dim('  every figure quorum-checkable across independent Fulcrum servers'),
    dim('  no accounts · no API keys · no tracking · no dependencies'),
    '',
    gray('  ↑/↓ move · Enter select · Esc back · Ctrl+C quit'),
  ];
  console.log('');
  console.log(box(rows, { title: 'cascan v' + version, paddingX: 2 }));
  console.log('');
}

function printSeparator() {
  const w = Math.min((process.stdout.columns || 80) - 4, 60);
  const label = ' ◈ ';
  const sideLen = Math.max(0, Math.floor((w - label.length) / 2));
  console.log('\n  ' + gray('╌'.repeat(sideLen) + label + '╌'.repeat(sideLen)));
}

const FLOWS = {
  balance: balanceFlow,
  watch: watchFlow,
  tx: txFlow,
  tokens: tokensFlow,
  campaign: campaignFlow,
  history: historyFlow,
  alert: alertFlow,
  servers: serversFlow,
  gas: gasFlow,
  addr: addrFlow,
};

/**
 * Run the REPL until the user quits.
 * @param {string} version
 * @returns {Promise<{ exitCode: number }>}
 */
export async function cmdInteractive(version) {
  if (!process.stdin.isTTY) {
    process.stderr.write(red('Error: interactive mode requires a TTY (stdin must be a terminal).\n'));
    return { exitCode: 1 };
  }

  printBanner(version);

  const session = { outputMode: 'pretty', lastAddress: null };

  while (true) {
    let action;
    try {
      action = await select({
        message: `What would you like to do?  ${dim('[output: ' + session.outputMode + ']')}`,
        hint: '↑/↓ move · Enter select · q quit · Ctrl+C exit',
        choices: [
          { value: 'balance',  label: 'Check balance',      icon: '◈', description: 'BCH + CashTokens, quorum-checked' },
          { value: 'watch',    label: 'Watch payments',     icon: '⚡', description: '0-conf payment stream, optional webhook' },
          { value: 'tx',       label: 'Inspect transaction', icon: '⟳', description: 'Decode a tx by id' },
          { value: 'tokens',   label: 'Token card',         icon: '◇', description: 'CashToken metadata (BCMR)' },
          { value: 'campaign', label: 'Track fundraiser',   icon: '♥', description: 'Flipstarter-style progress, live or one-shot' },
          { value: 'history',  label: 'History → CSV',      icon: '▤', description: 'Full ledger export, optional FIFO cost basis' },
          { value: 'alert',    label: 'Set up alert',       icon: '◉', description: 'Fire a webhook when a balance condition turns true' },
          { value: 'servers',  label: 'Fleet health',       icon: '⚑', description: 'Discover + probe the public Fulcrum fleet' },
          { value: 'gas',      label: 'Fee estimates',      icon: '⛽', description: 'Current network fee levels' },
          { value: 'addr',     label: 'Address tools',      icon: '⇄', description: 'Convert / validate / inspect (offline)' },
          { value: 'output',   label: 'Output mode',        icon: '◍', description: 'pretty / JSON / NDJSON for this session' },
          { value: 'quit',     label: 'Quit',               icon: '←', description: 'Exit interactive mode' },
        ],
      });
    } catch (err) {
      if (err instanceof CancelledError) {
        console.log('\n' + dim('  Goodbye.'));
        return { exitCode: 0 };
      }
      throw err;
    }

    if (action === 'quit') {
      console.log('\n' + dim('  Goodbye.'));
      return { exitCode: 0 };
    }

    try {
      if (action === 'output') {
        session.outputMode = await select({
          message: `Output mode (current: ${session.outputMode})`,
          choices: OUTPUT_MODES,
        });
        console.log(dim(`  output mode → ${session.outputMode}`));
      } else {
        const parsed = await FLOWS[action](session);
        console.log('');
        const code = await dispatchCommand(parsed);
        if (code !== 0) {
          process.stderr.write(yellow(`  (command finished with exit code ${code})\n`));
        }
      }
    } catch (err) {
      if (err instanceof CancelledError) {
        console.log(dim('  cancelled — back to menu'));
      } else {
        process.stderr.write(red(`Error: ${err?.message ?? err}\n`));
      }
    }

    printSeparator();
  }
}
