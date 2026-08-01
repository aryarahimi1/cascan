# Dapp security contract

cascan handles network reliability and verifies selected BCH claims. It does
not hold, derive, transmit, or sign with private keys.

This document defines the security properties an integrating dapp may rely on
and the ones it must not assume.

## Safe Node defaults

`connect()` enables strict verification by default for `balance()`, `tx()`,
and `height()`:

- at least two endpoints must return the same value;
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

Automatic Node discovery treats DNS seed, gossip, and cached endpoints as
untrusted. It rejects private, loopback, link-local, metadata, multicast,
documentation, benchmarking, and reserved destinations; rejects mixed
public/private DNS answers; restricts gossiped ports; and pins the validated
DNS answer into the outbound socket. An explicit `servers` pool skips
automatic discovery and remains caller-controlled, so do not populate it from
untrusted input.

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

## Residual trust limits

- Checkpoints prove a server follows BCH history at the pinned fork heights;
  they do not prove a current balance, UTXO set, mempool state, or block tip.
- Two endpoints can be operated by the same party or collude. cascan has no
  reliable operator-independence or ASN-ownership oracle.
- cascan does not implement transaction-inclusion Merkle proofs or SPV.
  Confirmed-status claims remain quorum-checked endpoint claims.
- A malicious server can omit a real UTXO or report a stale/spent UTXO.
  The provider guards prevent foreign-output substitution; signing/broadcast
  still provides the final spendability check.
- A Node strict query fails closed when it cannot obtain required agreement.
  Availability is intentionally traded for integrity on money-relevant
  default calls.

## Integration checklist

1. Keep strict verification enabled (the default) for financial decisions.
2. Persist receipts with high-value application decisions.
3. Treat `watch()` and browser events as triggers to re-query, not proof.
4. Handle `QuorumDisagreementError` and `AllServersFailedError` as a
   fail-closed state; never substitute a cached or single-server answer.
5. Disclose Electrum query/IP privacy to browser users.
