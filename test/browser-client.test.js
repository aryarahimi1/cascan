import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  BROWSER_CLIENT_LIMITS,
  BrowserFulcrumClient,
  BrowserFulcrumError,
  headerHash,
  normalizeBrowserClientLimits,
} from '../src/browser/client.js';

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(payload) {
    this.sent.push(payload);
    const request = JSON.parse(payload);
    const result = request.method === 'server.version'
      ? ['fake-fulcrum', '1.6']
      : request.method === 'blockchain.block.header'
        ? '00'.repeat(80)
      : request.method === 'blockchain.headers.subscribe'
        ? { height: 900_001, hex: '00'.repeat(80) }
        : 'pong';
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      });
    });
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }

  notify(method, params) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method, params }) });
  }
}

class ErrorWebSocket {
  static closed = false;

  constructor() {
    this.readyState = 0;
    queueMicrotask(() => this.onerror?.());
  }

  close() {
    ErrorWebSocket.closed = true;
    this.readyState = 3;
  }
}

class ControlledWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(payload) {
    this.sent.push(payload);
    const request = JSON.parse(payload);
    if (request.method === 'server.version') {
      queueMicrotask(() => this.respond(request.id, ['controlled-fulcrum', '1.6']));
    }
  }

  respond(id, result) {
    this.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', id, result }),
    });
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
}

class NeverOpenWebSocket {
  static instances = [];

  constructor() {
    this.readyState = 0;
    this.closed = false;
    NeverOpenWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
}

class ReconnectWebSocket {
  static instances = [];

  constructor() {
    this.readyState = 0;
    this.sent = [];
    ReconnectWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(payload) {
    this.sent.push(payload);
    const request = JSON.parse(payload);
    if (request.method === 'server.version') {
      queueMicrotask(() => this.respond(request.id, ['reconnect-fulcrum', '1.6']));
    }
  }

  respond(id, result) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  }

  remoteClose() {
    this.readyState = 3;
    this.onclose?.();
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
}

const waitFor = async (predicate, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for browser client state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

test('browser client: connects over native WSS and reads the BCH tip', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://fulcrum.example:50004/',
    WebSocket: FakeWebSocket,
    timeoutMs: 100,
    verifyChain: false,
  });
  await client.connect();

  assert.deepEqual(client.serverVersion, ['fake-fulcrum', '1.6']);
  assert.deepEqual(
    await client.request('blockchain.headers.subscribe'),
    { height: 900_001, hex: '00'.repeat(80) },
  );
  assert.equal(FakeWebSocket.instances.at(-1).url, 'wss://fulcrum.example:50004/');
  client.close();
});

test('browser client: delivers notifications and removes handlers', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://fulcrum.example/',
    WebSocket: FakeWebSocket,
    timeoutMs: 100,
    verifyChain: false,
  });
  await client.connect();

  const seen = [];
  const off = client.onNotification((method, params) => seen.push([method, params]));
  FakeWebSocket.instances.at(-1).notify('blockchain.headers.subscribe', [{ height: 7 }]);
  await new Promise(resolve => setTimeout(resolve, 5));
  off();
  FakeWebSocket.instances.at(-1).notify('blockchain.headers.subscribe', [{ height: 8 }]);
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.deepEqual(seen, [['blockchain.headers.subscribe', [{ height: 7 }]]]);
  client.close();
});

test('browser client: rejects insecure and credential-bearing endpoints by default', () => {
  assert.throws(
    () => new BrowserFulcrumClient({ url: 'ws://fulcrum.example/', WebSocket: FakeWebSocket }),
    BrowserFulcrumError,
  );
  assert.throws(
    () => new BrowserFulcrumClient({ url: 'wss://user:pass@fulcrum.example/', WebSocket: FakeWebSocket }),
    /credentials/,
  );
});

test('browser client: rejects malformed request shapes before sending', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://fulcrum.example/',
    WebSocket: FakeWebSocket,
    timeoutMs: 100,
    verifyChain: false,
  });
  await client.connect();
  await assert.rejects(() => client.request('', []), /invalid Electrum method/);
  await assert.rejects(() => client.request('server.ping', {}), /params must be an array/);
  client.close();
});

test('browser client: rejects a server on the wrong BCH chain', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://wrong-chain.example/',
    WebSocket: FakeWebSocket,
    crypto: webcrypto,
    timeoutMs: 100,
  });
  await assert.rejects(() => client.connect(), /wrong chain/);
  assert.equal(client.chainVerified, false);
});

test('browser client: hashes block headers with BCH double-SHA256 byte order', async () => {
  const zeroHeader = '00'.repeat(80);
  assert.equal(
    await headerHash(zeroHeader, webcrypto),
    '14508459b221041eab257d2baaa7459775ba748246c8403609eb708f0e57e74b',
  );
});

