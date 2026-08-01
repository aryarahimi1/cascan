# cascan library API

Zero-dependency. Node ≥ 20.10:

```js
import { connect } from '@aryarh/cascan';
```

Browser:

```js
import { connect } from '@aryarh/cascan/browser';
```

## `connect(options?) → Promise<Cascan>`

Discovers the server pool (cache → DNS seed + peer gossip + probing →
curated fallback), verifies every candidate against chain checkpoints,
then repeats checkpoint verification on the exact pool/quorum sockets that
serve data. It connects to the best-scoring authenticated-TLS server and
resolves connected — or throws
`AllServersFailedError`.

| option | default | meaning |
|---|---|---|
| `network` | `'mainnet'` | `'mainnet'` \| `'chipnet'` \| `'testnet4'` — note: chipnet and testnet4 share the `bchtest:` prefix; the `network` option (not the address) selects the chain, and each has its own verified pool + checkpoints |
| `servers` | discovery | explicit pool (skips endpoint discovery; every serving socket is still checkpoint-verified and subject to the transport policy). Verified mode also requires caller-audited `operator` and `infrastructure` ids on each eligible voter |
| `discover` | `true` | `false` = curated list only (also: `CASCAN_NO_DISCOVERY=1`) |
| `verify` | `true` | strict quorum verification on `balance()`/`tx()`/`height()`; `false` is an explicit single-server trade-off |
| `allowInsecureTransport` | `false` | explicit unauthenticated TLS/TCP escape hatch for diagnostics or non-payment reads; requires `verify: false`, and payment-mode quorum refuses insecure endpoints |
| `timeoutMs` | `10000` | per-request timeout |
| `subscriptionCheckMs` | `30000` | interval for round-robin subscription re-queries, which detect a silent notification channel that ping cannot detect |
| `subscriptionCheckBatchSize` | `32` | maximum subscriptions re-queried per interval (1–256) |
| `handlerRetryBaseMs` | `500` | initial callback retry delay after throw/rejection/timeout |
| `handlerRetryMaxMs` | `30000` | maximum callback retry delay |
| `handlerTimeoutMs` | `30000` | time before a callback attempt is treated as failed; timeout cannot cancel user code |
| `failureBackoffBaseMs` | `1000` | initial per-server circuit cooldown; equal jitter chooses the upper half of each exponential range |
| `failureBackoffMaxMs` | `60000` | maximum per-server circuit cooldown |
| `minHealthyUptimeMs` | `60000` | successful setup does not erase failure debt; a live server must remain healthy this long and then answer successfully |
| `retryBudgetAttempts` | `min(32, max(4, pool size))` | global connection attempts allowed per budget window (1–64), shared by every caller and recovery path |
| `retryBudgetWindowMs` | `60000` | fixed connection-attempt budget window |
| `recoveryBackoffBaseMs` | `1000` | initial whole-pool background recovery backoff after an active pool is exhausted |
| `recoveryBackoffMaxMs` | `60000` | maximum whole-pool recovery backoff; only one recovery timer exists |
| `cachePath` | `~/.cascan/servers*.json` | discovery cache location |
| `onLog` | silent | discovery progress callback |

## `Cascan` instance

| member | returns | notes |
|---|---|---|
| `balance(addr, {verify?})` | `{ address, confirmedSats, unconfirmedSats, totalSats, receipt? }` | sats are **strings** (BigInt-safe); strict quorum verification by default |
| `tx(txid, {verbose?, verify?})` | `{ tx, receipt? }` | verbose by default; strict quorum verification by default |
| `height({verify?})` | `number` | current chain tip; strict quorum verification by default |
| `watch(addr, cb)` | `() => void` unsubscribe | `cb(status, event)` accepts sync/async handlers; changed state during failover or a liveness re-query uses acknowledged at-least-once delivery |
| `verify(method, params, {mode?, maxServers?, minAgreement?})` | `{ value, receipt }` | any Electrum method, cross-checked (default `majority`, capped at 4 independent operators); always requires at least two matching operator votes and rejects plurality/tie results |
| `request(method, params)` | raw result | escape hatch, still failover-protected |
| `servers()` | health snapshot | ranked, with visible scores |
| `network` | string | the connected network |
| `close()` | — | tears down the pool |

