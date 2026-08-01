/**
 * cascan — BCH's connection-reliability layer.
 *
 * Public library API (zero dependencies, Node ≥ 20.10):
 *
 *   import { connect } from '@aryarh/cascan';
 *
 *   const bch = await connect();                    // discovery + failover on
 *   const bal = await bch.balance('bitcoincash:…'); // survives server death
 *   const stop = await bch.watch('bitcoincash:…', st => console.log('activity!', st));
 *   bch.on('failover', f => console.log(`switched ${f.from} → ${f.to}`));
 *   await bch.close();
 *
 * Reliability contract:
 *   - the server pool is DISCOVERED (Flowee DNS seed + peer gossip +
 *     probing), verified against BCH fork checkpoints, health-scored, and
 *     cached in ~/.cascan/servers.json — with the curated list as fallback
 *   - every call fails over transparently; subscriptions resurrect on the
 *     replacement server and deliver anything missed during the gap
 *   - money-relevant queries are quorum-verified by default: at least two
 *     matching eligible operator responses and no plurality result;
 *     `verify: false` is an explicit single-server performance trade-off
 *   - when the whole pool is exhausted you get AllServersFailedError —
 *     loud death, never silent staleness
 *
 * The cascan CLI is this library's first consumer.
 */

import { EventEmitter } from 'node:events';
import { ServerPool } from './pool/pool.js';
import { resolvePool, toQuorumEntry } from './pool/resolve.js';
import { queryQuorum, fulcrumMeta } from './fulcrum/quorum.js';
import { consensusHeight, scoreServer } from './pool/health.js';
import { serverName } from './pool/transport.js';
import { parseAddress } from './address.js';
import { getNetwork } from './networks.js';
import { parseBchSatoshis, requireBchHeight } from './validation.js';

export class Cascan extends EventEmitter {
  /** @param {ServerPool} pool  @param {object} opts */
  constructor(pool, opts = {}) {
    super();
    this.pool = pool;
    this.network = opts.network ?? 'mainnet';
    this.defaults = { verify: opts.verify !== false };
    for (const ev of [
      'failover', 'failover-start', 'server-lost', 'exhausted', 'handler-error',
      'recovery-scheduled', 'recovered', 'server-stable',
    ]) {
      pool.on(ev, (payload) => this.emit(ev, payload));
    }
  }

  /** Escape hatch: any Electrum method, with failover. */
  request(method, params = []) {
    return this.pool.request(method, params);
  }

  /**
   * Quorum-verified call: same method fanned out to eligible operators.
   * @returns {Promise<{ value: any, receipt: object }>}
   *   receipt = { answered, agreement, servers[], disagreements[], degraded[] }
   */
  async verify(method, params = [], opts = {}) {
    const ranked = this.pool.ranked().filter(s => s.ports?.ssl || s.ports?.tcp);
    // Pass the full ranked pool: queryQuorum filters to distinct trusted
    // operators before applying maxFanout. Pre-slicing here could let fast
    // gossip peers crowd all security voters out of the candidate window.
    const entries = ranked.map(toQuorumEntry);
    const requestedMinimum = opts.minAgreement ?? 2;
    if (!Number.isInteger(requestedMinimum) || requestedMinimum < 1) {
      throw new RangeError('minAgreement must be a positive integer');
    }
    const qr = await queryQuorum(method, params, {
      mode: opts.mode ?? 'majority',
      servers: entries,
      network: this.network,
      paymentMode: true,
      timeoutMs: opts.timeoutMs,
      maxFanout: opts.maxServers ?? 4,
      // `verify()` is a security boundary, so a caller cannot accidentally
      // turn it into a one-server success path. Use request() for that.
      minAgreement: Math.max(2, requestedMinimum),
    });
    return { value: qr.value, receipt: fulcrumMeta(qr) };
  }

