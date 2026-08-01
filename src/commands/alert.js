/**
 * src/commands/alert.js
 *
 * cascan alert <address> --if "<condition>" --webhook <url>
 *
 * Polls a quorum-checked balance on an interval, evaluates the condition
 * DSL, and POSTs the envelope to the webhook on the false→true edge.
 * State (~/.cascan/alerts.json) dedupes across polls AND across process
 * restarts: while the condition stays true no repeat fire happens; when it
 * goes false the alert re-arms.
 *
 * Events (NDJSON with --json, human lines otherwise):
 *   evaluated — one per poll: lhs value, condition result, outcome
 *   error     — non-fatal iteration failure (loop continues)
 *   stop      — Ctrl+C teardown
 *
 * Outcomes: fired | deduped | not-fired | fire-failed | dry-run
 *
 * Lineage: ported from glnc's src/alert/index.js, re-plumbed onto the
 * Fulcrum quorum layer (glnc polls one RPC; cascan keeps its quorum posture).
 */

import { parseAddress } from '../address.js';
import { queryQuorum, fulcrumMeta } from '../fulcrum/quorum.js';
import { serverOverride } from '../fulcrum/servers.js';
import { getBchPrice } from '../prices.js';
import { parseCondition, evaluateCondition, buildContext } from '../alert/conditions.js';
import { readAlertState, writeAlertState } from '../alert/state.js';
import { postWebhook, validateWebhookUrl } from './webhook.js';
import { SCHEMA } from '../output/schemas.js';
import { wrapEvent } from '../output/envelope.js';
import { emitNDJSON } from '../output/emit.js';
import { shortenCashaddr } from '../cli/render.js';
import { gray, red, green, bold, cyan } from '../cli/theme.js';

class AlertUsageError extends Error {
  constructor(message) { super(message); this.exitCode = 1; }
}

/** One poll: fetch → evaluate → maybe fire. Throws on fetch failure. */
async function runIteration(rec, parsedCondition, parsed, pollIndex) {
  const servers = serverOverride(parsed.server) ?? undefined;

  const qr = await queryQuorum('blockchain.address.get_balance', [rec.cashaddr], {
    mode: parsed.quorum,
    minAgreement: parsed.webhook && !parsed.dryRun ? 2 : 1,
    servers,
    network: parsed.network,
  });

  let price = { usd: null, meta: null };
  if (parsedCondition.needsPrice) {
    price = await getBchPrice();
  }

  const ctx = buildContext(qr.value, price.usd);
  const evalResult = evaluateCondition(parsedCondition, ctx);
  const ts = new Date().toISOString();

  const meta = {
    sources: {
      fulcrum: fulcrumMeta(qr),
      ...(price.meta ? { prices: price.meta } : {}),
    },
    partial: qr.partial || (parsedCondition.needsPrice && price.usd == null),
    warnings: [...rec.warnings],
  };

  const baseData = {
    poll: pollIndex,
    address: rec.cashaddr,
    condition: parsed.condition,
    lhsValue: evalResult.lhsValue,
    conditionTrue: evalResult.ok,
    balance: {
      confirmedSats: String(qr.value?.confirmed ?? 0),
      unconfirmedSats: String(qr.value?.unconfirmed ?? 0),
    },
    ...(parsedCondition.needsPrice ? { bchUsd: price.usd } : {}),
  };

  // Dry-run: report and skip webhook + state entirely.
  if (parsed.dryRun) {
    return {
      env: wrapEvent(SCHEMA.ALERT, 'evaluated', { data: { ...baseData, dryRun: true, outcome: 'dry-run', fired: false }, meta }),
      humanOutcome: gray('[dry-run]'),
      ts,
      evalResult,
    };
  }

  const alertKey = `${rec.cashaddr}:${parsed.condition}`;
  const prevState = await readAlertState(alertKey);
  const shouldFire = evalResult.ok && (prevState === null || !prevState.lastConditionResult);

  let outcome = 'not-fired';
  let httpStatus = null;
  let webhookError = null;
  let humanOutcome = gray('not-fired');

  if (evalResult.ok && prevState?.lastConditionResult === true) {
    outcome = 'deduped';
    humanOutcome = gray('skipped (already fired; re-arms when condition goes false)');
  } else if (shouldFire) {
    const payload = wrapEvent(SCHEMA.ALERT, 'fired', { data: { ...baseData, evaluatedAt: ts }, meta });
    try {
      await postWebhook(parsed.webhook, payload);
      await writeAlertState(alertKey, { lastFiredAt: Date.now(), lastConditionResult: true });
      outcome = 'fired';
      httpStatus = 200; // postWebhook throws on any !ok status
      humanOutcome = green('fired');
    } catch (err) {
      outcome = 'fire-failed';
      webhookError = err.message;
      humanOutcome = red(`fire-failed: ${err.message}`);
    }
  } else if (!evalResult.ok) {
    // Condition false — re-arm.
    await writeAlertState(alertKey, {
      lastFiredAt: prevState?.lastFiredAt ?? 0,
      lastConditionResult: false,
    });
  }

  return {
    env: wrapEvent(SCHEMA.ALERT, 'evaluated', {
      data: { ...baseData, dryRun: false, outcome, httpStatus, webhookError, fired: outcome === 'fired' },
      meta,
    }),
    humanOutcome,
    ts,
    evalResult,
  };
}