test('browser client: handshake errors close and release the failed socket', async () => {
  ErrorWebSocket.closed = false;
  const client = new BrowserFulcrumClient({
    url: 'wss://offline.example/',
    WebSocket: ErrorWebSocket,
    verifyChain: false,
    timeoutMs: 100,
  });
  await assert.rejects(() => client.connect(), /connection failed/);
  assert.equal(ErrorWebSocket.closed, true);
  assert.equal(client._socket, null);
});

test('browser client: resource options are bounded by secure hard limits', () => {
  assert.deepEqual(normalizeBrowserClientLimits(), {
    messageBytes: BROWSER_CLIENT_LIMITS.messageBytes,
    queuedBytes: BROWSER_CLIENT_LIMITS.messageBytes * 2,
    recordsPerMessage: BROWSER_CLIENT_LIMITS.recordsPerMessage,
    queuedRecords: BROWSER_CLIENT_LIMITS.queuedRecords,
    dispatchBatchSize: BROWSER_CLIENT_LIMITS.dispatchBatchSize,
    recordsPerSecond: BROWSER_CLIENT_LIMITS.recordsPerSecond,
    notificationsPerSecond: BROWSER_CLIENT_LIMITS.notificationsPerSecond,
    responseRecords: BROWSER_CLIENT_LIMITS.responseRecords,
    pendingRequests: BROWSER_CLIENT_LIMITS.pendingRequests,
  });
  assert.throws(
    () => normalizeBrowserClientLimits({
      maxMessageBytes: BROWSER_CLIENT_LIMITS.hardMessageBytes + 1,
    }),
    /maxMessageBytes/,
  );
  assert.throws(
    () => normalizeBrowserClientLimits({ dispatchBatchSize: 17 }),
    /dispatchBatchSize/,
  );
  assert.throws(
    () => normalizeBrowserClientLimits({ maxPendingRequests: 129 }),
    /maxPendingRequests/,
  );
});

test('browser client: oversized and over-batched messages abort the hostile server', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://oversized.example/',
    WebSocket: FakeWebSocket,
    verifyChain: false,
    timeoutMs: 100,
    maxMessageBytes: 350_000,
    maxRecordsPerMessage: 2,
  });
  await client.connect();
  let closeError;
  client.onClose(error => { closeError = error; });

  FakeWebSocket.instances.at(-1).onmessage({ data: 'x'.repeat(350_001) });

  assert.equal(client.connected, false);
  assert.match(closeError.message, /350000 bytes/);

  const batched = new BrowserFulcrumClient({
    url: 'wss://over-batched.example/',
    WebSocket: FakeWebSocket,
    verifyChain: false,
    timeoutMs: 100,
    maxRecordsPerMessage: 2,
  });
  await batched.connect();
  let batchError;
  batched.onClose(error => { batchError = error; });
  const notification = JSON.stringify({ method: 'server.banner', params: [] });
  FakeWebSocket.instances.at(-1).onmessage({ data: `${notification}\n${notification}\n${notification}` });

  assert.equal(batched.connected, false);
  assert.match(batchError.message, /2 JSON records/);
});

test('browser client: bounded queue rejects a producer faster than dispatch', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://queue-flood.example/',
    WebSocket: FakeWebSocket,
    verifyChain: false,
    timeoutMs: 100,
    maxRecordsPerMessage: 2,
  });
  await client.connect();
  const scheduled = [];
  client._setTimeout = fn => {
    scheduled.push(fn);
    return scheduled.length;
  };
  client._clearTimeout = () => {};
  let closeError;
  client.onClose(error => { closeError = error; });
  const line = JSON.stringify({ method: 'server.banner', params: [] });
  const socket = FakeWebSocket.instances.at(-1);

  socket.onmessage({ data: `${line}\n${line}` });
  socket.onmessage({ data: `${line}\n${line}` });
  socket.onmessage({ data: line });

  assert.equal(scheduled.length, 1);
  assert.equal(client.connected, false);
  assert.match(closeError.message, /queue limit/);
});

test('browser client: dispatch yields to the browser between small record batches', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://yield.example/',
    WebSocket: FakeWebSocket,
    verifyChain: false,
    timeoutMs: 100,
    dispatchBatchSize: 2,
  });
  await client.connect();
  const scheduled = [];
  client._setTimeout = fn => {
    scheduled.push(fn);
    return scheduled.length;
  };
  client._clearTimeout = () => {};
  const seen = [];
  client.onNotification((_method, params) => seen.push(params[0]));
  const records = Array.from({ length: 5 }, (_, index) => (
    JSON.stringify({ method: 'server.banner', params: [index] })
  ));

  FakeWebSocket.instances.at(-1).onmessage({ data: records.join('\n') });
  assert.deepEqual(seen, []);
  scheduled.shift()();
  assert.deepEqual(seen, [0, 1]);
  scheduled.shift()();
  assert.deepEqual(seen, [0, 1, 2, 3]);
  scheduled.shift()();
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
  client.close();
});

