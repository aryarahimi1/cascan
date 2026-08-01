/**
 * src/commands/webhook.js
 *
 * SSRF-conscious webhook POST for watch events.
 *
 * v0.1 scope (documented, not hidden):
 *   - scheme allowlist: http/https only
 *   - blocks literal loopback / RFC1918 / link-local / IMDS hostnames and IPs
 *   - 10s timeout, no retries, redirects not followed
 * DNS resolution goes through
 * a guarded lookup hook — every resolved address is blocklist-checked and
 * the socket connects to exactly the address that passed, closing the
 * DNS-rebinding (TOCTOU) window between validation and connection.
 * IPv6 literals (incl. IPv4-mapped/NAT64/6to4 forms) are range-checked.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup as dnsLookup } from 'node:dns';

const BLOCKED_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'metadata', 'metadata.google.internal']);

function isBlockedIpv4(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;                       // 0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true;                                 // link-local + IMDS
  if (a === 172 && b >= 16 && b <= 31) return true;                        // 172.16/12
  if (a === 192 && b === 168) return true;                                 // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;                       // CGNAT
  if (a >= 224) return true;                                               // multicast + reserved
  return false;
}

/**
 * Extract an embedded IPv4 (a, b octets) from IPv6 transition forms:
 *   ::ffff:127.0.0.1  (mapped, dotted)      ::ffff:7f00:1  (mapped, hex)
 *   ::127.0.0.1       (compatible, dotted)  64:ff9b::7f00:1 (NAT64)
 *   2002:7f00:0001::  (6to4)
 * Returns [a, b] or null.
 */
function embeddedIpv4(lower) {
  // Dotted-quad tail: ::ffff:a.b.c.d or ::a.b.c.d
  const dotted = lower.match(/\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted && (lower.startsWith('::ffff:') || lower.startsWith('::') || lower.startsWith('64:ff9b::'))) {
    const octets = lower.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (octets) return [Number(octets[1]), Number(octets[2])];
  }
  // Hex tail: last two 16-bit groups → a.b.c.d
  const hexTail = lower.match(/(?:^|:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexTail && (lower.startsWith('::ffff:') || lower.startsWith('64:ff9b::'))) {
    const hi = parseInt(hexTail[1], 16);
    return [(hi >> 8) & 0xff, hi & 0xff];
  }
  // 6to4: 2002:aabb:cccc:: → aa.bb
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):/);
  if (sixToFour) {
    const v = parseInt(sixToFour[1], 16);
    return [(v >> 8) & 0xff, v & 0xff];
  }
  return null;
}

function isBlockedIpLiteral(h) {
  // IPv4 literals (Node's URL parser normalizes decimal/hex/octal forms
  // to dotted-quad before we see them, so those tricks fail here).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return isBlockedIpv4(a, b);
  }
  // IPv6 literals
  if (h.includes(':')) {
    const lower = h.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
      return true;
    }
    // IPv4-mapped/compatible/NAT64/6to4: block iff the embedded IPv4 is blocked.
    const embedded = embeddedIpv4(lower);
    if (embedded && isBlockedIpv4(embedded[0], embedded[1])) return true;
    return false;
  }
  return false;
}

/**
 * Validate a webhook URL. Throws with a descriptive message.
 * @param {string} urlStr
 * @returns {URL}
 */
export function validateWebhookUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`invalid webhook URL: ${JSON.stringify(urlStr)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`webhook URL must be http:// or https:// (got ${url.protocol})`);
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || isBlockedIpLiteral(host)) {
    throw new Error(`webhook host ${host} is blocked (loopback/private/link-local)`);
  }
  return url;
}

/**
 * DNS-rebinding (TOCTOU) guard for the validation/connection boundary.
 * The hostname is resolved through THIS hook and every resolved address is
 * re-checked against the blocklist; the socket then connects to the exact
 * address that passed. A DNS answer that changes between "check" and
 * "connect" no longer exists as a window, because they are the same step.
 */
function guardedLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
    for (const a of list) {
      if (isBlockedIpLiteral(a.address)) {
        return callback(new Error(`webhook host ${hostname} resolves to blocked address ${a.address} (loopback/private/link-local)`));
      }
    }
    // Node accepts (err, address, family) or (err, [{address, family}]) per `all`.
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

/**
 * POST one JSON-envelope attempt to the webhook. Throws on transport or HTTP
 * failure; higher-level acknowledged delivery may retry with the same
 * idempotency key. Uses
 * node:http(s).request instead of fetch so DNS resolution goes through
 * guardedLookup (fetch/undici does not expose a lookup hook per-request).
 * Redirects are NOT followed — a 3xx response is a failure, matching the
 * old `redirect: 'error'` posture.
 *
 * @param {string} urlStr - pre-validated
 * @param {object} payload
 * @param {{ idempotencyKey?: string }} [opts]
 */
export async function postWebhook(urlStr, payload, opts = {}) {
  const url = validateWebhookUrl(urlStr);
  const body = JSON.stringify(payload);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const idempotencyKey = opts.idempotencyKey;
  if (idempotencyKey != null && (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 1 || idempotencyKey.length > 200 ||
    !/^[a-z0-9._:-]+$/i.test(idempotencyKey)
  )) {
    throw new TypeError('webhook idempotency key must be 1-200 safe ASCII characters');
  }

  return new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      lookup: guardedLookup,
      timeout: 10_000,
    }, (res) => {
      res.resume(); // drain — the response body is not our business
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`webhook POST failed: HTTP ${res.statusCode}`));
    });
    req.on('timeout', () => {
      req.destroy(new Error('webhook POST timed out after 10s'));
    });
    req.on('error', (err) => reject(new Error(`webhook POST failed: ${err.message}`)));
    req.end(body);
  });
}
