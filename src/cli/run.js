/**
 * src/cli/run.js
 *
 * Single command dispatcher shared by bin/cascan.js and the interactive
 * REPL — one switch, one emission path, so the two entry points can never
 * drift apart. Errors propagate to the caller (the bin maps them to exit
 * codes; the REPL renders them and returns to the menu).
 */

import { emitJSON } from '../output/emit.js';
import { gray } from './theme.js';

import { cmdBalance } from '../commands/balance.js';
import { cmdTx } from '../commands/tx.js';
import { cmdWatch } from '../commands/watch.js';
import { cmdGas } from '../commands/gas.js';
import { cmdAddr } from '../commands/addr.js';
import { cmdSchema } from '../commands/schema.js';
import { cmdTokens } from '../commands/tokens.js';
import { cmdCampaign } from '../commands/campaign.js';
import { cmdHistory } from '../commands/history.js';
import { cmdAlert } from '../commands/alert.js';
import { cmdServers } from '../commands/servers.js';

/**
 * Run one parsed command and emit its output.
 *
 * @param {ReturnType<import('./args.js').parseArgs>} parsed
 * @returns {Promise<number>} exit code
 */
export async function dispatchCommand(parsed) {
  let result;
  switch (parsed.command) {
    case 'balance': result = await cmdBalance(parsed); break;
    case 'tx':      result = await cmdTx(parsed);      break;
    case 'watch':   return (await cmdWatch(parsed)).exitCode;
    case 'gas':     result = await cmdGas(parsed);     break;
    case 'addr':    result = await cmdAddr(parsed);    break;
    case 'tokens':  result = await cmdTokens(parsed);  break;
    case 'schema':  result = await cmdSchema(parsed);  break;
    case 'history': return (await cmdHistory(parsed)).exitCode;
    case 'alert':   return (await cmdAlert(parsed)).exitCode;
    case 'servers': result = await cmdServers(parsed); break;
    case 'campaign': {
      const r = await cmdCampaign(parsed);
      if (r.exitCode !== undefined) return r.exitCode; // live --watch mode
      result = r;
      break;
    }
    default:
      throw new Error(`unknown command: ${parsed.command}`);
  }

  if (parsed.json && result.envelope) {
    emitJSON(result.envelope);
  } else if (result.human) {
    process.stdout.write(result.human + '\n');
    for (const w of result.meta?.warnings ?? []) {
      process.stderr.write(gray(`! ${w}\n`));
    }
  }

  if (parsed.strict && result.meta?.partial) return 3;
  return 0;
}
