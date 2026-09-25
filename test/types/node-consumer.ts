/**
 * Compile-only fixture: a TypeScript consumer of the Node entry point.
 * `npm run test:types` must accept every line and every @ts-expect-error.
 */

import {
  AllServersFailedError,
  CascanMainnetProvider,
  CascanNetworkProvider,
  connect,
  getNetwork,
  parseAddress,
  queryQuorum,
  type AddressRecord,
  type Cascan,
  type QuorumReceipt,
  type ServerSnapshot,
  type SubscriptionEvent,
} from '@aryarh/cascan';

function expectType<T>(value: T): T {
  return value;
}

export async function nodeConsumer(): Promise<void> {
  const bch: Cascan = await connect({ network: 'chipnet', timeoutMs: 5_000 });

  const balance = await bch.balance('bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl');
  expectType<string>(balance.totalSats);
  expectType<QuorumReceipt | undefined>(balance.receipt);

  const raw = await bch.tx('00'.repeat(32), { verbose: false });
  expectType<string>(raw.tx);
  const verbose = await bch.tx('00'.repeat(32));
  expectType<string>(verbose.tx.txid);

  expectType<number>(await bch.height({ verify: false }));

  const verified = await bch.verify<{ confirmed: number }>('blockchain.address.get_balance', ['x']);
  expectType<number>(verified.value.confirmed);
  expectType<string>(verified.receipt.answered);

  const stop = await bch.watch('bitcoincash:q…', async (status, event: SubscriptionEvent) => {
    expectType<string | null>(status);
    expectType<string>(event.id);
    expectType<'notification' | 'resubscribe' | 'liveness-check'>(event.source);
  });
  stop();

  bch.on('failover', (event) => {
    expectType<string | null>(event.to);
  });
  bch.once('recovered', (event) => {
    expectType<number>(event.outageMs);
  });
  // @ts-expect-error — not a cascan event
  bch.on('failvoer', () => {});

  const snapshot: ServerSnapshot[] = bch.servers();
  expectType<number>(snapshot[0]!.score);

  const cashscript = new CascanNetworkProvider(bch);
  const utxos = await cashscript.getUtxos('bchtest:q…');
  expectType<bigint>(utxos[0]!.satoshis);

  const mainnet = new CascanMainnetProvider(bch);
  expectType<bigint>(await mainnet.getBalance('bitcoincash:q…'));
  expectType<number>((await mainnet.getHeader(1, true)).timestamp);
  expectType<string>((await mainnet.getHeader(1)).hex);

  const quorum = await queryQuorum<number>('blockchain.headers.subscribe', [], { mode: 'majority' });
  expectType<number>(quorum.value);

  const record: AddressRecord = parseAddress('bitcoincash:q…', { network: 'mainnet' });
  expectType<string | null>(record.legacy);
  expectType<'bitcoincash' | 'bchtest'>(getNetwork('chipnet').cashaddrPrefix);

  try {
    await connect({ verify: false, allowInsecureTransport: true });
  } catch (err) {
    if (err instanceof AllServersFailedError) expectType<'ALL_SERVERS_FAILED'>(err.code);
  }

  // @ts-expect-error — insecure transport is non-payment only and requires verify: false
  await connect({ allowInsecureTransport: true });
  // @ts-expect-error — unknown network
  await connect({ network: 'testnet3' });

  await bch.close();
}
