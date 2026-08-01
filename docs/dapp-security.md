# Dapp security contract

cascan handles network reliability and verifies selected BCH claims. It does
not hold, derive, transmit, or sign with private keys.

This document defines the security properties an integrating dapp may rely on
and the ones it must not assume.

## Safe Node defaults

`connect()` enables strict verification by default for `balance()`, `tx()`,
and `height()`:

- at least two eligible operator identities must return the same value;
- a plurality or tie rejects with `QuorumDisagreementError`;
- invalid BCH heights and malformed/impossible satoshi fields reject;
- the returned receipt identifies successful, failed, and disagreeing
  endpoints.

```js
import { connect } from 'cascan';

const bch = await connect();
const balance = await bch.balance(address);
// Use balance.receipt when recording or displaying the decision.
```

Do not use `request()` or `{ verify: false }` to authorize a withdrawal,
token-gated action, exchange credit, payment fulfillment, or confirmation
threshold. Those are explicit single-server modes.

Address subscription callbacks are validated status-change signals, not
payment proofs. On a callback, refetch the relevant state through the default
verified API before taking a money-moving action.

Subscription delivery is acknowledged in memory. A callback may return a
promise; a throw, rejection, or timeout emits `handler-error` and retries with
the same `event.id`. Use that ID as an idempotency key for side effects. A
timeout cannot cancel JavaScript already running, so a late first attempt may
overlap its retry. Do not write a handler that charges, credits, broadcasts,
or sends a webhook twice merely because it ran twice.

Observed upstream state is tracked separately from successfully delivered
state. While one event is awaiting acknowledgement, cascan retains it and
coalesces later unstarted observations to the newest status. The pool also
periodically re-queries a bounded round-robin batch of subscriptions to detect
a notification channel that went silent while ping remained healthy. These
properties recover state-change triggers; they do not create an append-only
transaction feed.

Failover is serialized: concurrent request, socket, keepalive, and liveness
failures share one teardown/reconnect transition. Failed endpoints enter
exponential equal-jitter circuit cooldowns, and one setup success does not
clear failure debt. All callers and background recovery share a fixed-window
connection-attempt budget. After an active pool is exhausted, the current
operation still fails closed, while exactly one bounded recovery timer keeps
subscription recovery possible. Monitor `exhausted`, `recovery-scheduled`,
and `recovered`; do not interpret recovery as verification of server data.
Calling `close()` cancels pending recovery and prevents an in-flight setup
from reactivating the pool.

Automatic Node discovery treats DNS seed, gossip, and cached endpoints as
untrusted. It rejects private, loopback, link-local, metadata, multicast,
documentation, benchmarking, and reserved destinations; rejects mixed
public/private DNS answers; restricts gossiped ports; and pins the validated
DNS answer into the outbound socket. An explicit `servers` pool skips
automatic discovery and remains caller-controlled, so do not populate it from
untrusted input.

Discovery improves availability; it does not manufacture trust. Only hosts
in cascan's built-in curated registry are eligible security voters by
default. DNS-seed and gossip servers may carry traffic and absorb failover,
but have no payment-quorum vote. Cached `operator` or `infrastructure`
claims are discarded and re-derived from the current built-in registry.

Strict quorum counts one vote per operator and per declared infrastructure
group. After connecting, endpoints that share an observed remote IP address
or exact TLS certificate fingerprint are collapsed again to one vote. The
receipt exposes `answeredOperator`, `operators`, `voterCount`, and each
endpoint's operator/infrastructure and `independent` status.

An explicit `servers` pool is caller-controlled. For its members to vote in
verified mode, assign stable, independently researched `operator` and
`infrastructure` ids (lowercase DNS-style ids are recommended). Never derive
these ids from server gossip, DNS answers, or any other untrusted field:

```js
await connect({
  servers: [
    { host: 'a.example', ports: { ssl: 50002 }, operator: 'org-a', infrastructure: 'host-a' },
    { host: 'b.example', ports: { ssl: 50002 }, operator: 'org-b', infrastructure: 'host-b' },
  ],
});
```

Discovery does not create a reusable trust token. Every later Node pool and
quorum socket repeats the selected network's fork-checkpoint checks before it
may serve an application request or subscription. A cached endpoint that no
longer matches is rejected and failover continues. Automatic/default Node
paths require certificate-authenticated TLS and never downgrade after a
certificate failure.

