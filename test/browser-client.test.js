import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  BrowserFulcrumClient,
  BrowserFulcrumError,
  headerHash,
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
        ? { height: 900_001, hex: '00' }
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
    { height: 900_001, hex: '00' },
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
  off();
  FakeWebSocket.instances.at(-1).notify('blockchain.headers.subscribe', [{ height: 8 }]);

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
