/**
 * scripts/verify.mjs
 *
 * End-to-end verification battery: runs every cascan command against the
 * live network and asserts output shape + exit codes. Exits 1 on any FAIL.
 *
 *   node scripts/verify.mjs
 */

import { spawn } from 'node:child_process';

const BIN = new URL('../bin/cascan.js', import.meta.url).pathname;
const GENESIS_CA = 'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy';
const GENESIS_LEGACY = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const KNOWN_TX = '3387418aaddb4927209c5032f515aa442a6587d6e54677f08a03b8fa7789e688';
const DOGECASH = '8473d94f604de351cdee3030f6c354d36b257861ad8e95bbc0a06fbab2a2f9cf';

let pass = 0, fail = 0;

function run(args, { timeout = 45_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, out, err: err + '\nTIMEOUT' }); }, timeout);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

const j = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

console.log('cascan verification battery\n');

// 1) balance: three quorum modes agree
{
  const any = j(await run(['balance', GENESIS_CA, '--json']));
  const maj = j(await run(['balance', GENESIS_CA, '--quorum', 'majority', '--json']));
  const all = j(await run(['balance', GENESIS_CA, '--quorum', 'all', '--json']));
  check('balance --quorum any → ok envelope', any?.ok === true && any.schema === 'cascan.balance/v1');
  check('balance --quorum majority → ok', maj?.ok === true);
  check('balance --quorum all → ok (unanimous)', all?.ok === true);
  check('all three modes agree on totalSats',
    any?.data?.balance?.totalSats === maj?.data?.balance?.totalSats &&
    maj?.data?.balance?.totalSats === all?.data?.balance?.totalSats,
    `${any?.data?.balance?.totalSats} vs ${maj?.data?.balance?.totalSats} vs ${all?.data?.balance?.totalSats}`);
  // Majority fans out to the top-ranked discovered servers (capped
  // at 4) instead of the 3 hardcoded ones. ≥2 ok answers = a real quorum.
  check('majority meta carries a real quorum (2–4 ok servers) + no disagreements',
    (() => {
      const ok = maj?.meta?.sources?.fulcrum?.servers?.filter(s => s.status === 'ok').length ?? 0;
      return ok >= 2 && ok <= 4 && maj?.meta?.sources?.fulcrum?.disagreements?.length === 0;
    })());
  check('tokens array present with bcmr attribution',
    Array.isArray(any?.data?.tokens) && any?.meta?.sources?.bcmr?.provider === 'paytaca');
}

// 2) legacy == cashaddr balance (codec live proof)
{
  const a = j(await run(['balance', GENESIS_LEGACY, '--json']));
  const b = j(await run(['balance', GENESIS_CA, '--json']));
  check('legacy and cashaddr balances identical',
    a?.data?.balance?.totalSats === b?.data?.balance?.totalSats,
    `${a?.data?.balance?.totalSats} vs ${b?.data?.balance?.totalSats}`);
  check('legacy input carries BTC-ambiguity warning', (a?.meta?.warnings ?? []).some(w => w.includes('byte-identical')));
}

// 3) tx decode + raw + bad input
{
  const tx = j(await run(['tx', KNOWN_TX, '--json']));
  check('tx decode → ok with vout', tx?.ok === true && tx.data.vout.length >= 1);
  const raw = j(await run(['tx', KNOWN_TX, '--raw']));
  check('tx --raw → cascan.tx-raw/v1 passthrough', raw?.schema === 'cascan.tx-raw/v1' && raw.data.raw != null);
  const bad = await run(['tx', 'not-a-txid', '--json']);
  check('bad txid → exit 1 with error envelope', bad.code === 1 && j(bad)?.ok === false);
}

// 4) offline + misc commands
{
  const addr = j(await run(['addr', GENESIS_LEGACY, '--json']));
  check('addr offline conversion correct', addr?.data?.cashaddr === GENESIS_CA);
  const gas = j(await run(['gas', '--json']));
  check('gas → tiers + relay present', gas?.ok === true && Array.isArray(gas.data.tiers));
  const tok = j(await run(['tokens', DOGECASH, '--json']));
  check('tokens → DogeCash card found', tok?.data?.found === true && tok?.data?.metadata?.symbol === 'DOGECASH');
  const schema = await run(['schema']);
  check('schema lists all ids incl. campaign', schema.out.includes('cascan.campaign/v1'));
}

// 5) campaign one-shot
{
  const c = j(await run(['campaign', GENESIS_CA, '--goal', '100', '--json']));
  check('campaign → progress math', c?.ok === true && c.data.percent === 26.97 || c?.data?.percent > 0);
  check('campaign meta carries prices source', c?.meta?.sources?.prices?.provider === 'coingecko');
  const gated = await run(['campaign', GENESIS_CA, '--webhook', 'https://hooks.slack.com/x']);
  check('campaign --webhook without --watch → exit 1', gated.code === 1 && gated.err.includes('requires --watch'));
}

