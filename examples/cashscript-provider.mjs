/**
 * examples/cashscript-provider.mjs
 *
 * The one-line CashScript integration. CashScript's default
 * ElectrumNetworkProvider talks to ONE hardcoded server with no fallback —
 * its own docs say so. This swap gives every CashScript contract discovery,
 * health-scored server selection, and transparent failover:
 *
 *   const provider = new ElectrumNetworkProvider('mainnet');     // before
 *   const provider = new CascanNetworkProvider(await connect()); // after
 *
 * Run it (no cashscript install needed — the provider interface is
 * standardized and duck-typed):
 *
 *   node examples/cashscript-provider.mjs [address]
 */

import { connect, CascanNetworkProvider } from '../src/index.js';

const address = process.argv[2] ?? 'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy';

const bch = await connect();
const provider = new CascanNetworkProvider(bch);

// In a real CashScript app this object goes straight into the SDK:
//   import { Contract } from 'cashscript';
//   const contract = new Contract(artifact, args, { provider });

console.log('network       :', provider.network);
console.log('block height  :', await provider.getBlockHeight());

const utxos = await provider.getUtxos(address);
const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
console.log(`utxos         : ${utxos.length} (${total} sats) on ${address.slice(0, 30)}…`);
const withTokens = utxos.filter(u => u.token);
if (withTokens.length > 0) {
  console.log(`cashtokens    : ${withTokens.length} token UTXO(s), first category ${withTokens[0].token.category.slice(0, 16)}…`);
}

console.log('served by     :', bch.pool.current, `(pool of ${bch.pool.servers.length} — failover automatic)`);
await bch.close();
