import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  ChainVerificationError,
  headerHash,
  verifyBchChain,
} from '../src/fulcrum/chain.js';
import { queryQuorum } from '../src/fulcrum/quorum.js';
import { AllServersFailedError } from '../src/fulcrum/errors.js';
import { connect } from '../src/index.js';
import { ServerPool } from '../src/pool/pool.js';
import { candidateConnectionAttempts } from '../src/pool/discovery.js';
import { MAINNET_CHECKPOINT_HEADERS, checkpointHeader } from './checkpoint-fixtures.js';

const ZERO_HEADER = '00'.repeat(80);

test('chain verifier accepts only the selected network checkpoints on the current client', async () => {
  const seen = [];
  const client = {
    name: 'fixture:50002',
    chainVerified: null,
    async request(method, params) {
      seen.push([method, params]);
      return checkpointHeader(params);
    },
  };

  assert.equal(await verifyBchChain(client, 'mainnet'), 'mainnet');
  assert.equal(client.chainVerified, 'mainnet');
  assert.deepEqual(seen.map(([, params]) => params[0]), [478559, 556767]);
  assert.equal(headerHash(MAINNET_CHECKPOINT_HEADERS.get(478559)),
    '000000000000000000651ef99cb9fcbe0dadde1d424bd9f15ff20136191a5eec');

  client.request = async () => ZERO_HEADER;
  await assert.rejects(() => verifyBchChain(client, 'mainnet'), /wrong chain/);
  assert.equal(client.chainVerified, null, 'a later failed proof cannot retain stale verified state');
});

test('chain verifier fails closed on malformed and wrong-chain headers', async () => {
  await assert.rejects(
    () => verifyBchChain({ name: 'malformed', request: async () => '00' }, 'mainnet'),
    err => err instanceof ChainVerificationError && err.code === 'MALFORMED_CHECKPOINT_HEADER',
  );
  await assert.rejects(
    () => verifyBchChain({ name: 'wrong', request: async () => ZERO_HEADER }, 'mainnet'),
    err => err instanceof ChainVerificationError && err.code === 'WRONG_CHAIN',
  );
});

class PoolSecurityClient {
  constructor(spec) {
    this.spec = spec;
    this.name = spec.name;
    this.connected = false;
    this._socket = { once() {} };
  }

  async connect() {
    this.connected = true;
    return this;
  }

  async request(method, params = []) {
    if (method === 'blockchain.block.header') {
      return this.spec.wrongChain ? ZERO_HEADER : checkpointHeader(params);
    }
    if (method === 'blockchain.headers.subscribe') {
      if (this.spec.closeDuringSetup) this.connected = false;
      return { height: 962_000 };
    }
    this.spec.applicationCalls++;
    return this.spec.answer;
  }

  onNotification() {}
  close() { this.connected = false; }
}

test('pool rejects a wrong-chain cached endpoint before it serves application data', async () => {
  const bad = { name: 'cached-bad', wrongChain: true, answer: 'poison', applicationCalls: 0 };
  const good = { name: 'curated-good', wrongChain: false, answer: 'honest', applicationCalls: 0 };
  const specs = [bad, good];
  const pool = new ServerPool(specs.map(spec => ({
    host: spec.name,
    ports: { ssl: 50002 },
    tlsStrict: true,
    source: spec === bad ? 'cache' : 'curated',
  })), {
    network: 'mainnet',
    clientFactory: server => new PoolSecurityClient(specs.find(spec => spec.name === server.host)),
  });

  const lost = [];
  pool.on('server-lost', event => lost.push(event));
  assert.equal(await pool.request('merchant.balance'), 'honest');
  assert.equal(bad.applicationCalls, 0, 'wrong-chain socket never reaches the application request');
  assert.equal(good.applicationCalls, 1);
  assert.match(lost[0].error, /wrong chain/);
  pool.close();
});

