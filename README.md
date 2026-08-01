# cascan

**Never depend on one Fulcrum server again — automatic discovery, failover,
and restored subscriptions, with strict quorum verification on Node.**

> **Beta candidate:** ready for public review, demos, and limited pilot
> integrations—not a standalone payment oracle. Browser mode improves
> availability but accepts one active server's plausible answers; do not use a
> browser response alone to release funds, credit deposits, or grant token
> access. See the [dapp security contract](docs/dapp-security.md).

cascan is Bitcoin Cash's connection-reliability layer: a zero-runtime-dependency
library (server discovery via [Flowee's DNS seed](https://ipfs.flowee.org/docs/electrum-servers/)
+ peer gossip, per-server health scoring, transparent auto-failover,
subscriptions that survive server death, strict quorum receipts) — with a
full-featured CLI as its first consumer. No API keys or accounts. Node gets
DNS/gossip discovery and quorum; browsers get
automatic WSS bootstrapping, failover, and subscription restoration.

## The library

Your app stops dying when a server dies — in ten lines:

```js
import { connect } from '@aryarh/cascan';

const bch = await connect();                       // DNS seed + gossip + probing; curated fallback
const address = 'bitcoincash:qr7f…';
const { totalSats } = await bch.balance(address);

await bch.watch(address, async (_status, event) => {
  const latest = await bch.balance(address);        // strict re-query, then acknowledge
  console.log('payment activity', event.id, latest.totalSats);
});                                                // stable ID across retries

bch.on('failover', f => console.log(`${f.from} died → now on ${f.to}`));
```

Every exact Node socket is **verified before it may answer**: it must use
certificate-authenticated TLS, speak the Electrum protocol, and match the BCH
fork checkpoints (block 478559 rejects BTC servers, 556767 rejects BSV).
Discovery verification is repeated on every later pool and quorum connection,
so a stale cache or changed endpoint cannot inherit an old trust decision.
Health (latency EMA, height lag,
failure history) is scored continuously; the pool is cached in
`~/.cascan/servers.json` (24h TTL).

Node `balance()`, `tx()`, and `height()` use strict quorum verification by
default: they require matching responses from at least two eligible operator
identities and reject a plurality/tie. Gossip servers improve availability
but do not automatically become security voters. Duplicate operators,
declared infrastructure groups, observed IP addresses, and exact TLS
certificate fingerprints count once. Each call returns a receipt showing who
answered, agreed, disagreed, or was excluded:

```js
const bal = await bch.balance(addr);
// bal.receipt = { answered, answeredOperator, operators: [...], servers: [...], ... }
```

Use `verify: false` only for an explicit single-server latency trade-off;
raw `request()` is likewise an unverified escape hatch.

Read the [dapp security contract](docs/dapp-security.md) before using cascan
to authorize money movement, token access, or confirmations.

When the entire pool is unreachable you get `AllServersFailedError` —
loud failure for the current request, never silent staleness. A pool that was
previously connected keeps exactly one bounded background recovery attempt:
failed endpoints enter exponential equal-jitter cooldowns, all connection
attempts share a global budget, and failure debt clears only after 60 seconds
of healthy uptime. `recovery-scheduled` and `recovered` make the outage visible.
The recovery lifecycle remains active until `close()`; an initial `connect()`
failure does not leave an inaccessible background task.

`watch()` callbacks may be synchronous or async. A throw, rejected promise,
or 30-second timeout emits `handler-error` and retries with bounded backoff
and the same event ID. This is in-process **at-least-once** delivery, so make
handlers idempotent using `event.id`; a timed-out handler may finish after its
retry starts. While a handler is blocked, cascan retains the active event and
only the newest not-yet-started status, because Electrum statuses are refresh
signals rather than a transaction ledger. The pool also re-queries subscribed
state in round-robin batches (every 30 seconds by default), so a working ping
cannot hide a silent notification channel. There is no durable queue across a
process/page crash: always re-query verified state after startup and on every
callback.

Full API reference: **[docs/library.md](docs/library.md)**. Networks:
`mainnet` (default), `chipnet` — where CashScript contract development
happens — and `testnet4`, each with its own verified pool and checkpoints:

```js
const bch = await connect({ network: 'chipnet' });
```

### Directly from a browser

Browser builds use the platform's native `WebSocket` and Web Crypto APIs.
Cascan automatically starts from its built-in WSS bootstrap pool, verifies
each server's BCH fork checkpoints, health-ranks the healthy servers, fails
over, and restores address subscriptions:

```js
import { connect } from '@aryarh/cascan/browser';

const bch = await connect();

console.log(await bch.height(), bch.pool.current);
await bch.watch(address, async (_status, event) => {
  const latest = await bch.balance(address);        // display only: one server's claim
  console.log('payment activity', event.id, latest.totalSats);
});
```

Apps and users can still override the pool with
`connect({ servers: ['wss://…', 'wss://…'] })`.

Run the browser demo from the repository root:

```sh
npm run serve:browser
# open http://localhost:4173/examples/browser/
# FundMe-style chipnet display pilot:
# open http://localhost:4173/examples/fundme-pilot/
```

The [FundMe-style chipnet pilot](docs/fundme-chipnet-pilot.md) is a
representative campaign monitor, not FundMe production code. It intentionally
contains no pledge, signing, claim, refund, payout, or payment-authorization
path: browser progress remains one active server's display-only claim.

The browser build uses automatic WSS bootstrapping rather than Node's DNS/TCP
discovery because browsers cannot use those APIs. Fulcrum peer gossip usually
advertises raw TCP/TLS endpoints, not browser-compatible WSS endpoints. Browser
quorum is not implemented yet, so a single-server balance remains that
server's claim. Chain identity, failover, health, and subscription continuity
are enforced. Hostile WSS traffic is bounded: 2 MiB messages, 256 JSON records
per message and per second, 128 notifications per second, 16 records per event
loop turn, 10,000 records per result array, and 64 in-flight requests by
default. Queue or validation violations close that server and trigger pool
failover; block notifications require an exact 80-byte header. Direct Electrum
connections reveal the user's IP address and queried BCH addresses to each
selected server; cascan never handles private keys.

### CashScript in one line

CashScript's default `ElectrumNetworkProvider` is a single hardcoded
server with no fallback — its own docs say so. Swap it:

```js
import { connect, CascanNetworkProvider } from '@aryarh/cascan';

const provider = new CascanNetworkProvider(await connect());
const contract = new Contract(artifact, args, { provider }); // unchanged
```

### mainnet-js too

```js
import { connect, CascanMainnetProvider } from '@aryarh/cascan';
const provider = new CascanMainnetProvider(await connect());
```

Full interface by shape — headers, batches, `loadInputValues` vin
enrichment, `waitForBlock`, and address/tx subscriptions that inherit the
pool's failover + resurrection guarantees (which the stock single-client
provider does not have). Transactions, parent enrichment, headers, history,
relay fee, and balance are quorum-checked; malformed or disagreeing results
fail closed.