test('browser client: notification and total record floods close the connection', async () => {
  const notificationClient = new BrowserFulcrumClient({
    url: 'wss://notification-flood.example/',
    WebSocket: FakeWebSocket,
    verifyChain: false,
    timeoutMs: 100,
    maxNotificationsPerSecond: 2,
  });
  await notificationClient.connect();
  let notifications = 0;
  let notificationError;
  notificationClient.onNotification(() => { notifications++; });
  notificationClient.onClose(error => { notificationError = error; });
  const notification = JSON.stringify({ method: 'server.banner', params: [] });
  FakeWebSocket.instances.at(-1).onmessage({
    data: `${notification}\n${notification}\n${notification}`,
  });
  await waitFor(() => !notificationClient.connected);
  assert.equal(notifications, 2);
  assert.match(notificationError.message, /2 notifications per second/);

  let now = 0;
  const recordClient = new BrowserFulcrumClient({
    url: 'wss://record-flood.example/',
    WebSocket: FakeWebSocket,
    verifyChain: false,
    timeoutMs: 100,
    maxRecordsPerSecond: 2,
    now: () => now,
  });
  await recordClient.connect();
  now = 1_000;
  let recordError;
  recordClient.onClose(error => { recordError = error; });
  FakeWebSocket.instances.at(-1).onmessage({
    data: [101, 102, 103]
      .map(id => JSON.stringify({ jsonrpc: '2.0', id, result: null }))
      .join('\n'),
  });
  await waitFor(() => !recordClient.connected);
  assert.match(recordError.message, /2 JSON records per second/);
});

test('browser client: oversized result arrays and malformed JSON fail closed', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://response-array.example/',
    WebSocket: ControlledWebSocket,
    verifyChain: false,
    timeoutMs: 100,
    maxResponseRecords: 2,
  });
  await client.connect();
  const socket = ControlledWebSocket.instances.at(-1);
  const pending = client.request('blockchain.address.get_history', ['bitcoincash:qtest']);
  const request = JSON.parse(socket.sent.at(-1));
  socket.respond(request.id, [{}, {}, {}]);
  await assert.rejects(pending, /2 result records/);
  assert.equal(client.connected, false);

  const malformed = new BrowserFulcrumClient({
    url: 'wss://malformed-json.example/',
    WebSocket: FakeWebSocket,
    verifyChain: false,
    timeoutMs: 100,
  });
  await malformed.connect();
  let closeError;
  malformed.onClose(error => { closeError = error; });
  FakeWebSocket.instances.at(-1).onmessage({ data: '{' });
  await waitFor(() => !malformed.connected);
  assert.match(closeError.message, /malformed Electrum JSON/);
});

test('browser client: pending requests and callback registrations are capped', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://bounded-state.example/',
    WebSocket: ControlledWebSocket,
    verifyChain: false,
    timeoutMs: 1_000,
    maxPendingRequests: 2,
  });
  await client.connect();
  const first = assert.rejects(client.request('lookup.one'), /connection closed/);
  const second = assert.rejects(client.request('lookup.two'), /connection closed/);
  await assert.rejects(() => client.request('lookup.three'), /2 in flight/);

  const notificationHandlers = Array.from(
    { length: BROWSER_CLIENT_LIMITS.notificationHandlers },
    () => () => {},
  );
  for (const handler of notificationHandlers) client.onNotification(handler);
  client.onNotification(notificationHandlers[0]);
  assert.throws(() => client.onNotification(() => {}), /notification handler limit/);

  const closeHandlers = Array.from(
    { length: BROWSER_CLIENT_LIMITS.closeHandlers },
    () => () => {},
  );
  for (const handler of closeHandlers) client.onClose(handler);
  client.onClose(closeHandlers[0]);
  assert.throws(() => client.onClose(() => {}), /close handler limit/);

  client.close();
  await Promise.all([first, second]);
});

test('browser client: close immediately cancels an unfinished WebSocket handshake', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://never-opens.example/',
    WebSocket: NeverOpenWebSocket,
    verifyChain: false,
    timeoutMs: 60_000,
  });
  const pending = client.connect();
  client.close();

  await assert.rejects(pending, /connection closed during handshake/);
  assert.equal(NeverOpenWebSocket.instances.at(-1).closed, true);
  assert.equal(client._socket, null);
});

test('browser client: retired WebSocket events cannot affect a reconnected socket', async () => {
  const client = new BrowserFulcrumClient({
    url: 'wss://reconnect.example/',
    WebSocket: ReconnectWebSocket,
    verifyChain: false,
    timeoutMs: 100,
  });
  await client.connect();
  const retired = ReconnectWebSocket.instances.at(-1);
  retired.remoteClose();
  assert.equal(client.connected, false);

  await client.connect();
  const current = ReconnectWebSocket.instances.at(-1);
  assert.notEqual(current, retired);
  const pending = client.request('lookup');
  const request = JSON.parse(current.sent.at(-1));

  retired.respond(request.id, 'attacker-controlled');
  retired.onclose?.();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(client.connected, true);
  assert.equal(client._pending.has(request.id), true);

  current.respond(request.id, 'current-server');
  assert.equal(await pending, 'current-server');
  client.close();
});
