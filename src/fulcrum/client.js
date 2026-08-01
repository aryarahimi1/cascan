/**
 * src/fulcrum/client.js
 *
 * Zero-dependency Electrum-protocol (Fulcrum) client over TLS or TCP.
 * JSON-RPC 1.0-style, newline-delimited, exactly as Fulcrum/ElectrumX speak.
 *
 * One client = one persistent socket. For one-shot queries, the quorum
 * helper opens a client per server and closes it after the call; the watch
 * command keeps one client open and drives subscriptions.
 */

import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createPinnedLookup, resolvePublicAddresses } from '../net/public-destination.js';

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket client framing — zero dependencies.
//
// Fulcrum exposes the same newline-delimited JSON-RPC over ws (50003) and
// wss (50004); the WebSocket layer is pure wrapping. This implements the
// client side only: handshake, masked text frames out, frame parsing in
// (incl. fragmentation), pong replies, close. Enough for Electrum traffic;
// not a general-purpose WebSocket library on purpose.
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Build a masked client frame around a UTF-8 text payload. */
export function wsEncodeText(payload) {
  const data = Buffer.from(payload, 'utf8');
  const mask = randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Incremental frame parser. Feed raw socket bytes; get complete messages.
 * `carryFragments` is the fragment accumulator from the PREVIOUS call — a
 * fragmented message whose continuation arrives in a later socket read
 * must not lose its head across socket reads.
 *
 * Returns { messages: string[], pings: Buffer[], closed: boolean,
 *           rest: Buffer, fragments: Buffer|null }.
 */
export function wsDecodeFrames(buffer, carryFragments = null) {
  const messages = [];
  const pings = [];
  let closed = false;
  let fragments = carryFragments;
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const maskedIn = (b1 & 0x80) !== 0; // server frames must NOT be masked
    let len = b1 & 0x7f;
    let head = 2;

    if (len === 126) {
      if (buffer.length - offset < 4) break;
      len = buffer.readUInt16BE(offset + 2);
      head = 4;
    } else if (len === 127) {
      if (buffer.length - offset < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(FulcrumClient.MAX_BUFFER_BYTES)) { closed = true; break; }
      len = Number(big);
      head = 10;
    }
    if (maskedIn) head += 4;
    if (buffer.length - offset < head + len) break;

    const maskKey = maskedIn ? buffer.subarray(offset + head - 4, offset + head) : null;
    let payload = buffer.subarray(offset + head, offset + head + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    offset += head + len;

    if (opcode === 0x1 || opcode === 0x0) {          // text / continuation
      if (!fin) {
        fragments = fragments ? Buffer.concat([fragments, payload]) : Buffer.from(payload);
      } else if (fragments) {
        messages.push(Buffer.concat([fragments, payload]).toString('utf8'));
        fragments = null;
      } else {
        messages.push(payload.toString('utf8'));
      }
    } else if (opcode === 0x9) {                     // ping → caller pongs
      pings.push(Buffer.from(payload));
    } else if (opcode === 0x8) {                     // close
      closed = true;
      break;
    }
    // 0x2 binary / 0xA pong: ignored (Electrum servers speak text)
  }

  return { messages, pings, closed, rest: buffer.subarray(offset), fragments };
}

/** Frame a pong for a received ping payload (client frames are masked). */
export function wsEncodePong(payload) {
  const mask = randomBytes(4);
  const header = Buffer.from([0x8a, 0x80 | payload.length]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

export const CLIENT_NAME = 'cascan/0.1.0';
// Electrum-Cash protocol range. 1.4 is the widely-deployed CashTokens-aware
// baseline on Fulcrum; we negotiate [1.4, 1.6] and record what we get.
export const PROTOCOL_RANGE = ['1.4', '1.6'];

export class FulcrumError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'FulcrumError';
    this.server = opts.server;
    this.method = opts.method;
    this.kind = opts.kind;
    this.code = opts.code;
  }
}

export class FulcrumClient {
  static MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MB line cap

  /**
   * @param {{ host: string, port: number, tls?: boolean,
   *           transport?: 'tcp'|'ssl'|'ws'|'wss',
   *           rejectUnauthorized?: boolean, timeoutMs?: number,
   *           publicOnly?: boolean, lookup?: Function,
   *           name?: string }} opts
   */
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port;
    this.transport = opts.transport ?? (opts.tls !== false ? 'ssl' : 'tcp');
    this.useTls = this.transport === 'ssl' || this.transport === 'wss';
    this.isWs = this.transport === 'ws' || this.transport === 'wss';
    this.rejectUnauthorized = opts.rejectUnauthorized !== false; // default true
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.name = opts.name ?? `${this.host}:${this.port}`;
    this.publicOnly = opts.publicOnly === true;
    this._lookup = opts.lookup;

    this._socket = null;
    this._buffer = '';           // JSON line buffer (all transports)
    this._wsBuffer = Buffer.alloc(0); // raw frame buffer (ws/wss only)
    this._wsFragments = null;    // fragmented-message carry across reads
    this._nextId = 1;
    this._pending = new Map();   // id → { resolve, reject, timer, method }
    this._notifyHandlers = [];   // fn(method, params)
    this.serverVersion = null;   // [serverSw, protocol] after connect()
    this.connected = false;
  }

  /** Connect + negotiate server.version. */
  async connect() {
    if (this.connected) return this;

    const socketOpts = {
      host: this.host,
      port: this.port,
      rejectUnauthorized: this.rejectUnauthorized,
    };
    if (this.publicOnly) {
      try {
        const addresses = await resolvePublicAddresses(this.host, { lookup: this._lookup });
        socketOpts.lookup = createPinnedLookup(addresses);
      } catch (err) {
        throw new FulcrumError(err?.message ?? String(err), {
          server: this.name,
          kind: 'transport',
          code: err?.code ?? 'EACCES',
        });
      }
    }
    // SNI: needed by servers behind valid certs on shared IPs. Node forbids
    // an IP literal as servername (RFC 6066) — discovered-by-IP servers
    // (DNS seed) connect without SNI and cannot present a matching cert,
    // so callers pass rejectUnauthorized: false for those.
    if (this.useTls && net.isIP(this.host) === 0) socketOpts.servername = this.host;

    const socket = this.useTls ? tls.connect(socketOpts) : net.connect(socketOpts);
    this._socket = socket;
    socket.setNoDelay(true);
    if (!this.isWs) socket.setEncoding('utf8'); // ws frames are binary
    socket.on('error', (err) => this._onSocketError(err));
    socket.on('close', () => this._onClose());

    // Connect with a hard timeout — an unresponsive host (firewalled port,
    // dropped SYN) must not hang the CLI forever.
    const event = this.useTls ? 'secureConnect' : 'connect';
    let connectTimer;
    try {
      await Promise.race([
        once(socket, event),
        new Promise((_, reject) => {
          connectTimer = setTimeout(() => {
            // A superseding connect attempt may have installed a new socket.
            // Never let this attempt's timeout destroy that replacement.
            if (this._socket === socket) socket.destroy();
            reject(new FulcrumError(`connect timeout after ${this.timeoutMs}ms`, { server: this.name, kind: 'transport' }));
          }, this.timeoutMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof FulcrumError) throw err;
      throw new FulcrumError(err?.message ?? String(err), {
        server: this.name,
        kind: 'transport',
        code: err?.code,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if (this.isWs) {
      await this._wsHandshake();
      this._socket.on('data', (chunk) => this._onWsData(chunk));
    } else {
      this._socket.on('data', (chunk) => this._onData(chunk));
    }
    this.connected = true;

    // Negotiate protocol; failure here means "not an electrum server".
    this.serverVersion = await this.request('server.version', [CLIENT_NAME, PROTOCOL_RANGE]);
    return this;
  }

  /** RFC 6455 client handshake over the already-open socket. */
  async _wsHandshake() {
    const key = randomBytes(16).toString('base64');
    const expectAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const hostHeader = net.isIP(this.host) ? `[${this.host}]` : this.host;

    this._socket.write(
      `GET / HTTP/1.1\r\n` +
      `Host: ${hostHeader}:${this.port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`
    );

    // Read until the HTTP response header terminator; anything after it is
    // already frame data and must be fed to the frame parser.
    let head = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._socket.destroy();
        reject(new FulcrumError(`websocket handshake timeout after ${this.timeoutMs}ms`, { server: this.name, kind: 'transport' }));
      }, this.timeoutMs);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) {
          if (head.length > 65536) { cleanup(); reject(new FulcrumError('websocket handshake response too large', { server: this.name })); }
          return;
        }
        cleanup();
        const header = head.subarray(0, end).toString('latin1');
        const statusLine = header.split('\r\n')[0];
        if (!/^HTTP\/1\.1 101/.test(statusLine)) {
          return reject(new FulcrumError(`websocket upgrade refused: ${statusLine}`, { server: this.name }));
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(header)?.[1];
        if (accept !== expectAccept) {
          return reject(new FulcrumError('websocket handshake: Sec-WebSocket-Accept mismatch', { server: this.name }));
        }
        this._wsBuffer = Buffer.from(head.subarray(end + 4)); // early frames
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this._socket.removeListener('data', onData);
      };
      this._socket.on('data', onData);
    });
  }

  _onWsData(chunk) {
    this._wsBuffer = Buffer.concat([this._wsBuffer, chunk]);
    if (this._wsBuffer.length > FulcrumClient.MAX_BUFFER_BYTES) {
      this.close();
      this._onSocketError(new FulcrumError(`websocket buffer exceeded ${FulcrumClient.MAX_BUFFER_BYTES} bytes`, { server: this.name }));
      return;
    }
    const { messages, pings, closed, rest, fragments } = wsDecodeFrames(this._wsBuffer, this._wsFragments);
    this._wsBuffer = Buffer.from(rest);
    this._wsFragments = fragments;
    // Fragment accumulation counts against the same cap as everything else.
    if (this._wsFragments && this._wsFragments.length > FulcrumClient.MAX_BUFFER_BYTES) {
      this.close();
      this._onSocketError(new FulcrumError(`websocket fragmented message exceeded ${FulcrumClient.MAX_BUFFER_BYTES} bytes`, { server: this.name }));
      return;
    }
    for (const ping of pings) {
      try { this._socket.write(wsEncodePong(ping)); } catch { /* dying socket */ }
    }
    // Each text frame carries one (or more newline-joined) JSON-RPC message —
    // reuse the newline-delimited path so both transports share one parser.
    for (const m of messages) {
      this._onData(m.endsWith('\n') ? m : m + '\n');
    }
    if (closed) this.close();
  }

  /**
   * JSON-RPC request with per-request timeout.
   * @param {string} method
   * @param {any[]} [params]
   * @returns {Promise<any>}
   */
  request(method, params = []) {
    if (!this._socket || this._socket.destroyed) {
      return Promise.reject(new FulcrumError(`not connected (method: ${method})`, { server: this.name, method, kind: 'transport' }));
    }
    const id = this._nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new FulcrumError(`timeout after ${this.timeoutMs}ms: ${method}`, { server: this.name, method, kind: 'transport' }));
      }, this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      this._socket.write(this.isWs ? wsEncodeText(payload) : payload);
    });
  }

  /**
   * Register a notification handler (subscriptions).
   * @param {(method: string, params: any[]) => void} fn
   */
  onNotification(fn) {
    this._notifyHandlers.push(fn);
  }

  /** Subscribe to an address; cb fires on every status change. */
  async subscribeAddress(address, cb) {
    this.onNotification((method, params) => {
      if (method === 'blockchain.address.subscribe' && params?.[0] === address) {
        cb(params[1]);
      }
    });
    return this.request('blockchain.address.subscribe', [address]);
  }

  /** Current tip via headers.subscribe (returns { height, hex }). */
  async tip() {
    return this.request('blockchain.headers.subscribe');
  }

  close() {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new FulcrumError('connection closed', { server: this.name, kind: 'transport' }));
    }
    this._pending.clear();
    if (this._socket && !this._socket.destroyed) this._socket.destroy();
    this.connected = false;
  }

  _onData(chunk) {
    this._buffer += chunk;
    // Malicious-server guard: an unterminated line that grows without bound
    // would OOM the CLI. Legit Fulcrum responses (histories, listunspent)
    // are well under this cap.
    if (this._buffer.length > FulcrumClient.MAX_BUFFER_BYTES) {
      this.close();
      this._onSocketError(new FulcrumError(`response exceeded ${FulcrumClient.MAX_BUFFER_BYTES} bytes without a newline terminator`, { server: this.name }));
      return;
    }
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // garbage line; electrum servers shouldn't send these
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this._pending.get(msg.id);
        if (!p) continue;
        this._pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const errText = typeof msg.error === 'string' ? msg.error : (msg.error.message ?? JSON.stringify(msg.error));
          p.reject(new FulcrumError(errText, { server: this.name, method: p.method, kind: 'application' }));
        } else {
          p.resolve(msg.result);
        }
      } else if (msg.method !== undefined) {
        for (const fn of this._notifyHandlers) {
          try { fn(msg.method, msg.params); } catch { /* handler errors are userland */ }
        }
      }
    }
  }

  _onSocketError(err) {
    // Surface to all pending requests; the 'close' handler finishes teardown.
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new FulcrumError(err.message, { server: this.name, kind: err.kind ?? 'transport', code: err.code }));
    }
    this._pending.clear();
  }

  _onClose() {
    this.connected = false;
    this._onSocketError(new FulcrumError('connection closed', { server: this.name, kind: 'transport' }));
  }
}
