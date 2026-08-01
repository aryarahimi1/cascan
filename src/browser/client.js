import { getNetwork } from '../networks.js';
import { requireBchBlockHeaderHex } from '../validation.js';

export const BROWSER_CLIENT_NAME = 'cascan-browser/0.4.0-beta.0';
export const BROWSER_PROTOCOL_RANGE = ['1.4', '1.6'];

const MIB = 1024 * 1024;
const RATE_WINDOW_MS = 1_000;

export const BROWSER_CLIENT_LIMITS = Object.freeze({
  messageBytes: 2 * MIB,
  hardMessageBytes: 8 * MIB,
  recordsPerMessage: 256,
  queuedRecords: 512,
  dispatchBatchSize: 16,
  recordsPerSecond: 256,
  notificationsPerSecond: 128,
  responseRecords: 10_000,
  pendingRequests: 64,
  notificationHandlers: 8,
  closeHandlers: 8,
});

export class BrowserFulcrumError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'BrowserFulcrumError';
    this.server = opts.server;
    this.method = opts.method;
    this.kind = opts.kind;
    this.code = opts.code;
  }
}

/**
 * Electrum/Fulcrum JSON-RPC over the browser's native WebSocket.
 * WebSocket framing, TLS, certificate checks, pings, and fragmentation are
 * deliberately left to the browser.
 */
export class BrowserFulcrumClient {
  static MAX_MESSAGE_BYTES = BROWSER_CLIENT_LIMITS.messageBytes;
  static HARD_MAX_MESSAGE_BYTES = BROWSER_CLIENT_LIMITS.hardMessageBytes;

  constructor(opts = {}) {
    const url = parseServerUrl(opts.url, opts.allowInsecure === true);
    const WebSocketImpl = opts.WebSocket ?? globalThis.WebSocket;
    if (typeof WebSocketImpl !== 'function') {
      throw new BrowserFulcrumError('WebSocket is unavailable in this environment', { kind: 'configuration' });
    }

    this.url = url.href;
    this.name = opts.name ?? url.host;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.network = getNetwork(opts.network ?? 'mainnet');
    this.verifyChain = opts.verifyChain !== false;
    this._limits = normalizeBrowserClientLimits(opts);
    this._crypto = opts.crypto ?? globalThis.crypto;
    this._WebSocket = WebSocketImpl;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._setTimeout = typeof opts.setTimeout === 'function'
      ? opts.setTimeout
      : (...args) => globalThis.setTimeout(...args);
    this._clearTimeout = typeof opts.clearTimeout === 'function'
      ? opts.clearTimeout
      : handle => globalThis.clearTimeout(handle);
    this._encoder = new TextEncoder();
    this._socket = null;
    this._connecting = null;
    this._cancelOpen = null;
    this._nextId = 1;
    this._pending = new Map();
    this._notifyHandlers = new Set();
    this._closeHandlers = new Set();
    this._messageQueue = [];
    this._queuedRecords = 0;
    this._queuedBytes = 0;
    this._drainTimer = null;
    this._recordRate = new TokenBucket(
      this._limits.recordsPerSecond,
      RATE_WINDOW_MS,
      this._now(),
    );
    this._notificationRate = new TokenBucket(
      this._limits.notificationsPerSecond,
      RATE_WINDOW_MS,
      this._now(),
    );
    this.serverVersion = null;
    this.chainVerified = false;
    this.connected = false;
    this._closed = false;
  }

