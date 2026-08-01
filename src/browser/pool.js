import { BrowserFulcrumClient } from './client.js';
import { AllServersFailedError, isTransportFailure } from '../fulcrum/errors.js';
import {
  isServerCoolingDown,
  normalizeHealth,
  rankServers,
  recordFailure,
  recordHeight,
  recordSuccess,
} from '../pool/health.js';
import { MAX_REASONABLE_BCH_HEIGHT, isValidBchHeight } from '../validation.js';
import {
  SubscriptionDelivery,
  MAX_SUBSCRIPTION_TIMER_MS,
  normalizeSubscriptionDeliveryOptions,
} from '../subscriptions/delivery.js';
import { normalizeRecoveryOptions, RetryController } from '../pool/recovery.js';

const KEEPALIVE_MS = 45_000;
const SUBSCRIPTION_CHECK_MS = 30_000;
const SUBSCRIPTION_CHECK_BATCH = 32;
export const MAX_BROWSER_SERVERS = 32;
export const MAX_BROWSER_SUBSCRIPTIONS = 1_000;
export { MAX_REASONABLE_BCH_HEIGHT };

export class BrowserServerPool {
  constructor(servers, opts = {}) {
    if (!Array.isArray(servers) || servers.length === 0) {
      throw new TypeError('at least one browser Fulcrum server is required');
    }
    if (servers.length > MAX_BROWSER_SERVERS) {
      throw new RangeError(`browser Fulcrum pool is limited to ${MAX_BROWSER_SERVERS} servers`);
    }
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._random = typeof opts.random === 'function' ? opts.random : Math.random;
    this._setTimeout = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
    this._clearTimeout = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
    this._recoveryPolicy = normalizeRecoveryOptions(opts, servers.length);
    const healthNow = this._now();
    this.servers = servers.map(server => ({
      ...server,
      health: normalizeHealth(server.health, {
        now: healthNow,
        maxCooldownMs: this._recoveryPolicy.failureBackoffMaxMs,
      }),
      tlsStrict: true,
    }));
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
    this._clientFactory = opts.clientFactory ?? (server => new BrowserFulcrumClient({
      url: server.url,
      network: opts.network,
      timeoutMs: this.timeoutMs,
      WebSocket: opts.WebSocket,
      crypto: opts.crypto,
    }));
    this._events = new Map();
    this._client = null;
    this._current = null;
    this._connecting = null;
    this._failingOver = null;
    this._activeSince = null;
    this._activeStable = false;
    this._everConnected = false;
    this._exhaustedSince = null;
    this._recoveryTimer = null;
    this._recoveryScheduledAt = 0;
    this._subscriptions = new Map();
    this._restoring = false;
    this._stagedStatuses = new Map();
    this._restoreError = null;
    this._keepalive = null;
    this._subscriptionCheck = null;
    this._subscriptionCheckCursor = 0;
    this._subscriptionCheckInFlight = false;
    this._subscriptionCheckGeneration = 0;
    this._closed = false;
  }

