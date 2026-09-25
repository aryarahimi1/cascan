#!/usr/bin/env node
/**
 * Public BCH Fulcrum network status, measured with cascan's own discovery.
 *
 *   node scripts/status-snapshot.mjs [previous.json] [out.json]
 *
 * Each run probes every server the DNS seed, curated registry, and peer
 * gossip advertise, plus every server remembered from earlier runs, and
 * appends one state per server to a rolling window (see status-lib.mjs).
 *
 * Monitoring only: insecure transports are allowed so self-signed servers
 * can still be checkpoint-verified, and the TLS state is recorded rather
 * than trusted. Nothing here feeds a payment decision.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { discoverServers } from '../src/pool/discovery.js';
import { getNetwork } from '../src/networks.js';
import {
  STATUS_SCHEMA,
  classifyRejection,
  classifyVerified,
  mergeRun,
  runnerCannotReach,
} from './status-lib.mjs';

const NETWORKS = ['mainnet', 'chipnet'];
const INTERVAL_MINUTES = 30;
const WINDOW_SAMPLES = 7 * 24 * (60 / INTERVAL_MINUTES);

const [previousPath, outPath] = process.argv.slice(2);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const previous = await readPrevious(previousPath);
const now = new Date().toISOString();

const networks = {};
for (const name of NETWORKS) {
  const prior = previous?.networks?.[name];
  const observations = await observe(name, prior);
  networks[name] = mergeRun(prior, observations, { now, windowSamples: WINDOW_SAMPLES });
  const run = networks[name].runs.at(-1);
  console.error(`${name}: ${run.up}/${run.probed} up, ${run.authenticated} authenticated TLS, tip ${run.tip}`);
}

const status = {
  schema: STATUS_SCHEMA,
  generatedAt: now,
  intervalMinutes: INTERVAL_MINUTES,
  windowSamples: WINDOW_SAMPLES,
  generator: `cascan/${packageJson.version}`,
  networks,
};
const json = `${JSON.stringify(status)}\n`;
if (outPath) await writeFile(outPath, json);
else process.stdout.write(json);

async function readPrevious(path) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed?.schema === STATUS_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

async function observe(networkName, prior) {
  const net = getNetwork(networkName);
  const remembered = (prior?.servers ?? [])
    .filter(entry => entry.ports && (entry.ports.ssl || entry.ports.tcp))
    .map(entry => ({ host: entry.host, ports: entry.ports }));

  const result = await discoverServers({
    network: networkName,
    curated: [...net.curated, ...remembered],
    allowInsecureTransport: true,
    maxProbes: 64,
  });

  const sources = new Map();
  for (const entry of prior?.servers ?? []) sources.set(entry.host, entry.source);
  for (const entry of net.curated) sources.set(entry.host, 'curated');

  const observations = [];
  for (const record of result.servers) {
    observations.push({
      host: record.host,
      state: classifyVerified(record),
      source: sources.get(record.host) ?? record.source,
      ports: { ssl: record.ports?.ssl ?? null, tcp: record.ports?.tcp ?? null },
      transport: record.transport,
      port: record.port,
      latencyMs: record.health?.latencyEmaMs ?? null,
      height: record.health?.height ?? null,
      software: record.software ?? null,
      protocol: record.protocol ?? null,
    });
  }
  for (const rejection of result.rejected) {
    if (observations.some(obs => obs.host === rejection.host)) continue;
    // Not a measurement of the server: the runner has no route to it.
    if (runnerCannotReach(rejection.host, rejection.reason)) continue;
    observations.push({
      host: rejection.host,
      state: classifyRejection(rejection.reason),
      source: sources.get(rejection.host) ?? (isIP(rejection.host) ? 'seed' : 'gossip'),
      reason: rejection.reason,
    });
  }
  return foldSeedAddresses(observations);
}

/**
 * The DNS seed returns bare IPs. Drop an IP whose address belongs to a
 * hostname probed in the same run, so one server is never counted twice.
 */
async function foldSeedAddresses(observations) {
  const hostnameIps = new Set();
  await Promise.all(observations
    .filter(obs => !isIP(obs.host))
    .map(async (obs) => {
      for (const address of [
        ...await resolve4(obs.host).catch(() => []),
        ...await resolve6(obs.host).catch(() => []),
      ]) hostnameIps.add(address);
    }));
  return observations.filter(obs => !isIP(obs.host) || !hostnameIps.has(obs.host));
}