  async connect() {
    if (this._closed) throw this._transportError('client closed');
    if (this.connected) return this;
    if (this._connecting) return this._connecting;
    this._connecting = this._open().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _open() {
    let socket;
    try {
      socket = new this._WebSocket(this.url);
    } catch (err) {
      throw this._transportError(err);
    }
    this._socket = socket;

    await new Promise((resolve, reject) => {
      let settled = false;
      const rejectOpen = (error) => {
        if (settled) return;
        settled = true;
        this._cancelOpen = null;
        this._clearTimeout(timer);
        try { socket.close(); } catch { /* constructor-owned socket */ }
        reject(this._transportError(error));
      };
      const timer = this._setTimeout(() => {
        rejectOpen(`connect timeout after ${this.timeoutMs}ms`);
      }, this.timeoutMs);
      this._cancelOpen = () => rejectOpen('connection closed during handshake');

      socket.onopen = () => {
        if (settled) return;
        if (this._closed || this._socket !== socket) {
          rejectOpen('connection closed during handshake');
          return;
        }
        settled = true;
        this._cancelOpen = null;
        this._clearTimeout(timer);
        this.connected = true;
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        this._cancelOpen = null;
        this._clearTimeout(timer);
        if (this._socket === socket) this._socket = null;
        try { socket.close(); } catch { /* failed handshake */ }
        reject(this._transportError('websocket connection failed'));
      };
      socket.onclose = () => {
        if (!settled) {
          settled = true;
          this._cancelOpen = null;
          this._clearTimeout(timer);
          reject(this._transportError('connection closed during handshake'));
        }
        if (this._socket !== socket) return;
        this._socket = null;
        this._handleClose();
      };
      socket.onmessage = (event) => {
        if (this._socket === socket) this._onMessage(event.data);
      };
    });

    try {
      this.serverVersion = await this.request('server.version', [
        BROWSER_CLIENT_NAME,
        BROWSER_PROTOCOL_RANGE,
      ]);
      if (this._closed) throw this._transportError('client closed');
      if (this.verifyChain) await this._verifyChain();
      return this;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  request(method, params = []) {
    if (typeof method !== 'string' || method.length === 0 || method.length > 256) {
      return Promise.reject(new BrowserFulcrumError('invalid Electrum method', {
        server: this.name,
        method,
        kind: 'application',
      }));
    }
    if (!Array.isArray(params)) {
      return Promise.reject(new BrowserFulcrumError('Electrum params must be an array', {
        server: this.name,
        method,
        kind: 'application',
      }));
    }
    if (this._closed || !this.connected || !this._socket || this._socket.readyState !== 1) {
      return Promise.reject(this._transportError(`not connected (method: ${method})`, method));
    }

    if (this._pending.size >= this._limits.pendingRequests) {
      return Promise.reject(new BrowserFulcrumError(
        `browser request limit is ${this._limits.pendingRequests} in flight`,
        { server: this.name, method, kind: 'application' },
      ));
    }

    const id = this._nextId++;
    let payload;
    try {
      payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    } catch {
      return Promise.reject(new BrowserFulcrumError('Electrum params are not JSON-serializable', {
        server: this.name,
        method,
        kind: 'application',
      }));
    }
    if (byteLengthOverLimit(payload, this._limits.messageBytes, this._encoder) > this._limits.messageBytes) {
      return Promise.reject(new BrowserFulcrumError('Electrum request exceeds the message limit', {
        server: this.name,
        method,
        kind: 'application',
      }));
    }
    return new Promise((resolve, reject) => {
      const timer = this._setTimeout(() => {
        this._pending.delete(id);
        reject(this._transportError(`timeout after ${this.timeoutMs}ms: ${method}`, method));
      }, this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this._socket.send(payload);
      } catch (err) {
        this._clearTimeout(timer);
        this._pending.delete(id);
        reject(this._transportError(err, method));
      }
    });
  }

  onNotification(fn) {
    if (typeof fn !== 'function') throw new TypeError('notification handler must be a function');
    if (!this._notifyHandlers.has(fn) && this._notifyHandlers.size >= BROWSER_CLIENT_LIMITS.notificationHandlers) {
      throw new RangeError(`browser notification handler limit is ${BROWSER_CLIENT_LIMITS.notificationHandlers}`);
    }
    this._notifyHandlers.add(fn);
    return () => this._notifyHandlers.delete(fn);
  }

  onClose(fn) {
    if (typeof fn !== 'function') throw new TypeError('close handler must be a function');
    if (!this._closeHandlers.has(fn) && this._closeHandlers.size >= BROWSER_CLIENT_LIMITS.closeHandlers) {
      throw new RangeError(`browser close handler limit is ${BROWSER_CLIENT_LIMITS.closeHandlers}`);
    }
    this._closeHandlers.add(fn);
    return () => this._closeHandlers.delete(fn);
  }

  close() {
    this._closed = true;
    const cancelOpen = this._cancelOpen;
    this._cancelOpen = null;
    cancelOpen?.();
    const socket = this._socket;
    this._socket = null;
    if (socket && socket.readyState < 2) {
      try { socket.close(1000, 'client closing'); } catch { /* already closing */ }
    }
    this._handleClose();
  }

  async _verifyChain() {
    if (!this._crypto?.subtle) {
      throw new BrowserFulcrumError('Web Crypto is required for BCH checkpoint verification', {
        server: this.name,
        kind: 'configuration',
      });
    }
    for (const checkpoint of this.network.checkpoints) {
      const header = await this.request('blockchain.block.header', [checkpoint.height]);
      const hash = await headerHash(header, this._crypto);
      if (hash !== checkpoint.hash) {
        throw new BrowserFulcrumError(
          `wrong chain: checkpoint ${checkpoint.height} does not match ${this.network.name}`,
          { server: this.name, method: 'blockchain.block.header', kind: 'application' },
        );
      }
    }
    this.chainVerified = true;
  }

  _onMessage(data) {
    if (this._closed) return;
    if (typeof data !== 'string') {
      this._abort('binary WebSocket messages are not valid Electrum JSON-RPC');
      return;
    }
    const bytes = byteLengthOverLimit(data, this._limits.messageBytes, this._encoder);
    if (bytes > this._limits.messageBytes) {
      this._abort(`response exceeded ${this._limits.messageBytes} bytes`);
      return;
    }
    const records = splitWireRecords(data, this._limits.recordsPerMessage);
    if (records === null) {
      this._abort(`response exceeded ${this._limits.recordsPerMessage} JSON records`);
      return;
    }
    if (records.length === 0) {
      this._abort('empty WebSocket message is not valid Electrum JSON-RPC');
      return;
    }
    if (
      this._queuedRecords + records.length > this._limits.queuedRecords
      || this._queuedBytes + bytes > this._limits.queuedBytes
    ) {
      this._abort('browser response queue limit exceeded');
      return;
    }

    this._messageQueue.push({ records, index: 0, bytes });
    this._queuedRecords += records.length;
    this._queuedBytes += bytes;
    this._scheduleDrain();
  }

  _scheduleDrain() {
    if (this._drainTimer !== null || this._closed) return;
    this._drainTimer = this._setTimeout(() => {
      this._drainTimer = null;
      this._drainMessages();
    }, 0);
  }

  _drainMessages() {
    if (this._closed) return;
    let processed = 0;
    while (processed < this._limits.dispatchBatchSize && this._messageQueue.length > 0) {
      const batch = this._messageQueue[0];
      const line = batch.records[batch.index++];
      this._queuedRecords--;
      processed++;
      if (batch.index === batch.records.length) {
        this._messageQueue.shift();
        this._queuedBytes -= batch.bytes;
      }

      if (!this._recordRate.take(this._now())) {
        this._abort(`server exceeded ${this._limits.recordsPerSecond} JSON records per second`);
        return;
      }
      if (!this._processRecord(line)) return;
    }
    if (this._messageQueue.length > 0) this._scheduleDrain();
  }

  _processRecord(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._abort('server sent malformed Electrum JSON');
      return false;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this._abort('server sent an invalid Electrum JSON-RPC record');
      return false;
    }

    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (message.id !== undefined && (hasResult || hasError)) {
      if (hasResult && hasError) {
        this._abort('server response contained both result and error');
        return false;
      }
      const pending = this._pending.get(message.id);
      if (!pending) return true;
      if (hasResult && Array.isArray(message.result) && message.result.length > this._limits.responseRecords) {
        this._abort(`response exceeded ${this._limits.responseRecords} result records`);
        return false;
      }
      this._pending.delete(message.id);
      this._clearTimeout(pending.timer);
      if (hasError) {
        const text = typeof message.error === 'string'
          ? message.error
          : (message.error?.message ?? JSON.stringify(message.error));
        pending.reject(new BrowserFulcrumError(String(text).slice(0, 4096), {
          server: this.name,
          method: pending.method,
          kind: 'application',
        }));
      } else {
        pending.resolve(message.result);
      }
      return true;
    }

    if (
      typeof message.method !== 'string'
      || message.method.length === 0
      || message.method.length > 256
      || !Array.isArray(message.params)
      || message.params.length > 16
    ) {
      this._abort('server sent an invalid Electrum notification');
      return false;
    }
    if (!this._notificationRate.take(this._now())) {
      this._abort(`server exceeded ${this._limits.notificationsPerSecond} notifications per second`);
      return false;
    }
    for (const fn of this._notifyHandlers) {
      if (this._closed) return false;
      try { fn(message.method, message.params); } catch { /* user callback */ }
    }
    return !this._closed;
  }

  _abort(message) {
    const err = this._transportError(message);
    this._closed = true;
    this._rejectPending(err);
    const socket = this._socket;
    this._socket = null;
    if (socket && socket.readyState < 2) {
      try { socket.close(1002, 'invalid server message'); } catch { /* dying socket */ }
    }
    this._handleClose(err);
  }

  _handleClose(error = null) {
    const wasConnected = this.connected || this._pending.size > 0;
    this.connected = false;
    this._clearMessageQueue();
    this._rejectPending(this._transportError('connection closed'));
    if (!wasConnected) return;
    for (const fn of this._closeHandlers) {
      try { fn(error); } catch { /* user callback */ }
    }
  }

  _clearMessageQueue() {
    if (this._drainTimer !== null) this._clearTimeout(this._drainTimer);
    this._drainTimer = null;
    this._messageQueue = [];
    this._queuedRecords = 0;
    this._queuedBytes = 0;
  }

  _rejectPending(err) {
    for (const pending of this._pending.values()) {
      this._clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pending.clear();
  }

  _transportError(value, method) {
    if (value instanceof BrowserFulcrumError) return value;
    const message = value instanceof Error ? value.message : String(value);
    return new BrowserFulcrumError(message, {
      server: this.name,
      method,
      kind: 'transport',
      code: value?.code,
    });
  }
}

function parseServerUrl(value, allowInsecure) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserFulcrumError('server URL must be an absolute wss:// URL', { kind: 'configuration' });
  }
  if (url.protocol !== 'wss:' && !(allowInsecure && url.protocol === 'ws:')) {
    throw new BrowserFulcrumError('server URL must use wss:// (or explicitly allow insecure ws://)', {
      kind: 'configuration',
    });
  }
  if (url.username || url.password || url.hash) {
    throw new BrowserFulcrumError('server URL must not contain credentials or a fragment', {
      kind: 'configuration',
    });
  }
  return url;
}

export async function headerHash(headerHex, cryptoImpl = globalThis.crypto) {
  let normalized;
  try {
    normalized = requireBchBlockHeaderHex(headerHex);
  } catch {
    throw new BrowserFulcrumError('server returned a malformed 80-byte block header', {
      kind: 'application',
    });
  }
  if (!cryptoImpl?.subtle) {
    throw new BrowserFulcrumError('Web Crypto is unavailable', { kind: 'configuration' });
  }
  const bytes = Uint8Array.from(normalized.match(/../g), byte => Number.parseInt(byte, 16));
  const first = await cryptoImpl.subtle.digest('SHA-256', bytes);
  const second = await cryptoImpl.subtle.digest('SHA-256', first);
  return [...new Uint8Array(second)]
    .reverse()
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeBrowserClientLimits(opts = {}) {
  const messageBytes = boundedInteger(
    'maxMessageBytes',
    opts.maxMessageBytes,
    BROWSER_CLIENT_LIMITS.messageBytes,
    350_000,
    BROWSER_CLIENT_LIMITS.hardMessageBytes,
  );
  const recordsPerMessage = boundedInteger(
    'maxRecordsPerMessage',
    opts.maxRecordsPerMessage,
    BROWSER_CLIENT_LIMITS.recordsPerMessage,
    1,
    BROWSER_CLIENT_LIMITS.recordsPerMessage,
  );
  return Object.freeze({
    messageBytes,
    queuedBytes: messageBytes * 2,
    recordsPerMessage,
    queuedRecords: Math.min(BROWSER_CLIENT_LIMITS.queuedRecords, recordsPerMessage * 2),
    dispatchBatchSize: Math.min(
      recordsPerMessage,
      boundedInteger(
        'dispatchBatchSize',
        opts.dispatchBatchSize,
        BROWSER_CLIENT_LIMITS.dispatchBatchSize,
        1,
        BROWSER_CLIENT_LIMITS.dispatchBatchSize,
      ),
    ),
    recordsPerSecond: boundedInteger(
      'maxRecordsPerSecond',
      opts.maxRecordsPerSecond,
      BROWSER_CLIENT_LIMITS.recordsPerSecond,
      1,
      1_024,
    ),
    notificationsPerSecond: boundedInteger(
      'maxNotificationsPerSecond',
      opts.maxNotificationsPerSecond,
      BROWSER_CLIENT_LIMITS.notificationsPerSecond,
      1,
      512,
    ),
    responseRecords: boundedInteger(
      'maxResponseRecords',
      opts.maxResponseRecords,
      BROWSER_CLIENT_LIMITS.responseRecords,
      1,
      50_000,
    ),
    pendingRequests: boundedInteger(
      'maxPendingRequests',
      opts.maxPendingRequests,
      BROWSER_CLIENT_LIMITS.pendingRequests,
      1,
      128,
    ),
  });
}

function boundedInteger(name, value, fallback, min, max) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function byteLengthOverLimit(value, limit, encoder) {
  if (value.length > limit) return limit + 1;
  return encoder.encode(value).byteLength;
}

function splitWireRecords(data, limit) {
  const records = [];
  let start = 0;
  while (start <= data.length) {
    const newline = data.indexOf('\n', start);
    const end = newline === -1 ? data.length : newline;
    const line = data.slice(start, end).trim();
    if (line) {
      records.push(line);
      if (records.length > limit) return null;
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return records;
}

class TokenBucket {
  constructor(capacity, windowMs, now) {
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(now) {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.updatedAt = Math.max(this.updatedAt, now);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed * this.capacity / this.windowMs),
    );
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}