Events (via `bch.on(...)`): `failover` `{from, to, reason}` ·
`failover-start` · `server-lost` `{server, error}` · `exhausted` `{errors}` ·
`handler-error` `{eventId, type, key, source, observedAt, attempt, error, willRetry}` ·
`recovery-scheduled` `{attempt, delayMs, retryAt}` ·
`recovered` `{server, outageMs}` · `server-stable` `{server, uptimeMs}`.

### Subscription delivery contract

The second callback argument is frozen metadata:
`{ id, type, key, source, observedAt, attempt }`. Resolving or returning from
the callback acknowledges that attempt. A throw, rejected promise, or timeout
emits `handler-error` and retries with the same `id`; `attempt` increases.
This provides at-least-once delivery while the process/page remains alive.

Handlers must be idempotent. `event.id` is stable across attempts in the
current process/page, but it changes after restart; use a transaction/outpoint/
action key protected by a database unique constraint for durable financial
effects. JavaScript cannot cancel a timed-out handler, so the original attempt
and a retry can overlap. Return the database/webhook promise—fire-and-forget is
acknowledged too early. Callback retries and event IDs are in memory only; a
restart has no durable replay log. Under backpressure, cascan retains the
active event and coalesces later unstarted observations to the newest state.
Therefore callbacks are triggers to re-query current state, not a complete
event ledger or payment proof.

CLI watch/campaign/alert webhooks carry an `Idempotency-Key` header;
watch/campaign do not commit their local processed state until a 2xx response.
Receivers must persist that key atomically with the side effect because network
timeouts are ambiguous, and should return 2xx when a key was already committed.
The header is not a signature; authenticate the webhook endpoint separately.

Every 30 seconds by default, the pool re-issues subscribe calls for a bounded,
round-robin batch. A changed response enters the same delivery path with
`source: 'liveness-check'`. This detects silent notification loss even when
`server.ping` still works.

Default verification separates availability from trust. DNS-seed/gossip
servers remain in the failover pool but cannot vote on payment data. Built-in
curated hosts receive maintained operator/infrastructure ids; one vote is
allowed per id, and matching connected IP addresses or exact TLS certificate
fingerprints collapse to one vote again. Cached identity claims are ignored.
Receipts expose `answeredOperator`, the agreeing `operators`, `voterCount`,
and each endpoint's `independent` status. These labels are maintained
assertions—not proof against hidden common ownership or collusion.

## Browser API

`connect({ network?, servers?, timeoutMs?, keepaliveMs?, subscriptionCheckMs?,
subscriptionCheckBatchSize?, handlerRetryBaseMs?, handlerRetryMaxMs?,
handlerTimeoutMs?, failureBackoffBaseMs?, failureBackoffMaxMs?,
minHealthyUptimeMs?, retryBudgetAttempts?, retryBudgetWindowMs?,
recoveryBackoffBaseMs?, recoveryBackoffMaxMs?, maxMessageBytes?,
maxRecordsPerMessage?, dispatchBatchSize?, maxRecordsPerSecond?,
maxNotificationsPerSecond?, maxResponseRecords?, maxPendingRequests? })`
automatically uses
the selected network's built-in `wss://` bootstrap pool. It verifies each
candidate against BCH fork checkpoints using Web Crypto, then connects to the
best healthy endpoint. Passing `servers` overrides the bootstrap pool.
Mainnet and chipnet currently have automatic WSS pools; testnet4 requires an
explicit WSS pool because no working public browser endpoint is known.

