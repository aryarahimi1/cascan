import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  collapseInfrastructureDuplicates,
  queryQuorum,
  selectQuorumVoters,
} from '../src/fulcrum/quorum.js';
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

test('quorum rejects unbounded or malformed policy input', async () => {
  await assert.rejects(() => queryQuorum('x', [], { mode: 'bogus' }), /mode must be/);
  await assert.rejects(() => queryQuorum('x', [], { servers: [], minAgreement: 1.5 }), /positive integer/);
  await assert.rejects(() => queryQuorum('x', [], { servers: [], maxFanout: Number.NaN }), /1 to 32/);
  await assert.rejects(() => queryQuorum('x', [], { servers: [], maxFanout: 33 }), /1 to 32/);
});

test('payment voter selection ignores gossip identities and caps after diversity filtering', () => {
  const servers = [
    { host: 'fast-gossip.example', ports: { ssl: 50002 } },
    { host: 'a-1.example', ports: { ssl: 50002 }, operator: 'operator-a', infrastructure: 'infra-a' },
    { host: 'a-2.example', ports: { ssl: 50002 }, operator: 'operator-a', infrastructure: 'infra-a-2' },
    { host: 'shared.example', ports: { ssl: 50002 }, operator: 'operator-x', infrastructure: 'infra-a' },
    { host: 'b.example', ports: { ssl: 50002 }, operator: 'operator-b', infrastructure: 'infra-b' },
    { host: 'c.example', ports: { ssl: 50002 }, operator: 'operator-c', infrastructure: 'infra-c' },
  ];
  const selection = selectQuorumVoters(servers, { paymentMode: true, maxFanout: 2 });
  assert.deepEqual(selection.selected.map(server => server.operator), ['operator-a', 'operator-b']);
  assert.deepEqual(selection.excluded.map(server => server.reason), [
    'unknown-operator',
    'duplicate-operator',
    'duplicate-infrastructure',
    'fanout-limit',
  ]);
});

test('payment voter selection rejects unsafe identity strings instead of reflecting them', () => {
  const selection = selectQuorumVoters([{
    host: 'host.example',
    ports: { ssl: 50002 },
    operator: 'honest\x1b]8;;https://evil.example\x07click',
    infrastructure: 'infra-a',
  }], { paymentMode: true, maxFanout: 4 });
  assert.equal(selection.selected.length, 0);
  assert.equal(selection.excluded[0].reason, 'unknown-operator');
  assert.equal(selection.excluded[0].operator, undefined);
});

test('same IP or TLS certificate forms one transitive infrastructure vote', () => {
  const collapsed = collapseInfrastructureDuplicates([
    { server: 'a:50002', operator: 'a', remoteAddress: '1.1.1.1', certificateFingerprint: 'CERT-A' },
    { server: 'b:50002', operator: 'b', remoteAddress: '1.1.1.1', certificateFingerprint: 'CERT-B' },
    { server: 'c:50002', operator: 'c', remoteAddress: '2.2.2.2', certificateFingerprint: 'CERT-B' },
  ], true);
  assert.deepEqual(collapsed.map(record => record.independent), [true, false, false]);
  assert.equal(collapsed[1].duplicateOf, 'a:50002');
  assert.equal(collapsed[2].duplicateOf, 'a:50002');
});

test('payment quorum fails closed before dialing two aliases of one operator', async () => {
  const aliases = [
    { host: 'one.example', ports: { ssl: 50002 }, operator: 'same-operator', infrastructure: 'one-infra' },
    { host: 'two.example', ports: { ssl: 50002 }, operator: 'same-operator', infrastructure: 'two-infra' },
  ];
  await assert.rejects(
    () => queryQuorum('merchant.balance', [], {
      mode: 'majority',
      minAgreement: 2,
      paymentMode: true,
      servers: aliases,
    }),
    err => {
      assert.ok(err instanceof QuorumDisagreementError);
      assert.match(err.message, /1 eligible independent operator/);
      assert.equal(err.record.servers[0].reason, 'duplicate-operator');
      return true;
    },
  );
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

test('security quorum: one liar cannot override two matching responders', async (t) => {
  const honest = { confirmed: 42, unconfirmed: 0 };
  const servers = [
    await startServer(() => ({ confirmed: 5_000_000_000, unconfirmed: 0 })),
    await startServer(() => honest),
    await startServer(() => honest),
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
  assert.deepEqual(qr.value, honest);
  assert.equal(qr.agreement, 'majority');
  assert.equal(qr.agreementCount, 2);
  assert.equal(qr.disagreements.length, 1);
  assert.equal(qr.partial, true);
});

test('security boundary: two colluding identities can outvote one honest responder', async (t) => {
  const fabricated = { confirmed: 5_000_000_000, unconfirmed: 0 };
  const servers = [
    await startServer(() => fabricated),
    await startServer(() => fabricated),
    await startServer(() => ({ confirmed: 42, unconfirmed: 0 })),
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
  assert.deepEqual(qr.value, fabricated);
  assert.equal(qr.agreement, 'majority');
  assert.equal(qr.agreementCount, 2);
  assert.equal(qr.disagreements.length, 1);
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
    servers: servers.map((server, index) => entry(server, {
      operator: `fixture-${index + 1}`,
      infrastructure: `fixture-${index + 1}`,
    })),
    allowInsecureTransport: true,
    paymentMode: false,
    timeoutMs: 100,
  });
  assert.equal(qr.agreementCount, 2);
  assert.deepEqual(qr.value, { confirmed: 42 });
  assert.equal(qr.answeredOperator, 'fixture-1');
  assert.deepEqual(qr.operators, ['fixture-1', 'fixture-2']);
  assert.ok(qr.statuses.every(status => status.independent === true));
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