  /**
   * Balance in satoshis (confirmed + unconfirmed as strings — money math
   * is never floated). `verify: true` adds a quorum receipt.
   *
   * @param {string} address — cashaddr or legacy
   * @returns {Promise<{ address: string, confirmedSats: string,
   *   unconfirmedSats: string, totalSats: string, receipt?: object }>}
   */
  async balance(address, opts = {}) {
    const rec = parseAddress(address, { network: this.network });
    const verify = opts.verify ?? this.defaults.verify;

    let value, receipt;
    if (verify) {
      ({ value, receipt } = await this.verify('blockchain.address.get_balance', [rec.cashaddr], opts));
    } else {
      value = await this.pool.request('blockchain.address.get_balance', [rec.cashaddr]);
    }

    const confirmedSats = parseBchSatoshis(value?.confirmed, {
      field: 'confirmed',
    }).toString();
    const unconfirmedSats = parseBchSatoshis(value?.unconfirmed, {
      allowNegative: true,
      field: 'unconfirmed',
    }).toString();
    return {
      address: rec.cashaddr,
      confirmedSats,
      unconfirmedSats,
      totalSats: (BigInt(confirmedSats) + BigInt(unconfirmedSats)).toString(),
      ...(receipt ? { receipt } : {}),
    };
  }

  /**
   * Transaction lookup (verbose by default). `verify: true` cross-checks
   * the raw hex across servers.
   */
  async tx(txid, opts = {}) {
    const verbose = opts.verbose !== false;
    const verify = opts.verify ?? this.defaults.verify;
    if (verify) {
      const { value, receipt } = await this.verify('blockchain.transaction.get', [txid, verbose], opts);
      return { tx: value, receipt };
    }
    return { tx: await this.pool.request('blockchain.transaction.get', [txid, verbose]) };
  }

  /** Current chain height. Verified by default; see balance() for opt-out semantics. */
  async height(opts = {}) {
    const verify = opts.verify ?? this.defaults.verify;
    const tip = verify
      ? (await this.verify('blockchain.headers.subscribe', [], opts)).value
      : await this.pool.request('blockchain.headers.subscribe');
    return requireBchHeight(tip?.height);
  }

  /**
   * Watch an address. Changed state observed during live operation, failover,
   * or a liveness re-query enters acknowledged delivery. Under callback
   * backpressure, only the newest not-yet-started state is retained.
   *
   * @param {string} address
   * @param {(status: string|null, event: object) => void|Promise<void>} cb
   * @returns {Promise<() => void>} unsubscribe
   */
  async watch(address, cb) {
    const rec = parseAddress(address, { network: this.network });
    await this.pool.subscribeAddress(rec.cashaddr, cb);
    return () => this.pool.unsubscribeAddress(rec.cashaddr, cb);
  }

  /** Health snapshot of the pool, best-first, with visible scores. */
  servers() {
    const ranked = this.pool.ranked();
    const maxHeight = consensusHeight(ranked);
    const now = Date.now();
    return ranked.map(s => ({
      host: s.host,
      ports: s.ports,
      source: s.source ?? 'curated',
      operator: s.operator ?? null,
      infrastructure: s.infrastructure ?? null,
      tlsStrict: s.tlsStrict !== false,
      software: s.software ?? null,
      protocol: s.protocol ?? null,
      height: s.health.height,
      latencyMs: s.health.latencyEmaMs,
      failures: s.health.failures,
      cooldownUntil: s.health.cooldownUntil > now
        ? new Date(s.health.cooldownUntil).toISOString()
        : null,
      cooldownMs: Math.max(0, (s.health.cooldownUntil ?? 0) - now),
      score: Math.round(scoreServer(s, maxHeight) * 10) / 10,
      connected: this.pool.current === serverName(s),
    }));
  }

  async close() {
    this.pool.close();
  }
}

