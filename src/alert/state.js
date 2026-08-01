/**
 * src/alert/state.js
 *
 * Persist alert "last fired" state to ~/.cascan/alerts.json so looping
 * alerts fire on the false→true edge instead of spamming the webhook on
 * every poll while the condition stays true.
 *
 * Schema: { [alertKey]: { lastFiredAt: number, lastConditionResult: boolean } }
 * alertKey format: `${cashaddr}:${conditionString}`
 *
 * Lineage: ported from glnc's src/alert/state.js (atomic tmp+rename write,
 * single-slot in-process mutex).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ALERTS_PATH = join(homedir(), '.cascan', 'alerts.json');

// Single-slot mutex for in-process read-modify-write on the alerts file.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

/** Read raw alerts file; returns {} on any error. */
async function readRaw() {
  try {
    const text = await readFile(ALERTS_PATH, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Write object to alerts file atomically. Never throws. */
async function writeRaw(data) {
  try {
    await mkdir(dirname(ALERTS_PATH), { recursive: true });
    // Stage to a per-pid tmp then rename so concurrent `cascan alert` runs
    // across terminals don't corrupt the JSON file.
    const tmp = `${ALERTS_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, ALERTS_PATH);
  } catch {
    // Non-fatal — alerting still works, dedupe degrades to per-process.
  }
}

/**
 * @typedef {{ lastFiredAt: number, lastConditionResult: boolean }} AlertState
 */

/**
 * Read state for a single alert key.
 * @param {string} alertKey
 * @returns {Promise<AlertState | null>}
 */
export async function readAlertState(alertKey) {
  const raw = await readRaw();
  const entry = raw[alertKey];
  if (!entry || typeof entry !== 'object') return null;
  return {
    lastFiredAt: entry.lastFiredAt ?? 0,
    lastConditionResult: entry.lastConditionResult ?? false,
  };
}

/**
 * Write state for a single alert key, merging with the existing file.
 * @param {string} alertKey
 * @param {AlertState} state
 */
export async function writeAlertState(alertKey, { lastFiredAt, lastConditionResult }) {
  return withWriteLock(async () => {
    const raw = await readRaw();
    raw[alertKey] = { lastFiredAt, lastConditionResult };
    await writeRaw(raw);
  });
}