export async function cmdAlert(parsed) {
  // Fail fast, before any I/O: address, condition, webhook URL.
  const rec = parseAddress(parsed.target, { network: parsed.network });

  let parsedCondition;
  try {
    parsedCondition = parseCondition(parsed.condition);
  } catch (err) {
    throw new AlertUsageError(err.message);
  }
  if (parsed.webhook) {
    validateWebhookUrl(parsed.webhook); // throws with a descriptive message
  }

  const emitLine = (r) => {
    if (parsed.json) {
      emitNDJSON(r.env);
    } else {
      const status = r.evalResult.ok ? green('TRUE ') : red('FALSE');
      process.stdout.write(
        `${gray(r.ts)}  ${bold(shortenCashaddr(rec.cashaddr))}  ` +
        `${cyan(parsed.condition)}  lhs=${r.evalResult.lhsValue ?? 'null'}  ${status}  ${r.humanOutcome}\n`
      );
    }
  };

  let pollIndex = 0;

  if (parsed.once) {
    const r = await runIteration(rec, parsedCondition, parsed, pollIndex);
    emitLine(r);
    return { exitCode: 0 };
  }

  if (!parsed.json) {
    process.stderr.write(gray(
      `  alert armed: ${shortenCashaddr(rec.cashaddr)} — "${parsed.condition}" every ${parsed.interval}s` +
      `${parsed.dryRun ? ' [dry-run]' : ''} — Ctrl+C to stop\n`
    ));
  }

  let stopped = false;
  const sigintHandler = () => { stopped = true; };
  process.on('SIGINT', sigintHandler);

  try {
    while (!stopped) {
      try {
        const r = await runIteration(rec, parsedCondition, parsed, pollIndex++);
        emitLine(r);
      } catch (err) {
        // Never crash the loop — a server blip must not kill a standing alert.
        if (parsed.json) {
          emitNDJSON(wrapEvent(SCHEMA.ALERT, 'error', {
            ok: false,
            error: { code: err?.code ?? 'iteration-error', message: err?.message ?? String(err) },
          }));
        } else {
          process.stderr.write(red(`! poll failed: ${err?.message ?? err}\n`));
        }
      }

      // Wait interval seconds, polling for SIGINT every 100ms.
      const deadline = Date.now() + parsed.interval * 1000;
      while (Date.now() < deadline && !stopped) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    if (parsed.json) {
      emitNDJSON(wrapEvent(SCHEMA.ALERT, 'stop', { data: { reason: 'sigint', polls: pollIndex } }));
    } else {
      process.stderr.write(gray('  stopped.\n'));
    }
  }
  return { exitCode: 0 };
}
