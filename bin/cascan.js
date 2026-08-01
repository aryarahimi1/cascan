#!/usr/bin/env node

/**
 * bin/cascan.js
 *
 * cascan — verification-first terminal explorer for Bitcoin Cash.
 * Multi-Fulcrum quorum, 0-conf payment watch, no API keys, no dependencies.
 *
 * Exit codes:
 *   0  success
 *   1  user/input error (bad address, bad flags, unknown command)
 *   2  all Fulcrum servers failed
 *   3  quorum disagreement or partial result under --strict
 */

import { parseArgs, ParseError } from '../src/cli/args.js';
import { initTheme, gray, red } from '../src/cli/theme.js';
import { AddressError } from '../src/address.js';
import { QuorumDisagreementError, AllServersFailedError } from '../src/fulcrum/quorum.js';
import { emitJSON } from '../src/output/emit.js';
import { wrapError } from '../src/output/envelope.js';
import { SCHEMA } from '../src/output/schemas.js';
import { dispatchCommand } from '../src/cli/run.js';
import { cmdInteractive } from '../src/commands/interactive.js';

const VERSION = '0.4.0-beta.1';

const HELP = `
  cascan — verify, don't trust: Bitcoin Cash in your terminal

  Usage:
    cascan balance <address> [--quorum any|majority|all] [--json] [--verbose]
    cascan tx <txid> [--raw] [--quorum ...] [--json]
    cascan watch <address> [--0conf] [--webhook <url>] [--once] [--json]
    cascan history <address> [--from Y-M-D] [--to Y-M-D] [--cost-basis fifo]
                             [--out <file.csv>] [--no-prices] [--json]
    cascan alert <address> --if "<cond>" --webhook <url>
                           [--interval <s>] [--once] [--dry-run] [--json]
    cascan tokens <category-hex>       CashToken metadata card (BCMR)
    cascan campaign <address> [--goal <BCH>] [--watch] [--webhook <url>]
    cascan servers                 fleet health: discovery + probe + scores
    cascan gas [--json]
    cascan addr <address>          (offline: convert/validate/inspect)
    cascan interactive             (arrow-key REPL over every command)
    cascan schema [<id>]
    cascan --version | --help

  Alert conditions: <path> <op> <number> — paths: balance, balance.sats,
    balance.usd, unconfirmed, unconfirmed.sats · ops: < <= > >= == !=
    e.g.  cascan alert bitcoincash:qq... --if "balance.usd > 1000" --webhook https://...

  Address formats: cashaddr (bitcoincash:q... or bare q...) or legacy (1.../3...)
  Flags: --json --ndjson --strict --verbose --no-color --server host:port
         --network mainnet|chipnet|testnet4 (--chipnet shorthand; chipnet is
         where CashScript contract development happens)

  Exit codes: 0 ok · 1 input error · 2 all servers failed · 3 disagreement/strict-partial
`;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.version) {
    process.stdout.write(`cascan ${VERSION}\n`);
    return 0;
  }
  if (parsed.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  initTheme({ noColor: parsed.noColor, jsonMode: parsed.json });

  // --raw is machine output only
  if (parsed.raw) parsed.json = true;

  if (parsed.command === 'interactive') {
    return (await cmdInteractive(VERSION)).exitCode;
  }

  return dispatchCommand(parsed);
}

main().then(
  code => process.exit(code),
  err => {
    const jsonWanted = process.argv.includes('--json') || process.argv.includes('--ndjson');
    const schema = process.argv.includes('tx') && process.argv.includes('--raw') ? SCHEMA.TX_RAW : SCHEMA.BALANCE;

    if (err instanceof ParseError || err instanceof AddressError || err?.exitCode === 1) {
      if (jsonWanted) emitJSON(wrapError(schema, err, { code: 'usage' }));
      else process.stderr.write(red(`Error: ${err.message}\n`));
      process.exit(1);
    }
    if (err instanceof AllServersFailedError) {
      if (jsonWanted) emitJSON(wrapError(schema, err, { code: err.code }));
      else process.stderr.write(red(`Error: ${err.message}\n  ${err.errors.map(e => e.message).join('\n  ')}\n`));
      process.exit(2);
    }
    if (err instanceof QuorumDisagreementError) {
      if (jsonWanted) emitJSON(wrapError(schema, err, { code: err.code, extra: { record: err.record } }));
      else process.stderr.write(red(`Error: ${err.message}\n`));
      process.exit(3);
    }
    if (jsonWanted) emitJSON(wrapError(schema, err));
    else process.stderr.write(red(`Error: ${err?.message ?? err}\n`));
    process.exit(1);
  }
);