Browser bootstrapping provides the same no-configuration connection and
failover experience, but it is not Node's DNS/gossip discovery: browsers
cannot resolve Electrum DNS seeds or connect to the raw TCP/TLS endpoints
normally returned by Fulcrum gossip. Raw TCP/TLS, legacy Base58 addresses,
and quorum receipts remain Node-only.

The returned `BrowserCascan` provides:

| member | notes |
|---|---|
| `height()` | validated BCH height, but still one selected server's claim |
| `balance(cashaddr)` | string satoshis; impossible supply values rejected |
| `watch(cashaddr, cb)` | same acknowledged callback/event-ID contract; restored after failover; returns unsubscribe |
| `request(method, params)` | raw Electrum call with failover |
| `servers()` | current health-ranked WSS pool |
| `killCurrent(reason?)` | demo/test hook for real failover |
| `on` / `off` | pool lifecycle, recovery, `block`, and `handler-error` events listed above |
| `close()` | closes the pool and clears subscriptions |

Browser resource limits:

| option / bound | default | allowed range or hard cap |
|---|---:|---:|
| `maxMessageBytes` | 2 MiB | 350,000 bytes–8 MiB |
| `maxRecordsPerMessage` | 256 | 1–256 |
| queued server records | 512 | derived; at most 2× the per-message record cap |
| `dispatchBatchSize` | 16 | 1–16 records per event-loop turn |
| `maxRecordsPerSecond` | 256 | 1–1,024 |
| `maxNotificationsPerSecond` | 128 | 1–512 |
| `maxResponseRecords` | 10,000 | 1–50,000 array items |
| `maxPendingRequests` | 64 | 1–128 |
| raw-client notification / close handlers | 8 each | hard cap |
| pool callbacks | 16 per subscription, 2,000 total | hard cap |
| pool event handlers | 32 per event, 128 total | hard cap |

The client rejects binary, empty, malformed, over-batched, over-rate, or
over-queue server traffic and closes that endpoint. Dispatch is split across
event-loop turns so a legal batch cannot monopolize the browser main thread.
Header subscription data must contain a valid BCH height and exactly 80 bytes
of hexadecimal block-header data. `close()` also cancels a WebSocket setup that
has not finished. Raise a configurable limit only for a known workload, such
as an unusually large history response; the hard caps cannot be disabled.

Other browser security defaults are `wss://` only, certificate validation
delegated to the browser, maximum 32 servers and 1,000 subscriptions, BCH
checkpoint verification, and atomic subscription restore.
The browser build does **not** claim that one server's balance, height, or
block event is independently verified; use Node quorum when that property is
required. Every selected Electrum operator can observe the user's IP address and queried BCH addresses,
so applications should disclose that privacy tradeoff and avoid sending private
keys or seed material through Electrum calls.

See the [dapp security contract](dapp-security.md) for verified-use guidance
and the residual trust limits.

## Failure semantics

- One request failing on a live server → retried on the next-ranked server.
- Server dies mid-session → `failover` event; subscriptions resubscribe on
  the replacement and the latest observed gap state is delivered through the
  acknowledged callback path (status hashes compared).
- Application errors (`tx not found`) are answers, not failover triggers.
- Whole pool unreachable → the current operation rejects with
  `AllServersFailedError` and emits `exhausted`. An already-active library pool
  schedules one bounded background recovery loop and emits `recovered` after
  subscriptions have been restored. It remains active until `close()`. An
  initial failed `connect()` schedules nothing because no caller can own or
  close that pool.
- Failed endpoints open exponential equal-jitter circuits. One successful
  setup cannot erase their failure debt; 60 seconds of healthy uptime plus a
  successful request/ping is required. A fixed-window global dial budget caps
  all callers and automatic recovery together.
- `close()` cancels pending recovery and wins a race with in-flight setup, so
  a closed pool cannot silently reconnect.
- `pool.killCurrent(reason?)` — chaos hook: kill the live connection for
  real and watch your own failover handling run.

