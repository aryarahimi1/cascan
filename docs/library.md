# cascan library API

Zero-dependency. Node ≥ 20.10:

```js
import { connect } from 'cascan';
```

Browser:

```js
import { connect } from 'cascan/browser';
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
| `cachePath` | `~/.cascan/servers*.json` | discovery cache location |
| `onLog` | silent | discovery progress callback |

## `Cascan` instance

| member | returns | notes |
|---|---|---|
| `balance(addr, {verify?})` | `{ address, confirmedSats, unconfirmedSats, totalSats, receipt? }` | sats are **strings** (BigInt-safe); strict quorum verification by default |
| `tx(txid, {verbose?, verify?})` | `{ tx, receipt? }` | verbose by default; strict quorum verification by default |
| `height({verify?})` | `number` | current chain tip; strict quorum verification by default |
| `watch(addr, cb)` | `() => void` unsubscribe | cb fires on every status change — **including changes that happen during a failover gap** |
| `verify(method, params, {mode?, maxServers?, minAgreement?})` | `{ value, receipt }` | any Electrum method, cross-checked (default `majority`, capped at 4 independent operators); always requires at least two matching operator votes and rejects plurality/tie results |
| `request(method, params)` | raw result | escape hatch, still failover-protected |
| `servers()` | health snapshot | ranked, with visible scores |
| `network` | string | the connected network |
| `close()` | — | tears down the pool |

Events (via `bch.on(...)`): `failover` `{from, to, reason}` ·
`failover-start` · `server-lost` `{server, error}` · `exhausted` `{errors}`.

Default verification separates availability from trust. DNS-seed/gossip
servers remain in the failover pool but cannot vote on payment data. Built-in
curated hosts receive maintained operator/infrastructure ids; one vote is
allowed per id, and matching connected IP addresses or exact TLS certificate
fingerprints collapse to one vote again. Cached identity claims are ignored.
Receipts expose `answeredOperator`, the agreeing `operators`, `voterCount`,
and each endpoint's `independent` status. These labels are maintained
assertions—not proof against hidden common ownership or collusion.

## Browser API

`connect({ network?, servers?, timeoutMs?, keepaliveMs? })` automatically uses
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
| `watch(cashaddr, cb)` | restored after failover; returns unsubscribe |
| `request(method, params)` | raw Electrum call with failover |
| `servers()` | current health-ranked WSS pool |
| `killCurrent(reason?)` | demo/test hook for real failover |
| `on` / `off` | `failover`, `failover-start`, `server-lost`, `exhausted`, `block` |
| `close()` | closes the pool and clears subscriptions |

Browser security defaults: `wss://` only, certificate validation delegated to
the browser, maximum 32 servers and 1,000 subscriptions, bounded messages and
configuration, BCH checkpoint verification, and atomic subscription restore.
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
  the replacement and **gap changes are delivered** (status hashes compared).
- Application errors (`tx not found`) are answers, not failover triggers.
- Whole pool unreachable → `AllServersFailedError` + `exhausted` event.
  Loud death, never silent staleness.
- `pool.killCurrent(reason?)` — chaos hook: kill the live connection for
  real and watch your own failover handling run.

## Adapters

### CashScript

```js
import { connect, CascanNetworkProvider } from 'cascan';
const provider = new CascanNetworkProvider(await connect({ network: 'chipnet' }));
const contract = new Contract(artifact, args, { provider });
```

Implements the documented `NetworkProvider` interface by shape: `getUtxos`,
`getUtxosForLockingBytecode`, `getBlockHeight`, `getRawTransaction`,
`sendRawTransaction` — bigint satoshis/token amounts, CashTokens `token`
details, documented `NetworkProvider*Error` names on broadcast failures.
Signing candidates are matched against quorum-agreed raw funding outputs,
and broadcast success requires two matching servers to retrieve the exact
raw transaction.

### mainnet-js

```js
import { connect, CascanMainnetProvider } from 'cascan';
const provider = new CascanMainnetProvider(await connect());
```

Implements the mainnet-js `NetworkProvider` interface by shape, including
`getHeader(s)` (decoded), `getRawTransaction(s)` with `loadInputValues`
vin enrichment, `getHistory` ranges, `waitForBlock`, and address/transaction
subscriptions that ride the pool's resurrection guarantees. UTXO selection
and default broadcast use the same strict funding-output and propagation
verification as the CashScript adapter.
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
import { FulcrumClient } from 'cascan';
const c = new FulcrumClient({ host: 'electrum.imaginary.cash', port: 50004, transport: 'wss' });
```

`FulcrumClient` is the raw protocol primitive and does not independently apply
the pool/quorum transport or checkpoint policy. Use `connect()`, `ServerPool`,
or `queryQuorum()` for the enforced serving-socket guarantees.

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