test('pool rejects a socket that closes after checkpoints but before setup completes', async () => {
  const closed = {
    name: 'closes-after-proof',
    closeDuringSetup: true,
    answer: 'never',
    applicationCalls: 0,
  };
  const good = { name: 'stays-open', answer: 'ready', applicationCalls: 0 };
  const specs = [closed, good];
  const pool = new ServerPool(specs.map(spec => ({
    host: spec.name,
    ports: { ssl: 50002 },
    tlsStrict: true,
  })), {
    clientFactory: server => new PoolSecurityClient(specs.find(spec => spec.name === server.host)),
  });

  assert.equal(await pool.request('merchant.balance'), 'ready');
  assert.equal(closed.applicationCalls, 0);
  assert.equal(pool.current, 'stays-open:50002');
  pool.close();
});

async function startSocketServer({ wrongChain = false, answer = 'ok' } = {}) {
  const state = { applicationCalls: 0, connections: 0 };
  const server = net.createServer(socket => {
    state.connections++;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        let result;
        if (request.method === 'server.version') result = ['security-fixture', '1.4'];
        else if (request.method === 'blockchain.block.header') {
          result = wrongChain ? ZERO_HEADER : checkpointHeader(request.params);
        } else {
          state.applicationCalls++;
          result = answer;
        }
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, state };
}

function tcpEntry(server) {
  const { port } = server.address();
  return {
    host: '127.0.0.1',
    ports: { tcp: port },
    transport: 'tcp',
    port,
    tlsStrict: false,
  };
}

async function closeSocketServers(records) {
  await Promise.all(records.map(({ server }) => new Promise(resolve => server.close(resolve))));
}

test('quorum verifies each exact socket and denies a wrong-chain endpoint a vote', async (t) => {
  const bad = await startSocketServer({ wrongChain: true, answer: 'poison' });
  const good = await startSocketServer({ answer: 'honest' });
  t.after(() => closeSocketServers([bad, good]));

  const result = await queryQuorum('merchant.balance', [], {
    mode: 'any',
    servers: [tcpEntry(bad.server), tcpEntry(good.server)],
    allowInsecureTransport: true,
    paymentMode: false,
    timeoutMs: 200,
  });
  assert.equal(result.value, 'honest');
  assert.equal(bad.state.applicationCalls, 0);
  assert.equal(good.state.applicationCalls, 1);
  assert.equal(result.statuses[0].status, 'failed');
  assert.match(result.statuses[0].error, /wrong chain/);
});

test('payment mode refuses explicit TCP opt-in before opening a socket', async (t) => {
  const local = await startSocketServer({ answer: 'should-not-run' });
  t.after(() => closeSocketServers([local]));

  await assert.rejects(
    () => queryQuorum('merchant.balance', [], {
      mode: 'any',
      servers: [tcpEntry(local.server)],
      allowInsecureTransport: true,
      paymentMode: true,
      timeoutMs: 100,
    }),
    err => err instanceof AllServersFailedError
      && err.errors[0]?.code === 'INSECURE_TRANSPORT',
  );
  assert.equal(local.state.connections, 0);
  assert.equal(local.state.applicationCalls, 0);
});

test('pool default refuses TCP before invoking its connection factory', async () => {
  let factoryCalls = 0;
  const pool = new ServerPool([{
    host: 'tcp-only.example',
    ports: { tcp: 50001 },
    transport: 'tcp',
    tlsStrict: false,
  }], {
    clientFactory() {
      factoryCalls++;
      throw new Error('must not dial');
    },
  });

  await assert.rejects(
    () => pool.acquire(),
    err => err instanceof AllServersFailedError
      && err.errors[0]?.code === 'INSECURE_TRANSPORT',
  );
  assert.equal(factoryCalls, 0);
  pool.close();
});

test('automatic discovery never downgrades unless insecure transport was explicit', () => {
  const candidate = { host: 'fulcrum.example', ports: { ssl: 50002, tcp: 50001 } };
  assert.deepEqual(candidateConnectionAttempts(candidate), [
    { port: 50002, tls: true, reject: true, tlsStrict: true },
  ]);
  assert.deepEqual(candidateConnectionAttempts(candidate, true), [
    { port: 50002, tls: true, reject: true, tlsStrict: true },
    { port: 50002, tls: true, reject: false, tlsStrict: false },
    { port: 50001, tls: false, reject: false, tlsStrict: false, cleartext: true },
  ]);
});

test('high-level payment defaults reject the insecure transport escape hatch', async () => {
  await assert.rejects(
    () => connect({ allowInsecureTransport: true }),
    /non-payment only.*verify: false/,
  );
});
