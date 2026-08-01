/**
 * scripts/probe-seed.mjs
 *
 * Inspect what the ec-seed.flowee.cash DNS seed returns
 * us, and what do seeded servers expose via server.features and
 * server.peers.subscribe? Run before designing discovery; keep for re-probes.
 *
 *   node scripts/probe-seed.mjs
 */

import { resolve4 } from 'node:dns/promises';
import { FulcrumClient } from '../src/fulcrum/client.js';

const SEED = 'ec-seed.flowee.cash';

const ips = await resolve4(SEED).catch(e => { console.log('seed resolve failed:', e.message); return []; });
console.log(`${SEED} A records:`, ips, '\n');

for (const ip of ips) {
  for (const [proto, port, tlsOn, reject] of [
    ['ssl-strict', 50002, true, true],
    ['ssl-insecure', 50002, true, false],
    ['tcp', 50001, false, false],
  ]) {
    const c = new FulcrumClient({ host: ip, port, tls: tlsOn, rejectUnauthorized: reject, timeoutMs: 6000 });
    const t0 = Date.now();
    try {
      await c.connect();
      const ms = Date.now() - t0;
      const [sw, protoV] = c.serverVersion;
      let feat = null, peers = null, tip = null;
      try { feat = await c.request('server.features'); } catch (e) { feat = `ERR ${e.message}`; }
      try { tip = await c.request('blockchain.headers.subscribe'); } catch { /**/ }
      try { peers = await c.request('server.peers.subscribe'); } catch (e) { peers = `ERR ${e.message}`; }
      console.log(`${ip} ${proto} OK ${ms}ms — ${sw} (protocol ${protoV}) height=${tip?.height}`);
      if (typeof feat === 'object' && feat) {
        console.log(`  features: hosts=${JSON.stringify(feat.hosts)} genesis=${feat.genesis_hash?.slice(0, 16)}… pruning=${feat.pruning ?? 'none'}`);
      } else {
        console.log(`  features: ${feat}`);
      }
      if (Array.isArray(peers)) {
        console.log(`  peers (${peers.length}):`);
        for (const p of peers.slice(0, 6)) console.log('   ', JSON.stringify(p));
        if (peers.length > 6) console.log(`    … ${peers.length - 6} more`);
      } else {
        console.log(`  peers: ${peers}`);
      }
      c.close();
      break; // first working proto per IP is enough
    } catch (e) {
      console.log(`${ip} ${proto} FAIL — ${e.message}`);
      c.close();
    }
  }
  console.log('');
}