`allowInsecureTransport: true` exists only for explicit diagnostics and
development networks. High-level `connect()` requires `verify: false` with
that option, and payment-mode quorum refuses unauthenticated TLS and TCP.
Never use the insecure escape hatch to authorize a payment or money movement.

## CashScript and mainnet-js providers

`CascanNetworkProvider.getUtxos()` and
`CascanMainnetProvider.getUtxos()` independently retrieve the raw funding
transaction through strict quorum and verify that each output's value,
CashToken prefix, and locking bytecode match the requested address. A server
cannot substitute a genuine foreign UTXO as the caller's funds.

Broadcast success requires two endpoints to retrieve the exact raw
transaction. This proves propagation visibility, not confirmation or block
inclusion.

## Browser use

`cascan/browser` verifies BCH fork checkpoints, validates response shapes,
uses WSS, and fails over between configured endpoints. It does **not**
implement browser quorum or SPV verification.

Browser balances, heights, and `block` events are one selected server's
claim. Use them for display and refresh signals only. Do not use them alone to
release funds, grant ownership/token access, credit deposits, or establish
confirmations. Run that decision through a Node quorum-capable service or
another independently verified BCH data source.

Direct Electrum connections expose the user's IP address and queried BCH
addresses to each selected operator. Never send private keys, seed phrases,
or signing material through any Electrum request.

Browser `watch()` uses the same callback acknowledgement, retry ID, bounded
backpressure, and periodic state re-query behavior as Node. It still observes
one active server at a time, so delivery reliability does not turn the
server's claim into independent verification.

Treat every WSS server as a potentially hostile network peer. The browser
client caps message bytes, JSON records, queued work, record and notification
rates, result-array length, pending requests, and registered callbacks. It
dispatches at most 16 records per event-loop turn, validates block headers as
exactly 80 bytes of hexadecimal data, and immediately cancels an unfinished
connection when closed. A violation closes the endpoint and lets the pool fail
over; it does not make malicious data truthful. Configurable limits and their
hard ceilings are listed in [the browser API reference](library.md#browser-api).

## Residual trust limits

- Checkpoints prove a server follows BCH history at the pinned fork heights;
  they do not prove a current balance, UTXO set, mempool state, or block tip.
- Curated operator/infrastructure labels are maintained assertions, not
  cryptographic identities. Same-IP/certificate collapse catches obvious
  aliases, but cascan has no reliable global ownership or ASN oracle. Two
  apparently separate operators may still share hidden control or collude.
- cascan does not implement transaction-inclusion Merkle proofs or SPV.
  Confirmed-status claims remain quorum-checked endpoint claims.
- A malicious server can omit a real UTXO or report a stale/spent UTXO.
  The provider guards prevent foreign-output substitution; signing/broadcast
  still provides the final spendability check.
- A Node strict query fails closed when it cannot obtain required agreement.
  Availability is intentionally traded for integrity on money-relevant
  default calls.
- Subscription delivery is not durable. Closing/reloading the page or process
  clears pending attempts and event IDs. Reconcile current state on startup.
- At-least-once delivery permits duplicates, and backpressure coalesces
  intermediate unstarted statuses. Handlers must be idempotent and must query
  the state they need instead of treating callbacks as a complete ledger.
- Circuit breakers and retry budgets bound reconnect amplification; they also
  intentionally trade temporary availability for process and network safety.
  A pool with too few healthy endpoints may remain unavailable until a
  cooldown or budget window opens.
- Browser resource bounds reduce denial-of-service impact but cannot provide
  WebSocket backpressure or stop a server from repeatedly forcing bounded
  disconnects. Repeated resource-limit failovers should be monitored as a
  hostile-server or capacity signal.

## Integration checklist

1. Keep strict verification enabled (the default) for financial decisions.
2. Persist receipts with high-value application decisions.
3. Treat `watch()` and browser events as triggers to re-query, not proof.
4. Make async watch handlers idempotent on `event.id`; monitor
   `handler-error`, and return the side-effect promise so failures are retried.
5. Reconcile current state on every process/page start; callback retries are
   not a durable queue.
6. Handle `QuorumDisagreementError` and `AllServersFailedError` as a
   fail-closed state; never substitute a cached or single-server answer.
7. Alert on repeated `exhausted`/`recovery-scheduled` events and test a full
   network outage plus automatic subscription restoration in staging.
8. Disclose Electrum query/IP privacy to browser users.
