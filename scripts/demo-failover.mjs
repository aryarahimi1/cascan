#!/usr/bin/env node
/**
 * scripts/demo-failover.mjs — the "your app stops dying" demo.
 *
 * Watches an address through the cascan library while REPEATEDLY KILLING
 * the live server connection. The subscription resurrects on the next
 * server every time; anything that happened during the gap is delivered.
 * Use this script to demonstrate connection failover and subscription recovery.
 *
 *   node scripts/demo-failover.mjs [address] [--kills N] [--interval SEC]
 *
 * Defaults: 3 kills, 12s apart, a known test address. Ctrl+C to stop early.
 */

import { connect } from '../src/index.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
const address = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--kills' && argv[argv.indexOf(a) - 1] !== '--interval')
  ?? 'bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl';
const KILLS = flag('--kills', 3);
const INTERVAL_S = flag('--interval', 12);

const dim = s => `\x1b[2m${s}\x1b[22m`;
const bold = s => `\x1b[1m${s}\x1b[22m`;
const green = s => `\x1b[32m${s}\x1b[39m`;
const red = s => `\x1b[31m${s}\x1b[39m`;
const cyan = s => `\x1b[36m${s}\x1b[39m`;
const ts = () => dim(new Date().toISOString().slice(11, 19));

console.log('');
console.log(bold('  cascan failover demo — never trust one server again'));
console.log(dim('  the watch below survives every server death you\'re about to see\n'));

// 1. Connect: discovery (cached) → health-ranked pool → best server.
const bch = await connect({ onLog: m => console.log(`  ${ts()} ${dim(m)}`) });
console.log(`  ${ts()} connected → ${cyan(bch.pool.current)} ${dim(`(pool of ${bch.pool.servers.length} verified servers)`)}`);

// 2. Baseline: quorum-verified balance, receipts included.
const bal = await bch.balance(address, { verify: true });
console.log(`  ${ts()} balance ${bold(bal.totalSats)} sats ${dim(`— verified by ${bal.receipt.servers.filter(s => s.status === 'ok').length} independent servers, answered by ${bal.receipt.answered}`)}\n`);

// 3. The standing watch — the thing that must not die.
let events = 0;
await bch.watch(address, () => {
  events++;
  console.log(`  ${ts()} ${green('⚡ activity on the address!')} ${dim('(status change delivered)')}`);
});
console.log(`  ${ts()} ${bold('watching')} ${address.slice(0, 28)}… ${dim('— subscription live')}\n`);

bch.on('failover', f => {
  console.log(`  ${ts()} ${green('✓ failed over')} → ${cyan(f.to)} ${dim('— subscription resurrected, gap events (if any) delivered')}\n`);
});
bch.on('exhausted', () => {
  console.log(`  ${ts()} ${red('✗ ENTIRE pool unreachable — loud death (this is the honest failure mode)')}`);
  process.exit(2);
});

// 4. Chaos: murder the live connection, repeatedly.
for (let i = 1; i <= KILLS; i++) {
  await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
  console.log(`  ${ts()} ${red(`💥 kill #${i}:`)} destroying the connection to ${cyan(bch.pool.current)} ${dim('(as if the server just died)')}`);
  await bch.pool.killCurrent(`demo kill #${i}`);
}

await new Promise(r => setTimeout(r, 3000));
console.log(dim(`\n  survived ${KILLS} server deaths — watch still live on ${bch.pool.current}, ${events} event(s) delivered, 0 lost.`));
console.log(dim('  the one-line version of this demo:\n'));
console.log('    const bch = await connect();');
console.log('    await bch.watch(address, onPayment);   // survives everything above\n');
await bch.close();
process.exit(0);
