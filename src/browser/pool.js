import { BrowserFulcrumClient } from './client.js';
import { AllServersFailedError, isTransportFailure } from '../fulcrum/errors.js';
import {
  newHealth,
  rankServers,
  recordFailure,
  recordHeight,
  recordSuccess,
} from '../pool/health.js';
import { MAX_REASONABLE_BCH_HEIGHT, isValidBchHeight } from '../validation.js';

const KEEPALIVE_MS = 45_000;
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
    this.servers = servers.map(server => ({
      ...server,
      health: server.health ?? newHealth(),
      tlsStrict: true,
    }));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;
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
    this._subscriptions = new Map();
    this._restoring = false;
    this._stagedStatuses = new Map();
    this._restoreError = null;
    this._keepalive = null;
    this._closed = false;
  }

  get current() {
    return this._current?.url ?? null;
  }

  ranked() {
    return rankServers(this.servers);
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

    for (const server of this.ranked()) {
      const client = this._clientFactory(server);
      const startedAt = Date.now();
      try {
        await client.connect();
        const tip = await client.request('blockchain.headers.subscribe');
        recordSuccess(server.health, Date.now() - startedAt, validHeight(tip?.height));

        this._client = client;
        this._current = server;
        client.onNotification((method, params) => this._onNotification(method, params));
        await this._restoreSubscriptions();
        client.onClose(() => {
          if (this._closed || this._client !== client) return;
          this._failover('connection closed').catch(() => { /* exhausted event is emitted */ });
        });
        if (!client.connected) throw new Error('connection closed during pool setup');
        this._startKeepalive();

        return client;
      } catch (err) {
        recordFailure(server.health);
        errors.push(err);
        client.close();
        if (this._client === client) this._teardownClient();
        this.emit('server-lost', { server: server.url, error: err?.message ?? String(err) });
      }
    }

    const exhausted = new AllServersFailedError(errors);
    this.emit('exhausted', { errors: errors.map(error => error?.message ?? String(error)) });
    throw exhausted;
  }

  async request(method, params = []) {
    let lastError;
    const maxAttempts = Math.max(1, this.servers.length);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = await this.acquire();
      const server = this._current;
      const startedAt = Date.now();
      try {
        const result = await client.request(method, params);
        recordSuccess(server.health, Date.now() - startedAt);
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
      entry = {
        callbacks: new Set(),
        lastStatus: null,
        initialized: false,
        initializing: null,
      };
      this._subscriptions.set(address, entry);
    }
    entry.callbacks.add(callback);
    if (entry.initialized) return entry.lastStatus;

    if (!entry.initializing) {
      entry.initializing = this.request('blockchain.address.subscribe', [address])
        .then(status => {
          const valid = requireStatus(status);
          entry.lastStatus = valid;
          entry.initialized = true;
          return valid;
        })
        .finally(() => { entry.initializing = null; });
    }

    try {
      return await entry.initializing;
    } catch (err) {
      entry.callbacks.delete(callback);
      if (entry.callbacks.size === 0) this._subscriptions.delete(address);
      throw err;
    }
  }

  unsubscribeAddress(address, callback) {
    const entry = this._subscriptions.get(address);
    if (!entry) return;
    entry.callbacks.delete(callback);
    if (entry.callbacks.size > 0) return;
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
    if (this._current) recordFailure(this._current.health);
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
      if (this._restoring) {
        this._stagedStatuses.set(address, status);
        return;
      }
      if (!entry.initialized || status === entry.lastStatus) return;
      entry.lastStatus = status;
      for (const callback of entry.callbacks) {
        try { callback(status); } catch { /* user callback */ }
      }
    } else if (method === 'blockchain.headers.subscribe') {
      const tip = Array.isArray(params) ? params[0] : params;
      if (isValidBchHeight(tip?.height) && this._current) {
        recordHeight(this._current.health, tip.height);
        this.emit('block', { height: tip.height, hex: typeof tip.hex === 'string' ? tip.hex : null });
      }
    }
  }

  async _restoreSubscriptions() {
    this._restoring = true;
    this._stagedStatuses.clear();
    this._restoreError = null;
    try {
      await this._resubscribeAll();
      if (this._restoreError) throw this._restoreError;
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
      restored.set(address, { entry, before: entry.lastStatus, fresh });
    }

    // Commit only after every subscription is restored. If a notification
    // arrived during restoration, it is staged and treated as the newest
    // observation. No callback escapes from a candidate that is later
    // rejected because another subscription failed.
    for (const [address, { entry, before, fresh }] of restored) {
      if (entry.lastStatus !== before) continue;
      const finalStatus = this._stagedStatuses.has(address)
        ? this._stagedStatuses.get(address)
        : fresh;
      if (finalStatus === before) continue;
      entry.lastStatus = finalStatus;
      for (const callback of entry.callbacks) {
        try { callback(finalStatus); } catch { /* user callback */ }
      }
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    let failures = 0;
    let inFlight = false;
    this._keepalive = setInterval(async () => {
      const client = this._client;
      if (!client?.connected || inFlight) return;
      inFlight = true;
      try {
        await client.request('server.ping');
        failures = 0;
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
    const client = this._client;
    this._client = null;
    this._current = null;
    client?.close();
  }

  close() {
    this._closed = true;
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