/**
 * Connect to Bitcoin Cash.
 *
 * @param {{
 *   network?: 'mainnet'|'chipnet'|'testnet4',  — default mainnet
 *   servers?: Array,        — explicit pool (skips discovery)
 *   discover?: boolean,     — default true: DNS seed + gossip + cache
 *   verify?: boolean,       — default true: quorum-verify balance/tx/height
 *   allowInsecureTransport?: boolean, — explicit non-payment escape hatch;
 *                                      requires verify:false
 *   timeoutMs?: number,
 *   subscriptionCheckMs?: number,
 *   subscriptionCheckBatchSize?: number,
 *   handlerRetryBaseMs?: number,
 *   handlerRetryMaxMs?: number,
 *   handlerTimeoutMs?: number,
 *   failureBackoffBaseMs?: number,
 *   failureBackoffMaxMs?: number,
 *   minHealthyUptimeMs?: number,
 *   retryBudgetAttempts?: number,
 *   retryBudgetWindowMs?: number,
 *   recoveryBackoffBaseMs?: number,
 *   recoveryBackoffMaxMs?: number,
 *   cachePath?: string,
 *   onLog?: (m: string) => void,
 * }} [opts]
 * @returns {Promise<Cascan>}
 */
export async function connect(opts = {}) {
  const network = getNetwork(opts.network ?? 'mainnet').name; // fail fast on typos
  if (opts.allowInsecureTransport === true && opts.verify !== false) {
    throw new TypeError('allowInsecureTransport is non-payment only and requires verify: false');
  }
  let servers;
  if (Array.isArray(opts.servers) && opts.servers.length > 0) {
    servers = opts.servers;
  } else {
    ({ servers } = await resolvePool(opts));
  }
  const pool = new ServerPool(servers, {
    network,
    timeoutMs: opts.timeoutMs,
    subscriptionCheckMs: opts.subscriptionCheckMs,
    subscriptionCheckBatchSize: opts.subscriptionCheckBatchSize,
    handlerRetryBaseMs: opts.handlerRetryBaseMs,
    handlerRetryMaxMs: opts.handlerRetryMaxMs,
    handlerTimeoutMs: opts.handlerTimeoutMs,
    failureBackoffBaseMs: opts.failureBackoffBaseMs,
    failureBackoffMaxMs: opts.failureBackoffMaxMs,
    minHealthyUptimeMs: opts.minHealthyUptimeMs,
    retryBudgetAttempts: opts.retryBudgetAttempts,
    retryBudgetWindowMs: opts.retryBudgetWindowMs,
    recoveryBackoffBaseMs: opts.recoveryBackoffBaseMs,
    recoveryBackoffMaxMs: opts.recoveryBackoffMaxMs,
    allowInsecureTransport: opts.allowInsecureTransport,
  });
  const bch = new Cascan(pool, { ...opts, network });
  await pool.acquire(); // fail fast: connect() resolves connected or throws
  return bch;
}

// Re-exports: the full toolbox for library consumers.
export { CascanNetworkProvider } from './adapters/cashscript.js';
export { CascanMainnetProvider } from './adapters/mainnetjs.js';
export { ServerPool } from './pool/pool.js';
export { resolvePool, toQuorumEntry, connectPool } from './pool/resolve.js';
export { discoverServers, DNS_SEED, CHECKPOINTS } from './pool/discovery.js';
export { rankServers, scoreServer, newHealth } from './pool/health.js';
export { queryQuorum, fulcrumMeta } from './fulcrum/quorum.js';
export { ChainVerificationError } from './fulcrum/chain.js';
export { QuorumDisagreementError, AllServersFailedError } from './fulcrum/errors.js';
export { InsecureTransportError } from './pool/transport.js';
export { FulcrumClient } from './fulcrum/client.js';
export { DEFAULT_FULCRUM_SERVERS } from './fulcrum/servers.js';
export { parseAddress, convertAddress, AddressError } from './address.js';
export { NETWORKS, NETWORK_NAMES, getNetwork } from './networks.js';
