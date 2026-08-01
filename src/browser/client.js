import { getNetwork } from '../networks.js';

export const BROWSER_CLIENT_NAME = 'cascan-browser/0.4.0-beta.0';
export const BROWSER_PROTOCOL_RANGE = ['1.4', '1.6'];

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
  static MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

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
    this._crypto = opts.crypto ?? globalThis.crypto;
    this._WebSocket = WebSocketImpl;
    this._socket = null;
    this._connecting = null;
    this._buffer = '';
    this._nextId = 1;
    this._pending = new Map();
    this._notifyHandlers = new Set();
    this._closeHandlers = new Set();
    this.serverVersion = null;
    this.chainVerified = false;
    this.connected = false;
  }

  async connect() {
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
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* constructor-owned socket */ }
        reject(this._transportError(`connect timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._socket === socket) this._socket = null;
        try { socket.close(); } catch { /* failed handshake */ }
        reject(this._transportError('websocket connection failed'));
      };
      socket.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(this._transportError('connection closed during handshake'));
        }
        this._handleClose();
      };
      socket.onmessage = (event) => this._onMessage(event.data);
    });

    try {
      this.serverVersion = await this.request('server.version', [
        BROWSER_CLIENT_NAME,
        BROWSER_PROTOCOL_RANGE,
      ]);
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
    if (!this.connected || !this._socket || this._socket.readyState !== 1) {
      return Promise.reject(this._transportError(`not connected (method: ${method})`, method));
    }

    const id = this._nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (new TextEncoder().encode(payload).byteLength > BrowserFulcrumClient.MAX_MESSAGE_BYTES) {
      return Promise.reject(new BrowserFulcrumError('Electrum request exceeds the message limit', {
        server: this.name,
        method,
        kind: 'application',
      }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(this._transportError(`timeout after ${this.timeoutMs}ms: ${method}`, method));
      }, this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this._socket.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(this._transportError(err, method));
      }
    });
  }

  onNotification(fn) {
    if (typeof fn !== 'function') throw new TypeError('notification handler must be a function');
    this._notifyHandlers.add(fn);
    return () => this._notifyHandlers.delete(fn);
  }

  onClose(fn) {
    if (typeof fn !== 'function') throw new TypeError('close handler must be a function');
    this._closeHandlers.add(fn);
    return () => this._closeHandlers.delete(fn);
  }

  close() {
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
    if (typeof data !== 'string') {
      this._abort('binary WebSocket messages are not valid Electrum JSON-RPC');
      return;
    }
    if (new TextEncoder().encode(data).byteLength > BrowserFulcrumClient.MAX_MESSAGE_BYTES) {
      this._abort(`response exceeded ${BrowserFulcrumClient.MAX_MESSAGE_BYTES} bytes`);
      return;
    }

    this._buffer += data.endsWith('\n') ? data : data + '\n';
    if (new TextEncoder().encode(this._buffer).byteLength > BrowserFulcrumClient.MAX_MESSAGE_BYTES) {
      this._abort(`response buffer exceeded ${BrowserFulcrumClient.MAX_MESSAGE_BYTES} bytes`);
      return;
    }

    let newline;
    while ((newline = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, newline).trim();
      this._buffer = this._buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;

      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const pending = this._pending.get(message.id);
        if (!pending) continue;
        this._pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
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
      } else if (typeof message.method === 'string' && Array.isArray(message.params)) {
        for (const fn of this._notifyHandlers) {
          try { fn(message.method, message.params); } catch { /* user callback */ }
        }
      }
    }
  }

  _abort(message) {
    const err = this._transportError(message);
    this._rejectPending(err);
    const socket = this._socket;
    this._socket = null;
    if (socket && socket.readyState < 2) {
      try { socket.close(1002, 'invalid server message'); } catch { /* dying socket */ }
    }
    this._handleClose();
  }

  _handleClose() {
    const wasConnected = this.connected || this._pending.size > 0;
    this.connected = false;
    this._buffer = '';
    this._rejectPending(this._transportError('connection closed'));
    if (!wasConnected) return;
    for (const fn of this._closeHandlers) {
      try { fn(); } catch { /* user callback */ }
    }
  }

  _rejectPending(err) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
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
  if (typeof headerHex !== 'string' || !/^[0-9a-f]{160}$/i.test(headerHex)) {
    throw new BrowserFulcrumError('server returned a malformed 80-byte block header', {
      kind: 'application',
    });
  }
  if (!cryptoImpl?.subtle) {
    throw new BrowserFulcrumError('Web Crypto is unavailable', { kind: 'configuration' });
  }
  const bytes = Uint8Array.from(headerHex.match(/../g), byte => Number.parseInt(byte, 16));
  const first = await cryptoImpl.subtle.digest('SHA-256', bytes);
  const second = await cryptoImpl.subtle.digest('SHA-256', first);
  return [...new Uint8Array(second)]
    .reverse()
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}
