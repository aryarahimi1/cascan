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

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const ALERTS_PATH = join(homedir(), '.cascan', 'alerts.json');

// Single-slot mutex for in-process read-modify-write on the alerts file.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

/** Read raw alerts file; a missing file is empty, corruption/I/O fail closed. */
async function readRaw() {
  try {
    const text = await readFile(ALERTS_PATH, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('alert state file must contain a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`alert state unavailable: ${error?.message ?? error}`, { cause: error });
  }
}

/** Write object to alerts file atomically. Persistence failures are visible. */
async function writeRaw(data) {
  await mkdir(dirname(ALERTS_PATH), { recursive: true, mode: 0o700 });
  // Use an unpredictable, exclusive temp file so another local process cannot
  // pre-place a symlink at a predictable PID-based path.
  const tmp = `${ALERTS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(tmp, ALERTS_PATH);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
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
