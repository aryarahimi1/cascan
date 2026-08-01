import { createHash } from 'node:crypto';
import { getNetwork } from '../networks.js';

export class ChainVerificationError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ChainVerificationError';
    this.code = opts.code ?? 'CHAIN_VERIFICATION_FAILED';
    this.kind = 'security';
    this.server = opts.server;
    this.method = 'blockchain.block.header';
    this.network = opts.network;
    this.height = opts.height;
  }
}

/** Double-SHA256 of an exact 80-byte block header, byte-reversed. */
export function headerHash(headerHex) {
  if (typeof headerHex !== 'string' || !/^[0-9a-f]{160}$/i.test(headerHex)) {
    throw new ChainVerificationError('server returned a malformed 80-byte block header', {
      code: 'MALFORMED_CHECKPOINT_HEADER',
    });
  }
  const h1 = createHash('sha256').update(Buffer.from(headerHex, 'hex')).digest();
  return createHash('sha256').update(h1).digest().reverse().toString('hex');
}

/**
 * Prove the selected BCH network on the client's current socket.
 * This must run after connect() and before the socket serves application data.
 */
export async function verifyBchChain(client, networkName = 'mainnet') {
  const network = getNetwork(networkName);
  client.chainVerified = null;
  for (const checkpoint of network.checkpoints) {
    let header;
    try {
      header = await client.request('blockchain.block.header', [checkpoint.height]);
    } catch (err) {
      if (err?.kind === 'transport') throw err;
      throw new ChainVerificationError(
        `could not verify ${network.name} checkpoint ${checkpoint.height}: ${err?.message ?? String(err)}`,
        {
          code: 'CHECKPOINT_UNAVAILABLE',
          server: client.name,
          network: network.name,
          height: checkpoint.height,
        },
      );
    }

    let hash;
    try {
      hash = headerHash(header);
    } catch (err) {
      if (err instanceof ChainVerificationError) {
        err.server = client.name;
        err.network = network.name;
        err.height = checkpoint.height;
      }
      throw err;
    }
    if (hash !== checkpoint.hash) {
      throw new ChainVerificationError(
        `wrong chain: checkpoint ${checkpoint.height} does not match ${network.name}`,
        {
          code: 'WRONG_CHAIN',
          server: client.name,
          network: network.name,
          height: checkpoint.height,
        },
      );
    }
  }
  client.chainVerified = network.name;
  return network.name;
}