## Adapters

### CashScript

```js
import { connect, CascanNetworkProvider } from '@aryarh/cascan';
const provider = new CascanNetworkProvider(await connect({ network: 'chipnet' }));
const contract = new Contract(artifact, args, { provider });
```

Implements the documented `NetworkProvider` interface by shape: `getUtxos`,
`getUtxosForLockingBytecode`, `getBlockHeight`, `getRawTransaction`,
`sendRawTransaction` — bigint satoshis/token amounts, CashTokens `token`
details, documented `NetworkProvider*Error` names on broadcast failures.
Signing candidates are matched against quorum-agreed raw funding outputs,
and broadcast success requires two matching servers to retrieve the exact
raw transaction. `getRawTransaction()` is also quorum-verified and hashes the
returned bytes back to the requested txid.

### mainnet-js

```js
import { connect, CascanMainnetProvider } from '@aryarh/cascan';
const provider = new CascanMainnetProvider(await connect());
```

Implements the mainnet-js `NetworkProvider` interface by shape, including
`getHeader(s)` (decoded), `getRawTransaction(s)` with `loadInputValues`
vin enrichment, `getHistory` ranges, `waitForBlock`, and address/transaction
subscriptions that ride the pool's resurrection guarantees. UTXO selection
and default broadcast use the same strict funding-output and propagation
verification as the CashScript adapter.
Transactions, parent enrichment, headers, history, relay fee, and balance use
strict quorum; malformed, missing, or disagreeing batch members reject rather
than being silently omitted.
The unsafe mainnet-js `awaitPropagation=false` fire-and-forget mode is
rejected rather than returning an unverifiable success.

## Transports

Automatic discovery, `ServerPool`, and `queryQuorum` accept only
certificate-authenticated `ssl`/`wss` by default. They do not fall back to
self-signed TLS or cleartext when authentication fails. Low-level callers may
explicitly set `allowInsecureTransport: true` for non-payment diagnostics;
this does not make the connection trustworthy, and high-level verified/payment
paths reject that configuration. Some testnet4 community endpoints currently
require this explicit development-only mode because their certificates are not
valid.

`FulcrumClient` speaks `tcp`, `ssl` (default), `ws`, and `wss` — the
WebSocket framing is an in-house RFC 6455 client (zero deps):

```js
import { FulcrumClient } from '@aryarh/cascan';
const c = new FulcrumClient({ host: 'electrum.imaginary.cash', port: 50004, transport: 'wss' });
```

`FulcrumClient` is the raw protocol primitive and does not independently apply
the pool/quorum transport, checkpoint, acknowledged-callback, or subscription
liveness policy. Use `connect()`, `ServerPool`, or `queryQuorum()` for the
corresponding enforced guarantees.

## Toolbox re-exports

`ServerPool` · `discoverServers` · `resolvePool` · `connectPool` ·
`rankServers`/`scoreServer`/`newHealth` · `queryQuorum`/`fulcrumMeta` ·
`QuorumDisagreementError`/`AllServersFailedError` ·
`ChainVerificationError`/`InsecureTransportError` · `FulcrumClient` ·
`parseAddress`/`convertAddress`/`AddressError` · `NETWORKS`/`getNetwork` ·
`DEFAULT_FULCRUM_SERVERS` · `DNS_SEED`/`CHECKPOINTS`.

## Guarantees

1. **Zero npm dependencies** — Node built-ins only, forever.
2. **Chain identity** — every serving socket must match fork-checkpoint header hashes
   (BTC-split + BSV-split for mainnet; per-network pins for chipnet/testnet4)
   before it may serve a single answer.
3. **Money is never floated** — satoshis and token amounts are
   BigInt/strings end-to-end; floats appear only in display-layer USD.
4. **Degradation is surfaced** — receipts carry `disagreements[]` and
   `degraded[]`; nothing is averaged away.
