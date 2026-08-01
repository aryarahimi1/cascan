/**
 * Real-socket lifecycle tests for FulcrumClient.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { FulcrumClient } from '../src/fulcrum/client.js';

function createFulcrumServer() {
  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        const result = request.method === 'server.version'
          ? ['local-test', '1.4']
          : 'pong';
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      }
    });
  });
}

test('client: successful connect stays alive beyond 2x the connect timeout', async (t) => {
  const timeoutMs = 100;
  const server = createFulcrumServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const client = new FulcrumClient({
    host: '127.0.0.1',
    port,
    transport: 'tcp',
    timeoutMs,
  });
  t.after(async () => {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await client.connect();
  await new Promise((resolve) => setTimeout(resolve, timeoutMs * 2 + 20));

  assert.equal(client.connected, true);
  assert.equal(client._socket.destroyed, false);
  assert.equal(await client.request('server.ping'), 'pong');
});
