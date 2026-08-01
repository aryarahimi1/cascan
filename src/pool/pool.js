/**
 * src/pool/pool.js
 *
 * ServerPool — the reliability core. One live connection to the
 * best-scoring server, transparent failover when it dies, and
 * subscriptions that RESURRECT on the replacement server.
 *
 * The resurrection detail that makes `watch` safe: for every subscribed
 * address the pool remembers the last status hash the old server reported.
 * After failover it resubscribes on the new server, and if the returned
 * status differs — something happened during the gap — the callback fires
 * immediately. A payment that lands mid-failover is delivered, not lost.
 *
 * Failure ladder (honesty preserved):
 *   one request fails      → retried on the next-ranked server, failure
 *                            recorded in that server's health
 *   current server dies    → 'failover' event + automatic reconnect
 *   every server fails     → AllServersFailedError — loud failure, never
 *                            silent staleness
 *
 * Zero dependencies: node:events only.
 */

import { EventEmitter } from 'node:events';
import { FulcrumClient } from '../fulcrum/client.js';
import { AllServersFailedError, isTransportFailure } from '../fulcrum/errors.js';
import { newHealth, recordSuccess, recordFailure, recordHeight, rankServers } from './health.js';
import { serverDialTarget, serverName } from './transport.js';
import { isValidBchHeight, isValidElectrumAddressStatus } from '../validation.js';

const KEEPALIVE_MS = 45_000;

export class ServerPool extends EventEmitter {
  /**
   * @param {Array} servers — discovery records ({ host, ports, tlsStrict,
   *        health?, ... }) or curated entries ({ host, ports: { ssl, tcp } })
   * @param {{ timeoutMs?: number, keepaliveMs?: number,
   *           clientFactory?: (server: object) => object }} [opts]
   */
  constructor(servers, opts = {}) {
    super();
    this.servers = servers.map(s => ({
      ...s,
      health: s.health ?? newHealth(),
      tlsStrict: s.tlsStrict ?? true, // curated entries are hostname+valid-cert
    }));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;
    this._clientFactory = opts.clientFactory ?? ((server) => {
      const target = serverDialTarget(server);
      return new FulcrumClient({
        host: server.host,
        port: target.port,
        transport: target.transport,
        rejectUnauthorized: server.tlsStrict !== false,
        timeoutMs: this.timeoutMs,
        publicOnly: server.publicOnly === true,
      });
    });

    this._client = null;
    this._current = null;       // server record backing _client
    this._connecting = null;    // in-flight connect promise (serializes failover)
    this._subs = new Map();     // address → { cbs: Set<fn>, lastStatus: string|null }
    this._txSubs = new Map();   // txid → { cbs: Set<fn>, lastHeight: number|null }
    this._keepalive = null;
    this._closed = false;
  }

  /** Name of the currently connected server, or null. */
  get current() {
    return serverName(this._current);
  }

  /** Health-ranked snapshot (does not mutate pool order). */
  ranked() {
    return rankServers(this.servers);
  }

  /**
   * Ensure a live client, connecting to the best-ranked server. Serialized:
   * concurrent callers during a failover share one connection attempt.
   */
  async acquire(opts = {}) {
    if (this._closed) throw new Error('pool closed');
    if (this._client?.connected) return this._client;
    if (this._connecting) return this._connecting;

    this._connecting = this._connect(opts.exclude ?? new Set())
      .finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connect(exclude = new Set()) {
    const previous = this.current;
    const errors = [];

    for (const server of this.ranked()) {
      if (exclude.has(serverName(server))) continue;
      const client = this._clientFactory(server);
      const t0 = Date.now();
      try {
        await client.connect();
        recordSuccess(server.health, Date.now() - t0);

        this._client = client;
        this._current = server;
        client.onNotification((method, params) => this._onNotify(method, params));
        // Height tracking (also warms the header sub for notifications).
        const tip = await client.request('blockchain.headers.subscribe').catch(() => null);
        if (tip?.height != null) recordHeight(server.health, tip.height);

        // Socket death → failover, not silence.
        const c = client;
        c._socket?.once('close', () => {
          if (this._closed || this._client !== c) return;
          this._failover('connection closed').catch(() => { /* exhausted → emitted */ });
        });

        this._startKeepalive();
        await this._resubscribeAll();

        if (previous && previous !== this.current) {
          this.emit('failover', { from: previous, to: this.current, reason: 'reconnect' });
        }
        return client;
      } catch (err) {
        recordFailure(server.health);
        errors.push(err);
        client.close();
        if (this._client === client) {
          this._stopKeepalive();
          this._client = null;
          this._current = null;
        }
        this.emit('server-lost', { server: `${server.host}`, error: err.message });
      }
    }

    const exhausted = new AllServersFailedError(errors);
    this.emit('exhausted', { errors: errors.map(e => e.message) });
    throw exhausted;
  }

  async _failover(reason, opts = {}) {
    if (this._closed) return;
    const from = this.current;
    if (this._current) recordFailure(this._current.health);
    this._teardownClient();
    this.emit('failover-start', { from, reason });
    await this.acquire({ exclude: opts.exclude ?? new Set() });
    this.emit('failover', { from, to: this.current, reason });
  }

  _teardownClient() {
    this._stopKeepalive();
    if (this._client) {
      const c = this._client;
      this._client = null;
      this._current = null;
      c.close();
    }
  }

  /**
   * Request with transparent failover: tries the current server, then walks
   * the ranked list. Application-level errors (e.g. "tx not found") are NOT
   * failover triggers — only transport/timeout failures are, mirroring the
   * uniform-error honesty rule in quorum.js.
   */
  async request(method, params = []) {
    let lastErr = null;
    const maxAttempts = Math.max(1, this.servers.length);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = await this.acquire(); // throws AllServersFailedError when exhausted
      const server = this._current;
      const t0 = Date.now();
      try {
        const value = await client.request(method, params);
        recordSuccess(server.health, Date.now() - t0);
        return value;
      } catch (err) {
        lastErr = err;
        if (this._isApplicationError(err)) throw err; // server answered; the answer is "no"
        // Transport-level failure → rotate.
        await this._failover(`request failed: ${err.message}`);
      }
    }
    throw lastErr;
  }

