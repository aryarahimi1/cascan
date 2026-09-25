/**
 * Network-status snapshot: classification and rolling-window merge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRejection,
  classifyVerified,
  mergeRun,
  shortReason,
  uptime,
} from '../scripts/status-lib.mjs';

test('status: verified records are classified by transport authentication', () => {
  assert.equal(classifyVerified({ transport: 'ssl', tlsStrict: true }), 'A');
  assert.equal(classifyVerified({ transport: 'ssl', tlsStrict: false }), 'S');
  assert.equal(classifyVerified({ transport: 'tcp', tlsStrict: false }), 'C');
});

test('status: rejections separate unreachable, wrong-chain, and failed handshakes', () => {
  assert.equal(classifyRejection('connect timeout after 6000ms'), 'D');
  assert.equal(classifyRejection('connect ECONNREFUSED 1.2.3.4:50002'), 'D');
  assert.equal(classifyRejection('no transport available'), 'D');
  assert.equal(classifyRejection('wrong chain: checkpoint 556767 does not match mainnet'), 'W');
  assert.equal(classifyRejection('server returned a malformed 80-byte block header'), 'X');
  assert.equal(shortReason(`line one\n    at stack (x.js:1)`), 'line one');
});

test('status: runs append samples, mark unprobed hosts, and compute lag from the tip', () => {
  const first = mergeRun(undefined, [
    { host: 'a.example', state: 'A', source: 'curated', height: 100, ports: { ssl: 50002, tcp: null } },
    { host: 'b.example', state: 'S', source: 'gossip', height: 98 },
    { host: 'c.example', state: 'D', source: 'seed', reason: 'connect timeout after 6000ms' },
  ], { now: '2026-01-01T00:00:00.000Z', windowSamples: 4 });

  assert.deepEqual(first.runs, [{ at: '2026-01-01T00:00:00.000Z', probed: 3, up: 2, authenticated: 1, tip: 100 }]);
  const b = first.servers.find(entry => entry.host === 'b.example');
  assert.equal(b.last.lag, 2);
  assert.equal(b.lastUp, '2026-01-01T00:00:00.000Z');
  const c = first.servers.find(entry => entry.host === 'c.example');
  assert.equal(c.lastUp, null);
  assert.equal(c.last.lag, null);
  assert.equal(c.last.reason, 'connect timeout after 6000ms');

  const second = mergeRun(first, [
    { host: 'a.example', state: 'D', reason: 'connect ECONNREFUSED' },
  ], { now: '2026-01-01T00:30:00.000Z', windowSamples: 4 });
  const a = second.servers.find(entry => entry.host === 'a.example');
  assert.equal(a.samples, 'AD');
  assert.equal(a.lastUp, '2026-01-01T00:00:00.000Z', 'a failed run keeps the last time it was up');
  assert.deepEqual(a.ports, { ssl: 50002, tcp: null }, 'ports survive a run without them');
  assert.equal(second.servers.find(entry => entry.host === 'b.example').samples, 'S-');
  assert.equal(second.runs.at(-1).tip, null);
});

test('status: the window is bounded and forgets hosts with no probes left in it', () => {
  let status;
  status = mergeRun(status, [{ host: 'gone.example', state: 'A', height: 1 }], { now: 't0', windowSamples: 3 });
  for (const now of ['t1', 't2', 't3']) {
    status = mergeRun(status, [{ host: 'stay.example', state: 'A', height: 1 }], { now, windowSamples: 3 });
  }
  assert.deepEqual(status.servers.map(entry => entry.host), ['stay.example']);
  assert.equal(status.servers[0].samples, 'AAA');
  assert.equal(status.runs.length, 3);
});

test('status: uptime counts only runs in which the server was probed', () => {
  assert.equal(uptime('AASD--'), 0.75);
  assert.equal(uptime('C'), 1);
  assert.equal(uptime('WX'), 0);
  assert.equal(uptime('---'), null);
});
