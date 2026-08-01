/**
 * src/pool/pool.js
 *
 * ServerPool — the reliability core. One live connection to the
 * best-scoring server, transparent failover when it dies, and
 * subscriptions that RESURRECT on the replacement server.
 *
 * The resurrection detail behind `watch`: for every subscription the pool
 * tracks upstream observation separately from callback acknowledgement.
 * After failover it resubscribes on the new server; a changed state enters
 * the same acknowledged, retryable delivery path as a live notification.
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
import { verifyBchChain } from '../fulcrum/chain.js';
import { AllServersFailedError, isTransportFailure } from '../fulcrum/errors.js';
import {
  isServerCoolingDown,
  normalizeHealth,
  recordSuccess,
  recordFailure,
  recordHeight,
  rankServers,
} from './health.js';
import { requireAllowedTransport, serverName } from './transport.js';
import { isValidBchHeight, isValidElectrumAddressStatus } from '../validation.js';
import { getNetwork } from '../networks.js';
import {
  SubscriptionDelivery,
  MAX_SUBSCRIPTION_TIMER_MS,
  normalizeSubscriptionDeliveryOptions,
} from '../subscriptions/delivery.js';
import { normalizeRecoveryOptions, RetryController } from './recovery.js';

const KEEPALIVE_MS = 45_000;
const SUBSCRIPTION_CHECK_MS = 30_000;
const SUBSCRIPTION_CHECK_BATCH = 32;

export class ServerPool extends EventEmitter {
  /**
   * @param {Array} servers — discovery records ({ host, ports, tlsStrict,
   *        health?, ... }) or curated entries ({ host, ports: { ssl, tcp } })
   * @param {{ network?: 'mainnet'|'chipnet'|'testnet4',
   *           timeoutMs?: number, keepaliveMs?: number,
   *           subscriptionCheckMs?: number, subscriptionCheckBatchSize?: number,
   *           handlerRetryBaseMs?: number, handlerRetryMaxMs?: number,
   *           handlerTimeoutMs?: number,
   *           failureBackoffBaseMs?: number, failureBackoffMaxMs?: number,
   *           minHealthyUptimeMs?: number,
   *           retryBudgetAttempts?: number, retryBudgetWindowMs?: number,
   *           recoveryBackoffBaseMs?: number, recoveryBackoffMaxMs?: number,
   *           allowInsecureTransport?: boolean,
   *           clientFactory?: (server: object) => object,
   *           now?: () => number, random?: () => number }} [opts]
   */
  constructor(servers, opts = {}) {
    super();
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._random = typeof opts.random === 'function' ? opts.random : Math.random;
    this._setTimeout = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
    this._clearTimeout = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
    this._recoveryPolicy = normalizeRecoveryOptions(opts, servers.length);
    const healthNow = this._now();
    this.servers = servers.map(s => ({
      ...s,
      health: normalizeHealth(s.health, {
        now: healthNow,
        maxCooldownMs: this._recoveryPolicy.failureBackoffMaxMs,
      }),
      tlsStrict: s.tlsStrict ?? true, // curated entries are hostname+valid-cert
    }));
    this.network = getNetwork(opts.network ?? servers[0]?.network ?? 'mainnet').name;
    this.allowInsecureTransport = opts.allowInsecureTransport === true;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;
    this.subscriptionCheckMs = opts.subscriptionCheckMs ?? SUBSCRIPTION_CHECK_MS;
    this.subscriptionCheckBatchSize = opts.subscriptionCheckBatchSize ?? SUBSCRIPTION_CHECK_BATCH;
    if (!Number.isInteger(this.subscriptionCheckMs) || this.subscriptionCheckMs < 1 || this.subscriptionCheckMs > MAX_SUBSCRIPTION_TIMER_MS) {
      throw new RangeError(`subscriptionCheckMs must be an integer from 1 to ${MAX_SUBSCRIPTION_TIMER_MS}`);
    }
    if (!Number.isInteger(this.subscriptionCheckBatchSize) || this.subscriptionCheckBatchSize < 1 || this.subscriptionCheckBatchSize > 256) {
      throw new RangeError('subscriptionCheckBatchSize must be an integer from 1 to 256');
    }
    this._deliveryOptions = normalizeSubscriptionDeliveryOptions({
      retryBaseMs: opts.handlerRetryBaseMs,
      retryMaxMs: opts.handlerRetryMaxMs,
      handlerTimeoutMs: opts.handlerTimeoutMs,
    });
    this._retryController = new RetryController(this._recoveryPolicy, { random: this._random });
    this._clientFactory = opts.clientFactory ?? ((server) => {
      const target = requireAllowedTransport(server, {
        allowInsecureTransport: this.allowInsecureTransport,
      });
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
    this._failingOver = null;   // one teardown/reconnect transition at a time
    this._activeSince = null;
    this._activeStable = false;
    this._everConnected = false;
    this._exhaustedSince = null;
    this._recoveryTimer = null;
    this._recoveryScheduledAt = 0;
    this._subs = new Map();     // address → observed + acknowledged delivery state
    this._txSubs = new Map();   // txid → observed + acknowledged delivery state
    this._keepalive = null;
    this._subscriptionCheck = null;
    this._subscriptionCheckCursor = 0;
    this._subscriptionCheckInFlight = false;
    this._subscriptionCheckGeneration = 0;
    this._restoring = false;
    this._stagedAddressStatuses = new Map();
    this._stagedTransactionHeights = new Map();
    this._restoreError = null;
    this._closed = false;
  }

  /** Name of the currently connected server, or null. */
  get current() {
    return serverName(this._current);
  }

  /** Health-ranked snapshot (does not mutate pool order). */
  ranked() {
    return rankServers(this.servers, this._now());
  }

  _recordServerFailure(server) {
    if (!server) return;
    recordFailure(server.health, {
      now: this._now(),
      random: this._random,
      failureBackoffBaseMs: this._recoveryPolicy.failureBackoffBaseMs,
      failureBackoffMaxMs: this._recoveryPolicy.failureBackoffMaxMs,
    });
  }

  _recordSetupSuccess(server, latencyMs, height = null) {
    const now = this._now();
    recordSuccess(server.health, latencyMs, height, { now, clearFailures: false });
  }

  _recordActiveSuccess(server, latencyMs, height = null) {
    const now = this._now();
    const stable = server === this._current
      && this._activeSince !== null
      && (now - this._activeSince) >= this._recoveryPolicy.minHealthyUptimeMs;
    recordSuccess(server.health, latencyMs, height, { now, clearFailures: stable });
    if (stable && !this._activeStable) {
      this._activeStable = true;
      this._retryController.noteStable(now);
      this.emit('server-stable', { server: this.current, uptimeMs: now - this._activeSince });
    }
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
    let budgetExhausted = false;
    let eligibleServers = 0;

    for (const server of this.ranked()) {
      if (this._closed) throw new Error('pool closed');
      if (exclude.has(serverName(server))) continue;
      const attemptAt = this._now();
      if (isServerCoolingDown(server, attemptAt)) continue;
      eligibleServers++;
      if (!this._retryController.take(attemptAt)) {
        budgetExhausted = true;
        break;
      }
      let client;
      let activated = false;
      const t0 = this._now();
      try {
        // Enforce the transport policy before even a custom factory can dial.
        requireAllowedTransport(server, {
          allowInsecureTransport: this.allowInsecureTransport,
        });
        client = this._clientFactory(server);
        await client.connect();
        if (this._closed) throw new Error('pool closed');
        let closedDuringSetup = false;
        const c = client;
        c._socket?.once('close', () => {
          if (this._closed) return;
          if (!activated) {
            closedDuringSetup = true;
          } else if (this._client === c) {
            this._failover('connection closed').catch(() => { /* exhausted → emitted */ });
          }
        });
        // Security boundary: this exact live socket cannot become active until
        // it proves the selected BCH network's fork checkpoints.
        await verifyBchChain(client, this.network);
        client.onNotification((method, params) => {
          if (this._client === client) this._onNotify(method, params);
        });
        // Height tracking also warms the header subscription. Setup errors are
        // not optional: a socket that died after its proof must never become
        // the active client.
        const tip = await client.request('blockchain.headers.subscribe');
        if (this._closed || closedDuringSetup || !client.connected) {
          const err = new Error('connection closed during verified pool setup');
          err.kind = 'transport';
          throw err;
        }

        this._recordSetupSuccess(server, this._now() - t0);
        this._client = client;
        this._current = server;
        if (tip?.height != null) recordHeight(server.health, tip.height, this._now());

        this._restoring = true;
        this._stagedAddressStatuses.clear();
        this._stagedTransactionHeights.clear();
        this._restoreError = null;
        try {
          const restored = await this._resubscribeAll();
          if (this._restoreError) throw this._restoreError;
          if (this._closed || closedDuringSetup || !client.connected) {
            const err = new Error('connection closed during verified pool setup');
            err.kind = 'transport';
            throw err;
          }
          this._commitRestoredSubscriptions(restored);
        } finally {
          this._restoring = false;
          this._stagedAddressStatuses.clear();
          this._stagedTransactionHeights.clear();
          this._restoreError = null;
        }
        activated = true;
        this._activeSince = this._now();
        this._activeStable = false;
        this._everConnected = true;
        this._cancelRecovery();
        this._startKeepalive();
        this._startSubscriptionChecks();

        if (this._exhaustedSince !== null) {
          const exhaustedSince = this._exhaustedSince;
          this._exhaustedSince = null;
          this.emit('recovered', {
            server: this.current,
            outageMs: Math.max(0, this._now() - exhaustedSince),
          });
        }

        if (previous && previous !== this.current) {
          this.emit('failover', { from: previous, to: this.current, reason: 'reconnect' });
        }
        return client;
      } catch (err) {
        const closing = this._closed;
        if (!closing) {
          this._recordServerFailure(server);
          errors.push(err);
        }
        if (this._client === client) {
          this._stopKeepalive();
          this._stopSubscriptionChecks();
          this._client = null;
          this._current = null;
        }
        client?.close();
        if (closing) throw new Error('pool closed');
        this.emit('server-lost', { server: `${server.host}`, error: err.message });
      }
    }

    if (budgetExhausted) errors.push(new Error('global Fulcrum connection retry budget exhausted'));
    if (eligibleServers === 0 && errors.length === 0) {
      errors.push(new Error('all eligible Fulcrum server circuits are cooling down'));
    }

    const exhausted = new AllServersFailedError(errors);
    if (this._everConnected && this._exhaustedSince === null) this._exhaustedSince = this._now();
    const recovery = this._scheduleRecovery();
    if (recovery) {
      exhausted.retryAt = recovery.retryAt;
      exhausted.retryAfterMs = recovery.delayMs;
    }
    this.emit('exhausted', {
      errors: errors.map(e => e.message),
      ...(recovery ? { recovery } : {}),
    });
    throw exhausted;
  }

  async _failover(reason, opts = {}) {
    if (this._closed) return;
    if (this._failingOver) return this._failingOver;
    this._failingOver = this._performFailover(reason, opts)
      .finally(() => { this._failingOver = null; });
    return this._failingOver;
  }

  async _performFailover(reason, opts = {}) {
    const from = this.current;
    if (this._current) this._recordServerFailure(this._current);
    this._teardownClient();
    this.emit('failover-start', { from, reason });
    await this.acquire({ exclude: opts.exclude ?? new Set() });
    this.emit('failover', { from, to: this.current, reason });
  }

  _teardownClient() {
    this._stopKeepalive();
    this._stopSubscriptionChecks();
    this._activeSince = null;
    this._activeStable = false;
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
      const t0 = this._now();
      try {
        const value = await client.request(method, params);
        this._recordActiveSuccess(server, this._now() - t0);
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

  _newDelivery(type, key, onDelivered) {
    return new SubscriptionDelivery({
      type,
      key,
      ...this._deliveryOptions,
      onDelivered,
      onHandlerError: payload => this.emit('handler-error', payload),
    });
  }

  _newAddressEntry(address) {
    const entry = {
      initialized: false,
      observedStatus: null,
      deliveredStatus: null,
      initializing: null,
      pendingInitial: null,
      delivery: null,
    };
    entry.delivery = this._newDelivery('address-status', address, value => {
      entry.deliveredStatus = value;
    });
    return entry;
  }

  _newTransactionEntry(txid) {
    const entry = {
      initialized: false,
      observedHeight: null,
      deliveredHeight: null,
      initializing: null,
      pendingInitial: null,
      delivery: null,
    };
    entry.delivery = this._newDelivery('transaction-height', txid, value => {
      entry.deliveredHeight = value;
    });
    return entry;
  }

  _observeAddress(entry, status, source) {
    if (!entry.initialized || Object.is(status, entry.observedStatus)) return null;
    entry.observedStatus = status;
    return entry.delivery.observe(status, source);
  }

  _observeTransaction(entry, height, source) {
    if (!entry.initialized || Object.is(height, entry.observedHeight)) return null;
    entry.observedHeight = height;
    return entry.delivery.observe(height, source);
  }

  /**
   * Subscribe to an address. Survives failover: resubscribed automatically,
   * and a status change that happened during the gap fires cb immediately.
   *
   * @param {string} address — cashaddr
   * @param {(status: string|null, event: object) => void|Promise<void>} cb
   * @returns {Promise<string|null>} current status hash
   */
  async subscribeAddress(address, cb) {
    if (typeof cb !== 'function') throw new TypeError('subscription callback must be a function');
    let entry = this._subs.get(address);
    if (!entry) {
      // `initialized: false` keeps _resubscribeAll from touching this entry
      // until the initial subscribe below establishes the status baseline —
      // otherwise a concurrent failover would fire cb with the FIRST status
      // as if it were a change.
      entry = this._newAddressEntry(address);
      this._subs.set(address, entry);
    }
    entry.delivery.add(cb);
    if (entry.initialized) return entry.observedStatus;

    // Concurrent subscribers share one baseline request. Otherwise a status
    // change between two initial requests could be silently installed as a
    // second baseline instead of delivered as a change.
    if (!entry.initializing) {
      entry.initializing = this._initializeAddress(address, entry)
        .finally(() => { entry.initializing = null; });
    }
    try {
      return await entry.initializing;
    } catch (err) {
      entry.delivery.delete(cb);
      if (entry.delivery.size === 0) {
        entry.delivery.close();
        this._subs.delete(address);
      }
      throw err;
    }
  }

  async _initializeAddress(address, entry) {
    const maxAttempts = Math.max(1, this.servers.length);
    const excluded = new Set();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await this.request('blockchain.address.subscribe', [address]);
      if (isValidElectrumAddressStatus(status)) {
        entry.observedStatus = status;
        entry.deliveredStatus = status;
        entry.delivery.setBaseline(status);
        entry.initialized = true;
        const pending = entry.pendingInitial;
        entry.pendingInitial = null;
        if (pending?.client === this._client) {
          this._observeAddress(entry, pending.value, 'notification');
        }
        return entry.observedStatus;
      }
      if (attempt < maxAttempts - 1) {
        if (this.current) excluded.add(this.current);
        await this._failover('invalid address subscription status', { exclude: excluded });
        continue;
      }
      throw new TypeError('server returned an invalid Electrum address status');
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
    entry.delivery.delete(cb);
    if (entry.delivery.size === 0) {
      entry.delivery.close();
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
   * @param {(height: number|null, event: object) => void|Promise<void>} cb
   * @returns {Promise<number|null>} current height (0/null = unconfirmed)
   */
  async subscribeTransaction(txid, cb) {
    if (typeof cb !== 'function') throw new TypeError('subscription callback must be a function');
    let entry = this._txSubs.get(txid);
    if (!entry) {
      entry = this._newTransactionEntry(txid);
      this._txSubs.set(txid, entry);
    }
    entry.delivery.add(cb);
    if (entry.initialized) return entry.observedHeight;

    if (!entry.initializing) {
      entry.initializing = this._initializeTransaction(txid, entry)
        .finally(() => { entry.initializing = null; });
    }
    try {
      return await entry.initializing;
    } catch (err) {
      entry.delivery.delete(cb);
      if (entry.delivery.size === 0) {
        entry.delivery.close();
        this._txSubs.delete(txid);
      }
      throw err;
    }
  }

  async _initializeTransaction(txid, entry) {
    const maxAttempts = Math.max(1, this.servers.length);
    const excluded = new Set();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const height = await this.request('blockchain.transaction.subscribe', [txid]);
      if (isValidOptionalBchHeight(height)) {
        const baseline = height ?? null;
        entry.observedHeight = baseline;
        entry.deliveredHeight = baseline;
        entry.delivery.setBaseline(baseline);
        entry.initialized = true;
        const pending = entry.pendingInitial;
        entry.pendingInitial = null;
        if (pending?.client === this._client) {
          this._observeTransaction(entry, pending.value, 'notification');
        }
        return entry.observedHeight;
      }
      if (attempt < maxAttempts - 1) {
        if (this.current) excluded.add(this.current);
        await this._failover('invalid transaction subscription height', { exclude: excluded });
        continue;
      }
      throw new TypeError('server returned an invalid BCH transaction height');
    }
  }

  /** Remove one tx callback (server-side interest cleared when none remain). */
  unsubscribeTransaction(txid, cb) {
    const entry = this._txSubs.get(txid);
    if (!entry) return;
    entry.delivery.delete(cb);
    if (entry.delivery.size === 0) {
      entry.delivery.close();
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
      if (fresh !== entry.observedStatus) addressChanges.push({ entry, fresh });
    }

    const txChanges = [];
    for (const [txid, entry] of this._txSubs) {
      if (!entry.initialized) continue;
      const height = await this._client.request('blockchain.transaction.subscribe', [txid]);
      if (!isValidOptionalBchHeight(height)) {
        throw new TypeError('server returned an invalid BCH transaction height');
      }
      const fresh = height ?? null;
      if (fresh !== entry.observedHeight) txChanges.push({ entry, fresh });
    }

    return { addressChanges, txChanges };
  }

  // Commit only after every subscription is live and the candidate socket is
  // still healthy. Notifications received during restoration are staged, so
  // no callback can escape from a candidate rejected later in setup.
  _commitRestoredSubscriptions({ addressChanges, txChanges }) {
    const changedAddressEntries = new Set(addressChanges.map(change => change.entry));
    const changedTransactionEntries = new Set(txChanges.map(change => change.entry));
    for (const { entry, fresh } of addressChanges) {
      const finalStatus = this._stagedAddressStatuses.has(entry)
        ? this._stagedAddressStatuses.get(entry)
        : fresh;
      this._observeAddress(entry, finalStatus, 'resubscribe');
    }
    for (const { entry, fresh } of txChanges) {
      const finalHeight = this._stagedTransactionHeights.has(entry)
        ? this._stagedTransactionHeights.get(entry)
        : fresh;
      this._observeTransaction(entry, finalHeight, 'resubscribe');
    }

    // A staged notification may carry a change even when the synchronous
    // subscribe response matched the previous observation.
    for (const [entry, status] of this._stagedAddressStatuses) {
      if (!changedAddressEntries.has(entry)) {
        this._observeAddress(entry, status, 'resubscribe');
      }
    }
    for (const [entry, height] of this._stagedTransactionHeights) {
      if (!changedTransactionEntries.has(entry)) {
        this._observeTransaction(entry, height, 'resubscribe');
      }
    }
  }

  _onNotify(method, params) {
    if (method === 'blockchain.address.subscribe') {
      const [address, status] = params ?? [];
      const entry = this._subs.get(address);
      if (!entry) return;
      if (!isValidElectrumAddressStatus(status)) {
        if (this._restoring) {
          this._restoreError = new TypeError('server returned an invalid Electrum address status during restoration');
          this._client?.close();
          return;
        }
        this._failover('invalid address subscription status', {
          exclude: new Set(this.current ? [this.current] : []),
        }).catch(() => {});
        return;
      }
      if (!entry.initialized) {
        entry.pendingInitial = { client: this._client, value: status };
        return;
      }
      if (this._restoring) {
        this._stagedAddressStatuses.set(entry, status);
        return;
      }
      this._observeAddress(entry, status, 'notification');
    } else if (method === 'blockchain.transaction.subscribe') {
      const [txid, height] = params ?? [];
      const entry = this._txSubs.get(txid);
      if (!entry) return;
      if (!isValidOptionalBchHeight(height)) {
        if (this._restoring) {
          this._restoreError = new TypeError('server returned an invalid BCH transaction height during restoration');
          this._client?.close();
          return;
        }
        this._failover('invalid transaction subscription height', {
          exclude: new Set(this.current ? [this.current] : []),
        }).catch(() => {});
        return;
      }
      if (!entry.initialized) {
        entry.pendingInitial = { client: this._client, value: height ?? null };
        return;
      }
      if (this._restoring) {
        this._stagedTransactionHeights.set(entry, height ?? null);
        return;
      }
      this._observeTransaction(entry, height ?? null, 'notification');
    } else if (method === 'blockchain.headers.subscribe') {
      const tip = Array.isArray(params) ? params[0] : params;
      if (isValidBchHeight(tip?.height) && this._current) {
        recordHeight(this._current.health, tip.height, this._now());
        this.emit('block', { height: tip.height, hex: tip.hex ?? null });
      }
    }
  }

  _startSubscriptionChecks() {
    this._stopSubscriptionChecks();
    const generation = this._subscriptionCheckGeneration;
    this._subscriptionCheck = setInterval(() => {
      if (this._subscriptionCheckInFlight || this._closed) return;
      this._subscriptionCheckInFlight = true;
      this._checkSubscriptionBatch()
        .catch(() => { /* failover/exhausted is emitted by the pool */ })
        .finally(() => {
          if (this._subscriptionCheckGeneration === generation) {
            this._subscriptionCheckInFlight = false;
          }
        });
    }, this.subscriptionCheckMs);
    this._subscriptionCheck.unref?.();
  }

  async _checkSubscriptionBatch() {
    const client = this._client;
    if (!client?.connected) return;
    const subscriptions = [
      ...[...this._subs.entries()]
        .filter(([, entry]) => entry.initialized)
        .map(([key, entry]) => ({ kind: 'address', key, entry })),
      ...[...this._txSubs.entries()]
        .filter(([, entry]) => entry.initialized)
        .map(([key, entry]) => ({ kind: 'transaction', key, entry })),
    ];
    if (subscriptions.length === 0) return;

    const count = Math.min(this.subscriptionCheckBatchSize, subscriptions.length);
    for (let offset = 0; offset < count; offset++) {
      if (this._client !== client || !client.connected || this._closed) return;
      const index = (this._subscriptionCheckCursor + offset) % subscriptions.length;
      const item = subscriptions[index];
      try {
        if (item.kind === 'address') {
          const status = await client.request('blockchain.address.subscribe', [item.key]);
          if (!isValidElectrumAddressStatus(status)) {
            throw new TypeError('server returned an invalid Electrum address status during liveness check');
          }
          if (this._client === client) this._observeAddress(item.entry, status, 'liveness-check');
        } else {
          const height = await client.request('blockchain.transaction.subscribe', [item.key]);
          if (!isValidOptionalBchHeight(height)) {
            throw new TypeError('server returned an invalid BCH transaction height during liveness check');
          }
          if (this._client === client) this._observeTransaction(item.entry, height ?? null, 'liveness-check');
        }
      } catch (error) {
        if (this._client === client && !this._closed) {
          await this._failover(`subscription liveness check failed: ${error?.message ?? String(error)}`, {
            exclude: new Set(this.current ? [this.current] : []),
          });
        }
        return;
      }
    }
    this._subscriptionCheckCursor = (this._subscriptionCheckCursor + count) % subscriptions.length;
  }

  _stopSubscriptionChecks() {
    this._subscriptionCheckGeneration++;
    if (this._subscriptionCheck) {
      clearInterval(this._subscriptionCheck);
      this._subscriptionCheck = null;
    }
    this._subscriptionCheckInFlight = false;
  }

  _earliestCircuitAt(now) {
    let earliest = Infinity;
    for (const server of this.servers) {
      const until = Number.isFinite(server.health.cooldownUntil)
        ? server.health.cooldownUntil
        : now;
      earliest = Math.min(earliest, Math.max(now, until));
    }
    return Number.isFinite(earliest) ? earliest : now;
  }

  _scheduleRecovery() {
    if (this._closed || !this._everConnected) return null;
    if (this._recoveryTimer !== null) {
      return {
        attempt: this._retryController.recoveryFailures,
        delayMs: Math.max(1, this._recoveryScheduledAt - this._now()),
        retryAt: this._recoveryScheduledAt,
      };
    }

    const now = this._now();
    const recovery = this._retryController.noteExhaustion(now, this._earliestCircuitAt(now));
    this._recoveryScheduledAt = recovery.retryAt;
    this._recoveryTimer = this._setTimeout(() => {
      this._recoveryTimer = null;
      this._recoveryScheduledAt = 0;
      if (this._closed || this._client?.connected) return;
      this.acquire().catch(() => { /* _connect emits exhaustion and schedules the next bounded attempt */ });
    }, recovery.delayMs);
    this._recoveryTimer.unref?.();
    this.emit('recovery-scheduled', recovery);
    return recovery;
  }

  _cancelRecovery() {
    if (this._recoveryTimer !== null) this._clearTimeout(this._recoveryTimer);
    this._recoveryTimer = null;
    this._recoveryScheduledAt = 0;
  }

  _startKeepalive() {
    this._stopKeepalive();
    let pingFailures = 0;
    this._keepalive = setInterval(async () => {
      const client = this._client;
      if (!client?.connected) return;
      const server = this._current;
      const startedAt = this._now();
      try {
        await client.request('server.ping');
        pingFailures = 0;
        if (this._client === client && server) {
          this._recordActiveSuccess(server, this._now() - startedAt);
        }
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
    this._cancelRecovery();
    for (const entry of this._subs.values()) entry.delivery.close();
    for (const entry of this._txSubs.values()) entry.delivery.close();
    this._subs.clear();
    this._txSubs.clear();
    this._teardownClient();
  }
}

function isValidOptionalBchHeight(value) {
  return value === null || isValidBchHeight(value);
}