  /**
   * Heuristic: a FulcrumError carrying a daemon/protocol message on a still-
   * living socket is an application error. Timeouts and closed/reset sockets
   * are transport errors.
   */
  _isApplicationError(err) {
    if (isTransportFailure(err)) return false;
    return this._client?.connected === true;
  }

  /**
   * Subscribe to an address. Survives failover: resubscribed automatically,
   * and a status change that happened during the gap fires cb immediately.
   *
   * @param {string} address — cashaddr
   * @param {(status: string|null) => void} cb
   * @returns {Promise<string|null>} current status hash
   */
  async subscribeAddress(address, cb) {
    let entry = this._subs.get(address);
    if (!entry) {
      // `initialized: false` keeps _resubscribeAll from touching this entry
      // until the initial subscribe below establishes the status baseline —
      // otherwise a concurrent failover would fire cb with the FIRST status
      // as if it were a change.
      entry = { cbs: new Set(), lastStatus: null, initialized: false };
      this._subs.set(address, entry);
    }
    entry.cbs.add(cb);
    if (entry.initialized) return entry.lastStatus;

    // Failover-aware initial subscribe: a server death here retries on the
    // next-ranked server instead of surfacing a transport error.
    try {
      const maxAttempts = Math.max(1, this.servers.length);
      const excluded = new Set();
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const status = await this.request('blockchain.address.subscribe', [address]);
        if (isValidElectrumAddressStatus(status)) {
          entry.lastStatus = status;
          entry.initialized = true;
          return entry.lastStatus;
        }
        if (attempt < maxAttempts - 1) {
          // A malformed subscription response is a hostile server answer,
          // not an application-level failure the caller should absorb.
          if (this.current) excluded.add(this.current);
          await this._failover('invalid address subscription status', {
            exclude: excluded,
          });
          continue;
        }
        throw new TypeError('server returned an invalid Electrum address status');
      }
    } catch (err) {
      entry.cbs.delete(cb);
      if (entry.cbs.size === 0) this._subs.delete(address);
      throw err;
    }
  }

  /**
   * Chaos hook: kill the current connection as if the server died —
   * failover, resubscription, and gap delivery all run for real. Test your
   * failover before production does. Used by scripts/demo-failover.mjs.
   *
   * @param {string} [reason]
   * @returns {Promise<string|null>} the replacement server (or throws when
   *          the pool is exhausted)
   */
  async killCurrent(reason = 'chaos: killed by operator') {
    if (!this._client?.connected) return this.current;
    await this._failover(reason);
    return this.current;
  }

  /** Remove one callback (and the server-side interest when none remain). */
  unsubscribeAddress(address, cb) {
    const entry = this._subs.get(address);
    if (!entry) return;
    entry.cbs.delete(cb);
    if (entry.cbs.size === 0) {
      this._subs.delete(address);
      // Fulcrum protocol 1.4+: unsubscribe is best-effort.
      this._client?.request('blockchain.address.unsubscribe', [address]).catch(() => {});
    }
  }

  /**
   * Subscribe to a transaction's confirmation status (height changes).
   * Same resurrection contract as subscribeAddress.
   *
   * @param {string} txid
   * @param {(height: number|null) => void} cb
   * @returns {Promise<number|null>} current height (0/null = unconfirmed)
   */
  async subscribeTransaction(txid, cb) {
    let entry = this._txSubs.get(txid);
    if (!entry) {
      entry = { cbs: new Set(), lastHeight: null, initialized: false };
      this._txSubs.set(txid, entry);
    }
    entry.cbs.add(cb);
    if (entry.initialized) return entry.lastHeight;

    try {
      const maxAttempts = Math.max(1, this.servers.length);
      const excluded = new Set();
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const height = await this.request('blockchain.transaction.subscribe', [txid]);
        if (isValidOptionalBchHeight(height)) {
          entry.lastHeight = height ?? null;
          entry.initialized = true;
          return entry.lastHeight;
        }
        if (attempt < maxAttempts - 1) {
          if (this.current) excluded.add(this.current);
          await this._failover('invalid transaction subscription height', {
            exclude: excluded,
          });
          continue;
        }
        throw new TypeError('server returned an invalid BCH transaction height');
      }
    } catch (err) {
      entry.cbs.delete(cb);
      if (entry.cbs.size === 0) this._txSubs.delete(txid);
      throw err;
    }
  }

  /** Remove one tx callback (server-side interest cleared when none remain). */
  unsubscribeTransaction(txid, cb) {
    const entry = this._txSubs.get(txid);
    if (!entry) return;
    entry.cbs.delete(cb);
    if (entry.cbs.size === 0) {
      this._txSubs.delete(txid);
      this._client?.request('blockchain.transaction.unsubscribe', [txid]).catch(() => {});
    }
  }

  async _resubscribeAll() {
    const addressChanges = [];
    for (const [address, entry] of this._subs) {
      if (!entry.initialized) continue; // baseline not set yet — see subscribeAddress
      const status = await this._client.request('blockchain.address.subscribe', [address]);
      if (!isValidElectrumAddressStatus(status)) {
        throw new TypeError('server returned an invalid Electrum address status');
      }
      const fresh = status;
      if (fresh !== entry.lastStatus) addressChanges.push({ entry, fresh });
    }

    const txChanges = [];
    for (const [txid, entry] of this._txSubs) {
      if (!entry.initialized) continue;
      const height = await this._client.request('blockchain.transaction.subscribe', [txid]);
      if (!isValidOptionalBchHeight(height)) {
        throw new TypeError('server returned an invalid BCH transaction height');
      }
      const fresh = height ?? null;
      if (fresh !== entry.lastHeight) txChanges.push({ entry, fresh });
    }

    // Commit only after every subscription is live. A partial restore must
    // fail the candidate connection, otherwise watch consumers can remain
    // silently blind while keepalive pings continue to succeed.
    for (const { entry, fresh } of addressChanges) {
      entry.lastStatus = fresh;
      for (const cb of entry.cbs) {
        try { cb(fresh); } catch { /* userland */ }
      }
    }
    for (const { entry, fresh } of txChanges) {
      entry.lastHeight = fresh;
      for (const cb of entry.cbs) {
        try { cb(fresh); } catch { /* userland */ }
      }
    }
  }

  _onNotify(method, params) {
    if (method === 'blockchain.address.subscribe') {
      const [address, status] = params ?? [];
      const entry = this._subs.get(address);
      if (!entry) return;
      if (!isValidElectrumAddressStatus(status)) {
        this._failover('invalid address subscription status', {
          exclude: new Set(this.current ? [this.current] : []),
        }).catch(() => {});
        return;
      }
      entry.lastStatus = status;
      for (const cb of entry.cbs) {
        try { cb(entry.lastStatus); } catch { /* userland */ }
      }
    } else if (method === 'blockchain.transaction.subscribe') {
      const [txid, height] = params ?? [];
      const entry = this._txSubs.get(txid);
      if (!entry) return;
      if (!isValidOptionalBchHeight(height)) {
        this._failover('invalid transaction subscription height', {
          exclude: new Set(this.current ? [this.current] : []),
        }).catch(() => {});
        return;
      }
      entry.lastHeight = height ?? null;
      for (const cb of entry.cbs) {
        try { cb(entry.lastHeight); } catch { /* userland */ }
      }
    } else if (method === 'blockchain.headers.subscribe') {
      const tip = Array.isArray(params) ? params[0] : params;
      if (isValidBchHeight(tip?.height) && this._current) {
        recordHeight(this._current.health, tip.height);
        this.emit('block', { height: tip.height, hex: tip.hex ?? null });
      }
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    let pingFailures = 0;
    this._keepalive = setInterval(async () => {
      const client = this._client;
      if (!client?.connected) return;
      try {
        await client.request('server.ping');
        pingFailures = 0;
      } catch {
        pingFailures++;
        if (pingFailures >= 2 && this._client === client) {
          pingFailures = 0;
          // The old contract died loudly here; the pool's contract is
          // failover first, loud death only when the whole pool is gone.
          this._failover('keepalive failed twice').catch(() => { /* exhausted → emitted */ });
        }
      }
    }, this.keepaliveMs);
    this._keepalive.unref?.();
  }

  _stopKeepalive() {
    if (this._keepalive) { clearInterval(this._keepalive); this._keepalive = null; }
  }

  close() {
    this._closed = true;
    this._subs.clear();
    this._txSubs.clear();
    this._teardownClient();
  }
}

function isValidOptionalBchHeight(value) {
  return value === null || isValidBchHeight(value);
}
