/**
 * test/security.test.js
 *
 * Security regression tests:
 *   - webhook SSRF blocklist incl. IPv4-mapped IPv6 bypasses
 *   - terminal escape injection sanitization
 *   - malformed server data resilience in token aggregation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWebhookUrl } from '../src/commands/webhook.js';
import { sanitize } from '../src/cli/render.js';
import { aggregateTokenUtxos } from '../src/tokens/aggregate.js';

test('webhook: public https URLs pass', () => {
  const u = validateWebhookUrl('https://hooks.slack.com/services/XXX');
  assert.equal(u.hostname, 'hooks.slack.com');
});

test('webhook: scheme allowlist rejects file/ftp/gopher/data', () => {
  for (const scheme of ['file:///etc/passwd', 'ftp://x.com/', 'gopher://x.com/', 'data:text/plain,x']) {
    assert.throws(() => validateWebhookUrl(scheme), /http/);
  }
});

test('webhook: loopback/private/IMDS IPv4 literals blocked', () => {
  for (const u of [
    'http://127.0.0.1/hook', 'http://10.1.2.3/hook', 'http://192.168.1.1/hook',
    'http://169.254.169.254/latest/meta-data', 'http://172.16.0.1/hook',
    'http://2130706433/hook',       // decimal IPv4 for 127.0.0.1
    'http://0x7f000001/hook',       // hex IPv4
  ]) {
    assert.throws(() => validateWebhookUrl(u), /blocked/, `expected blocked: ${u}`);
  }
});

test('webhook: IPv4-mapped IPv6 bypasses are blocked', () => {
  for (const u of [
    'http://[::ffff:127.0.0.1]/hook',
    'http://[::ffff:a9fe:a9fe]/hook',      // 169.254.169.254 IMDS
    'http://[::ffff:7f00:1]/hook',         // hex form of 127.0.0.1
    'http://[::ffff:c0a8:101]/hook',       // 192.168.1.1
    'http://[64:ff9b::7f00:1]/hook',       // NAT64-embedded 127.0.0.1
  ]) {
    assert.throws(() => validateWebhookUrl(u), /blocked/, `expected blocked: ${u}`);
  }
});

test('webhook: 6to4 with public embedded IPv4 still allowed', () => {
  // 2002:0801:0101:: embeds 8.1.1.1 (public)  must not be over-blocked
  const u = validateWebhookUrl('http://[2002:0801:0101::]/hook');
  assert.ok(u);
});

test('sanitize: strips ESC/OSC/CSI introducers and control chars', () => {
  const evil = 'legit \x1b[2J\x1b[0;0H\x1b]8;;http://evil\x07CLICK\x1b]8;;\x07 done';
  const clean = sanitize(evil);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(clean), 'no control chars may survive');
  assert.equal(clean, 'legit [2J[0;0H]8;;http://evilCLICK]8;; done');
});

test('sanitize: non-strings pass through untouched', () => {
  assert.equal(sanitize(null), null);
  assert.equal(sanitize(42), 42);
});

test('aggregate: garbage from a hostile server is skipped, not thrown', () => {
  const utxos = [
    { tx_hash: 't1', tx_pos: 0, value: 800, token_data: { category: 'a'.repeat(64), amount: 'not-a-number' } },
    { tx_hash: 't2', tx_pos: 0, value: 'garbage', token_data: { category: 'a'.repeat(64), amount: '5' } },
    { tx_hash: 't3', tx_pos: 0, value: 800, token_data: { category: 'not-hex-at-all', amount: '9' } },
    { tx_hash: 't4', tx_pos: 0, value: 800, token_data: null },
    'not-even-an-object',
  ];
  const out = aggregateTokenUtxos(utxos);
  assert.equal(out.length, 1);
  assert.equal(out[0].ftAmount, '5');           // the one valid amount survived
  assert.equal(out[0].satsLocked, '800');       // t1's 800; t2's 'garbage' skipped
  assert.equal(out[0].utxoCount, 2);            // both valid-category utxos counted
});

// ---------------------------------------------------------------------------
// Pool-backed commands print
// discovery-sourced (gossip → attacker-influenceable) server names.
// ---------------------------------------------------------------------------

test('quorum render: hostile "answered" server name is sanitized', async () => {
  const { renderQuorumLine, renderServerStatuses } = await import('../src/cli/render.js');
  const evil = 'evil\x1b[2J\x1b]8;;https://phish.example\x07srv.com:50002';
  const line = renderQuorumLine({ answered: evil, agreement: 'majority', height: 1, statuses: [{ server: evil, status: 'ok', latencyMs: 1 }] });
  assert.ok(!line.includes('\x1b]8'), 'OSC introducer stripped');
  assert.ok(!line.includes('\x1b[2J'), 'CSI screen-clear stripped');
  assert.ok(!line.includes('\x07'), 'BEL stripped');
  // Theme helpers legitimately emit ANSI color codes; the assertion targets
  // the INJECTED sequences: the ESC byte must be gone from attacker strings.
  const statuses = renderServerStatuses([{ server: evil, status: 'failed', error: 'x\x1b[31mfake' }]);
  assert.ok(!statuses.includes('\x1b[2J'), 'injected screen-clear stripped');
  assert.ok(!statuses.includes('\x1b]8'), 'injected OSC stripped');
  assert.ok(statuses.includes('x[31mfake'), 'error text kept, ESC byte stripped');
});

// ---------------------------------------------------------------------------
// DNS-rebinding closure: hostnames that
// RESOLVE to blocked ranges are refused at connection time.
// ---------------------------------------------------------------------------

test('webhook: hostname resolving to loopback blocked at lookup (DNS rebinding)', async () => {
  const { postWebhook } = await import('../src/commands/webhook.js');
  // localtest.me publicly resolves to 127.0.0.1 — the literal check cannot
  // see it, only the guarded lookup can. Skip silently if DNS is unavailable.
  try {
    await postWebhook('http://localtest.me/hook', { probe: true });
    assert.fail('expected rebinding-style hostname to be blocked');
  } catch (err) {
    if (/ENOTFOUND|EAI_AGAIN/.test(err.message)) return; // offline CI — inconclusive, not a failure
    assert.match(err.message, /resolves to blocked address/);
  }
});
