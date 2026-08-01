import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const MAX_DNS_ANSWERS = 16;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home',
  '.lan',
];

const NON_PUBLIC_V4 = new BlockList();
const NON_PUBLIC_V6 = new BlockList();

// IANA special-purpose, private, loopback, link-local, documentation,
// benchmarking, multicast, and reserved IPv4 ranges. Public discovery must
// never turn an attacker-controlled peer record into a probe of these ranges.
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  NON_PUBLIC_V4.addSubnet(network, prefix, 'ipv4');
}

// Only global-unicast 2000::/3 is eligible. The three broad ranges below
// exclude everything outside it, including mapped IPv4, loopback, ULA,
// link-local, NAT64, discard-only, multicast, and reserved space.
NON_PUBLIC_V6.addSubnet('::', 3, 'ipv6');
NON_PUBLIC_V6.addSubnet('4000::', 2, 'ipv6');
NON_PUBLIC_V6.addSubnet('8000::', 1, 'ipv6');

// Special-purpose ranges that sit inside 2000::/3.
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3ffe::', 16],
]) {
  NON_PUBLIC_V6.addSubnet(network, prefix, 'ipv6');
}

export class UnsafeDestinationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeDestinationError';
    this.code = 'EACCES';
  }
}

/** True only for globally routable IP literals. */
export function isPublicIp(address) {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, 'ipv4');
  if (family === 6) return !NON_PUBLIC_V6.check(address, 'ipv6');
  return false;
}

/** Hostnames reserved for local/internal resolution are never public targets. */
export function isBlockedHostname(hostname) {
  if (typeof hostname !== 'string') return true;
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return BLOCKED_HOSTNAMES.has(normalized)
    || BLOCKED_HOSTNAME_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

/**
 * Resolve once, reject the entire hostname if any answer is non-public, and
 * return the exact bounded answer set that may be bound into a socket lookup.
 *
 * @param {string} hostname
 * @param {{ lookup?: typeof dnsLookup }} [opts]
 * @returns {Promise<Array<{address: string, family: 4|6}>>}
 */
export async function resolvePublicAddresses(hostname, opts = {}) {
  if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 253) {
    throw new UnsafeDestinationError('public destination hostname is invalid');
  }
  if (isBlockedHostname(hostname)) {
    throw new UnsafeDestinationError(`destination ${hostname} is local or metadata-only`);
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicIp(hostname)) {
      throw new UnsafeDestinationError(`destination ${hostname} is not a public IP address`);
    }
    return [{ address: hostname, family: literalFamily }];
  }

  const lookup = opts.lookup ?? dnsLookup;
  let answers;
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new UnsafeDestinationError(`public DNS lookup failed for ${hostname}: ${err?.code ?? err?.message ?? 'unknown error'}`);
  }
  if (!Array.isArray(answers)) answers = answers ? [answers] : [];
  if (answers.length === 0) {
    throw new UnsafeDestinationError(`public DNS lookup returned no addresses for ${hostname}`);
  }
  if (answers.length > MAX_DNS_ANSWERS) {
    throw new UnsafeDestinationError(`public DNS lookup returned too many addresses for ${hostname}`);
  }

  const records = [];
  const seen = new Set();
  for (const answer of answers) {
    const address = answer?.address;
    const actualFamily = isIP(address);
    const declaredFamily = answer?.family === 4 || answer?.family === 'IPv4'
      ? 4
      : answer?.family === 6 || answer?.family === 'IPv6'
        ? 6
        : actualFamily;
    if (
      (actualFamily !== 4 && actualFamily !== 6)
      || declaredFamily !== actualFamily
      || !isPublicIp(address)
    ) {
      throw new UnsafeDestinationError(`destination ${hostname} resolved to a non-public address`);
    }
    const family = actualFamily;
    const key = `${family}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({ address, family });
  }
  if (records.length === 0) {
    throw new UnsafeDestinationError(`public DNS lookup returned no usable addresses for ${hostname}`);
  }
  return records;
}

/**
 * Node socket lookup callback that can return only a previously validated
 * answer. DNS is not consulted a second time, closing the rebinding window.
 */
export function createPinnedLookup(records) {
  if (
    !Array.isArray(records)
    || records.length === 0
    || records.length > MAX_DNS_ANSWERS
    || records.some(record => isIP(record?.address) !== record?.family || !isPublicIp(record?.address))
  ) {
    throw new UnsafeDestinationError('cannot pin an invalid or non-public DNS answer');
  }
  const pinned = records.map(record => ({ address: record.address, family: record.family }));
  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const requestedFamily = options?.family === 4 || options?.family === 6
      ? options.family
      : 0;
    const eligible = requestedFamily === 0
      ? pinned
      : pinned.filter(record => record.family === requestedFamily);

    queueMicrotask(() => {
      if (eligible.length === 0) {
        const err = new UnsafeDestinationError('validated destination has no address in the requested family');
        err.code = 'ENOTFOUND';
        callback(err);
      } else if (options?.all === true) {
        callback(null, eligible.map(record => ({ ...record })));
      } else {
        callback(null, eligible[0].address, eligible[0].family);
      }
    });
  };
}
