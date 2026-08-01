/**
 * examples/merchant-webhook.mjs
 *
 * Watchtower-style payment monitoring in ~30 lines: watch a set of
 * addresses (your POS invoices, donation address, treasury), POST every
 * payment to your backend, survive every server death in between.
 *
 * The CLI equivalent for a single address is one line of shell:
 *
 *   cascan watch <address> --0conf --webhook https://your-api/hook
 *
 * This example is the library version — multiple addresses, one pool,
 * one process.
 *
 *   node examples/merchant-webhook.mjs <webhook-url> <address> [address…]
 */

import { connect } from '../src/index.js';
import { postWebhook } from '../src/commands/webhook.js';

const [webhookUrl, ...addresses] = process.argv.slice(2);
if (!webhookUrl || addresses.length === 0) {
  console.error('usage: node examples/merchant-webhook.mjs <webhook-url> <address> [address…]');
  process.exit(1);
}

const bch = await connect();
console.log(`pool: ${bch.pool.servers.length} servers, connected to ${bch.pool.current}`);

// Ops visibility: failovers are normal operation, exhaustion is the pager.
bch.on('failover', f => console.log(`! failover ${f.from} → ${f.to} — subscriptions resurrected`));
bch.on('exhausted', () => { console.error('!! entire pool unreachable'); process.exit(2); });

for (const address of addresses) {
  await bch.watch(address, async () => {
    // Something changed on this address (payment in, confirmation, spend).
    // Fetch the current state and hand YOUR system the facts.
    const bal = await bch.balance(address).catch(() => null);
    const event = {
      schema: 'merchant-example/v1',
      ts: new Date().toISOString(),
      address,
      totalSats: bal?.totalSats ?? null,
      server: bch.pool.current,
    };
    try {
      await postWebhook(webhookUrl, event); // SSRF-guarded, DNS-pinned POST
      console.log(`→ webhook fired for ${address.slice(0, 24)}… (${event.totalSats} sats)`);
    } catch (err) {
      console.error(`! webhook failed: ${err.message}`);
    }
  });
  console.log(`watching ${address}`);
}

console.log('monitoring — Ctrl+C to stop');