  get current() {
    return this._current?.url ?? null;
  }

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
    recordSuccess(server.health, latencyMs, height, {
      now: this._now(),
      clearFailures: false,
    });
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

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('event handler must be a function');
    let handlers = this._events.get(event);
    if (!handlers) {
      handlers = new Set();
      this._events.set(event, handlers);
    }
    handlers.add(fn);
    return this;
  }

  off(event, fn) {
    this._events.get(event)?.delete(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this._events.get(event) ?? []) {
      try { fn(payload); } catch { /* user callback */ }
    }
  }

  async acquire() {
    if (this._closed) throw new Error('pool closed');
    if (this._client?.connected) return this._client;
    if (this._connecting) return this._connecting;
    this._connecting = this._connect().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connect() {
    const errors = [];
    let budgetExhausted = false;
    let eligibleServers = 0;

    for (const server of this.ranked()) {
      if (this._closed) throw new Error('pool closed');
      const attemptAt = this._now();
      if (isServerCoolingDown(server, attemptAt)) continue;
      eligibleServers++;
      if (!this._retryController.take(attemptAt)) {
        budgetExhausted = true;
        break;
      }
      const client = this._clientFactory(server);
      let activated = false;
      let closedDuringSetup = false;
      const startedAt = this._now();
      try {
        await client.connect();
        if (this._closed) throw new Error('pool closed');
        client.onClose(() => {
          if (!activated) {
            closedDuringSetup = true;
            return;
          }
          if (this._closed || this._client !== client) return;
          this._failover('connection closed').catch(() => { /* exhausted event is emitted */ });
        });
        const tip = await client.request('blockchain.headers.subscribe');
        this._recordSetupSuccess(server, this._now() - startedAt, validHeight(tip?.height));

        this._client = client;
        this._current = server;
        client.onNotification((method, params) => {
          if (this._client === client) this._onNotification(method, params);
        });
        await this._restoreSubscriptions(client);
        if (this._closed || closedDuringSetup || !client.connected) {
          throw new Error('connection closed during pool setup');
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
        client.close();
        if (closing) throw new Error('pool closed');
        this.emit('server-lost', { server: server.url, error: err?.message ?? String(err) });
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
      errors: errors.map(error => error?.message ?? String(error)),
      ...(recovery ? { recovery } : {}),
    });
    throw exhausted;
  }

  async request(method, params = []) {
    let lastError;
    const maxAttempts = Math.max(1, this.servers.length);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = await this.acquire();
      const server = this._current;
      const startedAt = this._now();
      try {
        const result = await client.request(method, params);
        this._recordActiveSuccess(server, this._now() - startedAt);
        return result;
      } catch (err) {
        lastError = err;
        if (!isTransportFailure(err) && client.connected) throw err;
        await this._failover(`request failed: ${err?.message ?? String(err)}`);
      }
    }
    throw lastError;
  }

  async killCurrent(reason = 'chaos: killed by operator') {
    if (!this._client?.connected) return this.current;
    await this._failover(reason);
    return this.current;
  }

  _newAddressEntry(address) {
    const entry = {
      callbacks: null,
      observedStatus: null,
      deliveredStatus: null,
      initialized: false,
      initializing: null,
      pendingInitial: null,
    };
    entry.callbacks = new SubscriptionDelivery({
      type: 'address-status',
      key: address,
      ...this._deliveryOptions,
      onDelivered: value => { entry.deliveredStatus = value; },
      onHandlerError: payload => this.emit('handler-error', payload),
    });
    return entry;
  }

  _observeAddress(entry, status, source) {
    if (!entry.initialized || Object.is(status, entry.observedStatus)) return null;
    entry.observedStatus = status;
    return entry.callbacks.observe(status, source);
  }

  async subscribeAddress(address, callback) {
    if (typeof address !== 'string' || address.length === 0 || address.length > 256) {
      throw new TypeError('subscription address must be a non-empty string of at most 256 characters');
    }
    if (typeof callback !== 'function') throw new TypeError('subscription callback must be a function');

    let entry = this._subscriptions.get(address);
    if (!entry) {
      if (this._subscriptions.size >= MAX_BROWSER_SUBSCRIPTIONS) {
        throw new RangeError(`browser subscription limit is ${MAX_BROWSER_SUBSCRIPTIONS}`);
      }
      entry = this._newAddressEntry(address);
      this._subscriptions.set(address, entry);
    }
    entry.callbacks.add(callback);
    if (entry.initialized) return entry.observedStatus;

    if (!entry.initializing) {
      entry.initializing = this.request('blockchain.address.subscribe', [address])
        .then(status => {
          const valid = requireStatus(status);
          entry.observedStatus = valid;
          entry.deliveredStatus = valid;
          entry.callbacks.setBaseline(valid);
          entry.initialized = true;
          const pending = entry.pendingInitial;
          entry.pendingInitial = null;
          if (pending?.client === this._client) {
            this._observeAddress(entry, pending.value, 'notification');
          }
          return entry.observedStatus;
        })
        .finally(() => { entry.initializing = null; });
    }

    try {
      return await entry.initializing;
    } catch (err) {
      entry.callbacks.delete(callback);
      if (entry.callbacks.size === 0) {
        entry.callbacks.close();
        this._subscriptions.delete(address);
      }
      throw err;
    }
  }

  unsubscribeAddress(address, callback) {
    const entry = this._subscriptions.get(address);
    if (!entry) return;
    entry.callbacks.delete(callback);
    if (entry.callbacks.size > 0) return;
    entry.callbacks.close();
    this._subscriptions.delete(address);
    this._client?.request('blockchain.address.unsubscribe', [address]).catch(() => {});
  }

  async _failover(reason) {
    if (this._closed) return;
    if (this._failingOver) return this._failingOver;
    this._failingOver = this._performFailover(reason)
      .finally(() => { this._failingOver = null; });
    return this._failingOver;
  }

  async _performFailover(reason) {
    const from = this.current;
    if (this._current) this._recordServerFailure(this._current);
    this._teardownClient();
    this.emit('failover-start', { from, reason });
    await this.acquire();
    this.emit('failover', { from, to: this.current, reason });
  }

  _onNotification(method, params) {
    if (method === 'blockchain.address.subscribe') {
      const [address, rawStatus] = params ?? [];
      const entry = this._subscriptions.get(address);
      if (!entry) return;
      let status;
      try {
        status = requireStatus(rawStatus);
      } catch (err) {
        if (this._restoring) {
          this._restoreError = err;
          this._client?.close();
          return;
        }
        this._failover('invalid address subscription notification').catch(() => {});
        return;
      }
      if (!entry.initialized) {
        entry.pendingInitial = { client: this._client, value: status };
        return;
      }
      if (this._restoring) {
        this._stagedStatuses.set(address, status);
        return;
      }
      this._observeAddress(entry, status, 'notification');
    } else if (method === 'blockchain.headers.subscribe') {
      const tip = Array.isArray(params) ? params[0] : params;
      if (isValidBchHeight(tip?.height) && this._current) {
        recordHeight(this._current.health, tip.height, this._now());
        this.emit('block', { height: tip.height, hex: typeof tip.hex === 'string' ? tip.hex : null });
      }
    }
  }

  async _restoreSubscriptions(client) {
    this._restoring = true;
    this._stagedStatuses.clear();
    this._restoreError = null;
    try {
      const restored = await this._resubscribeAll();
      if (this._restoreError) throw this._restoreError;
      if (this._client !== client || !client.connected) {
        throw new Error('connection closed during subscription restoration');
      }
      this._commitRestoredSubscriptions(restored);
    } finally {
      this._restoring = false;
      this._stagedStatuses.clear();
      this._restoreError = null;
    }
  }

  async _resubscribeAll() {
    const restored = new Map();
    for (const [address, entry] of this._subscriptions) {
      if (!entry.initialized) continue;
      const fresh = requireStatus(
        await this._client.request('blockchain.address.subscribe', [address]),
      );
      if (this._restoreError) throw this._restoreError;
      restored.set(address, { entry, before: entry.observedStatus, fresh });
    }

    return restored;
  }

  // Commit only after every subscription is restored and the candidate is
  // still live. If a notification arrived during restoration, it is staged
  // and treated as the newest observation. No callback escapes from a
  // candidate that is later rejected because another subscription failed.
  _commitRestoredSubscriptions(restored) {
    for (const [address, { entry, before, fresh }] of restored) {
      if (entry.observedStatus !== before) continue;
      const finalStatus = this._stagedStatuses.has(address)
        ? this._stagedStatuses.get(address)
        : fresh;
      if (finalStatus === before) continue;
      this._observeAddress(entry, finalStatus, 'resubscribe');
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
    const subscriptions = [...this._subscriptions.entries()]
      .filter(([, entry]) => entry.initialized);
    if (subscriptions.length === 0) return;

    const count = Math.min(this.subscriptionCheckBatchSize, subscriptions.length);
    for (let offset = 0; offset < count; offset++) {
      if (this._client !== client || !client.connected || this._closed) return;
      const index = (this._subscriptionCheckCursor + offset) % subscriptions.length;
      const [address, entry] = subscriptions[index];
      try {
        const status = requireStatus(
          await client.request('blockchain.address.subscribe', [address]),
        );
        if (this._client === client) this._observeAddress(entry, status, 'liveness-check');
      } catch (error) {
        if (this._client === client && !this._closed) {
          await this._failover(`subscription liveness check failed: ${error?.message ?? String(error)}`);
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
      this.acquire().catch(() => { /* _connect schedules the next bounded attempt */ });
    }, recovery.delayMs);
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
    let failures = 0;
    let inFlight = false;
    this._keepalive = setInterval(async () => {
      const client = this._client;
      if (!client?.connected || inFlight) return;
      const server = this._current;
      const startedAt = this._now();
      inFlight = true;
      try {
        await client.request('server.ping');
        failures = 0;
        if (this._client === client && server) {
          this._recordActiveSuccess(server, this._now() - startedAt);
        }
      } catch {
        failures++;
        if (failures >= 2 && this._client === client) {
          failures = 0;
          this._failover('keepalive failed twice').catch(() => { /* exhausted event is emitted */ });
        }
      } finally {
        inFlight = false;
      }
    }, this.keepaliveMs);
  }

  _stopKeepalive() {
    if (this._keepalive) {
      clearInterval(this._keepalive);
      this._keepalive = null;
    }
  }

  _teardownClient() {
    this._stopKeepalive();
    this._stopSubscriptionChecks();
    this._activeSince = null;
    this._activeStable = false;
    const client = this._client;
    this._client = null;
    this._current = null;
    client?.close();
  }

  close() {
    this._closed = true;
    this._cancelRecovery();
    for (const entry of this._subscriptions.values()) entry.callbacks.close();
    this._subscriptions.clear();
    this._teardownClient();
    this._events.clear();
  }
}

function validHeight(value) {
  return isValidBchHeight(value) ? value : null;
}

function requireStatus(value) {
  if (value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value))) {
    return value;
  }
  throw new TypeError('server returned an invalid Electrum address status');
}