// 6) watch --once
{
  const w = j(await run(['watch', GENESIS_CA, '--once', '--json']));
  check('watch --once → poll event', w?.schema === 'cascan.watch/v1' && w.event === 'poll' && w.ok === true);
}

// 7) alert — dry-run evaluation, DSL validation, SSRF gate
{
  const a = j(await run(['alert', GENESIS_CA, '--if', 'balance > 0.000001', '--dry-run', '--once', '--ndjson']));
  check('alert --dry-run --once → evaluated event, condition true',
    a?.schema === 'cascan.alert/v1' && a.event === 'evaluated' &&
    a.data?.conditionTrue === true && a.data?.outcome === 'dry-run');
  const usd = j(await run(['alert', GENESIS_CA, '--if', 'balance.usd > 1', '--dry-run', '--once', '--ndjson']));
  // CoinGecko free tier may 429 mid-battery; the honest degradation
  // (null lhs, condition false, partial+rateLimited surfaced) also passes.
  const usdResolved = usd?.data?.lhsValue > 0 && usd?.meta?.sources?.prices?.provider === 'coingecko';
  const usdDegradedHonestly = usd?.data?.lhsValue === null && usd?.data?.conditionTrue === false &&
    usd?.meta?.partial === true && usd?.meta?.sources?.prices?.rateLimited === true;
  check('alert balance.usd resolves (or degrades honestly under 429)', usdResolved || usdDegradedHonestly);
  const badDsl = await run(['alert', GENESIS_CA, '--if', 'balance ~ 5', '--dry-run', '--once']);
  check('alert bad DSL operator → exit 1', badDsl.code === 1);
  const ssrf = await run(['alert', GENESIS_CA, '--if', 'balance > 0', '--webhook', 'http://169.254.169.254/x', '--once']);
  check('alert IMDS webhook blocked → exit 1', ssrf.code === 1 && ssrf.err.includes('blocked'));
}

// 8) history — CSV shape + JSON envelope on a small (3-tx) address;
//    --no-prices keeps it fast and offline-ish
{
  const SMALL = 'bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl';
  const h = await run(['history', SMALL, '--no-prices']);
  check('history CSV → header + rows', h.code === 0 &&
    h.out.startsWith('timestamp,iso_timestamp,txid,height,type') &&
    h.out.split('\r\n').filter(Boolean).length === 4); // header + 2 receives + 1 send
  const hj = j(await run(['history', SMALL, '--no-prices', '--json']));
  check('history --json → envelope with rows + single-server attribution',
    hj?.schema === 'cascan.history/v1' && Array.isArray(hj.data?.rows) &&
    hj.data.rows.length === 3 && typeof hj.meta?.sources?.fulcrum?.answered === 'string');
  check('history ledger math: received == sent for the emptied address',
    hj?.data?.summary?.receivedSats === '3333700' && hj?.data?.summary?.sentSats === '3333700');
  const ranged = j(await run(['history', SMALL, '--no-prices', '--from', '2017-01-01', '--json']));
  check('history --from filters rows', ranged?.data?.rows?.length === 1 && ranged.data.rows[0].type === 'send');
}

// 9) servers — discovery + fleet health
{
  const s = j(await run(['servers', '--json'], { timeout: 90_000 }));
  check('servers → cascan.servers/v1 envelope', s?.ok === true && s.schema === 'cascan.servers/v1');
  check('discovery beats the hardcoded list (fleet > 3 curated)',
    (s?.data?.fleet?.length ?? 0) > 3, `got ${s?.data?.fleet?.length}`);
  check('fleet spans seed/gossip sources, not just curated',
    s?.data?.fleet?.some(f => f.source === 'seed' || f.source === 'gossip'));
  check('consensus height agreed across the fleet',
    s?.data?.consensusHeight > 0 && s.data.fleet.every(f => f.height === null || s.data.consensusHeight - f.height <= 2));
  check('rejections carry reasons (nothing silently dropped)',
    (s?.data?.rejected ?? []).every(r => typeof r.reason === 'string' && r.reason.length > 0));
}

// 10) chipnet — the network CashScript devs build on
{
  const s = j(await run(['servers', '--chipnet', '--json'], { timeout: 90_000 }));
  check('chipnet fleet discovered + verified (≥3 servers)', (s?.data?.fleet?.length ?? 0) >= 3);
  const wrongNet = await run(['balance', 'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy', '--chipnet']);
  check('mainnet address on --chipnet → loud exit 1', wrongNet.code === 1 && wrongNet.err.includes('does not belong'));
}

// 11) error paths
{
  const badCmd = await run(['frobnicate']);
  check('unknown command → exit 1', badCmd.code === 1);
  const badAddr = await run(['balance', 'not-an-address']);
  check('garbage address → exit 1', badAddr.code === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
