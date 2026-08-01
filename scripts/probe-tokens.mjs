/**
 * scripts/probe-tokens.mjs
 *
 * Inspect the CashToken response shapes returned by public servers.
 *   1. Fulcrum get_balance / get_history with "include_tokens" and
 *      "tokens_only" filters (shape on an address with no tokens).
 *   2. Chaingraph → find a REAL holder of the DogeCash category, derive
 *      their cashaddr from locking_bytecode.
 *   3. bcmr.paytaca.com endpoints for category metadata.
 *   4. include_tokens on the real holder — confirm tokens show up.
 */

import { FulcrumClient } from '../src/fulcrum/client.js';
import { encodeCashAddr } from '../src/cashaddr.js';

const HOST = 'electrum.imaginary.cash';
const GENESIS = 'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy';
const DOGECASH_CATEGORY = '8473d94f604de351cdee3030f6c354d36b257861ad8e95bbc0a06fbab2a2f9cf';
const CHAINGRAPH = 'https://gql.chaingraph.pat.mn/v1/graphql';
const BCMR = 'https://bcmr.paytaca.com';

const log = (t, v) => console.log(`\n=== ${t} ===\n`, typeof v === 'string' ? v : JSON.stringify(v, null, 2)?.slice(0, 1500));

// ---------- 1) Fulcrum token-filter shapes on a tokenless address ----------
const c = new FulcrumClient({ host: HOST, port: 50002, tls: true, timeoutMs: 10_000 });
await c.connect();
log('server', c.serverVersion);

for (const filter of ['include_tokens', 'tokens_only', 'exclude_tokens']) {
  try {
    const r = await c.request('blockchain.address.get_balance', [GENESIS, filter]);
    log(`get_balance(addr, "${filter}")`, r);
  } catch (e) {
    log(`get_balance(addr, "${filter}")`, `ERROR: ${e.message}`);
  }
}

// ---------- 2) Chaingraph → real holder of DogeCash ----------
async function chaingraph(query) {
  const res = await fetch(CHAINGRAPH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`chaingraph HTTP ${res.status}`);
  return res.json();
}

let holderAddr = null;
for (const catBytes of [`\\x${DOGECASH_CATEGORY}`, `\\x${DOGECASH_CATEGORY.match(/../g).reverse().join('')}`]) {
  try {
    const q = `{ output(where: { token_category: { _eq: "${catBytes}" } }, limit: 5) { locking_bytecode token_category } }`;
    const r = await chaingraph(q);
    log(`chaingraph outputs for category ${catBytes.slice(0, 14)}…`, r);
    const rows = r?.data?.output ?? [];
    for (const row of rows) {
      const lb = row.locking_bytecode;
      // P2PKH: 76a914<20B>88ac → hash160 → cashaddr
      if (/^76a914[0-9a-f]{40}88ac$/.test(lb)) {
        const hash = Uint8Array.from(Buffer.from(lb.slice(6, 46), 'hex'));
        holderAddr = encodeCashAddr('bitcoincash', 'p2pkh', hash);
        break;
      }
    }
    if (holderAddr) break;
  } catch (e) {
    log('chaingraph', `ERROR: ${e.message}`);
  }
}
log('holder address (P2PKH)', holderAddr ?? 'none found');

// ---------- 3) BCMR metadata endpoints ----------
for (const path of [
  `/api/tokens/${DOGECASH_CATEGORY}/`,
  `/api/bcmr/${DOGECASH_CATEGORY}/`,
]) {
  try {
    const res = await fetch(`${BCMR}${path}`, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    log(`BCMR GET ${path} → HTTP ${res.status}`, text.slice(0, 1200));
  } catch (e) {
    log(`BCMR GET ${path}`, `ERROR: ${e.message}`);
  }
}

// ---------- 4) include_tokens on the real holder ----------
if (holderAddr) {
  try {
    const r = await c.request('blockchain.address.get_balance', [holderAddr, 'include_tokens']);
    log(`get_balance(holder, "include_tokens") on ${holderAddr}`, r);
  } catch (e) {
    log('holder include_tokens', `ERROR: ${e.message}`);
  }
}

c.close();
console.log('\nprobe done');
