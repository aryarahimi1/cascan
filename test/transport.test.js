/**
 * test/transport.test.js
 *
 * RFC 6455 frame codec tests (no network) + network registry contracts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsEncodeText, wsDecodeFrames, wsEncodePong } from '../src/fulcrum/client.js';
import { NETWORKS, NETWORK_NAMES, getNetwork } from '../src/networks.js';
import { parseAddress, AddressError } from '../src/address.js';

// ---------------------------------------------------------------------------
// WebSocket framing
// ---------------------------------------------------------------------------

/** Build an UNMASKED server-side text frame (servers must not mask). */
function serverTextFrame(text, { fin = true, opcode = 0x1 } = {}) {
  const data = Buffer.from(text, 'utf8');
  let header;
  if (data.length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, data.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode; header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  }
  return Buffer.concat([header, data]);
}

test('ws: client frames are masked; server frame decodes back to the payload', () => {
  const enc = wsEncodeText('{"id":1}');
  assert.equal(enc[0], 0x81, 'FIN + text opcode');
  assert.equal(enc[1] & 0x80, 0x80, 'client frames MUST set the mask bit');

  const { messages } = wsDecodeFrames(serverTextFrame('{"result":42}'));
  assert.deepEqual(messages, ['{"result":42}']);
});

test('ws: split frames across reads — partial data is carried, not lost', () => {
  const frame = serverTextFrame('{"id":7,"result":"long-ish payload here"}');
  const first = wsDecodeFrames(frame.subarray(0, 5));
  assert.equal(first.messages.length, 0);
  assert.equal(first.rest.length, 5);
  const second = wsDecodeFrames(Buffer.concat([first.rest, frame.subarray(5)]));
  assert.deepEqual(second.messages, ['{"id":7,"result":"long-ish payload here"}']);
});

test('ws: fragmented message reassembled (text + continuation)', () => {
  const part1 = serverTextFrame('{"id":1,', { fin: false, opcode: 0x1 });
  const part2 = serverTextFrame('"result":9}', { fin: true, opcode: 0x0 });
  const { messages } = wsDecodeFrames(Buffer.concat([part1, part2]));
  assert.deepEqual(messages, ['{"id":1,"result":9}']);
});

test('ws: extended 16-bit length frames decode', () => {
  const big = 'x'.repeat(300);
  const { messages } = wsDecodeFrames(serverTextFrame(big));
  assert.equal(messages[0].length, 300);
});

test('ws: ping surfaces for ponging; close terminates; pong frame is masked', () => {
  const ping = Buffer.from([0x89, 0x02, 0xab, 0xcd]); // ping, 2-byte payload
  const close = Buffer.from([0x88, 0x00]);
  const r = wsDecodeFrames(Buffer.concat([ping, close]));
  assert.equal(r.pings.length, 1);
  assert.deepEqual([...r.pings[0]], [0xab, 0xcd]);
  assert.equal(r.closed, true);
  const pong = wsEncodePong(r.pings[0]);
  assert.equal(pong[0], 0x8a);
  assert.equal(pong[1] & 0x80, 0x80, 'client pong must be masked');
});

// ---------------------------------------------------------------------------
// Network registry + network-aware addresses
// ---------------------------------------------------------------------------

test('networks: registry is complete and internally consistent', () => {
  assert.deepEqual(NETWORK_NAMES, ['mainnet', 'chipnet', 'testnet4']);
  for (const name of NETWORK_NAMES) {
    const net = getNetwork(name);
    assert.equal(net.name, name);
    assert.ok(net.curated.length >= 2, `${name} has curated servers`);
    assert.ok(net.checkpoints.length === 2, `${name} has 2 checkpoints`);
    for (const cp of net.checkpoints) assert.match(cp.hash, /^[0-9a-f]{64}$/);
  }
  // chipnet and testnet4 diverge at the checkpoint — the chains are distinct
  assert.notEqual(NETWORKS.chipnet.checkpoints[0].hash, NETWORKS.testnet4.checkpoints[0].hash);
  assert.throws(() => getNetwork('btc'), /unknown network/);
});

test('address: bchtest cashaddr parses on chipnet, keeps its prefix', () => {
  const rec = parseAddress('bchtest:qr7fzmep8g7h7ymfxy74lgc0v950j3r295pdnvy3hr', { network: 'chipnet' });
  assert.equal(rec.network, 'chipnet');
  assert.match(rec.cashaddr, /^bchtest:/);
  // same hash160 as the mainnet twin — only the encoding differs
  assert.equal(Buffer.from(rec.hash).toString('hex'), 'fc916f213a3d7f1369313d5fa30f6168f9446a2d');
});

test('address: wrong-network prefix fails loudly (never silently zero)', () => {
  assert.throws(
    () => parseAddress('bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl', { network: 'chipnet' }),
    /does not belong to chipnet/
  );
  assert.throws(
    () => parseAddress('bchtest:qr7fzmep8g7h7ymfxy74lgc0v950j3r295pdnvy3hr', { network: 'mainnet' }),
    AddressError
  );
});

test('address: bare payload assumes the network prefix', () => {
  const rec = parseAddress('qr7fzmep8g7h7ymfxy74lgc0v950j3r295pdnvy3hr', { network: 'chipnet' });
  assert.match(rec.cashaddr, /^bchtest:/);
});

test('address: testnet legacy version bytes (0x6f/0xc4) accepted on chipnet', () => {
  const main = parseAddress('bchtest:qr7fzmep8g7h7ymfxy74lgc0v950j3r295pdnvy3hr', { network: 'chipnet' });
  const roundTrip = parseAddress(main.legacy, { network: 'chipnet' });
  assert.equal(roundTrip.cashaddr, main.cashaddr);
  // and the same legacy string is NOT valid on mainnet
  assert.throws(() => parseAddress(main.legacy, { network: 'mainnet' }), /version byte/);
});

test('ws: fragment head in one read, continuation in the next — carried, not lost', () => {
  const part1 = serverTextFrame('{"id":1,', { fin: false, opcode: 0x1 });
  const part2 = serverTextFrame('"result":9}', { fin: true, opcode: 0x0 });
  const r1 = wsDecodeFrames(part1, null);
  assert.equal(r1.messages.length, 0);
  assert.ok(r1.fragments, 'fragment head retained');
  const r2 = wsDecodeFrames(part2, r1.fragments);
  assert.deepEqual(r2.messages, ['{"id":1,"result":9}']);
  assert.equal(r2.fragments, null);
});