Implements the full standardized interface (`getUtxos`,
`getUtxosForLockingBytecode`, `getBlockHeight`, `getRawTransaction`,
`sendRawTransaction`) with CashTokens mapped to bigint `token` details and
the documented `NetworkProvider*Error` names on broadcast failures. Signing
candidates are checked against quorum-agreed raw funding transactions, so a
server cannot hide a CashToken prefix and induce a token burn. Broadcast
success — including "already in mempool" — is returned only after two
matching servers can retrieve the exact transaction. Raw transaction reads
also require strict quorum and hash the returned bytes back to the requested
txid. See
`examples/cashscript-provider.mjs`.

### See the failover with your own eyes

```sh
node scripts/demo-failover.mjs   # kills the live connection 3×; the watch survives
```

Lineage: the architecture and honesty philosophy are ported from
[glnc](https://github.com/aryarahimi1/glnc) ("Etherscan in your terminal")
by the same author — rebuilt BCH-native.

## The CLI

```sh
cascan servers               # fleet health: who's up, at what height, how fast
cascan balance bitcoincash:qr7f...
cascan balance qr7f... --quorum majority --json | jq .meta.sources.fulcrum
cascan watch bitcoincash:qr7f... --0conf --webhook https://...
cascan alert bitcoincash:qr7f... --if "balance.usd > 1000" --webhook https://...
cascan history bitcoincash:qr7f... --cost-basis fifo --out taxes.csv
cascan tx 3387418a...
cascan tokens 8473d94f...    # CashToken category card (BCMR)
cascan campaign bitcoincash:qr7f... --goal 100 --watch
cascan gas
cascan addr 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa   # offline
cascan interactive           # arrow-key REPL over every command
cascan schema
```

## Install

The reviewed public beta is [`@aryarh/cascan@0.4.0-beta.2`](https://www.npmjs.com/package/@aryarh/cascan/v/0.4.0-beta.2).
Pin the exact prerelease during pilots:

```sh
npm install @aryarh/cascan@0.4.0-beta.2
```

For the CLI without a global install:

```sh
npx --package=@aryarh/cascan@0.4.0-beta.2 cascan --help
```

The unscoped `cascan` package is **not** this project. This remains a beta: do
not treat a plain, unpinned install as a production-stability promise.

To evaluate a reviewed checkout directly:

```sh
npm test
node bin/cascan.js --help
```

See [the release-security checklist](docs/release-security.md) for the controls
used for public releases.

## Why

Single hardcoded Electrum servers remain common in BCH applications, so an
otherwise healthy app can lose balance reads, payment detection, or broadcast
access when its chosen server fails.
Flowee built a [DNS seed](https://ipfs.flowee.org/docs/electrum-servers/)
because "hardcoding one server puts a target on its back"; POS builders
cite the single point of failure; CashScript's own docs admit its default
provider has no fallback. cascan is that missing layer: discovery,
health-scored failover, and — for whoever wants them — receipts showing
which server answered, at what height, and whether anyone disagreed.

## Commands

| Command | What it does |
|---|---|
| `balance <address>` | Quorum-checked balance **with CashTokens** (per-category FT amounts, NFTs, BCMR-enriched symbols). `--quorum any\|majority\|all` (default `majority`; `any` is the explicit low-latency option) |
| `servers` | **Fleet health:** discovers the public Fulcrum fleet live (DNS seed + gossip + curated), verifies chain identity, and prints per-server transport, software, height, latency, and score — plus every rejected server with the reason. Refreshes the pool cache |
| `watch <address>` | **Payments.** Pool-backed status trigger with acknowledged callback delivery; a dying server triggers failover + subscription resurrection, and periodic re-queries recover silent notification loss. `--0conf` fires webhooks on mempool sightings, `--webhook <url>` POSTs envelopes, `--once` snapshots and exits |
| `alert <address>` | **Standing conditions.** `--if "<path> <op> <number>"` (paths: `balance`, `balance.sats`, `balance.usd`, `unconfirmed`, `unconfirmed.sats`) polled on `--interval` (default 60s), quorum-checked. Fires `--webhook` on the false→true **edge** — state in `~/.cascan/alerts.json` dedupes across polls and restarts, re-arms when the condition goes false. `--dry-run` evaluates without firing, `--once` for cron |
| `history <address>` | **Ledger export.** Full confirmed history → CSV (stdout or `--out file`): signed deltas, fees, receive/send/self classification. `--from`/`--to` date range, historical USD prices (keyless: Kraken dailies ≈ 2 years + CoinGecko ≤ 365 days; older rows honestly empty), `--cost-basis fifo` for realized-gain columns, `--no-prices` to skip. Fulcrum-only — no indexer, no API key |
| `campaign <address>` | **Fundraisers.** Raised vs `--goal <BCH>`, donor proxy, progress bar. `--watch` streams progress/goal-reached events (NDJSON) → `--webhook` |
| `interactive` | Arrow-key REPL over the same engine — every flow builds the exact `parsed` object the flag CLI would, so the two surfaces cannot drift |
| `tokens <category>` | CashToken category card from BCMR (issuer-published metadata, labeled as a claim, not consensus) |
| `tx <txid>` | Decode a transaction. `--raw` = provider-verbatim (`cascan.tx-raw/v1`) |
| `gas` | Fee tiers (estimatefee), relay fee, mempool note |
| `addr <address>` | Offline: validate + convert cashaddr ↔ legacy, hash160, locking script, scripthash |
| `schema [<id>]` | List / print stable schema ids |

Global flags: `--json` `--ndjson` `--strict` `--verbose` `--no-color` `--server host:port` (pin to one Fulcrum server).

Honesty notes: live commands die loudly on a dead server (two failed
keepalives → `stop` event + exit 2). Campaign "raised" is the current
balance and "donors" the tx count — approximations, labeled as such in
every envelope.

Address input: cashaddr (`bitcoincash:q...` or bare `q...`) or legacy
(`1...`/`3...`). Legacy strings are byte-identical on BTC — cascan treats
them as BCH and attaches a warning to the envelope.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Input error (bad address/flags/unknown command) |
| 2 | All Fulcrum servers failed |
| 3 | Quorum disagreement or partial result under `--strict` |

## The envelope contract

Every `--json` line: `{ schema, ts, ok, data, error, meta }`.
`meta.sources.fulcrum` carries the provenance: `answered`, `height`,
`answeredOperator`, agreeing `operators`, `voterCount`, per-server
`statuses[]` (ok/failed/not-tried + latency and independence), `disagreements[]`
(plurality record under `--quorum majority`), `degraded[]` (quorum
requested but <2 servers answered). `meta.partial` flips true on any
degradation — combine with `--strict` to fail automated checks.

Schemas: `cascan.balance/v1` · `cascan.tx/v1` · `cascan.tx-raw/v1` ·
`cascan.gas/v1` · `cascan.watch/v1` · `cascan.addr/v1` · `cascan.tokens/v1` ·
`cascan.campaign/v1` · `cascan.history/v1` · `cascan.alert/v1` ·
`cascan.servers/v1`.

## Security posture

Security regression tests cover hostile server data, transaction/UTXO
validation, failover, browser boundaries, webhooks, and package distribution.
Report suspected vulnerabilities privately using [the security policy](SECURITY.md),
not a public issue.

- **SSRF (webhooks):** scheme allowlist, blocked loopback/RFC1918/IMDS/CGNAT
  literals incl. decimal/hex IPv4 and IPv4-mapped IPv6 (`::ffff:a.b.c.d`,
  hex-tail, NAT64, 6to4), redirects refused, 10s timeout, no retries.
  DNS resolution goes through a guarded
  lookup hook — every resolved address is blocklist-checked and the socket
  connects to exactly the address that passed (no check/connect window).
- **Terminal injection:** BCMR/server strings are stripped of control
  characters before printing (`sanitize` in `src/cli/render.js`).
- **Hostile servers:** 16MB line cap on the socket buffer, malformed
  numerics guarded (never NaN/throw into money math), token categories
  validated before they reach a URL path, metadata fetches refuse redirects.
- **Payment automation:** watch, campaign, and alert webhook decisions require
  at least two matching Fulcrum responses; subscription notifications are
  treated only as untrusted change signals.
- **Signing and broadcast:** adapter UTXOs are checked against quorum-agreed
  raw funding outputs (including CashToken prefixes), and broadcast success
  requires independent retrieval of the exact raw transaction. Adapter
  transaction, header, history, and parent-enrichment reads also fail closed
  on malformed data or quorum disagreement.
- **Money math:** satoshis and token amounts are BigInt/string end-to-end;
  floats only appear in display-only USD conversion.
- **TLS:** automatic Node discovery and all payment-capable defaults require
  certificate-authenticated TLS and never downgrade to unauthenticated TLS or
  cleartext. `allowInsecureTransport: true` is an explicit non-payment escape
  hatch and requires `verify: false`; payment verification still refuses it.

## Development

```sh
npm test                  # unit tests: Node + browser clients, failover, subscriptions, security, codecs, CLI
npm run test:browser      # deterministic Chromium, Firefox, and WebKit integration tests
npm run test:browser:live # opt-in live WSS browser connection + failover check
node scripts/verify.mjs   # 36-check live end-to-end battery (all commands + exit codes)
node scripts/spike.mjs    # probe the public server landscape
node scripts/probe-seed.mjs    # re-probe the DNS seed + peer gossip shapes
node scripts/probe-tokens.mjs  # re-probe CashToken data shapes
```

## License

MIT.
