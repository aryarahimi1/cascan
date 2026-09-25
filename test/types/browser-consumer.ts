/**
 * Compile-only fixture: a TypeScript consumer of the browser entry point.
 */

import {
  BROWSER_BOOTSTRAP_SERVERS,
  BrowserFulcrumError,
  connect,
  type Balance,
  type BrowserCascan,
  type BrowserServerSnapshot,
} from '@aryarh/cascan/browser';

function expectType<T>(value: T): T {
  return value;
}

export async function browserConsumer(): Promise<void> {
  const bch: BrowserCascan = await connect({
    network: 'mainnet',
    servers: ['wss://electrum.imaginary.cash:50004/', { url: 'wss://bch.loping.net:50004/' }],
    keepaliveMs: 30_000,
  });

  const balance: Balance = await bch.balance('bitcoincash:q…');
  expectType<string>(balance.confirmedSats);
  // @ts-expect-error — browser answers carry no quorum receipt
  balance.receipt;

  expectType<number>(await bch.height());

  const stop = await bch.watch('bitcoincash:q…', (status, event) => {
    expectType<string | null>(status);
    expectType<number>(event.attempt);
  });
  stop();

  bch.on('block', (tip) => {
    expectType<number>(tip.height);
  }).on('failover', (event) => {
    expectType<string>(event.reason);
  });

  const servers: BrowserServerSnapshot[] = bch.servers();
  expectType<string>(servers[0]!.url);
  expectType<string | null>(await bch.killCurrent('demo'));
  expectType<readonly string[]>(BROWSER_BOOTSTRAP_SERVERS.chipnet);

  try {
    await bch.request<string>('server.banner');
  } catch (err) {
    if (err instanceof BrowserFulcrumError) expectType<string | undefined>(err.kind);
  }

  bch.close();
}
