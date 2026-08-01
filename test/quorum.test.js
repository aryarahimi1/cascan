import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { queryQuorum } from '../src/fulcrum/quorum.js';
import { AllServersFailedError, QuorumDisagreementError } from '../src/fulcrum/errors.js';
import { parseArgs } from '../src/cli/args.js';
import { checkpointHeader } from './checkpoint-fixtures.js';

const NO_RESPONSE = Symbol('no-response');

async function startServer(handler) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const result = request.method === 'server.version'
          ? ['quorum-test', '1.4']
          : request.method === 'blockchain.block.header'
            ? checkpointHeader(request.params)
          : await handler(request.method, request.params);
        if (result === NO_RESPONSE) continue;
        const response = result instanceof Error
          ? { jsonrpc: '2.0', id: request.id, error: { message: result.message } }
          : { jsonrpc: '2.0', id: request.id, result };
        socket.write(JSON.stringify(response) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function entry(server, extra = {}) {
  const { port } = server.address();
  return {
    host: '127.0.0.1',
    ports: { tcp: port, ssl: port },
    transport: 'tcp',
    port,
    rejectUnauthorized: false,
    ...extra,
  };
}

async function closeServers(servers) {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}

test('CLI secure default fans out with majority quorum', () => {
  assert.equal(parseArgs(['gas']).quorum, 'majority');
});

test('quorum: discovery-verified TCP transport is reused instead of redialing TLS', async (t) => {
  const server = await startServer(() => 'tcp-ok');
  t.after(() => closeServers([server]));
  const qr = await queryQuorum('x.transport', [], {
    mode: 'any',
    servers: [entry(server)],
    allowInsecureTransport: true,
    timeoutMs: 100,
  });
  assert.equal(qr.value, 'tcp-ok');
  assert.equal(qr.answered, `127.0.0.1:${server.address().port}`);
});

test('quorum: uniform timeouts remain AllServersFailedError', async (t) => {
  const servers = [
    await startServer(() => NO_RESPONSE),
    await startServer(() => NO_RESPONSE),
  ];
  t.after(() => closeServers(servers));
  await assert.rejects(
    () => queryQuorum('x.hang', [], {
      mode: 'any',
      servers: servers.map(server => entry(server)),
      allowInsecureTransport: true,
      timeoutMs: 30,
    }),
    AllServersFailedError
  );
});

test('quorum: uniform daemon errors remain application errors', async (t) => {
  const servers = [
    await startServer(() => new Error('transaction not found')),
    await startServer(() => new Error('transaction not found')),
  ];
  t.after(() => closeServers(servers));
  await assert.rejects(
    () => queryQuorum('blockchain.transaction.get', ['missing'], {
      mode: 'any',
      servers: servers.map(server => entry(server)),
      allowInsecureTransport: true,
      timeoutMs: 100,
    }),
    err => {
      assert.equal(err.constructor, Error);
      assert.equal(err.message, 'transaction not found');
      return true;
    }
  );
});

test('security quorum: one fabricated answer cannot satisfy minAgreement=2', async (t) => {
  const servers = [
    await startServer(() => ({ confirmed: 5_000_000_000 })),
    await startServer(() => ({ confirmed: 0 })),
  ];
  t.after(() => closeServers(servers));
  await assert.rejects(
    () => queryQuorum('blockchain.address.get_balance', ['address'], {
      mode: 'majority',
      minAgreement: 2,
      servers: servers.map(server => entry(server)),
      allowInsecureTransport: true,
      paymentMode: false,
      timeoutMs: 100,
    }),
    QuorumDisagreementError
  );
});

test('security quorum: two matching independent endpoints satisfy minAgreement=2', async (t) => {
  const servers = [
    await startServer(() => ({ confirmed: 42 })),
    await startServer(() => ({ confirmed: 42 })),
  ];
  t.after(() => closeServers(servers));
  const qr = await queryQuorum('blockchain.address.get_balance', ['address'], {
    mode: 'majority',
    minAgreement: 2,
    servers: servers.map(server => entry(server)),
    allowInsecureTransport: true,
    paymentMode: false,
    timeoutMs: 100,
  });
  assert.equal(qr.agreementCount, 2);
  assert.deepEqual(qr.value, { confirmed: 42 });
});

test('security quorum: a 2–2 tie cannot satisfy minAgreement=2', async (t) => {
  const servers = [
    await startServer(() => ({ confirmed: 500_000 })),
    await startServer(() => ({ confirmed: 500_000 })),
    await startServer(() => ({ confirmed: 0 })),
    await startServer(() => ({ confirmed: 0 })),
  ];
  t.after(() => closeServers(servers));

  await assert.rejects(
    () => queryQuorum('blockchain.address.get_balance', ['address'], {
      mode: 'majority',
      minAgreement: 2,
      servers: servers.map(server => entry(server)),
      allowInsecureTransport: true,
      paymentMode: false,
      timeoutMs: 100,
    }),
    err => {
      assert.ok(err instanceof QuorumDisagreementError);
      assert.match(err.message, /no strict majority/);
      return true;
    }
  );
});
